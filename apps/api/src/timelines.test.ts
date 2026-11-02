import { MediaQueues, Storage, connectMongo, originalKey, type Database } from '@agent-edit/infra';
import { newId, secondsToTicks, snapToFrame } from '@agent-edit/shared';
import { createCaptionClip, createMediaClip } from '@agent-edit/timeline-engine';
import type { Timeline, TimelineOperation } from '@agent-edit/validation';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createRedis } from './infra/redis.js';

const DB_NAME = `agent_edit_test_timelines_${Date.now()}`;
const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  MONGO_URL: process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017',
  MONGO_DB: DB_NAME,
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:8333',
  S3_PUBLIC_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:8333',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'agent-edit-test-timelines',
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? 'agent-edit-dev',
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? 'agent-edit-dev-secret',
  RATE_LIMIT_GLOBAL_PER_MINUTE: '100000',
  RATE_LIMIT_AUTH_PER_MINUTE: '1000',
});

const rate = { num: 30, den: 1 };
const s = (seconds: number) => snapToFrame(secondsToTicks(seconds), rate);
const settings = { aspectRatio: '16:9', width: 1920, height: 1080, frameRate: rate };

let app: FastifyInstance;
let database: Database;
let redis: Redis;
let storage: Storage;
let queues: MediaQueues;

interface Actor {
  cookie: string;
  projectId: string;
  mediaId: string;
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
  const projectId = project.json().id;
  const mediaId = newId('med');
  const now = new Date();
  await database.media.insertOne({
    _id: mediaId,
    projectId,
    ownerId: register.json().user.id,
    name: 'clip.mp4',
    folder: null,
    status: 'ready',
    size: 1,
    contentType: 'video/mp4',
    extension: 'mp4',
    fingerprint: mediaId,
    upload: null,
    storage: {
      originalKey: originalKey(projectId, mediaId),
      proxyKey: null,
      audioKey: null,
      waveformKey: null,
      waveformPeaksPerSecond: null,
      thumbnailKeys: [],
      posterKey: null,
    },
    probe: {
      duration: s(600),
      width: 1920,
      height: 1080,
      frameRate: rate,
      isVariableFrameRate: false,
      rotation: 0,
      container: 'mov',
      videoCodec: 'h264',
      audioCodec: 'aac',
      audioChannels: 2,
      sampleRate: 48000,
      bitrate: 1,
    },
    error: null,
    generation: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  return { cookie, projectId, mediaId };
}

function call(actor: Actor, method: 'GET' | 'POST' | 'DELETE', path: string, payload?: object) {
  return app.inject({
    method,
    url: `/api/v1/projects/${actor.projectId}${path}`,
    headers: { cookie: actor.cookie },
    ...(payload ? { payload } : {}),
  });
}

const main = async (actor: Actor): Promise<Timeline> =>
  (await call(actor, 'GET', '/timelines/main')).json();

const key = () => crypto.randomUUID();

const trackOf = (timeline: Timeline, type: string) =>
  timeline.tracks.find((track) => track.type === type)!;

function addOp(timeline: Timeline, actor: Actor, start = 0, seconds = 10): TimelineOperation {
  return {
    op: 'add_clip',
    trackId: trackOf(timeline, 'VIDEO').id,
    clip: createMediaClip(
      { sourceMediaId: actor.mediaId, start: s(start), sourceIn: 0, sourceOut: s(seconds) },
      rate,
    ),
  };
}

async function edit(actor: Actor, timeline: Timeline, ops: TimelineOperation[], over: object = {}) {
  return call(actor, 'POST', `/timelines/${timeline.id}/transactions`, {
    baseRevision: timeline.revision,
    idempotencyKey: key(),
    ops,
    ...over,
  });
}

async function seeded(actor: Actor) {
  const timeline = await main(actor);
  const res = await edit(actor, timeline, [addOp(timeline, actor)]);
  expect(res.statusCode).toBe(200);
  return res.json().timeline as Timeline;
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

describe('main timeline', () => {
  it('is created once with all six track types, even when requests race', async () => {
    const actor = await newActor();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call(actor, 'GET', '/timelines/main')),
    );
    const ids = new Set(results.map((res) => res.json().id));
    expect(ids.size).toBe(1);
    const timeline = results[0]!.json() as Timeline;
    expect(timeline.tracks.map((t) => t.type).sort()).toEqual(
      ['AUDIO', 'BROLL', 'CAPTIONS', 'MUSIC', 'OVERLAYS', 'VIDEO'].sort(),
    );
    expect(timeline.frameRate).toEqual(rate);
    expect(await database.timelines.countDocuments({ projectId: actor.projectId })).toBe(1);
  });

  it('cannot be deleted', async () => {
    const actor = await newActor();
    const timeline = await main(actor);
    expect((await call(actor, 'DELETE', `/timelines/${timeline.id}`)).statusCode).toBe(409);
  });
});

describe('transactions', () => {
  it('persists an edit and bumps the revision', async () => {
    const actor = await newActor();
    const timeline = await seeded(actor);
    expect(timeline.revision).toBe(1);
    const stored = await database.timelines.findOne({ _id: timeline.id });
    expect(stored?.tracks.find((t) => t.type === 'VIDEO')?.clips).toHaveLength(1);
  });

  it('refuses a stale revision instead of overwriting newer work', async () => {
    const actor = await newActor();
    const before = await main(actor);
    await edit(actor, before, [addOp(before, actor)]);
    const stale = await edit(actor, before, [addOp(before, actor, 20)]);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('revision_conflict');
    expect(stale.json().error.details.revision).toBe(1);
    expect(trackOf(await main(actor), 'VIDEO').clips).toHaveLength(1);
  });

  it('lets exactly one of many simultaneous edits win', async () => {
    const actor = await newActor();
    const timeline = await main(actor);
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_v, i) => edit(actor, timeline, [addOp(timeline, actor, i * 20)])),
    );
    expect(attempts.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(attempts.filter((r) => r.statusCode === 409)).toHaveLength(7);
    const after = await main(actor);
    expect(after.revision).toBe(1);
    expect(trackOf(after, 'VIDEO').clips).toHaveLength(1);
    expect(await database.transactions.countDocuments({ timelineId: timeline.id })).toBe(1);
  });

