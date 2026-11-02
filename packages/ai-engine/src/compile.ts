import {
  newId,
  secondsToTicks,
  snapToFrame,
  ticksPerFrame,
  ticksToSeconds,
} from '@agent-edit/shared';
import {
  TimelineError,
  applyOperations,
  clipEnd,
  createCaptionClip,
  createMediaClip,
  cutRangesOperations,
  findClip,
  firstTrackOfType,
  isRangeFree,
  speedRangeOperations,
  timelineDuration,
  trimOperation,
  type MediaLookup,
} from '@agent-edit/timeline-engine';
import type {
  AgentPlan,
  CompiledPlanStep,
  MediaClip,
  PlanStep,
  ShortProposal,
  TimelineOperation,
  TimelineState,
} from '@agent-edit/validation';
import { findMomentsWithRules } from './moments.js';
import { findRepeatedTakes, normalizeWords } from './repeated-takes.js';

export interface SourceSegment {
  mediaId: string;
  /** Ticks in the source file. */
  start: number;
  end: number;
  text: string;
  words: ReadonlyArray<{ w: string; s: number; e: number }>;
}

export interface SourceRange {
  mediaId: string;
  start: number;
  end: number;
}

export interface LibraryItem {
  id: string;
  name: string;
  folder: string | null;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** Words describing the footage: scene summaries and transcript, for matching B-roll. */
  description: string;
}

export interface HighlightMoment extends SourceRange {
  score: number;
  title: string | null;
  reason: string | null;
}

export interface CompileContext {
  segments: readonly SourceSegment[];
  silences: readonly SourceRange[];
  moments: readonly HighlightMoment[];
  library: ReadonlyMap<string, LibraryItem>;
  /** A horizontal position for a subject, when a vision model can give one. */
  subjectFraming?: ((mediaId: string, time: number) => number | null) | undefined;
}

export interface CompiledPlan {
  steps: CompiledPlanStep[];
  ops: TimelineOperation[];
  shorts: ShortProposal[];
  state: TimelineState;
}

/** Why a step cannot run, in words shown to the user. */
class StepRejected extends Error {}

const DEFAULT_MIN_SILENCE_SECONDS = 0.7;
/** Keeps a little air, so cuts do not clip the start and end of words. */
const SILENCE_PADDING_SECONDS = 0.12;
const CAPTION_MAX_CHARS = 42;
const BROLL_SECONDS = 4;
const SHORT_MIN_SECONDS = 15;
const SHORT_MAX_SECONDS = 60;

/** The VIDEO track is the edit's spine: transcript and silence map onto the footage there. */
function spineClips(state: TimelineState): MediaClip[] {
  return (firstTrackOfType(state, 'VIDEO')?.clips ?? []).filter(
    (clip): clip is MediaClip => clip.kind === 'media',
  );
}

/** Where a stretch of source footage currently sits on the timeline, if it is used at all. */
export function sourceToTimeline(
  state: TimelineState,
  range: SourceRange,
): Array<{ start: number; end: number; clip: MediaClip }> {
  const found: Array<{ start: number; end: number; clip: MediaClip }> = [];
  for (const clip of spineClips(state)) {
    if (clip.sourceMediaId !== range.mediaId) continue;
    const from = Math.max(range.start, clip.sourceIn);
    const to = Math.min(range.end, clip.sourceOut);
    if (to <= from) continue;
    found.push({
      start: clip.start + (from - clip.sourceIn) / clip.speed,
      end: clip.start + (to - clip.sourceIn) / clip.speed,
      clip,
    });
  }
  return found;
}

function mergeRanges(ranges: Array<{ start: number; end: number }>) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function musicTrackIds(state: TimelineState): Set<string> {
  return new Set(state.tracks.filter((t) => t.type === 'MUSIC').map((t) => t.id));
}

function seconds(value: number): string {
  return `${ticksToSeconds(value).toFixed(1)}s`;
}

interface StepOutcome {
  ops: TimelineOperation[];
  summary: string;
  shorts?: ShortProposal[];
}

type Compiler = (state: TimelineState, step: PlanStep, context: CompileContext) => StepOutcome;

function requireTimes(step: PlanStep, state: TimelineState) {
  if (step.start === null || step.end === null) {
    throw new StepRejected('The plan did not say which part of the timeline to change');
  }
  const duration = timelineDuration(state);
  const start = Math.max(0, secondsToTicks(step.start));
  const end = Math.min(duration, secondsToTicks(step.end));
  if (end <= start) throw new StepRejected('That time range is outside the timeline');
  return { start, end };
}

