// The mark on a canvas, for tiles the Desk draws itself. It paints what AgentMark paints in the DOM: a rounded square
// in the tone, then the icon's strokes (or the uploaded mask) in FOREGROUND and nothing else.
import { GRID, iconById, STROKE } from './icons';
import { FOREGROUND } from './foreground';
import { toneColor, type LookTheme } from './tones';

/** The `icon` id for an uploaded mask: the picture is used for its shape (alpha) only, never its colors. */
export const PNG_ICON = 'png';
/** The glyph's side as a share of the tile's, and the tile's corner radius as a share of its side (the Desk's 18 px on a 76 px tile). */
export const GLYPH_SHARE = 0.56;
export const RADIUS_SHARE = 0.24;
/** Below this tile side (px) the glyph is bigger, so it does not shrink to a speck, and its stroke has a floor. */
export const SMALL_TILE = 32;
export const SMALL_GLYPH_SHARE = 0.7;
/** The thinnest a stroke may draw on screen, in px. */
export const MIN_STROKE_PX = 1.3;

/** The glyph's side for a tile of this side: 56% of it, or 70% below 32 px. Uploads use the same. */
export function glyphSize(size: number): number {
  return size * (size < SMALL_TILE ? SMALL_GLYPH_SHARE : GLYPH_SHARE);
}

/** The stroke width on the 24 grid for a glyph of this side: STROKE, or more where that would draw under 1.3 px. */
export function strokeFor(glyph: number): number {
  return Math.max(STROKE, (MIN_STROKE_PX * GRID) / Math.max(glyph, 1));
}

export interface DrawMarkOptions {
  icon: string;
  tone: string;
  theme: LookTheme;
  mask?: CanvasImageSource | null;
  x: number;
  y: number;
  size: number;
  radius: number;
}

function scratch(w: number, h: number): CanvasRenderingContext2D | null {
  const c: OffscreenCanvas | HTMLCanvasElement | null =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : null;
  return (c?.getContext('2d') as CanvasRenderingContext2D | null) ?? null;
}

function sizeOf(src: CanvasImageSource): { width: number; height: number } {
  const s = src as { width?: number | SVGAnimatedLength; height?: number | SVGAnimatedLength; naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number };
  const w = Number(s.naturalWidth ?? s.videoWidth ?? s.width);
  const h = Number(s.naturalHeight ?? s.videoHeight ?? s.height);
  return { width: w > 0 ? w : 1, height: h > 0 ? h : 1 };
}

export function drawAgentMark(ctx: CanvasRenderingContext2D, o: DrawMarkOptions): void {
  const glyph = glyphSize(o.size);
  const gx = o.x + (o.size - glyph) / 2;
  const gy = o.y + (o.size - glyph) / 2;
  ctx.save();
  ctx.fillStyle = toneColor(o.tone, o.theme);
  ctx.beginPath();
  ctx.roundRect(o.x, o.y, o.size, o.size, o.radius);
  ctx.fill();
  if (o.icon === PNG_ICON) {
    if (o.mask) {
      // Tint through a scratch canvas: the mask's alpha is kept, its colors are replaced.
      const px = Math.max(1, Math.ceil(glyph * (globalThis.devicePixelRatio || 1)));
      const s = scratch(px, px);
      if (s) {
        // Fit the mask into the square, whatever its shape (like CSS `contain`), so an old non-square mask is never stretched.
        const { width: mw, height: mh } = sizeOf(o.mask);
        const k = Math.min(px / mw, px / mh);
        s.drawImage(o.mask, (px - mw * k) / 2, (px - mh * k) / 2, mw * k, mh * k);
        s.globalCompositeOperation = 'source-in';
        s.fillStyle = FOREGROUND;
        s.fillRect(0, 0, px, px);
        ctx.drawImage(s.canvas, gx, gy, glyph, glyph);
      }
    }
  } else {
    const k = glyph / GRID;
    ctx.translate(gx, gy);
    ctx.scale(k, k);
    ctx.strokeStyle = FOREGROUND;
    ctx.lineWidth = strokeFor(glyph);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const d of iconById(o.icon).paths) ctx.stroke(new Path2D(d));
  }
  ctx.restore();
}
