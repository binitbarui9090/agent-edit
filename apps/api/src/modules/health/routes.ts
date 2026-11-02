import { WORKER_HEARTBEAT_PREFIX } from '@agent-edit/shared';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Database } from '../../infra/mongo.js';

async function check(probe: () => Promise<unknown>): Promise<boolean> {
  try {
    await probe();
    return true;
  } catch {
    return false;
  }
}

async function countWorkers(redis: Redis): Promise<number> {
  let cursor = '0';
  let count = 0;
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${WORKER_HEARTBEAT_PREFIX}*`,
      'COUNT',
      100,
    );
    cursor = next;
    count += keys.length;
  } while (cursor !== '0');
  return count;
}

export async function healthRoutes(
  app: FastifyInstance,
  { database, redis }: { database: Database; redis: Redis },
) {
  const noLimit = { config: { rateLimit: false } } as const;

  app.get('/live', noLimit, async () => ({ status: 'ok' }));

  // Workers are reported but do not gate readiness: the API can still serve while they restart.
  app.get('/ready', noLimit, async (_req, reply) => {
    const [mongo, redisUp] = await Promise.all([
      check(() => database.db.command({ ping: 1 })),
      check(() => redis.ping()),
    ]);
    const workers = redisUp ? await countWorkers(redis).catch(() => 0) : 0;
    const ready = mongo && redisUp;
    return reply
      .status(ready ? 200 : 503)
      .send({ status: ready ? 'ok' : 'unavailable', mongo, redis: redisUp, workers });
  });
}
