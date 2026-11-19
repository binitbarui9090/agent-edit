import { newId, secondsToTicks, snapToFrame } from '@agent-edit/shared';
import { applyOperations, createDefaultTracks, createMediaClip } from '@agent-edit/timeline-engine';
import type { AgentPlan, PlanStep, TimelineState } from '@agent-edit/validation';
import { agentPlanSchema } from '@agent-edit/validation';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  assessPlan,
  compilePlan,
  sourceToTimeline,
  type CompileContext,
  type LibraryItem,
} from './compile.js';
import {
  chooseEditorialCut,
  isQuestion,
  planInstruction,
  reconcilePlan,
  type PlannerContext,
} from './planner.js';
import { MockLanguageModel } from './providers/mock.js';
import { suggestEdits } from './suggestions.js';
import { planStep, understandInstruction } from './understand.js';

const rate = { num: 30, den: 1 };
const s = (seconds: number) => snapToFrame(secondsToTicks(seconds), rate);
const talkId = newId('med');

const library = new Map<string, LibraryItem>([
  [
    talkId,
    {
      id: talkId,
      name: 'talk.mp4',
      folder: null,
      duration: s(60),
      width: 1920,
      height: 1080,
      hasAudio: true,
      description: '',
    },
  ],
]);
const media = (id: string) => {
  const item = library.get(id);
  return item ? { duration: item.duration } : undefined;
};

function timeline(): TimelineState {
  const state: TimelineState = {
    width: 1920,
    height: 1080,
    frameRate: rate,
    tracks: createDefaultTracks(),
  };
  const video = state.tracks.find((track) => track.type === 'VIDEO')!;
  const clip = createMediaClip(
    { sourceMediaId: talkId, start: 0, sourceIn: 0, sourceOut: s(60) },
    rate,
  );
  return applyOperations(state, [{ op: 'add_clip', trackId: video.id, clip }], media).state;
}

function line(start: number, end: number, text: string) {
  const parts = text.split(' ');
  const each = (end - start) / parts.length;
  return {
    mediaId: talkId,
    start: s(start),
    end: s(end),
    text,
    words: parts.map((w, i) => ({ w, s: start + i * each, e: start + (i + 1) * each })),
  };
}

const context: CompileContext = {
  segments: [
    line(0, 6, 'Welcome back, um, to the channel today.'),
    line(8, 14, 'The boundary between services matters most.'),
    line(14, 20, 'The boundary between services matters most.'),
    line(25, 32, 'Start with a simple modular design first.'),
    line(40, 50, 'Name the reason before you split anything.'),
  ],
  silences: [{ mediaId: talkId, start: s(20), end: s(25) }],
  moments: [],
  library,
};

const planner = (instruction: string, extra: Partial<PlannerContext> = {}): PlannerContext => ({
  instruction,
  durationSeconds: 60,
  clips: [{ id: 'clip_a', track: 'VIDEO', start: 0, end: 60, name: 'talk.mp4', speed: 1 }],
  library: [],
  transcript: [{ start: 0, end: 6, text: 'Welcome back' }],
  silenceCount: 1,
  silenceSeconds: 5,
  repeatedTakeCount: 1,
  hasCaptions: false,
  ...extra,
});

const operations = (steps: readonly PlanStep[]) => steps.map((step) => step.operation);

