// Exports a real edit through the browser, downloads the file and probes what actually came out.
// Needs `npm run infra:up`, `npm run dev` and the full FFmpeg build for burned-in captions.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const shots = fileURLToPath(new URL('./screenshots/', import.meta.url));
mkdirSync(shots, { recursive: true });
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const FULL = '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
const FFMPEG = process.env.FFMPEG_PATH ?? (existsSync(FULL) ? FULL : 'ffmpeg');
const FFPROBE = process.env.FFPROBE_PATH ?? FFMPEG.replace(/ffmpeg$/, 'ffprobe');
const dir = mkdtempSync(join(tmpdir(), 'ae-render-e2e-'));
const quiet = ['-hide_banner', '-loglevel', 'error', '-y'];

function make(name, color, hz, seconds) {
  const path = join(dir, name);
  execFileSync(FFMPEG, [
    ...quiet,
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=1280x720:r=30:d=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${hz}:sample_rate=48000:duration=${seconds},volume=2`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-g',
    '15',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    path,
  ]);
  return path;
}
const redClip = make('red clip.mp4', 'red', 300, 6);
const blueClip = make('blue clip.mp4', 'blue', 600, 6);
const longClip = make('long clip.mp4', 'lime', 400, 60);

const probe = (file) =>
  JSON.parse(
    execFileSync(FFPROBE, [
      '-v',
      'error',
      '-count_frames',
      '-show_entries',
      'stream=codec_type,codec_name,width,height,nb_read_frames:format=duration',
      '-of',
      'json',
      file,
    ]).toString(),
  );
const pixel = (file, at, x = 640, y = 360) => {
  const raw = execFileSync(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(at),
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    `crop=1:1:${x}:${y},format=rgb24`,
    '-f',
    'rawvideo',
    '-',
  ]);
  return [raw[0], raw[1], raw[2]];
};
const spread = (buffer) => {
  let low = 255;
  let high = 0;
  for (const value of buffer) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  return high - low;
};
const isColor = (actual, expected) =>
  actual.every((value, i) => Math.abs(value - expected[i]) < 40);
const RED = [254, 0, 0];
const BLUE = [0, 0, 254];

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 950 },
  acceptDownloads: true,
});
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label} ${extra}`);
  if (!cond) process.exitCode = 1;
};
const shot = (n) => page.screenshot({ path: `${shots}${n}.png` });

await page.goto(`${BASE}/register`);
await page.getByLabel('Email').fill(`render+${Date.now()}@example.com`);
await page.getByLabel('Name').fill('Render E2E');
await page.getByLabel('Password').fill('correct horse battery staple');
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByRole('heading', { name: 'Projects' }).waitFor();
ok(
  'dashboard says exports appear here, before any exist',
  await page.getByText('Finished exports appear here').isVisible(),
);
await page.goto(`${BASE}/projects/new`);
await page.getByLabel('Name', { exact: true }).fill('Render demo');
await page.getByRole('radio', { name: '720p' }).check({ force: true });
await page.getByLabel('Footage (optional)').setInputFiles([redClip, blueClip, longClip]);
await page.getByRole('button', { name: 'Create project' }).click();
await page.getByText('Choose files').waitFor();
const projectId = page.url().split('/projects/')[1];
await page
  .getByRole('list', { name: 'Media' })
  .getByText('Ready', { exact: true })
  .nth(2)
  .waitFor({ timeout: 180_000 });

const api = (path, init) =>
  page.evaluate(
    async ([url, options]) => (await fetch(url, options)).json(),
    [`/api/v1/projects/${projectId}${path}`, init],
  );

await page.goto(`${BASE}/projects/${projectId}/edit`);
await page.getByRole('tab', { name: 'Export' }).click();
ok(
  'exporting an empty timeline is not offered',
  await page.getByRole('button', { name: 'Export video' }).isDisabled(),
);
const saved = () => page.getByTestId('save-state').getByText('Saved').waitFor({ timeout: 15_000 });
await page.getByRole('button', { name: 'Add red clip.mp4 to timeline' }).click();
await saved();
await page.getByRole('button', { name: 'Add blue clip.mp4 to timeline' }).click();
await saved();

// A caption, and a split with the tail removed, so the render has real edits to honour.
await page.locator('[data-testid=ruler]').click({ position: { x: 40 * 2 + 1, y: 10 } });
await page.getByRole('button', { name: 'Add caption' }).click();
await saved();
await page.getByLabel('Text').fill('Burned in caption');
await page.getByLabel('Text').blur();
await saved();
await page.keyboard.press('Escape');
await page.locator('[data-testid=ruler]').click({ position: { x: 40 * 4 + 1, y: 10 } });
await page.getByRole('button', { name: 'Split' }).click();
await saved();
const clips = page.getByTestId('track-VIDEO').getByTestId('clip');
await clips.nth(1).click({ position: { x: 20, y: 20 } });
await page.getByRole('button', { name: 'Ripple delete' }).click();
await saved();
const timeline = await api('/timelines/main');
const video = timeline.tracks.find((t) => t.type === 'VIDEO').clips;
const seconds = video.reduce((sum, c) => sum + c.duration, 0) / 705_600_000;
ok(
  'the edit is what the test expects',
  video.length === 2 && Math.abs(seconds - 10) < 0.2,
  `${seconds.toFixed(2)}s`,
);

// --- Export ---
await page.getByRole('tab', { name: 'Export' }).click();
await shot('50-export-panel');
await page.getByRole('button', { name: 'Export video' }).click();
const job = page.getByTestId('render-job').first();
await job.waitFor();
const seen = new Set();
const samples = setInterval(() => {
  page
    .getByRole('progressbar')
    .first()
    .getAttribute('aria-valuenow')
    .then((v) => v !== null && seen.add(Number(v)))
    .catch(() => {});
}, 100);
await job.getByRole('link', { name: 'Download video' }).waitFor({ timeout: 180_000 });
clearInterval(samples);
await shot('51-export-done');
ok(
  'progress came from the job and rose',
  seen.size === 0 || [...seen].every((v) => v >= 0 && v <= 100),
  [...seen].sort((a, b) => a - b).join(','),
);

// --- Keep editing while the file downloads, to prove the export is a snapshot ---
const [download] = await Promise.all([
  page.waitForEvent('download'),
  job.getByRole('link', { name: 'Download video' }).click(),
]);
const file = join(dir, 'exported.mp4');
await download.saveAs(file);
ok(
  'download has the right name',
  download.suggestedFilename().endsWith('.mp4'),
  download.suggestedFilename(),
);
ok('the file is real', statSync(file).size > 1000, `${(statSync(file).size / 1024).toFixed(0)} KB`);

const info = probe(file);
const v = info.streams.find((s) => s.codec_type === 'video');
const a = info.streams.find((s) => s.codec_type === 'audio');
ok('H.264 and AAC', v.codec_name === 'h264' && a?.codec_name === 'aac');
ok('the project resolution', v.width === 1280 && v.height === 720, `${v.width}x${v.height}`);
const expectedFrames = video.reduce((sum, c) => sum + c.duration, 0) / (705_600_000 / 30);
ok(
  'exactly the timeline frame count',
  Number(v.nb_read_frames) === expectedFrames,
  `${v.nb_read_frames} of ${expectedFrames}`,
);
ok(
  'kept first clip shows at the start',
  isColor(pixel(file, 1), RED),
  JSON.stringify(pixel(file, 1)),
);
ok(
  'the removed tail is really gone: blue follows directly',
  isColor(pixel(file, 5), BLUE),
  JSON.stringify(pixel(file, 5)),
);
const contrast = (at) => {
  const raw = execFileSync(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(at),
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    'crop=1280:120:0:600,format=gray',
    '-f',
    'rawvideo',
    '-',
  ]);
  return spread(raw);
};
ok('the caption is burned in while on screen', contrast(3) > 100, `contrast ${contrast(3)}`);
ok('and gone afterwards', contrast(6) < 40, `contrast ${contrast(6)}`);

