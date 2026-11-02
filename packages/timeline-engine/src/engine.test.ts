import { newId, secondsToTicks, snapToFrame, ticksPerFrame } from '@agent-edit/shared';
import type { TimelineOperation, TimelineState } from '@agent-edit/validation';
import { describe, expect, it } from 'vitest';
import { applyOperations } from './apply.js';
import { createCaptionClip, createDefaultTracks, createMediaClip } from './build.js';
import {
  affectedClipIds,
  cutRangeOperations,
  cutRangesOperations,
  deleteClipsOperations,
  speedRangeOperations,
  trimOperation,
} from './edits.js';
import { TimelineError } from './errors.js';
import { clipAt, clipsInRange, findClip, timelineDuration } from './queries.js';
import { validateTimeline, type MediaLookup } from './validate.js';

const rate = { num: 30000, den: 1001 };
const frame = ticksPerFrame(rate);
const s = (seconds: number) => snapToFrame(secondsToTicks(seconds), rate);
const mediaId = newId('med');
const media: MediaLookup = (id) => (id === mediaId ? { duration: s(3600) } : undefined);

function empty(): TimelineState {
  return { frameRate: rate, width: 1920, height: 1080, tracks: createDefaultTracks() };
}

const trackOf = (state: TimelineState, type: string) => state.tracks.find((t) => t.type === type)!;
const clip = (start: number, seconds: number, sourceStart = 0) =>
  createMediaClip(
    {
      sourceMediaId: mediaId,
      start: s(start),
      sourceIn: s(sourceStart),
      sourceOut: s(sourceStart + seconds),
    },
    rate,
  );

function withClips(...clips: ReturnType<typeof clip>[]): TimelineState {
  const state = empty();
  const ops: TimelineOperation[] = clips.map((c) => ({
    op: 'add_clip',
    trackId: trackOf(state, 'VIDEO').id,
    clip: c,
  }));
  return applyOperations(state, ops, media).state;
}

function expectRejected(run: () => unknown, code: string) {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(TimelineError);
    expect((err as TimelineError).code).toBe(code);
    return;
  }
  throw new Error(`Expected rejection with ${code}`);
}

