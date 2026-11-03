import { spawn } from 'node:child_process';
import { secondsToTicks } from '@agent-edit/shared';
import { UNTRUSTED_INPUT_ARGS, runFfmpeg } from './ffmpeg.js';
import type { ProcessTracker } from './process-tracker.js';

interface AnalysisOptions {
  signal?: AbortSignal | undefined;
  tracker?: ProcessTracker | undefined;
  onProgress?: ((fraction: number) => void) | undefined;
  /** Seconds, to turn FFmpeg's position into a fraction. */
  duration: number;
}

export interface TimeRange {
  /** Ticks. */
  start: number;
  end: number;
}

/** Quiet stretches of at least half a second. Quieter than speech, but above typical room tone. */
export async function detectSilence(
  ffmpeg: string,
  input: string,
  { signal, tracker, onProgress, duration }: AnalysisOptions,
): Promise<TimeRange[]> {
  const ranges: TimeRange[] = [];
  let open: number | null = null;
  await runFfmpeg(
    ffmpeg,
    [
      // Our own extracted FLAC, so the video container whitelist does not apply.
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      input,
      '-af',
      'silencedetect=noise=-35dB:d=0.5',
      '-f',
      'null',
      '-',
    ],
    {
      signal,
      tracker,
      onProgress: (seconds) => onProgress?.(Math.min(1, seconds / duration)),
      onLogLine: (line) => {
        const started = /silence_start: (-?[\d.]+)/.exec(line);
        if (started) open = Math.max(0, Number(started[1]));
        const ended = /silence_end: ([\d.]+)/.exec(line);
        if (ended && open !== null) {
          ranges.push({ start: secondsToTicks(open), end: secondsToTicks(Number(ended[1])) });
          open = null;
        }
      },
    },
  );
  // A recording that ends in silence never reports silence_end.
  if (open !== null) ranges.push({ start: secondsToTicks(open), end: secondsToTicks(duration) });
  return ranges;
}

/**
 * Where the picture changes. Runs on keyframes of the proxy, which has one per second: a cut lands
 * within a second, and reading keyframes alone keeps a 3-hour file quick.
 */
export async function detectSceneChanges(
  ffmpeg: string,
  proxy: string,
  { signal, tracker, onProgress, duration }: AnalysisOptions,
): Promise<number[]> {
  const cuts: number[] = [];
  await runFfmpeg(
    ffmpeg,
    [
      '-skip_frame',
      'nokey',
      ...UNTRUSTED_INPUT_ARGS,
      '-i',
      proxy,
      '-an',
      '-vf',
      "scale=160:-2,select='gt(scene,0.3)',showinfo",
      '-fps_mode',
      'vfr',
      '-f',
      'null',
      '-',
    ],
    {
      signal,
      tracker,
      onProgress: (seconds) => onProgress?.(Math.min(1, seconds / duration)),
      onLogLine: (line) => {
        const match = /pts_time:([\d.]+)/.exec(line);
        if (match && line.includes('showinfo')) cuts.push(secondsToTicks(Number(match[1])));
      },
    },
  );
  return cuts;
}

export async function extractFrame(
  ffmpeg: string,
  input: string,
  output: string,
  atSeconds: number,
  { signal, tracker }: Pick<AnalysisOptions, 'signal' | 'tracker'> = {},
): Promise<void> {
  await runFfmpeg(
    ffmpeg,
    [
      ...UNTRUSTED_INPUT_ARGS,
      '-ss',
      atSeconds.toFixed(3),
      '-i',
      input,
      '-frames:v',
      '1',
      '-vf',
      'scale=640:-2',
      '-q:v',
      '4',
      '-update',
      '1',
      '-f',
      'image2',
      output,
    ],
    { signal, tracker },
  );
}

const MOTION_WIDTH = 64;
const MOTION_HEIGHT = 36;
/** Frame differences below this are compression noise, not movement. */
const MOTION_NOISE_FLOOR = 10;
/** Too little change overall means a still shot, with nothing to go on. */
const MIN_MOTION_ENERGY = 400;
/** Evenly spread motion has a spread near 0.29. Well below that means it is concentrated somewhere. */
const MAX_CONCENTRATED_SPREAD = 0.2;

/** Where movement concentrates across the picture, or null if there is no clear region. */
export function analyzeColumnMotion(columns: readonly number[]): number | null {
  const total = columns.reduce((sum, value) => sum + value, 0);
  if (total < MIN_MOTION_ENERGY) return null;
  const position = (index: number) => (index + 0.5) / columns.length;
  const center = columns.reduce((sum, value, i) => sum + value * position(i), 0) / total;
  const variance =
    columns.reduce((sum, value, i) => sum + value * (position(i) - center) ** 2, 0) / total;
  if (Math.sqrt(variance) > MAX_CONCENTRATED_SPREAD) return null;
  return Math.round((center - 0.5) * 2 * 1000) / 1000;
}

/**
 * Measures where a shot moves, from -1 (left edge) to 1 (right edge). A speaker moves and a background
 * does not, so this finds them with no model at all. It picks one position per shot: it does not track
 * someone walking across the frame, and a moving camera reads as no clear region.
 */
export function findActiveRegion(
  ffmpeg: string,
  input: string,
  fromSeconds: number,
  lengthSeconds: number,
  { signal, tracker }: Pick<AnalysisOptions, 'signal' | 'tracker'> = {},
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(
      ffmpeg,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        ...UNTRUSTED_INPUT_ARGS,
        '-ss',
        fromSeconds.toFixed(3),
        '-t',
        lengthSeconds.toFixed(3),
        '-i',
        input,
        '-an',
        '-vf',
        `fps=4,scale=${MOTION_WIDTH}:${MOTION_HEIGHT},format=gray,tblend=all_mode=difference`,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'gray',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], shell: false, ...(signal ? { signal } : {}) },
    );
    tracker?.track(child, ffmpeg);
    const columns = new Array<number>(MOTION_WIDTH).fill(0);
    let offset = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      for (const value of chunk) {
        if (value > MOTION_NOISE_FLOOR) columns[offset % MOTION_WIDTH]! += value;
        offset++;
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(analyzeColumnMotion(columns));
      else reject(new Error(`FFmpeg exited with code ${code}`));
    });
  });
}
