import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId, secondsToTicks, snapToFrame, ticksToSeconds } from '@agent-edit/shared';
import {
  applyOperations,
  captionsToSrt,
  createCaptionClip,
  createDefaultTracks,
  createMediaClip,
  timelineDuration,
} from '@agent-edit/timeline-engine';
import type { TimelineOperation, TimelineState } from '@agent-edit/validation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeFile } from './probe.js';
import { hasFilter, measureLoudness, renderTimeline } from './render-run.js';
import {
  buildAssSubtitles,
  buildChunkCommand,
  escapeAssText,
  normalizationGain,
  planRenderChunks,
  type RenderSource,
} from './render.js';

const FULL = '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
const FFMPEG = process.env.FFMPEG_PATH ?? (existsSync(FULL) ? FULL : 'ffmpeg');
const FFPROBE = process.env.FFPROBE_PATH ?? FFMPEG.replace(/ffmpeg$/, 'ffprobe');
const rate = { num: 30, den: 1 };
const s = (seconds: number) => snapToFrame(secondsToTicks(seconds), rate);

let dir: string;
const sources = new Map<string, RenderSource>();
const ids: Record<string, string> = {};

/** Footage that says what it is: each file is one solid colour and one pure tone, so output is checkable. */
function makeSource(name: string, color: string, hz: number, seconds = 30, gain = 0.3) {
  const path = join(dir, `${name}.mp4`);
  execFileSync(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=640x360:r=30:d=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${hz}:sample_rate=48000:duration=${seconds},volume=${gain}`,
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
  const id = newId('med');
  ids[name] = id;
  sources.set(id, { path, hasAudio: true });
  return id;
}

/** A source whose colour changes every second, so a wrong frame is visible as a wrong colour. */
function makeCountingSource() {
  const path = join(dir, 'counting.mp4');
  const stripes = ['red', 'lime', 'blue', 'yellow', 'cyan', 'magenta', 'white', 'gray'];
  const inputs = stripes.flatMap((color) => [
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=640x360:r=30:d=1`,
  ]);
  const filter = `${stripes.map((_c, i) => `[${i}:v]`).join('')}concat=n=${stripes.length}:v=1[v]`;
  execFileSync(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...inputs,
    '-filter_complex',
    filter,
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-g',
    '5',
    '-pix_fmt',
    'yuv420p',
    path,
  ]);
  const id = newId('med');
  ids.counting = id;
  sources.set(id, { path, hasAudio: false });
  return id;
}

const COLORS: Record<string, [number, number, number]> = {
  red: [254, 0, 0],
  lime: [0, 255, 1],
  blue: [0, 0, 254],
  yellow: [255, 255, 0],
  cyan: [0, 255, 255],
  magenta: [254, 0, 255],
  white: [255, 255, 255],
  gray: [128, 128, 128],
  black: [0, 0, 0],
};

function pixel(file: string, seconds: number, x = 320, y = 180): [number, number, number] {
  const raw = execFileSync(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    seconds.toFixed(3),
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
  return [raw[0]!, raw[1]!, raw[2]!];
}

function expectColor(file: string, seconds: number, name: string, x?: number, y?: number) {
  const actual = pixel(file, seconds, x, y);
  const expected = COLORS[name]!;
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(actual[i]! - expected[i]!), `${name} at ${seconds}s: ${actual}`).toBeLessThan(
      40,
    );
  }
}

/** Mean loudness of a window, in dB. */
function loudness(file: string, from: number, length: number): number {
  const stderr = execFileSync(
    'sh',
    [
      '-c',
      `"${FFMPEG}" -hide_banner -ss ${from} -t ${length} -i "${file}" -af volumedetect -vn -f null - 2>&1`,
    ],
    { encoding: 'utf8' },
  );
  const match = /mean_volume: (-?[\d.]+) dB/.exec(stderr);
  return match ? Number(match[1]) : Number.NEGATIVE_INFINITY;
}

