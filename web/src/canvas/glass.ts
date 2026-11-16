// An icon's tile as a piece of glass (the owner's pick, Nov 16: "I want C restrained for the app tiles"; `GLASS_FACE` in
// tokens.ts), drawn once into the tile's sprite (`sprites.ts` `tileSprite`), never live: a pan blits the same bitmap as ever.
//
// What reads as glass, in paint order, all inside the tile's rounded rect:
// 1. What's behind it. On a textured desk, the desk's own texture under the tile, frosted and bent at the edge: near the rim the
//    glass reaches out past its edge for the desk beyond, as a thick edge does (the lens). A bitmap of its own per tile place,
//    made in idle time after a settle, never in a frame (`glassLens.ts`, a chunk of its own, fetched with the first one: release
//    6.11 moved it out of the first load). On a flat desk there's nothing to bend, and the body lets the desk through as it's drawn.
// 2. The body: the tile's own tint (the egg), mostly solid.
// 3. Depth from light: a deepening inside the edge away from the light, a sheen down from the top.
// 4. The specular: a thin light that hugs the rim, brightest at the top left where the light hits, fading round the edge to a
//    faint glint opposite, with a soft light just inside it. Never a uniform bevel, and no hairline: the edge is light.
import { glassRgba, type GlassFace } from '../theme/tokens';
import type { TileFill } from '../theme/tileFace';
import { EGG } from '../theme/tileFace';

type Ctx = OffscreenCanvasRenderingContext2D;

/** The desk under a tile, for the glass to show and bend: where the tile sits on it, its base, and its texture at this raster. */
export interface GlassBackdrop {
  x: number;
  y: number;
  base: string;
  image: ImageBitmap;
  density: number;
}

/** The light comes from the top left. */
const LIGHT = (-3 * Math.PI) / 4;

/** A conic gradient round (cx, cy) whose alpha at each angle is `alpha(θ)`, in colour `rgb`. */
function conic(ctx: Ctx, cx: number, cy: number, rgb: string, alpha: (a: number) => number): CanvasGradient | string {
  if (typeof ctx.createConicGradient !== 'function') return glassRgba(rgb, alpha(LIGHT) / 2);
  const g = ctx.createConicGradient(0, cx, cy);
  const n = 48;
  for (let i = 0; i <= n; i += 1) g.addColorStop(i / n, glassRgba(rgb, Number(Math.max(0, Math.min(1, alpha((i / n) * 2 * Math.PI))).toFixed(4))));
  return g;
}

const lit = (a: number): number => Math.max(0, Math.cos(a - LIGHT));
const away = (a: number): number => Math.max(0, Math.cos(a - LIGHT - Math.PI));

/**
 * A band inside the edge, `width` wide, strongest at the edge and fading inward: strokes on the current path (the tile, clipped
 * to it), each a step narrower, so their overlap builds toward the rim.
 */
function band(ctx: Ctx, style: CanvasGradient | string, width: number, steps = 5): void {
  const base = ctx.globalAlpha;
  ctx.strokeStyle = style;
  for (let i = steps; i >= 1; i -= 1) {
    ctx.globalAlpha = base / steps;
    ctx.lineWidth = (2 * width * i) / steps;
    ctx.stroke();
  }
  ctx.globalAlpha = base;
}



/**
 * The light on the glass (the depth inside the edge, the sheen, the specular and the soft light inside it), the same for every app
 * of a size: drawn once per size, raster scale and theme, and laid over each app's body. Its own small cache, keyed by the theme's
 * `GlassFace`.
 */
const lights = new WeakMap<GlassFace, Map<string, OffscreenCanvas>>();
function glassLight(w: number, h: number, r: number, q: number, g: GlassFace): OffscreenCanvas | null {
  let byKey = lights.get(g);
  if (!byKey) lights.set(g, (byKey = new Map()));
  const key = `${w}|${h}|${r}|${q}`;
  const hit = byKey.get(key);
  if (hit) return hit;
  const canvas = new OffscreenCanvas(Math.ceil(w * q), Math.ceil(h * q));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(q, q);
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, r);
  ctx.clip();
  const cx = w / 2;
  const cy = h / 2;
  // Depth: the edge a little deeper away from the light, thin and hugging the rim, so it reads as the glass's thickness.
  if (g.depthAlpha > 0) {
    const deep = conic(ctx, cx, cy, g.depth, (a) => g.depthAlpha * (0.25 + 0.75 * away(a) ** 1.5));
    band(ctx, deep, 3, 3);
    ctx.strokeStyle = deep;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
  if (g.sheen > 0) {
    const s = ctx.createLinearGradient(0, 0, w * 0.18, h * 0.62);
    s.addColorStop(0, glassRgba(g.spec, g.sheen));
    s.addColorStop(1, glassRgba(g.spec, 0));
    ctx.fillStyle = s;
    ctx.fillRect(0, 0, w, h);
  }
  // The specular: brightest at the lit corner, fading round the rim to a glint opposite; a soft light just inside it.
  const spec = (a: number): number => g.specFloor + (g.specPeak - g.specFloor) * lit(a) ** 6 + Math.max(0, g.specBack - g.specFloor) * away(a) ** 8;
  const style = conic(ctx, cx, cy, g.spec, spec);
  if (g.glow > 0) {
    ctx.save();
    ctx.globalAlpha = g.glow;
    band(ctx, style, g.glowWidth, 4);
    ctx.restore();
  }
  ctx.strokeStyle = style;
  ctx.lineWidth = 2 * g.specWidth;
  ctx.stroke();
  if (byKey.size > 64) byKey.clear();
  byKey.set(key, canvas);
  return canvas;
}

/**
 * The glass, inside the tile's rounded rect at (0, 0, w, h) on a context scaled by `q`: the body, the tile's tint `fill` as the egg
 * at `opacity`, then the light. What's behind is its own bitmap under this one (`glassBackdrop`), or the desk itself as it's drawn.
 */
export function drawGlass(ctx: Ctx, w: number, h: number, r: number, q: number, g: GlassFace, fill: TileFill, opacity: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, r);
  ctx.clip();
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(w * EGG.cx, h * EGG.cy);
  ctx.scale(w * EGG.rx, h * EGG.ry);
  const egg = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  egg.addColorStop(EGG.flat, fill.centre);
  egg.addColorStop(1, fill.rim);
  ctx.fillStyle = egg;
  ctx.fillRect(-2, -2, 4, 4);
  ctx.restore();
  const light = glassLight(w, h, r, q, g);
  if (light) ctx.drawImage(light, 0, 0, w, h);
  ctx.restore();
}
