import type { MediaLookup } from '@agent-edit/timeline-engine';
import type { AgentSuggestion, PlanStep, TimelineState } from '@agent-edit/validation';
import { compilePlan, type CompileContext } from './compile.js';
import { planStep } from './understand.js';

const CANDIDATES: ReadonlyArray<{
  operation: PlanStep['operation'];
  instruction: string;
  fields?: Partial<PlanStep>;
}> = [
  { operation: 'remove_repeated_takes', instruction: 'Remove the repeated takes.' },
  { operation: 'remove_silence', instruction: 'Remove the pauses.' },
  { operation: 'remove_filler_words', instruction: 'Remove the filler words.' },
  { operation: 'add_captions', instruction: 'Add subtitles.' },
  { operation: 'normalize_dialogue', instruction: 'Normalize the dialogue.' },
];

const MAX_SUGGESTIONS = 4;

function shortened(summary: string): string {
  return summary
    .replace(/, such as ".*$/, '')
    .replace(/ in the final render$/, '')
    .replace(/ from the transcript$/, '');
}

/**
 * Edits the footage actually calls for, each proven by compiling it against the current timeline, so
 * a suggestion's numbers are the numbers it would really produce and spent ones disappear. Only runs
 * when there is speech: on an empty or silent edit there is nothing honest to suggest.
 */
export function suggestEdits(
  state: TimelineState,
  context: CompileContext,
  media: MediaLookup,
): AgentSuggestion[] {
  if (context.segments.length === 0) return [];
  const suggestions: AgentSuggestion[] = [];
  for (const { operation, instruction, fields } of CANDIDATES) {
    const step = compilePlan(
      { summary: '', steps: [planStep(operation, '', fields)] },
      state,
      context,
      media,
    ).steps[0]!;
    if (!step.error && step.operationCount > 0) {
      const saved = step.secondsSaved >= 0.05 ? ` · ${step.secondsSaved.toFixed(1)}s` : '';
      suggestions.push({ id: operation, label: `${shortened(step.summary)}${saved}`, instruction });
    }
  }
  return suggestions.slice(0, MAX_SUGGESTIONS);
}
