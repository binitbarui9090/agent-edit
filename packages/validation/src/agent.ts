import { ID_PREFIXES } from '@agent-edit/shared';
import { z } from 'zod';
import { idSchema } from './common.js';
import { timelineOperationSchema, undoRedoRequestSchema } from './operations.js';
import { speedSchema, trackTypeSchema, volumeSchema } from './timeline.js';

export const PLAN_OPERATIONS = [
  'remove_silence',
  'remove_repeated_takes',
  'remove_filler_words',
  'cut_range',
  'speed_range',
  'cut_to_duration',
  'normalize_dialogue',
  'reduce_noise',
  'set_track_volume',
  'add_captions',
  'add_broll',
  'add_music',
  'generate_shorts',
  'trim_clip',
  'remove_clip',
  'split_clip',
  'move_clip',
  'change_track',
  'change_volume',
  'change_speed',
  'update_transition',
] as const;
export const planOperationSchema = z.enum(PLAN_OPERATIONS);
export type PlanOperation = z.infer<typeof planOperationSchema>;

/**
 * What a model returns. Times are seconds, because that is how a transcript reads; the compiler turns
 * them into frame-snapped ticks. A flat object with nullable fields works with every provider's
 * structured output mode, which a discriminated union does not.
 */
export const planStepSchema = z.object({
  operation: planOperationSchema,
  reason: z.string().max(500),
  clipId: z.string().nullable(),
  /** Seconds on the timeline. */
  start: z.number().nullable(),
  end: z.number().nullable(),
  // Models fill fields a step does not use with zeros. An impossible value counts as not given, and
  // a step that needed it then fails on its own rather than sinking the whole plan.
  speed: speedSchema.nullable().catch(null),
  volume: volumeSchema.nullable().catch(null),
  trackType: trackTypeSchema.nullable(),
  /** What to look for, such as the subject of B-roll or the mood of music. */
  query: z.string().max(200).nullable(),
  mediaId: z.string().nullable(),
  count: z.number().int().min(1).max(10).nullable().catch(null),
  /** A target length, or the minimum pause worth removing. */
  seconds: z.number().positive().nullable().catch(null),
});
export type PlanStep = z.infer<typeof planStepSchema>;

export const agentPlanSchema = z.object({
  summary: z.string().max(1000),
  steps: z.array(planStepSchema).max(100),
});
export type AgentPlan = z.infer<typeof agentPlanSchema>;

export const compiledPlanStepSchema = z.object({
  index: z.number().int().nonnegative(),
  operation: planOperationSchema,
  reason: z.string(),
  /** What this step will do, stated from what the compiler found rather than what the model said. */
  summary: z.string(),
  operationCount: z.number().int().nonnegative(),
  /** How much shorter this step makes the edit, measured. Negative if it gets longer. */
  secondsSaved: z.number().default(0),
  /** Why the step cannot apply. Nothing from it enters the plan. */
  error: z.string().nullable(),
});
export type CompiledPlanStep = z.infer<typeof compiledPlanStepSchema>;

export const shortProposalSchema = z.object({
  name: z.string(),
  reason: z.string(),
  sourceMediaId: idSchema(ID_PREFIXES.media),
  sourceIn: z.number(),
  sourceOut: z.number(),
  /** Where the subject sits across the source picture: -1 is its left edge, 1 its right. */
  framing: z.number().min(-1).max(1),
  framingSource: z.enum(['center', 'motion']),
  captions: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
});
export type ShortProposal = z.infer<typeof shortProposalSchema>;

export const AGENT_RUN_STATUSES = [
  'queued',
  'planning',
  'proposed',
  /** A question was answered, or there was nothing to edit. Nothing awaits review. */
  'answered',
  'applied',
  'rejected',
  'stale',
  'failed',
] as const;
export const agentRunStatusSchema = z.enum(AGENT_RUN_STATUSES);
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

/** What the creator was looking at when they asked, so "this clip" and "here" mean something. */
export const agentRunContextSchema = z.strictObject({
  selectedClipIds: z.array(z.string().max(64)).max(50),
  playheadSeconds: z.number().nonnegative(),
});
export type AgentRunContext = z.infer<typeof agentRunContextSchema>;

export const agentImpactSchema = z.object({
  beforeSeconds: z.number().nonnegative(),
  afterSeconds: z.number().nonnegative(),
});
export type AgentImpact = z.infer<typeof agentImpactSchema>;

export const agentSuggestionSchema = z.object({
  id: planOperationSchema,
  label: z.string(),
  instruction: z.string(),
});
export type AgentSuggestion = z.infer<typeof agentSuggestionSchema>;

export const agentRunSchema = z.object({
  id: idSchema(ID_PREFIXES.agentRun),
  timelineId: idSchema(ID_PREFIXES.timeline),
  instruction: z.string(),
  status: agentRunStatusSchema,
  stage: z.string().nullable(),
  baseRevision: z.number().int().nonnegative(),
  summary: z.string().nullable(),
  steps: z.array(compiledPlanStepSchema),
  ops: z.array(timelineOperationSchema),
  shorts: z.array(shortProposalSchema),
  warnings: z.array(z.string()),
  impact: agentImpactSchema.nullable().default(null),
  provider: z
    .object({ id: z.string(), model: z.string().nullable(), isMock: z.boolean() })
    .nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AgentRun = z.infer<typeof agentRunSchema>;

export const createAgentRunRequestSchema = z.strictObject({
  instruction: z.string().trim().min(1, 'Tell the agent what to do').max(2000),
  context: agentRunContextSchema.optional(),
});

export const applyAgentRunRequestSchema = undoRedoRequestSchema.extend({
  /** Steps the user kept. Everything else is left out of the commit. */
  enabledSteps: z.array(z.number().int().nonnegative()).max(100),
});

export const agentRunParamsSchema = z.strictObject({
  id: idSchema(ID_PREFIXES.project),
  timelineId: idSchema(ID_PREFIXES.timeline),
  runId: idSchema(ID_PREFIXES.agentRun),
});