describe('understandInstruction', () => {
  const understood = (text: string, extra: Partial<PlannerContext> = {}) =>
    understandInstruction(text, planner(text, extra));

  it.each([
    ['Remove unnecessary pauses.', 'remove_silence'],
    ['please cut the dead air', 'remove_silence'],
    ['can you remove repeated takes?', 'remove_repeated_takes'],
    ['Get rid of the ums and uhs', 'remove_filler_words'],
    ['Create subtitles.', 'add_captions'],
    ['Normalize the dialogue', 'normalize_dialogue'],
    ['Reduce the background noise', 'reduce_noise'],
    ['Add some background music', 'add_music'],
    ['Add relevant B-roll', 'add_broll'],
  ])('reads %s exactly', (text, operation) => {
    const result = understood(text);
    expect(result.complete).toBe(true);
    expect(operations(result.steps)).toEqual([operation]);
  });

  it('takes numbers from the words used', () => {
    expect(understood('Make the first 15 seconds faster').steps[0]).toMatchObject({
      operation: 'speed_range',
      start: 0,
      end: 15,
    });
    expect(understood('Speed up the first 2 minutes to 1.5x').steps[0]).toMatchObject({
      end: 120,
      speed: 1.5,
    });
    expect(understood('Cut the last 10 seconds').steps[0]).toMatchObject({ start: 50, end: 60 });
    expect(understood('Cut from 0:10 to 0:20').steps[0]).toMatchObject({ start: 10, end: 20 });
    expect(understood('Cut this into a 30 second video').steps[0]).toMatchObject({
      operation: 'cut_to_duration',
      seconds: 30,
    });
    expect(understood('Set the B-roll volume to 50%').steps[0]).toMatchObject({
      trackType: 'BROLL',
      volume: 0.5,
    });
    expect(understood('Generate three YouTube Shorts').steps[0]).toMatchObject({ count: 3 });
    expect(understood('make a short about boundaries').steps[0]).toMatchObject({
      count: 1,
      query: 'boundaries',
    });
    expect(understood('Remove pauses longer than 2 seconds').steps[0]).toMatchObject({
      seconds: 2,
    });
  });

  it('reads every clause of a long instruction', () => {
    const result = understood(
      'Make the first 15 seconds faster, remove repeated takes, add relevant B-roll, normalize dialogue, and generate three Shorts.',
    );
    expect(result.complete).toBe(true);
    expect(operations(result.steps)).toEqual([
      'speed_range',
      'remove_repeated_takes',
      'add_broll',
      'normalize_dialogue',
      'generate_shorts',
    ]);
  });

  it.each([
    "Don't remove the pauses",
    'Keep the pauses',
    'Cut the boring part',
    'Remove the part where I talk about money',
    'Make it more cinematic',
    'This drags, tighten it up',
    'Add captions for the first minute',
    'Set the music to 900%',
    'Generate 40 Shorts',
    'What is this about?',
  ])('leaves "%s" for a model rather than guessing', (text) => {
    expect(understood(text).complete).toBe(false);
  });

  it('keeps the clause it knows when another needs a model', () => {
    const result = understood('Remove the pauses and make it feel warmer');
    expect(result.complete).toBe(false);
    expect(operations(result.steps)).toEqual(['remove_silence']);
  });

  it('resolves "this clip" from the selection, and only then', () => {
    expect(understood('Delete this clip').complete).toBe(false);
    const selected = understood('Delete this clip', { selectedClipIds: ['clip_a'] });
    expect(selected.complete).toBe(true);
    expect(selected.steps[0]).toMatchObject({ operation: 'remove_clip', clipId: 'clip_a' });
    expect(understood('Mute this clip', { selectedClipIds: ['clip_a'] }).steps[0]).toMatchObject({
      operation: 'change_volume',
      volume: 0,
    });
  });

  it('splits at the playhead only when there is a clip under it', () => {
    expect(understood('Split here', { playheadSeconds: 12 }).steps[0]).toMatchObject({
      operation: 'split_clip',
      clipId: 'clip_a',
      start: 12,
    });
    expect(understood('Split here', { playheadSeconds: 99 }).complete).toBe(false);
    expect(understood('Split here').complete).toBe(false);
  });
});

describe('isQuestion', () => {
  it.each([
    ['What is this video about?', true],
    ['Summarize this', true],
    ['do I have repeated takes', true],
    ['is the opening too slow', true],
    ['Can you remove the pauses?', false],
    ['Do the same for the music', false],
    ['Remove the pauses', false],
  ])('%s: %s', (text, expected) => {
    expect(isQuestion(text)).toBe(expected);
  });
});

describe('reconcilePlan', () => {
  const plan = (...steps: PlanStep[]): AgentPlan => ({ summary: 'from the model', steps });

  it('strips cuts from an instruction that never asked for any', () => {
    const { plan: result, warnings } = reconcilePlan(
      plan(
        planStep('generate_shorts', 'Make Shorts', { count: 3 }),
        planStep('remove_silence', 'Tidy up'),
      ),
      'Pick some vertical reels for me',
      [],
    );
    expect(operations(result.steps)).toEqual(['generate_shorts']);
    expect(warnings[0]).toContain('Tidy up');
  });

  it('keeps style edits from turning into cuts, and says so when nothing is left', () => {
    const { plan: result } = reconcilePlan(
      plan(planStep('remove_repeated_takes', 'Cinematic pacing')),
      'Make the video more cinematic',
      [],
    );
    expect(result.steps).toEqual([]);
    expect(result.summary).toContain('did not ask');
  });

  it('allows a cut when the words ask for one', () => {
    const { plan: result } = reconcilePlan(
      plan(planStep('remove_silence', 'Tighten')),
      'This drags, tighten it up',
      [],
    );
    expect(operations(result.steps)).toEqual(['remove_silence']);
  });

  it('refuses a target length nobody stated', () => {
    const { plan: result } = reconcilePlan(
      plan(planStep('cut_to_duration', 'Shorten', { seconds: 30 })),
      'Tighten it up',
      [],
    );
    expect(result.steps).toEqual([]);
  });

  it('adds a clause the model dropped, and overrides one it got wrong', () => {
    const { plan: result } = reconcilePlan(
      plan(planStep('generate_shorts', 'Shorts', { count: 2 })),
      'Generate three Shorts and make it warmer, remove the pauses',
      [
        planStep('generate_shorts', 'Create 3', { count: 3 }),
        planStep('remove_silence', 'Remove the pauses'),
      ],
    );
    expect(result.steps.find((step) => step.operation === 'generate_shorts')?.count).toBe(3);
    expect(operations(result.steps)).toContain('remove_silence');
  });

  it('runs whole-edit operations once however many times they are listed', () => {
    const { plan: result } = reconcilePlan(
      plan(
        planStep('remove_silence', 'one'),
        planStep('remove_silence', 'two', { seconds: 1 }),
        planStep('remove_repeated_takes', 'three'),
        planStep('remove_repeated_takes', 'four'),
      ),
      'tighten this up',
      [],
    );
    expect(operations(result.steps)).toEqual(['remove_silence', 'remove_repeated_takes']);
  });

  it('lets a follow-up refer back to something the words here do not repeat', () => {
    const { plan: result } = reconcilePlan(
      plan(planStep('remove_silence', 'Again')),
      'Do that again',
      [],
      { hasHistory: true },
    );
    expect(operations(result.steps)).toEqual(['remove_silence']);
  });
});

