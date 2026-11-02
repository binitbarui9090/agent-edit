export const QUEUES = {
  system: 'system',
} as const;

export const SYSTEM_JOBS = {
  ping: 'ping',
} as const;

export const WORKER_HEARTBEAT_PREFIX = 'worker:heartbeat:';
export const WORKER_HEARTBEAT_TTL_SECONDS = 15;
