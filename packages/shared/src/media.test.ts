import { describe, expect, it } from 'vitest';
import { MIN_PART_SIZE, partCountFor, partSizeFor, uploadExtension } from './media.js';

describe('multipart sizing', () => {
  it('uses the minimum part size for small files', () => {
    expect(partSizeFor(1024)).toBe(MIN_PART_SIZE);
    expect(partCountFor(1024, MIN_PART_SIZE)).toBe(1);
  });

  it.each([1, 10, 200, 1000, 5000])('stays under the S3 part limit at %d GiB', (gib) => {
    const size = gib * 1024 ** 3;
    expect(partCountFor(size, partSizeFor(size))).toBeLessThanOrEqual(10_000);
  });

  it('counts an exact multiple without an empty final part', () => {
    expect(partCountFor(MIN_PART_SIZE * 3, MIN_PART_SIZE)).toBe(3);
    expect(partCountFor(MIN_PART_SIZE * 3 + 1, MIN_PART_SIZE)).toBe(4);
  });
});

describe('uploadExtension', () => {
  it.each([
    ['clip.MP4', 'mp4'],
    ['my.talk.mov', 'mov'],
    ['a.mkv', 'mkv'],
    ['a.webm', 'webm'],
  ])('accepts %s', (name, expected) => {
    expect(uploadExtension(name)).toBe(expected);
  });

  it.each(['a.exe', 'mp4', 'a.mp4.sh', 'a.', 'constructor', 'a.constructor'])(
    'rejects %s',
    (name) => {
      expect(uploadExtension(name)).toBeNull();
    },
  );
});
