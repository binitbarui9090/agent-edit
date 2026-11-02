import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import {
  type Database,
  type MediaDoc,
  type MediaJobData,
  type MediaQueues,
  type Storage,
  derivedKey,
  publishEvent,
} from '@agent-edit/infra';
import {
  InvalidMediaError,
  extractAudio,
  generateProxy,
  generateThumbnails,
  generateWaveform,
  probeFile,
  type BinaryPaths,
  type ProcessTracker,
} from '@agent-edit/media-engine';
import {
  REQUIRED_STEPS,
  STEP_LABELS,
  WAVEFORM_PEAKS_PER_SECOND,
  ticksToSeconds,
  type ProcessingStep,
} from '@agent-edit/shared';
import type { JobStatus } from '@agent-edit/validation';
import { UnrecoverableError, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { SourceCache } from './source-cache.js';

export interface PipelineContext {
  database: Database;
  storage: Storage;
  queues: MediaQueues;
  redis: Redis;
  cache: SourceCache;
  binaries: BinaryPaths;
  tracker: ProcessTracker;
  log: Logger;
  signal: AbortSignal;
}

const PROGRESS_INTERVAL_MS = 1000;
const TERMINAL: ReadonlySet<JobStatus> = new Set(['done', 'failed', 'skipped']);

/** Throttled, because FFmpeg reports many times a second and each report writes to MongoDB. */
function progressReporter(ctx: PipelineContext, media: MediaDoc, step: ProcessingStep) {
  let last = 0;
  return (progress: number) => {
    const now = Date.now();
    if (now - last < PROGRESS_INTERVAL_MS) return;
    last = now;
    void writeProgress(ctx, media, step, progress).catch((err: unknown) =>
      ctx.log.warn({ err, mediaId: media._id, step }, 'progress update failed'),
    );
  };
}

async function writeProgress(
  ctx: PipelineContext,
  media: MediaDoc,
  step: ProcessingStep,
  progress: number,
) {
  await ctx.database.analysisJobs.updateOne(
    { mediaId: media._id, step, status: 'running' },
    { $set: { progress, updatedAt: new Date() } },
  );
  await publishEvent(ctx.redis, {
    type: 'job.progress',
    projectId: media.projectId,
    mediaId: media._id,
    step,
    status: 'running',
    progress,
  });
}

async function setJobs(
  ctx: PipelineContext,
  mediaId: string,
  steps: readonly ProcessingStep[],
  fields: { status: JobStatus; progress?: number; error?: string | null },
) {
  const now = new Date();
  await ctx.database.analysisJobs.updateMany(
    { mediaId, step: { $in: [...steps] } },
    {
      $set: {
        ...fields,
        updatedAt: now,
        ...(TERMINAL.has(fields.status) ? { finishedAt: now } : {}),
      },
    },
  );
}

type StepRunner = (
  ctx: PipelineContext,
  media: MediaDoc,
  report: (progress: number) => void,
) => Promise<void>;

function requireProbe(media: MediaDoc) {
  if (!media.probe) throw new Error('Step ran before metadata was available');
  return media.probe;
}

const runProbe: StepRunner = async (ctx, media) => {
  const source = await ctx.cache.acquire(media, ctx.signal);
  let probe;
  try {
    probe = await probeFile(ctx.binaries.ffprobe, source, ctx.signal);
  } catch (err) {
    // The file is what it is, so retrying a rejected file would only waste work.
    if (err instanceof InvalidMediaError) throw new UnrecoverableError(err.message);
    throw err;
  }
  await ctx.database.media.updateOne(
    { _id: media._id },
    { $set: { probe, updatedAt: new Date() } },
  );

  const next: ProcessingStep[] = ['thumbnails', 'proxy'];
  if (probe.audioCodec) next.push('waveform', 'audio');
  else await setJobs(ctx, media._id, ['waveform', 'audio'], { status: 'skipped', progress: 0 });

  const data: MediaJobData = { mediaId: media._id, projectId: media.projectId };
  for (const step of next) await ctx.queues.enqueue(step, data, media.generation);
};

const runThumbnails: StepRunner = async (ctx, media, report) => {
  const probe = requireProbe(media);
  const source = await ctx.cache.acquire(media, ctx.signal);
  const scratch = await ctx.cache.scratch(media._id, 'thumbnails');
  try {
    const files = await generateThumbnails(ctx.binaries.ffmpeg, source, scratch, {
      duration: ticksToSeconds(probe.duration),
      signal: ctx.signal,
      tracker: ctx.tracker,
      onProgress: (p) => report(p * 0.9),
    });
    const keys: string[] = [];
    for (const [index, file] of files.entries()) {
      const key = derivedKey(media.projectId, media._id, `thumb-${index}.jpg`);
      await ctx.storage.uploadFile(key, file, 'image/jpeg');
      keys.push(key);
    }
    await ctx.database.media.updateOne(
      { _id: media._id },
      {
        $set: {
          'storage.thumbnailKeys': keys,
          // The second frame: first frames are so often black.
          'storage.posterKey': keys[1] ?? keys[0] ?? null,
          updatedAt: new Date(),
        },
      },
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

const runWaveform: StepRunner = async (ctx, media, report) => {
  const probe = requireProbe(media);
  const source = await ctx.cache.acquire(media, ctx.signal);
  const scratch = await ctx.cache.scratch(media._id, 'waveform');
  try {
    const output = join(scratch, 'peaks.bin');
    await generateWaveform(ctx.binaries.ffmpeg, source, output, {
      duration: ticksToSeconds(probe.duration),
      peaksPerSecond: WAVEFORM_PEAKS_PER_SECOND,
      signal: ctx.signal,
      tracker: ctx.tracker,
      onProgress: (p) => report(p * 0.95),
    });
    const key = derivedKey(media.projectId, media._id, 'waveform.bin');
    await ctx.storage.uploadFile(key, output, 'application/octet-stream');
    await ctx.database.media.updateOne(
      { _id: media._id },
      {
        $set: {
          'storage.waveformKey': key,
          'storage.waveformPeaksPerSecond': WAVEFORM_PEAKS_PER_SECOND,
          updatedAt: new Date(),
        },
      },
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

const runProxy: StepRunner = async (ctx, media, report) => {
  const probe = requireProbe(media);
  const source = await ctx.cache.acquire(media, ctx.signal);
  const scratch = await ctx.cache.scratch(media._id, 'proxy');
  try {
    const output = join(scratch, 'proxy.mp4');
    await generateProxy(ctx.binaries.ffmpeg, source, output, {
      duration: ticksToSeconds(probe.duration),
      hasAudio: probe.audioCodec !== null,
      signal: ctx.signal,
      tracker: ctx.tracker,
      onProgress: (p) => report(p * 0.95),
    });
    const key = derivedKey(media.projectId, media._id, 'proxy.mp4');
    await ctx.storage.uploadFile(key, output, 'video/mp4');
    await ctx.database.media.updateOne(
      { _id: media._id },
      { $set: { 'storage.proxyKey': key, updatedAt: new Date() } },
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

const runAudio: StepRunner = async (ctx, media, report) => {
  const probe = requireProbe(media);
  const source = await ctx.cache.acquire(media, ctx.signal);
  const scratch = await ctx.cache.scratch(media._id, 'audio');
  try {
    const output = join(scratch, 'audio.flac');
    await extractAudio(ctx.binaries.ffmpeg, source, output, {
      duration: ticksToSeconds(probe.duration),
      signal: ctx.signal,
      tracker: ctx.tracker,
      onProgress: (p) => report(p * 0.95),
    });
    const key = derivedKey(media.projectId, media._id, 'audio.flac');
    await ctx.storage.uploadFile(key, output, 'audio/flac');
    await ctx.database.media.updateOne(
      { _id: media._id },
      { $set: { 'storage.audioKey': key, updatedAt: new Date() } },
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

const RUNNERS: Record<ProcessingStep, StepRunner> = {
  probe: runProbe,
  thumbnails: runThumbnails,
  waveform: runWaveform,
  proxy: runProxy,
  audio: runAudio,
};

/** Decides the asset's status from its jobs, once none of them are still pending. */
export async function settleMedia(ctx: PipelineContext, mediaId: string): Promise<void> {
  const jobs = await ctx.database.analysisJobs.find({ mediaId }).toArray();
  if (jobs.some((job) => !TERMINAL.has(job.status))) return;

  const fatal = jobs.find((job) => job.status === 'failed' && REQUIRED_STEPS.includes(job.step));
  const update = fatal
    ? { status: 'failed' as const, error: `${STEP_LABELS[fatal.step]}: ${fatal.error}` }
    : { status: 'ready' as const, error: null };
  await ctx.database.media.updateOne(
    { _id: mediaId, deletedAt: null },
    { $set: { ...update, updatedAt: new Date() } },
  );
  await ctx.cache.release(mediaId);
}

async function notifyChanged(ctx: PipelineContext, projectId: string, mediaId: string) {
  await publishEvent(ctx.redis, { type: 'media.changed', projectId, mediaId });
}

export async function processStep(ctx: PipelineContext, job: Job<MediaJobData>): Promise<void> {
  const step = job.name as ProcessingStep;
  const runner = RUNNERS[step];
  if (!runner) throw new UnrecoverableError(`Unknown media step: ${job.name}`);
  const { mediaId, projectId } = job.data;

  const media = await ctx.database.media.findOne({ _id: mediaId, deletedAt: null });
  if (!media) {
    // Deleted while queued. The sweep owns cleanup, and there is nothing useful left to do here.
    ctx.log.info({ mediaId, step }, 'skipping step for deleted media');
    return;
  }

  const now = new Date();
  await ctx.database.analysisJobs.updateOne(
    { mediaId, step },
    {
      $set: {
        status: 'running',
        progress: 0,
        attempts: job.attemptsMade + 1,
        error: null,
        startedAt: now,
        updatedAt: now,
      },
    },
  );
  await notifyChanged(ctx, projectId, mediaId);

  await runner(ctx, media, progressReporter(ctx, media, step));

  await setJobs(ctx, mediaId, [step], { status: 'done', progress: 1, error: null });
  await settleMedia(ctx, mediaId);
  await notifyChanged(ctx, projectId, mediaId);
}

/** Runs from the worker's failed event, so it also covers stalled jobs the processor never saw. */
export async function handleStepFailure(
  ctx: PipelineContext,
  job: Job<MediaJobData>,
  err: Error,
): Promise<void> {
  const step = job.name as ProcessingStep;
  const { mediaId, projectId } = job.data;
  const exhausted =
    err.name === 'UnrecoverableError' || job.attemptsMade >= (job.opts.attempts ?? 1);
  ctx.log.error({ err, mediaId, step, attempt: job.attemptsMade, exhausted }, 'step failed');

  if (!exhausted) {
    await setJobs(ctx, mediaId, [step], { status: 'queued', progress: 0, error: err.message });
    await notifyChanged(ctx, projectId, mediaId);
    return;
  }

  await setJobs(ctx, mediaId, [step], { status: 'failed', error: err.message });
  if (step === 'probe') {
    await setJobs(ctx, mediaId, ['thumbnails', 'waveform', 'proxy', 'audio'], {
      status: 'skipped',
      progress: 0,
    });
  }
  await settleMedia(ctx, mediaId);
  await notifyChanged(ctx, projectId, mediaId);
}
