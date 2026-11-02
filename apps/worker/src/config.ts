import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storageEnvSchema } from '@agent-edit/infra';
import { z } from 'zod';

const envSchema = storageEnvSchema.extend({
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  REDIS_URL: z.string().min(1),
  MONGO_URL: z.string().min(1),
  MONGO_DB: z.string().min(1),
  WORK_DIR: z.string().min(1).default(join(tmpdir(), 'agent-edit-work')),
  MEDIA_CONCURRENCY: z.coerce.number().int().positive().default(3),
  PROXY_CONCURRENCY: z.coerce.number().int().positive().default(1),
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  FFPROBE_PATH: z.string().min(1).default('ffprobe'),
});

export type WorkerConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment. Copy .env.example to .env.\n${problems.join('\n')}`);
  }
  return parsed.data;
}
