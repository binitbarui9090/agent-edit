import { hostname } from 'node:os';
import { join } from 'node:path';
import { createAiProviders } from '@agent-edit/ai-engine';
import { MediaQueues, Storage, connectMongo } from '@agent-edit/infra';
import { ProcessTracker } from '@agent-edit/media-engine';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { startHeartbeat } from './heartbeat.js';
import { SourceCache } from './media/source-cache.js';
import { PROCESS_DIR_NAME } from './media/sweep.js';
import { startMediaWorkers } from './media/workers.js';
import { createSystemWorker } from './system-worker.js';

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL, base: { service: 'worker' } });
const workerId = `${hostname()}:${process.pid}`;

// BullMQ requires maxRetriesPerRequest: null on blocking connections.
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
redis.on('error', (err) => log.error({ err }, 'redis error'));

const database = await connectMongo(config.MONGO_URL, config.MONGO_DB);
const storage = new Storage(config);
const queues = new MediaQueues({ connection: redis });
const shutdownController = new AbortController();

// Before taking work, so a crashed predecessor's encoder is not competing with its own retry.
const tracker = new ProcessTracker(join(config.WORK_DIR, PROCESS_DIR_NAME));
const orphansKilled = await tracker.reap();
if (orphansKilled > 0) log.warn({ orphansKilled }, 'stopped FFmpeg left by a dead worker');

const stopHeartbeat = startHeartbeat(redis, workerId, log);
const systemWorker = createSystemWorker(redis, workerId);
systemWorker.on('failed', (job, err) => log.error({ jobId: job?.id, err }, 'job failed'));
systemWorker.on('error', (err) => log.error({ err }, 'worker error'));

const mediaWorkers = await startMediaWorkers(
  {
    database,
    storage,
    queues,
    redis,
    cache: new SourceCache(storage, config.WORK_DIR),
    binaries: { ffmpeg: config.FFMPEG_PATH, ffprobe: config.FFPROBE_PATH },
    tracker,
    ai: createAiProviders(config),
    log,
    signal: shutdownController.signal,
  },
  {
    connection: redis,
    mediaConcurrency: config.MEDIA_CONCURRENCY,
    proxyConcurrency: config.PROXY_CONCURRENCY,
    analysisConcurrency: config.ANALYSIS_CONCURRENCY,
    renderConcurrency: config.RENDER_CONCURRENCY,
    workDir: config.WORK_DIR,
  },
);

log.info({ workerId, workDir: config.WORK_DIR }, 'worker started');

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'draining');
  // A running encode could take hours. Stop it now: BullMQ retries the job on the next worker.
  shutdownController.abort();
  await systemWorker.close();
  await mediaWorkers.close();
  await queues.close();
  await stopHeartbeat();
  redis.disconnect();
  await database.client.close();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