function dominantHz(file: string, from: number, length: number): number {
  // Counting zero crossings is plenty for a pure tone.
  const raw = execFileSync(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(from),
      '-t',
      String(length),
      '-i',
      file,
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      's16le',
      '-',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  let crossings = 0;
  let previous = 0;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const sample = raw.readInt16LE(i);
    if (previous < 0 && sample >= 0) crossings++;
    previous = sample;
  }
  return crossings / length;
}

function blank(): TimelineState {
  return { frameRate: rate, width: 640, height: 360, tracks: createDefaultTracks() };
}

const trackId = (state: TimelineState, type: string) =>
  state.tracks.find((t) => t.type === type)!.id;

function build(ops: (state: TimelineState) => TimelineOperation[], base = blank()): TimelineState {
  return applyOperations(base, ops(base)).state;
}

const media = (
  name: string,
  start: number,
  sourceIn: number,
  length: number,
  extra: object = {},
) => ({
  ...createMediaClip(
    {
      sourceMediaId: ids[name]!,
      start: s(start),
      sourceIn: s(sourceIn),
      sourceOut: s(sourceIn + length),
    },
    rate,
  ),
  ...extra,
});

async function render(
  name: string,
  state: TimelineState,
  over: Partial<Parameters<typeof renderTimeline>[0]> = {},
) {
  const workDir = join(dir, `work-${name}`);
  mkdirSync(workDir, { recursive: true });
  const output = join(dir, `${name}.out.mp4`);
  await renderTimeline({
    ffmpeg: FFMPEG,
    state,
    sources,
    width: state.width,
    height: state.height,
    burnCaptions: true,
    workDir,
    output,
    crf: 18,
    ...over,
  });
  return output;
}

