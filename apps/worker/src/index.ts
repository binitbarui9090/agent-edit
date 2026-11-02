import { hostname } from 'node:os';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { startHeartbeat } from './heartbeat.js';
import { createSystemWorker } from './system-worker.js';

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL, base: { service: 'worker' } });
const workerId = `${hostname()}:${process.pid}`;

// BullMQ requires maxRetriesPerRequest: null on blocking connections.
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
redis.on('error', (err) => log.error({ err }, 'redis error'));

const stopHeartbeat = startHeartbeat(redis, workerId, log);
const systemWorker = createSystemWorker(redis, workerId);
systemWorker.on('failed', (job, err) => log.error({ jobId: job?.id, err }, 'job failed'));
systemWorker.on('error', (err) => log.error({ err }, 'worker error'));

log.info({ workerId }, 'worker started');

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'draining');
  await systemWorker.close();
  await stopHeartbeat();
  redis.disconnect();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
