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
