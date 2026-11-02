import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  findMomentsWithModel,
  findMomentsWithRules,
  findRepeatedTakes,
  ModelOutputError,
  type FoundMoment,
  type ProviderInfo,
} from '@agent-edit/ai-engine';
import type { AnalysisJobDoc, MediaDoc, MomentKind } from '@agent-edit/infra';
import { detectSceneChanges, detectSilence, extractFrame } from '@agent-edit/media-engine';
import { newId, secondsToTicks, ticksToSeconds, type ProcessingStep } from '@agent-edit/shared';
import type { PipelineContext, StepRunner } from './pipeline.js';

/** A step that cannot run and is not a failure, such as no provider being configured. */
export class SkipStep extends Error {}

const FFMPEG_PROVIDER: ProviderInfo = { id: 'ffmpeg', model: null, isMock: false };
const RULES_PROVIDER: ProviderInfo = { id: 'rules', model: null, isMock: false };
/** Enough to describe a long recording's look without one model call per cut. */
const MAX_VISUAL_SCENES = 40;

async function recordProvider(
  ctx: PipelineContext,
  media: MediaDoc,
  step: ProcessingStep,
  provider: ProviderInfo,
  note?: string,
) {
  const fields: Partial<AnalysisJobDoc> = {
    provider: {
      id: provider.model ? `${provider.id}:${provider.model}` : provider.id,
      isMock: provider.isMock,
    },
    ...(note ? { note } : {}),
  };
  await ctx.database.analysisJobs.updateOne({ mediaId: media._id, step }, { $set: fields });
}

function requireProbe(media: MediaDoc) {
  if (!media.probe) throw new SkipStep('Metadata could not be read');
  return media.probe;
}

async function downloadAudio(ctx: PipelineContext, media: MediaDoc, step: string) {
  if (!media.storage.audioKey) throw new SkipStep('This footage has no audio');
  const scratch = await ctx.cache.scratch(media._id, step);
  const path = join(scratch, 'audio.flac');
  await ctx.storage.downloadToFile(media.storage.audioKey, path, ctx.signal);
  return { scratch, path };
}

