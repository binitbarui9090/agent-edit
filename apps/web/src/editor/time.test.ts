import { secondsToTicks, ticksPerFrame } from '@agent-edit/shared';
import { describe, expect, it } from 'vitest';
import { formatRulerLabel, formatTimecode, pxToTicks, rulerStep, snap, ticksToPx } from './time';

describe('formatTimecode', () => {
  it('counts frames at an integer rate', () => {
    const rate = { num: 25, den: 1 };
    expect(formatTimecode(0, rate)).toBe('00:00:00:00');
    expect(formatTimecode(ticksPerFrame(rate) * 26, rate)).toBe('00:00:01:01');
    expect(formatTimecode(secondsToTicks(3661), rate)).toBe('01:01:01:00');
  });

  it('uses nominal frame numbers at 29.97', () => {
    const rate = { num: 30000, den: 1001 };
    expect(formatTimecode(ticksPerFrame(rate) * 29, rate)).toBe('00:00:00:29');
    expect(formatTimecode(ticksPerFrame(rate) * 30, rate)).toBe('00:00:01:00');
  });
});

describe('zoom conversions', () => {
  it('round-trips', () => {
    const ticks = secondsToTicks(12.5);
    expect(pxToTicks(ticksToPx(ticks, 40), 40)).toBeCloseTo(ticks, 3);
  });
});

describe('rulerStep', () => {
  it('keeps labels readable at any zoom', () => {
    expect(rulerStep(200)).toBe(1);
    expect(rulerStep(10)).toBe(10);
    expect(rulerStep(0.1)).toBe(900);
    expect(rulerStep(0.001)).toBe(3600);
  });
});

describe('formatRulerLabel', () => {
  it('formats minutes and hours', () => {
    expect(formatRulerLabel(65)).toBe('1:05');
    expect(formatRulerLabel(3725)).toBe('1:02:05');
  });
});

describe('snap', () => {
  const targets = [secondsToTicks(10), secondsToTicks(20)];

  it('pulls to a target within the threshold', () => {
    const result = snap(secondsToTicks(10.05), targets, 100);
    expect(result).toEqual({ time: targets[0], snapped: true });
  });

  it('leaves the time alone when nothing is near', () => {
    const time = secondsToTicks(15);
    expect(snap(time, targets, 100)).toEqual({ time, snapped: false });
  });

  it('measures the threshold in pixels, so zooming out snaps from further away', () => {
    const time = secondsToTicks(10.5);
    expect(snap(time, targets, 100).snapped).toBe(false);
    expect(snap(time, targets, 10).snapped).toBe(true);
  });
});
