import { describe, expect, it } from 'vitest';
import { rateCap, readViewZoom } from './viewZoom';

describe('readViewZoom: what a view\'s frame sends up, read as numbers only', () => {
  it('a wheel: its delta in CSS px by its mode, and whether a key was held', () => {
    expect(readViewZoom({ w: -100, m: 0, k: true }, 800)).toEqual({ dy: -100, keyHeld: true });
    expect(readViewZoom({ w: 3, m: 1, k: false }, 800)).toEqual({ dy: 48, keyHeld: false });
    expect(readViewZoom({ w: 1, m: 2, k: false }, 800)).toEqual({ dy: 800, keyHeld: false });
  });

  it('a pinch step: at the camera\'s pinch rate, never a held key', () => {
    const grow = readViewZoom({ g: 1.1 }, 800)!;
    expect(grow.keyHeld).toBe(false);
    expect(grow.dy).toBeLessThan(0);
    expect(readViewZoom({ g: 0.9 }, 800)!.dy).toBeGreaterThan(0);
  });

  it('held to its range: nothing larger than one big step reaches the office', () => {
    expect(readViewZoom({ w: 1e9, m: 0, k: false }, 800)!.dy).toBe(2000);
    expect(readViewZoom({ w: -1e9, m: 1, k: false }, 800)!.dy).toBe(-2000);
    expect(readViewZoom({ w: 1, m: 2, k: false }, 1e9)!.dy).toBe(2000);
  });

  it('anything else is nothing', () => {
    const bad: unknown[] = [
      null, undefined, 1, 'w', [], [1, 0, true], { w: 1, m: 0 }, { w: 1, m: 0, k: true, x: 5 }, { w: '1', m: 0, k: true },
      { w: 1, m: 3, k: true }, { w: 1, m: 0.5, k: true }, { w: NaN, m: 0, k: true }, { w: Infinity, m: 0, k: true },
      { w: 1, m: 0, k: 1 }, { g: 0 }, { g: -1 }, { g: 11 }, { g: 0.05 }, { g: NaN }, { g: 1 }, { g: '1.1' }, { g: 1.1, w: 1 },
      { t: 'ma.zoom', w: 1 }, new Map([['w', 1]]), Object.assign(Object.create({ m: 0, k: true }), { w: 1 }),
    ];
    for (const d of bad) expect(readViewZoom(d, 800), JSON.stringify(d)).toBeNull();
  });
});

describe('rateCap', () => {
  it('lets so many through in a second, then none until the next', () => {
    let t = 0;
    const ok = rateCap(3, () => t);
    expect([ok(), ok(), ok(), ok()]).toEqual([true, true, true, false]);
    t = 999;
    expect(ok()).toBe(false);
    t = 1000;
    expect([ok(), ok(), ok(), ok()]).toEqual([true, true, true, false]);
  });
});
