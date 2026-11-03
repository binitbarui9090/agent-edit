import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MediaQueues,
  Storage,
  connectMongo,
  originalKey,
  type Database,
  type MediaDoc,
  type RenderJobDoc,
} from '@agent-edit/infra';
import { ProcessTracker, probeFile } from '@agent-edit/media-engine';
import { QUEUES, newId, secondsToTicks, snapToFrame } from '@agent-edit/shared';
import {
  applyOperations,
  createCaptionClip,
  createDefaultTracks,
  createMediaClip,
  timelineDuration,
} from '@agent-edit/timeline-engine';
import type { TimelineState } from '@agent-edit/validation';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PipelineContext } from '../media/pipeline.js';
import { SourceCache } from '../media/source-cache.js';
import { startMediaWorkers } from '../media/workers.js';

const FULL = '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
const FFMPEG = process.env.FFMPEG_PATH ?? (existsSync(FULL) ? FULL : 'ffmpeg');
const FFPROBE = process.env.FFPROBE_PATH ?? FFMPEG.replace(/ffmpeg$/, 'ffprobe');
const stamp = Date.now();
const prefix = `test_render_${stamp}`;
const rate = { num: 30, den: 1 };
const s = (seconds: number) => snapToFrame(secondsToTicks(seconds), rate);
const projectId = newId('prj');
const ownerId = newId('usr');

let dir: string;
let database: Database;
let storage: Storage;
let queues: MediaQueues;
let redis: Redis;
let ctx: PipelineContext;
let workers: Awaited<ReturnType<typeof startMediaWorkers>>;
let mediaId: string;

async function makeMedia(seconds = 6): Promise<string> {
  const path = join(dir, `${newId('med')}.mp4`);
  execFileSync(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=640x360:rate=30:duration=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=400:duration=${seconds}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    '-shortest',
    path,
  ]);
  const id = newId('med');
  const key = originalKey(projectId, id);
  const size = await storage.uploadFile(key, path, 'video/mp4');
  const probe = await probeFile(FFPROBE, path);
  const now = new Date();
  const doc: MediaDoc = {
    _id: id,
    projectId,
    ownerId,
    name: 'clip.mp4',
    folder: null,
    status: 'ready',
    size,
    contentType: 'video/mp4',
    extension: 'mp4',
    fingerprint: id,
    upload: null,
    storage: {
      originalKey: key,
      proxyKey: null,
      audioKey: null,
      waveformKey: null,
      waveformPeaksPerSecond: null,
      thumbnailKeys: [],
      posterKey: null,
    },
    probe,
    error: null,
    generation: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  await database.media.insertOne(doc);
  return id;
}

function timeline(source: string, seconds = 3): TimelineState {
  const state: TimelineState = {
    frameRate: rate,
    width: 640,
    height: 360,
    tracks: createDefaultTracks(),
  };
  return applyOperations(state, [
    {
      op: 'add_clip',
      trackId: state.tracks.find((t) => t.type === 'VIDEO')!.id,
      clip: createMediaClip(
        { sourceMediaId: source, start: 0, sourceIn: 0, sourceOut: s(seconds) },
        rate,
      ),
    },
    {
      op: 'add_caption',
      trackId: state.tracks.find((t) => t.type === 'CAPTIONS')!.id,
      clip: createCaptionClip({ start: s(1), duration: s(1), text: 'Hello' }, rate),
    },
  ]).state;
}

async function start(state: TimelineState, over: Partial<RenderJobDoc> = {}): Promise<string> {
  const id = newId('rnd');
  const now = new Date();
  await database.renders.insertOne({
    _id: id,
    projectId,
    ownerId,
    timelineId: newId('tln'),
    timelineName: 'Main edit',
    revision: 1,
    snapshot: state,
    preset: 'source',
    burnCaptions: true,
    width: state.width,
    height: state.height,
    status: 'queued',
    progress: 0,
    attempts: 0,
    error: null,
    outputKey: null,
    outputSize: null,
    captionsKey: null,
    logKey: null,
    durationTicks: timelineDuration(state),
    generation: 0,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    ...over,
  });
  await queues.enqueueRender(id, 0);
  return id;
}

async function settled(id: string) {
  await expect
    .poll(
      async () => {
        const status = (await database.renders.findOne({ _id: id }))?.status;
        return status === 'done' || status === 'failed' || status === 'cancelled';
      },
      { timeout: 90_000, interval: 200 },
    )
    .toBe(true);
  return (await database.renders.findOne({ _id: id }))!;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ae-render-job-'));
  database = await connectMongo(
    process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017',
    `agent_edit_test_render_${stamp}`,
  );
  storage = new Storage({
    S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:8333',
    S3_PUBLIC_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:8333',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'agent-edit-test-render',
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? 'agent-edit-dev',
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? 'agent-edit-dev-secret',
  });
  await storage.ensureBucket(['http://localhost:5173']);
  redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6380', {
    maxRetriesPerRequest: null,
  });
  queues = new MediaQueues({ connection: redis, prefix });
  const workDir = join(dir, 'work');
  ctx = {
    database,
    storage,
    queues,
    redis,
    cache: new SourceCache(storage, workDir),
    binaries: { ffmpeg: FFMPEG, ffprobe: FFPROBE },
    tracker: new ProcessTracker(join(workDir, 'processes')),
    ai: { speech: null, language: null, vision: null },
    log: pino({ level: 'silent' }),
    signal: new AbortController().signal,
  };
  workers = await startMediaWorkers(ctx, {
    connection: redis,
    prefix,
    mediaConcurrency: 1,
    proxyConcurrency: 1,
    analysisConcurrency: 1,
    renderConcurrency: 2,
    workDir,
  });
  mediaId = await makeMedia();
}, 60_000);

