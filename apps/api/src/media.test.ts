import type { Database } from '@agent-edit/infra';
import { MediaQueues, Storage, connectMongo } from '@agent-edit/infra';
import { MIN_PART_SIZE, PROCESSING_STEPS, QUEUES, newId } from '@agent-edit/shared';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createRedis } from './infra/redis.js';

const DB_NAME = `agent_edit_test_media_${Date.now()}`;
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
  S3_BUCKET: 'agent-edit-test-media',
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? 'agent-edit-dev',
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? 'agent-edit-dev-secret',
  MAX_UPLOAD_BYTES: String(64 * 1024 * 1024),
  RATE_LIMIT_GLOBAL_PER_MINUTE: '100000',
  RATE_LIMIT_AUTH_PER_MINUTE: '1000',
});

const settings = { aspectRatio: '16:9', width: 1920, height: 1080, frameRate: { num: 30, den: 1 } };
const FILE_SIZE = MIN_PART_SIZE * 2 + 1024;

let app: FastifyInstance;
let database: Database;
let redis: Redis;
let storage: Storage;
let queues: MediaQueues;
let probeQueue: Queue;

function fingerprint(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface Actor {
  cookie: string;
  projectId: string;
}

async function newActor(): Promise<Actor> {
  const register = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email: `${newId('usr')}@example.com`,
      displayName: 'T',
      password: 'correct horse battery',
    },
  });
  const session = register.cookies.find((c) => c.name === 'ae_session');
  const cookie = `ae_session=${session?.value}`;
  const project = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: { cookie },
    payload: { name: 'P', settings },
  });
  return { cookie, projectId: project.json().id };
}

function call(
  actor: Actor,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  payload?: object,
) {
  return app.inject({
    method,
    url: `/api/v1/projects/${actor.projectId}${path}`,
    headers: { cookie: actor.cookie },
    ...(payload ? { payload } : {}),
  });
}

function initUpload(actor: Actor, over: object = {}) {
  return call(actor, 'POST', '/uploads', {
    name: 'talk.mp4',
    size: FILE_SIZE,
    fingerprint: fingerprint(),
    ...over,
  });
}

/** Uploads through presigned URLs, as the browser does, with no credentials of its own. */
async function putParts(actor: Actor, mediaId: string, partNumbers: number[], sizes: number[]) {
  const signed = await call(actor, 'POST', `/uploads/${mediaId}/parts`, { partNumbers });
  expect(signed.statusCode).toBe(200);
  for (const [index, { url }] of signed.json().urls.entries()) {
    const res = await fetch(url, { method: 'PUT', body: Buffer.alloc(sizes[index]!, index + 1) });
    expect(res.status).toBe(200);
  }
}

const PART_SIZES = [MIN_PART_SIZE, MIN_PART_SIZE, 1024];

beforeAll(async () => {
  database = await connectMongo(config.MONGO_URL, config.MONGO_DB);
  redis = createRedis(config.REDIS_URL);
  storage = new Storage(config);
  await storage.ensureBucket([config.WEB_ORIGIN]);
  queues = new MediaQueues({ connection: redis, prefix: DB_NAME });
  probeQueue = new Queue(QUEUES.media, { connection: redis, prefix: DB_NAME });
  app = await buildApp({ config, database, redis, storage, queues });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await probeQueue.obliterate({ force: true });
  await probeQueue.close();
  await queues.close();
  await database.db.dropDatabase();
  await database.client.close();
  await storage.deleteBucket();
  const keys = await redis.keys(`${DB_NAME}:*`);
  if (keys.length > 0) await redis.del(keys);
  redis.disconnect();
});

describe('upload validation', () => {
  it.each([
    ['an unsupported extension', { name: 'virus.exe' }, 415],
    ['a file over the limit', { size: 65 * 1024 * 1024 }, 413],
    ['an empty file', { size: 0 }, 400],
    ['a malformed fingerprint', { fingerprint: 'nope' }, 400],
  ])('rejects %s', async (_label, over, status) => {
    const actor = await newActor();
    const res = await initUpload(actor, over);
    expect(res.statusCode).toBe(status);
    expect(await database.media.countDocuments({ projectId: actor.projectId })).toBe(0);
  });

  it('never uses the file name in the storage key', async () => {
    const actor = await newActor();
    const name = '../../../etc/passwd.mp4';
    const res = await initUpload(actor, { name });
    expect(res.statusCode).toBe(201);
    const doc = await database.media.findOne({ _id: res.json().media.id });
    expect(doc?.name).toBe(name);
    expect(doc?.storage.originalKey).toBe(`originals/${actor.projectId}/${doc?._id}/source`);
  });

  it('derives the content type from the extension, not the client', async () => {
    const actor = await newActor();
    const res = await initUpload(actor, { name: 'a.MOV' });
    const doc = await database.media.findOne({ _id: res.json().media.id });
    expect(doc?.contentType).toBe('video/quicktime');
  });
});

