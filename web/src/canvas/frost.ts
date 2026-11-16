// The tile in hand, frosted (the owner, Nov 16: the rest of the office in the app tiles' glass C; `docs/sub-status/office-glass.md`).
// At rest an icon's glass shows its desk's texture frosted and bent (`glass.ts` `glassBackdrop`); in hand it moves over the desk and
// whatever else is on it, so what's behind it is the desk without it: drawn once, in idle time after the press, at most half its
// size on screen (frost needs no detail), blurred by the glass's own frost, and kept until the drop. Each frame of the drag draws the
// part under the tile from that one bitmap, clipped to the tile: one blit, never a blur in a frame (the "never sluggish" rule).
// Nothing else on a desk moves while a tile is dragged freely, so the copy stays true for the whole drag.
import type Konva from 'konva';

/** A desk without the tile in hand, frosted, and where it is on the stage (CSS px, as `getAbsoluteTransform` has it). */
export interface FrostUnder {
  image: HTMLCanvasElement;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The copy's largest side, in px: a frosted desk needs no detail. */
const MAX_SIDE = 900;

/**
 * `desk` (`size` in desk units) drawn without `tile`, blurred by `frost` desk units, or null if there's nothing to draw. Its box
 * on the stage comes from its own transform and size: Konva can't measure a shape that draws itself. What a desk draws pinned
 * to the screen (its etched name, `camera.pinToScreen`) can't be placed in a copy and is left out: it's in the strip, where no
 * tile goes.
 */
export function frostUnder(desk: Konva.Node, tile: Konva.Node, size: { w: number; h: number }, frost: number): FrostUnder | null {
  const m = desk.getAbsoluteTransform().getMatrix();
  const scale = m[0] ?? 1;
  const r = { x: m[4] ?? 0, y: m[5] ?? 0, width: size.w * scale, height: size.h * (m[3] ?? 1) };
  if (!(r.width >= 1 && r.height >= 1)) return null;
  const ratio = Math.min(0.5, MAX_SIDE / Math.max(r.width, r.height));
  const container = desk as Konva.Container;
  const pinned = typeof container.find === 'function' ? container.find('.desk-name') : [];
  const hidden = [tile, ...pinned].filter((n) => n.visible());
  for (const n of hidden) n.visible(false);
  let shot: HTMLCanvasElement;
  try {
    shot = desk.toCanvas({ x: r.x, y: r.y, width: r.width, height: r.height, pixelRatio: ratio });
  } finally {
    for (const n of hidden) n.visible(true);
  }
  const out = document.createElement('canvas');
  out.width = shot.width;
  out.height = shot.height;
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  ctx.filter = `blur(${Math.max(0.5, frost * scale * ratio).toFixed(2)}px)`;
  ctx.drawImage(shot, 0, 0);
  return { image: out, x: r.x, y: r.y, w: r.width, h: r.height };
}

/** The part of `f` under a tile `w` by `h` on a context in the tile's own units (absolute transform `m`), clipped to its corners. */
export function drawFrostUnder(ctx: CanvasRenderingContext2D, f: FrostUnder, m: number[], w: number, h: number, radius: number): void {
  const s = m[0] ?? 1;
  const t = m[3] ?? 1;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, radius);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(f.image, (f.x - (m[4] ?? 0)) / s, (f.y - (m[5] ?? 0)) / t, f.w / s, f.h / t);
  ctx.restore();
}
