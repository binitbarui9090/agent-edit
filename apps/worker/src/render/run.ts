import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publishEvent, renderKey, type RenderJobDoc } from '@agent-edit/infra';
import { hasFilter, probeFile, renderTimeline, type RenderSource } from '@agent-edit/media-engine';
import { ticksPerFrame } from '@agent-edit/shared';
import { captionsToSrt, timelineCaptions } from '@agent-edit/timeline-engine';
import { UnrecoverableError } from 'bullmq';
import type { PipelineContext } from '../media/pipeline.js';

const CANCEL_POLL_MS = 1500;
const PROGRESS_INTERVAL_MS = 1000;

/**
 * Renders from original footage, never from proxies, against a snapshot taken when the job was
 * created. Edits made after pressing export do not change what comes out.
 */
export async function processRender(
  ctx: PipelineContext,
  renderId: string,
  workRoot: string,
  attemptsMade: number,
): Promise<void> {
  const job = await ctx.database.renders.findOne({ _id: renderId });
  if (!job || job.status === 'cancelled' || job.status === 'done') return;

  const log: string[] = [
    `render ${renderId}, revision ${job.revision}, attempt ${attemptsMade + 1}`,
  ];
  const notify = (status: RenderJobDoc['status'], progress: number) =>
    publishEvent(ctx.redis, {
      type: 'render.changed',
      projectId: job.projectId,
      renderId,
      status,
      progress,
    });

  const started = await ctx.database.renders.findOneAndUpdate(
    { _id: renderId, status: { $in: ['queued', 'running'] } },
    { $set: { status: 'running', attempts: attemptsMade + 1, error: null, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!started) return;
  await notify('running', started.progress);

  const controller = new AbortController();
  const signal = AbortSignal.any([ctx.signal, controller.signal]);
  // Polled rather than pushed, so cancelling works even if this worker missed an event.
  const cancelWatch = setInterval(() => {
    void ctx.database.renders
      .findOne({ _id: renderId }, { projection: { status: 1 } })
      .then((doc) => {
        if (doc?.status === 'cancelled') controller.abort();
      })
      .catch(() => undefined);
  }, CANCEL_POLL_MS);

  const state = job.snapshot;
  const mediaIds = [
    ...new Set(
      state.tracks.flatMap((track) =>
        track.clips.flatMap((clip) => (clip.kind === 'media' ? [clip.sourceMediaId] : [])),
      ),
    ),
  ];
  const workDir = join(workRoot, `render-${renderId}`);
  await mkdir(workDir, { recursive: true });
  const pinned: string[] = [];

  try {
    if (
      job.burnCaptions &&
      timelineCaptions(state).length > 0 &&
      !(await hasFilter(ctx.binaries.ffmpeg, 'ass'))
    ) {
      throw new UnrecoverableError(
        'This FFmpeg cannot burn in captions, because it was built without libass. Install ffmpeg-full and set FFMPEG_PATH, or export without burned-in captions.',
      );
    }

    const sources = new Map<string, RenderSource>();
    for (const mediaId of mediaIds) {
      const media = await ctx.database.media.findOne({ _id: mediaId });
      if (!media?.probe) {
        throw new UnrecoverableError(`Footage used on this timeline is no longer available`);
      }
      ctx.cache.pin(mediaId);
      pinned.push(mediaId);
      sources.set(mediaId, {
        path: await ctx.cache.acquire(media, signal),
        hasAudio: media.probe.audioCodec !== null,
      });
    }

    // A retry finds its finished chunks on disk and renders only what is left.
    const existing = await readdir(workDir);
    const finished = new Set(
      existing.flatMap((name) => {
        const match = /^done-(\d+)$/.exec(name);
        return match ? [Number(match[1])] : [];
      }),
    );
    if (finished.size > 0) log.push(`resuming with ${finished.size} chunks already done`);

    let lastWrite = 0;
    const output = join(workDir, 'output.mp4');
    await renderTimeline({
      ffmpeg: ctx.binaries.ffmpeg,
      state,
      sources,
      width: job.width,
      height: job.height,
      burnCaptions: job.burnCaptions,
      workDir,
      output,
      signal,
      tracker: ctx.tracker,
      finished,
      onLog: (line) => log.push(line),
      onChunkFinished: (index) => {
        void writeFile(join(workDir, `done-${index}`), '');
      },
      onProgress: (progress) => {
        const now = Date.now();
        if (now - lastWrite < PROGRESS_INTERVAL_MS) return;
        lastWrite = now;
        void ctx.database.renders
          .updateOne(
            { _id: renderId, status: 'running' },
            { $set: { progress, updatedAt: new Date() } },
          )
          .then(() => notify('running', progress))
          .catch((err: unknown) =>
            ctx.log.warn({ err, renderId }, 'render progress update failed'),
          );
      },
    });

    // Checked before reporting success: a file that exists is not yet proof it is the right one.
    const probe = await probeFile(ctx.binaries.ffprobe, output, signal);
    const tolerance = ticksPerFrame(state.frameRate) * 3;
    if (Math.abs(probe.duration - job.durationTicks) > tolerance) {
      throw new Error(
        `Output length ${probe.duration} does not match the timeline's ${job.durationTicks}`,
      );
    }
    if (probe.width !== job.width || probe.height !== job.height) {
      throw new Error(`Output is ${probe.width}x${probe.height}, not ${job.width}x${job.height}`);
    }
    log.push(`verified: ${probe.width}x${probe.height}, ${probe.videoCodec}/${probe.audioCodec}`);

    const outputKey = renderKey(job.projectId, renderId, 'output.mp4');
    await ctx.storage.uploadFile(outputKey, output, 'video/mp4');
    const { size } = await stat(output);

    let captionsKey: string | null = null;
    const srt = captionsToSrt(state);
    if (srt) {
      captionsKey = renderKey(job.projectId, renderId, 'captions.srt');
      await ctx.storage.uploadText(captionsKey, srt, 'application/x-subrip');
    }
    const logKey = renderKey(job.projectId, renderId, 'render.log');
    await ctx.storage.uploadText(logKey, log.join('\n'), 'text/plain');

    await ctx.database.renders.updateOne(
      { _id: renderId, status: 'running' },
      {
        $set: {
          status: 'done',
          progress: 1,
          outputKey,
          outputSize: size,
          captionsKey,
          logKey,
          updatedAt: new Date(),
          finishedAt: new Date(),
        },
      },
    );
    await notify('done', 1);
    await rm(workDir, { recursive: true, force: true });
  } catch (err) {
    if (controller.signal.aborted) {
      await rm(workDir, { recursive: true, force: true });
      throw new UnrecoverableError('Cancelled');
    }
    log.push(`failed: ${err instanceof Error ? err.message : String(err)}`);
    await ctx.storage
      .uploadText(renderKey(job.projectId, renderId, 'render.log'), log.join('\n'), 'text/plain')
      .then(() =>
        ctx.database.renders.updateOne(
          { _id: renderId },
          { $set: { logKey: renderKey(job.projectId, renderId, 'render.log') } },
        ),
      )
      .catch(() => undefined);
    throw err;
  } finally {
    clearInterval(cancelWatch);
    for (const mediaId of pinned) await ctx.cache.unpin(mediaId);
  }
}

/** Runs from the worker's failed event, so it also covers a stalled job the processor never saw. */
export async function handleRenderFailure(
  ctx: PipelineContext,
  renderId: string,
  err: Error,
  exhausted: boolean,
): Promise<void> {
  const job = await ctx.database.renders.findOne({ _id: renderId });
  if (!job || job.status === 'cancelled') return;
  const final = exhausted || err.name === 'UnrecoverableError';
  const status = final ? 'failed' : 'queued';
  await ctx.database.renders.updateOne(
    { _id: renderId, status: { $ne: 'cancelled' } },
    {
      $set: {
        status,
        error: err.message.slice(0, 1000),
        updatedAt: new Date(),
        ...(final ? { finishedAt: new Date() } : {}),
      },
    },
  );
  await publishEvent(ctx.redis, {
    type: 'render.changed',
    projectId: job.projectId,
    renderId,
    status,
    progress: job.progress,
  });
}