describe('applyOperations', () => {
  it('never mutates its input', () => {
    const state = withClips(clip(0, 10));
    const frozen = JSON.stringify(state);
    const id = trackOf(state, 'VIDEO').clips[0]!.id;
    applyOperations(state, [{ op: 'move_clip', clipId: id, start: s(5) }], media);
    expect(JSON.stringify(state)).toBe(frozen);
  });

  it('keeps clips sorted by start', () => {
    const state = withClips(clip(20, 5), clip(0, 5), clip(10, 5));
    const starts = trackOf(state, 'VIDEO').clips.map((c) => c.start);
    expect(starts).toEqual([s(0), s(10), s(20)]);
  });

  it('rejects the whole transaction when any operation fails', () => {
    const state = withClips(clip(0, 10));
    const id = trackOf(state, 'VIDEO').clips[0]!.id;
    expectRejected(
      () =>
        applyOperations(
          state,
          [
            { op: 'move_clip', clipId: id, start: s(5) },
            { op: 'remove_clip', clipId: newId('clip') },
          ],
          media,
        ),
      'clip_not_found',
    );
    expect(trackOf(state, 'VIDEO').clips[0]!.start).toBe(0);
  });

  it('reports which operation failed', () => {
    const state = withClips(clip(0, 10));
    try {
      applyOperations(state, [{ op: 'remove_clip', clipId: newId('clip') }], media);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TimelineError).opIndex).toBe(0);
      expect((err as TimelineError).message).toContain('Operation 1');
    }
  });

  it('allows transient overlaps inside a transaction but not in the result', () => {
    const state = withClips(clip(0, 10), clip(10, 10));
    const [a, b] = trackOf(state, 'VIDEO').clips;
    expectRejected(
      () => applyOperations(state, [{ op: 'move_clip', clipId: b!.id, start: s(5) }], media),
      'overlap',
    );
    const swapped = applyOperations(
      state,
      [
        { op: 'move_clip', clipId: a!.id, start: s(10) },
        { op: 'move_clip', clipId: b!.id, start: 0 },
      ],
      media,
    ).state;
    expect(trackOf(swapped, 'VIDEO').clips[0]!.id).toBe(b!.id);
  });

  it('rejects off-grid times, which is what stops a model inventing fractional frames', () => {
    const state = withClips(clip(0, 10));
    const id = trackOf(state, 'VIDEO').clips[0]!.id;
    expectRejected(
      () => applyOperations(state, [{ op: 'move_clip', clipId: id, start: frame + 1 }], media),
      'off_grid',
    );
  });

  it('rejects a duplicate clip id', () => {
    const state = withClips(clip(0, 10));
    const existing = trackOf(state, 'VIDEO').clips[0]!;
    if (existing.kind !== 'media') throw new Error('expected media');
    expectRejected(
      () =>
        applyOperations(
          state,
          [
            {
              op: 'add_clip',
              trackId: trackOf(state, 'BROLL').id,
              clip: { ...existing, start: s(30) },
            },
          ],
          media,
        ),
      'duplicate_id',
    );
  });

  it('rejects media the project does not have', () => {
    const state = empty();
    const stranger = createMediaClip(
      { sourceMediaId: newId('med'), start: 0, sourceIn: 0, sourceOut: s(5) },
      rate,
    );
    expectRejected(
      () =>
        applyOperations(
          state,
          [{ op: 'add_clip', trackId: trackOf(state, 'VIDEO').id, clip: stranger }],
          media,
        ),
      'media_not_found',
    );
  });

  it('rejects a clip that runs past the end of its source', () => {
    const state = empty();
    expectRejected(
      () =>
        applyOperations(
          state,
          [{ op: 'add_clip', trackId: trackOf(state, 'VIDEO').id, clip: clip(0, 3700) }],
          media,
        ),
      'source_out_of_range',
    );
  });

  it('rejects a source span that does not match duration at the clip speed', () => {
    const state = withClips(clip(0, 10));
    const id = trackOf(state, 'VIDEO').clips[0]!.id;
    expectRejected(
      () =>
        applyOperations(
          state,
          [{ op: 'change_speed', clipId: id, speed: 2, duration: s(10) }],
          media,
        ),
      'source_out_of_range',
    );
  });

  it('enforces track types', () => {
    const state = withClips(clip(0, 10));
    const id = trackOf(state, 'VIDEO').clips[0]!.id;
    expectRejected(
      () =>
        applyOperations(
          state,
          [{ op: 'change_track', clipId: id, trackId: trackOf(state, 'CAPTIONS').id, start: 0 }],
          media,
        ),
      'incompatible_track',
    );
    expectRejected(
      () =>
        applyOperations(
          state,
          [{ op: 'add_broll', trackId: trackOf(state, 'MUSIC').id, clip: clip(0, 2) }],
          media,
        ),
      'incompatible_track',
    );
  });

  it('protects locked tracks but still lets them be unlocked', () => {
    const state = withClips(clip(0, 10));
    const video = trackOf(state, 'VIDEO');
    const locked = applyOperations(state, [
      { op: 'update_track', trackId: video.id, locked: true },
    ]).state;
    const id = video.clips[0]!.id;
    expectRejected(
      () => applyOperations(locked, [{ op: 'remove_clip', clipId: id }], media),
      'track_locked',
    );
    const unlocked = applyOperations(locked, [
      { op: 'update_track', trackId: video.id, locked: false },
      { op: 'remove_clip', clipId: id },
    ]).state;
    expect(trackOf(unlocked, 'VIDEO').clips).toEqual([]);
  });
});

