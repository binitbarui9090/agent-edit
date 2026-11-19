import type { PlanStep } from '@agent-edit/validation';

const blank: Omit<PlanStep, 'operation' | 'reason'> = {
  clipId: null,
  start: null,
  end: null,
  speed: null,
  volume: null,
  trackType: null,
  query: null,
  mediaId: null,
  count: null,
  seconds: null,
};

export function planStep(
  operation: PlanStep['operation'],
  reason: string,
  fields: Partial<Omit<PlanStep, 'operation' | 'reason'>> = {},
): PlanStep {
  return { ...blank, ...fields, operation, reason };
}

export interface UnderstandContext {
  durationSeconds: number;
  clips: ReadonlyArray<{ id: string; track: string; start: number; end: number }>;
  selectedClipIds?: readonly string[];
  playheadSeconds?: number;
}

export interface Understood {
  steps: PlanStep[];
  /** Every clause was recognised exactly, so no model is needed. */
  complete: boolean;
}

const VERBS =
  'remove|cut|delete|trim|get rid|strip|take out|drop|clean up|tighten|lose|add|create|generate|make|put|burn|give|find|extract|normali[sz]e|even out|level|balance|reduce|lower|turn|set|change|speed up|shorten|bring|condense|split|mute';

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const TRACKS: Readonly<Record<string, PlanStep['trackType']>> = {
  music: 'MUSIC',
  'b-roll': 'BROLL',
  broll: 'BROLL',
  'b roll': 'BROLL',
  voice: 'VIDEO',
  dialogue: 'VIDEO',
  video: 'VIDEO',
  audio: 'AUDIO',
  overlay: 'OVERLAYS',
  overlays: 'OVERLAYS',
};

function splitClauses(instruction: string): string[] {
  return instruction
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\b(?:please|kindly)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .split(new RegExp(`[,;!\\n]+|\\.(?=\\s|$)|\\b(?:then|also)\\b|\\band\\s+(?=(?:${VERBS})\\b)`))
    .map((clause) =>
      clause
        .trim()
        .replace(
          /^(?:(?:and|now|just|next|can you|could you|would you|will you|i want you to|i'd like you to|let's|lets|go ahead and)\s+)+/,
          '',
        )
        .replace(/[?\s]+$/, ''),
    )
    .filter(Boolean);
}

const toSeconds = (value: string, unit: string) => Number(value) * (unit.startsWith('m') ? 60 : 1);

function parseTime(value: string): number {
  if (!value.includes(':')) return Number(value);
  const [minutes, rest] = value.split(':');
  return Number(minutes) * 60 + Number(rest);
}

const REMOVE =
  '(?:remove|cut(?: out)?|delete|trim(?: out)?|get rid of|strip(?: out)?|take out|drop|clean up|tighten up|lose)';
const DET = '(?:(?:all|the|any|my|of|those|these|every)\\s+)*';
const WHOLE =
  '(?:\\s+(?:from|in)\\s+(?:the|this|my)\\s+(?:video|edit|footage|timeline|clip|recording))?';
const UNIT = '(s|sec|secs|second|seconds|m|min|mins|minute|minutes)';
const TIME = '(\\d+:\\d{2}|\\d+(?:\\.\\d+)?)\\s*(?:s|sec|secs|seconds)?';
const THE_EDIT = '(?:this|it|the video|the edit|everything|the timeline|this video)';

type Rule = (clause: string, context: UnderstandContext) => PlanStep[] | null;

const pauses: Rule = (clause) => {
  const match = new RegExp(
    `^${REMOVE}\\s+${DET}(?:(?:unnecessary|unneeded|long|longer|awkward|extra|empty|needless)\\s+)*(?:pauses?|silences?|silent parts?|dead air|gaps?)(?:\\s+(?:longer|more)\\s+than\\s+(\\d+(?:\\.\\d+)?)\\s*(?:s|sec|secs|seconds?))?${WHOLE}$`,
  ).exec(clause);
  if (!match) return null;
  return [
    planStep('remove_silence', 'Remove the pauses', match[1] ? { seconds: Number(match[1]) } : {}),
  ];
};

