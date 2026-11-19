import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assessPlan,
  chooseEditorialCut,
  compilePlan,
  ModelOutputError,
  planInstruction,
  sourceToTimeline,
  type PlanRoute,
  type PlannerContext,
  type ProviderInfo,
  type SourceRange,
} from '@agent-edit/ai-engine';
import {
  loadAgentContext,
  publishEvent,
  type AgentContext,
  type AgentRunDoc,
  type TimelineDoc,
} from '@agent-edit/infra';
import { findActiveRegion } from '@agent-edit/media-engine';
import { ticksToSeconds } from '@agent-edit/shared';
import { clipEnd, timelineDuration } from '@agent-edit/timeline-engine';
import type { ShortProposal } from '@agent-edit/validation';
import type { PipelineContext } from '../media/pipeline.js';

const RULES_PROVIDER: ProviderInfo = { id: 'rules', model: null, isMock: false };
const INSTANT_PROVIDER: ProviderInfo = { id: 'instant', model: null, isMock: false };
const HISTORY_RUNS = 6;
const MAX_NOTES = 40;

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

function providerFor(route: PlanRoute, model: ProviderInfo | null): ProviderInfo {
  if (route === 'instant') return INSTANT_PROVIDER;
  return route === 'rules' || !model ? RULES_PROVIDER : model;
}

/** Everything the model reads, in timeline seconds: that is what the times it answers with mean. */
async function plannerContext(
  ctx: PipelineContext,
  run: AgentRunDoc,
  timeline: TimelineDoc,
  context: AgentContext,
): Promise<PlannerContext> {
  const { library, segments, silences, moments } = context.compile;
  const place = (range: SourceRange) => {
    const [found] = sourceToTimeline(timeline, range);
    return found ? { start: ticksToSeconds(found.start), end: ticksToSeconds(found.end) } : null;
  };
  const earlier = await ctx.database.agentRuns
    .find({ timelineId: run.timelineId, _id: { $ne: run._id }, createdAt: { $lt: run.createdAt } })
    .sort({ createdAt: -1 })
    .limit(HISTORY_RUNS)
    .toArray();
  return {
    instruction: run.instruction,
    durationSeconds: ticksToSeconds(timelineDuration(timeline)),
    clips: timeline.tracks
      .flatMap((track) =>
        track.clips.map((clip) => ({
          id: clip.id,
          track: track.type,
          start: ticksToSeconds(clip.start),
          end: ticksToSeconds(clipEnd(clip)),
          name:
            clip.kind === 'media'
              ? (library.get(clip.sourceMediaId)?.name ?? 'footage')
              : clip.text,
          speed: clip.speed,
        })),
      )
      .slice(0, 300),
    library: [...library.values()].map((item) => ({
      id: item.id,
      name: item.name,
      folder: item.folder,
      seconds: ticksToSeconds(item.duration),
    })),
    transcript: segments
      .flatMap((segment) =>
        sourceToTimeline(timeline, segment).map(({ start, end }) => ({
          start: ticksToSeconds(start),
          end: ticksToSeconds(end),
          text: segment.text,
        })),
      )
      .sort((a, b) => a.start - b.start),
    silenceCount: silences.length,
    silenceSeconds: silences.reduce(
      (sum, range) => sum + ticksToSeconds(range.end - range.start),
      0,
    ),
    repeatedTakeCount: context.repeatedTakeCount,
    hasCaptions: timeline.tracks.some(
      (track) => track.type === 'CAPTIONS' && track.clips.length > 0,
    ),
    selectedClipIds: run.context?.selectedClipIds ?? [],
    ...(run.context ? { playheadSeconds: run.context.playheadSeconds } : {}),
    history: earlier.reverse().map((item) => ({
      instruction: item.instruction,
      summary: item.plan?.summary ?? null,
      status: item.status,
    })),
    chapters: context.chapters.slice(0, MAX_NOTES).flatMap((chapter) => {
      const at = place(chapter);
      return at && chapter.title ? [{ start: at.start, title: chapter.title }] : [];
    }),
    highlights: moments.slice(0, MAX_NOTES).flatMap((moment) => {
      const at = place(moment);
      return at && moment.title ? [{ ...at, title: moment.title }] : [];
    }),
    scenes: context.scenes.slice(0, MAX_NOTES).flatMap((scene) => {
      const at = place(scene);
      return at ? [{ start: at.start, summary: scene.summary }] : [];
    }),
  };
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
    const planning = await plannerContext(ctx, run, timeline, context);
    if (model) await update({ stage: `Asking ${model.info.model ?? model.info.id} for a plan` });
    const { plan, warnings, route } = await planInstruction(model, planning, ctx.signal);
    const provider = providerFor(route, model?.info ?? null);
    if (route === 'rules') {
      warnings.push('No AI model is configured, so this plan came from pattern-matching rules.');
    }
    if (provider.isMock) warnings.push('This plan is demo output from a mock provider.');

    const editorial: SourceRange[] = [];
    const target = plan.steps.find((step) => step.operation === 'cut_to_duration');
    if (model && target?.seconds) {
      await update({ stage: 'Choosing which lines to keep' });
      const spoken = context.compile.segments.flatMap((segment) => {
        const [place] = sourceToTimeline(timeline, segment);
        return place
          ? [{ segment, seconds: ticksToSeconds(place.end - place.start), text: segment.text }]
          : [];
      });
      const keep = await chooseEditorialCut(model, spoken, target.seconds, ctx.signal);
      if (keep) {
        for (const index of keep) {
          const { mediaId, start, end } = spoken[index]!.segment;
          editorial.push({ mediaId, start, end });
        }
      } else {
        warnings.push('The model did not choose lines, so analysis scores decided what to keep.');
      }
      context.compile.editorialKeep = editorial;
    }

    await update({ stage: 'Checking the plan against the timeline' });
    const compiled = compilePlan(plan, timeline, context.compile, context.media);
    const assessed = assessPlan(timeline, compiled, plan);
    warnings.push(...assessed.warnings);
    if (compiled.shorts.length > 0) {
      await update({ stage: 'Finding the subject in each Short' });
      compiled.shorts = await frameShorts(ctx, compiled.shorts);
    }
    if (context.compile.segments.length === 0 && plan.steps.length > 0) {
      warnings.push('This footage has no transcript, so speech-based edits cannot run.');
    }
    if (compiled.steps.length > 0 && compiled.steps.every((step) => step.error)) {
      warnings.push('None of the steps in this plan could be applied.');
    }
    await update({
      status: plan.steps.length > 0 ? 'proposed' : 'answered',
      stage: null,
      plan,
      steps: compiled.steps,
      ops: compiled.ops,
      shorts: compiled.shorts,
      warnings,
      impact: assessed.impact,
      editorial,
      provider,
    });
  } catch (err) {
    ctx.log.error({ err, runId }, 'agent planning failed');
    await update({
      status: 'failed',
      stage: null,
      error:
        err instanceof ModelOutputError
          ? 'The model could not produce a usable plan. Try saying it differently.'
          : err instanceof Error
            ? err.message
            : 'Planning failed',
    });
  }
}
