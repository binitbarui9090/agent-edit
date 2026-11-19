// Drives the timeline editor with real gestures, checking results against the server's copy.
// Needs `npm run infra:up`, `npm run dev` and FFmpeg.
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
const FRAME = TICKS / 30;
const dir = mkdtempSync(join(tmpdir(), 'ae-editor-'));

function make(name, seconds, frequency) {
  const path = join(dir, name);
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1280x720:rate=30:duration=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequency}:duration=${seconds}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-g',
    '15',
    '-c:a',
    'aac',
    '-shortest',
    path,
  ]);
  return path;
}
const talk = make('talk.mp4', 20, 300);
const broll = make('cutaway.mp4', 6, 500);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
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

await page.goto(`${BASE}/register`);
await page.getByLabel('Email').fill(`editor+${Date.now()}@example.com`);
await page.getByLabel('Name').fill('Editor E2E');
await page.getByLabel('Password').fill('correct horse battery staple');
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByRole('heading', { name: 'Projects' }).waitFor();
await page.goto(`${BASE}/projects/new`);
await page.getByLabel('Name', { exact: true }).fill('Editor demo');
await page.getByLabel('Footage (optional)').setInputFiles([talk, broll]);
await page.getByRole('button', { name: 'Create project' }).click();
await page.getByText('Choose files').waitFor();
const projectId = page.url().split('/projects/')[1];
await page
  .getByRole('list', { name: 'Media' })
  .getByText('Ready', { exact: true })
  .nth(1)
  .waitFor({ timeout: 120_000 });

const api = (path, init) =>
  page.evaluate(
    async ([url, options]) => {
      const res = await fetch(url, options);
      return res.json();
    },
    [`/api/v1/projects/${projectId}${path}`, init],
  );
const server = () => api('/timelines/main');
const track = (t, type) => t.tracks.find((x) => x.type === type);
const settled = () =>
  page.getByTestId('save-state').getByText('Saved').waitFor({ timeout: 15_000 });
const clips = () => page.getByTestId('track-VIDEO').getByTestId('clip');
const clipBox = (locator) =>
  locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