function frameCount(file: string): number {
  return Number(
    execFileSync(FFPROBE, [
      '-v',
      'error',
      '-count_frames',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=nb_read_frames',
      '-of',
      'csv=p=0',
      file,
    ])
      .toString()
      .trim()
      .replace(/,$/, ''),
  );
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ae-render-'));
  makeSource('red', 'red', 300);
  makeSource('blue', 'blue', 600);
  makeSource('lime', 'lime', 1200);
  makeCountingSource();
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('picture', () => {
  it('plays clips in timeline order, each from the right source point, with black in the gaps', async () => {
    const state = build((st) => [
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('counting', 0, 4, 1) },
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('counting', 1, 2, 1) },
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('red', 3, 0, 1) },
    ]);
    const file = await render('order', state);
    expectColor(file, 0.5, 'cyan');
    expectColor(file, 1.5, 'blue');
    expectColor(file, 2.5, 'black');
    expectColor(file, 3.5, 'red');
  });

  it('is exact on length: output has precisely the timeline frame count', async () => {
    const state = build((st) => [
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('red', 0, 0, 2) },
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('blue', 2, 3, 1.5) },
    ]);
    const file = await render('length', state);
    expect(frameCount(file)).toBe(105);
    const probe = await probeFile(FFPROBE, file);
    expect(probe).toMatchObject({ width: 640, height: 360, videoCodec: 'h264', audioCodec: 'aac' });
    expect(probe.frameRate).toEqual({ num: 30, den: 1 });
    expect(ticksToSeconds(probe.duration)).toBeCloseTo(3.5, 1);
  });

  it('applies speed: a clip at 2x shows the source twice as fast', async () => {
    const clip = media('counting', 0, 0, 8, { speed: 2, duration: s(4) });
    const state = build((st) => [{ op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip }]);
    const file = await render('speed', state);
    expect(frameCount(file)).toBe(120);
    expectColor(file, 0.25, 'red');
    expectColor(file, 0.75, 'lime');
    expectColor(file, 2.25, 'cyan');
    expectColor(file, 3.75, 'gray');
  });

  it('applies slow motion', async () => {
    const clip = media('counting', 0, 0, 2, { speed: 0.5, duration: s(4) });
    const state = build((st) => [{ op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip }]);
    const file = await render('slow', state);
    expect(frameCount(file)).toBe(120);
    expectColor(file, 1, 'red');
    expectColor(file, 3, 'lime');
  });

  it('composites tracks in order: B-roll covers video, overlays cover B-roll', async () => {
    const state = build((st) => [
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('red', 0, 0, 3) },
      { op: 'add_broll', trackId: trackId(st, 'BROLL'), clip: media('blue', 1, 0, 2) },
      { op: 'add_clip', trackId: trackId(st, 'OVERLAYS'), clip: media('lime', 2, 0, 1) },
    ]);
    const file = await render('layers', state);
    expectColor(file, 0.5, 'red');
    expectColor(file, 1.5, 'blue');
    expectColor(file, 2.5, 'lime');
  });

  it('applies scale and position like the preview', async () => {
    const small = {
      ...media('blue', 0, 0, 1),
      transform: { x: 0.25, y: 0, scale: 0.5, rotation: 0, opacity: 1 },
    };
    const state = build((st) => [
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('red', 0, 0, 1) },
      { op: 'add_clip', trackId: trackId(st, 'OVERLAYS'), clip: small },
    ]);
    const file = await render('transform', state);
    expectColor(file, 0.5, 'red', 100, 180);
    expectColor(file, 0.5, 'blue', 480, 180);
    expectColor(file, 0.5, 'red', 480, 40);
  });

  it('crops with a scale above 1, as a vertical Short does, and slides with x', async () => {
    const vertical: TimelineState = { ...blank(), width: 360, height: 640 };
    const wide = {
      ...media('counting', 0, 0, 1),
      transform: { x: 0, y: 0, scale: 3.16, rotation: 0, opacity: 1 },
    };
    const state = build(
      (st) => [{ op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: wide }],
      vertical,
    );
    const file = await render('crop', state);
    const probe = await probeFile(FFPROBE, file);
    expect([probe.width, probe.height]).toEqual([360, 640]);
    // The picture fills the frame top to bottom, with no bars.
    expectColor(file, 0.5, 'red', 180, 5);
    expectColor(file, 0.5, 'red', 180, 635);
    expectColor(file, 0.5, 'red', 5, 320);
  });

  it('applies opacity', async () => {
    const half = {
      ...media('blue', 0, 0, 1),
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 0.5 },
    };
    const state = build((st) => [
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('red', 0, 0, 1) },
      { op: 'add_clip', trackId: trackId(st, 'OVERLAYS'), clip: half },
    ]);
    const [r, , b] = pixel(await render('opacity', state), 0.5);
    expect(r).toBeGreaterThan(90);
    expect(b).toBeGreaterThan(90);
  });

  it('fades through a transition', async () => {
    const clip = {
      ...media('red', 0, 0, 2),
      transitionIn: { type: 'fade_black' as const, duration: s(1) },
    };
    const state = build((st) => [{ op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip }]);
    const file = await render('fade', state);
    expect(pixel(file, 0.05)[0]).toBeLessThan(50);
    const middle = pixel(file, 0.5)[0];
    expect(middle).toBeGreaterThan(90);
    expect(middle).toBeLessThan(190);
    expect(pixel(file, 1.5)[0]).toBeGreaterThan(220);
  });

  it('leaves out disabled clips', async () => {
    const state = build((st) => [
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('red', 0, 0, 1) },
      {
        op: 'add_clip',
        trackId: trackId(st, 'OVERLAYS'),
        clip: { ...media('blue', 0, 0, 1), enabled: false },
      },
    ]);
    expectColor(await render('disabled', state), 0.5, 'red');
  });

  it('letterboxes when exporting to another shape, rather than cropping', async () => {
    const state = build((st) => [
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('red', 0, 0, 1) },
    ]);
    const file = await render('letterbox', state, { width: 360, height: 360 });
    expect((await probeFile(FFPROBE, file)).width).toBe(360);
    expectColor(file, 0.5, 'black', 180, 20);
    expectColor(file, 0.5, 'red', 180, 180);
  });
});

