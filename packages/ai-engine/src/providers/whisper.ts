import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ProviderInfo,
  SpeechToText,
  TranscribedSegment,
  TranscribedWord,
  TranscribeOptions,
} from './types.js';

interface WhisperToken {
  text: string;
  offsets: { from: number; to: number };
}

interface WhisperOutput {
  result?: { language?: string };
  transcription?: Array<{ tokens?: WhisperToken[] }>;
}

const SENTENCE_END = /[.!?]["')\]]*$/;
/** Sentence punctuation is sometimes missing, so very long runs are broken up anyway. */
const MAX_WORDS_PER_SEGMENT = 30;

/**
 * Rebuilds words from Whisper's tokens and splits at sentence ends. Whisper's own segments follow
 * audio chunks, so one can hold a sentence and its repeat, which would hide a repeated take.
 */
export function parseWhisperOutput(output: WhisperOutput): {
  language: string;
  segments: TranscribedSegment[];
} {
  const words: TranscribedWord[] = [];
  for (const chunk of output.transcription ?? []) {
    for (const token of chunk.tokens ?? []) {
      if (token.text.startsWith('[_') || token.text.trim().startsWith('<|')) continue;
      const start = token.offsets.from / 1000;
      const end = token.offsets.to / 1000;
      const previous = words.at(-1);
      if (token.text.startsWith(' ') || !previous) {
        if (token.text.trim()) words.push({ w: token.text.trim(), s: start, e: end });
      } else {
        // A continuation of the same word, or attached punctuation.
        previous.w += token.text;
        previous.e = end;
      }
    }
  }

  const segments: TranscribedSegment[] = [];
  let current: TranscribedWord[] = [];
  const flush = () => {
    const first = current[0];
    const last = current.at(-1);
    if (first && last) {
      segments.push({
        start: first.s,
        end: last.e,
        text: current.map((word) => word.w).join(' '),
        speaker: null,
        words: current,
      });
    }
    current = [];
  };
  for (const word of words) {
    current.push(word);
    if (SENTENCE_END.test(word.w) || current.length >= MAX_WORDS_PER_SEGMENT) flush();
  }
  flush();
  return { language: output.result?.language ?? 'unknown', segments };
}

/** whisper.cpp on this machine: free and private, with word timings but no speaker labels. */
export class WhisperCppSpeechToText implements SpeechToText {
  readonly info: ProviderInfo;
  readonly identifiesSpeakers = false;

  constructor(
    private readonly binary: string,
    private readonly modelPath: string,
  ) {
    const name =
      modelPath
        .split('/')
        .pop()
        ?.replace(/^ggml-|\.bin$/g, '') ?? 'unknown';
    this.info = { id: 'whisper.cpp', model: name, isMock: false };
  }

  async transcribe(audioPath: string, { signal, onProgress }: TranscribeOptions = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'ae-whisper-'));
    const prefix = join(directory, 'out');
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          this.binary,
          ['-m', this.modelPath, '-f', audioPath, '-oj', '-ojf', '-of', prefix, '-pp', '-np'],
          { stdio: ['ignore', 'ignore', 'pipe'], shell: false, ...(signal ? { signal } : {}) },
        );
        let tail = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          tail = (tail + chunk).slice(-2000);
          for (const match of chunk.matchAll(/progress\s*=\s*(\d+)%/g)) {
            onProgress?.(Number(match[1]) / 100);
          }
        });
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`whisper.cpp exited with ${code}: ${tail}`)),
        );
      });
      const output = JSON.parse(await readFile(`${prefix}.json`, 'utf8')) as WhisperOutput;
      return parseWhisperOutput(output);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
