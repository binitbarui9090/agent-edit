import { ID_PREFIXES, MAX_SIGN_BATCH, PROCESSING_STEPS } from '@agent-edit/shared';
import { z } from 'zod';
import { idSchema, isoDateSchema, ticksSchema } from './common.js';
import { mediaIdSchema } from './timeline.js';

const mediaNameSchema = z.string().trim().min(1, 'Name is required').max(255);
const folderSchema = z.string().trim().min(1).max(80).nullable();

export const mediaStatusSchema = z.enum(['uploading', 'processing', 'ready', 'failed']);
export type MediaStatus = z.infer<typeof mediaStatusSchema>;

export const stepSchema = z.enum(PROCESSING_STEPS);
export const jobStatusSchema = z.enum(['queued', 'running', 'done', 'failed', 'skipped']);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const analysisJobSchema = z.object({
  step: stepSchema,
  status: jobStatusSchema,
  progress: z.number().min(0).max(1),
  error: z.string().nullable(),
  provider: z.object({ id: z.string(), isMock: z.boolean() }),
  note: z.string().nullable(),
});
export type AnalysisJob = z.infer<typeof analysisJobSchema>;

export const mediaProbeSchema = z.object({
  duration: ticksSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  frameRate: z.object({ num: z.number().int().positive(), den: z.number().int().positive() }),
  isVariableFrameRate: z.boolean(),
  rotation: z.number().int(),
  container: z.string(),
  videoCodec: z.string(),
  audioCodec: z.string().nullable(),
  audioChannels: z.number().int().nonnegative(),
  sampleRate: z.number().int().nonnegative(),
  bitrate: z.number().int().nonnegative(),
});
export type MediaProbe = z.infer<typeof mediaProbeSchema>;

export const mediaAssetSchema = z.object({
  id: mediaIdSchema,
  projectId: idSchema(ID_PREFIXES.project),
  name: z.string(),
  folder: z.string().nullable(),
  status: mediaStatusSchema,
  size: z.number().int().nonnegative(),
  error: z.string().nullable(),
  probe: mediaProbeSchema.nullable(),
  jobs: z.array(analysisJobSchema),
  posterUrl: z.url().nullable(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type MediaAsset = z.infer<typeof mediaAssetSchema>;

export const mediaListSchema = z.object({
  items: z.array(mediaAssetSchema),
  nextCursor: z.string().nullable(),
});
export type MediaList = z.infer<typeof mediaListSchema>;

export const mediaPlaybackSchema = mediaAssetSchema.extend({
  proxyUrl: z.url().nullable(),
  thumbnailUrls: z.array(z.url()),
  waveform: z.object({ url: z.url(), peaksPerSecond: z.number().int().positive() }).nullable(),
});
export type MediaPlayback = z.infer<typeof mediaPlaybackSchema>;

export const updateMediaRequestSchema = z
  .strictObject({ name: mediaNameSchema.optional(), folder: folderSchema.optional() })
  .refine((v) => v.name !== undefined || v.folder !== undefined, 'Nothing to update');
export type UpdateMediaRequest = z.infer<typeof updateMediaRequestSchema>;

export const initUploadRequestSchema = z.strictObject({
  name: mediaNameSchema,
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/, 'Expected a SHA-256 hex digest'),
});
export type InitUploadRequest = z.infer<typeof initUploadRequestSchema>;

export const uploadedPartSchema = z.object({
  partNumber: z.number().int().positive(),
  size: z.number().int().nonnegative(),
});

export const uploadStateSchema = z.object({
  media: mediaAssetSchema,
  partSize: z.number().int().positive(),
  partCount: z.number().int().positive(),
  uploadedParts: z.array(uploadedPartSchema),
  resumed: z.boolean(),
});
export type UploadState = z.infer<typeof uploadStateSchema>;

export const signPartsRequestSchema = z.strictObject({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(MAX_SIGN_BATCH),
});

export const signPartsResponseSchema = z.object({
  urls: z.array(z.object({ partNumber: z.number().int().positive(), url: z.url() })),
});

export const mediaParamsSchema = z.strictObject({
  id: idSchema(ID_PREFIXES.project),
  mediaId: mediaIdSchema,
});

export const listMediaQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().max(200).optional(),
});

/** Sent over the WebSocket. Progress patches the cache; `changed` triggers a refetch. */
export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('job.progress'),
    projectId: idSchema(ID_PREFIXES.project),
    mediaId: mediaIdSchema,
    step: stepSchema,
    status: jobStatusSchema,
    progress: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal('media.changed'),
    projectId: idSchema(ID_PREFIXES.project),
    mediaId: mediaIdSchema,
  }),
  z.object({
    type: z.literal('render.changed'),
    projectId: idSchema(ID_PREFIXES.project),
    renderId: idSchema(ID_PREFIXES.renderJob),
    status: z.enum(['queued', 'running', 'done', 'failed', 'cancelled']),
    progress: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal('agent.changed'),
    projectId: idSchema(ID_PREFIXES.project),
    timelineId: idSchema(ID_PREFIXES.timeline),
    runId: idSchema(ID_PREFIXES.agentRun),
  }),
  z.object({
    type: z.literal('timeline.changed'),
    projectId: idSchema(ID_PREFIXES.project),
    timelineId: idSchema(ID_PREFIXES.timeline),
    revision: z.number().int().nonnegative(),
  }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;

export const clientEventSchema = z.strictObject({
  type: z.literal('subscribe'),
  projectId: idSchema(ID_PREFIXES.project),
});
export type ClientEvent = z.infer<typeof clientEventSchema>;
