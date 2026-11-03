import { TICKS_PER_SECOND, ticksPerFrame } from '@agent-edit/shared';
import { UNTRUSTED_INPUT_ARGS } from './ffmpeg.js';
import { clipEnd, timelineCaptions, timelineDuration } from '@agent-edit/timeline-engine';
import type { MediaClip, TimelineState, TrackType } from '@agent-edit/validation';

export interface RenderSource {
  path: string;
  hasAudio: boolean;
}

export interface RenderChunk {
  index: number;
  /** Ticks on the timeline. */
  start: number;
  end: number;
}

export interface ChunkOptions {
  maxSeconds?: number;
  maxClips?: number;
}

const VISUAL_BOTTOM_UP: readonly TrackType[] = ['VIDEO', 'BROLL', 'OVERLAYS'];
const NORMALIZE_TARGET_LUFS = -16;
const MAX_NORMALIZE_GAIN_DB = 20;

const seconds = (ticks: number) => (ticks / TICKS_PER_SECOND).toFixed(6);

function audible(state: TimelineState, sources: ReadonlyMap<string, RenderSource>) {
  return state.tracks
    .filter((track) => !track.muted && track.type !== 'CAPTIONS')
    .flatMap((track) =>
      track.clips
        .filter(
          (clip): clip is MediaClip =>
            clip.kind === 'media' &&
            clip.enabled &&
            clip.volume > 0 &&
            track.volume > 0 &&
            sources.get(clip.sourceMediaId)?.hasAudio === true,
        )
        .map((clip) => ({ clip, track })),
    );
}

/** Tracks in compositing order, and only the footage that would be seen. */
function visible(state: TimelineState) {
  return VISUAL_BOTTOM_UP.flatMap((type) =>
    state.tracks.filter((track) => track.type === type),
  ).flatMap((track) =>
    track.clips
      .filter((clip): clip is MediaClip => clip.kind === 'media' && clip.enabled)
      .map((clip) => ({ clip, track })),
  );
}

/** Times a chunk may not start at, because a fade is running across them. */
function insideTransition(state: TimelineState, time: number): number | null {
  for (const { clip } of visible(state)) {
    if (clip.transitionIn && time > clip.start && time < clip.start + clip.transitionIn.duration) {
      return clip.start + clip.transitionIn.duration;
    }
    const outStart = clipEnd(clip) - (clip.transitionOut?.duration ?? 0);
    if (clip.transitionOut && time > outStart && time < clipEnd(clip)) return clipEnd(clip);
  }
  return null;
}

/**
 * Splits a timeline into stretches rendered by separate FFmpeg processes. One command for a long edit
 * would hold a decoder open for every clip at once, and memory would grow with clip count. Chunks keep
 * it flat, and a retry repeats only the chunk that failed.
 */
export function planRenderChunks(
  state: TimelineState,
  { maxSeconds = 300, maxClips = 24 }: ChunkOptions = {},
): RenderChunk[] {
  const duration = timelineDuration(state);
  const frame = ticksPerFrame(state.frameRate);
  const maxLength = Math.max(frame, Math.floor((maxSeconds * TICKS_PER_SECOND) / frame) * frame);
  const media = state.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.kind === 'media')
    .sort((a, b) => a.start - b.start);

  const chunks: RenderChunk[] = [];
  let start = 0;
  while (start < duration) {
    let end = Math.min(duration, start + maxLength);
    const overlapping = media.filter((clip) => clip.start < end && clipEnd(clip) > start);
    if (overlapping.length > maxClips) {
      // Ends where the clip after the limit begins, so it opens the next chunk.
      const limit = overlapping[maxClips]!;
      if (limit.start > start) end = limit.start;
    }
    // Pushed forward out of any fade, so one is never split between two processes.
    for (let guard = 0; guard < 100; guard++) {
      const later = insideTransition(state, end);
      if (later === null) break;
      end = later;
    }
    chunks.push({ index: chunks.length, start, end: Math.min(end, duration) });
    start = Math.min(end, duration);
  }
  return chunks;
}

