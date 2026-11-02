import { z } from 'zod';
import { positiveTicksSchema, shortTicksSchema, ticksSchema } from './common.js';
import {
  captionClipSchema,
  captionStyleSchema,
  clipIdSchema,
  mediaClipSchema,
  speedSchema,
  trackIdSchema,
  transformSchema,
  transitionSchema,
  volumeSchema,
} from './timeline.js';

/**
 * Canonical timeline operations. Every value is an absolute post-state and every new ID is assigned
 * before the op is issued, so replaying an op yields the same result. These schemas check shape
 * only; invariants that need the timeline (overlaps, track compatibility) belong to the reducer.
 * Models never emit these directly: see docs/ARCHITECTURE.md §5.
 */
export const timelineOperationSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add_clip'), trackId: trackIdSchema, clip: mediaClipSchema }),
  z.strictObject({ op: z.literal('add_broll'), trackId: trackIdSchema, clip: mediaClipSchema }),
  z.strictObject({ op: z.literal('add_music'), trackId: trackIdSchema, clip: mediaClipSchema }),
  z.strictObject({ op: z.literal('add_caption'), trackId: trackIdSchema, clip: captionClipSchema }),
  z.strictObject({ op: z.literal('remove_clip'), clipId: clipIdSchema }),
  z.strictObject({
    op: z.literal('trim_clip'),
    clipId: clipIdSchema,
    start: ticksSchema,
    duration: positiveTicksSchema,
    sourceIn: ticksSchema,
    sourceOut: positiveTicksSchema,
  }),
  z.strictObject({
    op: z.literal('split_clip'),
    clipId: clipIdSchema,
    at: positiveTicksSchema,
    newClipId: clipIdSchema,
  }),
  z.strictObject({ op: z.literal('move_clip'), clipId: clipIdSchema, start: ticksSchema }),
  z.strictObject({
    op: z.literal('change_track'),
    clipId: clipIdSchema,
    trackId: trackIdSchema,
    start: ticksSchema,
  }),
  z.strictObject({ op: z.literal('change_volume'), clipId: clipIdSchema, volume: volumeSchema }),
  z.strictObject({
    op: z.literal('change_speed'),
    clipId: clipIdSchema,
    speed: speedSchema,
    duration: positiveTicksSchema,
  }),
  z.strictObject({
    op: z.literal('update_transition'),
    clipId: clipIdSchema,
    side: z.enum(['in', 'out']),
    transition: transitionSchema.nullable(),
  }),
  z.strictObject({
    op: z.literal('update_audio'),
    clipId: clipIdSchema,
    normalize: z.boolean().optional(),
    denoise: z.boolean().optional(),
    fadeIn: shortTicksSchema.optional(),
    fadeOut: shortTicksSchema.optional(),
  }),
  z.strictObject({
    op: z.literal('update_caption'),
    clipId: clipIdSchema,
    text: z.string().min(1).max(2000).optional(),
    style: captionStyleSchema.optional(),
  }),
  z.strictObject({
    op: z.literal('update_transform'),
    clipId: clipIdSchema,
    transform: transformSchema,
  }),
  z.strictObject({ op: z.literal('set_clip_enabled'), clipId: clipIdSchema, enabled: z.boolean() }),
]);
export type TimelineOperation = z.infer<typeof timelineOperationSchema>;
export type TimelineOperationName = TimelineOperation['op'];

export const editTransactionRequestSchema = z.strictObject({
  baseRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(16).max(64),
  ops: z.array(timelineOperationSchema).min(1).max(5000),
  summary: z.string().max(500).optional(),
});
export type EditTransactionRequest = z.infer<typeof editTransactionRequestSchema>;