async function drag(fromX, fromY, toX, toY) {
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move((fromX + toX) / 2, (fromY + toY) / 2, { steps: 4 });
  await page.mouse.move(toX, toY, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  await settled();
}
const seekTo = async (seconds) => {
  await page
    .locator('[data-testid=ruler]')
    .click({ position: { x: seconds * pxPerSecond + 1, y: 10 } });
};
let pxPerSecond = 40;

// --- Opening the editor ---
await page.getByRole('link', { name: 'Editor' }).click();
await page.getByRole('region', { name: 'Timeline' }).waitFor();
await page.getByTestId('bin-item').nth(1).waitFor();
let timeline = await server();
ok('main timeline exists with six tracks', timeline.tracks.length === 6);

// --- Add clips ---
await page.getByRole('button', { name: 'Add talk.mp4 to timeline' }).click();
await settled();
await clips().first().waitFor();
timeline = await server();
ok('adding footage writes a real clip', track(timeline, 'VIDEO').clips.length === 1);
const added = track(timeline, 'VIDEO').clips[0];
ok(
  'clip spans the probed source',
  Math.abs(added.sourceOut / TICKS - 20) < 0.2,
  `${(added.sourceOut / TICKS).toFixed(2)}s`,
);
await page.waitForFunction(
  () => document.querySelector('[data-testid=track-VIDEO] canvas')?.width > 0,
  null,
  { timeout: 15_000 },
);
ok('waveform is drawn on the clip', true);

// --- Layout: every label beside its own track ---
const alignment = () =>
  page.evaluate(() => {
    const headers = [
      ...document.querySelectorAll('section[aria-label=Timeline] [data-header-track]'),
    ];
    return headers.map((header) => {
      const row = document.querySelector(`[data-testid=track-${header.dataset.headerTrack}]`);
      return Math.abs(header.getBoundingClientRect().top - row.getBoundingClientRect().top);
    });
  });
const offsets = await alignment();
ok(
  'each track header lines up with its row',
  offsets.length === 6 && offsets.every((d) => d <= 1),
  JSON.stringify(offsets),
);
const fit = await page.evaluate(() => {
  const s = document.querySelector('[data-testid=timeline-scroller]');
  return {
    overflow: s.scrollHeight - s.clientHeight,
    bottom: document.querySelector('[data-testid=track-MUSIC]').getBoundingClientRect().bottom,
    height: innerHeight,
  };
});
ok(
  'all six tracks are visible without scrolling',
  fit.overflow <= 0 && fit.bottom <= fit.height,
  JSON.stringify(fit),
);
const previewBox = await page
  .getByTestId('stage')
  .evaluate((el) => el.getBoundingClientRect().height);
ok(
  'the preview uses the space above the timeline',
  previewBox > 350,
  `${Math.round(previewBox)}px`,
);

await shot('30-editor');

// --- Preview follows the timeline ---
const stageVideo = () =>
  page.evaluate(() => {
    const v = [...document.querySelectorAll('[data-testid=stage] video')].find(
      (el) => el.style.visibility === 'visible',
    );
    return v
      ? { time: v.currentTime, ready: v.readyState, width: v.videoWidth, paused: v.paused }
      : null;
  });
await seekTo(5);
await page.waitForFunction(
  () => {
    const v = [...document.querySelectorAll('[data-testid=stage] video')].find(
      (el) => el.style.visibility === 'visible',
    );
    return v && v.readyState >= 2 && !v.seeking && Math.abs(v.currentTime - 5) < 0.1;
  },
  null,
  { timeout: 15_000 },
);
ok('seeking shows the matching source frame', true, `${(await stageVideo()).time.toFixed(2)}s`);
const timecode = await page.getByTestId('timecode').textContent();
ok(
  'timecode follows the playhead',
  timecode.startsWith('00:00:05:') || timecode.startsWith('00:00:04:'),
  timecode,
);

await page.keyboard.press('Space');
await page.waitForFunction(
  () => {
    const v = [...document.querySelectorAll('[data-testid=stage] video')].find(
      (el) => el.style.visibility === 'visible',
    );
    return v && !v.paused && v.currentTime > 5.5;
  },
  null,
  { timeout: 15_000 },
);
ok('Space plays, and the picture advances', true);
await page.keyboard.press('Space');
await page.waitForTimeout(100);
const paused = await stageVideo();
ok('Space pauses', paused.paused);

// --- Split ---
await seekTo(10);
await page
  .getByRole('button', { name: /talk\.mp4/ })
  .first()
  .click({ position: { x: 3, y: 30 } })
  .catch(() => {});
await page.keyboard.press('s');
await settled();
timeline = await server();
let video = track(timeline, 'VIDEO').clips;
ok('S splits at the playhead', video.length === 2, `${video.length} clips`);
ok('split keeps source continuity', video[0].sourceOut === video[1].sourceIn);
ok('split lands on the frame grid', video[1].start % FRAME === 0);

// --- Trim ---
await page.reload();
await clips().nth(1).waitFor();
ok('edits persist across reload', (await clips().count()) === 2);
const beforeTrim = await clipBox(clips().nth(1));
const right = clips().nth(1).getByTestId('trim-end');
await right.evaluate((el) => (el.style.background = ''));
await drag(
  beforeTrim.x + beforeTrim.w - 2,
  beforeTrim.y + 20,
  beforeTrim.x + beforeTrim.w - 2 - 120,
  beforeTrim.y + 20,
);
timeline = await server();
video = track(timeline, 'VIDEO').clips;
ok(
  'dragging the tail trims the clip',
  Math.abs(video[1].duration / TICKS - 7) < 0.2,
  `${(video[1].duration / TICKS).toFixed(2)}s`,
);
ok('trim moves the source out point', video[1].sourceOut - video[1].sourceIn === video[1].duration);

const headBox = await clipBox(clips().nth(1));
await drag(headBox.x + 2, headBox.y + 20, headBox.x + 2 + 80, headBox.y + 20);
timeline = await server();
video = track(timeline, 'VIDEO').clips;
ok(
  'dragging the head trims and shifts source in',
  Math.abs(video[1].sourceIn / TICKS - 12) < 0.2,
  `${(video[1].sourceIn / TICKS).toFixed(2)}s`,
);

// The preview must now show the trimmed footage, not the original position.
const trimmedStart = video[1].start / TICKS;
const trimmedSource = video[1].sourceIn / TICKS;
await seekTo(trimmedStart + 1);
await page.waitForFunction(
  (expected) => {
    const v = [...document.querySelectorAll('[data-testid=stage] video')].find(
      (el) => el.style.visibility === 'visible',
    );
    return v && !v.seeking && Math.abs(v.currentTime - expected) < 0.2;
  },
  trimmedSource + 1,
  { timeout: 15_000 },
);
ok('preview reflects the trim', true, `plays source at ${(trimmedSource + 1).toFixed(1)}s`);

// --- Move with snapping ---
const moveBox = await clipBox(clips().nth(1));
const firstEnd = (await clipBox(clips().first())).x + (await clipBox(clips().first())).w;
await drag(
  moveBox.x + moveBox.w / 2,
  moveBox.y + 20,
  moveBox.x + moveBox.w / 2 + 200,
  moveBox.y + 20,
);
timeline = await server();
video = track(timeline, 'VIDEO').clips;
const movedStart = video[1].start;
ok(
  'dragging moves the clip',
  movedStart / TICKS > trimmedStart + 3,
  `${(movedStart / TICKS).toFixed(2)}s`,
);
const movedBox = await clipBox(clips().nth(1));
await drag(movedBox.x + 20, movedBox.y + 20, firstEnd + 25, movedBox.y + 20);
timeline = await server();
video = track(timeline, 'VIDEO').clips;
ok(
  'dragging near an edge snaps to it exactly',
  video[1].start === video[0].start + video[0].duration,
);

const overlapBox = await clipBox(clips().nth(1));
await drag(overlapBox.x + 20, overlapBox.y + 20, overlapBox.x - 150, overlapBox.y + 20);
const afterOverlap = await server();
ok('a move that would overlap is refused', afterOverlap.revision === timeline.revision);

// --- Move across tracks ---
const brollRow = await clipBox(page.getByTestId('track-BROLL'));
const crossBox = await clipBox(clips().nth(1));
await drag(crossBox.x + 30, crossBox.y + 20, crossBox.x + 30, brollRow.y + 20);
timeline = await server();
ok(
  'dragging to another row changes track',
  track(timeline, 'BROLL').clips.length === 1 && track(timeline, 'VIDEO').clips.length === 1,
);

const captionRow = await clipBox(page.getByTestId('track-CAPTIONS'));
const incompatible = await clipBox(page.getByTestId('track-BROLL').getByTestId('clip'));
const revisionBefore = timeline.revision;
await drag(incompatible.x + 30, incompatible.y + 20, incompatible.x + 30, captionRow.y + 20);
timeline = await server();
ok('footage cannot be dragged onto the captions track', timeline.revision === revisionBefore);

// --- Drag and drop from the bin ---
const musicRow = await clipBox(page.getByTestId('track-MUSIC'));
// Picking a clip brings up its properties, so Media has to be asked for again.
await page.getByRole('tab', { name: 'Media' }).click();
await page
  .getByTestId('bin-item')
  .filter({ hasText: 'cutaway.mp4' })
  .dragTo(page.getByTestId('track-MUSIC'), {
    targetPosition: { x: 200, y: 20 },
  });
await settled();
timeline = await server();
ok('dragging from the bin creates a clip', track(timeline, 'MUSIC').clips.length === 1);
void musicRow;

// --- Inspector ---
await page
  .getByTestId('track-MUSIC')
  .getByTestId('clip')
  .click({ position: { x: 20, y: 20 } });
await page.getByRole('region', { name: 'Timeline' }).waitFor();
const volume = page.getByLabel(/^Volume/);
await volume.fill('0.3');
await volume.blur();
await settled();
timeline = await server();
ok('inspector changes write through', track(timeline, 'MUSIC').clips[0].volume === 0.3);
await page.getByLabel('Normalize loudness').check();
await settled();
timeline = await server();
ok(
  'normalize flag is stored on the clip',
  track(timeline, 'MUSIC').clips[0].audio.normalize === true,
);
await shot('31-inspector');

// --- Track volume ---
const musicVolume = page.getByLabel('Music volume');
await musicVolume.fill('0.5');
await musicVolume.blur();
await settled();
timeline = await server();
ok('the track volume control writes through', track(timeline, 'MUSIC').volume === 0.5);

// --- Captions ---
await seekTo(1);
await page.getByRole('button', { name: 'Add caption' }).click();
await settled();
await page.getByLabel('Text').fill('Hello <b>world</b>');
await page.getByLabel('Text').blur();
await settled();
timeline = await server();
ok('caption text is editable', track(timeline, 'CAPTIONS').clips[0].text === 'Hello <b>world</b>');
await seekTo(2);
const layer = page.getByTestId('caption-layer');
await layer.getByText('Hello <b>world</b>').waitFor();
ok('caption shows in the preview as text, never markup', (await layer.locator('b').count()) === 0);
await page.getByLabel('Position').selectOption('top');
await settled();
timeline = await server();
ok('caption style is stored', track(timeline, 'CAPTIONS').clips[0].style.position === 'top');
await shot('32-caption');

// --- Multi-select and delete ---
await page.keyboard.press('Escape');
await page.keyboard.press('Control+a');
await page.waitForTimeout(100);
const selectedCount = await page.locator('[data-testid=clip][data-selected=true]').count();
ok('select all selects every clip', selectedCount === 4, `${selectedCount}`);
await page.keyboard.press('Delete');
await settled();
timeline = await server();
ok(
  'delete removes the whole selection',
  timeline.tracks.every((t) => t.clips.length === 0),
);
const playheadAtZero = await page
  .getByTestId('playhead')
  .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41);
