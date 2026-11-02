import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { MediaQueues, Storage, connectMongo } from '@agent-edit/infra';
import { createRedis } from './infra/redis.js';

const config = loadConfig();
const database = await connectMongo(config.MONGO_URL, config.MONGO_DB);
const redis = createRedis(config.REDIS_URL);
const storage = new Storage(config);
await storage.ensureBucket([config.WEB_ORIGIN]);
const queues = new MediaQueues({ connection: redis });
const app = await buildApp({ config, database, redis, storage, queues });
redis.on('error', (err) => app.log.error({ err }, 'redis error'));

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await queues.close();
  redis.disconnect();
  await database.client.close();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
