import { TICKS_PER_SECOND, idPattern, type IdPrefix } from '@agent-edit/shared';
import { z } from 'zod';

export function idSchema(prefix: IdPrefix) {
  return z.string().regex(idPattern(prefix), `Expected a ${prefix} id`);
}

/** Integer flicks. See packages/shared/src/time.ts. */
export const ticksSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const positiveTicksSchema = ticksSchema.positive();

/** Longest fade or transition: a guard against model output, not a creative limit. */
export const shortTicksSchema = ticksSchema.max(60 * TICKS_PER_SECOND);

export const isoDateSchema = z.iso.datetime();