ok(
  'playhead follows the clock when the timeline empties',
  playheadAtZero === 0 && (await page.getByTestId('timecode').textContent()) === '00:00:00:00',
  `x=${playheadAtZero}`,
);

// --- Undo and redo ---
const removedRevision = timeline.revision;
await page.keyboard.press('Control+z');
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid=clip]').length === 4,
  null,
  { timeout: 10_000 },
);
timeline = await server();
ok(
  'undo restores the batch as one step',
  timeline.tracks.flatMap((t) => t.clips).length === 4 && timeline.revision === removedRevision + 1,
);
await page.keyboard.press('Control+Shift+z');
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid=clip]').length === 0,
  null,
  { timeout: 10_000 },
);
ok(
  'redo reapplies it',
  (await server()).tracks.every((t) => t.clips.length === 0),
);
await page.keyboard.press('Control+z');
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid=clip]').length === 4,
  null,
  { timeout: 10_000 },
);

// --- Versions and history ---
await page.getByRole('tab', { name: 'History' }).click();
await page.getByLabel('Save current state as').fill('Rough cut');
await page.getByRole('button', { name: 'Save version' }).click();
await page.getByRole('list', { name: 'Versions' }).getByText('Rough cut').waitFor();
ok('a version can be saved', true);
await page.keyboard.press('Control+a');
await page.keyboard.press('Delete');
await settled();
await page.getByRole('button', { name: 'Restore Rough cut' }).click();
await page.getByRole('button', { name: 'Confirm restore Rough cut' }).click();
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid=clip]').length === 4,
  null,
  { timeout: 10_000 },
);
timeline = await server();
ok('restoring brings the version back', timeline.tracks.flatMap((t) => t.clips).length === 4);
const history = await page.getByRole('list', { name: 'Edit history' }).textContent();
ok(
  'history attributes the restore and earlier edits',
  /Restore/.test(history) && /You/.test(history),
);
await shot('33-history');

