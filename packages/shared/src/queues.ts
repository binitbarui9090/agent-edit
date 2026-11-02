export const QUEUES = {
  system: 'system',
  // Separate queues so a multi-hour proxy encode cannot hold up quick steps for other footage.
  media: 'media',
  proxy: 'media-proxy',
  // One at a time by default: speech recognition uses every core it can get.
  analysis: 'analysis',
  agent: 'agent',
  render: 'render',
  maintenance: 'maintenance',
} as const;

export const SYSTEM_JOBS = {
  ping: 'ping',
} as const;

export const MAINTENANCE_JOBS = {
  sweep: 'sweep',
} as const;

export const WORKER_HEARTBEAT_PREFIX = 'worker:heartbeat:';
export const WORKER_HEARTBEAT_TTL_SECONDS = 15;

export function projectEventChannel(projectId: string): string {
  return `events:project:${projectId}`;
}
