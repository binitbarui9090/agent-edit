import { type MediaJobData } from '@agent-edit/infra';
import { MAINTENANCE_JOBS, QUEUES } from '@agent-edit/shared';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { handleStepFailure, processStep, type PipelineContext } from './pipeline.js';
import { sweep } from './sweep.js';

export interface WorkerOptions {
  connection: ConnectionOptions;
  prefix?: string;
  mediaConcurrency: number;
  proxyConcurrency: number;
  workDir: string;
}

const SWEEP_EVERY_MS = 10 * 60 * 1000;

export async function startMediaWorkers(
  ctx: PipelineContext,
  { connection, prefix, mediaConcurrency, proxyConcurrency, workDir }: WorkerOptions,
) {
  const base = { connection, ...(prefix ? { prefix } : {}) };

  const build = (queue: string, concurrency: number) => {
    const worker = new Worker<MediaJobData>(queue, (job) => processStep(ctx, job), {
      ...base,
      concurrency,
    });
    worker.on('failed', (job, err) => {
      if (!job) return;
      void handleStepFailure(ctx, job, err).catch((failure: unknown) =>
        ctx.log.error({ err: failure, jobId: job.id }, 'could not record step failure'),
      );
    });
    worker.on('error', (err) => ctx.log.error({ err }, 'media worker error'));
    return worker;
  };
  const media = build(QUEUES.media, mediaConcurrency);
  const proxy = build(QUEUES.proxy, proxyConcurrency);

  const maintenanceQueue = new Queue(QUEUES.maintenance, base);
  const maintenance = new Worker(
    QUEUES.maintenance,
    async () => {
      const result = await sweep(ctx, workDir);
      ctx.log.info(result, 'sweep finished');
      return result;
    },
    { ...base, concurrency: 1 },
  );
  maintenance.on('error', (err) => ctx.log.error({ err }, 'maintenance worker error'));
  maintenance.on('failed', (_job, err) => ctx.log.error({ err }, 'sweep failed'));
  await maintenanceQueue.upsertJobScheduler(
    MAINTENANCE_JOBS.sweep,
    { every: SWEEP_EVERY_MS },
    { name: MAINTENANCE_JOBS.sweep, opts: { removeOnComplete: 10, removeOnFail: 50 } },
  );

  return {
    media,
    proxy,
    async close() {
      await Promise.all([media.close(), proxy.close(), maintenance.close()]);
      await maintenanceQueue.close();
    },
  };
}
