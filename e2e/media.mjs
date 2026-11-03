// Drives real uploads through a browser. Needs `npm run infra:up`, `npm run dev` and FFmpeg.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { chromium } from 'playwright';

const shots = fileURLToPath(new URL('./screenshots/', import.meta.url));
mkdirSync(shots, { recursive: true });
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const PROCESSING_TIMEOUT = 120_000;
const files = mkdtempSync(join(tmpdir(), 'ae-e2e-'));

const s3 = new S3Client({
  region: process.env.S3_REGION ?? 'us-east-1',
  endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:8333',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'agent-edit-dev',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'agent-edit-dev-secret',
  },
});
const BUCKET = process.env.S3_BUCKET ?? 'agent-edit';

function ffmpeg(name, args) {
  const path = join(files, name);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, path]);
  return path;
}

const hashFile = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });

async function hashStored(key) {
  const { Body } = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const hash = createHash('sha256');
  for await (const chunk of Body) hash.update(chunk);
  return hash.digest('hex');
}

console.log('generating test footage...');
const tone = (seconds) => ['-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`];
const small = ffmpeg('sample talk.mp4', [
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=1280x720:rate=30:duration=5',
  ...tone(5),
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-c:a',
  'aac',
  '-shortest',
]);
// Lossless noise-heavy video: large enough for many parts, and still genuine media.
const heavy = (name, seed) =>
  ffmpeg(name, [
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1280x720:rate=30:duration=8,noise=alls=40:allf=t:all_seed=${seed}`,
    ...tone(8),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-qp',
    '10',
    '-c:a',
    'aac',
    '-shortest',
  ]);
const large = heavy('long recording.mp4', 1);
const large2 = heavy('second recording.mov', 2);
const garbage = join(files, 'not really a video.mp4');
writeFileSync(garbage, Buffer.alloc(16 * 1024, 0x41));
const unsupported = join(files, 'notes.txt');
writeFileSync(unsupported, 'hello');
console.log(
  `  large files: ${(statSync(large).size / 1048576).toFixed(0)} MB, ${(statSync(large2).size / 1048576).toFixed(0)} MB`,
);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && /Content Security Policy/.test(m.text())) problems.push(m.text());
});
page.on('dialog', (d) => d.accept());
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label} ${extra}`);
  if (!cond) process.exitCode = 1;
};
const shot = (n) => page.screenshot({ path: `${shots}${n}.png` });

// Records every part PUT that storage accepted, so "resumed" is measured, not assumed.
let accepted = [];
page.on('response', (res) => {
  const url = new URL(res.url());
  const part = url.searchParams.get('partNumber');
  if (res.request().method() === 'PUT' && part && res.status() === 200) accepted.push(Number(part));
});

const cdp = await ctx.newCDPSession(page);
// One session for both: separate sessions override each other's network conditions.
const network = (offline, bytesPerSecond) =>
  cdp.send('Network.emulateNetworkConditions', {
    offline,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: bytesPerSecond,
  });
const throttle = (bytesPerSecond) => network(false, bytesPerSecond);
const unthrottle = () => throttle(-1);

const row = (name) =>
  page.getByRole('list', { name: 'Media' }).getByRole('listitem').filter({ hasText: name });
const uploadRow = (name) =>
  page.getByRole('list', { name: 'Uploads' }).getByRole('listitem').filter({ hasText: name });
const percent = async (name) =>
  Number(
    await page
      .getByRole('progressbar', { name: `Upload of ${name}` })
      .getAttribute('aria-valuenow'),
  );
const untilPercent = async (name, min) => {
  await page.waitForFunction(
    ([label, floor]) =>
      Number(
        document
          .querySelector(`[role=progressbar][aria-label="Upload of ${label}"]`)
          ?.getAttribute('aria-valuenow'),
      ) >= floor,
    [name, min],
    { timeout: 60_000 },
  );
};
const ready = (name) =>
  row(name).getByText('Ready', { exact: true }).waitFor({ timeout: PROCESSING_TIMEOUT });
const choose = (paths) => page.getByLabel('Choose video files').setInputFiles(paths);

await page.goto(`${BASE}/register`);
await page.getByLabel('Email').fill(`media+${Date.now()}@example.com`);
await page.getByLabel('Name').fill('Media E2E');
await page.getByLabel('Password').fill('correct horse battery staple');
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByRole('heading', { name: 'Projects' }).waitFor();

// --- Project creation with footage ---
await page.getByRole('link', { name: 'New project' }).click();
await page.getByLabel('Name', { exact: true }).fill('Upload demo');
await page.getByLabel('Footage (optional)').setInputFiles(small);
await page.getByText(/sample talk\.mp4 · /).waitFor();
await page.getByRole('button', { name: 'Create project' }).click();
await page.getByRole('heading', { name: 'Upload demo' }).waitFor();
const projectId = page.url().split('/projects/')[1];
ok('project created with footage already selected', /^prj_/.test(projectId));
await page.getByText('Live updates').waitFor();
ok('realtime connection is live', true);

// --- Processing ---
const stepsSeen = new Set();
const watch = setInterval(() => {
  page
    .locator('[data-status="running"]')
    .allTextContents()
    .then((t) => t.forEach((x) => stepsSeen.add(x.replace(/[\d%]+$/, ''))))
    .catch(() => {});
}, 100);
await ready('sample talk.mp4');
clearInterval(watch);
ok(
  'footage reaches Ready through the real pipeline',
  true,
  `running steps observed: ${[...stepsSeen].join(', ') || 'too fast to sample'}`,
);
await page.reload();
const smallRow = row('sample talk.mp4');
await smallRow.getByText('0:05').waitFor();
ok('metadata shows real duration', true);
ok('metadata shows real resolution', await smallRow.getByText('1280 × 720').isVisible());
ok('metadata shows real frame rate', await smallRow.getByText('30 fps').isVisible());
ok(
  'thumbnail is loaded',
  await smallRow.locator('img').evaluate((img) => img.complete && img.naturalWidth > 0),
);
await shot('20-media-ready');

// --- Preview plays the proxy ---
await page.getByRole('button', { name: 'Preview sample talk.mp4' }).click();
const video = page.locator('dialog video');
await video.waitFor();
await page.waitForFunction(() => document.querySelector('dialog video')?.readyState >= 2, null, {
  timeout: 15_000,
});
const dims = await video.evaluate((v) => [v.videoWidth, v.videoHeight, Math.round(v.duration)]);
ok(
  'preview loads the 720p proxy',
  dims[0] === 1280 && dims[1] === 720 && dims[2] === 5,
  JSON.stringify(dims),
);
await video.evaluate((v) => {
  v.muted = true;
  return v.play();
});
await page.waitForFunction(() => document.querySelector('dialog video')?.currentTime > 0.3, null, {
  timeout: 10_000,
});
ok('proxy really plays (currentTime advances)', true);
await video.evaluate((v) => {
  v.currentTime = 4;
});
await page.waitForFunction(
  () => {
    const v = document.querySelector('dialog video');
    return v.currentTime >= 3.9 && !v.seeking;
  },
  null,
  { timeout: 10_000 },
);
ok('proxy seeks through range requests', true);
const waveformHasInk = await page.locator('dialog canvas').evaluate((canvas) => {
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
  return false;
});
ok('waveform is drawn from real peaks', waveformHasInk);
await shot('21-preview');
await page.getByRole('button', { name: 'Close' }).click();

// --- Organise ---
await page.getByRole('button', { name: 'Edit sample talk.mp4' }).click();
await smallRow.getByLabel('Name').fill('Keynote take 1.mp4');
await smallRow.getByLabel('Folder').fill('A-roll');
await smallRow.getByRole('button', { name: 'Save' }).click();
await row('Keynote take 1.mp4').waitFor();
await page.reload();
await row('Keynote take 1.mp4').getByText('A-roll').waitFor();
ok('rename and folder persist across reload', true);
await page.getByLabel('Folder').selectOption('A-roll');
ok('folder filter shows matching media', await row('Keynote take 1.mp4').isVisible());
await page.getByLabel('Folder').selectOption('All');

// --- Rejections ---
await choose(unsupported);
await uploadRow('notes.txt').getByText('Supported formats are').waitFor();
ok('unsupported extension refused before any upload', (await row('notes.txt').count()) === 0);
await uploadRow('notes.txt').getByRole('button', { name: 'Dismiss' }).click();

await choose(garbage);
const badRow = row('not really a video.mp4');
const badStatus = badRow.getByText('Failed', { exact: true }).last();
await badStatus.waitFor({ timeout: PROCESSING_TIMEOUT });
ok(
  'fake video is rejected by FFprobe with a reason',
  await badRow.getByText('Not a supported video file').first().isVisible(),
);
await shot('22-media-failed');
const [retried] = await Promise.all([
  page.waitForResponse((res) => res.url().endsWith('/retry')),
  page.getByRole('button', { name: 'Retry not really a video.mp4' }).click(),
]);
ok('retry really restarts processing', (await retried.json()).status === 'processing');
await page.waitForFunction(
  async (url) => {
    const { items } = await (await fetch(url)).json();
    return items.find((m) => m.name === 'not really a video.mp4')?.status === 'failed';
  },
  `/api/v1/projects/${projectId}/media`,
  { timeout: PROCESSING_TIMEOUT },
);
await badStatus.waitFor({ timeout: PROCESSING_TIMEOUT });
ok('the rerun fails honestly again', true);
await page.getByRole('button', { name: 'Delete not really a video.mp4' }).click();
await page.getByRole('button', { name: 'Confirm delete not really a video.mp4' }).click();
await badRow.waitFor({ state: 'detached' });
ok('deleted media leaves the list', true);

// --- Going offline mid-upload ---
accepted = [];
await throttle(12 * 1024 * 1024);
await choose(large);
await untilPercent('long recording.mp4', 25);
const before = await percent('long recording.mp4');
await shot('23-uploading');
await network(true, 0);
await uploadRow('long recording.mp4')
  .getByText(/Offline|Connection problem/)
  .waitFor({ timeout: 30_000 });
ok('going offline is reported, not hidden', true);
await page.getByText('Reconnecting').waitFor({ timeout: 30_000 });
ok('realtime loss is reported too', true);
await shot('24-offline');
const partsAtOffline = accepted.length;
await page.waitForTimeout(1500);
ok('nothing is accepted while offline', accepted.length === partsAtOffline);
await unthrottle();
await page.getByText('Live updates').waitFor({ timeout: 30_000 });
ok('realtime reconnects by itself', true);
await uploadRow('long recording.mp4').getByText('Uploaded').waitFor({ timeout: 60_000 });
ok('upload continues by itself once back online', true, `(was at ${before}%)`);
const duplicates = accepted.filter((n, i) => accepted.indexOf(n) !== i);
ok('no finished part was sent twice', duplicates.length === 0, `${accepted.length} parts accepted`);
await ready('long recording.mp4');

// --- Reload mid-upload, then resume by choosing the file again ---
accepted = [];
await throttle(12 * 1024 * 1024);
await choose(large2);
await untilPercent('second recording.mov', 35);
await page.waitForFunction(() => true);
const sentBeforeReload = new Set(accepted);
await unthrottle();
await page.reload();
await row('second recording.mov').getByText('Upload incomplete').waitFor();
ok('interrupted upload is visible after reload, with instructions', true);
await shot('25-incomplete');
accepted = [];
await choose(large2);
await uploadRow('second recording.mov')
  .getByText(/resumed from/)
  .waitFor({ timeout: 15_000 });
ok(
  'choosing the same file resumes it',
  true,
  await uploadRow('second recording.mov')
    .getByText(/resumed from/)
    .textContent(),
);
await uploadRow('second recording.mov').getByText('Uploaded').waitFor({ timeout: 60_000 });
const repeated = accepted.filter((n) => sentBeforeReload.has(n));
ok(
  'resume sent only parts storage lacked',
  sentBeforeReload.size > 0 && repeated.length === 0,
  `kept ${sentBeforeReload.size}, sent ${accepted.length}, repeated ${repeated.length}`,
);
await ready('second recording.mov');
ok('resumed file processes as valid media', true);

// --- Integrity: the stored bytes must equal the local file ---
const listed = await page.evaluate(
  async (id) => (await (await fetch(`/api/v1/projects/${id}/media`)).json()).items,
  projectId,
);
for (const [name, path] of [
  ['long recording.mp4', large],
  ['second recording.mov', large2],
]) {
  const media = listed.find((m) => m.name === name);
  const key = `originals/${projectId}/${media.id}/source`;
  const [local, stored] = await Promise.all([hashFile(path), hashStored(key)]);
  ok(`stored bytes match the local file: ${name}`, local === stored, local.slice(0, 12));
}

// --- Pause, resume, cancel ---
await throttle(8 * 1024 * 1024);
await page.goto(`${BASE}/projects/new`);
await page.getByLabel('Name', { exact: true }).fill('Pause demo');
await page.getByRole('button', { name: 'Create project' }).click();
await page.getByRole('heading', { name: 'Pause demo' }).waitFor();
const pauseProject = page.url().split('/projects/')[1];
await choose(large);
await untilPercent('long recording.mp4', 15);
await uploadRow('long recording.mp4').getByRole('button', { name: 'Pause' }).click();
await uploadRow('long recording.mp4').getByText('Paused').waitFor();
await page.waitForTimeout(300);
const paused = accepted.length;
const pausedAt = await percent('long recording.mp4');
await page.waitForTimeout(1500);
ok(
  'pause really stops the transfer',
  accepted.length === paused && (await percent('long recording.mp4')) === pausedAt,
  `at ${pausedAt}%`,
);
await uploadRow('long recording.mp4').getByRole('button', { name: 'Resume' }).click();
await page.waitForFunction(
  (floor) =>
    Number(document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')) > floor,
  pausedAt,
  { timeout: 30_000 },
);
ok('resume continues the transfer', true);
await uploadRow('long recording.mp4').getByRole('button', { name: 'Cancel' }).click();
await uploadRow('long recording.mp4').waitFor({ state: 'detached' });
await unthrottle();
await page.reload();
await page.getByText('No footage yet').waitFor();
ok('cancel removes the upload completely', true);
const remaining = await page.evaluate(
  async (id) => (await (await fetch(`/api/v1/projects/${id}/media`)).json()).items.length,
  pauseProject,
);
ok('cancel leaves no record on the server', remaining === 0);

// --- Dashboard ---
await page.goto(BASE);
const demo = page.getByRole('row').filter({ hasText: 'Upload demo' });
await demo.getByText('3 clips').waitFor();
ok('dashboard shows real footage count', true);
ok(
  'dashboard shows a real thumbnail',
  await demo.locator('img').evaluate((img) => img.complete && img.naturalWidth > 0),
);
await shot('26-dashboard');

// --- Mobile ---
const mobile = await browser.newPage({
  viewport: { width: 390, height: 844 },
  storageState: await ctx.storageState(),
});
await mobile.goto(`${BASE}/projects/${projectId}`);
await mobile.getByText('Ready', { exact: true }).first().waitFor();
const overflow = await mobile.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
ok('media library has no horizontal scroll at 390px', overflow <= 0, `overflow=${overflow}`);
await mobile.screenshot({ path: `${shots}27-mobile-media.png`, fullPage: true });
await mobile.close();

ok('no uncaught page errors', problems.length === 0, JSON.stringify(problems));
await browser.close();
rmSync(files, { recursive: true, force: true });
