// A DOM glyph canvas's backing store (`GlyphCanvas`, `chrome/icons.tsx`): its box in the screen's own pixels, so the bitmap
// maps 1:1 to them and is never resampled (at 1.25x or 1.5x a rounded `size x devicePixelRatio` can be a pixel off the box
// the browser paints, and the glyph blurs).

/**
 * The device-pixel box of an element `w` x `h` CSS px whose top-left is at `x`, `y` CSS px, at `dpr` device pixels a CSS
 * pixel: each edge lands on a device pixel, as the browser snaps it, and each axis is the distance between its snapped
 * edges. So an 18 px box at 1.25x is 23 or 22 device pixels by where it sits (22.5 either way), and two boxes side by side
 * cover exactly what one box over both would. Never under 1.
 */
export function deviceBox(x: number, y: number, w: number, h: number, dpr: number): { w: number; h: number } {
  const span = (at: number, len: number): number => Math.max(1, Math.round((at + len) * dpr) - Math.round(at * dpr));
  return { w: span(x, w), h: span(y, h) };
}