export const runTranscript: StepRunner = async (ctx, media, report) => {
  const speech = ctx.ai.speech;
  if (!speech) throw new SkipStep('No speech-to-text provider is configured');
  const { scratch, path } = await downloadAudio(ctx, media, 'transcript');
  try {
    await recordProvider(ctx, media, 'transcript', speech.info);
    const { segments } = await speech.transcribe(path, {
      signal: ctx.signal,
      onProgress: (fraction) => report(fraction * 0.95),
    });
    // Replaced whole, so a retry cannot leave a mix of two attempts.
    await ctx.database.segments.deleteMany({ mediaId: media._id });
    if (segments.length > 0) {
      await ctx.database.segments.insertMany(
        segments.map((segment) => ({
          _id: newId('seg'),
          mediaId: media._id,
          projectId: media.projectId,
          start: secondsToTicks(segment.start),
          end: secondsToTicks(segment.end),
          text: segment.text,
          speaker: segment.speaker,
          words: segment.words,
          provider: speech.info,
        })),
      );
    }
    const spans = segments.map(({ start, end, text }) => ({ start, end, text }));
    await replaceMoments(
      ctx,
      media,
      ['repeated_take'],
      findRepeatedTakes(spans).map((take) => ({
        kind: 'repeated_take' as const,
        start: take.start,
        end: take.end,
        score: take.score,
        title: take.text.slice(0, 120),
        reason: `Said again at ${take.keptAt.toFixed(1)}s`,
      })),
      RULES_PROVIDER,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

async function replaceMoments(
  ctx: PipelineContext,
  media: MediaDoc,
  kinds: MomentKind[],
  moments: Array<
    Pick<FoundMoment, 'start' | 'end' | 'score' | 'title' | 'reason'> & { kind: MomentKind }
  >,
  provider: ProviderInfo,
) {
  await ctx.database.moments.deleteMany({ mediaId: media._id, kind: { $in: kinds } });
  if (moments.length === 0) return;
  await ctx.database.moments.insertMany(
    moments.map((moment) => ({
      _id: newId('mom'),
      mediaId: media._id,
      projectId: media.projectId,
      kind: moment.kind,
      // Moments arrive in seconds from models and rules alike. Storage is always ticks.
      start: secondsToTicks(moment.start),
      end: secondsToTicks(moment.end),
      score: moment.score,
      title: moment.title,
      reason: moment.reason,
      provider,
    })),
  );
}

export const runSilence: StepRunner = async (ctx, media, report) => {
  const probe = requireProbe(media);
  const { scratch, path } = await downloadAudio(ctx, media, 'silence');
  try {
    const ranges = await detectSilence(ctx.binaries.ffmpeg, path, {
      duration: ticksToSeconds(probe.duration),
      signal: ctx.signal,
      tracker: ctx.tracker,
      onProgress: (fraction) => report(fraction * 0.95),
    });
    await replaceMoments(
      ctx,
      media,
      ['silence'],
      ranges.map((range) => ({
        kind: 'silence' as const,
        start: ticksToSeconds(range.start),
        end: ticksToSeconds(range.end),
        score: 1,
        title: null,
        reason: 'Measured from the audio',
      })),
      FFMPEG_PROVIDER,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

export const runScenes: StepRunner = async (ctx, media, report) => {
  const probe = requireProbe(media);
  if (!media.storage.proxyKey) throw new SkipStep('The proxy is not available');
  const scratch = await ctx.cache.scratch(media._id, 'scenes');
  try {
    const proxy = join(scratch, 'proxy.mp4');
    await ctx.storage.downloadToFile(media.storage.proxyKey, proxy, ctx.signal);
    const cuts = await detectSceneChanges(ctx.binaries.ffmpeg, proxy, {
      duration: ticksToSeconds(probe.duration),
      signal: ctx.signal,
      tracker: ctx.tracker,
      onProgress: (fraction) => report(fraction * 0.95),
    });
    const boundaries = [0, ...cuts, probe.duration];
    await ctx.database.scenes.deleteMany({ mediaId: media._id });
    await ctx.database.scenes.insertMany(
      boundaries.slice(0, -1).map((start, index) => ({
        _id: newId('scn'),
        mediaId: media._id,
        projectId: media.projectId,
        start,
        end: boundaries[index + 1]!,
        summary: null,
        provider: null,
      })),
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

/** Speakers come with the transcript when its provider can tell them apart. */
export const runSpeakers: StepRunner = async (ctx, media) => {
  const speech = ctx.ai.speech;
  if (!speech) throw new SkipStep('No speech-to-text provider is configured');
  if (!speech.identifiesSpeakers) {
    throw new SkipStep(`${speech.info.id} does not identify speakers. Deepgram does.`);
  }
  const labelled = await ctx.database.segments.countDocuments({
    mediaId: media._id,
    speaker: { $ne: null },
  });
  if (labelled === 0) throw new SkipStep('No speaker labels were returned');
  await recordProvider(ctx, media, 'speakers', speech.info);
};

export const runVisual: StepRunner = async (ctx, media, report) => {
  const vision = ctx.ai.vision;
  if (!vision) throw new SkipStep('No vision provider is configured');
  if (!media.storage.proxyKey) throw new SkipStep('The proxy is not available');
  const scenes = await ctx.database.scenes
    .find({ mediaId: media._id })
    .sort({ start: 1 })
    .toArray();
  if (scenes.length === 0) throw new SkipStep('No scenes were found');
  const stride = Math.max(1, Math.ceil(scenes.length / MAX_VISUAL_SCENES));
  const chosen = scenes.filter((_scene, index) => index % stride === 0);
  await recordProvider(
    ctx,
    media,
    'visual',
    vision.info,
    chosen.length < scenes.length
      ? `Described ${chosen.length} of ${scenes.length} scenes, evenly spaced`
      : undefined,
  );
  const scratch = await ctx.cache.scratch(media._id, 'visual');
  try {
    const proxy = join(scratch, 'proxy.mp4');
    await ctx.storage.downloadToFile(media.storage.proxyKey, proxy, ctx.signal);
    for (const [index, scene] of chosen.entries()) {
      const frame = join(scratch, `frame-${index}.jpg`);
      await extractFrame(
        ctx.binaries.ffmpeg,
        proxy,
        frame,
        ticksToSeconds((scene.start + scene.end) / 2),
        {
          signal: ctx.signal,
          tracker: ctx.tracker,
        },
      );
      const summary = await vision.describeImage(
        frame,
        'Describe what is visible in this video frame in one short sentence, for someone looking for footage.',
        ctx.signal,
      );
      await ctx.database.scenes.updateOne(
        { _id: scene._id },
        { $set: { summary: summary.slice(0, 500), provider: vision.info } },
      );
      report((index + 1) / chosen.length);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

export const runMoments: StepRunner = async (ctx, media, report) => {
  const segments = await ctx.database.segments
    .find({ mediaId: media._id })
    .sort({ start: 1 })
    .toArray();
  const scenes = await ctx.database.scenes
    .find({ mediaId: media._id })
    .sort({ start: 1 })
    .toArray();
  if (segments.length === 0 && scenes.length === 0) {
    throw new SkipStep('There is no transcript or scene list to read');
  }
  const spans = segments.map((segment) => ({
    start: ticksToSeconds(segment.start),
    end: ticksToSeconds(segment.end),
    text: segment.text,
  }));
  const sceneStarts = scenes.map((scene) => ticksToSeconds(scene.start));
  const model = ctx.ai.language;

  let found: FoundMoment[];
  let provider = RULES_PROVIDER;
  let note: string | undefined = 'Rule-based: no language model is configured';
  if (model && spans.length > 0) {
    // Recorded first, so a failure is attributed to what actually ran.
    await recordProvider(ctx, media, 'moments', model.info);
    try {
      found = await findMomentsWithModel(model, spans, {
        signal: ctx.signal,
        onProgress: (fraction) => report(fraction * 0.95),
      });
      provider = model.info;
      note = undefined;
    } catch (err) {
      if (!(err instanceof ModelOutputError)) throw err;
      // Useful results beat a failed step, as long as they are labelled for what they are.
      found = findMomentsWithRules(spans, sceneStarts);
      note = 'Rule-based: the model did not return usable results';
    }
  } else {
    found = findMomentsWithRules(spans, sceneStarts);
  }
  await recordProvider(ctx, media, 'moments', provider, note);
  await replaceMoments(ctx, media, ['chapter', 'highlight'], found, provider);
};
