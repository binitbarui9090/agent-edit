import { loginRequestSchema, registerRequestSchema } from '@agent-edit/validation';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from '../../config.js';
import { SESSION_COOKIE, currentUser } from '../../plugins/auth.js';
import { toUser, type AuthService } from './service.js';

export async function authRoutes(
  app: FastifyInstance,
  { auth, config }: { auth: AuthService; config: Config },
) {
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production',
  } as const;

  function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date) {
    void reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions, expires: expiresAt });
  }

  const strictLimit = {
    config: { rateLimit: { max: config.RATE_LIMIT_AUTH_PER_MINUTE, timeWindow: '1 minute' } },
  };

  app.post('/register', strictLimit, async (req, reply) => {
    const input = registerRequestSchema.parse(req.body);
    const user = await auth.register(input);
    const session = await auth.createSession(user._id, req.headers['user-agent']);
    setSessionCookie(reply, session.token, session.expiresAt);
    return reply.status(201).send({ user: toUser(user) });
  });

  app.post('/login', strictLimit, async (req, reply) => {
    const input = loginRequestSchema.parse(req.body);
    const user = await auth.login(input);
    const session = await auth.createSession(user._id, req.headers['user-agent']);
    setSessionCookie(reply, session.token, session.expiresAt);
    return { user: toUser(user) };
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await auth.revokeSession(token);
    void reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return reply.status(204).send();
  });

  app.get('/me', { preHandler: app.requireUser }, async (req) => ({
    user: toUser(currentUser(req)),
  }));
}
