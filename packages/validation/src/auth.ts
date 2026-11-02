import { ID_PREFIXES } from '@agent-edit/shared';
import { z } from 'zod';
import { idSchema, isoDateSchema } from './common.js';

const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

export const registerRequestSchema = z.strictObject({
  email: emailSchema,
  displayName: z.string().trim().min(1).max(80),
  // The upper bound keeps a hostile request from spending KDF time on megabytes of input.
  password: z.string().min(10, 'Use at least 10 characters').max(200),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const userSchema = z.object({
  id: idSchema(ID_PREFIXES.user),
  email: z.string(),
  displayName: z.string(),
  createdAt: isoDateSchema,
});
export type User = z.infer<typeof userSchema>;
