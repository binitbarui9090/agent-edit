import { STEP_DEPENDENCIES, type ProcessingStep } from '@agent-edit/shared';
import type { JobStatus } from '@agent-edit/validation';
import type { Database } from './mongo.js';
import type { MediaQueues } from './pipeline.js';

const TERMINAL: ReadonlySet<JobStatus> = new Set(['done', 'failed', 'skipped']);

/**
 * Enqueues every queued step whose dependencies have finished. Called after each step, and safe to
 * call as often as you like: job ids are deterministic, so a repeat is ignored.
 */
export async function enqueueReadySteps(
  database: Database,
  queues: MediaQueues,
  mediaId: string,
  projectId: string,
  generation: number,
): Promise<void> {
  const jobs = await database.analysisJobs.find({ mediaId }).toArray();
  const status = new Map<ProcessingStep, JobStatus>(jobs.map((job) => [job.step, job.status]));
  for (const job of jobs) {
    if (job.status !== 'queued') continue;
    const ready = STEP_DEPENDENCIES[job.step].every((dependency) => {
      const state = status.get(dependency);
      return state !== undefined && TERMINAL.has(state);
    });
    if (ready) await queues.enqueue(job.step, { mediaId, projectId }, generation);
  }
}
