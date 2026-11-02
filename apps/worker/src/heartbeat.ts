import { WORKER_HEARTBEAT_PREFIX, WORKER_HEARTBEAT_TTL_SECONDS } from '@agent-edit/shared';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

/** A key that expires on its own, so a crashed worker disappears from /health/ready. */
export function startHeartbeat(redis: Redis, workerId: string, log: Logger): () => Promise<void> {
  const key = `${WORKER_HEARTBEAT_PREFIX}${workerId}`;
  const beat = () =>
    redis
      .set(key, new Date().toISOString(), 'EX', WORKER_HEARTBEAT_TTL_SECONDS)
      .catch((err: unknown) => log.warn({ err }, 'heartbeat failed'));
  void beat();
  const timer = setInterval(beat, (WORKER_HEARTBEAT_TTL_SECONDS * 1000) / 3);
  return async () => {
    clearInterval(timer);
    await redis.del(key).catch(() => undefined);
  };
}
