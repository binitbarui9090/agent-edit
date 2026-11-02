import { execFile } from 'node:child_process';
import { secondsToTicks } from '@agent-edit/shared';
import type { MediaProbe } from '@agent-edit/validation';
import { MediaProcessError, UNTRUSTED_INPUT_ARGS } from './ffmpeg.js';

/** The file is not usable media. Retrying cannot help. */
export class InvalidMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMediaError';
  }
}

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  channels?: number;
  sample_rate?: string;
  duration?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
  disposition?: { attached_pic?: number };
}

interface RawProbe {
  format?: { format_name?: string; duration?: string; bit_rate?: string };
  streams?: RawStream[];
}

function parseRate(value: string | undefined): { num: number; den: number } | null {
  const [num, den] = (value ?? '').split('/').map(Number);
  if (!num || !den || !Number.isFinite(num) || !Number.isFinite(den)) return null;
  return { num, den };
}

function rotationOf(stream: RawStream): number {
  const fromSideData = stream.side_data_list?.find((d) => d.rotation !== undefined)?.rotation;
  const raw = fromSideData ?? Number(stream.tags?.rotate ?? 0);
  return Number.isFinite(raw) ? Math.round(raw) : 0;
}

export function parseProbe(raw: RawProbe): MediaProbe {
  const streams = raw.streams ?? [];
  // Embedded cover art appears as a video stream but is not footage.
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video?.width || !video.height) throw new InvalidMediaError('No video stream found');
  const audio = streams.find((s) => s.codec_type === 'audio');

  const seconds = Number(raw.format?.duration ?? video.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new InvalidMediaError('Unknown duration');

  const average = parseRate(video.avg_frame_rate);
  const nominal = parseRate(video.r_frame_rate);
  const frameRate = average ?? nominal;
  if (!frameRate) throw new InvalidMediaError('Unknown frame rate');
  const isVariableFrameRate =
    average !== null &&
    nominal !== null &&
    Math.abs(average.num / average.den - nominal.num / nominal.den) >
      0.01 * (nominal.num / nominal.den);

  // Decoders apply rotation, so the frames we work with have the displayed dimensions.
  const rotation = rotationOf(video);
  const swapped = Math.abs(rotation) % 180 === 90;

  return {
    duration: secondsToTicks(seconds),
    width: swapped ? video.height : video.width,
    height: swapped ? video.width : video.height,
    frameRate,
    isVariableFrameRate,
    rotation,
    container: raw.format?.format_name ?? 'unknown',
    videoCodec: video.codec_name ?? 'unknown',
    audioCodec: audio?.codec_name ?? null,
    audioChannels: audio?.channels ?? 0,
    sampleRate: Number(audio?.sample_rate ?? 0) || 0,
    bitrate: Number(raw.format?.bit_rate ?? 0) || 0,
  };
}

export function probeFile(binary: string, path: string, signal?: AbortSignal): Promise<MediaProbe> {
  const args = [
    ...UNTRUSTED_INPUT_ARGS,
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    path,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}) },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as { code?: unknown }).code;
          // A non-zero exit means FFprobe ran and rejected the file. Anything else is our problem.
          if (typeof code === 'number') {
            reject(new InvalidMediaError('Not a supported video file'));
          } else {
            reject(new MediaProcessError(err.message, stderr, null));
          }
          return;
        }
        try {
          resolve(parseProbe(JSON.parse(stdout) as RawProbe));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}
