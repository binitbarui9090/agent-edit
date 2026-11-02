import { QUEUES, type ProcessingStep } from '@agent-edit/shared';
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

export class MediaQueues {
  private readonly media: Queue<MediaJobData>;
  private readonly proxy: Queue<MediaJobData>;

  constructor(options: QueueOptions) {
    this.media = new Queue(QUEUES.media, options);
    this.proxy = new Queue(QUEUES.proxy, options);
  }

  private queueFor(step: ProcessingStep) {
    return step === 'proxy' ? this.proxy : this.media;
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

  async close(): Promise<void> {
    await Promise.all([this.media.close(), this.proxy.close()]);
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
    // Everything in this pipeline is real FFmpeg work. AI steps will record their adapter here.
    provider: { id: 'ffmpeg', isMock: false },
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
  };
}
