import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { MediaProcessError, UNTRUSTED_INPUT_ARGS, runFfmpeg, type RunOptions } from './ffmpeg.js';
import type { ProcessTracker } from './process-tracker.js';

type Progress = (fraction: number) => void;

export interface StepOptions {
  signal?: AbortSignal | undefined;
  onProgress?: Progress | undefined;
  stallTimeoutMs?: number | undefined;
  tracker?: ProcessTracker | undefined;
}

function runOptions(
  duration: number,
  { signal, onProgress, stallTimeoutMs, tracker }: StepOptions,
) {
  const options: RunOptions = {
    signal,
    stallTimeoutMs,
    tracker,
    onProgress: (seconds) => onProgress?.(Math.min(1, seconds / duration)),
  };
  return options;
}

const PROXY_HEIGHT = 720;

/**
 * Editing proxy: one-second keyframes make seeks land quickly and +faststart lets the browser start
 * from range requests without reading the whole file. Non-editing metadata is dropped.
 */
export async function generateProxy(
  ffmpeg: string,
  input: string,
  output: string,
  { duration, hasAudio, ...options }: StepOptions & { duration: number; hasAudio: boolean },
): Promise<void> {
  await runFfmpeg(
    ffmpeg,
    [
      ...UNTRUSTED_INPUT_ARGS,
      '-i',
      input,
      '-map',
      '0:v:0',
      ...(hasAudio ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : ['-an']),
      '-map_metadata',
      '-1',
      '-sn',
      '-dn',
      '-vf',
      `scale=-2:'min(${PROXY_HEIGHT},ih)':flags=bicubic,format=yuv420p`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '26',
      '-force_key_frames',
      'expr:gte(t,n_forced*1)',
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      output,
    ],
    runOptions(duration, options),
  );
}

/** Mono 16 kHz is what speech-to-text wants, and FLAC keeps a 3-hour file manageable. */
export async function extractAudio(
  ffmpeg: string,
  input: string,
  output: string,
  { duration, ...options }: StepOptions & { duration: number },
): Promise<void> {
  await runFfmpeg(
    ffmpeg,
    [
      ...UNTRUSTED_INPUT_ARGS,
      '-i',
      input,
      '-map',
      '0:a:0',
      '-vn',
      '-map_metadata',
      '-1',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'flac',
      '-f',
      'flac',
      output,
    ],
    runOptions(duration, options),
  );
}

export const THUMBNAIL_COUNT = 10;

/**
 * Seeking before -i jumps straight to the nearest keyframe, so cost is per thumbnail rather than
 * proportional to the length of the recording.
 */
export async function generateThumbnails(
  ffmpeg: string,
  input: string,
  outputDir: string,
  { duration, signal, onProgress, stallTimeoutMs, tracker }: StepOptions & { duration: number },
): Promise<string[]> {
  const files: string[] = [];
  for (let i = 0; i < THUMBNAIL_COUNT; i++) {
    const at = (duration * (i + 0.5)) / THUMBNAIL_COUNT;
    const output = join(outputDir, `thumb-${String(i).padStart(2, '0')}.jpg`);
    try {
      await runFfmpeg(
        ffmpeg,
        [
          ...UNTRUSTED_INPUT_ARGS,
          '-ss',
          at.toFixed(3),
          '-i',
          input,
          '-frames:v',
          '1',
          '-vf',
          'scale=320:-2',
          '-q:v',
          '4',
          '-update',
          '1',
          '-f',
          'image2',
          output,
        ],
        { signal, stallTimeoutMs, tracker },
      );
      files.push(output);
    } catch (err) {
      // One undecodable spot should not cost the other nine. No frames at all is a real failure.
      if (!(err instanceof MediaProcessError)) throw err;
    }
    onProgress?.((i + 1) / THUMBNAIL_COUNT);
  }
  if (files.length === 0) throw new MediaProcessError('No frames could be extracted', '', null);
  return files;
}

const WAVEFORM_SAMPLE_RATE = 8000;

/**
 * Writes min/max Int8 pairs. Samples stream through a fixed-size buffer, so memory stays flat no
 * matter how long the recording is: a 3-hour file produces about 1 MB at 50 peaks per second.
 */
export async function generateWaveform(
  ffmpeg: string,
  input: string,
  output: string,
  {
    duration,
    peaksPerSecond,
    signal,
    onProgress,
    tracker,
  }: StepOptions & { duration: number; peaksPerSecond: number },
): Promise<{ peakCount: number }> {
  signal?.throwIfAborted();
  const samplesPerPeak = Math.round(WAVEFORM_SAMPLE_RATE / peaksPerSecond);
  const totalSamples = duration * WAVEFORM_SAMPLE_RATE;

  const child = spawn(
    ffmpeg,
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      ...UNTRUSTED_INPUT_ARGS,
      '-i',
      input,
      '-map',
      '0:a:0',
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(WAVEFORM_SAMPLE_RATE),
      '-f',
      's16le',
      '-c:a',
      'pcm_s16le',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], shell: false },
  );
  tracker?.track(child, ffmpeg);

  const onAbort = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', onAbort, { once: true });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });

  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  const out = createWriteStream(output);
  let min = 0;
  let max = 0;
  let inBucket = 0;
  let samples = 0;
  let peakCount = 0;
  let carry: Buffer | null = null;

  const toInt8 = (sample: number) => Math.max(-127, Math.round(sample / 256));
  const flush = () => {
    peakCount++;
    return out.write(Buffer.from(new Int8Array([toInt8(min), toInt8(max)]).buffer));
  };

  try {
    for await (const value of child.stdout) {
      let chunk = value as Buffer;
      if (carry) {
        chunk = Buffer.concat([carry, chunk]);
        carry = null;
      }
      const usable = chunk.length - (chunk.length % 2);
      if (usable < chunk.length) carry = chunk.subarray(usable);
      for (let i = 0; i < usable; i += 2) {
        const sample = chunk.readInt16LE(i);
        if (inBucket === 0 || sample < min) min = sample;
        if (inBucket === 0 || sample > max) max = sample;
        if (++inBucket === samplesPerPeak) {
          if (!flush()) await new Promise((resolve) => out.once('drain', resolve));
          inBucket = 0;
        }
      }
      samples += usable / 2;
      onProgress?.(Math.min(1, samples / totalSamples));
    }
    if (inBucket > 0) flush();
  } finally {
    signal?.removeEventListener('abort', onAbort);
    out.end();
    await finished(out);
  }

  const code = await exited;
  signal?.throwIfAborted();
  if (code !== 0) throw new MediaProcessError(`FFmpeg exited with code ${code}`, stderr, code);
  return { peakCount };
}