/** ASS needs braces and backslashes neutralised, or caption text could restyle or inject tags. */
export function escapeAssText(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/\\/g, '\u2216')
    .replace(/[{}]/g, (brace) => (brace === '{' ? '(' : ')'))
    .replace(/\n/g, '\\N');
}

function assTime(ticks: number): string {
  const centis = Math.round((ticks / TICKS_PER_SECOND) * 100);
  const hours = Math.floor(centis / 360_000);
  const minutes = Math.floor(centis / 6000) % 60;
  const secs = Math.floor(centis / 100) % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${hours}:${pad(minutes)}:${pad(secs)}.${pad(centis % 100)}`;
}

/** BBGGRR with ASS's inverted alpha: 00 is opaque. */
function assColor(hex: string): string {
  const value = hex.replace('#', '');
  const [r, g, b] = [value.slice(0, 2), value.slice(2, 4), value.slice(4, 6)];
  const alpha = value.length === 8 ? 255 - Number.parseInt(value.slice(6, 8), 16) : 0;
  return `&H${alpha.toString(16).padStart(2, '0')}${b}${g}${r}&`.toUpperCase();
}

const ASS_ALIGNMENT = { top: 8, middle: 5, bottom: 2 } as const;

/** Captions for one chunk, timed from its start. Each caption's style comes from the clip itself. */
export function buildAssSubtitles(
  state: TimelineState,
  chunk: RenderChunk,
  width: number,
  height: number,
): string | null {
  const captions = timelineCaptions(state).filter(
    (clip) => clip.start < chunk.end && clipEnd(clip) > chunk.start,
  );
  if (captions.length === 0) return null;

  // Sizes are stored against the timeline's height, so an export at another size looks the same.
  const scale = height / state.height;
  const styles = new Map<string, string>();
  const styleName = (clip: (typeof captions)[number]) => {
    const key = JSON.stringify(clip.style);
    let name = styles.get(key);
    if (!name) {
      name = `S${styles.size}`;
      styles.set(key, name);
    }
    return name;
  };
  const events = captions.map((clip) => {
    const from = Math.max(0, clip.start - chunk.start);
    const to = Math.min(chunk.end, clipEnd(clip)) - chunk.start;
    return `Dialogue: 0,${assTime(from)},${assTime(to)},${styleName(clip)},,0,0,0,,${escapeAssText(clip.text)}`;
  });
  const styleLines = captions
    .filter(
      (clip, i) =>
        captions.findIndex((o) => JSON.stringify(o.style) === JSON.stringify(clip.style)) === i,
    )
    .map((clip) => {
      const { font, size, color, background, position } = clip.style;
      const box = background !== null;
      const name = styleName(clip);
      // Commas and newlines would break out of this format's fields.
      const safeFont = font.replace(/[,\r\n]/g, ' ');
      return [
        `Style: ${name},${safeFont},${Math.round(size * scale)},${assColor(color)},${assColor(color)}`,
        `${assColor(background ?? '#000000')},${assColor(background ?? '#000000')},0,0,0,0,100,100,0,0`,
        `${box ? 3 : 1},${box ? 6 : 2},0,${ASS_ALIGNMENT[position]},${Math.round(width * 0.05)},${Math.round(width * 0.05)},${Math.round(height * 0.06)},1`,
      ].join(',');
    });
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styleLines,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

function quoteFilterPath(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/** atempo only accepts 0.5 to 2, so larger changes chain. */
function atempoChain(speed: number): string[] {
  const filters: string[] = [];
  let remaining = speed;
  while (remaining > 2) {
    filters.push('atempo=2');
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) > 1e-6) filters.push(`atempo=${remaining.toFixed(6)}`);
  return filters;
}

export interface ChunkCommandOptions {
  chunk: RenderChunk;
  sources: ReadonlyMap<string, RenderSource>;
  /** Output size. Differing from the timeline's shape letterboxes rather than crops. */
  width: number;
  height: number;
  /** Measured loudness of each normalized clip, in dB of gain to apply. */
  gains?: ReadonlyMap<string, number>;
  assPath?: string | null;
  output: string;
  crf?: number;
}

/** Everything FFmpeg needs for one chunk. Pure, so a timeline's render can be tested as text. */
export function buildChunkCommand(state: TimelineState, options: ChunkCommandOptions) {
  const { chunk, sources, width, height, gains, assPath, output, crf = 20 } = options;
  const rate = `${state.frameRate.num}/${state.frameRate.den}`;
  const length = (chunk.end - chunk.start) / TICKS_PER_SECOND;
  const inputs: string[] = [];
  const graph: string[] = [];
  let inputCount = 0;

  const addInput = (clip: MediaClip, sliceStart: number, sliceEnd: number) => {
    const source = sources.get(clip.sourceMediaId);
    if (!source) throw new Error(`No source file for media ${clip.sourceMediaId}`);
    const sourceFrom = clip.sourceIn + (sliceStart - clip.start) * clip.speed;
    const sourceLength = (sliceEnd - sliceStart) * clip.speed;
    inputs.push(
      ...UNTRUSTED_INPUT_ARGS,
      '-ss',
      seconds(sourceFrom),
      '-t',
      // A little over, so the trim below rather than the demuxer decides the last frame.
      (sourceLength / TICKS_PER_SECOND + 0.5).toFixed(6),
      '-i',
      source.path,
    );
    return inputCount++;
  };

  graph.push(
    `color=c=black:s=${state.width}x${state.height}:r=${rate}:d=${length.toFixed(6)},format=yuv420p[base]`,
  );
  let top = 'base';
  let label = 0;

  for (const { clip } of visible(state)) {
    if (clip.start >= chunk.end || clipEnd(clip) <= chunk.start) continue;
    const sliceStart = Math.max(clip.start, chunk.start);
    const sliceEnd = Math.min(clipEnd(clip), chunk.end);
    const sliceLength = (sliceEnd - sliceStart) / TICKS_PER_SECOND;
    const offset = (sliceStart - chunk.start) / TICKS_PER_SECOND;
    const input = addInput(clip, sliceStart, sliceEnd);
    const { x, y, scale, rotation, opacity } = clip.transform;

    const filters = [
      'setpts=PTS-STARTPTS',
      `setpts=PTS/${clip.speed.toFixed(6)}`,
      `fps=${rate}`,
      `trim=duration=${sliceLength.toFixed(6)}`,
      'setpts=PTS-STARTPTS',
      // Fits inside the frame at scale 1, exactly as the preview's object-fit: contain does.
      `scale=w=trunc(${state.width}*${scale.toFixed(6)}/2)*2:h=trunc(${state.height}*${scale.toFixed(6)}/2)*2:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    ];
    const fadeIn = clip.transitionIn && sliceStart === clip.start ? clip.transitionIn : null;
    const fadeOut = clip.transitionOut && sliceEnd === clipEnd(clip) ? clip.transitionOut : null;
    const needsAlpha = opacity < 1 || rotation !== 0 || fadeIn !== null || fadeOut !== null;
    if (needsAlpha) filters.push('format=yuva420p');
    if (rotation !== 0) {
      const radians = ((rotation * Math.PI) / 180).toFixed(6);
      filters.push(`rotate=${radians}:ow=rotw(${radians}):oh=roth(${radians}):c=none`);
    }
    if (opacity < 1) filters.push(`colorchannelmixer=aa=${opacity.toFixed(4)}`);
    if (fadeIn) {
      filters.push(`fade=t=in:st=0:d=${(fadeIn.duration / TICKS_PER_SECOND).toFixed(6)}:alpha=1`);
    }
    if (fadeOut) {
      const d = fadeOut.duration / TICKS_PER_SECOND;
      filters.push(
        `fade=t=out:st=${Math.max(0, sliceLength - d).toFixed(6)}:d=${d.toFixed(6)}:alpha=1`,
      );
    }
    filters.push(`setpts=PTS+${offset.toFixed(6)}/TB`);
    graph.push(`[${input}:v:0]${filters.join(',')}[v${label}]`);
    const next = `o${label}`;
    const px = `(W-w)/2+${(x * state.width).toFixed(3)}`;
    const py = `(H-h)/2+${(y * state.height).toFixed(3)}`;
    graph.push(`[${top}][v${label}]overlay=x=${px}:y=${py}:eof_action=pass[${next}]`);
    top = next;
    label++;
  }

  const finishing: string[] = [];
  if (width !== state.width || height !== state.height) {
    finishing.push(
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    );
  }
  if (assPath) finishing.push(`ass=filename=${quoteFilterPath(assPath)}`);
  finishing.push('format=yuv420p', `setsar=1`);
  graph.push(`[${top}]${finishing.join(',')}[video]`);

  const audioLabels: string[] = [];
  for (const { clip, track } of audible(state, sources)) {
    if (clip.start >= chunk.end || clipEnd(clip) <= chunk.start) continue;
    const sliceStart = Math.max(clip.start, chunk.start);
    const sliceEnd = Math.min(clipEnd(clip), chunk.end);
    const sliceLength = (sliceEnd - sliceStart) / TICKS_PER_SECOND;
    const input = addInput(clip, sliceStart, sliceEnd);
    const delayMs = Math.round(((sliceStart - chunk.start) / TICKS_PER_SECOND) * 1000);
    const gainDb = clip.audio.normalize ? (gains?.get(clip.id) ?? 0) : 0;
    const level = clip.volume * track.volume * 10 ** (gainDb / 20);

    // Written against time from the clip's own start, so a fade survives a clip crossing chunks.
    const into = ((sliceStart - clip.start) / TICKS_PER_SECOND).toFixed(6);
    const remaining = ((clipEnd(clip) - sliceStart) / TICKS_PER_SECOND).toFixed(6);
    const terms = [level.toFixed(6)];
    if (clip.audio.fadeIn > 0) {
      terms.push(`min(1,(t+${into})/${(clip.audio.fadeIn / TICKS_PER_SECOND).toFixed(6)})`);
    }
    if (clip.audio.fadeOut > 0) {
      terms.push(
        `min(1,max(0,${remaining}-t)/${(clip.audio.fadeOut / TICKS_PER_SECOND).toFixed(6)})`,
      );
    }
    const filters = ['asetpts=PTS-STARTPTS', ...atempoChain(clip.speed)];
    filters.push(`atrim=duration=${sliceLength.toFixed(6)}`, 'asetpts=PTS-STARTPTS');
    if (clip.audio.denoise) filters.push('afftdn=nf=-25');
    filters.push(`volume=volume='${terms.join('*')}':eval=frame`);
    filters.push('aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo');
    if (delayMs > 0) filters.push(`adelay=${delayMs}:all=1`);
    const name = `a${audioLabels.length}`;
    graph.push(`[${input}:a:0]${filters.join(',')}[${name}]`);
    audioLabels.push(name);
  }

  if (audioLabels.length === 0) {
    graph.push(
      `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${length.toFixed(6)}[audio]`,
    );
  } else {
    const mixed = audioLabels.map((name) => `[${name}]`).join('');
    // normalize=0: amix would otherwise lower every clip as more play at once.
    const mixer =
      audioLabels.length > 1
        ? `${mixed}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,`
        : `${mixed}`;
    graph.push(`${mixer}apad,atrim=duration=${length.toFixed(6)}[audio]`);
  }

  const args = [
    ...inputs,
    '-map',
    '[video]',
    '-map',
    '[audio]',
    '-r',
    rate,
    '-t',
    length.toFixed(6),
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    String(crf),
    '-pix_fmt',
    'yuv420p',
    // PCM joins between chunks without the gap each AAC encode would add.
    '-c:a',
    'pcm_s16le',
    '-ar',
    '48000',
    '-f',
    'matroska',
    output,
  ];
  return { graph: graph.join(';\n'), args };
}

export function normalizationGain(measuredLufs: number): number {
  if (!Number.isFinite(measuredLufs)) return 0;
  const gain = NORMALIZE_TARGET_LUFS - measuredLufs;
  return Math.max(-MAX_NORMALIZE_GAIN_DB, Math.min(MAX_NORMALIZE_GAIN_DB, gain));
}