function requireClipId(step: PlanStep, state: TimelineState) {
  if (!step.clipId) throw new StepRejected('The plan did not name a clip');
  const located = findClip(state, step.clipId);
  // Models invent ids, and plans go stale. Either way there is nothing safe to do.
  if (!located) throw new StepRejected(`Clip ${step.clipId} is not on the timeline`);
  return located;
}

const removeSilence: Compiler = (state, step, context) => {
  const minimum = secondsToTicks(step.seconds ?? DEFAULT_MIN_SILENCE_SECONDS);
  const padding = secondsToTicks(SILENCE_PADDING_SECONDS);
  const frame = ticksPerFrame(state.frameRate);
  const ranges = context.silences
    .filter((silence) => silence.end - silence.start >= minimum)
    .flatMap((silence) => sourceToTimeline(state, silence))
    .map(({ start, end }) => ({ start: start + padding, end: end - padding }))
    .filter(({ start, end }) => end - start >= frame * 2);
  if (context.silences.length === 0) {
    throw new StepRejected('Silence analysis has found nothing on this footage');
  }
  if (ranges.length === 0) {
    return { ops: [], summary: 'No pause on the timeline is long enough to remove' };
  }
  const merged = mergeRanges(ranges);
  const total = merged.reduce((sum, range) => sum + range.end - range.start, 0);
  return {
    ops: cutRangesOperations(state, merged, { excludeTrackIds: musicTrackIds(state) }),
    summary: `Remove ${merged.length} pause${merged.length === 1 ? '' : 's'}, ${seconds(total)} in total`,
  };
};

const removeRepeatedTakes: Compiler = (state, _step, context) => {
  if (context.segments.length === 0) {
    throw new StepRejected('This needs a transcript, and the footage does not have one yet');
  }
  const perMedia = new Map<string, SourceSegment[]>();
  for (const segment of context.segments) {
    perMedia.set(segment.mediaId, [...(perMedia.get(segment.mediaId) ?? []), segment]);
  }
  const ranges: Array<{ start: number; end: number }> = [];
  const lines: string[] = [];
  for (const [mediaId, segments] of perMedia) {
    for (const take of findRepeatedTakes(segments)) {
      const mapped = sourceToTimeline(state, { mediaId, start: take.start, end: take.end });
      if (mapped.length === 0) continue;
      ranges.push(...mapped.map(({ start, end }) => ({ start, end })));
      lines.push(take.text);
    }
  }
  if (ranges.length === 0) return { ops: [], summary: 'No repeated takes found on the timeline' };
  const preview = lines[0]!.length > 60 ? `${lines[0]!.slice(0, 60)}…` : lines[0]!;
  return {
    ops: cutRangesOperations(state, mergeRanges(ranges), { excludeTrackIds: musicTrackIds(state) }),
    summary: `Remove ${ranges.length} earlier take${ranges.length === 1 ? '' : 's'}, such as "${preview}"`,
  };
};

const cutRange: Compiler = (state, step) => {
  const { start, end } = requireTimes(step, state);
  return {
    ops: cutRangesOperations(state, [{ start, end }], { excludeTrackIds: musicTrackIds(state) }),
    summary: `Remove ${seconds(start)} to ${seconds(end)}`,
  };
};

const speedRange: Compiler = (state, step) => {
  const { start, end } = requireTimes(step, state);
  const speed = step.speed ?? 1.25;
  return {
    ops: speedRangeOperations(state, start, end, speed),
    summary: `Play ${seconds(start)} to ${seconds(end)} at ${speed}x`,
  };
};