describe('sound', () => {
  it('plays each clip with its own audio, in sync with its picture', async () => {
    const state = build((st) => [
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('red', 0, 0, 2) },
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('blue', 2, 0, 2) },
    ]);
    const file = await render('sync', state);
    expect(dominantHz(file, 0.5, 1)).toBeCloseTo(300, -1);
    expect(dominantHz(file, 2.5, 1)).toBeCloseTo(600, -1);
  });

  it('keeps pitch while speeding up', async () => {
    const clip = media('blue', 0, 0, 4, { speed: 2, duration: s(2) });
    const state = build((st) => [{ op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip }]);
    const file = await render('pitch', state);
    expect(dominantHz(file, 0.5, 1)).toBeCloseTo(600, -2);
  });

  it('applies clip volume, and silence at zero', async () => {
    const state = build((st) => [
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('red', 0, 0, 2) },
      {
        op: 'add_clip',
        trackId: trackId(st, 'VIDEO'),
        clip: media('red', 2, 0, 2, { volume: 0.25 }),
      },
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('red', 4, 0, 2, { volume: 0 }) },
    ]);
    const file = await render('volume', state);
    const full = loudness(file, 0.5, 1);
    const quiet = loudness(file, 2.5, 1);
    expect(full - quiet).toBeCloseTo(12, 0);
    expect(loudness(file, 4.5, 1)).toBeLessThan(-80);
  });

  it('honours track mute and track volume', async () => {
    const state = build((st) => [
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('red', 0, 0, 1) },
      { op: 'add_music', trackId: trackId(st, 'MUSIC'), clip: media('lime', 0, 0, 1) },
      { op: 'update_track', trackId: trackId(st, 'MUSIC'), muted: true },
    ]);
    const file = await render('mute', state);
    expect(dominantHz(file, 0.2, 0.6)).toBeCloseTo(300, -1);
  });

  it('mixes tracks without lowering them', async () => {
    const dialogue = build((st) => [
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('red', 0, 0, 2) },
    ]);
    const both = build((st) => [
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('red', 0, 0, 2) },
      { op: 'add_music', trackId: trackId(st, 'MUSIC'), clip: media('lime', 0, 0, 2) },
    ]);
    const alone = loudness(await render('solo', dialogue), 0.5, 1);
    const mixed = loudness(await render('mixed', both), 0.5, 1);
    expect(mixed).toBeGreaterThanOrEqual(alone - 0.5);
  });

  it('fades audio in and out', async () => {
    const clip = {
      ...media('red', 0, 0, 4),
      audio: { normalize: false, denoise: false, fadeIn: s(2), fadeOut: s(1) },
    };
    const state = build((st) => [{ op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip }]);
    const file = await render('afade', state);
    expect(loudness(file, 0, 0.3)).toBeLessThan(loudness(file, 2, 0.5) - 8);
    expect(loudness(file, 3.8, 0.2)).toBeLessThan(loudness(file, 2, 0.5) - 8);
  });

  it('normalizes a quiet clip and a loud one to about the same level', async () => {
    // Realistic levels: about -36 and -20 LUFS, both within the safety cap on gain.
    const quiet = makeSource('quiet', 'red', 400, 6, 0.3);
    const loud = makeSource('loud', 'blue', 400, 6, 2);
    const state = build((st) => [
      {
        op: 'add_clip',
        trackId: trackId(st, 'VIDEO'),
        clip: {
          ...media('quiet', 0, 0, 5),
          audio: { normalize: true, denoise: false, fadeIn: 0, fadeOut: 0 },
        },
      },
      {
        op: 'add_clip',
        trackId: trackId(st, 'VIDEO'),
        clip: {
          ...media('loud', 5, 0, 5),
          audio: { normalize: true, denoise: false, fadeIn: 0, fadeOut: 0 },
        },
      },
    ]);
    const log: string[] = [];
    const file = await render('normalize', state, { onLog: (line) => log.push(line) });
    void quiet;
    void loud;
    const difference = Math.abs(loudness(file, 1, 3) - loudness(file, 6, 3));
    expect(difference).toBeLessThan(1.5);
    expect(log.filter((line) => line.startsWith('normalize'))).toHaveLength(2);
  });

  it('measures silence as no gain rather than infinite gain', () => {
    expect(normalizationGain(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(normalizationGain(-46)).toBe(20);
    expect(normalizationGain(-16)).toBe(0);
    expect(normalizationGain(0)).toBe(-16);
  });

  it('reads real loudness from a source', async () => {
    const measured = await measureLoudness(FFMPEG, sources.get(ids.red!)!.path, 0, 3);
    expect(measured).toBeGreaterThan(-40);
    expect(measured).toBeLessThan(-5);
  });

  it('applies noise reduction without breaking the output', async () => {
    const clip = {
      ...media('red', 0, 0, 2),
      audio: { normalize: false, denoise: true, fadeIn: 0, fadeOut: 0 },
    };
    const state = build((st) => [{ op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip }]);
    expect(frameCount(await render('denoise', state))).toBe(60);
  });

  it('writes silent audio for a timeline with no sound at all', async () => {
    const state = build((st) => [
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('counting', 0, 0, 2) },
    ]);
    const file = await render('silent', state);
    expect((await probeFile(FFPROBE, file)).audioCodec).toBe('aac');
    expect(loudness(file, 0.5, 1)).toBeLessThan(-80);
  });
});