describe('split_clip', () => {
  it('produces two clips that play exactly the original source', () => {
    const state = withClips(clip(10, 20, 100));
    const id = trackOf(state, 'VIDEO').clips[0]!.id;
    const next = applyOperations(
      state,
      [{ op: 'split_clip', clipId: id, at: s(15), newClipId: newId('clip') }],
      media,
    ).state;
    const [left, right] = trackOf(next, 'VIDEO').clips;
    if (left?.kind !== 'media' || right?.kind !== 'media') throw new Error('expected media');
    expect(left.sourceOut).toBe(right.sourceIn);
    expect(left.sourceIn).toBe(s(100));
    expect(right.sourceOut).toBe(s(100) + s(20));
    expect(left.duration + right.duration).toBe(s(20));
    expect(right.start).toBe(s(15));
  });

  it('keeps source continuity at a non-unit speed', () => {
    const state = withClips(clip(0, 20));
    const id = trackOf(state, 'VIDEO').clips[0]!.id;
    const fast = applyOperations(
      state,
      [{ op: 'change_speed', clipId: id, speed: 2, duration: s(20) / 2 - ((s(20) / 2) % frame) }],
      media,
    ).state;
    const next = applyOperations(
      fast,
      [{ op: 'split_clip', clipId: id, at: s(4), newClipId: newId('clip') }],
      media,
    ).state;
    const [left, right] = trackOf(next, 'VIDEO').clips;
    if (left?.kind !== 'media' || right?.kind !== 'media') throw new Error('expected media');
    expect(left.sourceOut).toBe(right.sourceIn);
    expect(left.sourceOut - left.sourceIn).toBe(left.duration * 2);
  });

  it.each([0, 20])('refuses to split at the edge %d', (at) => {
    const state = withClips(clip(0, 20));
    const id = trackOf(state, 'VIDEO').clips[0]!.id;
    expectRejected(
      () =>
        applyOperations(
          state,
          [{ op: 'split_clip', clipId: id, at: s(at), newClipId: newId('clip') }],
          media,
        ),
      'invalid_operation',
    );
  });

  it('keeps fades and transitions on the outer edges only', () => {
    const state = withClips(clip(0, 20));
    const id = trackOf(state, 'VIDEO').clips[0]!.id;
    const styled = applyOperations(
      state,
      [
        { op: 'update_audio', clipId: id, fadeIn: s(1), fadeOut: s(2) },
        {
          op: 'update_transition',
          clipId: id,
          side: 'out',
          transition: { type: 'fade_black', duration: s(1) },
        },
      ],
      media,
    ).state;
    const next = applyOperations(
      styled,
      [{ op: 'split_clip', clipId: id, at: s(10), newClipId: newId('clip') }],
      media,
    ).state;
    const [left, right] = trackOf(next, 'VIDEO').clips;
    expect(left?.audio).toMatchObject({ fadeIn: s(1), fadeOut: 0 });
    expect(right?.audio).toMatchObject({ fadeIn: 0, fadeOut: s(2) });
    expect(left?.transitionOut).toBeNull();
    expect(right?.transitionOut).toEqual({ type: 'fade_black', duration: s(1) });
  });
});