// --- SRT ---
const srt = await page.evaluate(
  async (url) => (await fetch(url)).text(),
  `/api/v1/projects/${projectId}/timelines/${timeline.id}/captions.srt`,
);
// Two entries, because Split with nothing selected also split the caption under the playhead.
ok(
  'SRT export is correct',
  /^1\n00:00:02,\d{3} --> 00:00:04,\d{3}\nBurned in caption\n\n2\n00:00:04,\d{3} --> 00:00:05,\d{3}\nBurned in caption\n$/.test(
    srt,
  ),
  JSON.stringify(srt),
);
ok(
  'SRT is also attached to the export',
  await job.getByRole('link', { name: 'Captions (SRT)' }).isVisible(),
);

// --- Different format ---
await page.getByLabel('Format').selectOption('square');
await page.getByLabel('Burn captions into the picture').uncheck();
await page.getByRole('button', { name: 'Export video' }).click();
const square = page.getByTestId('render-job').first();
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid=render-job]').length === 2,
);
await square.getByRole('link', { name: 'Download video' }).waitFor({ timeout: 180_000 });
const [squareDownload] = await Promise.all([
  page.waitForEvent('download'),
  square.getByRole('link', { name: 'Download video' }).click(),
]);
const squareFile = join(dir, 'square.mp4');
await squareDownload.saveAs(squareFile);
const squareVideo = probe(squareFile).streams.find((s) => s.codec_type === 'video');
ok(
  'square export has the requested shape',
  squareVideo.width === 1080 && squareVideo.height === 1080,
);
ok(
  'it letterboxes rather than crops',
  isColor(pixel(squareFile, 1, 540, 60), [0, 0, 0]) && isColor(pixel(squareFile, 1, 540, 540), RED),
);
const noCaption = execFileSync(FFMPEG, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-ss',
  '3',
  '-i',
  squareFile,
  '-frames:v',
  '1',
  '-vf',
  'crop=1080:150:0:600,format=gray',
  '-f',
  'rawvideo',
  '-',
]);
ok('captions left out when asked', spread(noCaption) < 40);