afterAll(async () => {
  await workers.close();
  await queues.close();
  for (const queue of [
    QUEUES.media,
    QUEUES.proxy,
    QUEUES.analysis,
    QUEUES.agent,
    QUEUES.render,
    QUEUES.maintenance,
  ]) {
    const handle = new Queue(queue, { connection: redis, prefix });
    await handle.obliterate({ force: true });
    await handle.close();
  }
  await storage.deleteBucket();
  await database.db.dropDatabase();
  await database.client.close();
  const keys = await redis.keys(`${prefix}:*`);
  if (keys.length > 0) await redis.del(keys);
  redis.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe('render jobs', () => {
  it('renders in the background and stores a verified, downloadable file', async () => {
    const done = await settled(await start(timeline(mediaId)));
    expect(done.error).toBeNull();
    expect(done).toMatchObject({ status: 'done', progress: 1 });
    expect(done.outputSize).toBeGreaterThan(0);
    expect(await storage.objectSize(done.outputKey!)).toBe(done.outputSize);

    const fetched = join(dir, 'fetched.mp4');
    await storage.downloadToFile(done.outputKey!, fetched);
    const probe = await probeFile(FFPROBE, fetched);
    expect(probe).toMatchObject({ width: 640, height: 360, videoCodec: 'h264', audioCodec: 'aac' });

    const url = await storage.signDownload(done.outputKey!, 'Main edit 640x360.mp4');
    const response = await fetch(url, { method: 'GET', headers: { range: 'bytes=0-9' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-disposition')).toContain(
      'attachment; filename="Main edit 640x360.mp4"',
    );
    expect(done.captionsKey).toBeTruthy();
    expect(done.logKey).toBeTruthy();
  });

  it('keeps the file name safe in the download header', async () => {
    const url = await storage.signDownload('x', 'bad"name\r\n; evil.mp4');
    expect(decodeURIComponent(url)).toContain('filename="bad_name_ evil.mp4"');
  });

  it('never modifies the source footage', async () => {
    const media = await database.media.findOne({ _id: mediaId });
    await settled(await start(timeline(mediaId, 1)));
    expect(await storage.objectSize(media!.storage.originalKey)).toBe(media!.size);
  });

  it('renders the snapshot, so edits after pressing export change nothing', async () => {
    const state = timeline(mediaId, 2);
    const id = await start(state);
    await database.timelines.deleteMany({});
    const done = await settled(id);
    const fetched = join(dir, 'snapshot.mp4');
    await storage.downloadToFile(done.outputKey!, fetched);
    expect((await probeFile(FFPROBE, fetched)).duration).toBeGreaterThan(s(1.9));
  });

  it('fails clearly when footage is gone, without pointless retries', async () => {
    const done = await settled(await start(timeline(newId('med'))));
    expect(done).toMatchObject({ status: 'failed', attempts: 1 });
    expect(done.error).toContain('no longer available');
  });

  it('cancels promptly, stopping FFmpeg and cleaning up', async () => {
    const long = await makeMedia(40);
    const id = await start(timeline(long, 40));
    await expect
      .poll(async () => (await database.renders.findOne({ _id: id }))?.status, { timeout: 30_000 })
      .toBe('running');
    await database.renders.updateOne(
      { _id: id },
      { $set: { status: 'cancelled', finishedAt: new Date() } },
    );
    await expect
      .poll(() => existsSync(join(dir, 'work', `render-${id}`)), { timeout: 15_000 })
      .toBe(false);
    const after = await database.renders.findOne({ _id: id });
    expect(after).toMatchObject({ status: 'cancelled', outputKey: null });
  });

  it('renders several jobs at once', async () => {
    const ids = await Promise.all([
      start(timeline(mediaId, 1)),
      start(timeline(mediaId, 1)),
      start(timeline(mediaId, 1)),
    ]);
    const results = await Promise.all(ids.map(settled));
    for (const result of results) expect(result.status).toBe('done');
  });

  it('leaves its scratch space clean', async () => {
    const id = await start(timeline(mediaId, 1));
    await settled(id);
    expect(readdirSync(join(dir, 'work')).filter((name) => name === `render-${id}`)).toEqual([]);
  });
});