  it('is safe to retry: a repeated key changes nothing and returns the same result', async () => {
    const actor = await newActor();
    const timeline = await main(actor);
    const idempotencyKey = key();
    const ops = [addOp(timeline, actor)];
    const body = { baseRevision: 0, idempotencyKey, ops };
    const first = await call(actor, 'POST', `/timelines/${timeline.id}/transactions`, body);
    const second = await call(actor, 'POST', `/timelines/${timeline.id}/transactions`, body);
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(true);
    expect(second.json().transactionId).toBe(first.json().transactionId);
    expect(trackOf(await main(actor), 'VIDEO').clips).toHaveLength(1);
  });

  it('commits nothing at all when any operation in the batch is invalid', async () => {
    const actor = await newActor();
    const timeline = await main(actor);
    const res = await edit(actor, timeline, [
      addOp(timeline, actor),
      { op: 'remove_clip', clipId: newId('clip') },
    ]);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({
      code: 'invalid_edit',
      details: { reason: 'clip_not_found', opIndex: 1 },
    });
    const after = await main(actor);
    expect(after.revision).toBe(0);
    expect(trackOf(after, 'VIDEO').clips).toEqual([]);
    expect(await database.transactions.countDocuments({ timelineId: timeline.id })).toBe(0);
  });

  it.each([
    [
      'media from another project',
      (t: Timeline) => ({
        op: 'add_clip',
        trackId: trackOf(t, 'VIDEO').id,
        clip: createMediaClip(
          { sourceMediaId: newId('med'), start: 0, sourceIn: 0, sourceOut: s(5) },
          rate,
        ),
      }),
    ],
    [
      'a clip past the end of its source',
      (t: Timeline, a: Actor) => ({
        op: 'add_clip',
        trackId: trackOf(t, 'VIDEO').id,
        clip: createMediaClip(
          { sourceMediaId: a.mediaId, start: 0, sourceIn: s(590), sourceOut: s(700) },
          rate,
        ),
      }),
    ],
  ])('rejects %s', async (_label, build) => {
    const actor = await newActor();
    const timeline = await main(actor);
    const res = await edit(actor, timeline, [build(timeline, actor) as TimelineOperation]);
    expect(res.statusCode).toBe(422);
  });