describe('inverse operations', () => {
  function roundTrip(state: TimelineState, operations: TimelineOperation[]) {
    const { state: changed, inverse } = applyOperations(state, operations, media);
    expect(changed).not.toEqual(state);
    const restored = applyOperations(changed, inverse, media);
    expect(restored.state).toEqual(state);
    // Redo: the inverse of the inverse leads back to the changed state.
    expect(applyOperations(restored.state, restored.inverse, media).state).toEqual(changed);
  }

  const base = () => {
    const state = withClips(clip(0, 10), clip(10, 10, 50));
    const captions = trackOf(state, 'CAPTIONS');
    return applyOperations(
      state,
      [
        {
          op: 'add_caption',
          trackId: captions.id,
          clip: createCaptionClip({ start: s(1), duration: s(2), text: 'Hello' }, rate),
        },
      ],
      media,
    ).state;
  };
  const ids = (state: TimelineState) => trackOf(state, 'VIDEO').clips.map((c) => c.id);
  const captionId = (state: TimelineState) => trackOf(state, 'CAPTIONS').clips[0]!.id;

  const cases: Array<[string, (state: TimelineState) => TimelineOperation[]]> = [
    ['remove_clip', (st) => [{ op: 'remove_clip', clipId: ids(st)[1]! }]],
    ['remove caption', (st) => [{ op: 'remove_clip', clipId: captionId(st) }]],
    ['move_clip', (st) => [{ op: 'move_clip', clipId: ids(st)[1]!, start: s(40) }]],
    [
      'change_track',
      (st) => [
        { op: 'change_track', clipId: ids(st)[1]!, trackId: trackOf(st, 'BROLL').id, start: s(3) },
      ],
    ],
    [
      'trim_clip',
      (st) => [
        {
          op: 'trim_clip',
          clipId: ids(st)[1]!,
          start: s(12),
          duration: s(5),
          sourceIn: s(52),
          sourceOut: s(52) + s(5),
        },
      ],
    ],
    [
      'split_clip',
      (st) => [{ op: 'split_clip', clipId: ids(st)[0]!, at: s(4), newClipId: newId('clip') }],
    ],
    ['change_volume', (st) => [{ op: 'change_volume', clipId: ids(st)[0]!, volume: 0.5 }]],
    [
      'change_speed',
      (st) => [
        {
          op: 'change_speed',
          clipId: ids(st)[0]!,
          speed: 2,
          duration: snapToFrame(s(10) / 2, rate),
        },
      ],
    ],
    [
      'update_transition',
      (st) => [
        {
          op: 'update_transition',
          clipId: ids(st)[0]!,
          side: 'in',
          transition: { type: 'crossfade', duration: s(1) },
        },
      ],
    ],
    ['update_audio', (st) => [{ op: 'update_audio', clipId: ids(st)[0]!, normalize: true }]],
    ['update_caption', (st) => [{ op: 'update_caption', clipId: captionId(st), text: 'Changed' }]],
    [
      'update_transform',
      (st) => [
        {
          op: 'update_transform',
          clipId: ids(st)[0]!,
          transform: { x: 0.2, y: 0, scale: 1.5, rotation: 0, opacity: 1 },
        },
      ],
    ],
    ['set_clip_enabled', (st) => [{ op: 'set_clip_enabled', clipId: ids(st)[0]!, enabled: false }]],
    [
      'update_track',
      (st) => [{ op: 'update_track', trackId: trackOf(st, 'VIDEO').id, muted: true }],
    ],
    ['ripple cut', (st) => cutRangeOperations(st, s(2), s(14))],
  ];

  it.each(cases)('%s round-trips exactly', (_name, build) => {
    const state = base();
    roundTrip(state, build(state));
  });

  it('round-trips a split that had fades and transitions', () => {
    const state = withClips(clip(0, 20));
    const id = trackOf(state, 'VIDEO').clips[0]!.id;
    const styled = applyOperations(
      state,
      [
        { op: 'update_audio', clipId: id, fadeIn: s(1), fadeOut: s(2) },
        {
          op: 'update_transition',
          clipId: id,
          side: 'out',
          transition: { type: 'fade_black', duration: s(1) },
        },
      ],
      media,
    ).state;
    roundTrip(styled, [{ op: 'split_clip', clipId: id, at: s(5), newClipId: newId('clip') }]);
  });

  it('survives long random edit sequences, undoing back to the exact start', () => {
    // A seeded generator, so a failure here can be reproduced.
    let seed = 42;
    const random = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
    let state = withClips(clip(0, 30), clip(30, 30, 100), clip(60, 30, 200));
    const initial = state;
    const undo: TimelineOperation[][] = [];
    for (let i = 0; i < 400; i++) {
      const clips = trackOf(state, 'VIDEO').clips;
      const target = clips[Math.floor(random() * clips.length)];
      if (!target) break;
      const choice = random();
      let ops: TimelineOperation[];
      if (choice < 0.3 && target.duration > 4 * frame) {
        const offset = 2 * frame;
        ops = [
          {
            op: 'split_clip',
            clipId: target.id,
            at: target.start + offset,
            newClipId: newId('clip'),
          },
        ];
      } else if (choice < 0.5) {
        ops = [{ op: 'change_volume', clipId: target.id, volume: Math.round(random() * 100) / 50 }];
      } else if (choice < 0.7) {
        ops = [{ op: 'set_clip_enabled', clipId: target.id, enabled: random() > 0.5 }];
      } else if (clips.length > 2) {
        ops = cutRangeOperations(state, target.start, target.start + frame * 3);
      } else {
        continue;
      }
      const result = applyOperations(state, ops, media);
      undo.push(result.inverse);
      state = result.state;
    }
    expect(undo.length).toBeGreaterThan(200);
    for (const inverse of undo.reverse()) state = applyOperations(state, inverse, media).state;
    expect(state).toEqual(initial);
  });
});

