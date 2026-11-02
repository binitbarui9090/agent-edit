import { TICKS_PER_SECOND, ticksToFrames, type FrameRate } from '@agent-edit/shared';

export const ticksToPx = (ticks: number, pxPerSecond: number) =>
  (ticks / TICKS_PER_SECOND) * pxPerSecond;

export const pxToTicks = (px: number, pxPerSecond: number) => (px / pxPerSecond) * TICKS_PER_SECOND;

/** HH:MM:SS:FF, counting real frames. Non-drop, so at 29.97 it runs slightly behind wall clock. */
export function formatTimecode(ticks: number, rate: FrameRate): string {
  const frames = ticksToFrames(ticks, rate);
  const nominal = Math.round(rate.num / rate.den);
  const pad = (value: number) => String(value).padStart(2, '0');
  const seconds = Math.floor(frames / nominal);
  return [
    pad(Math.floor(seconds / 3600)),
    pad(Math.floor(seconds / 60) % 60),
    pad(seconds % 60),
    pad(frames % nominal),
  ].join(':');
}

const RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
const MIN_LABEL_SPACING_PX = 80;

/** Seconds between labelled ruler marks at this zoom. */
export function rulerStep(pxPerSecond: number): number {
  return (
    RULER_STEPS.find((step) => step * pxPerSecond >= MIN_LABEL_SPACING_PX) ?? RULER_STEPS.at(-1)!
  );
}

export function formatRulerLabel(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const rest = String(seconds % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

const SNAP_THRESHOLD_PX = 8;

/**
 * The closest snap target to a time, or the time itself if none is near enough. Testing both edges of
 * a moved clip is the caller's job: it passes the offset each edge would need.
 */
export function snap(
  time: number,
  targets: readonly number[],
  pxPerSecond: number,
): { time: number; snapped: boolean } {
  const threshold = pxToTicks(SNAP_THRESHOLD_PX, pxPerSecond);
  let best = time;
  let bestDistance = threshold;
  let snapped = false;
  for (const target of targets) {
    const distance = Math.abs(target - time);
    if (distance < bestDistance) {
      best = target;
      bestDistance = distance;
      snapped = true;
    }
  }
  return { time: best, snapped };
}
