import type {
  TimelineClip,
  TimelineOperation,
  TimelineState,
  TimelineTrack,
  TrackType,
} from '@agent-edit/validation';
import { TimelineError } from './errors.js';
import { clipEnd, findClip, type LocatedClip } from './queries.js';
import { validateTimeline, type MediaLookup } from './validate.js';

export interface ApplyResult {
  state: TimelineState;
  /** Applied in order, these restore the state from before the transaction. */
  inverse: TimelineOperation[];
}

const MEDIA_TRACKS: ReadonlySet<TrackType> = new Set([
  'VIDEO',
  'BROLL',
  'AUDIO',
  'MUSIC',
  'OVERLAYS',
]);

export function isCompatible(kind: TimelineClip['kind'], type: TrackType): boolean {
  return kind === 'caption' ? type === 'CAPTIONS' : MEDIA_TRACKS.has(type);
}

function requireClip(state: TimelineState, clipId: string): LocatedClip {
  const located = findClip(state, clipId);
  if (!located) throw new TimelineError('clip_not_found', `Clip ${clipId} does not exist`);
  if (located.track.locked) {
    throw new TimelineError('track_locked', `Track ${located.track.name} is locked`);
  }
  return located;
}

function requireTrack(state: TimelineState, trackId: string): [TimelineTrack, number] {
  const trackIndex = state.tracks.findIndex((track) => track.id === trackId);
  const track = state.tracks[trackIndex];
  if (!track) throw new TimelineError('track_not_found', `Track ${trackId} does not exist`);
  return [track, trackIndex];
}

function requireWritableTrack(state: TimelineState, trackId: string): [TimelineTrack, number] {
  const found = requireTrack(state, trackId);
  if (found[0].locked) throw new TimelineError('track_locked', `Track ${found[0].name} is locked`);
  return found;
}

function withClips(state: TimelineState, trackIndex: number, clips: TimelineClip[]): TimelineState {
  const tracks = [...state.tracks];
  // Sorted by start at all times: overlap checks, seeking and drawing all rely on it.
  tracks[trackIndex] = { ...tracks[trackIndex]!, clips: clips.sort((a, b) => a.start - b.start) };
  return { ...state, tracks };
}

function replaceClip(state: TimelineState, at: LocatedClip, clip: TimelineClip): TimelineState {
  const clips = [...at.track.clips];
  clips[at.clipIndex] = clip;
  return withClips(state, at.trackIndex, clips);
}

function insertClip(
  state: TimelineState,
  trackId: string,
  clip: TimelineClip,
  expected?: { type: TrackType; label: string },
): TimelineState {
  if (findClip(state, clip.id)) {
    throw new TimelineError('duplicate_id', `Clip ${clip.id} already exists`);
  }
  const [track, trackIndex] = requireWritableTrack(state, trackId);
  if (expected && track.type !== expected.type) {
    throw new TimelineError(
      'incompatible_track',
      `${expected.label} goes on a ${expected.type} track, not ${track.type}`,
    );
  }
  if (!isCompatible(clip.kind, track.type)) {
    throw new TimelineError('incompatible_track', `${clip.kind} clip cannot go on ${track.type}`);
  }
  return withClips(state, trackIndex, [...track.clips, clip]);
}

function addOperationFor(trackId: string, clip: TimelineClip): TimelineOperation {
  return clip.kind === 'caption'
    ? { op: 'add_caption', trackId, clip }
    : { op: 'add_clip', trackId, clip };
}

