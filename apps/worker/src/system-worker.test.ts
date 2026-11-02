import { QUEUES, SYSTEM_JOBS, WORKER_HEARTBEAT_PREFIX } from '@agent-edit/shared';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { startHeartbeat } from './heartbeat.js';
import { createSystemWorker, type PingResult } from './system-worker.js';

const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const prefix = `test_${Date.now()}`;
const redis = new Redis(url, { maxRetriesPerRequest: null });

afterAll(async () => {
  const keys = await redis.keys(`${prefix}:*`);
  if (keys.length > 0) await redis.del(keys);
  redis.disconnect();
});

describe('system queue', () => {
  it('round-trips a job through real Redis to a worker', async () => {
    const worker = createSystemWorker(redis, 'test-worker', prefix);
    const queue = new Queue(QUEUES.system, { connection: redis, prefix });
    const events = new QueueEvents(QUEUES.system, { connection: { url }, prefix });
    await events.waitUntilReady();

    const job = await queue.add(SYSTEM_JOBS.ping, { hello: 'world' });
    const result = (await job.waitUntilFinished(events)) as PingResult;
    expect(result).toEqual({ pong: true, workerId: 'test-worker', echo: { hello: 'world' } });

    await worker.close();
    await events.close();
    await queue.close();
  });

  it('marks unknown job names as failed rather than silently succeeding', async () => {
    const worker = createSystemWorker(redis, 'test-worker', prefix);
    const queue = new Queue(QUEUES.system, { connection: redis, prefix });
    const events = new QueueEvents(QUEUES.system, { connection: { url }, prefix });
    await events.waitUntilReady();

    const job = await queue.add('bogus', {});
    await expect(job.waitUntilFinished(events)).rejects.toThrow('Unknown system job');

    await worker.close();
    await events.close();
    await queue.close();
  });
});

describe('heartbeat', () => {
  it('registers an expiring key and removes it on stop', async () => {
    const id = `${prefix}-hb`;
    const key = `${WORKER_HEARTBEAT_PREFIX}${id}`;
    const stop = startHeartbeat(redis, id, pino({ level: 'silent' }));
    await expect.poll(() => redis.ttl(key)).toBeGreaterThan(0);
    await stop();
    expect(await redis.exists(key)).toBe(0);
  });
});