describe('cutRangeOperations', () => {
  it('closes the gap across every track, keeping captions on their words', () => {
    let state = withClips(clip(0, 10), clip(10, 10, 100));
    state = applyOperations(
      state,
      [
        {
          op: 'add_caption',
          trackId: trackOf(state, 'CAPTIONS').id,
          clip: createCaptionClip({ start: s(12), duration: s(2), text: 'Later' }, rate),
        },
      ],
      media,
    ).state;
    const next = applyOperations(state, cutRangeOperations(state, s(5), s(8)), media).state;
    expect(timelineDuration(next)).toBe(timelineDuration(state) - (s(8) - s(5)));
    expect(trackOf(next, 'CAPTIONS').clips[0]!.start).toBe(s(12) - (s(8) - s(5)));
    const [first, second, third] = trackOf(next, 'VIDEO').clips;
    if (first?.kind !== 'media' || second?.kind !== 'media') throw new Error('expected media');
    expect(first.sourceOut).toBe(s(5));
    expect(second.sourceIn).toBe(s(8));
    expect(second.start).toBe(s(5));
    expect(third?.start).toBe(second.start + second.duration);
  });

  it('removes a clip entirely inside the range', () => {
    const state = withClips(clip(0, 5), clip(5, 5, 50), clip(10, 5, 90));
    const next = applyOperations(state, cutRangeOperations(state, s(5), s(10)), media).state;
    expect(trackOf(next, 'VIDEO').clips).toHaveLength(2);
    expect(timelineDuration(next)).toBe(timelineDuration(state) - (s(10) - s(5)));
  });

  it('leaves excluded tracks alone, so music keeps playing under a dialogue cut', () => {
    let state = withClips(clip(0, 20));
    const music = trackOf(state, 'MUSIC');
    state = applyOperations(
      state,
      [{ op: 'add_music', trackId: music.id, clip: clip(0, 20, 300) }],
      media,
    ).state;
    const next = applyOperations(
      state,
      cutRangeOperations(state, s(5), s(10), { excludeTrackIds: new Set([music.id]) }),
      media,
    ).state;
    expect(trackOf(next, 'MUSIC').clips).toHaveLength(1);
    expect(trackOf(next, 'MUSIC').clips[0]!.duration).toBe(s(20));
    expect(trackOf(next, 'VIDEO').clips).toHaveLength(2);
  });

  it('never touches a locked track', () => {
    let state = withClips(clip(0, 20));
    const video = trackOf(state, 'VIDEO');
    state = applyOperations(state, [{ op: 'update_track', trackId: video.id, locked: true }]).state;
    expect(cutRangeOperations(state, s(5), s(10))).toEqual([]);
  });

  it('cuts many ranges at once, with each landing on the right footage', () => {
    const state = withClips(clip(0, 60));
    const ranges = [
      { start: s(10), end: s(12) },
      { start: s(30), end: s(35) },
      { start: s(50), end: s(51) },
    ];
    const next = applyOperations(state, cutRangesOperations(state, ranges), media).state;
    const clips = trackOf(next, 'VIDEO').clips;
    expect(clips).toHaveLength(4);
    const sources = clips.map((c) => (c.kind === 'media' ? [c.sourceIn, c.sourceOut] : []));
    expect(sources[0]).toEqual([s(0), s(10)]);
    expect(sources[1]![0]).toBe(s(12));
    expect(sources[1]![1]).toBe(s(30));
    expect(sources[2]![0]).toBe(s(35));
    expect(sources[3]![0]).toBe(s(51));
    let cursor = 0;
    for (const item of clips) {
      expect(item.start).toBe(cursor);
      cursor += item.duration;
    }
  });
});