const cutToDuration: Compiler = (state, step, context) => {
  if (!step.seconds) throw new StepRejected('The plan did not give a target length');
  const target = secondsToTicks(step.seconds);
  const total = timelineDuration(state);
  if (total <= target) {
    return { ops: [], summary: `The edit is already ${seconds(total)}, within ${seconds(target)}` };
  }
  if (context.segments.length === 0) {
    throw new StepRejected('Choosing what to keep needs a transcript, and there is none yet');
  }

  // Rank each stretch of speech by the strongest moment it overlaps, then keep the best until the
  // target is met. Everything kept stays in its original order, so the story still reads.
  const spoken = context.segments.flatMap((segment) =>
    sourceToTimeline(state, segment).map(({ start, end }) => {
      const score = context.moments
        .filter((moment) => moment.mediaId === segment.mediaId)
        .filter((moment) => moment.start < segment.end && moment.end > segment.start)
        .reduce((best, moment) => Math.max(best, moment.score), 0);
      return { start, end, score };
    }),
  );
  const ranked = [...spoken].sort((a, b) => b.score - a.score || a.start - b.start);
  const keep: Array<{ start: number; end: number }> = [];
  let kept = 0;
  for (const range of ranked) {
    if (kept >= target) break;
    keep.push(range);
    kept += range.end - range.start;
  }
  const kept_ = mergeRanges(keep);
  const remove: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const range of kept_) {
    if (range.start > cursor) remove.push({ start: cursor, end: range.start });
    cursor = range.end;
  }
  if (cursor < total) remove.push({ start: cursor, end: total });
  return {
    ops: cutRangesOperations(state, remove, { excludeTrackIds: musicTrackIds(state) }),
    summary: `Cut from ${seconds(total)} to about ${seconds(kept)}, keeping the strongest speech`,
  };
};

function dialogueClips(state: TimelineState): MediaClip[] {
  return state.tracks
    .filter((track) => !track.locked && (track.type === 'VIDEO' || track.type === 'AUDIO'))
    .flatMap((track) => track.clips)
    .filter((clip): clip is MediaClip => clip.kind === 'media');
}

const normalizeDialogue: Compiler = (state) => {
  const clips = dialogueClips(state).filter((clip) => !clip.audio.normalize);
  return {
    ops: clips.map((clip) => ({ op: 'update_audio', clipId: clip.id, normalize: true })),
    summary:
      clips.length > 0
        ? `Normalize loudness on ${clips.length} dialogue clip${clips.length === 1 ? '' : 's'} in the final render`
        : 'Dialogue is already normalized',
  };
};

const reduceNoise: Compiler = (state) => {
  const clips = dialogueClips(state).filter((clip) => !clip.audio.denoise);
  return {
    ops: clips.map((clip) => ({ op: 'update_audio', clipId: clip.id, denoise: true })),
    summary: `Reduce noise on ${clips.length} clip${clips.length === 1 ? '' : 's'} in the final render`,
  };
};

const setTrackVolume: Compiler = (state, step) => {
  if (step.volume === null) throw new StepRejected('The plan did not give a volume');
  const type = step.trackType ?? 'MUSIC';
  const clips = state.tracks
    .filter((track) => track.type === type && !track.locked)
    .flatMap((track) => track.clips);
  if (clips.length === 0) throw new StepRejected(`There are no clips on the ${type} track`);
  const volume = step.volume;
  return {
    ops: clips.map((clip) => ({ op: 'change_volume', clipId: clip.id, volume })),
    summary: `Set ${clips.length} ${type} clip${clips.length === 1 ? '' : 's'} to ${Math.round(volume * 100)}% volume`,
  };
};

/** Breaks a sentence into readable caption lines, timed from its words. */
function captionChunks(segment: SourceSegment) {
  const chunks: Array<{ start: number; end: number; text: string }> = [];
  if (segment.words.length === 0) {
    return [{ start: segment.start, end: segment.end, text: segment.text }];
  }
  let words: Array<{ w: string; s: number; e: number }> = [];
  const flush = () => {
    const first = words[0];
    const last = words.at(-1);
    if (first && last) {
      chunks.push({
        start: secondsToTicks(first.s),
        end: secondsToTicks(last.e),
        text: words.map((word) => word.w).join(' '),
      });
    }
    words = [];
  };
  for (const word of segment.words) {
    const length = words.map((item) => item.w).join(' ').length + word.w.length + 1;
    if (length > CAPTION_MAX_CHARS) flush();
    words.push(word);
  }
  flush();
  return chunks;
}