function applyOne(
  state: TimelineState,
  operation: TimelineOperation,
): { state: TimelineState; inverse: TimelineOperation[] } {
  switch (operation.op) {
    case 'add_clip':
      return {
        state: insertClip(state, operation.trackId, operation.clip),
        inverse: [{ op: 'remove_clip', clipId: operation.clip.id }],
      };
    case 'add_broll':
      return {
        state: insertClip(state, operation.trackId, operation.clip, {
          type: 'BROLL',
          label: 'B-roll',
        }),
        inverse: [{ op: 'remove_clip', clipId: operation.clip.id }],
      };
    case 'add_music':
      return {
        state: insertClip(state, operation.trackId, operation.clip, {
          type: 'MUSIC',
          label: 'Music',
        }),
        inverse: [{ op: 'remove_clip', clipId: operation.clip.id }],
      };
    case 'add_caption':
      return {
        state: insertClip(state, operation.trackId, operation.clip, {
          type: 'CAPTIONS',
          label: 'A caption',
        }),
        inverse: [{ op: 'remove_clip', clipId: operation.clip.id }],
      };
    case 'remove_clip': {
      const at = requireClip(state, operation.clipId);
      return {
        state: withClips(
          state,
          at.trackIndex,
          at.track.clips.filter((clip) => clip.id !== at.clip.id),
        ),
        inverse: [addOperationFor(at.track.id, at.clip)],
      };
    }
    case 'trim_clip': {
      const at = requireClip(state, operation.clipId);
      const { clip } = at;
      const { start, duration, sourceIn, sourceOut } = operation;
      const next: TimelineClip =
        clip.kind === 'media'
          ? { ...clip, start, duration, sourceIn, sourceOut }
          : { ...clip, start, duration };
      return {
        state: replaceClip(state, at, next),
        inverse: [
          {
            op: 'trim_clip',
            clipId: clip.id,
            start: clip.start,
            duration: clip.duration,
            sourceIn: clip.kind === 'media' ? clip.sourceIn : 0,
            sourceOut: clip.kind === 'media' ? clip.sourceOut : clip.duration,
          },
        ],
      };
    }
    case 'split_clip': {
      const at = requireClip(state, operation.clipId);
      const { clip } = at;
      if (findClip(state, operation.newClipId)) {
        throw new TimelineError('duplicate_id', `Clip ${operation.newClipId} already exists`);
      }
      if (operation.at <= clip.start || operation.at >= clipEnd(clip)) {
        throw new TimelineError('invalid_operation', 'Split point must be inside the clip');
      }
      const leftDuration = operation.at - clip.start;
      const rightDuration = clip.duration - leftDuration;
      const shared = { start: clip.start, duration: leftDuration, transitionOut: null };
      const fadeOut = { ...clip.audio, fadeOut: 0 };
      const fadeIn = { ...clip.audio, fadeIn: 0 };
      let left: TimelineClip;
      let right: TimelineClip;
      let restore: TimelineOperation;
      if (clip.kind === 'media') {
        const boundary = clip.sourceIn + Math.round(leftDuration * clip.speed);
        left = { ...clip, ...shared, sourceOut: boundary, audio: fadeOut };
        right = {
          ...clip,
          id: operation.newClipId,
          start: operation.at,
          duration: rightDuration,
          sourceIn: boundary,
          transitionIn: null,
          audio: fadeIn,
        };
        restore = {
          op: 'trim_clip',
          clipId: clip.id,
          start: clip.start,
          duration: clip.duration,
          sourceIn: clip.sourceIn,
          sourceOut: clip.sourceOut,
        };
      } else {
        left = { ...clip, ...shared, audio: fadeOut };
        right = {
          ...clip,
          id: operation.newClipId,
          start: operation.at,
          duration: rightDuration,
          transitionIn: null,
          audio: fadeIn,
        };
        restore = {
          op: 'trim_clip',
          clipId: clip.id,
          start: clip.start,
          duration: clip.duration,
          sourceIn: 0,
          sourceOut: clip.duration,
        };
      }
      const clips = [...at.track.clips];
      clips[at.clipIndex] = left;
      clips.push(right);
      return {
        state: withClips(state, at.trackIndex, clips),
        inverse: [
          { op: 'remove_clip', clipId: operation.newClipId },
          restore,
          {
            op: 'update_transition',
            clipId: clip.id,
            side: 'out',
            transition: clip.transitionOut,
          },
          { op: 'update_audio', clipId: clip.id, fadeOut: clip.audio.fadeOut },
        ],
      };
    }
    case 'move_clip': {
      const at = requireClip(state, operation.clipId);
      return {
        state: replaceClip(state, at, { ...at.clip, start: operation.start }),
        inverse: [{ op: 'move_clip', clipId: at.clip.id, start: at.clip.start }],
      };
    }
    case 'change_track': {
      const at = requireClip(state, operation.clipId);
      const [target] = requireWritableTrack(state, operation.trackId);
      if (!isCompatible(at.clip.kind, target.type)) {
        throw new TimelineError(
          'incompatible_track',
          `${at.clip.kind} clip cannot go on ${target.type}`,
        );
      }
      const removed = withClips(
        state,
        at.trackIndex,
        at.track.clips.filter((clip) => clip.id !== at.clip.id),
      );
      return {
        state: insertClip(removed, operation.trackId, { ...at.clip, start: operation.start }),
        inverse: [
          { op: 'change_track', clipId: at.clip.id, trackId: at.track.id, start: at.clip.start },
        ],
      };
    }
    case 'change_volume': {
      const at = requireClip(state, operation.clipId);
      return {
        state: replaceClip(state, at, { ...at.clip, volume: operation.volume }),
        inverse: [{ op: 'change_volume', clipId: at.clip.id, volume: at.clip.volume }],
      };
    }
    case 'change_speed': {
      const at = requireClip(state, operation.clipId);
      if (at.clip.kind !== 'media') {
        throw new TimelineError('invalid_operation', 'Only media clips have a speed');
      }
      return {
        state: replaceClip(state, at, {
          ...at.clip,
          speed: operation.speed,
          duration: operation.duration,
        }),
        inverse: [
          {
            op: 'change_speed',
            clipId: at.clip.id,
            speed: at.clip.speed,
            duration: at.clip.duration,
          },
        ],
      };
    }
    case 'update_transition': {
      const at = requireClip(state, operation.clipId);
      const field = operation.side === 'in' ? 'transitionIn' : 'transitionOut';
      return {
        state: replaceClip(state, at, { ...at.clip, [field]: operation.transition }),
        inverse: [
          {
            op: 'update_transition',
            clipId: at.clip.id,
            side: operation.side,
            transition: at.clip[field],
          },
        ],
      };
    }
    case 'update_audio': {
      const at = requireClip(state, operation.clipId);
      const { audio } = at.clip;
      return {
        state: replaceClip(state, at, {
          ...at.clip,
          audio: {
            normalize: operation.normalize ?? audio.normalize,
            denoise: operation.denoise ?? audio.denoise,
            fadeIn: operation.fadeIn ?? audio.fadeIn,
            fadeOut: operation.fadeOut ?? audio.fadeOut,
          },
        }),
        inverse: [{ op: 'update_audio', clipId: at.clip.id, ...audio }],
      };
    }
    case 'update_caption': {
      const at = requireClip(state, operation.clipId);
      if (at.clip.kind !== 'caption') {
        throw new TimelineError('invalid_operation', 'Only caption clips have text');
      }
      return {
        state: replaceClip(state, at, {
          ...at.clip,
          text: operation.text ?? at.clip.text,
          style: operation.style ?? at.clip.style,
        }),
        inverse: [
          { op: 'update_caption', clipId: at.clip.id, text: at.clip.text, style: at.clip.style },
        ],
      };
    }
    case 'update_transform': {
      const at = requireClip(state, operation.clipId);
      return {
        state: replaceClip(state, at, { ...at.clip, transform: operation.transform }),
        inverse: [{ op: 'update_transform', clipId: at.clip.id, transform: at.clip.transform }],
      };
    }
    case 'set_clip_enabled': {
      const at = requireClip(state, operation.clipId);
      return {
        state: replaceClip(state, at, { ...at.clip, enabled: operation.enabled }),
        inverse: [{ op: 'set_clip_enabled', clipId: at.clip.id, enabled: at.clip.enabled }],
      };
    }
    case 'update_track': {
      // The one operation allowed on a locked track, or a track could never be unlocked.
      const [track, trackIndex] = requireTrack(state, operation.trackId);
      const tracks = [...state.tracks];
      tracks[trackIndex] = {
        ...track,
        locked: operation.locked ?? track.locked,
        muted: operation.muted ?? track.muted,
        volume: operation.volume ?? track.volume,
      };
      return {
        state: { ...state, tracks },
        inverse: [
          {
            op: 'update_track',
            trackId: track.id,
            locked: track.locked,
            muted: track.muted,
            volume: track.volume,
          },
        ],
      };
    }
  }
}

/**
 * Applies operations as one all-or-nothing unit. The input is never mutated, so a failure part way
 * simply discards the working copy. Invariants are checked once at the end because intermediate
 * states may legitimately overlap, as when a ripple edit moves a run of clips.
 */
export function applyOperations(
  state: TimelineState,
  operations: readonly TimelineOperation[],
  media?: MediaLookup,
): ApplyResult {
  let current = state;
  const inverse: TimelineOperation[] = [];
  for (const [index, operation] of operations.entries()) {
    try {
      const result = applyOne(current, operation);
      current = result.state;
      inverse.unshift(...result.inverse);
    } catch (err) {
      if (err instanceof TimelineError) {
        throw new TimelineError(err.code, `Operation ${index + 1}: ${err.message}`, index);
      }
      throw err;
    }
  }
  validateTimeline(current, media);
  return { state: current, inverse };
}
