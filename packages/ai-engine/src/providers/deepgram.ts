import { readFile } from 'node:fs/promises';
import type { ProviderInfo, SpeechToText, TranscribedSegment, TranscribeOptions } from './types.js';

interface DeepgramWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  speaker?: number;
}

interface DeepgramResponse {
  results?: {
    channels?: Array<{
      detected_language?: string;
      alternatives?: Array<{ words?: DeepgramWord[] }>;
    }>;
  };
}

const SENTENCE_END = /[.!?]$/;

export function parseDeepgramResponse(response: DeepgramResponse) {
  const channel = response.results?.channels?.[0];
  const words = channel?.alternatives?.[0]?.words ?? [];
  const segments: TranscribedSegment[] = [];
  let current: DeepgramWord[] = [];
  const flush = () => {
    const first = current[0];
    const last = current.at(-1);
    if (first && last) {
      segments.push({
        start: first.start,
        end: last.end,
        text: current.map((word) => word.punctuated_word ?? word.word).join(' '),
        speaker: first.speaker === undefined ? null : `speaker_${first.speaker}`,
        words: current.map((word) => ({
          w: word.punctuated_word ?? word.word,
          s: word.start,
          e: word.end,
        })),
      });
    }
    current = [];
  };
  for (const word of words) {
    if (current[0] && word.speaker !== current[0].speaker) flush();
    current.push(word);
    if (SENTENCE_END.test(word.punctuated_word ?? '')) flush();
  }
  flush();
  return { language: channel?.detected_language ?? 'unknown', segments };
}

/** Deepgram's hosted API. Paid, and the only adapter here that identifies speakers. */
export class DeepgramSpeechToText implements SpeechToText {
  readonly info: ProviderInfo;
  readonly identifiesSpeakers = true;

  constructor(
    private readonly apiKey: string,
    private readonly model = 'nova-3',
    private readonly baseUrl = 'https://api.deepgram.com',
  ) {
    this.info = { id: 'deepgram', model, isMock: false };
  }

  async transcribe(audioPath: string, { signal }: TranscribeOptions = {}) {
    const query = new URLSearchParams({
      model: this.model,
      punctuate: 'true',
      diarize: 'true',
      detect_language: 'true',
    });
    const response = await fetch(`${this.baseUrl}/v1/listen?${query}`, {
      method: 'POST',
      headers: { authorization: `Token ${this.apiKey}`, 'content-type': 'audio/flac' },
      body: await readFile(audioPath),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`Deepgram responded with ${response.status}`);
    return parseDeepgramResponse((await response.json()) as DeepgramResponse);
  }
}
