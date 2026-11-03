import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildShortOperations } from '@agent-edit/ai-engine';
import { analyzeColumnMotion, findActiveRegion, renderTimeline } from '@agent-edit/media-engine';
import { newId, secondsToTicks } from '@agent-edit/shared';
import { applyOperations, createDefaultTracks } from '@agent-edit/timeline-engine';
import type { TimelineState } from '@agent-edit/validation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const FULL = '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
const FFMPEG = process.env.FFMPEG_PATH ?? (existsSync(FULL) ? FULL : 'ffmpeg');
let dir: string;

/** A still blue background with a bright box bobbing around at the given horizontal centre. */
function shot(name: string, centerX: number, moving = true): string {
  const path = join(dir, name);
  const y = moving ? '150+60*sin(2*PI*t)' : '150';
  execFileSync(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=1280x720:r=30:d=6',
    '-f',
    'lavfi',
    '-i',
    'color=c=white:s=120x400:r=30:d=6',
    '-filter_complex',
    `[0][1]overlay=x=${centerX - 60}:y='${y}':eval=frame`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    path,
  ]);
  return path;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ae-framing-'));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('findActiveRegion', () => {
  it('finds movement on the left', async () => {
    const position = await findActiveRegion(FFMPEG, shot('left.mp4', 320), 0, 6);
    expect(position).toBeCloseTo(-0.5, 0);
    expect(position!).toBeLessThan(-0.3);
  });

  it('finds movement on the right', async () => {
    const position = await findActiveRegion(FFMPEG, shot('right.mp4', 960), 0, 6);
    expect(position!).toBeGreaterThan(0.3);
  });

  it('admits a still shot gives it nothing', async () => {
    expect(await findActiveRegion(FFMPEG, shot('still.mp4', 320, false), 0, 6)).toBeNull();
  });

  it('admits when movement is everywhere, as with a moving camera', () => {
    expect(analyzeColumnMotion(new Array(64).fill(1000))).toBeNull();
  });

  it('refuses a file that is not a real video', async () => {
    const path = join(dir, 'fake.mp4');
    execFileSync('sh', ['-c', `printf 'ffconcat version 1.0\\n' > "${path}"`]);
    await expect(findActiveRegion(FFMPEG, path, 0, 1)).rejects.toThrow('FFmpeg exited');
  });
});

describe('reframing end to end', () => {
  it('puts an off-centre subject in the middle of the rendered vertical frame', async () => {
    const source = shot('subject.mp4', 320);
    const framing = await findActiveRegion(FFMPEG, source, 0, 6);
    expect(framing).not.toBeNull();

    const mediaId = newId('med');
    const base: TimelineState = {
      frameRate: { num: 30, den: 1 },
      width: 360,
      height: 640,
      tracks: createDefaultTracks(),
    };
    const short = {
      name: 'x',
      reason: 'x',
      sourceMediaId: mediaId,
      sourceIn: 0,
      sourceOut: secondsToTicks(2),
      framing: framing!,
      framingSource: 'motion' as const,
      captions: [],
    };
    const state = applyOperations(
      base,
      buildShortOperations(short, base, { width: 1280, height: 720 }),
    ).state;
    const render = async (name: string, timeline: TimelineState) => {
      const workDir = join(dir, name);
      mkdirSync(workDir, { recursive: true });
      const output = join(dir, `${name}.mp4`);
      await renderTimeline({
        ffmpeg: FFMPEG,
        state: timeline,
        sources: new Map([[mediaId, { path: source, hasAudio: false }]]),
        width: 360,
        height: 640,
        burnCaptions: false,
        workDir,
        output,
      });
      return output;
    };
    const redAt = (file: string, x: number) => {
      const raw = execFileSync(FFMPEG, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        '0.5',
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        `crop=1:1:${x}:320,format=rgb24`,
        '-f',
        'rawvideo',
        '-',
      ]);
      return [raw[0]!, raw[1]!, raw[2]!];
    };
    const isWhite = (rgb: number[]) => rgb.every((value) => value > 200);

    const framed = await render('framed', state);
    expect(isWhite(redAt(framed, 180)), 'subject is centred when framed').toBe(true);

    // The control: the same shot, centre cropped, misses the subject entirely.
    const centered = applyOperations(
      base,
      buildShortOperations({ ...short, framing: 0 }, base, { width: 1280, height: 720 }),
    ).state;
    expect(isWhite(redAt(await render('centered', centered), 180))).toBe(false);
  });
});
