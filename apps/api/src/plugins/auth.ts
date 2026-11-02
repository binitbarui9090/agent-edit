import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../errors.js';
import type { UserDoc } from '@agent-edit/infra';
import type { AuthService } from '../modules/auth/service.js';

export const SESSION_COOKIE = 'ae_session';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserDoc | null;
  }
  interface FastifyInstance {
    requireUser: (req: FastifyRequest) => Promise<void>;
  }
}

export function currentUser(req: FastifyRequest): UserDoc {
  if (!req.user) throw new AppError('unauthenticated', 'Sign in required');
  return req.user;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const authPlugin = fp(
  async (app: FastifyInstance, opts: { auth: AuthService; webOrigin: string }) => {
    app.decorateRequest('user', null);

    // SameSite=Lax blocks cross-site cookies on POST; this also covers same-site subdomains.
    app.addHook('onRequest', async (req) => {
      if (SAFE_METHODS.has(req.method)) return;
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== opts.webOrigin) {
        throw new AppError('forbidden', 'Cross-origin request rejected');
      }
    });

    app.addHook('onRequest', async (req) => {
      const token = req.cookies[SESSION_COOKIE];
      if (token) req.user = await opts.auth.resolveSession(token);
    });

    app.decorate('requireUser', async (req: FastifyRequest) => {
      currentUser(req);
    });
  },
  { dependencies: ['@fastify/cookie'] },
);
