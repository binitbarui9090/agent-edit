import { ID_PREFIXES } from '@agent-edit/shared';
import { z } from 'zod';
import { idSchema, positiveTicksSchema, shortTicksSchema, ticksSchema } from './common.js';
import { frameRateSchema } from './project.js';

export const TRACK_TYPES = ['VIDEO', 'BROLL', 'AUDIO', 'MUSIC', 'CAPTIONS', 'OVERLAYS'] as const;
export const trackTypeSchema = z.enum(TRACK_TYPES);
export type TrackType = z.infer<typeof trackTypeSchema>;

export const clipIdSchema = idSchema(ID_PREFIXES.clip);
export const trackIdSchema = idSchema(ID_PREFIXES.track);
export const mediaIdSchema = idSchema(ID_PREFIXES.media);

export const transformSchema = z.strictObject({
  x: z.number().min(-10).max(10),
  y: z.number().min(-10).max(10),
  scale: z.number().min(0.01).max(20),
  rotation: z.number().min(-360).max(360),
  opacity: z.number().min(0).max(1),
});
export type Transform = z.infer<typeof transformSchema>;

export const clipAudioSchema = z.strictObject({
  normalize: z.boolean(),
  denoise: z.boolean(),
  fadeIn: shortTicksSchema,
  fadeOut: shortTicksSchema,
});
export type ClipAudio = z.infer<typeof clipAudioSchema>;

export const transitionSchema = z.strictObject({
  type: z.enum(['crossfade', 'fade_black']),
  duration: shortTicksSchema.positive(),
});
export type Transition = z.infer<typeof transitionSchema>;

export const speedSchema = z.number().min(0.25).max(4);
export const volumeSchema = z.number().min(0).max(4);

const clipBase = {
  id: clipIdSchema,
  start: ticksSchema,
  duration: positiveTicksSchema,
  speed: speedSchema,
  volume: volumeSchema,
  enabled: z.boolean(),
  transform: transformSchema,
  audio: clipAudioSchema,
  transitionIn: transitionSchema.nullable(),
  transitionOut: transitionSchema.nullable(),
};

export const mediaClipSchema = z
  .strictObject({
    ...clipBase,
    kind: z.literal('media'),
    sourceMediaId: mediaIdSchema,
    sourceIn: ticksSchema,
    sourceOut: positiveTicksSchema,
  })
  .refine((c) => c.sourceIn < c.sourceOut, {
    message: 'sourceIn must be before sourceOut',
    path: ['sourceOut'],
  });
export type MediaClip = z.infer<typeof mediaClipSchema>;

export const captionStyleSchema = z.strictObject({
  font: z.string().min(1).max(80),
  size: z.number().min(6).max(300),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  background: z
    .string()
    .regex(/^#[0-9a-fA-F]{8}$/)
    .nullable(),
  position: z.enum(['top', 'middle', 'bottom']),
});
export type CaptionStyle = z.infer<typeof captionStyleSchema>;

export const captionClipSchema = z.strictObject({
  ...clipBase,
  kind: z.literal('caption'),
  text: z.string().min(1).max(2000),
  style: captionStyleSchema,
});
export type CaptionClip = z.infer<typeof captionClipSchema>;

export const timelineClipSchema = z.discriminatedUnion('kind', [
  mediaClipSchema,
  captionClipSchema,
]);
export type TimelineClip = z.infer<typeof timelineClipSchema>;

export const timelineTrackSchema = z.strictObject({
  id: trackIdSchema,
  type: trackTypeSchema,
  name: z.string().min(1).max(80),
  locked: z.boolean(),
  muted: z.boolean(),
  volume: volumeSchema,
  clips: z.array(timelineClipSchema),
});
export type TimelineTrack = z.infer<typeof timelineTrackSchema>;

/** Everything the reducer works on. Identity and bookkeeping live on the stored document. */
export const timelineStateSchema = z.object({
  frameRate: frameRateSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  tracks: z.array(timelineTrackSchema),
});
export type TimelineState = z.infer<typeof timelineStateSchema>;
