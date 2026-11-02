/**
 * All timeline and source times are integer "ticks" (flicks, 1/705,600,000 s).
 *
 * The rate divides exactly by every supported frame rate and by 44.1/48 kHz, so frame arithmetic
 * never accumulates rounding error, unlike float seconds or microseconds at 29.97 fps. Values stay
 * below Number.MAX_SAFE_INTEGER for about 147 days of media.
 */
export const TICKS_PER_SECOND = 705_600_000;

export interface FrameRate {
  num: number;
  den: number;
}

export const FRAME_RATES = [
  { label: '23.976', num: 24000, den: 1001 },
  { label: '24', num: 24, den: 1 },
  { label: '25', num: 25, den: 1 },
  { label: '29.97', num: 30000, den: 1001 },
  { label: '30', num: 30, den: 1 },
  { label: '50', num: 50, den: 1 },
  { label: '59.94', num: 60000, den: 1001 },
  { label: '60', num: 60, den: 1 },
] as const;

export function isSupportedFrameRate({ num, den }: FrameRate): boolean {
  return FRAME_RATES.some((rate) => rate.num === num && rate.den === den);
}

export function frameRateLabel({ num, den }: FrameRate): string {
  const known = FRAME_RATES.find((rate) => rate.num === num && rate.den === den);
  return known ? known.label : (num / den).toFixed(3);
}

export function ticksPerFrame({ num, den }: FrameRate): number {
  return (TICKS_PER_SECOND * den) / num;
}

export function secondsToTicks(seconds: number): number {
  return Math.round(seconds * TICKS_PER_SECOND);
}

export function ticksToSeconds(ticks: number): number {
  return ticks / TICKS_PER_SECOND;
}

export function framesToTicks(frames: number, rate: FrameRate): number {
  return frames * ticksPerFrame(rate);
}

export function ticksToFrames(ticks: number, rate: FrameRate): number {
  return Math.round(ticks / ticksPerFrame(rate));
}

export function snapToFrame(ticks: number, rate: FrameRate): number {
  return framesToTicks(ticksToFrames(ticks, rate), rate);
}

export function isOnFrameGrid(ticks: number, rate: FrameRate): boolean {
  return Number.isSafeInteger(ticks) && ticks % ticksPerFrame(rate) === 0;
}
