import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  ModelOutputError,
  type JsonRequest,
  type LanguageModel,
  type ProviderInfo,
  type VisionModel,
} from './types.js';

interface OllamaResponse {
  message?: { content?: string };
  error?: string;
}

async function chat(
  baseUrl: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<string> {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stream: false, think: false, ...body }),
    ...(signal ? { signal } : {}),
  });
  const payload = (await response.json().catch(() => null)) as OllamaResponse | null;
  if (!response.ok || !payload) {
    throw new Error(`Ollama responded with ${response.status}: ${payload?.error ?? 'no body'}`);
  }
  return payload.message?.content ?? '';
}

/** A local model through Ollama. Free and private; quality depends entirely on the model chosen. */
export class OllamaLanguageModel implements LanguageModel {
  readonly info: ProviderInfo;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
  ) {
    this.info = { id: 'ollama', model, isMock: false };
  }

  async completeJson<T>({ system, prompt, schema, signal }: JsonRequest<T>): Promise<T> {
    const content = await chat(
      this.baseUrl,
      {
        model: this.model,
        format: z.toJSONSchema(schema),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        options: { temperature: 0.2 },
      },
      signal,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new ModelOutputError('The model did not return JSON');
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new ModelOutputError(`The model's JSON did not match: ${result.error.message}`);
    }
    return result.data;
  }
}

export class OllamaVisionModel implements VisionModel {
  readonly info: ProviderInfo;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
  ) {
    this.info = { id: 'ollama', model, isMock: false };
  }

  async describeImage(imagePath: string, prompt: string, signal?: AbortSignal): Promise<string> {
    const image = (await readFile(imagePath)).toString('base64');
    const content = await chat(
      this.baseUrl,
      { model: this.model, messages: [{ role: 'user', content: prompt, images: [image] }] },
      signal,
    );
    return content.trim();
  }
}