describe('deleteClipsOperations', () => {
  it('leaves a gap without ripple and closes it with ripple', () => {
    const state = withClips(clip(0, 10), clip(10, 10, 50), clip(20, 10, 90));
    const middle = trackOf(state, 'VIDEO').clips[1]!.id;
    const gap = applyOperations(state, deleteClipsOperations(state, [middle], false), media).state;
    expect(trackOf(gap, 'VIDEO').clips[1]!.start).toBe(s(20));
    const closed = applyOperations(
      state,
      deleteClipsOperations(state, [middle], true),
      media,
    ).state;
    expect(trackOf(closed, 'VIDEO').clips[1]!.start).toBe(s(10));
  });
});

describe('speedRangeOperations', () => {
  it('speeds up only the range and shifts the rest', () => {
    const state = withClips(clip(0, 60));
    const next = applyOperations(state, speedRangeOperations(state, 0, s(15), 2), media).state;
    const clips = trackOf(next, 'VIDEO').clips;
    expect(clips).toHaveLength(2);
    const [fast, rest] = clips;
    if (fast?.kind !== 'media' || rest?.kind !== 'media') throw new Error('expected media');
    expect(fast.speed).toBe(2);
    expect(fast.sourceIn).toBe(0);
    expect(fast.sourceOut).toBe(s(15));
    expect(rest.start).toBe(fast.duration);
    expect(rest.sourceIn).toBe(s(15));
    expect(timelineDuration(next)).toBeLessThan(s(60));
    expect(timelineDuration(next)).toBeGreaterThanOrEqual(s(60) - s(15) / 2 - frame);
  });

  it('can slow a range down, pushing later clips right', () => {
    const state = withClips(clip(0, 10), clip(10, 10, 50));
    const next = applyOperations(state, speedRangeOperations(state, 0, s(10), 0.5), media).state;
    const [slow, after] = trackOf(next, 'VIDEO').clips;
    expect(slow?.duration).toBeGreaterThan(s(10));
    expect(after?.start).toBe(slow!.start + slow!.duration);
  });

  it('retimes captions inside the range with the footage', () => {
    let state = withClips(clip(0, 60));
    state = applyOperations(
      state,
      [
        {
          op: 'add_caption',
          trackId: trackOf(state, 'CAPTIONS').id,
          clip: createCaptionClip({ start: s(10), duration: s(4), text: 'Inside' }, rate),
        },
        {
          op: 'add_caption',
          trackId: trackOf(state, 'CAPTIONS').id,
          clip: createCaptionClip({ start: s(20), duration: s(4), text: 'After' }, rate),
        },
      ],
      media,
    ).state;
    const next = applyOperations(state, speedRangeOperations(state, 0, s(15), 2), media).state;
    const [inside, after] = trackOf(next, 'CAPTIONS').clips;
    expect(inside?.start).toBeCloseTo(s(5), -8);
    expect(inside?.duration).toBeLessThan(s(4));
    expect(after?.start).toBeLessThan(s(20));
  });

  it('undoes exactly', () => {
    const state = withClips(clip(0, 60));
    const { state: changed, inverse } = applyOperations(
      state,
      speedRangeOperations(state, s(5), s(15), 1.5),
      media,
    );
    expect(applyOperations(changed, inverse, media).state).toEqual(state);
  });
});

