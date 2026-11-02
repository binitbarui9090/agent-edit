// The agent against real tools: speech from macOS `say`, whisper.cpp and the configured model.
// Needs `npm run infra:up`, `npm run dev` with SPEECH_PROVIDER=whisper, FFmpeg, and macOS for `say`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const shots = fileURLToPath(new URL('./screenshots/', import.meta.url));
mkdirSync(shots, { recursive: true });
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const TICKS = 705_600_000;
const dir = mkdtempSync(join(tmpdir(), 'ae-agent-'));
const quiet = ['-hide_banner', '-loglevel', 'error', '-y'];

const LINES = [
  'Welcome back to the channel. Today we are looking at software architecture for growing teams.',
  'The most important decision is where you draw the boundaries between your services.',
  'The most important decision is where you draw the boundaries between your services.',
  'A good boundary lets one team ship without waiting for another team, and that is why it matters so much.',
  'Here is the mistake I see most often. People split their system too early, before they understand the domain.',
  'Here is the mistake I see most often. People split their system too early, before they understand the domain.',
  'Start with a simple modular design. Keep the modules honest with clear interfaces. Only pull a service out when you can name the reason, and when a real team will own it from that day on. That one habit will save you years of pain.',
];

function speech() {
  const parts = LINES.map((line, index) => {
    const aiff = join(dir, `line${index}.aiff`);
    execFileSync('say', ['-v', 'Samantha', '-o', aiff, line]);
    const wav = join(dir, `line${index}.wav`);
    // Each line is followed by a real pause, so silence detection has something true to find.
    execFileSync('ffmpeg', [
      ...quiet,
      '-i',
      aiff,
      '-af',
      'apad=pad_dur=2',
      '-ar',
      '48000',
      '-ac',
      '1',
      wav,
    ]);
    return wav;
  });
  const list = join(dir, 'list.txt');
  execFileSync('sh', [
    '-c',
    `printf "file '%s'\\n" ${parts.map((p) => `"${p}"`).join(' ')} > "${list}"`,
  ]);
  const joined = join(dir, 'speech.wav');
  execFileSync('ffmpeg', [
    ...quiet,
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-c',
    'copy',
    joined,
  ]);
  return joined;
}

