import { describe, expect, it } from 'vitest';
import {
  FRAME_RATES,
  TICKS_PER_SECOND,
  framesToTicks,
  isOnFrameGrid,
  secondsToTicks,
  snapToFrame,
  ticksPerFrame,
  ticksToFrames,
} from './time.js';

describe('ticks', () => {
  it('represents a frame exactly at every supported rate', () => {
    for (const rate of FRAME_RATES) expect(Number.isInteger(ticksPerFrame(rate))).toBe(true);
  });

  it('represents an audio sample exactly at 44.1 and 48 kHz', () => {
    expect(Number.isInteger(TICKS_PER_SECOND / 44_100)).toBe(true);
    expect(Number.isInteger(TICKS_PER_SECOND / 48_000)).toBe(true);
  });

  it('does not drift when summing frames for ten hours at 29.97', () => {
    const rate = { num: 30000, den: 1001 };
    const frames = Math.round((10 * 3600 * 30000) / 1001);
    let sum = 0;
    for (let i = 0; i < frames; i++) sum += ticksPerFrame(rate);
    expect(sum).toBe(framesToTicks(frames, rate));
    expect(ticksToFrames(sum, rate)).toBe(frames);
    expect(Number.isSafeInteger(sum)).toBe(true);
  });

  it('snaps arbitrary seconds onto the frame grid', () => {
    const rate = { num: 25, den: 1 };
    const snapped = snapToFrame(secondsToTicks(2.513), rate);
    expect(isOnFrameGrid(snapped, rate)).toBe(true);
    expect(ticksToFrames(snapped, rate)).toBe(63);
  });

  it('rejects off-grid and non-integer values', () => {
    const rate = { num: 25, den: 1 };
    expect(isOnFrameGrid(ticksPerFrame(rate) + 1, rate)).toBe(false);
    expect(isOnFrameGrid(0.5, rate)).toBe(false);
  });
});
