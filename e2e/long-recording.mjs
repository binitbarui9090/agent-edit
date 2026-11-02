// Proves the long-recording claims on real data: a multi-GB, 3-hour file, an interrupted upload, and
// a worker killed mid-encode. Takes tens of minutes. Needs `npm run infra:up` and `npm run dev`.
// Usage: npm run test:long -- <path to file>, or omit the path to generate one in the temp directory.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const s3 = new S3Client({
  region: process.env.S3_REGION ?? 'us-east-1',
  endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:8333',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'agent-edit-dev',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'agent-edit-dev-secret',
  },
});

const started = Date.now();
const log = (...args) =>
  console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(5)}s]`, ...args);
const ok = (label, cond, extra = '') => {
  log(`${cond ? 'PASS' : 'FAIL'}  ${label} ${extra}`);
  if (!cond) process.exitCode = 1;
};
const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const mb = (kb) => `${(kb / 1024).toFixed(0)} MB`;

function generate() {
  const path = join(tmpdir(), 'agent-edit-three-hour.mp4');
  if (existsSync(path)) return path;
  log('generating a 3-hour recording...');
  const chunk = join(tmpdir(), 'agent-edit-chunk.mp4');
  const quiet = ['-hide_banner', '-loglevel', 'error', '-y'];
  execFileSync('ffmpeg', [
    ...quiet,
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1280x720:rate=30:duration=60,noise=alls=12:allf=t',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:duration=60',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-b:v',
    '2500k',
    '-g',
    '30',
    '-c:a',
    'aac',
    '-shortest',
    chunk,
  ]);
  execFileSync('ffmpeg', [
    ...quiet,
    '-stream_loop',
    '179',
    '-i',
    chunk,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    path,
  ]);
  return path;
}
const file = process.argv[2] ?? generate();
const fileName = file.split('/').pop();
const fileSize = statSync(file).size;
log(`file: ${fileName}, ${gb(fileSize)}`);

// --- Memory sampling ---
function rssOf(pattern) {
  try {
    const out = execFileSync('ps', ['-axo', 'rss=,command='], {
      maxBuffer: 16 * 1024 * 1024,
    }).toString();
    let peak = 0;
    for (const line of out.split('\n')) {
      if (!pattern.test(line)) continue;
      peak = Math.max(peak, Number(line.trim().split(/\s+/)[0]));
    }
    return peak;
  } catch {
    return 0;
  }
}
const peaks = { worker: 0, ffmpeg: 0, heap: 0 };
const WORKER_PATTERN = /apps\/worker|worker\/src\/index\.ts/;
const FFMPEG_PATTERN = /ffmpeg .*work.*\/source|ffmpeg .*\/source/;
const sampler = setInterval(() => {
  // tsx runs the worker as `node ... src/index.ts` from apps/worker.
  peaks.worker = Math.max(peaks.worker, rssOf(/src\/index\.ts/));
  peaks.ffmpeg = Math.max(peaks.ffmpeg, rssOf(FFMPEG_PATTERN));
}, 3000);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept());
let accepted = new Set();
page.on('response', (res) => {
  const part = new URL(res.url()).searchParams.get('partNumber');
  if (res.request().method() === 'PUT' && part && res.status() === 200) accepted.add(Number(part));
});
const sampleHeap = async () => {
  const used = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0).catch(() => 0);
  peaks.heap = Math.max(peaks.heap, used / 1024);
};
const heapTimer = setInterval(() => void sampleHeap(), 1000);

await page.goto(`${BASE}/register`);
await page.getByLabel('Email').fill(`long+${Date.now()}@example.com`);
await page.getByLabel('Name').fill('Long E2E');
await page.getByLabel('Password').fill('correct horse battery staple');
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByRole('heading', { name: 'Projects' }).waitFor();
await page.goto(`${BASE}/projects/new`);
await page.getByLabel('Name', { exact: true }).fill('Three hour recording');
await page.getByRole('button', { name: 'Create project' }).click();
await page.getByText('Choose files').waitFor();
const projectId = page.url().split('/projects/')[1];
const mediaUrl = `/api/v1/projects/${projectId}/media`;
const fetchMedia = async () =>
  (await page.evaluate(async (url) => (await (await fetch(url)).json()).items, mediaUrl))[0];

// --- Upload, interrupted by a reload ---
const uploadStart = Date.now();
await page.getByLabel('Choose video files').setInputFiles(file);
await page.waitForFunction(
  () => Number(document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')) >= 30,
  null,
  { timeout: 600_000 },
);
const kept = new Set(accepted);
log(`interrupting at 30%: ${kept.size} parts stored`);
await page.reload();
await page.getByText('Upload incomplete').waitFor({ timeout: 60_000 });
accepted = new Set();
await page.getByLabel('Choose video files').setInputFiles(file);
const resumed = page.getByText(/resumed from/);
await resumed.waitFor({ timeout: 60_000 });
log(`resuming: ${await resumed.textContent()}`);
await page.getByRole('status').getByText('Uploaded', { exact: true }).waitFor({ timeout: 900_000 });
const uploadSeconds = (Date.now() - uploadStart) / 1000;
const overlap = [...accepted].filter((n) => kept.has(n)).length;
ok(
  'multi-GB upload resumed without resending stored parts',
  kept.size > 0 && overlap === 0,
  `kept ${kept.size}, sent ${accepted.size}, repeated ${overlap}`,
);
log(
  `upload took ${uploadSeconds.toFixed(0)}s (${(fileSize / 1024 ** 2 / uploadSeconds).toFixed(0)} MB/s)`,
);

const media = await fetchMedia();
const key = `originals/${projectId}/${media.id}/source`;
log('hashing the stored object and the local file...');
const hashes = await Promise.all([
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  }),
  (async () => {
    const { Body } = await s3.send(
      new GetObjectCommand({ Bucket: process.env.S3_BUCKET ?? 'agent-edit', Key: key }),
    );
    const hash = createHash('sha256');
    for await (const chunk of Body) hash.update(chunk);
    return hash.digest('hex');
  })(),
]);
ok('stored bytes match the local file exactly', hashes[0] === hashes[1], hashes[0].slice(0, 16));

// --- Processing, with the worker killed mid-encode ---
const processStart = Date.now();
const stepTimes = {};
let killed = false;
let replacement = null;
for (;;) {
  const current = await fetchMedia();
  for (const job of current.jobs) {
    if (['done', 'failed', 'skipped'].includes(job.status) && !stepTimes[job.step]) {
      stepTimes[job.step] = ((Date.now() - processStart) / 1000).toFixed(0);
      log(`step ${job.step}: ${job.status} after ${stepTimes[job.step]}s`);
    }
  }
  const proxy = current.jobs.find((j) => j.step === 'proxy');
  if (!killed && proxy?.status === 'running' && proxy.progress >= 0.03) {
    killed = true;
    const pids = execFileSync('ps', ['-axo', 'pid=,command='])
      .toString()
      .split('\n')
      .filter(
        (line) =>
          /--conditions=source/.test(line) &&
          !/tsx watch|\.bin\/tsx/.test(line) &&
          /index\.ts/.test(line),
      )
      .map((line) => Number(line.trim().split(/\s+/)[0]));
    // Find the worker among the two watched entrypoints by the working directory.
    const workerPid = pids.find((pid) => {
      const cwd = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).toString();
      return cwd.includes('apps/worker');
    });
    if (!workerPid) throw new Error('Could not find the worker process');
    const before = Math.round(proxy.progress * 100);
    process.kill(workerPid, 'SIGKILL');
    log(`SIGKILL sent to worker ${workerPid} at proxy ${before}%`);
    const pgrep = () =>
      execFileSync('ps', ['-axo', 'pid=,command='])
        .toString()
        .split('\n')
        .filter((line) => FFMPEG_PATTERN.test(line))
        .map((line) => Number(line.trim().split(/\s+/)[0]));
    const strays = pgrep();
    ok(
      'killing the worker really does leave FFmpeg running',
      strays.length > 0,
      `${strays.length} left`,
    );
    replacement = spawn(
      process.execPath,
      ['--conditions=source', '--import', 'tsx', '--env-file-if-exists=../../.env', 'src/index.ts'],
      { cwd: new URL('../apps/worker/', import.meta.url), stdio: 'ignore' },
    );
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const current = pgrep();
    const survivors = strays.filter((pid) => current.includes(pid));
    ok(
      'the replacement worker stopped the stray encoders',
      survivors.length === 0,
      `${survivors.length} survived`,
    );
    log('started a replacement worker');
  }
  if (current.status !== 'processing') {
    ok(
      'asset reaches ready after the worker crash',
      current.status === 'ready',
      current.error ?? '',
    );
    ok('crash recovery was exercised', killed);
    break;
  }
  if (Date.now() - processStart > 60 * 60 * 1000) throw new Error('Processing took over an hour');
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
log(`processing took ${((Date.now() - processStart) / 1000).toFixed(0)}s for 3 hours of footage`);

// --- The result is really usable ---
await page.goto(`${BASE}/projects/${projectId}`);
await page.getByRole('button', { name: `Preview ${fileName}` }).click();
const video = page.locator('dialog video');
await video.waitFor();
await page.waitForFunction(() => document.querySelector('dialog video')?.readyState >= 1, null, {
  timeout: 60_000,
});
const duration = await video.evaluate((v) => v.duration);
ok('proxy reports the full duration', Math.abs(duration - 10800) < 10, `${duration.toFixed(0)}s`);
const seekStart = Date.now();
await video.evaluate((v) => {
  v.muted = true;
  v.currentTime = 7200;
});
await page.waitForFunction(
  () => {
    const v = document.querySelector('dialog video');
    return !v.seeking && v.readyState >= 2 && v.currentTime >= 7199;
  },
  null,
  { timeout: 60_000 },
);
const seekMs = Date.now() - seekStart;
ok('seeking to 2 hours is quick, without downloading the file', seekMs < 5000, `${seekMs} ms`);
await sampleHeap();

clearInterval(sampler);
clearInterval(heapTimer);
log(
  `peak memory: worker ${mb(peaks.worker)}, ffmpeg ${mb(peaks.ffmpeg)}, browser JS heap ${mb(peaks.heap)}`,
);
ok(
  'browser heap stayed far below the file size',
  peaks.heap * 1024 < fileSize / 10,
  mb(peaks.heap),
);
ok(
  'worker memory stayed far below the file size',
  peaks.worker * 1024 < fileSize / 4,
  mb(peaks.worker),
);

await browser.close();
if (replacement) replacement.kill('SIGTERM');
