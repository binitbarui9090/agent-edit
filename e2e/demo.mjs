// The product's acceptance test: every step of the demonstration, in order, in a real browser, with
// real speech, real speech recognition and a real language model. The final file is transcribed again,
// so the claim that a repeated take is gone is checked by listening to the export.
// Needs `npm run infra:up`, `npm run dev`, SPEECH_PROVIDER=whisper and an LLM_PROVIDER, on macOS.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { makeCutaway, makeSpeechVideo } from './speech.mjs';

const shots = fileURLToPath(new URL('./screenshots/', import.meta.url));
mkdirSync(shots, { recursive: true });
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const FULL = '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
const FFMPEG = process.env.FFMPEG_PATH ?? (existsSync(FULL) ? FULL : 'ffmpeg');
const FFPROBE = process.env.FFPROBE_PATH ?? FFMPEG.replace(/ffmpeg$/, 'ffprobe');
const WHISPER_MODEL =
  process.env.WHISPER_MODEL_PATH ?? join(homedir(), '.cache/agent-edit/whisper/ggml-base.en.bin');
const TICKS = 705_600_000;
const INSTRUCTION =
  'Make the first 15 seconds faster, remove repeated takes, add relevant B-roll, normalize dialogue, and generate three Shorts.';

const dir = mkdtempSync(join(tmpdir(), 'ae-demo-'));
const talk = join(dir, 'three hour recording.mp4');
const cutaway = join(dir, 'software architecture diagram.mp4');
makeSpeechVideo(dir, talk);
makeCutaway(cutaway);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 950 },
  acceptDownloads: true,
});
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && /Content Security Policy/.test(m.text())) problems.push(m.text());
});

const started = Date.now();
const step = (n, title) =>
  console.log(`\n--- Step ${n}: ${title} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label} ${extra}`);
  if (!cond) process.exitCode = 1;
};
const shot = (n) => page.screenshot({ path: `${shots}${n}.png` });
const saved = () => page.getByTestId('save-state').getByText('Saved').waitFor({ timeout: 15_000 });

await page.goto(`${BASE}/register`);
await page.getByLabel('Email').fill(`demo+${Date.now()}@example.com`);
await page.getByLabel('Name').fill('Demo');
await page.getByLabel('Password').fill('correct horse battery staple');
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByRole('heading', { name: 'Projects' }).waitFor();

step(1, 'Create a new project');
await page.getByRole('link', { name: 'New project' }).click();
await page.getByLabel('Name', { exact: true }).fill('Acceptance demo');
await page.getByRole('button', { name: 'Create project' }).click();
await page.getByRole('heading', { name: 'Acceptance demo' }).waitFor();
const projectId = page.url().split('/projects/')[1];
ok('project created', /^prj_/.test(projectId));
const api = (path, init) =>
  page.evaluate(
    async ([url, options]) => (await fetch(url, options)).json(),
    [`/api/v1/projects/${projectId}${path}`, init],
  );

step(2, 'Upload a recording');
const cdp = await ctx.newCDPSession(page);
// Slowed down only so the progress bar can be seen moving. The bytes are real.
await cdp.send('Network.emulateNetworkConditions', {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: 256 * 1024,
});
await page.getByLabel('Choose video files').setInputFiles([talk, cutaway]);

step(3, 'Show upload progress');
const bar = page.getByRole('progressbar', { name: 'Upload of three hour recording.mp4' });
await bar.waitFor({ timeout: 30_000 });
const readings = [];
for (let i = 0; i < 240 && new Set(readings).size < 3; i++) {
  readings.push(Number((await bar.getAttribute('aria-valuenow').catch(() => null)) ?? 100));
  await page.waitForTimeout(500);
}
await shot('60-demo-uploading');
ok(
  'progress moves and only rises',
  readings.at(-1) > readings[0] && readings.every((v, i) => i === 0 || v >= readings[i - 1]),
  readings.join(','),
);
await cdp.send('Network.emulateNetworkConditions', {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
});

step(4, 'Process the video asynchronously');
await page
  .getByRole('list', { name: 'Media' })
  .getByText('Ready', { exact: true })
  .nth(1)
  .waitFor({ timeout: 180_000 });
let media = (await api('/media')).items;
ok('footage is ready', media.length === 2 && media.every((m) => m.status === 'ready'));
await page.getByRole('link', { name: 'Settings' }).click();
await page.getByRole('heading', { name: 'Delete project' }).waitFor();
ok('the rest of the app stays usable during processing', true);
await page.getByRole('link', { name: 'Media', exact: true }).click();

