import { describe, expect, it } from 'vitest';
import { confirmedBytes, partLength, pendingParts } from './parts';

const plan = { size: 25, partSize: 10, partCount: 3 };

describe('multipart planning', () => {
  it('sizes the last part as the remainder', () => {
    expect([1, 2, 3].map((n) => partLength(n, plan))).toEqual([10, 10, 5]);
    expect(partLength(2, { size: 20, partSize: 10, partCount: 2 })).toBe(10);
  });

  it('skips only parts stored at the right size', () => {
    const uploadedParts = [
      { partNumber: 1, size: 10 },
      { partNumber: 3, size: 4 },
    ];
    expect(pendingParts({ ...plan, uploadedParts })).toEqual([2, 3]);
    expect(confirmedBytes({ ...plan, uploadedParts })).toBe(10);
  });

  it('finishes when everything is stored', () => {
    const uploadedParts = [1, 2, 3].map((n) => ({ partNumber: n, size: partLength(n, plan) }));
    expect(pendingParts({ ...plan, uploadedParts })).toEqual([]);
    expect(confirmedBytes({ ...plan, uploadedParts })).toBe(25);
  });
});
