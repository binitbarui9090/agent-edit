import { ID_PREFIXES } from '@agent-edit/shared';
import { z } from 'zod';
import { idSchema, isoDateSchema } from './common.js';

export const RENDER_PRESETS = {
  source: { label: 'Timeline size', width: null, height: null },
  '2160p': { label: '4K landscape', width: 3840, height: 2160 },
  '1080p': { label: '1080p landscape', width: 1920, height: 1080 },
  '720p': { label: '720p landscape', width: 1280, height: 720 },
  vertical: { label: 'Vertical 1080 × 1920', width: 1080, height: 1920 },
  square: { label: 'Square 1080 × 1080', width: 1080, height: 1080 },
} as const;

export type RenderPreset = keyof typeof RENDER_PRESETS;
export const renderPresetSchema = z.enum(
  Object.keys(RENDER_PRESETS) as [RenderPreset, ...RenderPreset[]],
);

export const renderStatusSchema = z.enum(['queued', 'running', 'done', 'failed', 'cancelled']);
export type RenderStatus = z.infer<typeof renderStatusSchema>;

export const createRenderRequestSchema = z.strictObject({
  preset: renderPresetSchema,
  burnCaptions: z.boolean(),
  /** Confirms what the creator saw is what gets rendered. */
  baseRevision: z.number().int().nonnegative(),
});

export const renderJobSchema = z.object({
  id: idSchema(ID_PREFIXES.renderJob),
  projectId: idSchema(ID_PREFIXES.project),
  timelineId: idSchema(ID_PREFIXES.timeline),
  timelineName: z.string(),
  revision: z.number().int().nonnegative(),
  preset: renderPresetSchema,
  burnCaptions: z.boolean(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  status: renderStatusSchema,
  progress: z.number().min(0).max(1),
  error: z.string().nullable(),
  durationSeconds: z.number().nonnegative(),
  outputSize: z.number().int().nonnegative().nullable(),
  downloadUrl: z.url().nullable(),
  captionsUrl: z.url().nullable(),
  logUrl: z.url().nullable(),
  createdAt: isoDateSchema,
  finishedAt: isoDateSchema.nullable(),
});
export type RenderJob = z.infer<typeof renderJobSchema>;

export const renderParamsSchema = z.strictObject({
  id: idSchema(ID_PREFIXES.project),
  renderId: idSchema(ID_PREFIXES.renderJob),
});
