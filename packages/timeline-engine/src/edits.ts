import { newId, snapToFrame, ticksPerFrame } from '@agent-edit/shared';
import type { TimelineClip, TimelineOperation, TimelineState } from '@agent-edit/validation';
import { applyOperations } from './apply.js';
import { clipEnd, clipsInRange, findClip } from './queries.js';

/** Trimming a clip's head or tail, keeping source and timeline in step. Clamps to valid ranges. */
export function trimOperation(
  clip: TimelineClip,
  edge: 'start' | 'end',
  time: number,
  state: TimelineState,
  sourceDuration: number | null,
): TimelineOperation {
  const frame = ticksPerFrame(state.frameRate);
  const sourceIn = clip.kind === 'media' ? clip.sourceIn : 0;
  const sourceOut = clip.kind === 'media' ? clip.sourceOut : clip.duration;
  const speed = clip.kind === 'media' ? clip.speed : 1;
  const end = clipEnd(clip);

  if (edge === 'start') {
    const earliest =
      clip.kind === 'media' ? clip.start - Math.floor(sourceIn / speed / frame) * frame : 0;
    const start = Math.min(Math.max(snapToFrame(time, state.frameRate), earliest, 0), end - frame);
    return {
      op: 'trim_clip',
      clipId: clip.id,
      start,
      duration: end - start,
      sourceIn:
        clip.kind === 'media'
          ? Math.max(0, sourceIn + Math.round((start - clip.start) * speed))
          : 0,
      sourceOut,
    };
  }

  const available =
    clip.kind === 'media' && sourceDuration !== null
      ? Math.floor((sourceDuration - sourceIn) / speed / frame) * frame
      : Number.MAX_SAFE_INTEGER;
  const duration = Math.min(
    Math.max(snapToFrame(time, state.frameRate) - clip.start, frame),
    available,
  );
  return {
    op: 'trim_clip',
    clipId: clip.id,
    start: clip.start,
    duration,
    sourceIn,
    sourceOut: clip.kind === 'media' ? sourceIn + Math.round(duration * speed) : duration,
  };
}

interface CutOptions {
  /** Tracks left untouched, for example to keep music running under a cut in dialogue. */
  excludeTrackIds?: ReadonlySet<string>;
  createId?: () => string;
}

/**
 * Ops that remove [start, end) from every unlocked track and close the gap, so captions and B-roll
 * stay in sync with the dialogue they belong to. Ripple is not an operation of its own: it compiles
 * to these primitives, so every effect is visible when a plan is previewed.
 */
export function cutRangeOperations(
  state: TimelineState,
  start: number,
  end: number,
  { excludeTrackIds, createId = () => newId('clip') }: CutOptions = {},
): TimelineOperation[] {
  const rate = state.frameRate;
  const from = snapToFrame(start, rate);
  const to = snapToFrame(end, rate);
  if (to <= from) return [];
  const length = to - from;
  const operations: TimelineOperation[] = [];

  for (const track of state.tracks) {
    if (track.locked || excludeTrackIds?.has(track.id)) continue;
    const later: TimelineClip[] = [];
    for (const clip of track.clips) {
      if (clip.start >= to) {
        later.push(clip);
        continue;
      }
      const stop = clipEnd(clip);
      if (stop <= from) continue;
      if (clip.start >= from && stop <= to) {
        operations.push({ op: 'remove_clip', clipId: clip.id });
      } else if (clip.start < from && stop > to) {
        // Spans the whole cut: split at both ends and drop the middle.
        const middle = createId();
        const tail = createId();
        operations.push(
          { op: 'split_clip', clipId: clip.id, at: from, newClipId: middle },
          { op: 'split_clip', clipId: middle, at: to, newClipId: tail },
          { op: 'remove_clip', clipId: middle },
          { op: 'move_clip', clipId: tail, start: to - length },
        );
      } else if (clip.start < from) {
        const rest = createId();
        operations.push(
          { op: 'split_clip', clipId: clip.id, at: from, newClipId: rest },
          { op: 'remove_clip', clipId: rest },
        );
      } else {
        const rest = createId();
        operations.push(
          { op: 'split_clip', clipId: clip.id, at: to, newClipId: rest },
          { op: 'remove_clip', clipId: clip.id },
          { op: 'move_clip', clipId: rest, start: to - length },
        );
      }
    }
    // Ascending, so each clip moves into space already vacated.
    for (const clip of later) {
      operations.push({ op: 'move_clip', clipId: clip.id, start: clip.start - length });
    }
  }
  return operations;
}

