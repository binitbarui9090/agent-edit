import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AnthropicLanguageModel, AnthropicVisionModel } from './providers/anthropic.js';
import { DeepgramSpeechToText } from './providers/deepgram.js';
import { MockLanguageModel, MockSpeechToText } from './providers/mock.js';
import { OllamaLanguageModel, OllamaVisionModel } from './providers/ollama.js';
import type { AiProviders } from './providers/types.js';
import { WhisperCppSpeechToText } from './providers/whisper.js';
import { ruleBasedPlan } from './planner.js';

export const aiEnvSchema = z.object({
  SPEECH_PROVIDER: z.enum(['none', 'whisper', 'deepgram', 'mock']).default('none'),
  LLM_PROVIDER: z.enum(['none', 'ollama', 'anthropic', 'mock']).default('none'),
  VISION_PROVIDER: z.enum(['none', 'ollama', 'anthropic']).default('none'),
  WHISPER_CLI_PATH: z.string().default('whisper-cli'),
  WHISPER_MODEL_PATH: z
    .string()
    .default(join(homedir(), '.cache/agent-edit/whisper/ggml-base.en.bin')),
  OLLAMA_URL: z.url().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().default('qwen3:8b'),
  OLLAMA_VISION_MODEL: z.string().default('gemma3:4b'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
});
export type AiEnv = z.infer<typeof aiEnvSchema>;

function requireKey(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required for the configured AI provider`);
  return value;
}

/** Every provider is chosen by environment variable. None of them is assumed anywhere else. */
export function createAiProviders(env: AiEnv): AiProviders {
  const speech = {
    none: () => null,
    whisper: () => new WhisperCppSpeechToText(env.WHISPER_CLI_PATH, env.WHISPER_MODEL_PATH),
    deepgram: () => new DeepgramSpeechToText(requireKey(env.DEEPGRAM_API_KEY, 'DEEPGRAM_API_KEY')),
    mock: () => new MockSpeechToText(),
  }[env.SPEECH_PROVIDER]();

  const language = {
    none: () => null,
    ollama: () => new OllamaLanguageModel(env.OLLAMA_URL, env.OLLAMA_MODEL),
    anthropic: () =>
      new AnthropicLanguageModel({
        apiKey: requireKey(env.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY'),
        model: env.ANTHROPIC_MODEL,
      }),
    mock: () => new MockLanguageModel(() => ruleBasedPlan('remove pauses and create subtitles')),
  }[env.LLM_PROVIDER]();

  const vision = {
    none: () => null,
    ollama: () => new OllamaVisionModel(env.OLLAMA_URL, env.OLLAMA_VISION_MODEL),
    anthropic: () =>
      new AnthropicVisionModel({
        apiKey: requireKey(env.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY'),
        model: env.ANTHROPIC_MODEL,
      }),
  }[env.VISION_PROVIDER]();

  return { speech, language, vision };
}