const takes: Rule = (clause) =>
  new RegExp(
    `^${REMOVE}\\s+${DET}(?:(?:(?:repeated|repeat|duplicate|duplicated|extra|bad|earlier|false|failed|flubbed)\\s+)*(?:takes?|retakes?|repeats?|repetitions?)|(?:repeated|duplicate|duplicated)\\s+(?:lines?|sentences?|parts?|bits?))${WHOLE}$`,
  ).test(clause)
    ? [planStep('remove_repeated_takes', 'Remove earlier attempts at repeated lines')]
    : null;

const fillers: Rule = (clause) =>
  new RegExp(
    `^${REMOVE}\\s+${DET}(?:filler(?:\\s+words?)?|ums?(?:\\s+and\\s+(?:the\\s+)?(?:uhs?|ahs?))?|uhs?(?:\\s+and\\s+(?:the\\s+)?ums?)?)${WHOLE}$`,
  ).test(clause)
    ? [planStep('remove_filler_words', 'Remove filler words like "um" and "uh"')]
    : null;

const faster: Rule = (clause, { durationSeconds }) => {
  const match = new RegExp(
    `^(?:make the (first|opening|last|final) (\\d+(?:\\.\\d+)?)\\s*${UNIT} (?:faster|quicker)|speed up the (first|opening|last|final) (\\d+(?:\\.\\d+)?)\\s*${UNIT})(?:\\s+(?:to|at|by)\\s+(\\d+(?:\\.\\d+)?)\\s*x)?$`,
  ).exec(clause);
  if (!match) return null;
  const edge = match[1] ?? match[4]!;
  const amount = toSeconds(match[2] ?? match[5]!, match[3] ?? match[6]!);
  const speed = match[7] ? Number(match[7]) : 1.25;
  if (speed < 0.25 || speed > 4) return null;
  const fromEnd = edge === 'last' || edge === 'final';
  return [
    planStep('speed_range', `Speed up the ${edge} ${amount} seconds, as asked`, {
      start: fromEnd ? Math.max(0, durationSeconds - amount) : 0,
      end: fromEnd ? durationSeconds : amount,
      speed,
    }),
  ];
};

const cutEdge: Rule = (clause, { durationSeconds }) => {
  const match = new RegExp(
    `^${REMOVE}(?:\\s+off)?\\s+the\\s+(first|opening|last|final)\\s+(\\d+(?:\\.\\d+)?)\\s*${UNIT}$`,
  ).exec(clause);
  if (!match) return null;
  const amount = toSeconds(match[2]!, match[3]!);
  const fromEnd = match[1] === 'last' || match[1] === 'final';
  return [
    planStep('cut_range', `Cut the ${match[1]} ${amount} seconds, as asked`, {
      start: fromEnd ? Math.max(0, durationSeconds - amount) : 0,
      end: fromEnd ? durationSeconds : amount,
    }),
  ];
};

const cutBetween: Rule = (clause) => {
  const match = new RegExp(
    `^${REMOVE}(?:\\s+everything)?(?:\\s+from)?\\s+${TIME}\\s+(?:to|until|through)\\s+${TIME}$`,
  ).exec(clause);
  if (!match) return null;
  return [
    planStep('cut_range', `Cut from ${match[1]} to ${match[2]}, as asked`, {
      start: parseTime(match[1]!),
      end: parseTime(match[2]!),
    }),
  ];
};

const captions: Rule = (clause) =>
  /^(?:(?:add|create|generate|make|put in|burn in|auto-?generate|give me)\s+(?:(?:the|some|auto|automatic|english)\s+)*(?:subtitles?|captions?)(?:\s+(?:from the transcript|to (?:the|this|my) (?:video|edit|timeline|clip)|for (?:the|this) video))?|(?:caption|subtitle) (?:this|it|the video|this video))$/.test(
    clause,
  )
    ? [planStep('add_captions', 'Create subtitles from the transcript')]
    : null;