/** Removes several ranges. Later ranges go first, so earlier times stay valid while cutting. */
export function cutRangesOperations(
  state: TimelineState,
  ranges: ReadonlyArray<{ start: number; end: number }>,
  options: CutOptions = {},
): TimelineOperation[] {
  const sorted = [...ranges].sort((a, b) => b.start - a.start);
  const operations: TimelineOperation[] = [];
  let current = state;
  for (const { start, end } of sorted) {
    const step = cutRangeOperations(current, start, end, options);
    if (step.length === 0) continue;
    current = applyOperations(current, step).state;
    operations.push(...step);
  }
  return operations;
}

/** Plain delete: removes clips and leaves the gap. Ripple closes it on the clips' own tracks only. */
export function deleteClipsOperations(
  state: TimelineState,
  clipIds: readonly string[],
  ripple: boolean,
): TimelineOperation[] {
  const operations: TimelineOperation[] = clipIds.map((clipId) => ({ op: 'remove_clip', clipId }));
  if (!ripple) return operations;

  const targets = new Set(clipIds);
  for (const track of state.tracks) {
    const removed = track.clips.filter((clip) => targets.has(clip.id));
    if (removed.length === 0) continue;
    let shift = 0;
    let next = 0;
    for (const clip of track.clips) {
      while (next < removed.length && clipEnd(removed[next]!) <= clip.start) {
        shift += removed[next]!.duration;
        next++;
      }
      if (shift > 0 && !targets.has(clip.id)) {
        operations.push({ op: 'move_clip', clipId: clip.id, start: clip.start - shift });
      }
    }
  }
  return operations;
}

/**
 * Plays [start, end) of the timeline at a new speed: splits at the edges, retimes the media inside,
 * and shifts everything after it so nothing overlaps or leaves a gap. Captions inside are retimed to
 * stay on their words.
 */
export function speedRangeOperations(
  state: TimelineState,
  start: number,
  end: number,
  speed: number,
  { createId = () => newId('clip') }: { createId?: () => string } = {},
): TimelineOperation[] {
  const rate = state.frameRate;
  const frame = ticksPerFrame(rate);
  const from = snapToFrame(start, rate);
  const to = snapToFrame(end, rate);
  const operations: TimelineOperation[] = [];
  const length = to - from;
  const newLength = Math.max(frame, snapToFrame(length / speed, rate));
  const delta = newLength - length;
  if (length <= 0) return [];

  let working = state;
  const run = (ops: TimelineOperation[]) => {
    working = applyOperations(working, ops).state;
    operations.push(...ops);
  };

  for (const track of state.tracks) {
    if (track.locked) continue;
    for (const boundary of [from, to]) {
      const current = working.tracks.find((t) => t.id === track.id)!;
      const crossing = current.clips.find((c) => c.start < boundary && clipEnd(c) > boundary);
      if (crossing) {
        run([{ op: 'split_clip', clipId: crossing.id, at: boundary, newClipId: createId() }]);
      }
    }
    const current = working.tracks.find((t) => t.id === track.id)!;
    const inside = clipsInRange(current.clips, from, to);
    const after = current.clips.filter((clip) => clip.start >= to);

    // Moves that push clips right go last-first, and those pulling left go first-first.
    const later = delta > 0 ? [...after].reverse() : after;
    const retime: TimelineOperation[] = [];
    let cursor = from;
    for (const clip of inside) {
      const position = from + snapToFrame((clip.start - from) / speed, rate);
      cursor = Math.max(cursor, position);
      const duration = Math.max(frame, snapToFrame(clip.duration / speed, rate));
      if (clip.kind === 'media') {
        const span = clip.sourceOut - clip.sourceIn;
        const newSpeed = clip.speed * speed;
        const exact = Math.max(frame, snapToFrame(span / newSpeed, rate));
        retime.push({ op: 'change_speed', clipId: clip.id, speed: newSpeed, duration: exact });
        retime.push({ op: 'move_clip', clipId: clip.id, start: cursor });
        cursor += exact;
      } else {
        retime.push({
          op: 'trim_clip',
          clipId: clip.id,
          start: cursor,
          duration,
          sourceIn: 0,
          sourceOut: duration,
        });
        cursor += duration;
      }
    }
    const shifts: TimelineOperation[] = later.map((clip) => ({
      op: 'move_clip',
      clipId: clip.id,
      start: clip.start + delta,
    }));
    if (retime.length > 0 || shifts.length > 0) run([...retime, ...shifts]);
  }
  return operations;
}

/** The clip IDs a set of operations touches, so a preview can highlight what would change. */
export function affectedClipIds(operations: readonly TimelineOperation[]): string[] {
  const ids = new Set<string>();
  for (const operation of operations) {
    if ('clipId' in operation) ids.add(operation.clipId);
    if ('clip' in operation) ids.add(operation.clip.id);
    if ('newClipId' in operation) ids.add(operation.newClipId);
  }
  return [...ids];
}

export { findClip };
