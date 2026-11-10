import { describe, expect, it } from 'vitest';
import { maskPixels, pngRefusalText } from './png';

const limits = { maxBytes: 262_144, maxPx: 512 };

/** RGBA pixels from a function of x, y. */
function image(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) d.set(px(x, y), (y * w + x) * 4);
  return d;
}
const plus = (x: number, y: number): boolean => (x >= 6 && x <= 9) || (y >= 6 && y <= 9);

/** A plus sign well inside a 20 px picture, clear of the border. */
const inset = (x: number, y: number): boolean => x >= 3 && x < 17 && y >= 3 && y < 17 && plus(x - 3, y - 3);

describe('maskPixels (the desk\'s mask rules, contract section 4)', () => {
  it('keeps a shape on transparency, trimmed and centred in a square with an 8% margin', () => {
    const r = maskPixels(image(40, 40, (x, y) => (plus(x - 10, y - 10) && x >= 10 && x < 26 && y >= 10 && y < 26 ? [0, 0, 0, 255] : [0, 0, 0, 0])), 40, 40);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.size).toBe(Math.ceil(16 / 0.84));
    const a = (x: number, y: number): number => r.rgba[(y * r.size + x) * 4 + 3]!;
    expect(a(0, 0)).toBe(0);
    expect(a(Math.floor(r.size / 2), Math.floor(r.size / 2))).toBe(255);
    const mid = (Math.floor(r.size / 2) * r.size + Math.floor(r.size / 2)) * 4;
    expect([r.rgba[mid], r.rgba[mid + 1], r.rgba[mid + 2]]).toEqual([255, 255, 255]);
  });
  it('is square whatever the shape: a wide wordmark is not stretched', () => {
    const r = maskPixels(image(100, 20, (x, y) => (y >= 4 && y < 16 && x % 6 < 3 ? [0, 0, 0, 255] : [0, 0, 0, 0])), 100, 20);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rgba.length).toBe(r.size * r.size * 4);
  });
  it('reads white on dark as well as dark on white, from the border', () => {
    const dark = maskPixels(image(20, 20, (x, y) => (inset(x, y) ? [255, 255, 255, 255] : [10, 10, 10, 255])), 20, 20);
    const light = maskPixels(image(20, 20, (x, y) => (inset(x, y) ? [0, 0, 0, 255] : [255, 255, 255, 255])), 20, 20);
    expect(dark.ok && light.ok).toBe(true);
  });
  it('refuses a blank picture, a full-bleed block and a busy border as no_shape', () => {
    expect(maskPixels(image(16, 16, () => [0, 0, 0, 0]), 16, 16)).toEqual({ ok: false, reason: 'no_shape' });
    expect(maskPixels(image(16, 16, () => [255, 255, 255, 255]), 16, 16)).toEqual({ ok: false, reason: 'no_shape' });
    expect(maskPixels(image(16, 16, () => [0, 0, 0, 255]), 16, 16)).toEqual({ ok: false, reason: 'no_shape' });
    expect(maskPixels(image(16, 16, (x) => [x * 16, x * 16, x * 16, 255]), 16, 16)).toEqual({ ok: false, reason: 'no_shape' });
    // Ink over 85% of its box.
    expect(maskPixels(image(16, 16, (x, y) => (x === 0 && y === 0 ? [0, 0, 0, 0] : [0, 0, 0, 255])), 16, 16)).toEqual({ ok: false, reason: 'no_shape' });
  });
  it('drops haze under the floor', () => {
    expect(maskPixels(image(16, 16, () => [0, 0, 0, 20]), 16, 16)).toEqual({ ok: false, reason: 'no_shape' });
  });
  it('refuses a hairline as too_thin', () => {
    const r = maskPixels(image(200, 200, (x, y) => (x === 100 || y === 100 ? [0, 0, 0, 255] : [0, 0, 0, 0])), 200, 200);
    expect(r).toEqual({ ok: false, reason: 'too_thin' });
  });
});

describe('refusal words', () => {
  it('says the four reasons the way the Design page does', () => {
    expect(pngRefusalText('not_png', limits)).toBe('That file isn’t a PNG inside, even if its name ends in .png. Export it as PNG and try again.');
    expect(pngRefusalText('no_shape', limits)).toBe('We couldn’t find a shape in that picture. Use a logo or icon on a clear or plain white background.');
    expect(pngRefusalText('too_thin', limits)).toBe('Its lines are too thin to see at icon size. Try a bolder version.');
    expect(pngRefusalText('too_many_pixels', limits)).toBe('That picture is over 512 by 512 pixels. Save a smaller copy and try again.');
  });
});
