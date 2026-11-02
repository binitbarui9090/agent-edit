import { QUEUES, queueForStep, type ProcessingStep } from '@agent-edit/shared';
import { Queue, type JobsOptions, type QueueOptions } from 'bullmq';
import type { AnalysisJobDoc } from './mongo.js';

export interface MediaJobData {
  mediaId: string;
  projectId: string;
}

export const MEDIA_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 5000 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 5000 },
};

/** BullMQ forbids ':' in custom ids. A repeated id is ignored, which makes enqueueing retry-safe. */
export function mediaJobId(mediaId: string, step: ProcessingStep, generation: number): string {
  return `${mediaId}.${step}.${generation}`;
}

export interface AgentJobData {
  runId: string;
}

export class MediaQueues {
  private readonly media: Queue<MediaJobData>;
  private readonly proxy: Queue<MediaJobData>;
  private readonly analysis: Queue<MediaJobData>;
  private readonly agent: Queue<AgentJobData>;

  constructor(options: QueueOptions) {
    this.media = new Queue(QUEUES.media, options);
    this.proxy = new Queue(QUEUES.proxy, options);
    this.analysis = new Queue(QUEUES.analysis, options);
    this.agent = new Queue(QUEUES.agent, options);
  }

  private queueFor(step: ProcessingStep) {
    return this[queueForStep(step)];
  }

  async enqueue(step: ProcessingStep, data: MediaJobData, generation: number): Promise<void> {
    await this.queueFor(step).add(step, data, {
      ...MEDIA_JOB_OPTIONS,
      jobId: mediaJobId(data.mediaId, step, generation),
    });
  }

  async exists(step: ProcessingStep, mediaId: string, generation: number): Promise<boolean> {
    const job = await this.queueFor(step).getJob(mediaJobId(mediaId, step, generation));
    return job !== undefined;
  }

  /** Not retried by BullMQ: a repeated model call costs money and rarely changes the answer. */
  async enqueueAgent(runId: string): Promise<void> {
    await this.agent.add(
      'plan',
      { runId },
      { jobId: runId, removeOnComplete: { age: 86_400 }, removeOnFail: { age: 604_800 } },
    );
  }

  async close(): Promise<void> {
    await Promise.all([
      this.media.close(),
      this.proxy.close(),
      this.analysis.close(),
      this.agent.close(),
    ]);
  }
}

export function newJobDoc(
  projectId: string,
  mediaId: string,
  step: ProcessingStep,
  now: Date,
): AnalysisJobDoc {
  return {
    _id: `${mediaId}.${step}`,
    projectId,
    mediaId,
    step,
    status: 'queued',
    progress: 0,
    attempts: 0,
    error: null,
    // AI steps overwrite this with the adapter that actually did the work.
    provider: { id: 'ffmpeg', isMock: false },
    note: null,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
  };
}
