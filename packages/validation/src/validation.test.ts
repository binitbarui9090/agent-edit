import { newId, secondsToTicks } from '@agent-edit/shared';
import { describe, expect, it } from 'vitest';
import { registerRequestSchema } from './auth.js';
import { timelineOperationSchema } from './operations.js';
import { createProjectRequestSchema } from './project.js';

const settings = {
  aspectRatio: '16:9',
  width: 1920,
  height: 1080,
  frameRate: { num: 30000, den: 1001 },
} as const;

describe('project settings', () => {
  it('accepts a valid project', () => {
    expect(createProjectRequestSchema.safeParse({ name: ' Demo ', settings }).data?.name).toBe(
      'Demo',
    );
  });

  it.each([
    ['resolution not matching the aspect ratio', { ...settings, height: 1000 }],
    ['odd-sided resolution', { ...settings, width: 1921, height: 1081 }],
    ['unsupported frame rate', { ...settings, frameRate: { num: 17, den: 1 } }],
    ['unknown keys', { ...settings, codec: 'h264' }],
  ])('rejects %s', (_label, bad) => {
    expect(createProjectRequestSchema.safeParse({ name: 'x', settings: bad }).success).toBe(false);
  });
});

describe('auth', () => {
  it('normalizes email', () => {
    const parsed = registerRequestSchema.parse({
      email: '  Ada@Example.COM ',
      displayName: 'Ada',
      password: 'correct horse battery',
    });
    expect(parsed.email).toBe('ada@example.com');
  });

  it('rejects short passwords', () => {
    const result = registerRequestSchema.safeParse({
      email: 'a@b.co',
      displayName: 'A',
      password: 'short',
    });
    expect(result.success).toBe(false);
  });
});

describe('timeline operations', () => {
  const clipId = newId('clip');

  it('accepts a canonical trim', () => {
    const result = timelineOperationSchema.safeParse({
      op: 'trim_clip',
      clipId,
      start: 0,
      duration: secondsToTicks(10),
      sourceIn: secondsToTicks(2),
      sourceOut: secondsToTicks(12),
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ['unknown op', { op: 'delete_database', clipId }],
    ['float ticks', { op: 'move_clip', clipId, start: 1.5 }],
    ['negative ticks', { op: 'move_clip', clipId, start: -1 }],
    ['malformed id', { op: 'remove_clip', clipId: '../../etc/passwd' }],
    ['extra fields', { op: 'remove_clip', clipId, drop: true }],
    ['out of range speed', { op: 'change_speed', clipId, speed: 100, duration: 1 }],
  ])('rejects %s', (_label, bad) => {
    expect(timelineOperationSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a media clip with an inverted source range', () => {
    const result = timelineOperationSchema.safeParse({
      op: 'add_clip',
      trackId: newId('trk'),
      clip: {
        id: clipId,
        kind: 'media',
        sourceMediaId: newId('med'),
        sourceIn: secondsToTicks(5),
        sourceOut: secondsToTicks(1),
        start: 0,
        duration: secondsToTicks(4),
        speed: 1,
        volume: 1,
        enabled: true,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        audio: { normalize: false, denoise: false, fadeIn: 0, fadeOut: 0 },
        transitionIn: null,
        transitionOut: null,
      },
    });
    expect(result.success).toBe(false);
  });
});