const addCaptions: Compiler = (state, _step, context) => {
  if (context.segments.length === 0) {
    throw new StepRejected('Subtitles need a transcript, and the footage does not have one yet');
  }
  const track = firstTrackOfType(state, 'CAPTIONS');
  if (!track) throw new StepRejected('This timeline has no captions track');
  if (track.locked) throw new StepRejected('The captions track is locked');
  if (track.clips.length > 0) {
    throw new StepRejected('The captions track already has captions. Remove them first.');
  }
  const frame = ticksPerFrame(state.frameRate);
  const placed: Array<{ start: number; end: number; text: string }> = [];
  for (const segment of context.segments) {
    for (const chunk of captionChunks(segment)) {
      for (const { start, end } of sourceToTimeline(state, {
        mediaId: segment.mediaId,
        start: chunk.start,
        end: chunk.end,
      })) {
        placed.push({ start, end, text: chunk.text });
      }
    }
  }
  placed.sort((a, b) => a.start - b.start);
  const ops: TimelineOperation[] = [];
  let cursor = 0;
  for (const [index, item] of placed.entries()) {
    const start = Math.max(cursor, snapToFrame(item.start, state.frameRate));
    const next = placed[index + 1];
    const limit = next ? snapToFrame(next.start, state.frameRate) : Number.MAX_SAFE_INTEGER;
    const end = Math.min(Math.max(snapToFrame(item.end, state.frameRate), start + frame), limit);
    if (end <= start) continue;
    ops.push({
      op: 'add_caption',
      trackId: track.id,
      clip: createCaptionClip({ start, duration: end - start, text: item.text }, state.frameRate),
    });
    cursor = end;
  }
  if (ops.length === 0) throw new StepRejected('None of the transcript is on the timeline');
  return {
    ops,
    summary: `Add ${ops.length} caption${ops.length === 1 ? '' : 's'} from the transcript`,
  };
};

function scoreMatch(queryWords: ReadonlySet<string>, item: LibraryItem): number {
  const haystack = new Set(normalizeWords(`${item.name} ${item.folder ?? ''} ${item.description}`));
  let score = 0;
  for (const word of queryWords) if (haystack.has(word)) score++;
  return score;
}

const addBroll: Compiler = (state, step, context) => {
  const track = firstTrackOfType(state, 'BROLL');
  if (!track) throw new StepRejected('This timeline has no B-roll track');
  if (track.locked) throw new StepRejected('The B-roll track is locked');
  const usedOnSpine = new Set(spineClips(state).map((clip) => clip.sourceMediaId));
  const candidates = [...context.library.values()].filter((item) => !usedOnSpine.has(item.id));
  if (candidates.length === 0) {
    throw new StepRejected('There is no other footage in the library to use as B-roll');
  }

  const queryWords = new Set(normalizeWords(step.query ?? ''));
  const named = step.mediaId ? context.library.get(step.mediaId) : undefined;
  const ranked = candidates
    .map((item) => ({ item, score: queryWords.size > 0 ? scoreMatch(queryWords, item) : 0 }))
    .sort((a, b) => b.score - a.score);
  const choices = named
    ? [named]
    : queryWords.size > 0 && ranked[0]!.score > 0
      ? ranked.filter((entry) => entry.score > 0).map((entry) => entry.item)
      : candidates;

  // Where to place it: an explicit time, or wherever the dialogue mentions the subject or the clip.
  const spots: Array<{ start: number; reason: string }> = [];
  if (step.start !== null) {
    spots.push({ start: secondsToTicks(step.start), reason: 'where the plan asked' });
  } else {
    const subject =
      queryWords.size > 0
        ? queryWords
        : new Set(choices.flatMap((item) => normalizeWords(`${item.name} ${item.description}`)));
    for (const segment of context.segments) {
      const words = normalizeWords(segment.text);
      if (!words.some((word) => subject.has(word) && word.length > 3)) continue;
      const [place] = sourceToTimeline(state, segment);
      if (place)
        spots.push({ start: place.start, reason: `when you say "${segment.text.slice(0, 40)}"` });
    }
  }
  if (spots.length === 0) {
    const what = step.query ? `"${step.query}"` : 'your B-roll footage';
    throw new StepRejected(
      `The transcript never mentions ${what}, so there is no clear place for it`,
    );
  }

  const ops: TimelineOperation[] = [];
  let working = track;
  let choice = 0;
  const used: string[] = [];
  for (const spot of spots.slice(0, 8)) {
    const item = choices[choice % choices.length]!;
    const length = Math.min(secondsToTicks(BROLL_SECONDS), item.duration);
    const start = snapToFrame(spot.start, state.frameRate);
    const end = start + snapToFrame(length, state.frameRate);
    if (!isRangeFree(working, start, end)) continue;
    const clip = createMediaClip(
      { sourceMediaId: item.id, start, sourceIn: 0, sourceOut: length, volume: 0 },
      state.frameRate,
    );
    ops.push({ op: 'add_broll', trackId: track.id, clip });
    working = { ...working, clips: [...working.clips, clip].sort((a, b) => a.start - b.start) };
    used.push(item.name);
    choice++;
  }
  if (ops.length === 0) throw new StepRejected('The B-roll track is already full at those points');
  return {
    ops,
    summary: `Add ${ops.length} B-roll clip${ops.length === 1 ? '' : 's'} from ${[...new Set(used)].join(', ')}`,
  };
};