describe('planInstruction', () => {
  const unusedModel = new MockLanguageModel(() => {
    throw new Error('the model should not have been asked');
  });

  it('skips the model when the instruction is understood in full', async () => {
    const result = await planInstruction(unusedModel, planner('Remove the pauses'));
    expect(result.route).toBe('instant');
    expect(operations(result.plan.steps)).toEqual(['remove_silence']);
  });

  it('answers a question without proposing an edit', async () => {
    const model = new MockLanguageModel(() => ({ answer: 'It is about boundaries.' }));
    const result = await planInstruction(model, planner('What is this about?'));
    expect(result.route).toBe('answer');
    expect(result.plan).toEqual({ summary: 'It is about boundaries.', steps: [] });
  });

  it('says plainly that answering needs a model when there is none', async () => {
    const result = await planInstruction(null, planner('What is this about?'));
    expect(result.route).toBe('rules');
    expect(result.plan.summary).toContain('language model');
    expect(result.plan.steps).toEqual([]);
  });

  it('falls back to labelled rules without a model', async () => {
    const result = await planInstruction(null, planner('Tighten the pauses a bit please'));
    expect(result.route).toBe('rules');
    expect(operations(result.plan.steps)).toEqual(['remove_silence']);
  });

  it('gives the model what the creator is looking at and what came before', async () => {
    let prompt = '';
    const model = new MockLanguageModel((request) => {
      prompt = request.prompt;
      return { summary: 'ok', steps: [] };
    });
    await planInstruction(
      model,
      planner('Make that warmer', {
        selectedClipIds: ['clip_a'],
        playheadSeconds: 12.5,
        history: [{ instruction: 'Remove pauses', summary: 'Removed', status: 'rejected' }],
        chapters: [{ start: 65, title: 'Boundaries' }],
        highlights: [{ start: 1, end: 9, title: 'The hook' }],
        scenes: [{ start: 3, summary: 'A whiteboard' }],
      }),
    );
    expect(prompt).toContain('Selected clips: clip_a');
    expect(prompt).toContain('Playhead: 12.5s');
    expect(prompt).toMatch(/<earlier_requests>[\s\S]*\(rejected\) "Remove pauses"/);
    expect(prompt).toMatch(/<chapters>[\s\S]*\[1:05\] Boundaries/);
    expect(prompt).toMatch(/<highlights>[\s\S]*The hook/);
    expect(prompt).toMatch(/<scenes>[\s\S]*A whiteboard/);
  });
});

describe('agentPlanSchema', () => {
  it('treats an impossible value in an unused field as not given', () => {
    const parsed = agentPlanSchema.parse({
      summary: 'x',
      steps: [
        {
          ...planStep('update_transition', 'Fade', { clipId: 'clip_a' }),
          speed: 0,
          volume: -1,
          count: 0,
          seconds: 0,
        },
      ],
    });
    expect(parsed.steps[0]).toMatchObject({
      speed: null,
      volume: null,
      count: null,
      seconds: null,
    });
    expect(() => z.toJSONSchema(agentPlanSchema)).not.toThrow();
  });
});