describe('chunks', () => {
  it('splits long timelines, with chunks that meet exactly', () => {
    const state = build((st) => [
      {
        op: 'add_clip',
        trackId: trackId(st, 'VIDEO'),
        clip: createMediaClip(
          { sourceMediaId: ids.red!, start: 0, sourceIn: 0, sourceOut: s(1000) },
          rate,
        ),
      },
    ]);
    const chunks = planRenderChunks(state, { maxSeconds: 300 });
    expect(chunks).toHaveLength(4);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.start).toBe(chunks[i - 1]!.end);
    expect(chunks[0]!.start).toBe(0);
    expect(chunks.at(-1)!.end).toBe(timelineDuration(state));
  });

  it('limits how many clips a chunk holds, so decoders do not pile up', () => {
    const state = build((st) =>
      Array.from({ length: 100 }, (_v, i): TimelineOperation => ({
        op: 'add_clip',
        trackId: trackId(st, 'VIDEO'),
        clip: media('red', i, 0, 1),
      })),
    );
    const chunks = planRenderChunks(state, { maxClips: 10 });
    expect(chunks.length).toBeGreaterThanOrEqual(10);
    for (const chunk of chunks) {
      const count = state.tracks[2]!.clips.filter(
        (c) => c.start < chunk.end && c.start + c.duration > chunk.start,
      ).length;
      expect(count).toBeLessThanOrEqual(10);
    }
  });

  it('never splits a fade between chunks', () => {
    const clip = {
      ...createMediaClip(
        { sourceMediaId: ids.red!, start: 0, sourceIn: 0, sourceOut: s(300) },
        rate,
      ),
      transitionOut: { type: 'fade_black' as const, duration: s(10) },
    };
    const state = build((st) => [{ op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip }]);
    for (const chunk of planRenderChunks(state, { maxSeconds: 295 })) {
      expect(chunk.end <= s(290) || chunk.end >= s(300)).toBe(true);
    }
  });

  it('renders across a chunk seam with no lost frame or audio gap', async () => {
    const state = build((st) => [
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('counting', 0, 0, 8) },
      { op: 'add_clip', trackId: trackId(st, 'AUDIO'), clip: media('red', 0, 0, 8) },
    ]);
    const workDir = join(dir, 'work-seam');
    mkdirSync(workDir, { recursive: true });
    const output = join(dir, 'seam.mp4');
    const chunks = planRenderChunks(state, { maxSeconds: 3 });
    expect(chunks.length).toBeGreaterThan(1);
    await renderSeam(state, workDir, output, 3);
    expect(frameCount(output)).toBe(240);
    expectColor(output, 2.9, 'blue');
    expectColor(output, 3.1, 'yellow');
    const before = loudness(output, 2.7, 0.25);
    const across = loudness(output, 2.9, 0.2);
    expect(Math.abs(before - across)).toBeLessThan(1);
    expect(dominantHz(output, 2.5, 1)).toBeCloseTo(300, -1);
  });

  it('skips chunks finished by an earlier attempt', async () => {
    const state = build((st) => [
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('red', 0, 0, 2) },
    ]);
    const workDir = join(dir, 'work-resume');
    mkdirSync(workDir, { recursive: true });
    const finished: number[] = [];
    const output = await render('resume', state, {
      workDir,
      onChunkFinished: (i) => finished.push(i),
    });
    expect(finished).toEqual([0]);
    const before = readdirSync(workDir).find((f) => f.endsWith('.mkv'))!;
    const stamp = readFileSync(join(workDir, before)).length;
    const log: string[] = [];
    await render('resume', state, {
      workDir,
      finished: new Set([0]),
      onLog: (l) => log.push(l),
      output,
    });
    expect(log.some((line) => line.startsWith('chunk'))).toBe(false);
    expect(readFileSync(join(workDir, before)).length).toBe(stamp);
  });

  it('reports real, rising progress that stays short of done until the file exists', async () => {
    const state = build((st) => [
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('red', 0, 0, 3) },
    ]);
    const seen: number[] = [];
    await render('progress', state, { onProgress: (p) => seen.push(p) });
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.at(-1)).toBeLessThanOrEqual(0.95);
  });

  it('can be cancelled', async () => {
    const state = build((st) => [
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('red', 0, 0, 20) },
    ]);
    const controller = new AbortController();
    const running = render('cancel', state, { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await expect(running).rejects.toThrow('Aborted');
  });
});

