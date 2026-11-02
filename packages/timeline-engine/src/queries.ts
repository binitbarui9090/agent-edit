import type { TimelineClip, TimelineState, TimelineTrack, TrackType } from '@agent-edit/validation';

export interface LocatedClip {
  track: TimelineTrack;
  trackIndex: number;
  clip: TimelineClip;
  clipIndex: number;
}

export function findClip(state: TimelineState, clipId: string): LocatedClip | null {
  for (const [trackIndex, track] of state.tracks.entries()) {
    const clipIndex = track.clips.findIndex((clip) => clip.id === clipId);
    const clip = track.clips[clipIndex];
    if (clip) return { track, trackIndex, clip, clipIndex };
  }
  return null;
}

export const clipEnd = (clip: Pick<TimelineClip, 'start' | 'duration'>) =>
  clip.start + clip.duration;

export function timelineDuration(state: TimelineState): number {
  let end = 0;
  for (const track of state.tracks) {
    const last = track.clips.at(-1);
    if (last) end = Math.max(end, clipEnd(last));
  }
  return end;
}

/** Binary search over a start-sorted track. Tracks can hold thousands of caption blocks. */
export function firstClipEndingAfter(clips: readonly TimelineClip[], time: number): number {
  let low = 0;
  let high = clips.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (clipEnd(clips[middle]!) <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function clipAt(track: TimelineTrack, time: number): TimelineClip | null {
  const clip = track.clips[firstClipEndingAfter(track.clips, time)];
  return clip && clip.start <= time ? clip : null;
}

/** Clips overlapping [from, to), for drawing only what is on screen. */
export function clipsInRange(
  clips: readonly TimelineClip[],
  from: number,
  to: number,
): TimelineClip[] {
  const result: TimelineClip[] = [];
  for (let i = firstClipEndingAfter(clips, from); i < clips.length; i++) {
    const clip = clips[i]!;
    if (clip.start >= to) break;
    result.push(clip);
  }
  return result;
}

export function firstTrackOfType(state: TimelineState, type: TrackType): TimelineTrack | null {
  return state.tracks.find((track) => track.type === type) ?? null;
}

/** Whether the range is free on a track, ignoring the given clips (those being moved). */
export function isRangeFree(
  track: TimelineTrack,
  start: number,
  end: number,
  ignore: ReadonlySet<string> = new Set(),
): boolean {
  return clipsInRange(track.clips, start, end).every((clip) => ignore.has(clip.id));
}
