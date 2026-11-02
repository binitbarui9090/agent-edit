import { isOnFrameGrid, ticksPerFrame } from '@agent-edit/shared';
import type { TimelineState } from '@agent-edit/validation';
import { TimelineError } from './errors.js';

export interface MediaFacts {
  duration: number;
}

export type MediaLookup = (mediaId: string) => MediaFacts | undefined;

/**
 * Checks everything an edit could break. The client passes no lookup while its media list is still
 * loading; the server always does, so the final authority never skips the source checks.
 */
export function validateTimeline(state: TimelineState, media?: MediaLookup): void {
  const seen = new Set<string>();
  const frame = ticksPerFrame(state.frameRate);

  for (const track of state.tracks) {
    let previousEnd = 0;
    for (const clip of track.clips) {
      if (seen.has(clip.id)) throw new TimelineError('duplicate_id', `Duplicate clip ${clip.id}`);
      seen.add(clip.id);

      if (clip.start < 0 || clip.duration <= 0) {
        throw new TimelineError('invalid_operation', `Clip ${clip.id} has an invalid time range`);
      }
      if (!isOnFrameGrid(clip.start, state.frameRate)) {
        throw new TimelineError('off_grid', `Clip ${clip.id} does not start on a frame boundary`);
      }
      if (!isOnFrameGrid(clip.duration, state.frameRate)) {
        throw new TimelineError('off_grid', `Clip ${clip.id} is not a whole number of frames`);
      }
      if (clip.start < previousEnd) {
        throw new TimelineError('overlap', `Clips overlap on track ${track.name}`);
      }
      previousEnd = clip.start + clip.duration;

      if (clip.kind !== 'media') continue;
      if (clip.sourceIn >= clip.sourceOut) {
        throw new TimelineError('source_out_of_range', `Clip ${clip.id} has an empty source range`);
      }
      // Speed can make the span land between frames, so allow one frame of rounding.
      const span = clip.sourceOut - clip.sourceIn;
      if (Math.abs(span - clip.duration * clip.speed) > frame * Math.max(1, clip.speed)) {
        throw new TimelineError(
          'source_out_of_range',
          `Clip ${clip.id}: source span does not match duration at speed ${clip.speed}`,
        );
      }
      if (media) {
        const facts = media(clip.sourceMediaId);
        if (!facts) {
          throw new TimelineError(
            'media_not_found',
            `Media ${clip.sourceMediaId} is not available`,
          );
        }
        if (clip.sourceOut > facts.duration + frame) {
          throw new TimelineError(
            'source_out_of_range',
            `Clip ${clip.id} runs past the end of its source`,
          );
        }
      }
    }
  }
}