describe('storage quota', () => {
  it('refuses an upload that would go over the limit, counting everything the user holds', async () => {
    const limited = await buildApp({
      config: {
        ...config,
        MONGO_DB: `${DB_NAME}:quota`,
        MAX_STORAGE_BYTES_PER_USER: FILE_SIZE * 2,
      },
      database,
      redis,
      storage,
      queues,
    });
    await limited.ready();
    const original = app;
    app = limited;
    try {
      const actor = await newActor();
      const first = fingerprint();
      expect((await initUpload(actor, { fingerprint: first })).statusCode).toBe(201);
      expect((await initUpload(actor)).statusCode).toBe(201);
      const refused = await initUpload(actor);
      expect(refused.statusCode).toBe(413);
      expect(refused.json().error.message).toContain('storage limit');
      // Resuming something already counted must still work.
      expect((await initUpload(actor, { fingerprint: first })).statusCode).toBe(200);
    } finally {
      app = original;
      await limited.close();
    }
  });
});

describe('resumable upload', () => {
  it('resumes by fingerprint and reports only the parts storage really has', async () => {
    const actor = await newActor();
    const print = fingerprint();
    const first = await initUpload(actor, { fingerprint: print });
    expect(first.statusCode).toBe(201);
    const { media, partCount, partSize } = first.json();
    expect(partCount).toBe(3);
    expect(partSize).toBe(MIN_PART_SIZE);
    expect(first.json().uploadedParts).toEqual([]);

    await putParts(actor, media.id, [2], [MIN_PART_SIZE]);

    // A later session, knowing only the file itself, picks up the same upload.
    const resumed = await initUpload(actor, { fingerprint: print });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().resumed).toBe(true);
    expect(resumed.json().media.id).toBe(media.id);
    expect(resumed.json().uploadedParts).toEqual([{ partNumber: 2, size: MIN_PART_SIZE }]);
    expect(await database.media.countDocuments({ projectId: actor.projectId })).toBe(1);
  });

  it('converges on one upload when two tabs start the same file at once', async () => {
    const actor = await newActor();
    const print = fingerprint();
    const results = await Promise.all([
      initUpload(actor, { fingerprint: print }),
      initUpload(actor, { fingerprint: print }),
      initUpload(actor, { fingerprint: print }),
    ]);
    expect(new Set(results.map((r) => r.json().media.id)).size).toBe(1);
    expect(await database.media.countDocuments({ projectId: actor.projectId })).toBe(1);
  });

  it('refuses to complete while parts are missing, naming them', async () => {
    const actor = await newActor();
    const { media } = (await initUpload(actor)).json();
    await putParts(actor, media.id, [1], [MIN_PART_SIZE]);

    const res = await call(actor, 'POST', `/uploads/${media.id}/complete`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('upload_incomplete');
    expect(res.json().error.details.missingParts).toEqual([2, 3]);
    expect((await database.media.findOne({ _id: media.id }))?.status).toBe('uploading');
  });

  it('rejects a part with the wrong size, so a client cannot misdeclare the file', async () => {
    const actor = await newActor();
    const { media } = (await initUpload(actor)).json();
    await putParts(actor, media.id, [1, 2, 3], [MIN_PART_SIZE, MIN_PART_SIZE, 999]);
    const res = await call(actor, 'POST', `/uploads/${media.id}/complete`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.missingParts).toEqual([3]);
  });

  it('completes, stores the exact bytes, seeds jobs and enqueues the probe', async () => {
    const actor = await newActor();
    const { media } = (await initUpload(actor)).json();
    await putParts(actor, media.id, [1, 2, 3], PART_SIZES);

    const res = await call(actor, 'POST', `/uploads/${media.id}/complete`);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('processing');
    expect(res.json().jobs.map((j: { step: string }) => j.step)).toEqual([...PROCESSING_STEPS]);
    for (const job of res.json().jobs) expect(job).toMatchObject({ status: 'queued', progress: 0 });

    const doc = await database.media.findOne({ _id: media.id });
    expect(await storage.objectSize(doc!.storage.originalKey)).toBe(FILE_SIZE);
    expect(doc?.upload).toBeNull();
    expect(await probeQueue.getJob(`${media.id}.probe.0`)).toBeDefined();
  });

  it('is idempotent: a repeated complete changes nothing and enqueues nothing new', async () => {
    const actor = await newActor();
    const { media } = (await initUpload(actor)).json();
    await putParts(actor, media.id, [1, 2, 3], PART_SIZES);
    await call(actor, 'POST', `/uploads/${media.id}/complete`);
    const before = await probeQueue.getJobCounts();

    const again = await call(actor, 'POST', `/uploads/${media.id}/complete`);
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe('processing');
    expect(await probeQueue.getJobCounts()).toEqual(before);
  });

  it('recovers when a crash happened after storage completed but before the status changed', async () => {
    const actor = await newActor();
    const { media } = (await initUpload(actor)).json();
    await putParts(actor, media.id, [1, 2, 3], PART_SIZES);
    const doc = await database.media.findOne({ _id: media.id });
    const parts = await storage.listParts(doc!.storage.originalKey, doc!.upload!.s3UploadId);
    await storage.completeMultipart(doc!.storage.originalKey, doc!.upload!.s3UploadId, parts!);

    const res = await call(actor, 'POST', `/uploads/${media.id}/complete`);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('processing');
  });

  it('cancels: aborts storage and removes the record', async () => {
    const actor = await newActor();
    const { media } = (await initUpload(actor)).json();
    await putParts(actor, media.id, [1], [MIN_PART_SIZE]);
    const doc = await database.media.findOne({ _id: media.id });

    expect((await call(actor, 'DELETE', `/uploads/${media.id}`)).statusCode).toBe(204);
    expect(await database.media.findOne({ _id: media.id })).toBeNull();
    expect(await storage.listParts(doc!.storage.originalKey, doc!.upload!.s3UploadId)).toBeNull();
  });

  it('refuses part numbers beyond the file', async () => {
    const actor = await newActor();
    const { media } = (await initUpload(actor)).json();
    const res = await call(actor, 'POST', `/uploads/${media.id}/parts`, { partNumbers: [4] });
    expect(res.statusCode).toBe(400);
  });
});

