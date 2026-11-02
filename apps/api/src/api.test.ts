import { newId } from '@agent-edit/shared';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { MediaQueues, Storage, connectMongo, type Database } from '@agent-edit/infra';
import { createRedis } from './infra/redis.js';

// Runs against the real services from docker-compose.yml, in a throwaway database.
const DB_NAME = `agent_edit_test_${Date.now()}`;
const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  MONGO_URL: process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017',
  MONGO_DB: DB_NAME,
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:8333',
  S3_PUBLIC_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:8333',
  S3_REGION: 'us-east-1',
  // A fixed name, so a crashed run cannot leak buckets: storage reserves volumes for each one.
  S3_BUCKET: 'agent-edit-test-api',
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? 'agent-edit-dev',
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? 'agent-edit-dev-secret',
  // Small enough for the size-limit test, large enough for its multipart files.
  MAX_UPLOAD_BYTES: String(64 * 1024 * 1024),
  RATE_LIMIT_GLOBAL_PER_MINUTE: '100000',
  RATE_LIMIT_AUTH_PER_MINUTE: '1000',
});

const settings = {
  aspectRatio: '16:9',
  width: 1920,
  height: 1080,
  frameRate: { num: 30000, den: 1001 },
};
const password = 'correct horse battery staple';

let app: FastifyInstance;
let database: Database;
let redis: Redis;
let storage: Storage;
let queues: MediaQueues;

async function signUp(
  email = `${newId('usr')}@example.com`,
): Promise<{ cookie: string; email: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, displayName: 'Test', password },
  });
  expect(res.statusCode).toBe(201);
  const session = res.cookies.find((c) => c.name === 'ae_session');
  if (!session) throw new Error('no session cookie');
  return { cookie: `ae_session=${session.value}`, email };
}

beforeAll(async () => {
  database = await connectMongo(config.MONGO_URL, config.MONGO_DB);
  redis = createRedis(config.REDIS_URL);
  storage = new Storage(config);
  await storage.ensureBucket([config.WEB_ORIGIN]);
  queues = new MediaQueues({ connection: redis, prefix: DB_NAME });
  app = await buildApp({ config, database, redis, storage, queues });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await queues.close();
  await storage.deleteBucket();
  await database.db.dropDatabase();
  await database.client.close();
  const keys = await redis.keys(`${DB_NAME}:*`);
  if (keys.length > 0) await redis.del(keys);
  redis.disconnect();
});

