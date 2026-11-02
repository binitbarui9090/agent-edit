import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Config } from './config.js';
import type { Database, MediaQueues, Storage } from '@agent-edit/infra';
import { agentRoutes } from './modules/agent/routes.js';
import { AgentService } from './modules/agent/service.js';
import { authRoutes } from './modules/auth/routes.js';
import { AuthService } from './modules/auth/service.js';
import { healthRoutes } from './modules/health/routes.js';
import { mediaRoutes } from './modules/media/routes.js';
import { MediaService } from './modules/media/service.js';
import { projectRoutes } from './modules/projects/routes.js';
import { ProjectService } from './modules/projects/service.js';
import { realtimeRoutes } from './modules/realtime/routes.js';
import { timelineRoutes } from './modules/timelines/routes.js';
import { TimelineService } from './modules/timelines/service.js';
import { authPlugin } from './plugins/auth.js';
import { errorsPlugin } from './plugins/errors.js';

export interface AppDeps {
  config: Config;
  database: Database;
  redis: Redis;
  storage: Storage;
  queues: MediaQueues;
}

export async function buildApp({
  config,
  database,
  redis,
  storage,
  queues,
}: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
    genReqId: () => randomUUID(),
    trustProxy: (_address, hop) => hop < config.TRUST_PROXY_HOPS,
    // Media bytes go straight to object storage, so API bodies are only ever small JSON.
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(errorsPlugin);
  await app.register(helmet);
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 4096 } });
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_GLOBAL_PER_MINUTE,
    timeWindow: '1 minute',
    redis,
    nameSpace: `${config.MONGO_DB}:rate:`,
    // A Redis outage degrades rate limiting; it must not take down sign-in and project access.
    skipOnError: true,
  });

  const auth = new AuthService(database, config.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  const projects = new ProjectService(database, storage);
  const media = new MediaService({
    database,
    storage,
    queues,
    redis,
    projects,
    maxUploadBytes: config.MAX_UPLOAD_BYTES,
  });

  const timelines = new TimelineService({ database, redis, projects });

  const agent = new AgentService({ database, redis, queues, projects, timelines });

  await app.register(authPlugin, { auth, webOrigin: config.WEB_ORIGIN });
  await app.register(healthRoutes, { prefix: '/health', database, redis, storage });
  await app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: '/auth', auth, config });
      await api.register(projectRoutes, { prefix: '/projects', projects });
      await api.register(mediaRoutes, { prefix: '/projects', media });
      await api.register(timelineRoutes, { prefix: '/projects', timelines });
      await api.register(agentRoutes, { prefix: '/projects', agent });
      await api.register(realtimeRoutes, { auth, projects, redis, webOrigin: config.WEB_ORIGIN });
    },
    { prefix: '/api/v1' },
  );

  return app;
}
