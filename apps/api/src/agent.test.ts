import { MediaQueues, Storage, connectMongo, originalKey, type Database } from '@agent-edit/infra';
import { QUEUES, newId, secondsToTicks, snapToFrame } from '@agent-edit/shared';
import { createMediaClip } from '@agent-edit/timeline-engine';
import type { AgentPlan, AgentRun, PlanStep, Timeline } from '@agent-edit/validation';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createRedis } from './infra/redis.js';

const DB_NAME = `agent_edit_test_agent_${Date.now()}`;
const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  MONGO_URL: process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017',
  MONGO_DB: DB_NAME,
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:8333',
  S3_PUBLIC_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:8333',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'agent-edit-test-agent',
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
let agentQueue: Queue;

interface Actor {
  cookie: string;
  userId: string;
  projectId: string;
  mediaId: string;
  timeline: Timeline;
}

const call = (
  actor: Pick<Actor, 'cookie' | 'projectId'>,
  method: 'GET' | 'POST',
  path: string,
  payload?: object,
) =>
  app.inject({
    method,
    url: `/api/v1/projects/${actor.projectId}${path}`,
    headers: { cookie: actor.cookie },
    ...(payload ? { payload } : {}),
  });

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
  const cookie = `ae_session=${register.cookies.find((c) => c.name === 'ae_session')?.value}`;
  const userId = register.json().user.id;
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
    ownerId: userId,
    name: 'talk.mp4',
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
      duration: s(120),
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
  const provider = { id: 'test', model: null, isMock: true };
  await database.moments.insertMany([
    {
      _id: newId('mom'),
      mediaId,
      projectId,
      kind: 'silence',
      start: s(10),
      end: s(15),
      score: 1,
      title: null,
      reason: null,
      provider,
    },
    {
      _id: newId('mom'),
      mediaId,
      projectId,
      kind: 'silence',
      start: s(40),
      end: s(44),
      score: 1,
      title: null,
      reason: null,
      provider,
    },
  ]);
  await database.segments.insertOne({
    _id: newId('seg'),
    mediaId,
    projectId,
    start: s(50),
    end: s(75),
    text: 'A self contained moment about software that would work well on its own as a short video.',
    speaker: null,
    words: [
      { w: 'A', s: 50, e: 51 },
      { w: 'moment.', s: 51, e: 75 },
    ],
    provider,
  });
  await database.moments.insertOne({
    _id: newId('mom'),
    mediaId,
    projectId,
    kind: 'highlight',
    start: s(50),
    end: s(75),
    score: 0.9,
    title: 'A strong moment',
    reason: 'Self contained',
    provider,
  });
  const main = (await call({ cookie, projectId }, 'GET', '/timelines/main')).json() as Timeline;
  const video = main.tracks.find((t) => t.type === 'VIDEO')!;
  const committed = await call(
    { cookie, projectId },
    'POST',
    `/timelines/${main.id}/transactions`,
    {
      baseRevision: main.revision,
      idempotencyKey: crypto.randomUUID(),
      ops: [
        {
          op: 'add_clip',
          trackId: video.id,
          clip: createMediaClip(
            { sourceMediaId: mediaId, start: 0, sourceIn: 0, sourceOut: s(120) },
            rate,
          ),
        },
      ],
    },
  );
  return { cookie, userId, projectId, mediaId, timeline: committed.json().timeline };
}

const blank: Omit<PlanStep, 'operation' | 'reason'> = {
  clipId: null,
  start: null,
  end: null,
  speed: null,
  volume: null,
  trackType: null,
  query: null,
  mediaId: null,
  count: null,
  seconds: null,
};

const planOf = (
  ...operations: Array<Partial<PlanStep> & { operation: PlanStep['operation'] }>
): AgentPlan => ({
  summary: 'Tighten the edit',
  steps: operations.map((operation) => ({ ...blank, reason: 'because', ...operation })),
});

/** A proposal as the worker leaves it. The worker's planning is tested on its own. */
async function propose(actor: Actor, plan: AgentPlan): Promise<AgentRun> {
  const created = await call(actor, 'POST', `/timelines/${actor.timeline.id}/agent-runs`, {
    instruction: 'Tighten this',
  });
  expect(created.statusCode).toBe(201);
  const run = created.json() as AgentRun;
  await database.agentRuns.updateOne(
    { _id: run.id },
    {
      $set: {
        status: 'proposed',
        plan,
        steps: plan.steps.map((step, index) => ({
          index,
          operation: step.operation,
          reason: step.reason,
          summary: step.operation,
          operationCount: 1,
          error: null,
        })),
        provider: { id: 'ollama', model: 'test-model', isMock: false },
      },
    },
  );
  return run;
}

const apply = (
  actor: Actor,
  run: AgentRun,
  enabledSteps: number[],
  baseRevision = actor.timeline.revision,
) =>
  call(actor, 'POST', `/timelines/${actor.timeline.id}/agent-runs/${run.id}/apply`, {
    baseRevision,
    enabledSteps,
  });

const video = (timeline: Timeline) => timeline.tracks.find((t) => t.type === 'VIDEO')!.clips;

