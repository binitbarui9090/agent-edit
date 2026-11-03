import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  compilePlan,
  planWithModel,
  ruleBasedPlan,
  type ProviderInfo,
} from '@agent-edit/ai-engine';
import { loadAgentContext, publishEvent, type AgentRunDoc } from '@agent-edit/infra';
import { findActiveRegion } from '@agent-edit/media-engine';
import { ticksToSeconds } from '@agent-edit/shared';
import { clipEnd, timelineDuration } from '@agent-edit/timeline-engine';
import type { AgentPlan, ShortProposal } from '@agent-edit/validation';
import type { PipelineContext } from '../media/pipeline.js';

const RULES_PROVIDER: ProviderInfo = { id: 'rules', model: null, isMock: false };

/**
 * Planning. Reads footage analysis, asks the model, and compiles the answer into operations checked
 * against the real reducer. It writes a proposal and nothing else: only the creator's approval, in
 * the API, can change a timeline.
 */
/**
 * Frames each Short on where the movement is. A shot with no clear region stays centred and says so,
 * and a Short should never fail over its crop.
 */
async function frameShorts(
  ctx: PipelineContext,
  shorts: ShortProposal[],
): Promise<ShortProposal[]> {
  const framed: ShortProposal[] = [];
  for (const short of shorts) {
    const media = await ctx.database.media.findOne({ _id: short.sourceMediaId });
    if (!media?.storage.proxyKey) {
      framed.push(short);
      continue;
    }
    const scratch = await ctx.cache.scratch(media._id, 'framing');
    try {
      const proxy = join(scratch, 'proxy.mp4');
      await ctx.storage.downloadToFile(media.storage.proxyKey, proxy, ctx.signal);
      const position = await findActiveRegion(
        ctx.binaries.ffmpeg,
        proxy,
        ticksToSeconds(short.sourceIn),
        ticksToSeconds(short.sourceOut - short.sourceIn),
        { signal: ctx.signal, tracker: ctx.tracker },
      );
      framed.push(
        position === null ? short : { ...short, framing: position, framingSource: 'motion' },
      );
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log.warn({ err, mediaId: media._id }, 'could not measure framing, keeping centre crop');
      framed.push(short);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  return framed;
}

export async function processAgentRun(ctx: PipelineContext, runId: string): Promise<void> {
  const run = await ctx.database.agentRuns.findOne({ _id: runId });
  if (!run || run.status !== 'queued') return;

  const update = async (fields: Partial<AgentRunDoc>) => {
    await ctx.database.agentRuns.updateOne(
      { _id: runId },
      { $set: { ...fields, updatedAt: new Date() } },
    );
    await publishEvent(ctx.redis, {
      type: 'agent.changed',
      projectId: run.projectId,
      timelineId: run.timelineId,
      runId,
    });
  };

  try {
    await update({ status: 'planning', stage: 'Reading the timeline and footage analysis' });
    const timeline = await ctx.database.timelines.findOne({ _id: run.timelineId });
    if (!timeline) throw new Error('The timeline no longer exists');
    const context = await loadAgentContext(ctx.database, timeline);

    const model = ctx.ai.language;
    let plan: AgentPlan;
    let provider: ProviderInfo;
    const warnings: string[] = [];
    if (model) {
      await update({ stage: `Asking ${model.info.model ?? model.info.id} for a plan` });
      const clips = timeline.tracks.flatMap((track) =>
        track.clips.map((clip) => ({
          id: clip.id,
          track: track.type,
          start: ticksToSeconds(clip.start),
          end: ticksToSeconds(clipEnd(clip)),
          name:
            clip.kind === 'media'
              ? (context.compile.library.get(clip.sourceMediaId)?.name ?? 'footage')
              : clip.text,
          speed: clip.speed,
        })),
      );
      const silences = context.compile.silences;
      const result = await planWithModel(
        model,
        {
          instruction: run.instruction,
          durationSeconds: ticksToSeconds(timelineDuration(timeline)),
          clips: clips.slice(0, 300),
          library: [...context.compile.library.values()].map((item) => ({
            id: item.id,
            name: item.name,
            folder: item.folder,
            seconds: ticksToSeconds(item.duration),
          })),
          transcript: context.compile.segments.map((segment) => ({
            start: ticksToSeconds(segment.start),
            end: ticksToSeconds(segment.end),
            text: segment.text,
          })),
          silenceCount: silences.length,
          silenceSeconds: silences.reduce(
            (sum, range) => sum + ticksToSeconds(range.end - range.start),
            0,
          ),
          repeatedTakeCount: context.repeatedTakeCount,
          hasCaptions: timeline.tracks.some(
            (track) => track.type === 'CAPTIONS' && track.clips.length > 0,
          ),
        },
        ctx.signal,
      );
      plan = result.plan;
      provider = model.info;
      warnings.push(...result.warnings);
      if (model.info.isMock) warnings.push('This plan is demo output from a mock provider.');
    } else {
      plan = ruleBasedPlan(run.instruction);
      provider = RULES_PROVIDER;
      warnings.push('No AI model is configured, so this plan came from pattern-matching rules.');
    }

    await update({ stage: 'Checking the plan against the timeline' });
    const compiled = compilePlan(plan, timeline, context.compile, context.media);
    if (compiled.shorts.length > 0) {
      await update({ stage: 'Finding the subject in each Short' });
      compiled.shorts = await frameShorts(ctx, compiled.shorts);
    }
    if (context.compile.segments.length === 0) {
      warnings.push('This footage has no transcript, so speech-based edits cannot run.');
    }
    if (compiled.steps.length > 0 && compiled.steps.every((step) => step.error)) {
      warnings.push('None of the steps in this plan could be applied.');
    }
    await update({
      status: 'proposed',
      stage: null,
      plan,
      steps: compiled.steps,
      ops: compiled.ops,
      shorts: compiled.shorts,
      warnings,
      provider,
    });
  } catch (err) {
    ctx.log.error({ err, runId }, 'agent planning failed');
    await update({
      status: 'failed',
      stage: null,
      error: err instanceof Error ? err.message : 'Planning failed',
    });
  }
}
