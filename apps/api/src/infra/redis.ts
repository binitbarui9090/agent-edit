import { Redis } from 'ioredis';

export function createRedis(url: string): Redis {
  // Fail commands quickly while Redis is down, so requests are not held up by rate limiting and
  // readiness reports the truth.
  const redis = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 2000 });
  // ioredis prints to stderr unless a listener exists. index.ts adds the one that logs.
  redis.on('error', () => undefined);
  return redis;
}