const addMusic: Compiler = (state, step, context) => {
  const track = firstTrackOfType(state, 'MUSIC');
  if (!track) throw new StepRejected('This timeline has no music track');
  if (track.locked) throw new StepRejected('The music track is locked');
  const duration = timelineDuration(state);
  if (duration === 0) throw new StepRejected('The timeline is empty');
  const queryWords = new Set([...normalizeWords(step.query ?? ''), 'music', 'track', 'song']);
  const used = new Set(spineClips(state).map((clip) => clip.sourceMediaId));
  const candidates = [...context.library.values()].filter(
    (item) => item.hasAudio && !used.has(item.id),
  );
  const item = step.mediaId
    ? context.library.get(step.mediaId)
    : candidates
        .map((entry) => ({ entry, score: scoreMatch(queryWords, entry) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)[0]?.entry;
  if (!item) {
    throw new StepRejected(
      'No music in the library. Upload a track with "music" in its name or folder.',
    );
  }
  const length = Math.min(duration, item.duration);
  const clip = createMediaClip(
    {
      sourceMediaId: item.id,
      start: 0,
      sourceIn: 0,
      sourceOut: length,
      volume: step.volume ?? 0.2,
    },
    state.frameRate,
  );
  const fade = Math.min(secondsToTicks(2), Math.floor(clip.duration / 4));
  return {
    ops: [
      { op: 'add_music', trackId: track.id, clip },
      { op: 'update_audio', clipId: clip.id, fadeIn: fade, fadeOut: fade },
    ],
    summary: `Add "${item.name}" under the edit at ${Math.round((step.volume ?? 0.2) * 100)}% volume`,
  };
};

/** Candidate moments cut from speech at sentence boundaries, as long as each Short should be. */
function speechMoments(context: CompileContext, count: number): HighlightMoment[] {
  const perMedia = new Map<string, SourceSegment[]>();
  for (const segment of context.segments) {
    perMedia.set(segment.mediaId, [...(perMedia.get(segment.mediaId) ?? []), segment]);
  }
  return [...perMedia].flatMap(([mediaId, segments]) => {
    const total = ticksToSeconds(segments.at(-1)!.end - segments[0]!.start);
    const target = Math.min(SHORT_MAX_SECONDS, Math.max(SHORT_MIN_SECONDS, total / count));
    return findMomentsWithRules(
      segments.map((s) => ({
        start: ticksToSeconds(s.start),
        end: ticksToSeconds(s.end),
        text: s.text,
      })),
      [],
      target,
    )
      .filter((moment) => moment.kind === 'highlight')
      .map((moment) => ({
        mediaId,
        start: secondsToTicks(moment.start),
        end: secondsToTicks(moment.end),
        score: moment.score,
        title: moment.title,
        reason: moment.reason,
      }));
  });
}

function chooseShorts(step: PlanStep, context: CompileContext): HighlightMoment[] {
  const count = step.count ?? 3;
  const queryWords = new Set(normalizeWords(step.query ?? ''));
  const inRange = (moment: HighlightMoment) => {
    const length = ticksToSeconds(moment.end - moment.start);
    return length >= SHORT_MIN_SECONDS && length <= SHORT_MAX_SECONDS + 5;
  };
  const relevance = (moment: HighlightMoment) => {
    if (queryWords.size === 0) return 0;
    const text = `${moment.title ?? ''} ${moment.reason ?? ''}`;
    return normalizeWords(text).filter((word) => queryWords.has(word)).length;
  };
  const rank = (moments: HighlightMoment[]) =>
    [...moments].sort(
      (a, b) => relevance(b) - relevance(a) || b.score - a.score || a.start - b.start,
    );
  // Non-overlapping, so each Short has its own material.
  const pick = (candidates: HighlightMoment[]) => {
    const chosen: HighlightMoment[] = [];
    for (const moment of candidates) {
      if (chosen.length >= count) break;
      const overlaps = chosen.some(
        (other) =>
          other.mediaId === moment.mediaId && other.start < moment.end && moment.start < other.end,
      );
      if (!overlaps) chosen.push(moment);
    }
    return chosen;
  };
  const speech = rank(speechMoments(context, count));
  const analysed = pick([...rank(context.moments.filter(inRange)), ...speech]);
  // One long highlight can cover so much that nothing else fits. Sentence-cut moments may then get
  // closer to the number asked for.
  const cut = pick(speech);
  return cut.length > analysed.length ? cut : analysed;
}

const generateShorts: Compiler = (_state, step, context) => {
  if (context.segments.length === 0) {
    throw new StepRejected(
      'Finding Shorts needs a transcript, and the footage does not have one yet',
    );
  }
  const chosen = chooseShorts(step, context);
  if (chosen.length === 0) {
    throw new StepRejected(
      `The footage has no self-contained moment of at least ${SHORT_MIN_SECONDS} seconds`,
    );
  }
  const shorts: ShortProposal[] = chosen.map((moment, index) => {
    const end = Math.min(moment.end, moment.start + secondsToTicks(SHORT_MAX_SECONDS));
    const framing = context.subjectFraming?.(moment.mediaId, (moment.start + end) / 2) ?? null;
    const captions = context.segments
      .filter((s) => s.mediaId === moment.mediaId && s.start < end && s.end > moment.start)
      .flatMap((segment) => captionChunks(segment))
      .filter((chunk) => chunk.start >= moment.start && chunk.end <= end);
    return {
      name: moment.title ? `Short: ${moment.title}`.slice(0, 80) : `Short ${index + 1}`,
      reason: moment.reason ?? 'A self-contained moment',
      sourceMediaId: moment.mediaId,
      sourceIn: moment.start,
      sourceOut: end,
      framing: framing ?? 0,
      framingSource: framing === null ? 'center' : 'vision',
      captions,
    };
  });
  const lengths = shorts.map((short) => seconds(short.sourceOut - short.sourceIn)).join(', ');
  const wanted = step.count ?? 3;
  const shortfall =
    shorts.length < wanted ? `. Asked for ${wanted}, but only this much footage stands alone.` : '';
  return {
    ops: [],
    shorts,
    summary: `Create ${shorts.length} vertical Short${shorts.length === 1 ? '' : 's'} as separate timelines (${lengths})${shortfall}`,
  };
};

const primitive =
  (build: (state: TimelineState, step: PlanStep) => StepOutcome): Compiler =>
  (state, step) =>
    build(state, step);

const trimClip = primitive((state, step) => {
  const { clip } = requireClipId(step, state);
  const ops: TimelineOperation[] = [];
  let working = clip;
  if (step.start !== null) {
    const op = trimOperation(working, 'start', secondsToTicks(step.start), state, null);
    ops.push(op);
    working = applyOperations(state, [op])
      .state.tracks.flatMap((track) => track.clips)
      .find((item) => item.id === clip.id)!;
  }
  if (step.end !== null) {
    ops.push(trimOperation(working, 'end', secondsToTicks(step.end), state, null));
  }
  if (ops.length === 0) throw new StepRejected('The plan did not give new start or end times');
  return { ops, summary: `Trim clip to ${step.start ?? '…'}s–${step.end ?? '…'}s` };
});

const removeClip = primitive((state, step) => {
  const { clip } = requireClipId(step, state);
  return {
    ops: [{ op: 'remove_clip', clipId: clip.id }],
    summary: `Remove the clip at ${seconds(clip.start)}`,
  };
});

const splitClip = primitive((state, step) => {
  const { clip } = requireClipId(step, state);
  if (step.start === null) throw new StepRejected('The plan did not say where to split');
  const at = snapToFrame(secondsToTicks(step.start), state.frameRate);
  if (at <= clip.start || at >= clipEnd(clip)) {
    throw new StepRejected('That split point is outside the clip');
  }
  return {
    ops: [{ op: 'split_clip', clipId: clip.id, at, newClipId: newId('clip') }],
    summary: `Split the clip at ${seconds(at)}`,
  };
});

const moveClip = primitive((state, step) => {
  const { clip } = requireClipId(step, state);
  if (step.start === null) throw new StepRejected('The plan did not say where to move it');
  const start = snapToFrame(secondsToTicks(step.start), state.frameRate);
  return {
    ops: [{ op: 'move_clip', clipId: clip.id, start }],
    summary: `Move the clip to ${seconds(start)}`,
  };
});

const changeTrack = primitive((state, step) => {
  const { clip } = requireClipId(step, state);
  if (!step.trackType) throw new StepRejected('The plan did not say which track');
  const target = firstTrackOfType(state, step.trackType);
  if (!target) throw new StepRejected(`There is no ${step.trackType} track`);
  const start =
    step.start === null ? clip.start : snapToFrame(secondsToTicks(step.start), state.frameRate);
  return {
    ops: [{ op: 'change_track', clipId: clip.id, trackId: target.id, start }],
    summary: `Move the clip to the ${step.trackType} track`,
  };
});

const changeVolume = primitive((state, step) => {
  const { clip } = requireClipId(step, state);
  if (step.volume === null) throw new StepRejected('The plan did not give a volume');
  return {
    ops: [{ op: 'change_volume', clipId: clip.id, volume: step.volume }],
    summary: `Set the clip to ${Math.round(step.volume * 100)}% volume`,
  };
});

const changeSpeed = primitive((state, step) => {
  const { clip } = requireClipId(step, state);
  if (clip.kind !== 'media') throw new StepRejected('Only footage has a speed');
  if (step.speed === null) throw new StepRejected('The plan did not give a speed');
  const duration = Math.max(
    ticksPerFrame(state.frameRate),
    snapToFrame((clip.sourceOut - clip.sourceIn) / step.speed, state.frameRate),
  );
  // Later clips would overlap a slowed clip, so they shift by the same amount.
  const delta = duration - clip.duration;
  const located = findClip(state, clip.id)!;
  const later = located.track.clips.filter((other) => other.start >= clipEnd(clip));
  const shifted: TimelineOperation[] = (delta > 0 ? [...later].reverse() : later).map((other) => ({
    op: 'move_clip',
    clipId: other.id,
    start: other.start + delta,
  }));
  return {
    ops: [{ op: 'change_speed', clipId: clip.id, speed: step.speed, duration }, ...shifted],
    summary: `Play the clip at ${step.speed}x`,
  };
});

const updateTransition = primitive((state, step) => {
  const { clip } = requireClipId(step, state);
  const duration = snapToFrame(secondsToTicks(step.seconds ?? 0.5), state.frameRate);
  return {
    ops: [
      {
        op: 'update_transition',
        clipId: clip.id,
        side: 'in',
        transition: { type: 'fade_black', duration },
      },
    ],
    summary: 'Fade the clip in',
  };
});

const COMPILERS: Record<PlanStep['operation'], Compiler> = {
  remove_silence: removeSilence,
  remove_repeated_takes: removeRepeatedTakes,
  cut_range: cutRange,
  speed_range: speedRange,
  cut_to_duration: cutToDuration,
  normalize_dialogue: normalizeDialogue,
  reduce_noise: reduceNoise,
  set_track_volume: setTrackVolume,
  add_captions: addCaptions,
  add_broll: addBroll,
  add_music: addMusic,
  generate_shorts: generateShorts,
  trim_clip: trimClip,
  remove_clip: removeClip,
  split_clip: splitClip,
  move_clip: moveClip,
  change_track: changeTrack,
  change_volume: changeVolume,
  change_speed: changeSpeed,
  update_transition: updateTransition,
};

/**
 * Compiling order, independent of the order a model listed things. Times in a plan refer to the
 * timeline as it was, so explicit-time steps run first and latest-first, leaving earlier times valid.
 * Measured steps re-map onto the current timeline each time, so they follow. Captions and B-roll come
 * after every cut, so they land on the final picture; goal-seeking cuts go before them.
 */
function compileRank(step: PlanStep): number {
  switch (step.operation) {
    case 'trim_clip':
    case 'remove_clip':
    case 'split_clip':
    case 'move_clip':
    case 'change_track':
    case 'change_speed':
    case 'cut_range':
    case 'speed_range':
      return 0;
    case 'remove_repeated_takes':
      return 1;
    case 'remove_silence':
      return 2;
    case 'cut_to_duration':
      return 3;
    case 'add_broll':
      return 5;
    case 'add_captions':
      return 6;
    default:
      return 4;
  }
}

/**
 * Turns a plan into exact operations. Pure and deterministic apart from new ids. Each step is applied
 * to a working copy as soon as it compiles, so a step that cannot apply is reported on its own and
 * cannot damage the ones around it. Nothing here touches stored state.
 */
export function compilePlan(
  plan: AgentPlan,
  base: TimelineState,
  context: CompileContext,
  media: MediaLookup,
  enabled?: ReadonlySet<number>,
): CompiledPlan {
  const order = plan.steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => {
      const rank = compileRank(a.step) - compileRank(b.step);
      if (rank !== 0) return rank;
      if (compileRank(a.step) === 0) return (b.step.start ?? 0) - (a.step.start ?? 0);
      return a.index - b.index;
    });

  let state = base;
  const ops: TimelineOperation[] = [];
  const shorts: ShortProposal[] = [];
  const compiled = new Map<number, CompiledPlanStep>();

  for (const { step, index } of order) {
    const header = { index, operation: step.operation, reason: step.reason };
    if (enabled && !enabled.has(index)) {
      compiled.set(index, { ...header, summary: 'Left out', operationCount: 0, error: null });
      continue;
    }
    try {
      const outcome = COMPILERS[step.operation](state, step, context);
      state = applyOperations(state, outcome.ops, media).state;
      ops.push(...outcome.ops);
      shorts.push(...(outcome.shorts ?? []));
      compiled.set(index, {
        ...header,
        summary: outcome.summary,
        operationCount: outcome.ops.length,
        error: null,
      });
    } catch (err) {
      if (!(err instanceof StepRejected) && !(err instanceof TimelineError)) throw err;
      compiled.set(index, {
        ...header,
        summary: 'Cannot apply',
        operationCount: 0,
        error: err.message,
      });
    }
  }

  return {
    steps: plan.steps.map((_step, index) => compiled.get(index)!),
    ops,
    shorts,
    state,
  };
}

/** Creates the operations for one independent vertical Short from its proposal. */
export function buildShortOperations(
  short: ShortProposal,
  state: TimelineState,
  source: { width: number; height: number },
): TimelineOperation[] {
  const video = firstTrackOfType(state, 'VIDEO');
  const captions = firstTrackOfType(state, 'CAPTIONS');
  if (!video || !captions) throw new Error('A new timeline always has these tracks');

  // Scale so the picture fills the frame height, then crop to it. A value of 1 is "contain".
  const sourceAspect = source.width / source.height;
  const targetAspect = state.width / state.height;
  const scale = Math.max(sourceAspect / targetAspect, targetAspect / sourceAspect);
  // How far the picture can slide before an edge shows, as a fraction of the frame width.
  const slack = (scale - 1) / 2;
  const clip = {
    ...createMediaClip(
      {
        sourceMediaId: short.sourceMediaId,
        start: 0,
        sourceIn: short.sourceIn,
        sourceOut: short.sourceOut,
      },
      state.frameRate,
    ),
    transform: { x: -short.framing * slack, y: 0, scale, rotation: 0, opacity: 1 },
  };
  const ops: TimelineOperation[] = [{ op: 'add_clip', trackId: video.id, clip }];

  const frame = ticksPerFrame(state.frameRate);
  let cursor = 0;
  for (const [index, caption] of short.captions.entries()) {
    const start = Math.max(cursor, snapToFrame(caption.start - short.sourceIn, state.frameRate));
    const next = short.captions[index + 1];
    const limit = next
      ? snapToFrame(next.start - short.sourceIn, state.frameRate)
      : Number.MAX_SAFE_INTEGER;
    const end = Math.min(
      Math.max(snapToFrame(caption.end - short.sourceIn, state.frameRate), start + frame),
      limit,
      clip.duration,
    );
    if (end <= start) continue;
    ops.push({
      op: 'add_caption',
      trackId: captions.id,
      clip: createCaptionClip(
        {
          start,
          duration: end - start,
          text: caption.text,
          style: {
            font: 'Arial',
            size: 72,
            color: '#ffffff',
            background: '#000000b3',
            position: 'bottom',
          },
        },
        state.frameRate,
      ),
    });
    cursor = end;
  }
  return ops;
}
