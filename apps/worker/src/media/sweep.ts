import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { mediaPrefixes } from '@agent-edit/infra';
import type { PipelineContext } from './pipeline.js';

export const PROCESS_DIR_NAME = 'processes';

const HOUR = 60 * 60 * 1000;
/** Long enough for a job that started before the delete to notice and stop writing. */
const PURGE_AFTER_MS = HOUR;
const STALE_UPLOAD_MS = 7 * 24 * HOUR;
const LOST_JOB_AFTER_MS = 10 * 60 * 1000;
const STALE_WORK_DIR_MS = 48 * HOUR;

export interface SweepResult {
  purged: number;
  abandonedUploads: number;
  requeued: number;
  workDirsRemoved: number;
  orphansKilled: number;
}

async function purgeDeleted(ctx: PipelineContext, now: number): Promise<number> {
  const docs = await ctx.database.media
    .find({ deletedAt: { $ne: null, $lte: new Date(now - PURGE_AFTER_MS) } })
    .limit(200)
    .toArray();
  for (const doc of docs) {
    if (doc.upload) {
      await ctx.storage.abortMultipart(doc.storage.originalKey, doc.upload.s3UploadId);
    }
    for (const prefix of mediaPrefixes(doc.projectId, doc._id)) {
      await ctx.storage.deletePrefix(prefix);
    }
    await ctx.cache.release(doc._id);
    await ctx.database.analysisJobs.deleteMany({ mediaId: doc._id });
    // Last, so a crash above leaves the record for the next sweep to finish.
    await ctx.database.media.deleteOne({ _id: doc._id });
  }
  return docs.length;
}

async function abandonStaleUploads(ctx: PipelineContext, now: number): Promise<number> {
  const docs = await ctx.database.media
    .find({ status: 'uploading', updatedAt: { $lte: new Date(now - STALE_UPLOAD_MS) } })
    .limit(200)
    .toArray();
  for (const doc of docs) {
    if (doc.upload) {
      await ctx.storage.abortMultipart(doc.storage.originalKey, doc.upload.s3UploadId);
    }
    await ctx.database.media.deleteOne({ _id: doc._id, status: 'uploading' });
  }
  return docs.length;
}

/** Recovers assets stuck "processing" because their queue entry vanished, as when Redis is reset. */
async function requeueLostJobs(ctx: PipelineContext, now: number): Promise<number> {
  const jobs = await ctx.database.analysisJobs
    .find({
      status: { $in: ['queued', 'running'] },
      updatedAt: { $lte: new Date(now - LOST_JOB_AFTER_MS) },
    })
    .limit(500)
    .toArray();
  let requeued = 0;
  for (const job of jobs) {
    const media = await ctx.database.media.findOne({ _id: job.mediaId, deletedAt: null });
    if (!media || media.status !== 'processing') continue;
    // Other steps are enqueued by the probe, so they are not lost until the probe has finished.
    if (job.step !== 'probe' && !media.probe) continue;
    if (await ctx.queues.exists(job.step, job.mediaId, media.generation)) continue;
    await ctx.queues.enqueue(
      job.step,
      { mediaId: job.mediaId, projectId: job.projectId },
      media.generation,
    );
    requeued++;
  }
  return requeued;
}

async function removeStaleWorkDirs(workDir: string, now: number): Promise<number> {
  const entries = await readdir(workDir, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Holds live process records, not an asset's scratch files.
    if (entry.name === PROCESS_DIR_NAME) continue;
    const path = join(workDir, entry.name);
    const { mtimeMs } = await stat(path);
    if (now - mtimeMs < STALE_WORK_DIR_MS) continue;
    await rm(path, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

export async function sweep(
  ctx: PipelineContext,
  workDir: string,
  now = Date.now(),
): Promise<SweepResult> {
  return {
    purged: await purgeDeleted(ctx, now),
    abandonedUploads: await abandonStaleUploads(ctx, now),
    requeued: await requeueLostJobs(ctx, now),
    workDirsRemoved: await removeStaleWorkDirs(workDir, now),
    orphansKilled: await ctx.tracker.reap(),
  };
}
