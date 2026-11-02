import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MediaQueues,
  Storage,
  connectMongo,
  newJobDoc,
  originalKey,
  type Database,
  type MediaDoc,
} from '@agent-edit/infra';
import { ProcessTracker, probeFile } from '@agent-edit/media-engine';
import {
  PROCESSING_STEPS,
  QUEUES,
  WAVEFORM_PEAKS_PER_SECOND,
  newId,
  projectEventChannel,
  ticksToSeconds,
} from '@agent-edit/shared';
import type { ServerEvent } from '@agent-edit/validation';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PipelineContext } from './pipeline.js';
import { SourceCache } from './source-cache.js';
import { sweep } from './sweep.js';
import { startMediaWorkers } from './workers.js';

const stamp = Date.now();
const prefix = `test_pipeline_${stamp}`;
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const storageEnv = {
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:8333',
  S3_PUBLIC_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:8333',
  S3_REGION: 'us-east-1',
  // A fixed name, so a crashed run cannot leak buckets: storage reserves volumes for each one.
  S3_BUCKET: 'agent-edit-test-pipeline',
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? 'agent-edit-dev',
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? 'agent-edit-dev-secret',
};

let dir: string;
let workDir: string;
let database: Database;
let storage: Storage;
let queues: MediaQueues;
let redis: Redis;
let subscriber: Redis;
let ctx: PipelineContext;
let workers: Awaited<ReturnType<typeof startMediaWorkers>>;
const events: ServerEvent[] = [];
const projectId = newId('prj');

const VIDEO = ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=4'];
const TONE = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=4'];

function makeVideo(name: string, args: string[]): string {
  const path = join(dir, name);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, path]);
  return path;
}

async function seed(path: string, name = 'clip.mp4', size?: number): Promise<MediaDoc> {
  const mediaId = newId('med');
  const key = originalKey(projectId, mediaId);
  const actualSize = await storage.uploadFile(key, path, 'video/mp4');
  const now = new Date();
  const doc: MediaDoc = {
    _id: mediaId,
    projectId,
    ownerId: newId('usr'),
    name,
    folder: null,
    status: 'processing',
    size: size ?? actualSize,
    contentType: 'video/mp4',
    extension: 'mp4',
    fingerprint: mediaId,
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
    probe: null,
    error: null,
    generation: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  await database.media.insertOne(doc);
  await database.analysisJobs.insertMany(
    PROCESSING_STEPS.map((step) => newJobDoc(projectId, mediaId, step, now)),
  );
  await queues.enqueue('probe', { mediaId, projectId }, 0);
  return doc;
}

async function settled(mediaId: string): Promise<MediaDoc> {
  await expect
    .poll(async () => (await database.media.findOne({ _id: mediaId }))?.status, {
      timeout: 60_000,
      interval: 100,
    })
    .not.toBe('processing');
  return (await database.media.findOne({ _id: mediaId }))!;
}

const jobsOf = (mediaId: string) => database.analysisJobs.find({ mediaId }).toArray();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ae-pipeline-'));
  workDir = join(dir, 'work');
  database = await connectMongo(
    process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017',
    `agent_edit_test_pipeline_${stamp}`,
  );
  storage = new Storage(storageEnv);
  await storage.ensureBucket(['http://localhost:5173']);
  redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  subscriber = new Redis(redisUrl);
  await subscriber.subscribe(projectEventChannel(projectId));
  subscriber.on('message', (_channel, message) => events.push(JSON.parse(message)));
  queues = new MediaQueues({ connection: redis, prefix });
  ctx = {
    database,
    storage,
    queues,
    redis,
    cache: new SourceCache(storage, workDir),
    binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
    tracker: new ProcessTracker(join(workDir, 'processes')),
    log: pino({ level: 'silent' }),
    signal: new AbortController().signal,
  };
  workers = await startMediaWorkers(ctx, {
    connection: redis,
    prefix,
    mediaConcurrency: 3,
    proxyConcurrency: 1,
    workDir,
  });
});

