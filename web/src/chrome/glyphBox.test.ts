import { describe, expect, it } from 'vitest';
import { deviceBox } from './glyphBox';

describe('deviceBox: a glyph canvas is its box in device pixels, each axis snapped as the browser snaps the edges', () => {
  it('at 1x and 2x every whole-pixel size is exact, wherever it sits', () => {
    for (const at of [0, 0.5, 3.25, 117.75]) {
      expect(deviceBox(at, at, 18, 24, 1)).toEqual({ w: 18, h: 24 });
      expect(deviceBox(at, at, 18, 24, 2)).toEqual({ w: 36, h: 48 });
    }
  });

  it('at 1.25x an 18 px glyph (22.5 device px) is 23 or 22 by where its edges land, never a rounded 23 everywhere', () => {
    expect(deviceBox(0, 0, 18, 18, 1.25)).toEqual({ w: 23, h: 23 });
    // Left edge at 0.5 CSS px is 0.625 device px, which snaps to 1; the right edge at 18.5 is 23.125, which snaps to 23: 22 across.
    expect(deviceBox(0.5, 0, 18, 18, 1.25)).toEqual({ w: 22, h: 23 });
    expect(deviceBox(0, 0.5, 18, 18, 1.25)).toEqual({ w: 23, h: 22 });
    // The 24 px cut (30 device px) is whole at 1.25x, wherever it is.
    for (const at of [0, 0.25, 0.5, 1, 7.5, 101.25]) expect(deviceBox(at, at, 24, 24, 1.25)).toEqual({ w: 30, h: 30 });
  });

  it('at 1.5x an 18 px glyph is 27 device px, and a 17 px one (25.5) 26 or 25 by where it sits', () => {
    for (const at of [0, 0.5, 1, 33.25]) expect(deviceBox(at, at, 18, 18, 1.5)).toEqual({ w: 27, h: 27 });
    expect(deviceBox(0, 0, 17, 17, 1.5)).toEqual({ w: 26, h: 26 });
    expect(deviceBox(1, 0, 17, 17, 1.5)).toEqual({ w: 25, h: 26 });
    // 24 px is 36, whole.
    expect(deviceBox(0.5, 0.5, 24, 24, 1.5)).toEqual({ w: 36, h: 36 });
  });

  it('two boxes side by side cover exactly what one box over both would, at 1.25x and 1.5x (no gap, no overlap)', () => {
    for (const dpr of [1.25, 1.5]) {
      for (let x = 0; x < 10; x += 0.25) {
        for (const [a, b] of [[18, 18], [17, 24], [18, 6]] as const) {
          expect(deviceBox(x, 0, a, 1, dpr).w + deviceBox(x + a, 0, b, 1, dpr).w).toBe(deviceBox(x, 0, a + b, 1, dpr).w);
        }
      }
    }
  });

  it('is never under 1 device pixel', () => {
    expect(deviceBox(0.5, 0.5, 0.1, 0.1, 1)).toEqual({ w: 1, h: 1 });
  });
});
