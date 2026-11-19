// The shortest path through the product: one video dropped on the dashboard, then the editor's layout,
// its keyboard, the transcript and an agent that answers instantly from what it measured.
// Needs `npm run dev`, SPEECH_PROVIDER=whisper and an LLM_PROVIDER, on macOS.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { makeSpeechVideo } from './speech.mjs';

const shots = fileURLToPath(new URL('./screenshots/', import.meta.url));
mkdirSync(shots, { recursive: true });
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

const dir = mkdtempSync(join(tmpdir(), 'ae-start-'));
const landscape = join(dir, 'landscape.mp4');
const vertical = join(dir, 'phone interview.mp4');
makeSpeechVideo(dir, landscape);
execFileSync('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  '-i',
  landscape,
  '-vf',
  'scale=720:1280,setsar=1',
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-c:a',
  'copy',
  vertical,
]);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && /Content Security Policy/.test(m.text())) problems.push(m.text());
});

const ok = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label} ${extra}`);
  if (!cond) process.exitCode = 1;
};
const saved = () => page.getByTestId('save-state').getByText('Saved').waitFor({ timeout: 15_000 });

await page.goto(`${BASE}/register`);
await page.getByLabel('Email').fill(`start+${Date.now()}@example.com`);
await page.getByLabel('Name').fill('Start');
await page.getByLabel('Password').fill('correct horse battery staple');
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByRole('heading', { name: 'Projects' }).waitFor();

// --- One file, straight to editing ---
await page.getByLabel('Start from a video file').setInputFiles(vertical);
await page.waitForURL(/\/projects\/prj_[^/]+\/edit$/, { timeout: 15_000 });
const projectId = page.url().split('/projects/')[1].split('/')[0];
ok('choosing a file opens the editor directly', Boolean(projectId));
const project = await page.evaluate(
  async (url) => (await fetch(url)).json(),
  `/api/v1/projects/${projectId}`,
);
ok('the project is named after the file', project.name === 'phone interview', project.name);
ok(
  'the project takes its shape from the file',
  project.settings.aspectRatio === '9:16' && project.settings.width === 720,
  JSON.stringify(project.settings),
);
const clip = page.getByTestId('track-VIDEO').getByTestId('clip').first();
await clip.waitFor({ timeout: 180_000 });
ok('the footage goes on the timeline by itself', true);
await saved();
const stage = await page.getByTestId('stage').boundingBox();
ok(
  'the preview takes the shape of a vertical timeline',
  Math.abs(stage.width / stage.height - 9 / 16) < 0.01,
  `${stage.width}x${stage.height}`,
);

// --- Layout ---
const size = await page.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  scrollHeight: document.documentElement.scrollHeight,
  width: innerWidth,
  height: innerHeight,
}));
ok(
  'the editor fits the window without scrolling the page',
  size.scrollWidth <= size.width && size.scrollHeight <= size.height,
  JSON.stringify(size),
);
await page.getByTestId('track-MUSIC').waitFor();
for (const type of ['OVERLAYS', 'BROLL', 'VIDEO', 'CAPTIONS', 'AUDIO', 'MUSIC']) {
  const header = await page.locator(`[data-header-track=${type}]`).boundingBox();
  const row = await page.getByTestId(`track-${type}`).boundingBox();
  ok(
    `the ${type} header lines up with its row`,
    Math.abs(header.y - row.y) < 2 && Math.abs(header.height - row.height) < 2,
    `${header.y}/${row.y} ${header.height}/${row.height}`,
  );
}
ok(
  'the agent is showing without being opened',
  await page.getByLabel('Tell the agent what to do').isVisible(),
);
const compose = await page.getByLabel('Tell the agent what to do').boundingBox();
const panel = await page.getByRole('complementary', { name: 'Agent and export' }).boundingBox();
ok(
  'the composer sits at the bottom of the agent panel',
  compose.y + compose.height > panel.y + panel.height - 90,
);

// --- Filmstrip ---
await page.waitForFunction(
  () => document.querySelector('[data-testid=clip] img')?.naturalWidth > 0,
  null,
  { timeout: 120_000 },
);
ok('clips show real frames from the footage', true);
const waveform = await page
  .getByTestId('track-VIDEO')
  .locator('canvas')
  .first()
  .evaluate((canvas) => {
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    return data.some((value) => value !== 0);
  })
  .catch(() => false);
ok('clips show the real waveform', waveform);

// --- Keyboard ---
await page.getByRole('heading', { name: 'Media' }).click();
await page.keyboard.press('Slash');
ok(
  '/ goes to the composer',
  await page
    .waitForFunction(() => document.activeElement?.id === 'agent-instruction', null, {
      timeout: 2000,
    })
    .then(() => true)
    .catch(() => false),
);
await page.keyboard.press('s');
ok(
  'typing in the composer does not trigger shortcuts',
  (await page.getByLabel('Tell the agent what to do').inputValue()) === 's' &&
    (await page.getByTestId('track-VIDEO').getByTestId('clip').count()) === 1,
);
await page.getByLabel('Tell the agent what to do').fill('');
await page.keyboard.press('Escape');
await page.keyboard.press('?');
ok(
  '? lists the shortcuts',
  await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).isVisible(),
);
await page.keyboard.press('Escape');
await page.keyboard.press('End');
await page.keyboard.press('ArrowUp');
const afterJump = await page.getByTestId('timecode').textContent();
await page.keyboard.press('Home');
ok('↑ jumps back to the previous cut', afterJump === '00:00:00:00', afterJump);

// --- Analysis arrives while editing, and the agent offers what it found ---
const chips = page.getByRole('list', { name: 'Suggested edits' });
for (let i = 0; i < 60; i++) {
  await page.reload();
  await page.getByTestId('track-VIDEO').waitFor();
  await page.waitForTimeout(1500);
  if (await chips.getByRole('button', { name: /pause/ }).count()) break;
  await page.waitForTimeout(4000);
}
const pauseChip = chips.getByRole('button', { name: /pause/ });
ok(
  'the agent suggests removing pauses, with a measured total',
  /Remove \d+ pauses? · [\d.]+s/.test(await pauseChip.textContent()),
  await pauseChip.textContent(),
);

// --- Transcript ---
await page.getByRole('tab', { name: 'Transcript' }).click();
const lines = page.getByRole('list', { name: 'Transcript lines' }).getByRole('listitem');
await lines.first().waitFor({ timeout: 30_000 });
ok('the transcript reads the footage', (await lines.count()) > 3, `${await lines.count()} lines`);
await lines.nth(2).getByRole('button').first().click();
const jumped = await page.getByTestId('timecode').textContent();
ok('clicking a line goes to it', jumped !== '00:00:00:00', jumped);
await page.getByRole('searchbox', { name: 'Search the transcript' }).fill('zzzz no such words');
ok('searching filters the lines', await page.getByText('Nothing matches that search.').isVisible());
await page.getByRole('searchbox', { name: 'Search the transcript' }).fill('');

// --- An instruction it fully understands needs no model ---
const started = Date.now();
await pauseChip.click();
const card = page.getByTestId('agent-run').first();
await card.getByRole('button', { name: 'Apply changes' }).waitFor({ timeout: 20_000 });
const seconds = (Date.now() - started) / 1000;
ok(
  'a clear request is answered without waiting on a model',
  seconds < 10,
  `${seconds.toFixed(1)}s`,
);
ok('and it says no model was used', await card.getByText('No model was needed').isVisible());
ok('the proposal states how much shorter the edit gets', await card.getByText(/→/).isVisible());
await page.screenshot({ path: `${shots}start-proposal.png` });
await card.getByRole('button', { name: 'Apply changes' }).click();
await card.getByText('Applied as one edit').waitFor({ timeout: 30_000 });
await page.waitForTimeout(1500);
ok('a suggestion that has been used goes away', (await pauseChip.count()) === 0);
ok(
  'the edit cut the clip into pieces',
  (await page.getByTestId('track-VIDEO').getByTestId('clip').count()) > 1,
);

// --- The selection means something ---
await page.getByRole('tab', { name: 'Media' }).click();
await page
  .getByTestId('track-VIDEO')
  .getByTestId('clip')
  .first()
  .click({ position: { x: 10, y: 40 } });
const clipsBefore = await page.getByTestId('track-VIDEO').getByTestId('clip').count();
await page.getByLabel('Tell the agent what to do').fill('Delete this clip');
await page.getByLabel('Tell the agent what to do').press('Enter');
const third = page.getByTestId('agent-run').first();
await third.getByText('Delete this clip').waitFor();
await third.getByRole('button', { name: 'Apply changes' }).waitFor({ timeout: 20_000 });
await third.getByRole('button', { name: 'Apply changes' }).click();
await third.getByText('Applied as one edit').waitFor({ timeout: 30_000 });
await page.waitForTimeout(800);
ok(
  '"this clip" means the clip selected',
  (await page.getByTestId('track-VIDEO').getByTestId('clip').count()) === clipsBefore - 1,
);
await page.getByRole('button', { name: 'Undo', exact: true }).click();
await saved();

// --- A question gets an answer, and nothing to approve ---
await page.getByLabel('Tell the agent what to do').fill('What is this video about?');
await page.getByLabel('Tell the agent what to do').press('Enter');
const answer = page.getByTestId('agent-run').first();
await answer.getByText('What is this video about?').waitFor();
await answer.getByText(/^Answered by/).waitFor({ timeout: 180_000 });
ok(
  'a question is answered from the footage',
  /architect|service|software/i.test(await answer.innerText()),
);
ok(
  'a question does not ask for approval',
  (await answer.getByRole('button', { name: 'Apply changes' }).count()) === 0,
);
await page.screenshot({ path: `${shots}start-answer.png` });

ok('no uncaught page errors', problems.length === 0, JSON.stringify(problems));
await browser.close();
rmSync(dir, { recursive: true, force: true });