describe('filler words', () => {
  it('cuts them by their word timings', () => {
    const compiled = compilePlan(
      { summary: '', steps: [planStep('remove_filler_words', 'Fillers')] },
      timeline(),
      context,
      media,
    );
    expect(compiled.steps[0]).toMatchObject({ error: null });
    expect(compiled.steps[0]!.summary).toContain('1 filler word');
    expect(compiled.steps[0]!.secondsSaved).toBeGreaterThan(0.5);
  });

  it('says so when the transcript has no word timings', () => {
    const compiled = compilePlan(
      { summary: '', steps: [planStep('remove_filler_words', 'Fillers')] },
      timeline(),
      { ...context, segments: context.segments.map((item) => ({ ...item, words: [] })) },
      media,
    );
    expect(compiled.steps[0]!.error).toContain('word timings');
  });
});

describe('target length', () => {
  const cut = { summary: '', steps: [planStep('cut_to_duration', 'Shorter', { seconds: 12 })] };
  const kept = (state: TimelineState, segment: (typeof context.segments)[number]) =>
    sourceToTimeline(state, segment).length > 0;

  it('keeps the later take of a repeated line, not both', () => {
    const { state } = compilePlan(cut, timeline(), context, media);
    expect(kept(state, context.segments[1]!) && kept(state, context.segments[2]!)).toBe(false);
  });

  it('keeps what an editor chose, and compiles the same way each time', () => {
    const chosen = context.segments[4]!;
    const withChoice = {
      ...context,
      editorialKeep: [{ mediaId: talkId, start: chosen.start, end: chosen.end }],
    };
    const first = compilePlan(cut, timeline(), withChoice, media);
    const second = compilePlan(cut, timeline(), withChoice, media);
    expect(kept(first.state, chosen)).toBe(true);
    expect(first.steps[0]!.secondsSaved).toBe(second.steps[0]!.secondsSaved);
  });

  it('chooses lines by number, ignoring numbers that do not exist', async () => {
    const lines = [
      { seconds: 5, text: 'one' },
      { seconds: 5, text: 'two' },
    ];
    const model = new MockLanguageModel(() => ({ keep: [1, 1, 7] }));
    expect(await chooseEditorialCut(model, lines, 5)).toEqual([1]);
  });

  it('declines an impossibly long list instead of asking', async () => {
    const lines = Array.from({ length: 501 }, () => ({ seconds: 1, text: 'x' }));
    const model = new MockLanguageModel(() => {
      throw new Error('should not be asked');
    });
    expect(await chooseEditorialCut(model, lines, 5)).toBeNull();
  });
});

describe('assessPlan', () => {
  const assess = (plan: AgentPlan) => {
    const base = timeline();
    return assessPlan(base, compilePlan(plan, base, context, media), plan);
  };

  it('measures the change in length', () => {
    const { impact, warnings } = assess({
      summary: '',
      steps: [planStep('cut_range', 'Cut', { start: 0, end: 10 })],
    });
    expect(impact!.beforeSeconds).toBeCloseTo(60, 1);
    expect(impact!.afterSeconds).toBeCloseTo(50, 1);
    expect(warnings).toEqual([]);
  });

  it('warns when a plan removes most of the edit unasked', () => {
    const { warnings } = assess({
      summary: '',
      steps: [planStep('cut_range', 'Cut', { start: 0, end: 50 })],
    });
    expect(warnings[0]).toContain('83%');
  });

  it('does not warn about a length the creator asked for', () => {
    const { warnings } = assess({
      summary: '',
      steps: [planStep('cut_to_duration', 'Short', { seconds: 12 })],
    });
    expect(warnings).toEqual([]);
  });

  it('has nothing to report when nothing changes', () => {
    expect(assess({ summary: '', steps: [] }).impact).toBeNull();
  });
});

describe('suggestEdits', () => {
  it('offers only what would really change something, with measured numbers', () => {
    const items = suggestEdits(timeline(), context, media);
    const silence = items.find((item) => item.id === 'remove_silence');
    expect(silence?.label).toMatch(/Remove 1 pause · 4\.7s/);
    expect(items.map((item) => item.id)).toContain('remove_repeated_takes');
    expect(items.length).toBeLessThanOrEqual(4);
    for (const item of items) {
      expect(understandInstruction(item.instruction, planner(item.instruction)).complete).toBe(
        true,
      );
    }
  });

  it('stops offering what has been done', () => {
    const base = timeline();
    const applied = compilePlan(
      { summary: '', steps: [planStep('remove_silence', 'Pauses')] },
      base,
      context,
      media,
    ).state;
    const items = suggestEdits(applied, context, media);
    expect(items.map((item) => item.id)).not.toContain('remove_silence');
  });

  it('has nothing to say without speech', () => {
    expect(suggestEdits(timeline(), { ...context, segments: [] }, media)).toEqual([]);
  });
});
