import { ID_PREFIXES } from '@agent-edit/shared';
import { z } from 'zod';
import { idSchema, positiveTicksSchema, shortTicksSchema, ticksSchema } from './common.js';
import {
  captionClipSchema,
  captionStyleSchema,
  clipIdSchema,
  mediaClipSchema,
  speedSchema,
  timelineStateSchema,
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
  z.strictObject({
    op: z.literal('update_track'),
    trackId: trackIdSchema,
    locked: z.boolean().optional(),
    muted: z.boolean().optional(),
    volume: volumeSchema.optional(),
  }),
]);
export type TimelineOperation = z.infer<typeof timelineOperationSchema>;
export type TimelineOperationName = TimelineOperation['op'];

export const TRANSACTION_SOURCES = ['manual', 'ai', 'undo', 'redo', 'restore'] as const;
export const transactionSourceSchema = z.enum(TRANSACTION_SOURCES);
export type TransactionSource = z.infer<typeof transactionSourceSchema>;

export const editTransactionRequestSchema = z.strictObject({
  baseRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(16).max(64),
  ops: z.array(timelineOperationSchema).min(1).max(20_000),
  summary: z.string().max(500).optional(),
});
export type EditTransactionRequest = z.infer<typeof editTransactionRequestSchema>;

export const undoRedoRequestSchema = z.strictObject({
  baseRevision: z.number().int().nonnegative(),
});

export const timelineParamsSchema = z.strictObject({
  id: idSchema(ID_PREFIXES.project),
  timelineId: idSchema(ID_PREFIXES.timeline),
});

export const versionParamsSchema = timelineParamsSchema.extend({
  versionId: idSchema(ID_PREFIXES.version),
});

const isoDate = z.iso.datetime();

export const timelineSchema = timelineStateSchema.extend({
  id: idSchema(ID_PREFIXES.timeline),
  projectId: idSchema(ID_PREFIXES.project),
  kind: z.enum(['main', 'short']),
  name: z.string(),
  revision: z.number().int().nonnegative(),
  canUndo: z.boolean(),
  canRedo: z.boolean(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type Timeline = z.infer<typeof timelineSchema>;

export const timelineSummarySchema = z.object({
  id: idSchema(ID_PREFIXES.timeline),
  kind: z.enum(['main', 'short']),
  name: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  duration: z.number().int().nonnegative(),
  clipCount: z.number().int().nonnegative(),
  updatedAt: isoDate,
});
export type TimelineSummary = z.infer<typeof timelineSummarySchema>;

export const historyEntrySchema = z.object({
  id: idSchema(ID_PREFIXES.transaction),
  revision: z.number().int().positive(),
  source: transactionSourceSchema,
  summary: z.string(),
  operationCount: z.number().int().nonnegative(),
  author: z.object({
    userId: z.string(),
    agentRunId: z.string().nullable(),
    model: z.string().nullable(),
  }),
  createdAt: isoDate,
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const createVersionRequestSchema = z.strictObject({
  name: z.string().trim().min(1, 'Name is required').max(120),
});

export const versionTriggerSchema = z.enum(['manual', 'pre_ai', 'pre_restore']);

export const timelineVersionSchema = z.object({
  id: idSchema(ID_PREFIXES.version),
  name: z.string(),
  revision: z.number().int().nonnegative(),
  trigger: versionTriggerSchema,
  createdAt: isoDate,
});
export type TimelineVersion = z.infer<typeof timelineVersionSchema>;
