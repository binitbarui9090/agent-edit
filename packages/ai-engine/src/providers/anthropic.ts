import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  ModelOutputError,
  type JsonRequest,
  type LanguageModel,
  type ProviderInfo,
  type VisionModel,
} from './types.js';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

const IMAGE_TYPES: Record<string, 'image/jpeg' | 'image/png'> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

function firstText(content: ReadonlyArray<{ type: string; text?: string }>): string {
  for (const block of content) {
    if (block.type === 'text' && block.text) return block.text;
  }
  return '';
}

export interface AnthropicOptions {
  apiKey: string;
  model?: string | undefined;
  /** For tests against a local stand-in. */
  baseURL?: string | undefined;
}

function createClient({ apiKey, baseURL }: AnthropicOptions): Anthropic {
  return new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
}

/** Claude through the official SDK, using structured outputs for schema-valid JSON. */
export class AnthropicLanguageModel implements LanguageModel {
  readonly info: ProviderInfo;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(options: AnthropicOptions) {
    this.model = options.model ?? DEFAULT_CLAUDE_MODEL;
    this.client = createClient(options);
    this.info = { id: 'anthropic', model: this.model, isMock: false };
  }

  async completeJson<T>({ system, prompt, schema, signal }: JsonRequest<T>): Promise<T> {
    const message = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 16000,
        system,
        output_config: {
          effort: 'high',
          format: {
            type: 'json_schema',
            schema: z.toJSONSchema(schema) as Record<string, unknown>,
          },
        },
        messages: [{ role: 'user', content: prompt }],
      },
      signal ? { signal } : {},
    );
    if (message.stop_reason === 'refusal') {
      throw new ModelOutputError('The model declined this request');
    }
    if (message.stop_reason === 'max_tokens') {
      throw new ModelOutputError('The model ran out of room before finishing its plan');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(firstText(message.content));
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

export class AnthropicVisionModel implements VisionModel {
  readonly info: ProviderInfo;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(options: AnthropicOptions) {
    this.model = options.model ?? DEFAULT_CLAUDE_MODEL;
    this.client = createClient(options);
    this.info = { id: 'anthropic', model: this.model, isMock: false };
  }

  async describeImage(imagePath: string, prompt: string, signal?: AbortSignal): Promise<string> {
    const mediaType = IMAGE_TYPES[extname(imagePath).toLowerCase()];
    if (!mediaType) throw new Error(`Unsupported image type: ${imagePath}`);
    const data = (await readFile(imagePath)).toString('base64');
    const message = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      },
      signal ? { signal } : {},
    );
    return firstText(message.content).trim();
  }
}