const targetLength: Rule = (clause) => {
  const match =
    new RegExp(
      `^(?:cut|trim|shorten|reduce|edit|bring|get|condense)(?:\\s+down)?(?:\\s+${THE_EDIT})?(?:\\s+down)?(?:\\s+(?:in)?to)?\\s+(?:(?:a|an|about|around|roughly|under)\\s+)*(\\d+(?:\\.\\d+)?)[-\\s]?${UNIT}(?:\\s+long)?(?:\\s+(?:video|cut|edit|version|clip))?$`,
    ).exec(clause) ??
    new RegExp(
      `^make\\s+(?:this|it|the video|a|an)\\s+(?:(?:about|around|roughly|under)\\s+)*(\\d+(?:\\.\\d+)?)[-\\s]?${UNIT}(?:\\s+long)?(?:\\s+(?:video|cut|edit|version))?$`,
    ).exec(clause);
  if (!match) return null;
  const amount = toSeconds(match[1]!, match[2]!);
  return [
    planStep('cut_to_duration', `Bring the edit down to about ${amount} seconds, as asked`, {
      seconds: amount,
    }),
  ];
};

const normalize: Rule = (clause) =>
  /^(?:normali[sz]e|even out|level(?: out)?|balance)\s+(?:(?:the|my)\s+)?(?:dialogue|audio|voices?|speech|loudness|volume|sound)(?:\s+(?:levels?|volume|loudness))?$/.test(
    clause,
  )
    ? [planStep('normalize_dialogue', 'Even out the loudness of the dialogue')]
    : null;

const noise: Rule = (clause) =>
  new RegExp(
    `^(?:reduce|remove|clean up|cut|get rid of|lower|fix)\\s+${DET}(?:background\\s+)?(?:noise|hiss|hum)${WHOLE}$`,
  ).test(clause)
    ? [planStep('reduce_noise', 'Reduce background noise')]
    : null;

const trackLevel: Rule = (clause) => {
  const match =
    /^(?:set|change|put|turn)\s+(?:the\s+)?(music|b-?roll|b roll|voice|dialogue|video|audio|overlays?)(?:\s+(?:track|volume|level))*\s+(?:to|at)\s+(\d+)\s*%$/.exec(
      clause,
    );
  if (!match) return null;
  const volume = Number(match[2]) / 100;
  if (volume > 2) return null;
  return [
    planStep('set_track_volume', `Set the ${match[1]} volume to ${match[2]}%, as asked`, {
      trackType: TRACKS[match[1]!]!,
      volume,
    }),
  ];
};

const quieterMusic: Rule = (clause) =>
  /^(?:(?:make|turn|set)\s+(?:the\s+)?(?:background\s+)?music(?:\s+volume)?\s+(?:quieter|softer|lower|down)|(?:lower|reduce|turn down|quiet)\s+(?:the\s+)?(?:background\s+)?music(?:\s+volume)?)$/.test(
    clause,
  )
    ? [
        planStep('set_track_volume', 'Lower the background music', {
          trackType: 'MUSIC',
          volume: 0.2,
        }),
      ]
    : null;

const broll: Rule = (clause) => {
  const match =
    /^add\s+(?:(?:some|relevant|the|more|appropriate)\s+)*b-?roll(?:\s+footage)?(?:\s+(?:wherever|where|when|whenever|while|during|about|of|for|on)\s+(?:(?:i'?m|i am|i|we'?re|we are|we|the speaker is)\s+)?(?:(?:discussing|talking about|talk about|mention|mentioning|discuss|say|saying|cover|covering|explaining|explain)\s+)?(.+))?$/.exec(
      clause,
    );
  if (!match) return null;
  const query = match[1]?.trim() || null;
  return [
    planStep(
      'add_broll',
      query ? `Add B-roll where you talk about ${query}` : 'Add relevant B-roll',
      {
        query,
      },
    ),
  ];
};

