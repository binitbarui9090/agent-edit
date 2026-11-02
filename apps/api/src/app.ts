import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Config } from './config.js';
import type { Database } from './infra/mongo.js';
import { authRoutes } from './modules/auth/routes.js';
import { AuthService } from './modules/auth/service.js';
import { healthRoutes } from './modules/health/routes.js';
import { projectRoutes } from './modules/projects/routes.js';
import { ProjectService } from './modules/projects/service.js';
import { authPlugin } from './plugins/auth.js';
import { errorsPlugin } from './plugins/errors.js';

export interface AppDeps {
  config: Config;
  database: Database;
  redis: Redis;
}

export async function buildApp({ config, database, redis }: AppDeps): Promise<FastifyInstance> {
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
  const projects = new ProjectService(database);

  await app.register(authPlugin, { auth, webOrigin: config.WEB_ORIGIN });
  await app.register(healthRoutes, { prefix: '/health', database, redis });
  await app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: '/auth', auth, config });
      await api.register(projectRoutes, { prefix: '/projects', projects });
    },
    { prefix: '/api/v1' },
  );

  return app;
}