/** Forces small chunks through the same code path, since planRenderChunks has a public default. */
async function renderSeam(
  state: TimelineState,
  workDir: string,
  output: string,
  maxSeconds: number,
) {
  const chunks = planRenderChunks(state, { maxSeconds });
  const files: string[] = [];
  for (const chunk of chunks) {
    const file = join(workDir, `seam-${chunk.index}.mkv`);
    const { graph, args } = buildChunkCommand(state, {
      chunk,
      sources,
      width: state.width,
      height: state.height,
      output: file,
      crf: 18,
    });
    const graphPath = join(workDir, `seam-${chunk.index}.graph`);
    execFileSync('sh', ['-c', `cat > "${graphPath}"`], { input: graph });
    const inputEnd = args.indexOf('-map');
    execFileSync(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...args.slice(0, inputEnd),
      '-/filter_complex',
      graphPath,
      ...args.slice(inputEnd),
    ]);
    files.push(file);
  }
  const list = join(workDir, 'list.txt');
  execFileSync('sh', ['-c', `cat > "${list}"`], {
    input: files.map((f) => `file '${f}'`).join('\n'),
  });
  execFileSync(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    output,
  ]);
}

describe('captions', () => {
  const withCaption = (text: string, position: 'top' | 'bottom' = 'bottom') =>
    build((st) => [
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('red', 0, 0, 3) },
      {
        op: 'add_caption',
        trackId: trackId(st, 'CAPTIONS'),
        clip: createCaptionClip(
          {
            start: s(1),
            duration: s(1),
            text,
            style: { font: 'Arial', size: 40, color: '#ffffff', background: '#000000ff', position },
          },
          rate,
        ),
      },
    ]);

  it('burns text in only while the caption is on screen', async () => {
    const available = await hasFilter(FFMPEG, 'ass');
    expect(available, 'run with the full FFmpeg build').toBe(true);
    const file = await render('burn', withCaption('Hello world'));
    const band = (at: number) =>
      execFileSync(FFMPEG, [
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
        'crop=640:60:0:290,format=gray',
        '-f',
        'rawvideo',
        '-',
      ]);
    const contrast = (buffer: Buffer) => Math.max(...buffer) - Math.min(...buffer);
    expect(contrast(band(0.5))).toBeLessThan(30);
    expect(contrast(band(1.5))).toBeGreaterThan(120);
    expect(contrast(band(2.5))).toBeLessThan(30);
  });

  it('can export without burning them', async () => {
    const file = await render('noburn', withCaption('Hello world'), { burnCaptions: false });
    expectColor(file, 1.5, 'red', 320, 320);
  });

  it('neutralises caption text that tries to inject styling', () => {
    expect(escapeAssText('{\\b1}evil\\N')).toBe('(∖b1)evil∖N');
    const ass = buildAssSubtitles(
      withCaption('{\\pos(0,0)}bad\nline'),
      { index: 0, start: 0, end: s(3) },
      640,
      360,
    )!;
    expect(ass).not.toContain('{\\pos');
    expect(ass).toContain('(∖pos(0,0))bad\\Nline');
  });

  it('renders hostile caption text safely end to end', async () => {
    const file = await render(
      'hostile',
      withCaption("{\\fad(0,0)}'; rm -rf /; \\N $(touch pwned) %s"),
    );
    expect(frameCount(file)).toBe(90);
    expect(readdirSync(dir).filter((f) => f.includes('pwned'))).toEqual([]);
  });

  it('times captions from the start of each chunk', () => {
    const state = withCaption('Timed');
    const ass = buildAssSubtitles(state, { index: 1, start: s(1), end: s(3) }, 640, 360)!;
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:01.00');
    expect(buildAssSubtitles(state, { index: 0, start: 0, end: s(0.5) }, 640, 360)).toBeNull();
  });

  it('scales text with the export size', () => {
    const state = withCaption('Sized');
    const small = buildAssSubtitles(state, { index: 0, start: 0, end: s(3) }, 320, 180)!;
    expect(small).toContain(',Arial,20,');
  });

  it('exports SRT with correct numbering and times, leaving out disabled captions', () => {
    const state = build((st) => [
      {
        op: 'add_caption',
        trackId: trackId(st, 'CAPTIONS'),
        clip: createCaptionClip({ start: s(61.5), duration: s(2), text: 'Second' }, rate),
      },
      {
        op: 'add_caption',
        trackId: trackId(st, 'CAPTIONS'),
        clip: createCaptionClip({ start: 0, duration: s(1), text: 'First' }, rate),
      },
      {
        op: 'add_caption',
        trackId: trackId(st, 'CAPTIONS'),
        clip: {
          ...createCaptionClip({ start: s(10), duration: s(1), text: 'Hidden' }, rate),
          enabled: false,
        },
      },
    ]);
    expect(captionsToSrt(state)).toBe(
      '1\n00:00:00,000 --> 00:00:01,000\nFirst\n\n2\n00:01:01,500 --> 00:01:03,500\nSecond\n',
    );
  });
});

describe('safety', () => {
  it('never puts a file path somewhere the shell or filter graph could read it as code', () => {
    const state = build((st) => [
      { op: 'add_clip', trackId: trackId(st, 'VIDEO'), clip: media('red', 0, 0, 1) },
    ]);
    const { graph } = buildChunkCommand(state, {
      chunk: { index: 0, start: 0, end: s(1) },
      sources,
      width: 640,
      height: 360,
      output: 'x.mkv',
      assPath: "/tmp/a'b;c.ass",
    });
    expect(graph).toContain("ass=filename='/tmp/a'\\''b;c.ass'");
    expect(graph).not.toContain(sources.get(ids.red!)!.path);
  });
});