afterAll(async () => {
  await workers.close();
  await queues.close();
  for (const queue of [QUEUES.media, QUEUES.proxy, QUEUES.maintenance]) {
    const handle = new Queue(queue, { connection: redis, prefix });
    await handle.obliterate({ force: true });
    await handle.close();
  }
  await database.db.dropDatabase();
  await database.client.close();
  await storage.deleteBucket();
  subscriber.disconnect();
  const keys = await redis.keys(`${prefix}:*`);
  if (keys.length > 0) await redis.del(keys);
  redis.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe('media pipeline', () => {
  it('turns an upload into every derived asset through real queues and storage', async () => {
    const source = makeVideo('full.mp4', [...VIDEO, ...TONE, '-c:v', 'libx264', '-c:a', 'aac']);
    const originalSize = statSync(source).size;
    const doc = await seed(source);
    const done = await settled(doc._id);

    expect(done.error).toBeNull();
    expect(done.status).toBe('ready');
    for (const job of await jobsOf(doc._id)) {
      expect(job).toMatchObject({ status: 'done', progress: 1, error: null, attempts: 1 });
      expect(job.provider).toEqual({ id: 'ffmpeg', isMock: false });
    }

    expect(done.probe).toMatchObject({ width: 1280, height: 720, audioCodec: 'aac' });
    expect(ticksToSeconds(done.probe!.duration)).toBeCloseTo(4, 0);

    const { storage: keys } = done;
    expect(keys.thumbnailKeys).toHaveLength(10);
    expect(keys.posterKey).toBe(keys.thumbnailKeys[1]);
    expect(keys.waveformPeaksPerSecond).toBe(WAVEFORM_PEAKS_PER_SECOND);
    for (const key of [keys.proxyKey!, keys.audioKey!, keys.waveformKey!, keys.posterKey!]) {
      expect(await storage.objectSize(key)).toBeGreaterThan(0);
    }

    // The proxy that came back from storage really is playable media.
    const proxy = join(dir, 'fetched-proxy.mp4');
    await storage.downloadToFile(keys.proxyKey!, proxy);
    expect(await probeFile('ffprobe', proxy)).toMatchObject({ height: 720, videoCodec: 'h264' });

    // The source is never modified, and the local copy is cleaned up.
    expect(await storage.objectSize(keys.originalKey)).toBe(originalSize);
    expect(existsSync(join(workDir, doc._id))).toBe(false);

    const changed = events.filter((e) => e.type === 'media.changed' && e.mediaId === doc._id);
    expect(changed.length).toBeGreaterThanOrEqual(5);
  });

  it('skips audio steps for silent footage and is still ready', async () => {
    const doc = await seed(makeVideo('silent.mp4', [...VIDEO, '-c:v', 'libx264']));
    const done = await settled(doc._id);
    expect(done.status).toBe('ready');
    const jobs = await jobsOf(doc._id);
    const status = (step: string) => jobs.find((j) => j.step === step)?.status;
    expect(status('waveform')).toBe('skipped');
    expect(status('audio')).toBe('skipped');
    expect(status('proxy')).toBe('done');
    expect(done.storage.waveformKey).toBeNull();
  });

  it('fails a non-video once, without pointless retries, and says why', async () => {
    const path = join(dir, 'garbage.mp4');
    writeFileSync(path, Buffer.alloc(8192, 0x41));
    const doc = await seed(path);
    const done = await settled(doc._id);
    expect(done.status).toBe('failed');
    expect(done.error).toContain('Not a supported video file');
    const jobs = await jobsOf(doc._id);
    const probe = jobs.find((j) => j.step === 'probe');
    expect(probe).toMatchObject({ status: 'failed', attempts: 1 });
    for (const job of jobs.filter((j) => j.step !== 'probe')) expect(job.status).toBe('skipped');
  });

  it('refuses a disguised ffconcat script end to end', async () => {
    const path = join(dir, 'hostile.mp4');
    writeFileSync(path, "ffconcat version 1.0\nfile 'source'\n");
    const done = await settled((await seed(path))._id);
    expect(done.status).toBe('failed');
    expect(done.probe).toBeNull();
  });

  it('retries a transient failure and records real attempts', async () => {
    const source = makeVideo('flaky.mp4', [...VIDEO, ...TONE, '-c:v', 'libx264', '-c:a', 'aac']);
    // The declared size is wrong, so each download fails its integrity check, as a truncated read would.
    const doc = await seed(source, 'flaky.mp4', 1);
    // Polled on the error, not the attempt count: a retry that has just started clears the error.
    await expect
      .poll(async () => (await jobsOf(doc._id)).find((j) => j.step === 'probe')?.error, {
        timeout: 30_000,
        interval: 50,
      })
      .toContain('Downloaded');
    // Repair the record: the next retry succeeds without any manual step.
    await database.media.updateOne({ _id: doc._id }, { $set: { size: statSync(source).size } });
    const done = await settled(doc._id);
    expect(done.status).toBe('ready');
    const probe = (await jobsOf(doc._id)).find((j) => j.step === 'probe');
    expect(probe?.attempts).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('does nothing for an asset deleted while queued', async () => {
    const source = makeVideo('gone.mp4', [...VIDEO, '-c:v', 'libx264']);
    const doc = await seed(source);
    await database.media.updateOne({ _id: doc._id }, { $set: { deletedAt: new Date() } });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const after = await database.media.findOne({ _id: doc._id });
    expect(after?.storage.proxyKey).toBeNull();
  });
});

describe('sweep', () => {
  const inTwoHours = () => Date.now() + 2 * 60 * 60 * 1000;

  it('purges deleted media from storage and the database, but not too soon', async () => {
    const source = makeVideo('purge.mp4', [...VIDEO, ...TONE, '-c:v', 'libx264', '-c:a', 'aac']);
    const doc = await seed(source);
    const done = await settled(doc._id);
    await database.media.updateOne({ _id: doc._id }, { $set: { deletedAt: new Date() } });

    await sweep(ctx, workDir);
    expect(await database.media.findOne({ _id: doc._id })).not.toBeNull();
    expect(await storage.objectSize(done.storage.proxyKey!)).toBeGreaterThan(0);

    const result = await sweep(ctx, workDir, inTwoHours());
    expect(result.purged).toBeGreaterThanOrEqual(1);
    expect(await database.media.findOne({ _id: doc._id })).toBeNull();
    expect(await database.analysisJobs.countDocuments({ mediaId: doc._id })).toBe(0);
    expect(await storage.objectSize(done.storage.originalKey)).toBeNull();
    expect(await storage.objectSize(done.storage.proxyKey!)).toBeNull();
  });

  it('leaves live media alone', async () => {
    const source = makeVideo('live.mp4', [...VIDEO, '-c:v', 'libx264']);
    const done = await settled((await seed(source))._id);
    await sweep(ctx, workDir, inTwoHours());
    expect(await storage.objectSize(done.storage.originalKey)).toBeGreaterThan(0);
    expect((await database.media.findOne({ _id: done._id }))?.status).toBe('ready');
  });

  it('aborts uploads abandoned for a week, leaving recent ones', async () => {
    const insert = async (age: number) => {
      const mediaId = newId('med');
      const key = originalKey(projectId, mediaId);
      const s3UploadId = await storage.createMultipart(key, 'video/mp4');
      const updatedAt = new Date(Date.now() - age);
      await database.media.insertOne({
        _id: mediaId,
        projectId,
        ownerId: newId('usr'),
        name: 'x.mp4',
        folder: null,
        status: 'uploading',
        size: 1,
        contentType: 'video/mp4',
        extension: 'mp4',
        fingerprint: mediaId,
        upload: { s3UploadId, partSize: 1, partCount: 1 },
        storage: {
          originalKey: key,
          proxyKey: null,
          audioKey: null,
          waveformKey: null,
          waveformPeaksPerSecond: null,
          thumbnailKeys: [],
          posterKey: null,
        },
        probe: null,
        error: null,
        generation: 0,
        createdAt: updatedAt,
        updatedAt,
        deletedAt: null,
      });
      return { mediaId, key, s3UploadId };
    };
    const stale = await insert(8 * 24 * 60 * 60 * 1000);
    const recent = await insert(60 * 1000);

    const result = await sweep(ctx, workDir);
    expect(result.abandonedUploads).toBeGreaterThanOrEqual(1);
    expect(await database.media.findOne({ _id: stale.mediaId })).toBeNull();
    expect(await storage.listParts(stale.key, stale.s3UploadId)).toBeNull();
    expect(await database.media.findOne({ _id: recent.mediaId })).not.toBeNull();
    expect(await storage.listParts(recent.key, recent.s3UploadId)).toEqual([]);
  });

  it('requeues work whose queue entry was lost, such as after a Redis reset', async () => {
    const mediaId = newId('med');
    const source = makeVideo('lost.mp4', [...VIDEO, ...TONE, '-c:v', 'libx264', '-c:a', 'aac']);
    const key = originalKey(projectId, mediaId);
    const size = await storage.uploadFile(key, source, 'video/mp4');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await database.media.insertOne({
      _id: mediaId,
      projectId,
      ownerId: newId('usr'),
      name: 'lost.mp4',
      folder: null,
      status: 'processing',
      size,
      contentType: 'video/mp4',
      extension: 'mp4',
      fingerprint: mediaId,
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
      probe: null,
      error: null,
      generation: 0,
      createdAt: old,
      updatedAt: old,
      deletedAt: null,
    });
    await database.analysisJobs.insertMany(
      PROCESSING_STEPS.map((step) => newJobDoc(projectId, mediaId, step, old)),
    );

    const result = await sweep(ctx, workDir);
    expect(result.requeued).toBeGreaterThanOrEqual(1);
    expect((await settled(mediaId)).status).toBe('ready');
    expect(readdirSync(workDir)).not.toContain(mediaId);
  });
});
