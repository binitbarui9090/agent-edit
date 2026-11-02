import { projectEventChannel } from '@agent-edit/shared';
import { clientEventSchema } from '@agent-edit/validation';
import type { WebSocket } from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { AppError } from '../../errors.js';
import { SESSION_COOKIE, currentUser } from '../../plugins/auth.js';
import type { AuthService } from '../auth/service.js';
import type { ProjectService } from '../projects/service.js';

const SESSION_RECHECK_MS = 60_000;
/** Application-level, because browsers hide protocol pings from page code. */
const HEARTBEAT_INTERVAL_MS = 25_000;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_NOT_FOUND = 4404;

interface RealtimeOptions {
  auth: AuthService;
  projects: ProjectService;
  redis: Redis;
  webOrigin: string;
}

/** Relays worker events from Redis to the sockets watching each project. */
export async function realtimeRoutes(
  app: FastifyInstance,
  { auth, projects, redis, webOrigin }: RealtimeOptions,
) {
  const subscriber = redis.duplicate();
  subscriber.on('error', (err) => app.log.warn({ err }, 'realtime subscriber error'));
  const sockets = new Map<string, Set<WebSocket>>();

  subscriber.on('message', (channel, message) => {
    for (const socket of sockets.get(channel) ?? []) socket.send(message);
  });

  function leave(channel: string, socket: WebSocket) {
    const members = sockets.get(channel);
    if (!members) return;
    members.delete(socket);
    if (members.size > 0) return;
    sockets.delete(channel);
    void subscriber.unsubscribe(channel).catch(() => undefined);
  }

  async function join(channel: string, socket: WebSocket) {
    const members = sockets.get(channel);
    if (members) {
      members.add(socket);
      return;
    }
    sockets.set(channel, new Set([socket]));
    await subscriber.subscribe(channel);
  }

  app.addHook('onClose', async () => {
    subscriber.disconnect();
  });

  async function authorizeUpgrade(req: FastifyRequest) {
    currentUser(req);
    // Browsers do not apply CORS to WebSockets, so a hostile page could otherwise open one here.
    const { origin } = req.headers;
    if (origin !== undefined && origin !== webOrigin) {
      throw new AppError('forbidden', 'Cross-origin request rejected');
    }
  }

  app.get('/ws', { websocket: true, preValidation: authorizeUpgrade }, (socket, req) => {
    const user = currentUser(req);
    const token = req.cookies[SESSION_COOKIE] ?? '';
    let channel: string | null = null;

    const heartbeat = setInterval(
      () => socket.send(JSON.stringify({ type: 'heartbeat' })),
      HEARTBEAT_INTERVAL_MS,
    );
    // A long-lived socket must not outlast the session that opened it.
    const recheck = setInterval(() => {
      void auth.resolveSession(token).then((current) => {
        if (!current) socket.close(CLOSE_UNAUTHORIZED, 'Session ended');
      });
    }, SESSION_RECHECK_MS);

    socket.on('message', (raw: Buffer) => {
      void (async () => {
        let parsed;
        try {
          parsed = clientEventSchema.parse(JSON.parse(raw.toString()));
          await projects.assertOwned(user._id, parsed.projectId);
        } catch {
          socket.close(CLOSE_NOT_FOUND, 'Unknown project');
          return;
        }
        const next = projectEventChannel(parsed.projectId);
        if (channel && channel !== next) leave(channel, socket);
        channel = next;
        await join(next, socket);
        socket.send(JSON.stringify({ type: 'subscribed', projectId: parsed.projectId }));
      })().catch((err: unknown) => {
        req.log.error({ err }, 'realtime subscribe failed');
        socket.close(1011, 'Subscribe failed');
      });
    });

    socket.on('close', () => {
      clearInterval(heartbeat);
      clearInterval(recheck);
      if (channel) leave(channel, socket);
    });
  });
}
