import type { z } from 'zod';

/** Recorded with every result, so nothing a mock produced can pass for real analysis. */
export interface ProviderInfo {
  id: string;
  model: string | null;
  isMock: boolean;
}

export interface TranscribedWord {
  w: string;
  /** Seconds from the start of the audio. */
  s: number;
  e: number;
}

export interface TranscribedSegment {
  start: number;
  end: number;
  text: string;
  speaker: string | null;
  words: TranscribedWord[];
}

export interface TranscribeOptions {
  signal?: AbortSignal | undefined;
  onProgress?: ((fraction: number) => void) | undefined;
}

export interface SpeechToText {
  readonly info: ProviderInfo;
  /** Whether segments carry speaker labels. Many local models do not provide them. */
  readonly identifiesSpeakers: boolean;
  transcribe(
    audioPath: string,
    options?: TranscribeOptions,
  ): Promise<{ language: string; segments: TranscribedSegment[] }>;
}

export interface JsonRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  schemaName: string;
  signal?: AbortSignal | undefined;
}

export interface LanguageModel {
  readonly info: ProviderInfo;
  /** Returns data matching the schema, or throws. Callers never see unvalidated model output. */
  completeJson<T>(request: JsonRequest<T>): Promise<T>;
}

export interface VisionModel {
  readonly info: ProviderInfo;
  describeImage(imagePath: string, prompt: string, signal?: AbortSignal): Promise<string>;
}

export interface AiProviders {
  speech: SpeechToText | null;
  language: LanguageModel | null;
  vision: VisionModel | null;
}

/** The model answered, but not in a usable way. Worth one retry with the error fed back. */
export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelOutputError';
  }
}
