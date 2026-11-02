import {
  ASPECT_RATIO_KEYS,
  ID_PREFIXES,
  isSupportedFrameRate,
  isValidResolution,
} from '@agent-edit/shared';
import { z } from 'zod';
import { idSchema, isoDateSchema } from './common.js';

export const frameRateSchema = z
  .strictObject({ num: z.number().int().positive(), den: z.number().int().positive() })
  .refine(isSupportedFrameRate, 'Unsupported frame rate');

export const projectSettingsSchema = z
  .strictObject({
    aspectRatio: z.enum(ASPECT_RATIO_KEYS),
    width: z.number().int().min(16).max(7680),
    height: z.number().int().min(16).max(7680),
    frameRate: frameRateSchema,
  })
  .refine((s) => isValidResolution(s.aspectRatio, s.width, s.height), {
    message: 'Resolution must be even-sided and match the aspect ratio',
    path: ['width'],
  });
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

const projectNameSchema = z.string().trim().min(1, 'Name is required').max(120);

export const createProjectRequestSchema = z.strictObject({
  name: projectNameSchema,
  settings: projectSettingsSchema,
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const updateProjectRequestSchema = z
  .strictObject({
    name: projectNameSchema.optional(),
    settings: projectSettingsSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.settings !== undefined, 'Nothing to update');
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

export const projectIdParamsSchema = z.strictObject({ id: idSchema(ID_PREFIXES.project) });

export const listProjectsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(200).optional(),
});

export const projectSchema = z.object({
  id: idSchema(ID_PREFIXES.project),
  name: z.string(),
  settings: projectSettingsSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type Project = z.infer<typeof projectSchema>;

export const projectListSchema = z.object({
  items: z.array(projectSchema),
  nextCursor: z.string().nullable(),
});
export type ProjectList = z.infer<typeof projectListSchema>;