  it('rejects malformed operations at the schema, before touching state', async () => {
    const actor = await newActor();
    const timeline = await seeded(actor);
    const res = await call(actor, 'POST', `/timelines/${timeline.id}/transactions`, {
      baseRevision: timeline.revision,
      idempotencyKey: key(),
      ops: [{ op: 'drop_database' }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('repairs a crash between the log write and the document update', async () => {
    const actor = await newActor();
    const timeline = await seeded(actor);
    const clipId = trackOf(timeline, 'VIDEO').clips[0]!.id;
    await database.transactions.insertOne({
      _id: newId('txn'),
      timelineId: timeline.id,
      projectId: actor.projectId,
      revision: timeline.revision + 1,
      idempotencyKey: key(),
      source: 'manual',
      summary: 'crashed',
      author: { userId: 'u', agentRunId: null, model: null },
      ops: [{ op: 'move_clip', clipId, start: s(30) }],
      inverseOps: [{ op: 'move_clip', clipId, start: 0 }],
      createdAt: new Date(),
    });
    const repaired = await main(actor);
    expect(repaired.revision).toBe(timeline.revision + 1);
    expect(trackOf(repaired, 'VIDEO').clips[0]!.start).toBe(s(30));
    expect(repaired.canUndo).toBe(true);
    const stored = await database.timelines.findOne({ _id: timeline.id });
    expect(stored?.revision).toBe(timeline.revision + 1);
  });
});

describe('undo and redo', () => {
  async function step(actor: Actor, timeline: Timeline, direction: 'undo' | 'redo') {
    const res = await call(actor, 'POST', `/timelines/${timeline.id}/${direction}`, {
      baseRevision: timeline.revision,
    });
    expect(res.statusCode).toBe(200);
    return res.json().timeline as Timeline;
  }

  it('walks back and forward through many edits exactly', async () => {
    const actor = await newActor();
    const states: Timeline[] = [await main(actor)];
    for (let i = 0; i < 6; i++) {
      const current = states.at(-1)!;
      const ops =
        i === 0
          ? [addOp(current, actor, 0, 30)]
          : i === 2
            ? [
                {
                  op: 'split_clip' as const,
                  clipId: trackOf(current, 'VIDEO').clips[0]!.id,
                  at: s(5),
                  newClipId: newId('clip'),
                },
              ]
            : [
                {
                  op: 'change_volume' as const,
                  clipId: trackOf(current, 'VIDEO').clips[0]!.id,
                  volume: i / 4,
                },
              ];
      states.push((await edit(actor, current, ops)).json().timeline);
    }
    let current = states.at(-1)!;
    for (let i = states.length - 2; i >= 0; i--) {
      current = await step(actor, current, 'undo');
      expect(current.tracks).toEqual(states[i]!.tracks);
    }
    expect(current.canUndo).toBe(false);
    expect(current.canRedo).toBe(true);
    for (let i = 1; i < states.length; i++) {
      current = await step(actor, current, 'redo');
      expect(current.tracks).toEqual(states[i]!.tracks);
    }
    expect(current.canRedo).toBe(false);
    expect(current.canUndo).toBe(true);
  });

  it('keeps an append-only log: undo adds a transaction and rewrites nothing', async () => {
    const actor = await newActor();
    const timeline = await seeded(actor);
    const undone = await step(actor, timeline, 'undo');
    expect(undone.revision).toBe(2);
    const history = (await call(actor, 'GET', `/timelines/${timeline.id}/history`)).json().items;
    expect(history.map((h: { source: string }) => h.source)).toEqual(['undo', 'manual']);
    expect(history[0].summary).toMatch(/^Undo: /);
  });

  it('a new edit clears redo, as every editor does', async () => {
    const actor = await newActor();
    const timeline = await seeded(actor);
    const undone = await step(actor, timeline, 'undo');
    expect(undone.canRedo).toBe(true);
    const edited = (await edit(actor, undone, [addOp(undone, actor, 40)])).json().timeline;
    expect(edited.canRedo).toBe(false);
    const res = await call(actor, 'POST', `/timelines/${timeline.id}/redo`, {
      baseRevision: edited.revision,
    });
    expect(res.statusCode).toBe(409);
  });

  it('a retried undo does not step twice', async () => {
    const actor = await newActor();
    const first = await seeded(actor);
    const second = (await edit(actor, first, [addOp(first, actor, 40)])).json().timeline;
    const path = `/timelines/${first.id}/undo`;
    const body = { baseRevision: second.revision };
    const once = await call(actor, 'POST', path, body);
    const twice = await call(actor, 'POST', path, body);
    expect(once.json().transactionId).toBe(twice.json().transactionId);
    expect(trackOf(await main(actor), 'VIDEO').clips).toHaveLength(1);
  });

  it('refuses when there is nothing to undo', async () => {
    const actor = await newActor();
    const timeline = await main(actor);
    const res = await call(actor, 'POST', `/timelines/${timeline.id}/undo`, { baseRevision: 0 });
    expect(res.statusCode).toBe(409);
  });
});

describe('versions', () => {
  it('saves a snapshot and restores it as an undoable transaction', async () => {
    const actor = await newActor();
    const first = await seeded(actor);
    const saved = await call(actor, 'POST', `/timelines/${first.id}/versions`, {
      name: 'Rough cut',
    });
    expect(saved.statusCode).toBe(201);

    let current: Timeline = (await edit(actor, first, [addOp(first, actor, 40)])).json().timeline;
    const captions = trackOf(current, 'CAPTIONS').id;
    current = (
      await edit(actor, current, [
        { op: 'update_track', trackId: trackOf(current, 'VIDEO').id, locked: true },
        {
          op: 'add_caption',
          trackId: captions,
          clip: createCaptionClip({ start: 0, duration: s(2), text: 'Hello' }, rate),
        },
      ])
    ).json().timeline;
    const beforeRestore = current.tracks;

    const restored = await call(
      actor,
      'POST',
      `/timelines/${first.id}/versions/${saved.json().id}/restore`,
      { baseRevision: current.revision },
    );
    expect(restored.statusCode).toBe(200);
    const after: Timeline = restored.json().timeline;
    expect(after.tracks).toEqual(first.tracks);

    const versions = (await call(actor, 'GET', `/timelines/${first.id}/versions`)).json().items;
    expect(versions.map((v: { trigger: string }) => v.trigger)).toEqual(['pre_restore', 'manual']);

    const undone = await call(actor, 'POST', `/timelines/${first.id}/undo`, {
      baseRevision: after.revision,
    });
    expect(undone.json().timeline.tracks).toEqual(beforeRestore);
  });
});

describe('attribution and ownership', () => {
  it('records who made each edit', async () => {
    const actor = await newActor();
    const timeline = await seeded(actor);
    const [entry] = (await call(actor, 'GET', `/timelines/${timeline.id}/history`)).json().items;
    expect(entry).toMatchObject({
      source: 'manual',
      operationCount: 1,
      author: { agentRunId: null, model: null },
    });
    expect(entry.author.userId).toMatch(/^usr_/);
  });

  it('hides timelines from other users on every route', async () => {
    const owner = await newActor();
    const intruder = await newActor();
    const timeline = await seeded(owner);
    const ops = { baseRevision: 1, idempotencyKey: key(), ops: [] };
    for (const actor of [{ ...intruder, projectId: owner.projectId }, intruder]) {
      const attempts = await Promise.all([
        call(actor, 'GET', `/timelines/${timeline.id}`),
        call(actor, 'POST', `/timelines/${timeline.id}/undo`, { baseRevision: 1 }),
        call(actor, 'POST', `/timelines/${timeline.id}/redo`, { baseRevision: 1 }),
        call(actor, 'GET', `/timelines/${timeline.id}/history`),
        call(actor, 'GET', `/timelines/${timeline.id}/versions`),
        call(actor, 'POST', `/timelines/${timeline.id}/versions`, { name: 'x' }),
        call(actor, 'DELETE', `/timelines/${timeline.id}`),
      ]);
      for (const res of attempts) expect(res.statusCode).toBe(404);
    }
    const stranger = await call(
      { ...intruder, projectId: owner.projectId },
      'POST',
      `/timelines/${timeline.id}/transactions`,
      { ...ops, ops: [{ op: 'remove_clip', clipId: trackOf(timeline, 'VIDEO').clips[0]!.id }] },
    );
    expect(stranger.statusCode).toBe(404);
    expect(trackOf(await main(owner), 'VIDEO').clips).toHaveLength(1);
  });

  it('refuses to delete footage that a timeline uses', async () => {
    const actor = await newActor();
    const timeline = await seeded(actor);
    const res = await call(actor, 'DELETE', `/media/${actor.mediaId}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('in_use');
    await edit(actor, timeline, [
      { op: 'remove_clip', clipId: trackOf(timeline, 'VIDEO').clips[0]!.id },
    ]);
    expect((await call(actor, 'DELETE', `/media/${actor.mediaId}`)).statusCode).toBe(204);
  });
});

describe('scale', () => {
  it('commits a large plan on a long timeline', async () => {
    const actor = await newActor();
    const timeline = await main(actor);
    const ops = Array.from({ length: 3000 }, (_v, i) => {
      const clip = createMediaClip(
        { sourceMediaId: actor.mediaId, start: s(i * 0.2), sourceIn: 0, sourceOut: s(0.2) },
        rate,
      );
      return { op: 'add_clip', trackId: trackOf(timeline, 'VIDEO').id, clip } as TimelineOperation;
    });
    const started = performance.now();
    const res = await edit(actor, timeline, ops);
    expect(res.statusCode).toBe(200);
    expect(trackOf(res.json().timeline, 'VIDEO').clips).toHaveLength(3000);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