describe('ownership', () => {
  it('hides another users uploads and media behind 404 on every route', async () => {
    const owner = await newActor();
    const intruder = await newActor();
    const { media } = (await initUpload(owner)).json();
    const stranger: Actor = { cookie: intruder.cookie, projectId: owner.projectId };
    // Their own project id with the victim's media id must not work either.
    const crossed: Actor = { cookie: intruder.cookie, projectId: intruder.projectId };

    const attempts = await Promise.all(
      [stranger, crossed].flatMap((actor) => [
        call(actor, 'GET', `/uploads/${media.id}`),
        call(actor, 'POST', `/uploads/${media.id}/parts`, { partNumbers: [1] }),
        call(actor, 'POST', `/uploads/${media.id}/complete`),
        call(actor, 'DELETE', `/uploads/${media.id}`),
        call(actor, 'GET', `/media/${media.id}`),
        call(actor, 'PATCH', `/media/${media.id}`, { name: 'pwned.mp4' }),
        call(actor, 'DELETE', `/media/${media.id}`),
        call(actor, 'POST', `/media/${media.id}/retry`),
      ]),
    );
    for (const res of attempts) expect(res.statusCode).toBe(404);
    expect((await call(stranger, 'GET', '/media')).statusCode).toBe(404);
    expect((await initUpload(stranger)).statusCode).toBe(404);

    const intact = await database.media.findOne({ _id: media.id });
    expect(intact?.name).toBe('talk.mp4');
    expect(intact?.deletedAt).toBeNull();
  });

  it('requires a signature to read stored media', async () => {
    const actor = await newActor();
    const { media } = (await initUpload(actor)).json();
    await putParts(actor, media.id, [1, 2, 3], PART_SIZES);
    await call(actor, 'POST', `/uploads/${media.id}/complete`);
    const doc = await database.media.findOne({ _id: media.id });
    const res = await fetch(
      `${config.S3_ENDPOINT}/${config.S3_BUCKET}/${doc!.storage.originalKey}`,
    );
    expect(res.status).toBe(403);
  });
});