step(5, 'Generate transcript and scene information');
const deadline = Date.now() + 600_000;
for (;;) {
  media = (await api('/media')).items;
  const busy = media.some((m) =>
    m.jobs.some((j) => j.status === 'queued' || j.status === 'running'),
  );
  if (!busy) break;
  if (Date.now() > deadline) throw new Error('Analysis took over 10 minutes');
  await page.waitForTimeout(2000);
}
const talkAsset = media.find((m) => m.name === 'three hour recording.mp4');
const analysis = await api(`/media/${talkAsset.id}/analysis`);
ok(
  'transcript has real words',
  analysis.segments
    .map((s) => s.text)
    .join(' ')
    .toLowerCase()
    .includes('software architecture'),
  `${analysis.segments.length} segments from ${analysis.segmentProvider?.model}`,
);
ok('not from a mock', analysis.segmentProvider && !analysis.segmentProvider.isMock);
ok('scenes were detected', analysis.scenes.length > 0, `${analysis.scenes.length} scenes`);
const takes = analysis.moments.filter((m) => m.kind === 'repeated_take');
ok('repeated takes were found', takes.length === 2);
await page.getByRole('link', { name: 'Analysis' }).click();
await page.getByRole('heading', { name: /Transcript/ }).waitFor();
await shot('61-demo-analysis');

step(6, 'Open the timeline editor');
await page.getByRole('link', { name: 'Editor' }).click();
await page.getByRole('region', { name: 'Timeline' }).waitFor();
await page.getByRole('button', { name: 'Add three hour recording.mp4 to timeline' }).click();
await saved();
const server = () => api('/timelines/main');
const track = (t, type) => t.tracks.find((x) => x.type === type);
const before = await server();
ok('the footage is on the timeline', track(before, 'VIDEO').clips.length === 1);

step(7, 'Ask the agent');
await page.getByRole('tab', { name: 'Agent' }).click();
await page.getByLabel('Tell the agent what to do').fill(INSTRUCTION);
await page.getByRole('button', { name: 'Ask the agent' }).click();
const card = page.getByTestId('agent-run').first();
await card.getByRole('button', { name: 'Reject' }).waitFor({ timeout: 300_000 });
ok('asking changed nothing yet', (await server()).revision === before.revision);

step(8, 'Show the AI-generated edit plan');
const run = (await api(`/timelines/${before.id}/agent-runs`)).items[0];
console.log(`      plan by ${run.provider.id} ${run.provider.model ?? ''}: ${run.summary}`);
ok('the plan came from a real model', run.provider.id !== 'mock' && !run.provider.isMock);
const asked = [
  'speed_range',
  'remove_repeated_takes',
  'add_broll',
  'normalize_dialogue',
  'generate_shorts',
];
const planned = run.steps.map((s) => s.operation);
for (const operation of asked) ok(`the plan covers ${operation}`, planned.includes(operation));
await shot('62-demo-plan');

step(9, 'Display proposed timeline operations');
const rows = card.getByRole('list', { name: 'Proposed steps' }).getByRole('listitem');
ok('every step is listed for review', (await rows.count()) === run.steps.length);
for (const item of run.steps)
  console.log(`      ${item.operation}: ${item.operationCount} ops. ${item.error ?? item.summary}`);
ok(
  'no requested step failed',
  run.steps.every((s) => s.error === null),
  JSON.stringify(run.steps.filter((s) => s.error).map((s) => s.error)),
);
ok('real operations were compiled', run.ops.length > 0, `${run.ops.length} operations`);
await card.getByRole('button', { name: 'Preview' }).click();
await page.getByText("Previewing the agent's proposal").waitFor();
await shot('63-demo-preview');
ok('previewing stored nothing', (await server()).revision === before.revision);

step(10, 'Apply the changes');
await card.getByRole('button', { name: 'Apply changes' }).click();
await card.getByText('Applied as one edit').waitFor({ timeout: 60_000 });
const applied = await server();
ok('applied as one transaction', applied.revision === before.revision + 1);
const history = (await api(`/timelines/${applied.id}/history`)).items;
ok(
  'attributed to the agent',
  history[0].source === 'ai' && history[0].author.agentRunId === run.id,
);
const versions = (await api(`/timelines/${applied.id}/versions`)).items;
ok('the earlier state was saved first', versions[0].trigger === 'pre_ai');

step(11, 'Visually inspect the updated timeline');
await page.waitForTimeout(500);
await shot('64-demo-applied');
const appliedVideo = track(applied, 'VIDEO').clips;
const domClips = await page.getByTestId('track-VIDEO').getByTestId('clip').count();
ok('the timeline shows the real result', domClips === appliedVideo.length, `${domClips} clips`);
ok('the opening is faster', appliedVideo[0].speed > 1, `${appliedVideo[0].speed}x`);
ok('B-roll is on its track', track(applied, 'BROLL').clips.length > 0);
ok(
  'dialogue is flagged to normalize',
  appliedVideo.every((c) => c.audio.normalize),
);
const { items: timelines } = await api('/timelines');
const shorts = timelines.filter((t) => t.kind === 'short');
ok('three Shorts exist as separate timelines', shorts.length === 3, `${shorts.length}`);
ok(
  'every Short is vertical',
  shorts.every((t) => t.width === 1080 && t.height === 1920),
);

