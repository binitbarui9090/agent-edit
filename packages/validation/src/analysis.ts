import { z } from 'zod';
import { idSchema } from './common.js';
import { ID_PREFIXES } from '@agent-edit/shared';

const providerRefSchema = z.object({
  id: z.string(),
  model: z.string().nullable(),
  isMock: z.boolean(),
});
export type ProviderRef = z.infer<typeof providerRefSchema>;

export const momentKindSchema = z.enum(['silence', 'repeated_take', 'chapter', 'highlight']);

export const mediaAnalysisSchema = z.object({
  mediaId: idSchema(ID_PREFIXES.media),
  segments: z.array(
    z.object({
      start: z.number(),
      end: z.number(),
      text: z.string(),
      speaker: z.string().nullable(),
    }),
  ),
  segmentProvider: providerRefSchema.nullable(),
  scenes: z.array(
    z.object({
      start: z.number(),
      end: z.number(),
      summary: z.string().nullable(),
      provider: providerRefSchema.nullable(),
    }),
  ),
  moments: z.array(
    z.object({
      kind: momentKindSchema,
      start: z.number(),
      end: z.number(),
      score: z.number(),
      title: z.string().nullable(),
      reason: z.string().nullable(),
      provider: providerRefSchema,
    }),
  ),
});
export type MediaAnalysis = z.infer<typeof mediaAnalysisSchema>;
