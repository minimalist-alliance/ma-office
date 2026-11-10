import { describe, expect, it } from 'vitest';
import { backoffMs } from './backoff';

describe('backoff (design 4.2.7)', () => {
  it('runs 0.5, 1, 2 ... up to 30 s', () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 40].map((n) => backoffMs(n, mid))).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
  });

  it('jitters by 20 % either way', () => {
    expect(backoffMs(1, () => 0)).toBeCloseTo(800);
    expect(backoffMs(1, () => 1)).toBeCloseTo(1200);
    expect(backoffMs(20, () => 1)).toBeCloseTo(36000);
  });

  it('treats a negative attempt as the first', () => {
    expect(backoffMs(-3, () => 0.5)).toBe(500);
  });
});
