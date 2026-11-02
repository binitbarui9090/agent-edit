import { QUEUES, SYSTEM_JOBS } from '@agent-edit/shared';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';

export interface PingResult {
  pong: true;
  workerId: string;
  echo: unknown;
}

/** Proves the API → Redis → worker path end to end. Real processors arrive in Phase 2. */
export function createSystemWorker(connection: Redis, workerId: string, prefix?: string): Worker {
  return new Worker(
    QUEUES.system,
    async (job): Promise<PingResult> => {
      if (job.name !== SYSTEM_JOBS.ping) throw new Error(`Unknown system job: ${job.name}`);
      return { pong: true, workerId, echo: job.data };
    },
    { connection, concurrency: 1, ...(prefix ? { prefix } : {}) },
  );
}
