export interface TextSpan {
  start: number;
  end: number;
  text: string;
}

const STOP_WORDS = new Set(['um', 'uh', 'er', 'ah', 'like', 'so', 'okay', 'ok', 'well']);

export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((word) => word && !STOP_WORDS.has(word));
}

/** Word bigram overlap (Dice). Tolerates a fluffed word without matching merely similar topics. */
export function similarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length === 1 || b.length === 1) return a.join(' ') === b.join(' ') ? 1 : 0;
  const pairs = (words: string[]) => {
    const counts = new Map<string, number>();
    for (let i = 0; i < words.length - 1; i++) {
      const pair = `${words[i]} ${words[i + 1]}`;
      counts.set(pair, (counts.get(pair) ?? 0) + 1);
    }
    return counts;
  };
  const left = pairs(a);
  const right = pairs(b);
  let shared = 0;
  for (const [pair, count] of left) shared += Math.min(count, right.get(pair) ?? 0);
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

const MIN_WORDS = 4;
const SIMILARITY_THRESHOLD = 0.7;
const LOOK_AHEAD = 3;

export interface RepeatedTake {
  /** The earlier attempt, which an editor would remove. */
  start: number;
  end: number;
  text: string;
  score: number;
  keptAt: number;
}

/**
 * Finds a line said again shortly after. The last attempt is kept, since that is normally the one the
 * speaker was happy with. Very short lines are ignored: "Right." said twice is not a retake.
 */
export function findRepeatedTakes(segments: readonly TextSpan[]): RepeatedTake[] {
  const normalized = segments.map((segment) => normalizeWords(segment.text));
  const takes: RepeatedTake[] = [];
  for (let i = 0; i < segments.length; i++) {
    const words = normalized[i]!;
    if (words.length < MIN_WORDS) continue;
    for (let j = i + 1; j <= i + LOOK_AHEAD && j < segments.length; j++) {
      const score = similarity(words, normalized[j]!);
      if (score >= SIMILARITY_THRESHOLD) {
        const earlier = segments[i]!;
        takes.push({
          start: earlier.start,
          end: earlier.end,
          text: earlier.text,
          score,
          keptAt: segments[j]!.start,
        });
        break;
      }
    }
  }
  return takes;
}