describe('media library', () => {
  it('renames and files media, and lists newest first', async () => {
    const actor = await newActor();
    const first = (await initUpload(actor, { name: 'one.mp4' })).json().media;
    const second = (await initUpload(actor, { name: 'two.mp4' })).json().media;

    const patched = await call(actor, 'PATCH', `/media/${first.id}`, {
      name: 'Keynote.mp4',
      folder: 'A-roll',
    });
    expect(patched.json()).toMatchObject({ name: 'Keynote.mp4', folder: 'A-roll' });

    const list = await call(actor, 'GET', '/media');
    expect(list.json().items.map((m: { id: string }) => m.id)).toEqual([second.id, first.id]);
  });

  it('paginates without gaps', async () => {
    const actor = await newActor();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await initUpload(actor)).json().media.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await call(actor, 'GET', `/media?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...res.json().items.map((m: { id: string }) => m.id));
      cursor = res.json().nextCursor;
    } while (cursor);
    expect(seen).toEqual([...ids].reverse());
  });

  it('soft deletes media and hides it, keeping objects for the sweep', async () => {
    const actor = await newActor();
    const { media } = (await initUpload(actor)).json();
    await putParts(actor, media.id, [1, 2, 3], PART_SIZES);
    await call(actor, 'POST', `/uploads/${media.id}/complete`);
    const doc = await database.media.findOne({ _id: media.id });

    expect((await call(actor, 'DELETE', `/media/${media.id}`)).statusCode).toBe(204);
    expect((await call(actor, 'GET', `/media/${media.id}`)).statusCode).toBe(404);
    expect((await call(actor, 'GET', '/media')).json().items).toEqual([]);
    expect(await storage.objectSize(doc!.storage.originalKey)).toBe(FILE_SIZE);
  });

  it('marks media deleted with its project', async () => {
    const actor = await newActor();
    const { media } = (await initUpload(actor)).json();
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${actor.projectId}`,
      headers: { cookie: actor.cookie },
    });
    expect((await database.media.findOne({ _id: media.id }))?.deletedAt).toBeInstanceOf(Date);
  });

  it('summarises media on the project', async () => {
    const actor = await newActor();
    await initUpload(actor);
    const { media } = (await initUpload(actor)).json();
    await putParts(actor, media.id, [1, 2, 3], PART_SIZES);
    await call(actor, 'POST', `/uploads/${media.id}/complete`);
    const res = await app.inject({
      url: `/api/v1/projects/${actor.projectId}`,
      headers: { cookie: actor.cookie },
    });
    expect(res.json().media).toEqual({
      total: 2,
      ready: 0,
      processing: 1,
      uploading: 1,
      failed: 0,
      posterUrl: null,
    });
  });

  it('retries failed steps with a fresh job and refuses when nothing failed', async () => {
    const actor = await newActor();
    const { media } = (await initUpload(actor)).json();
    await putParts(actor, media.id, [1, 2, 3], PART_SIZES);
    await call(actor, 'POST', `/uploads/${media.id}/complete`);
    expect((await call(actor, 'POST', `/media/${media.id}/retry`)).statusCode).toBe(409);

    await database.analysisJobs.updateOne(
      { mediaId: media.id, step: 'probe' },
      { $set: { status: 'failed', error: 'boom' } },
    );
    await database.media.updateOne(
      { _id: media.id },
      { $set: { status: 'failed', error: 'boom' } },
    );
    const res = await call(actor, 'POST', `/media/${media.id}/retry`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'processing', error: null });
    expect(await probeQueue.getJob(`${media.id}.probe.1`)).toBeDefined();
  });
});

describe('realtime', () => {
  let port: number;

  beforeAll(async () => {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    port = Number(new URL(address).port);
  });

  /** A real client over a real socket, resolving to the HTTP status if the upgrade is refused. */
  function connect(cookie: string, origin?: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`, {
      headers: { cookie, ...(origin ? { origin } : {}) },
    });
    return new Promise<WebSocket>((resolve, reject) => {
      socket.once('open', () => resolve(socket));
      socket.once('unexpected-response', (_req, res) => reject(new Error(String(res.statusCode))));
      socket.once('error', reject);
    });
  }

  function nextMessage(socket: WebSocket) {
    return new Promise<Record<string, unknown>>((resolve) => {
      socket.once('message', (data: Buffer) => resolve(JSON.parse(data.toString())));
    });
  }

  it('refuses a connection without a session', async () => {
    await expect(connect('ae_session=invalid')).rejects.toThrow('401');
  });

  it('refuses a connection from another origin', async () => {
    const { cookie } = await newActor();
    await expect(connect(cookie, 'https://evil.example')).rejects.toThrow('403');
  });

  it('closes on a project the user does not own', async () => {
    const owner = await newActor();
    const intruder = await newActor();
    const socket = await connect(intruder.cookie);
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
    socket.send(JSON.stringify({ type: 'subscribe', projectId: owner.projectId }));
    expect(await closed).toBe(4404);
  });

  it('delivers events for the subscribed project only', async () => {
    const actor = await newActor();
    const other = await newActor();
    const socket = await connect(actor.cookie);
    const ack = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'subscribe', projectId: actor.projectId }));
    expect(await ack).toMatchObject({ type: 'subscribed' });

    const received = nextMessage(socket);
    // An upload in someone else's project publishes first and must not reach this socket.
    await initUpload(other);
    const { media } = (await initUpload(actor)).json();
    expect(await received).toEqual({
      type: 'media.changed',
      projectId: actor.projectId,
      mediaId: media.id,
    });
    socket.terminate();
  });
});