describe('health', () => {
  it('reports real dependency state', async () => {
    const res = await app.inject({ url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', mongo: true, redis: true, storage: true });
  });
});

describe('auth', () => {
  it('registers, resolves the session and logs out', async () => {
    const { cookie, email } = await signUp();
    const me = await app.inject({ url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.json().user.email).toBe(email);
    expect(me.json().user.passwordHash).toBeUndefined();

    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie },
    });
    expect(out.statusCode).toBe(204);
    const after = await app.inject({ url: '/api/v1/auth/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('sets a hardened cookie and stores only a token hash and a salted password hash', async () => {
    const email = `${newId('usr')}@example.com`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, displayName: 'Test', password },
    });
    const session = res.cookies.find((c) => c.name === 'ae_session');
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Lax');

    const user = await database.users.findOne({ email });
    expect(user?.passwordHash).toMatch(/^scrypt\$/);
    expect(user?.passwordHash).not.toContain(password);
    const stored = await database.sessions.findOne({ userId: user?._id });
    expect(stored?.tokenHash).not.toBe(session?.value);
  });

  it('rejects a duplicate email regardless of case', async () => {
    const { email } = await signUp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: email.toUpperCase(), displayName: 'Other', password },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('email_taken');
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const { email } = await signUp();
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'not the password' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody@example.com', password: 'not the password' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.message).toBe(unknown.json().error.message);
  });

  it('logs in with valid credentials', async () => {
    const { email } = await signUp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects an expired session even before TTL cleanup runs', async () => {
    const { cookie, email } = await signUp();
    const user = await database.users.findOne({ email });
    await database.sessions.updateMany(
      { userId: user?._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const res = await app.inject({ url: '/api/v1/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects state-changing requests from another origin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://evil.example' },
      payload: { email: 'a@b.co', password: 'whatever' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('projects', () => {
  async function create(cookie: string, name = 'Demo') {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name, settings },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  it('requires authentication', async () => {
    const res = await app.inject({ url: '/api/v1/projects' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
  });

  it('creates, reads, updates and deletes', async () => {
    const { cookie } = await signUp();
    const project = await create(cookie);
    expect(project.id).toMatch(/^prj_/);

    const got = await app.inject({ url: `/api/v1/projects/${project.id}`, headers: { cookie } });
    expect(got.json().settings).toEqual(settings);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.id}`,
      headers: { cookie },
      payload: { name: 'Renamed' },
    });
    expect(patched.json().name).toBe('Renamed');
    expect(patched.json().updatedAt >= project.updatedAt).toBe(true);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${project.id}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(204);
    const gone = await app.inject({ url: `/api/v1/projects/${project.id}`, headers: { cookie } });
    expect(gone.statusCode).toBe(404);
    expect(await database.projects.countDocuments({ _id: project.id })).toBe(1);
  });

  it('hides other users projects behind 404 for every verb', async () => {
    const owner = await signUp();
    const intruder = await signUp();
    const { id } = await create(owner.cookie);
    const headers = { cookie: intruder.cookie };

    const responses = await Promise.all([
      app.inject({ url: `/api/v1/projects/${id}`, headers }),
      app.inject({
        method: 'PATCH',
        url: `/api/v1/projects/${id}`,
        headers,
        payload: { name: 'pwned' },
      }),
      app.inject({ method: 'DELETE', url: `/api/v1/projects/${id}`, headers }),
    ]);
    for (const res of responses) expect(res.statusCode).toBe(404);

    const list = await app.inject({ url: '/api/v1/projects', headers });
    expect(list.json().items).toEqual([]);
    const intact = await database.projects.findOne({ _id: id });
    expect(intact?.name).toBe('Demo');
    expect(intact?.deletedAt).toBeNull();
  });

  it('paginates by most recently modified without gaps or repeats', async () => {
    const { cookie } = await signUp();
    const created: string[] = [];
    for (let i = 0; i < 5; i++) created.push((await create(cookie, `P${i}`)).id);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
      const res = await app.inject({ url: `/api/v1/projects${query}`, headers: { cookie } });
      const page = res.json();
      seen.push(...page.items.map((p: { id: string }) => p.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...created].reverse());
  });

  it.each([
    ['invalid settings', { name: 'x', settings: { ...settings, height: 1000 } }],
    ['blank name', { name: '   ', settings }],
    ['mass assignment', { name: 'x', settings, ownerId: 'usr_someone' }],
    ['operator injection', { name: { $ne: null }, settings }],
  ])('rejects %s', async (_label, payload) => {
    const { cookie } = await signUp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
  });

  it('rejects malformed ids and cursors with 400, not a database error', async () => {
    const { cookie } = await signUp();
    const badId = await app.inject({ url: '/api/v1/projects/not-an-id', headers: { cookie } });
    expect(badId.statusCode).toBe(400);
    const badCursor = await app.inject({
      url: '/api/v1/projects?cursor=!!!',
      headers: { cookie },
    });
    expect(badCursor.statusCode).toBe(400);
  });
});

describe('platform', () => {
  it('keeps serving and reports the truth when Redis is unreachable', async () => {
    const deadRedis = createRedis('redis://127.0.0.1:1');
    const degraded = await buildApp({ config, database, redis: deadRedis, storage, queues });
    await degraded.ready();

    const ready = await degraded.inject({ url: '/health/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ status: 'unavailable', mongo: true, redis: false });

    const login = await degraded.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody@example.com', password: 'whatever' },
    });
    expect(login.statusCode).toBe(401);

    await degraded.close();
    deadRedis.disconnect();
  });

  it('returns JSON errors with a request id and no internals for unknown routes', async () => {
    const res = await app.inject({ url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.requestId).toBeTruthy();
  });

  it('rate limits auth endpoints through Redis', async () => {
    const strict = await buildApp({
      config: {
        ...config,
        MONGO_DB: `${DB_NAME}:strict`,
        RATE_LIMIT_AUTH_PER_MINUTE: 2,
      },
      database,
      redis,
      storage,
      queues,
    });
    await strict.ready();
    const attempt = () =>
      strict.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'a@b.co', password: 'nope' },
      });
    expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(401);
    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');
    await strict.close();
  });
});