// --- Cancel and retry on a longer job ---
await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Add long clip.mp4 to timeline' }).click();
await saved();
await page.getByLabel('Format').selectOption('source');
await page.getByRole('button', { name: 'Export video' }).click();
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid=render-job]').length === 3,
);
const long = page.getByTestId('render-job').first();
await long.getByRole('button', { name: 'Cancel' }).click();
await long.getByRole('status').getByText('Cancelled').waitFor({ timeout: 15_000 });
ok('an export can be cancelled', true);
await page.waitForTimeout(3000);
const running = execFileSync('ps', ['-axo', 'command='])
  .toString()
  .split('\n')
  .filter((l) => /ffmpeg .*chunk-/.test(l));
ok('cancelling really stops FFmpeg', running.length === 0, `${running.length} running`);
await long.getByRole('button', { name: 'Retry' }).click();
await long.getByRole('link', { name: 'Download video' }).waitFor({ timeout: 300_000 });
ok('a cancelled export can be retried to completion', true);

// --- Export history ---
await page.goto(BASE);
await page
  .getByRole('complementary', { name: 'Export history' })
  .getByRole('link', { name: /Download/ })
  .first()
  .waitFor();
const links = await page
  .getByRole('complementary', { name: 'Export history' })
  .getByRole('link', { name: /Download/ })
  .count();
ok('dashboard lists real exports', links === 3, `${links} downloads`);
await shot('52-dashboard-exports');

const res = await page.evaluate(async () => (await fetch('/api/v1/renders')).json());
const url = res.items[0].downloadUrl;
const stranger = await browser.newContext();
const anonymous = await stranger.request.get(url.split('?')[0]);
ok('the file needs a signature', anonymous.status() === 403, `${anonymous.status()}`);
const signed = await stranger.request.get(url, { headers: { range: 'bytes=0-9' } });
ok('the signed link works without a session', signed.status() === 206, `${signed.status()}`);
await stranger.close();

ok('no uncaught page errors', problems.length === 0, JSON.stringify(problems));
await browser.close();
rmSync(dir, { recursive: true, force: true });
