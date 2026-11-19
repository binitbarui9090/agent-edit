import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TICKS_PER_SECOND } from '@agent-edit/shared';
import type { MediaClip, TimelineState } from '@agent-edit/validation';
import { UNTRUSTED_INPUT_ARGS, runFfmpeg } from './ffmpeg.js';
import type { ProcessTracker } from './process-tracker.js';
import {
  buildAssSubtitles,
  buildChunkCommand,
  normalizationGain,
  planRenderChunks,
  type RenderSource,
} from './render.js';

const graphOptionCache = new Map<string, Promise<string>>();

/** The major version in `ffmpeg -version`. Builds from git report no number, and are recent. */
export function parseFfmpegMajor(output: string): number | null {
  const match = /^ffmpeg version n?(\d+)\./m.exec(output);
  return match ? Number(match[1]) : null;
}

/**
 * The option that reads a filter graph from a file. FFmpeg 7 introduced `-/filter_complex` and
 * deprecated `-filter_complex_script`, which 8 then removed, so each version only has one of them.
 */
export function graphFileOption(ffmpeg: string): Promise<string> {
  let option = graphOptionCache.get(ffmpeg);
  if (!option) {
    option = new Promise((resolve) => {
      execFile(ffmpeg, ['-version'], (err, stdout) => {
        const major = err ? null : parseFfmpegMajor(stdout);
        resolve(major !== null && major < 7 ? '-filter_complex_script' : '-/filter_complex');
      });
    });
    graphOptionCache.set(ffmpeg, option);
  }
  return option;
}

export function hasFilter(ffmpeg: string, name: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      ffmpeg,
      ['-hide_banner', '-filters'],
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        resolve(!err && new RegExp(`\\s${name}\\s`).test(stdout));
      },
    );
  });
}

/** Measures a clip's spoken loudness, so normalization is a fixed gain that cannot pump or jump. */
export async function measureLoudness(
  ffmpeg: string,
  source: string,
  fromSeconds: number,
  lengthSeconds: number,
  {
    signal,
    tracker,
  }: { signal?: AbortSignal | undefined; tracker?: ProcessTracker | undefined } = {},
): Promise<number> {
  let output = '';
  await runFfmpeg(
    ffmpeg,
    [
      ...UNTRUSTED_INPUT_ARGS,
      '-ss',
      fromSeconds.toFixed(6),
      '-t',
      lengthSeconds.toFixed(6),
      '-i',
      source,
      '-vn',
      '-af',
      'loudnorm=print_format=json',
      '-f',
      'null',
      '-',
    ],
    {
      signal,
      tracker,
      onLogLine: (line) => {
        output += `${line}\n`;
      },
    },
  );
  const match = /"input_i"\s*:\s*"(-?[\d.]+|-inf)"/.exec(output);
  return match?.[1] && match[1] !== '-inf' ? Number(match[1]) : Number.NEGATIVE_INFINITY;
}

export interface RenderOptions {
  ffmpeg: string;
  state: TimelineState;
  sources: ReadonlyMap<string, RenderSource>;
  width: number;
  height: number;
  burnCaptions: boolean;
  /** A directory that survives a retry, so finished chunks are not rendered again. */
  workDir: string;
  output: string;
  crf?: number;
  signal?: AbortSignal | undefined;
  tracker?: ProcessTracker | undefined;
  onProgress?: ((fraction: number) => void) | undefined;
  onLog?: ((line: string) => void) | undefined;
  /** Chunks already finished, by index, from an earlier attempt. */
  finished?: ReadonlySet<number> | undefined;
  onChunkFinished?: ((index: number) => void) | undefined;
}

export async function renderTimeline(options: RenderOptions): Promise<void> {
  const { ffmpeg, state, sources, width, height, burnCaptions, workDir, output } = options;
  const { signal, tracker, onProgress, onLog, finished, onChunkFinished, crf } = options;

  const clips = state.tracks
    .filter((track) => !track.muted)
    .flatMap((track) => track.clips)
    .filter(
      (clip): clip is MediaClip => clip.kind === 'media' && clip.enabled && clip.audio.normalize,
    );
  const gains = new Map<string, number>();
  for (const clip of clips) {
    const source = sources.get(clip.sourceMediaId);
    if (!source?.hasAudio) continue;
    const measured = await measureLoudness(
      ffmpeg,
      source.path,
      clip.sourceIn / TICKS_PER_SECOND,
      (clip.sourceOut - clip.sourceIn) / TICKS_PER_SECOND,
      { signal, tracker },
    );
    const gain = normalizationGain(measured);
    gains.set(clip.id, gain);
    onLog?.(`normalize ${clip.id}: measured ${measured} LUFS, gain ${gain.toFixed(2)} dB`);
  }

  const chunks = planRenderChunks(state);
  const total = chunks.at(-1)?.end ?? 0;
  // Leaves room for joining and uploading, so 100% is not shown before the file exists.
  const report = (done: number) => onProgress?.(0.02 + (done / total) * 0.9);
  const files: string[] = [];
  let doneTicks = 0;

  for (const chunk of chunks) {
    const file = join(workDir, `chunk-${String(chunk.index).padStart(5, '0')}.mkv`);
    files.push(file);
    const length = chunk.end - chunk.start;
    if (finished?.has(chunk.index)) {
      doneTicks += length;
      report(doneTicks);
      continue;
    }
    let assPath: string | null = null;
    if (burnCaptions) {
      const ass = buildAssSubtitles(state, chunk, width, height);
      if (ass) {
        assPath = join(workDir, `chunk-${chunk.index}.ass`);
        await writeFile(assPath, ass);
      }
    }
    const { graph, args } = buildChunkCommand(state, {
      chunk,
      sources,
      width,
      height,
      gains,
      assPath,
      output: file,
      ...(crf === undefined ? {} : { crf }),
    });
    const graphPath = join(workDir, `chunk-${chunk.index}.graph`);
    await writeFile(graphPath, graph);
    onLog?.(`chunk ${chunk.index}: ${chunk.start} to ${chunk.end}`);
    const before = doneTicks;
    // The graph goes in a file: long timelines would overflow an argument list.
    const inputEnd = args.indexOf('-map');
    const graphOption = await graphFileOption(ffmpeg);
    await runFfmpeg(
      ffmpeg,
      [...args.slice(0, inputEnd), graphOption, graphPath, ...args.slice(inputEnd)],
      {
        signal,
        tracker,
        onProgress: (position) => report(before + Math.min(length, position * TICKS_PER_SECOND)),
      },
    );
    doneTicks += length;
    report(doneTicks);
    onChunkFinished?.(chunk.index);
  }

  const list = join(workDir, 'chunks.txt');
  await writeFile(list, files.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'));
  onLog?.(`joining ${files.length} chunks`);
  await runFfmpeg(
    ffmpeg,
    [
      '-protocol_whitelist',
      'file,pipe',
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
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      output,
    ],
    { signal, tracker },
  );
  onProgress?.(0.95);
}
