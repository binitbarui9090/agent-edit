import { spawn } from 'node:child_process';
import type { ProcessTracker } from './process-tracker.js';

export interface BinaryPaths {
  ffmpeg: string;
  ffprobe: string;
}

export const DEFAULT_BINARIES: BinaryPaths = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };

/**
 * Applied to every read of uploaded media, which is hostile until proven otherwise.
 *
 * `file` alone is not enough: an "mp4" whose content is an ffconcat script is detected by content
 * and can pull in sibling files through relative paths, which the concat demuxer treats as safe.
 * Restricting demuxers to the containers the product accepts refuses every such format outright.
 */
export const UNTRUSTED_INPUT_ARGS = [
  '-protocol_whitelist',
  'file,pipe',
  '-format_whitelist',
  'mov,matroska,webm',
] as const;

export class MediaProcessError extends Error {
  constructor(
    message: string,
    readonly stderrTail: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'MediaProcessError';
  }
}

export interface RunOptions {
  signal?: AbortSignal | undefined;
  /** Kill after this long with no progress or output. A stuck decoder must not hold a slot forever. */
  stallTimeoutMs?: number | undefined;
  onProgress?: ((seconds: number) => void) | undefined;
  tracker?: ProcessTracker | undefined;
  /** Raises the log level and passes each stderr line along, for filters that report that way. */
  onLogLine?: ((line: string) => void) | undefined;
}

const STDERR_TAIL_BYTES = 8 * 1024;
const DEFAULT_STALL_MS = 5 * 60 * 1000;

/** Arguments are an argv array with no shell, so nothing in a name or path can be interpreted. */
export function runFfmpeg(
  binary: string,
  args: readonly string[],
  { signal, stallTimeoutMs = DEFAULT_STALL_MS, onProgress, tracker, onLogLine }: RunOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(
      binary,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        onLogLine ? 'info' : 'error',
        '-progress',
        'pipe:1',
        '-y',
        ...args,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], shell: false },
    );
    tracker?.track(child, binary);

    let stderr = '';
    let reason: Error | null = null;
    let timer: NodeJS.Timeout;
    const kill = (why: Error) => {
      reason ??= why;
      child.kill('SIGKILL');
    };
    const armStallTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => kill(new Error(`FFmpeg made no progress for ${stallTimeoutMs} ms`)),
        stallTimeoutMs,
      );
    };
    armStallTimer();

    const onAbort = () => kill(new Error('Aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    let buffered = '';
    child.stdout.on('data', (chunk: string) => {
      armStallTimer();
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        const match = /^out_time_us=(\d+)/.exec(line);
        if (match) onProgress?.(Number(match[1]) / 1_000_000);
      }
    });
    child.stderr.setEncoding('utf8');
    let partialLine = '';
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
      if (!onLogLine) return;
      armStallTimer();
      const lines = (partialLine + chunk).split('\n');
      partialLine = lines.pop() ?? '';
      for (const line of lines) onLogLine(line);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (reason) reject(reason);
      else if (code === 0) resolve();
      else reject(new MediaProcessError(`FFmpeg exited with code ${code}`, stderr, code));
    });
  });
}