step(12, 'Manually modify an AI-edited clip');
const last = page.getByTestId('track-VIDEO').getByTestId('clip').last();
const box = await last.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width };
});
await page.mouse.move(box.x + Math.min(box.w, 1400) - 2, box.y + 20);
await page.evaluate(() => {
  document.querySelector('[data-testid=timeline-scroller]').scrollLeft = 0;
});
const handle = await last.getByTestId('trim-end').evaluate((el) => {
  el.scrollIntoView({ inline: 'end', block: 'nearest' });
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.move(handle.x, handle.y);
await page.mouse.down();
await page.mouse.move(handle.x - 40, handle.y, { steps: 4 });
await page.mouse.move(handle.x - 80, handle.y, { steps: 4 });
await page.mouse.up();
await saved();
const manual = await server();
const manualHistory = (await api(`/timelines/${manual.id}/history`)).items;
ok(
  'a real drag trimmed the AI clip',
  manual.revision === applied.revision + 1 &&
    track(manual, 'VIDEO').clips.at(-1).duration < appliedVideo.at(-1).duration,
);
ok(
  'that edit is attributed to the person',
  manualHistory[0].source === 'manual' && manualHistory[1].source === 'ai',
);

step(13, 'Undo and redo changes');
await page.keyboard.press('Control+z');
await page.getByTestId('save-state').getByText('Saved').waitFor();
await page.waitForTimeout(500);
let current = await server();
ok(
  'undo removes the manual trim',
  JSON.stringify(current.tracks) === JSON.stringify(applied.tracks),
);
await page.keyboard.press('Control+Shift+z');
await page.waitForTimeout(800);
current = await server();
ok('redo brings it back', JSON.stringify(current.tracks) === JSON.stringify(manual.tracks));
await page.keyboard.press('Control+z');
await page.waitForTimeout(500);
await page.keyboard.press('Control+z');
await page.waitForTimeout(800);
current = await server();
ok(
  'undoing again reverses the whole agent edit in one step',
  JSON.stringify(current.tracks) === JSON.stringify(before.tracks),
);
await page.keyboard.press('Control+Shift+z');
await page.waitForTimeout(800);
current = await server();
ok(
  'and redo reapplies all of it',
  JSON.stringify(current.tracks) === JSON.stringify(applied.tracks),
);

step(14, 'Render the final video');
await page.getByRole('tab', { name: 'Export' }).click();
await page.getByRole('button', { name: 'Export video' }).click();
const job = page.getByTestId('render-job').first();
await job.waitFor();
await shot('65-demo-rendering');
await job.getByRole('link', { name: 'Download video' }).waitFor({ timeout: 400_000 });
await shot('66-demo-rendered');
ok('the render finished', true);

step(15, 'Download the exported result');
const [download] = await Promise.all([
  page.waitForEvent('download'),
  job.getByRole('link', { name: 'Download video' }).click(),
]);
const file = join(dir, 'final.mp4');
await download.saveAs(file);
ok(
  'a real file downloaded',
  statSync(file).size > 10_000,
  `${(statSync(file).size / 1024 / 1024).toFixed(1)} MB`,
);

const final = await server();
const info = JSON.parse(
  execFileSync(FFPROBE, [
    '-v',
    'error',
    '-count_frames',
    '-show_entries',
    'stream=codec_type,codec_name,width,height,nb_read_frames',
    '-of',
    'json',
    file,
  ]).toString(),
);
const video = info.streams.find((s) => s.codec_type === 'video');
ok(
  'H.264 and AAC',
  video.codec_name === 'h264' && info.streams.some((s) => s.codec_name === 'aac'),
);
const end = Math.max(...final.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)));
const frameTicks = (TICKS * final.frameRate.den) / final.frameRate.num;
ok(
  'exactly as long as the timeline',
  Number(video.nb_read_frames) === end / frameTicks,
  `${video.nb_read_frames} frames`,
);

// The real proof: listen to the export.
const flac = join(dir, 'final.flac');
execFileSync(FFMPEG, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  '-i',
  file,
  '-ac',
  '1',
  '-ar',
  '16000',
  '-c:a',
  'flac',
  flac,
]);
execFileSync(
  'whisper-cli',
  ['-m', WHISPER_MODEL, '-f', flac, '-oj', '-of', join(dir, 'final'), '-np'],
  { stdio: 'ignore' },
);
const heard = JSON.parse(readFileSync(join(dir, 'final.json'), 'utf8'))
  .transcription.map((s) => s.text)
  .join(' ')
  .toLowerCase();
const count = (needle) => heard.split(needle).length - 1;
console.log(`      heard: "${heard.trim().slice(0, 300)}…"`);
ok(
  'the repeated "boundaries" line is spoken once',
  count('boundaries between') === 1,
  `${count('boundaries between')} times`,
);
ok(
  'the repeated "mistake" line is spoken once',
  count('mistake i see') === 1,
  `${count('mistake i see')} times`,
);
ok(
  'the rest of the talk survives',
  heard.includes('modular design') && heard.includes('welcome back'),
);

await page.goto(BASE);
await page
  .getByRole('complementary', { name: 'Export history' })
  .getByRole('link', { name: /Download/ })
  .waitFor();
ok('the export is in the history', true);
await shot('67-demo-dashboard');

ok('no uncaught page errors', problems.length === 0, JSON.stringify(problems));
console.log(`\nFinished in ${((Date.now() - started) / 1000).toFixed(0)}s`);
await browser.close();
rmSync(dir, { recursive: true, force: true });
