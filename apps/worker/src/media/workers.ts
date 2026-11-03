import { type AgentJobData, type MediaJobData, type RenderJobData } from '@agent-edit/infra';
import { MAINTENANCE_JOBS, QUEUES } from '@agent-edit/shared';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { processAgentRun } from '../agent/run.js';
import { handleRenderFailure, processRender } from '../render/run.js';
import { handleStepFailure, processStep, type PipelineContext } from './pipeline.js';
import { sweep } from './sweep.js';

export interface WorkerOptions {
  connection: ConnectionOptions;
  prefix?: string;
  mediaConcurrency: number;
  proxyConcurrency: number;
  analysisConcurrency: number;
  renderConcurrency: number;
  workDir: string;
}

const SWEEP_EVERY_MS = 10 * 60 * 1000;

export async function startMediaWorkers(
  ctx: PipelineContext,
  {
    connection,
    prefix,
    mediaConcurrency,
    proxyConcurrency,
    analysisConcurrency,
    renderConcurrency,
    workDir,
  }: WorkerOptions,
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
  const analysis = build(QUEUES.analysis, analysisConcurrency);

  const agent = new Worker<AgentJobData>(
    QUEUES.agent,
    (job) => processAgentRun(ctx, job.data.runId),
    {
      ...base,
      // Long by design: a local model can take minutes per plan, and a lost lock would run it twice.
      lockDuration: 10 * 60 * 1000,
      concurrency: 2,
    },
  );
  agent.on('error', (err) => ctx.log.error({ err }, 'agent worker error'));
  agent.on('failed', (job, err) =>
    ctx.log.error({ err, runId: job?.data.runId }, 'agent run failed'),
  );

  const render = new Worker<RenderJobData>(
    QUEUES.render,
    (job) => processRender(ctx, job.data.renderId, workDir, job.attemptsMade),
    {
      ...base,
      concurrency: renderConcurrency,
      // A chunk can take a while and the lock renews itself, but a stall must not start a second copy.
      lockDuration: 2 * 60 * 1000,
    },
  );
  render.on('error', (err) => ctx.log.error({ err }, 'render worker error'));
  render.on('failed', (job, err) => {
    if (!job) return;
    void handleRenderFailure(
      ctx,
      job.data.renderId,
      err,
      job.attemptsMade >= (job.opts.attempts ?? 1),
    ).catch((failure: unknown) =>
      ctx.log.error({ err: failure }, 'could not record render failure'),
    );
  });

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
      await Promise.all([
        media.close(),
        proxy.close(),
        analysis.close(),
        agent.close(),
        render.close(),
        maintenance.close(),
      ]);
      await maintenanceQueue.close();
    },
  };
}
