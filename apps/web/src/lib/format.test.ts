import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatRelativeTime } from './format';

describe('formatBytes', () => {
  it.each([
    [512, '512 B'],
    [1536, '1.5 KB'],
    [8 * 1024 ** 2, '8.0 MB'],
    [150 * 1024 ** 3, '150 GB'],
    [3 * 1024 ** 4, '3.0 TB'],
  ])('%d is %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe('formatDuration', () => {
  it.each([
    [4, '0:04'],
    [65, '1:05'],
    [3 * 3600 + 5, '3:00:05'],
  ])('%d seconds is %s', (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
  });
});

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-01-02T00:00:00Z');
  it('describes recent and older times', () => {
    expect(formatRelativeTime('2026-01-01T23:59:50Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-01-01T22:00:00Z', now)).toBe('2 hours ago');
    expect(formatRelativeTime('2026-01-01T00:00:00Z', now)).toBe('yesterday');
  });
});