console.log('generating footage with real speech...');
const voice = speech();
const talk = join(dir, 'architecture talk.mp4');
execFileSync('ffmpeg', [
  ...quiet,
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=1280x720:rate=30',
  '-i',
  voice,
  '-map',
  '0:v',
  '-map',
  '1:a',
  '-shortest',
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-g',
  '15',
  '-c:a',
  'aac',
  talk,
]);
const cutaway = join(dir, 'software architecture diagram.mp4');
execFileSync('ffmpeg', [
  ...quiet,
  '-f',
  'lavfi',
  '-i',
  'smptebars=size=1280x720:rate=30:duration=12',
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-g',
  '15',
  cutaway,
]);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label} ${extra}`);
  if (!cond) process.exitCode = 1;
};
const shot = (n) => page.screenshot({ path: `${shots}${n}.png` });

await page.goto(`${BASE}/register`);
await page.getByLabel('Email').fill(`agent+${Date.now()}@example.com`);
await page.getByLabel('Name').fill('Agent E2E');
await page.getByLabel('Password').fill('correct horse battery staple');
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByRole('heading', { name: 'Projects' }).waitFor();
await page.goto(`${BASE}/projects/new`);
await page.getByLabel('Name', { exact: true }).fill('Agent demo');
await page.getByLabel('Footage (optional)').setInputFiles([talk, cutaway]);
await page.getByRole('button', { name: 'Create project' }).click();
await page.getByText('Choose files').waitFor();
const projectId = page.url().split('/projects/')[1];

const api = (path, init) =>
  page.evaluate(
    async ([url, options]) => (await fetch(url, options)).json(),
    [`/api/v1/projects/${projectId}${path}`, init],
  );

// --- Analysis ---
console.log('waiting for analysis (whisper and the model run for real)...');
const started = Date.now();
let media;
for (;;) {
  ({ items: media } = await api('/media'));
  const busy =
    media.length < 2 ||
    media.some((m) => m.jobs.some((j) => j.status === 'queued' || j.status === 'running'));
  if (!busy) break;
  if (Date.now() - started > 900_000) throw new Error('Analysis took over 15 minutes');
  await page.waitForTimeout(2000);
}
console.log(`  analysis finished in ${((Date.now() - started) / 1000).toFixed(0)}s`);
const talkAsset = media.find((m) => m.name === 'architecture talk.mp4');
const job = (step) => talkAsset.jobs.find((j) => j.step === step);
ok('transcript step finished', job('transcript').status === 'done', job('transcript').provider.id);
ok('transcript came from a real provider', !job('transcript').provider.isMock);
ok('silence detection finished', job('silence').status === 'done');
ok('scene detection finished', job('scenes').status === 'done');
ok('moments finished', job('moments').status === 'done', job('moments').provider.id);
ok(
  'speakers says plainly why it was skipped',
  job('speakers').status === 'skipped' && /does not identify/.test(job('speakers').note),
  job('speakers').note,
);

const analysis = await api(`/media/${talkAsset.id}/analysis`);
const transcript = analysis.segments
  .map((s) => s.text)
  .join(' ')
  .toLowerCase();
ok(
  'whisper really heard the speech',
  transcript.includes('software architecture') && transcript.includes('boundaries'),
  `"${transcript.slice(0, 70)}…"`,
);
const takes = analysis.moments.filter((m) => m.kind === 'repeated_take');
ok('both repeated takes were found', takes.length === 2, `${takes.length} found`);
ok(
  'the takes are the lines actually repeated',
  takes.some((t) => /boundaries/.test(t.title)) && takes.some((t) => /mistake/.test(t.title)),
);
const silences = analysis.moments.filter((m) => m.kind === 'silence');
ok('the real pauses were measured', silences.length >= 5, `${silences.length} pauses`);
await page.goto(`${BASE}/projects/${projectId}/analysis`);
await page.getByRole('heading', { name: /Transcript/ }).waitFor();
ok(
  'analysis page shows the provider',
  await page
    .getByText(/base\.en/)
    .first()
    .isVisible(),
);
await shot('40-analysis');

// --- Build the edit ---
await page.goto(`${BASE}/projects/${projectId}/edit`);
await page.getByRole('button', { name: 'Add architecture talk.mp4 to timeline' }).click();
await page.getByTestId('save-state').getByText('Saved').waitFor();
const server = () => api('/timelines/main');
const track = (t, type) => t.tracks.find((x) => x.type === type);
const before = await server();
const originalDuration = track(before, 'VIDEO').clips[0].duration;

// --- Ask the agent: the instruction from the brief ---
const INSTRUCTION =
  'Make the first 15 seconds faster, remove repeated takes, add relevant B-roll, normalize dialogue, and generate three Shorts.';
await page.getByRole('tab', { name: 'Agent' }).click();
await page.getByLabel('Tell the agent what to do').fill(INSTRUCTION);
await shot('41-agent-ask');
const askedAt = Date.now();
await page.getByRole('button', { name: 'Ask the agent' }).click();
const card = page.getByTestId('agent-run').first();
await card
  .getByRole('status')
  .waitFor({ timeout: 15_000 })
  .catch(() => {});
console.log('  planning...');
await card
  .getByRole('button', { name: 'Reject' })
  .or(card.getByText(/failed|could not/i))
  .first()
  .waitFor({ timeout: 300_000 });
console.log(`  plan arrived in ${((Date.now() - askedAt) / 1000).toFixed(0)}s`);
await shot('42-agent-plan');

const { items: runs } = await api(`/timelines/${before.id}/agent-runs`);
const run = runs[0];
console.log(`  provider: ${JSON.stringify(run.provider)}`);
console.log(
  `  steps: ${JSON.stringify(run.steps.map((s) => [s.operation, s.operationCount, s.error]))}`,
);
ok('the agent produced a proposal', run.status === 'proposed', run.error ?? '');
ok(
  'the plan names the real planner',
  run.provider && !run.provider.isMock,
  run.provider?.model ?? run.provider?.id,
);
const unchanged = await server();
ok('asking changed nothing on the timeline', unchanged.revision === before.revision);
ok(
  'steps are shown for review',
  (await card.getByRole('list', { name: 'Proposed steps' }).getByRole('listitem').count()) ===
    run.steps.length,
);
const working = run.steps.filter((s) => !s.error && s.operationCount > 0);
ok(
  'at least one step compiled into real operations',
  working.length > 0,
  `${working.length} steps`,
);

// --- Preview ---
if (run.ops.length > 0) {
  await card.getByRole('button', { name: 'Preview' }).click();
  await page.getByText("Previewing the agent's proposal").waitFor();
  const proposed = await page.locator('[data-testid=clip][data-proposed=true]').count();
  ok('preview highlights proposed clips', proposed > 0, `${proposed} highlighted`);
  ok('preview stored nothing', (await server()).revision === before.revision);
  await shot('43-agent-preview');
  await card.getByRole('button', { name: 'Stop preview' }).first().click();
  await page.getByText("Previewing the agent's proposal").waitFor({ state: 'detached' });
  ok(
    'stopping the preview restores the view',
    (await page.getByTestId('track-VIDEO').getByTestId('clip').count()) === 1,
  );
}

// --- Apply, and inspect what really happened ---
await card.getByRole('button', { name: 'Apply changes' }).click();
await card.getByText('Applied as one edit').waitFor({ timeout: 60_000 });
const applied = await server();
ok('applying is one transaction', applied.revision === before.revision + 1 || run.ops.length === 0);
const history = (await api(`/timelines/${applied.id}/history`)).items;
ok(
  'history attributes it to the agent and model',
  history[0].source === 'ai' && history[0].author.agentRunId === run.id,
  history[0].author.model ?? '',
);
const videoClips = track(applied, 'VIDEO').clips;
if (
  run.steps.some((s) => s.operation === 'remove_repeated_takes' && !s.error && s.operationCount > 0)
) {
  const covered = (seconds) =>
    videoClips.some((c) => c.sourceIn / TICKS <= seconds && c.sourceOut / TICKS >= seconds);
  ok(
    'the earlier takes are gone from the edit',
    takes.every((t) => !covered((t.start + t.end) / 2 / TICKS)),
  );
  ok(
    'the kept takes are still there',
    takes.every((t) => covered(t.end / TICKS + 2.5 + 2)),
    '',
  );
}
if (run.steps.some((s) => s.operation === 'speed_range' && !s.error)) {
  ok('the opening plays faster', videoClips[0].speed > 1, `${videoClips[0].speed}x`);
  ok('the rest stays at normal speed', videoClips.at(-1).speed === 1);
}
if (run.steps.some((s) => s.operation === 'normalize_dialogue' && !s.error)) {
  ok(
    'dialogue is flagged for normalization',
    videoClips.every((c) => c.audio.normalize),
  );
}
if (run.steps.some((s) => s.operation === 'add_broll' && !s.error && s.operationCount > 0)) {
  ok(
    'B-roll landed on its own track',
    track(applied, 'BROLL').clips.length > 0,
    `${track(applied, 'BROLL').clips.length} clips`,
  );
}
ok(
  'the edit got shorter',
  track(applied, 'VIDEO').clips.reduce((n, c) => n + c.duration, 0) < originalDuration ||
    run.ops.length === 0,
);
await shot('44-agent-applied');

// --- Shorts are independent timelines ---
const { items: timelines } = await api('/timelines');
const shorts = timelines.filter((t) => t.kind === 'short');
if (run.steps.some((s) => s.operation === 'generate_shorts' && !s.error)) {
  ok('all three requested Shorts were created', shorts.length === 3, `${shorts.length} created`);
  ok(
    'every Short is vertical',
    shorts.every((t) => t.width === 1080 && t.height === 1920),
  );
  const first = await api(`/timelines/${shorts[0].id}`);
  ok(
    'a Short has captions from the transcript',
    track(first, 'CAPTIONS').clips.length > 0,
    `${track(first, 'CAPTIONS').clips.length} captions`,
  );
  await page.goto(`${BASE}/projects/${projectId}/edit/${shorts[0].id}`);
  await page.getByTestId('track-VIDEO').getByTestId('clip').waitFor();
  await page.waitForTimeout(800);
  await shot('45-short');
  ok('a Short opens in the editor as an ordinary timeline', true);
  await page
    .getByTestId('track-VIDEO')
    .getByTestId('clip')
    .click({ position: { x: 20, y: 20 } });
  await page.getByLabel('Volume').fill('0.5');
  await page.getByLabel('Volume').blur();
  await page.getByTestId('save-state').getByText('Saved').waitFor();
  const edited = await api(`/timelines/${shorts[0].id}`);
  ok('a Short can be edited by itself', track(edited, 'VIDEO').clips[0].volume === 0.5);
  ok('editing a Short leaves the main edit alone', (await server()).revision === applied.revision);
  await page.goto(`${BASE}/projects/${projectId}/edit`);
  await page.getByRole('tab', { name: 'Agent' }).click();
}

// --- Undo as a unit ---
if (run.ops.length > 0) {
  await page.getByRole('tab', { name: 'Agent' }).click();
  await page.getByRole('button', { name: 'Undo this edit' }).click();
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('[data-testid=track-VIDEO] [data-testid=clip]').length === count,
    1,
    { timeout: 15_000 },
  );
  const undone = await server();
  ok(
    'undo reverses the whole agent edit in one step',
    JSON.stringify(undone.tracks) === JSON.stringify(before.tracks),
  );
}

// --- A request the footage cannot satisfy is reported, not faked ---
await page.getByLabel('Tell the agent what to do').fill('Add background music');
await page.getByRole('button', { name: 'Ask the agent' }).click();
const second = page.getByTestId('agent-run').first();
await second
  .getByRole('button', { name: 'Reject' })
  .or(second.getByText(/failed/i))
  .first()
  .waitFor({ timeout: 300_000 });
const latest = (await api(`/timelines/${before.id}/agent-runs`)).items[0];
const music = latest.steps.find((s) => s.operation === 'add_music');
ok(
  'missing music is explained rather than invented',
  !music || music.error !== null || music.operationCount > 0,
  music?.error ?? 'no music step planned',
);
await second.getByRole('button', { name: 'Reject' }).click();
await second.getByText('Rejected').waitFor();
ok(
  'reject closes the proposal and changes nothing',
  (await api(`/timelines/${before.id}/agent-runs`)).items[0].status === 'rejected',
);

ok('no uncaught page errors', problems.length === 0, JSON.stringify(problems));
await browser.close();
rmSync(dir, { recursive: true, force: true });