describe('trimOperation', () => {
  const trimmed = (edge: 'start' | 'end', time: number, state = withClips(clip(10, 20, 100))) => {
    const target = trackOf(state, 'VIDEO').clips[0]!;
    const op = trimOperation(target, edge, time, state, s(3600));
    return trackOf(applyOperations(state, [op], media).state, 'VIDEO').clips[0]!;
  };

  it('moves the source in point with the head', () => {
    const result = trimmed('start', s(15));
    if (result.kind !== 'media') throw new Error('expected media');
    expect(result.start).toBe(s(15));
    expect(result.sourceIn).toBe(s(100) + (s(15) - s(10)));
    expect(result.sourceOut).toBe(s(100) + s(20));
  });

  it('moves the out point with the tail', () => {
    const result = trimmed('end', s(25));
    if (result.kind !== 'media') throw new Error('expected media');
    expect(result.start).toBe(s(10));
    expect(result.sourceOut).toBe(s(100) + (s(25) - s(10)));
  });

  it('can extend a head back only as far as the source allows', () => {
    const result = trimmed('start', 0, withClips(clip(10, 20, 2)));
    if (result.kind !== 'media') throw new Error('expected media');
    expect(result.sourceIn).toBeGreaterThanOrEqual(0);
    expect(result.sourceIn).toBeLessThan(frame);
    expect(result.start).toBeGreaterThanOrEqual(s(10) - s(2) - frame);
  });

  it('cannot extend a tail past the source', () => {
    const state = withClips(clip(0, 20, 3580));
    const target = trackOf(state, 'VIDEO').clips[0]!;
    const op = trimOperation(target, 'end', s(100), state, s(3600));
    expect(() => applyOperations(state, [op], media)).not.toThrow();
    const result = trackOf(applyOperations(state, [op], media).state, 'VIDEO').clips[0]!;
    if (result.kind !== 'media') throw new Error('expected media');
    expect(result.sourceOut).toBeLessThanOrEqual(s(3600));
  });

  it('never collapses a clip below one frame', () => {
    expect(trimmed('end', s(5)).duration).toBe(frame);
    expect(trimmed('start', s(100)).duration).toBe(frame);
  });
});

describe('queries', () => {
  it('finds clips quickly over a very long track', () => {
    const state = empty();
    const video = trackOf(state, 'VIDEO');
    const ops: TimelineOperation[] = [];
    const length = 60 * frame;
    for (let i = 0; i < 5000; i++) {
      const item = createMediaClip(
        { sourceMediaId: mediaId, start: i * length, sourceIn: 0, sourceOut: length },
        rate,
      );
      ops.push({ op: 'add_clip', trackId: video.id, clip: item });
    }
    const big = applyOperations(state, ops).state;
    const started = performance.now();
    for (let i = 0; i < 20000; i++) clipAt(trackOf(big, 'VIDEO'), s(i % 10000));
    expect(performance.now() - started).toBeLessThan(500);
    expect(clipsInRange(trackOf(big, 'VIDEO').clips, 600 * frame, 900 * frame)).toHaveLength(5);
    expect(clipAt(trackOf(big, 'VIDEO'), s(100_000))).toBeNull();
    expect(findClip(big, trackOf(big, 'VIDEO').clips[4999]!.id)?.clipIndex).toBe(4999);
  });

  it('lists affected clips for previews', () => {
    const state = withClips(clip(0, 10));
    const id = trackOf(state, 'VIDEO').clips[0]!.id;
    const created = newId('clip');
    expect(
      affectedClipIds([{ op: 'split_clip', clipId: id, at: s(1), newClipId: created }]).sort(),
    ).toEqual([id, created].sort());
  });

  it('passes validation on an empty timeline', () => {
    expect(() => validateTimeline(empty())).not.toThrow();
  });
});