// --- Offline edits queue and land ---
await page.getByRole('tab', { name: 'Inspector' }).click();
await page
  .getByTestId('track-MUSIC')
  .getByTestId('clip')
  .click({ position: { x: 20, y: 20 } });
const offlineRevision = (await server()).revision;
await ctx.setOffline(true);
await page.getByLabel(/^Volume/).fill('0.7');
await page.getByLabel(/^Volume/).blur();
await page.getByTestId('save-state').getByText('Offline').waitFor({ timeout: 15_000 });
ok('an edit made offline is kept and flagged', true);
await ctx.setOffline(false);
await settled();
timeline = await server();
ok(
  'it lands exactly once on reconnect',
  track(timeline, 'MUSIC').clips[0].volume === 0.7 && timeline.revision === offlineRevision + 1,
);

// --- A second tab sees changes ---
const other = await ctx.newPage();
await other.goto(`${BASE}/projects/${projectId}/edit`);
await other.getByTestId('track-VIDEO').getByTestId('clip').first().waitFor();
const otherBefore = await other.getByTestId('clip').count();
await page.keyboard.press('Escape');
await page
  .getByTestId('track-MUSIC')
  .getByTestId('clip')
  .click({ position: { x: 20, y: 20 } });
await page.keyboard.press('Delete');
await settled();
await other.waitForFunction(
  (before) => document.querySelectorAll('[data-testid=clip]').length === before - 1,
  otherBefore,
  { timeout: 10_000 },
);
ok('another open tab updates live', true);
await other.close();

