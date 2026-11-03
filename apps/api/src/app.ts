import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
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
import { recentRendersRoutes, renderRoutes } from './modules/renders/routes.js';
import { RenderService } from './modules/renders/service.js';
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

  await app.register(errorsPlugin, { spaFallback: Boolean(config.WEB_DIST) });
  await app.register(helmet, { contentSecurityPolicy: { directives: contentSecurity(config) } });
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
    maxStorageBytesPerUser: config.MAX_STORAGE_BYTES_PER_USER,
  });

  const timelines = new TimelineService({ database, redis, projects });

  const renders = new RenderService({
    database,
    redis,
    queues,
    storage,
    projects,
    timelines,
    maxActivePerUser: config.MAX_ACTIVE_RENDERS_PER_USER,
  });
  const agent = new AgentService({
    database,
    redis,
    queues,
    projects,
    timelines,
    maxActivePerUser: config.MAX_ACTIVE_AGENT_RUNS_PER_USER,
  });

  await app.register(authPlugin, { auth, webOrigin: config.WEB_ORIGIN });
  await app.register(healthRoutes, { prefix: '/health', database, redis, storage });
  await app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: '/auth', auth, config });
      await api.register(projectRoutes, { prefix: '/projects', projects });
      await api.register(mediaRoutes, { prefix: '/projects', media });
      await api.register(timelineRoutes, { prefix: '/projects', timelines });
      await api.register(agentRoutes, { prefix: '/projects', agent });
      await api.register(renderRoutes, { prefix: '/projects', renders, timelines });
      await api.register(recentRendersRoutes, { prefix: '/renders', renders });
      await api.register(realtimeRoutes, { auth, projects, redis, webOrigin: config.WEB_ORIGIN });
    },
    { prefix: '/api/v1' },
  );

  if (config.WEB_DIST)
    await app.register(fastifyStatic, { root: config.WEB_DIST, wildcard: false });

  return app;
}

/**
 * Written for the app this server can host. Media comes from storage on another origin. React and the
 * playback engine set styles through the DOM, but libraries may add style tags, hence unsafe-inline
 * for styles only. Scripts stay strictly same-origin.
 */
function contentSecurity(config: Config) {
  const storage = new URL(config.S3_PUBLIC_ENDPOINT).origin;
  const socket = new URL(config.WEB_ORIGIN);
  const socketOrigin = `${socket.protocol === 'https:' ? 'wss:' : 'ws:'}//${socket.host}`;
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    fontSrc: ["'self'"],
    imgSrc: ["'self'", 'data:', storage],
    mediaSrc: ["'self'", storage],
    connectSrc: ["'self'", storage, socketOrigin],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    frameAncestors: ["'none'"],
    formAction: ["'self'"],
    // Off so a plain-HTTP deployment on a private network still loads its media.
    upgradeInsecureRequests: null,
  };
}
