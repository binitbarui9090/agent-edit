import type { JsonRequest, LanguageModel, ProviderInfo, SpeechToText } from './types.js';

/**
 * Canned output for exercising the product with no AI service at all. Flagged isMock wherever its
 * results are stored, and the interface labels them as demo data. It never reads the audio or the
 * prompt, so it says nothing true about any footage.
 */
export class MockSpeechToText implements SpeechToText {
  readonly info: ProviderInfo = { id: 'mock', model: null, isMock: true };
  readonly identifiesSpeakers = false;

  async transcribe() {
    const line = 'Demo transcript. This text was not produced from your audio.';
    return {
      language: 'en',
      segments: [
        {
          start: 0,
          end: 3,
          text: line,
          speaker: null,
          words: line.split(' ').map((w, i) => ({ w, s: i * 0.3, e: i * 0.3 + 0.3 })),
        },
      ],
    };
  }
}

export class MockLanguageModel implements LanguageModel {
  readonly info: ProviderInfo = { id: 'mock', model: null, isMock: true };

  constructor(private readonly respond: (request: JsonRequest<unknown>) => unknown) {}

  async completeJson<T>(request: JsonRequest<T>): Promise<T> {
    return request.schema.parse(this.respond(request as JsonRequest<unknown>));
  }
}