const music: Rule = (clause) =>
  /^add\s+(?:(?:some|the|a|background)\s+)*(?:music|song|soundtrack)$/.test(clause)
    ? [planStep('add_music', 'Add background music from your library')]
    : null;

const shorts: Rule = (clause) => {
  const match =
    /^(?:generate|create|make|cut|find|give me|extract|get)(?:\s+me)?\s+(?:(a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+)?(?:(?:youtube|yt|vertical|instagram|tiktok|short|good|best)\s+)*(?:shorts?|reels?|tiktoks?)(?:\s+(?:from|out of)\s+(?:this|the)(?:\s+(?:project|video|footage|recording))?)?(?:\s+(?:about|on)\s+(.+))?$/.exec(
      clause,
    );
  if (!match) return null;
  const raw = match[1];
  const count = raw ? (NUMBER_WORDS[raw] ?? Number(raw)) : 3;
  if (count < 1 || count > 10) return null;
  return [
    planStep('generate_shorts', `Create ${count} vertical Short${count === 1 ? '' : 's'}`, {
      count,
      query: match[2]?.trim() || null,
    }),
  ];
};

const THIS_CLIP =
  '(?:this|these|it|the selected|selected|the current)(?:\\s+(?:clip|clips|selection))?';

const deleteSelected: Rule = (clause, { selectedClipIds = [] }) =>
  selectedClipIds.length > 0 &&
  new RegExp(`^(?:delete|remove|cut|drop|get rid of)\\s+${THIS_CLIP}$`).test(clause)
    ? selectedClipIds.map((clipId) =>
        planStep('remove_clip', 'Remove the selected clip', { clipId }),
      )
    : null;

const muteSelected: Rule = (clause, { selectedClipIds = [] }) =>
  selectedClipIds.length > 0 && new RegExp(`^mute\\s+${THIS_CLIP}$`).test(clause)
    ? selectedClipIds.map((clipId) =>
        planStep('change_volume', 'Mute the selected clip', { clipId, volume: 0 }),
      )
    : null;

const splitHere: Rule = (clause, { clips, selectedClipIds = [], playheadSeconds }) => {
  if (playheadSeconds === undefined) return null;
  if (!/^split(?:\s+(?:this clip|the clip|it))?(?:\s+(?:here|at the playhead))$/.test(clause)) {
    return null;
  }
  const under = (clip: UnderstandContext['clips'][number]) =>
    clip.start < playheadSeconds && clip.end > playheadSeconds;
  const target =
    clips.find((clip) => selectedClipIds.includes(clip.id) && under(clip)) ??
    clips.find((clip) => clip.track === 'VIDEO' && under(clip));
  return target
    ? [
        planStep('split_clip', 'Split the clip at the playhead', {
          clipId: target.id,
          start: playheadSeconds,
        }),
      ]
    : null;
};

const RULES: readonly Rule[] = [
  pauses,
  takes,
  fillers,
  faster,
  cutEdge,
  cutBetween,
  captions,
  targetLength,
  normalize,
  noise,
  trackLevel,
  quieterMusic,
  broll,
  music,
  shorts,
  deleteSelected,
  muteSelected,
  splitHere,
];

/**
 * Reads an instruction clause by clause. Each pattern must match the whole clause, so "don't remove
 * the pauses" or "cut the boring part" are not understood here and go to a model. Getting one wrong
 * would be worse than being slower, because nothing else would catch it.
 */
export function understandInstruction(instruction: string, context: UnderstandContext): Understood {
  const clauses = splitClauses(instruction);
  const steps: PlanStep[] = [];
  let complete = clauses.length > 0;
  for (const clause of clauses) {
    let matched: PlanStep[] | null = null;
    for (const rule of RULES) {
      matched = rule(clause, context);
      if (matched) break;
    }
    if (matched) steps.push(...matched);
    else complete = false;
  }
  return { steps, complete };
}