beforeAll(async () => {
  database = await connectMongo(config.MONGO_URL, config.MONGO_DB);
  redis = createRedis(config.REDIS_URL);
  storage = new Storage(config);
  await storage.ensureBucket([config.WEB_ORIGIN]);
  queues = new MediaQueues({ connection: redis, prefix: DB_NAME });
  agentQueue = new Queue(QUEUES.agent, { connection: redis, prefix: DB_NAME });
  app = await buildApp({ config, database, redis, storage, queues });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await agentQueue.obliterate({ force: true });
  await agentQueue.close();
  await queues.close();
  await storage.deleteBucket();
  await database.db.dropDatabase();
  await database.client.close();
  const keys = await redis.keys(`${DB_NAME}:*`);
  if (keys.length > 0) await redis.del(keys);
  redis.disconnect();
});

describe('starting a run', () => {
  it('queues planning in the background and leaves the timeline alone', async () => {
    const actor = await newActor();
    const res = await call(actor, 'POST', `/timelines/${actor.timeline.id}/agent-runs`, {
      instruction: 'Remove the pauses',
    });
    expect(res.statusCode).toBe(201);
    const run = res.json() as AgentRun;
    expect(run.status).toBe('queued');
    expect(await agentQueue.getJob(run.id)).toBeDefined();
    const after = (await call(actor, 'GET', '/timelines/main')).json() as Timeline;
    expect(after.revision).toBe(actor.timeline.revision);
  });

  it('rejects an empty instruction', async () => {
    const actor = await newActor();
    const res = await call(actor, 'POST', `/timelines/${actor.timeline.id}/agent-runs`, {
      instruction: '   ',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('applying a proposal', () => {
  it('commits one attributed transaction, saving a version first', async () => {
    const actor = await newActor();
    const run = await propose(actor, planOf({ operation: 'remove_silence' }));
    const res = await apply(actor, run, [0]);
    expect(res.statusCode).toBe(200);
    const { timeline, run: applied } = res.json();
    expect(applied.status).toBe('applied');
    expect(video(timeline).length).toBe(3);

    const history = (await call(actor, 'GET', `/timelines/${timeline.id}/history`)).json().items;
    expect(history[0]).toMatchObject({
      source: 'ai',
      summary: 'Tighten the edit',
      author: { agentRunId: run.id, model: 'test-model', userId: actor.userId },
    });
    const versions = (await call(actor, 'GET', `/timelines/${timeline.id}/versions`)).json().items;
    expect(versions[0].trigger).toBe('pre_ai');
  });

  it('undoes as a single step, back to the exact earlier state', async () => {
    const actor = await newActor();
    const run = await propose(actor, planOf({ operation: 'remove_silence' }));
    const { timeline } = (await apply(actor, run, [0])).json();
    const undone = await call(actor, 'POST', `/timelines/${timeline.id}/undo`, {
      baseRevision: timeline.revision,
    });
    expect(undone.json().timeline.tracks).toEqual(actor.timeline.tracks);
  });

  it('applies only the steps the user kept', async () => {
    const actor = await newActor();
    const run = await propose(
      actor,
      planOf({ operation: 'remove_silence' }, { operation: 'normalize_dialogue' }),
    );
    const { timeline, run: applied } = (await apply(actor, run, [1])).json();
    expect(video(timeline)).toHaveLength(1);
    expect(video(timeline)[0]!.audio.normalize).toBe(true);
    expect(applied.steps[0].summary).toBe('Left out');
  });

  it('cannot be applied twice', async () => {
    const actor = await newActor();
    const run = await propose(actor, planOf({ operation: 'remove_silence' }));
    const { timeline } = (await apply(actor, run, [0])).json();
    const again = await apply(actor, run, [0], timeline.revision);
    expect(again.statusCode).toBe(409);
    const current = (await call(actor, 'GET', '/timelines/main')).json();
    expect(current.revision).toBe(timeline.revision);
  });

  it('refuses a stale revision rather than overwriting newer edits', async () => {
    const actor = await newActor();
    const run = await propose(actor, planOf({ operation: 'remove_silence' }));
    const clip = video(actor.timeline)[0]!;
    const moved = await call(actor, 'POST', `/timelines/${actor.timeline.id}/transactions`, {
      baseRevision: actor.timeline.revision,
      idempotencyKey: crypto.randomUUID(),
      ops: [{ op: 'change_volume', clipId: clip.id, volume: 0.5 }],
    });
    const stale = await apply(actor, run, [0]);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('revision_conflict');
    const current = (await call(actor, 'GET', '/timelines/main')).json();
    expect(current.tracks).toEqual(moved.json().timeline.tracks);
  });

  it('recompiles against newer edits, keeping them', async () => {
    const actor = await newActor();
    const run = await propose(actor, planOf({ operation: 'remove_silence' }));
    const clip = video(actor.timeline)[0]!;
    const moved = await call(actor, 'POST', `/timelines/${actor.timeline.id}/transactions`, {
      baseRevision: actor.timeline.revision,
      idempotencyKey: crypto.randomUUID(),
      ops: [{ op: 'change_volume', clipId: clip.id, volume: 0.5 }],
    });
    const res = await apply(actor, run, [0], moved.json().timeline.revision);
    expect(res.statusCode).toBe(200);
    for (const item of video(res.json().timeline)) expect(item.volume).toBe(0.5);
  });

  it('marks a plan stale when a step it needs no longer applies, changing nothing', async () => {
    const actor = await newActor();
    const clip = video(actor.timeline)[0]!;
    const run = await propose(actor, planOf({ operation: 'remove_clip', clipId: clip.id }));
    const removed = await call(actor, 'POST', `/timelines/${actor.timeline.id}/transactions`, {
      baseRevision: actor.timeline.revision,
      idempotencyKey: crypto.randomUUID(),
      ops: [{ op: 'remove_clip', clipId: clip.id }],
    });
    const revision = removed.json().timeline.revision;
    const res = await apply(actor, run, [0], revision);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('no longer apply');
    const stored = (
      await call(actor, 'GET', `/timelines/${actor.timeline.id}/agent-runs/${run.id}`)
    ).json();
    expect(stored.status).toBe('stale');
    expect((await call(actor, 'GET', '/timelines/main')).json().revision).toBe(revision);
  });

  it('refuses when nothing selected would change anything', async () => {
    const actor = await newActor();
    const run = await propose(actor, planOf({ operation: 'remove_silence' }));
    const res = await apply(actor, run, []);
    expect(res.statusCode).toBe(409);
  });
});

describe('Shorts', () => {
  it('creates independent vertical timelines, each editable with its own history', async () => {
    const actor = await newActor();
    const run = await propose(actor, planOf({ operation: 'generate_shorts', count: 1 }));
    const res = await apply(actor, run, [0]);
    expect(res.statusCode).toBe(200);
    const { createdTimelineIds, timeline } = res.json();
    expect(createdTimelineIds).toHaveLength(1);
    // The main edit is untouched by a Shorts-only plan.
    expect(timeline.revision).toBe(actor.timeline.revision);

    const short = (
      await call(actor, 'GET', `/timelines/${createdTimelineIds[0]}`)
    ).json() as Timeline;
    expect(short).toMatchObject({ kind: 'short', width: 1080, height: 1920, revision: 1 });
    const clip = video(short)[0]!;
    if (clip.kind !== 'media') throw new Error('expected media');
    expect(clip.sourceIn).toBe(s(50));
    expect(clip.transform.scale).toBeGreaterThan(3);

    const edited = await call(actor, 'POST', `/timelines/${short.id}/transactions`, {
      baseRevision: short.revision,
      idempotencyKey: crypto.randomUUID(),
      ops: [{ op: 'change_volume', clipId: clip.id, volume: 0.4 }],
    });
    expect(edited.statusCode).toBe(200);
    const main = (await call(actor, 'GET', '/timelines/main')).json() as Timeline;
    expect(main.revision).toBe(actor.timeline.revision);

    const listed = (await call(actor, 'GET', '/timelines')).json().items;
    expect(listed.map((item: { kind: string }) => item.kind).sort()).toEqual(['main', 'short']);
    expect(
      (await call(actor, 'POST', `/timelines/${short.id}/undo`, { baseRevision: 2 })).statusCode,
    ).toBe(200);
  });
});

describe('rejecting and ownership', () => {
  it('reject changes nothing and closes the run', async () => {
    const actor = await newActor();
    const run = await propose(actor, planOf({ operation: 'remove_silence' }));
    const res = await call(
      actor,
      'POST',
      `/timelines/${actor.timeline.id}/agent-runs/${run.id}/reject`,
    );
    expect(res.json().status).toBe('rejected');
    expect((await apply(actor, run, [0])).statusCode).toBe(409);
    expect((await call(actor, 'GET', '/timelines/main')).json().revision).toBe(
      actor.timeline.revision,
    );
  });

  it('hides runs and analysis from other users', async () => {
    const owner = await newActor();
    const intruder = await newActor();
    const run = await propose(owner, planOf({ operation: 'remove_silence' }));
    const path = `/timelines/${owner.timeline.id}/agent-runs`;
    for (const actor of [{ ...intruder, projectId: owner.projectId }, intruder]) {
      const attempts = await Promise.all([
        call(actor, 'GET', path),
        call(actor, 'POST', path, { instruction: 'x' }),
        call(actor, 'GET', `${path}/${run.id}`),
        call(actor, 'POST', `${path}/${run.id}/reject`),
        call(actor, 'POST', `${path}/${run.id}/apply`, { baseRevision: 1, enabledSteps: [0] }),
        call(actor, 'GET', `/media/${owner.mediaId}/analysis`),
      ]);
      for (const res of attempts) expect(res.statusCode).toBe(404);
    }
    const stored = await database.agentRuns.findOne({ _id: run.id });
    expect(stored?.status).toBe('proposed');
  });

  it('serves analysis results with the provider that produced them', async () => {
    const actor = await newActor();
    const res = await call(actor, 'GET', `/media/${actor.mediaId}/analysis`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.segmentProvider.isMock).toBe(true);
    expect(body.moments.every((m: { provider: unknown }) => m.provider)).toBe(true);
  });
});
