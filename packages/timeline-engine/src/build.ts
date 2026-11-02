import { newId, snapToFrame, type FrameRate } from '@agent-edit/shared';
import type {
  CaptionClip,
  CaptionStyle,
  ClipAudio,
  MediaClip,
  TimelineTrack,
  Transform,
  TrackType,
} from '@agent-edit/validation';

export const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
export const DEFAULT_AUDIO: ClipAudio = { normalize: false, denoise: false, fadeIn: 0, fadeOut: 0 };
export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  font: 'Arial',
  size: 48,
  color: '#ffffff',
  background: '#000000b3',
  position: 'bottom',
};

const DEFAULT_TRACKS: ReadonlyArray<{ type: TrackType; name: string }> = [
  { type: 'OVERLAYS', name: 'Overlays' },
  { type: 'BROLL', name: 'B-roll' },
  { type: 'VIDEO', name: 'Video' },
  { type: 'CAPTIONS', name: 'Captions' },
  { type: 'AUDIO', name: 'Audio' },
  { type: 'MUSIC', name: 'Music' },
];

export function createDefaultTracks(): TimelineTrack[] {
  return DEFAULT_TRACKS.map(({ type, name }) => ({
    id: newId('trk'),
    type,
    name,
    locked: false,
    muted: false,
    volume: 1,
    clips: [],
  }));
}

export interface MediaClipInput {
  sourceMediaId: string;
  start: number;
  sourceIn: number;
  sourceOut: number;
  speed?: number;
  volume?: number;
  id?: string;
}

/** Snaps the timeline side to the frame grid, so callers can pass any source range. */
export function createMediaClip(input: MediaClipInput, rate: FrameRate): MediaClip {
  const speed = input.speed ?? 1;
  const start = snapToFrame(input.start, rate);
  const duration = Math.max(
    snapToFrame(1, rate),
    snapToFrame((input.sourceOut - input.sourceIn) / speed, rate),
  );
  return {
    id: input.id ?? newId('clip'),
    kind: 'media',
    sourceMediaId: input.sourceMediaId,
    sourceIn: input.sourceIn,
    sourceOut: input.sourceOut,
    start,
    duration,
    speed,
    volume: input.volume ?? 1,
    enabled: true,
    transform: DEFAULT_TRANSFORM,
    audio: DEFAULT_AUDIO,
    transitionIn: null,
    transitionOut: null,
  };
}

export function createCaptionClip(
  input: { start: number; duration: number; text: string; style?: CaptionStyle; id?: string },
  rate: FrameRate,
): CaptionClip {
  return {
    id: input.id ?? newId('clip'),
    kind: 'caption',
    text: input.text,
    style: input.style ?? DEFAULT_CAPTION_STYLE,
    start: snapToFrame(input.start, rate),
    duration: Math.max(snapToFrame(input.duration, rate), snapToFrame(1, rate)),
    speed: 1,
    volume: 1,
    enabled: true,
    transform: DEFAULT_TRANSFORM,
    audio: DEFAULT_AUDIO,
    transitionIn: null,
    transitionOut: null,
  };
}