// --- Scale: 500 clips, real rendering cost ---
timeline = await server();
const talkId = track(timeline, 'VIDEO').clips[0].sourceMediaId;
const ops = [];
for (let i = 0; i < 500; i++) {
  const seconds = 2;
  const start = (i + 2) * seconds * TICKS + 30 * TICKS;
  ops.push({
    op: 'add_clip',
    trackId: track(timeline, 'BROLL').id,
    clip: {
      id: `clip_${String(i).padStart(22, '0').replace(/[ilo]/g, '0')}`,
      kind: 'media',
      sourceMediaId: talkId,
      sourceIn: 0,
      sourceOut: seconds * TICKS,
      start,
      duration: seconds * TICKS,
      speed: 1,
      volume: 1,
      enabled: true,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      audio: { normalize: false, denoise: false, fadeIn: 0, fadeOut: 0 },
      transitionIn: null,
      transitionOut: null,
    },
  });
}
const committed = await api(`/timelines/${timeline.id}/transactions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    baseRevision: timeline.revision,
    idempotencyKey: crypto.randomUUID(),
    ops,
    summary: 'Load test',
  }),
});
ok(
  'a 500-clip plan commits',
  committed.timeline?.tracks.find((t) => t.type === 'BROLL').clips.length >= 500,
  committed.error?.message ?? '',
);
await page.reload();
await page.getByTestId('track-VIDEO').getByTestId('clip').first().waitFor();
const domClips = await page.getByTestId('clip').count();
ok('only visible clips are mounted', domClips < 120, `${domClips} of 500+ in the DOM`);

await page.setViewportSize({ width: 1280, height: 620 });
await page.waitForTimeout(100);
await page.evaluate(() => {
  document.querySelector('[data-testid=timeline-scroller]').scrollTop = 60;
});
await page.waitForTimeout(100);
const shortOffsets = await alignment();
ok(
  'headers stay aligned when a short window scrolls the rows',
  shortOffsets.every((d) => d <= 1),
  JSON.stringify(shortOffsets),
);
await page.setViewportSize({ width: 1600, height: 950 });

const frames = await page.evaluate(async () => {
  const scroller = document.querySelector('[data-testid=timeline-scroller]');
  const times = [];
  let last = performance.now();
  for (let i = 0; i < 180; i++) {
    await new Promise(requestAnimationFrame);
    const now = performance.now();
    times.push(now - last);
    last = now;
    scroller.scrollLeft += 60;
  }
  times.sort((a, b) => a - b);
  return { p50: times[90], p95: times[171], worst: times[179] };
});
ok(
  'scrolling a 500-clip timeline stays smooth',
  frames.p95 < 34,
  `p50 ${frames.p50.toFixed(1)}ms, p95 ${frames.p95.toFixed(1)}ms, worst ${frames.worst.toFixed(0)}ms`,
);
await shot('34-many-clips');

const editStart = Date.now();
await page.evaluate(() => {
  document.querySelector('[data-testid=timeline-scroller]').scrollLeft = 0;
});
await page.waitForTimeout(100);
await page
  .getByTestId('track-VIDEO')
  .getByTestId('clip')
  .first()
  .click({ position: { x: 20, y: 20 } });
await page.getByLabel(/^Volume/).fill('0.9');
await page.getByLabel(/^Volume/).blur();
await settled();
ok(
  'editing stays quick at this size',
  Date.now() - editStart < 2500,
  `${Date.now() - editStart} ms`,
);

ok('no uncaught page errors', problems.length === 0, JSON.stringify(problems));
await browser.close();
rmSync(dir, { recursive: true, force: true });
