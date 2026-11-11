// Chrome sprites (design 3.10). Soft shadows are the most expensive thing to draw on a canvas,
// so panel and tile chrome (shadow, fill, hairline, ring, glyph) is rendered once into an
// offscreen bitmap per size and raster scale, and blitted afterwards. The raster scale follows
// the camera only when it settles. While the camera moves the last raster is reused, so a move
// never spends a frame rasterizing.
//
// From the prototype's measurements: a filtered blit costs a third of the frame budget in
// software rendering when panning at DPR 2. So smoothing is on only when the bitmap is actually
// being scaled (a zoom in progress) and off for a 1:1 pan.
import type { DeskStyleLook } from '../theme/deskStyles';
import type { DeskEtch, ShadowLayer, Tokens } from '../theme/tokens';
import { backdropOn } from '../theme/backdropMirror';
import { RING } from '../theme/tokens';
import { textureLevel, texturePattern } from './textureHub';
import { askForEtchFont, COUNT_GAP, countCell, countDigitInk, etchEpoch, etchWidth, setCountType, setEtchType, setStatusType, statusTextWidth } from './etch';
import { drawEtchIcon, drawGlyph, drawHiddenIcon, type EtchIcon } from './glyphs';
import { ETCH_DEPTH, ETCH_ICON, ETCH_SIZE, iconGlyphSize } from './layout';
import type { GlyphId } from '../agent/roster';

export interface Sprite {
  image: ImageBitmap;
  x: number;
  y: number;
  width: number;
  height: number;
  bytes: number;
}

const cache = new Map<string, Sprite>();
const MAX_BYTES = 64 * 1024 * 1024; // least recently used bitmaps go first
let bytes = 0;

/** Bitmap pixels per world unit. Updated when the camera settles. */
let rasterScale = 1;
/** On-screen device pixels per world unit, updated every camera change. */
let screenScale = 1;

export const getRasterScale = (): number => rasterScale;
export function setRasterScale(v: number): void {
  rasterScale = Math.min(6, Math.max(0.4, v));
}
export function setScreenScale(v: number): void {
  screenScale = v;
}
export function needsSmoothing(): boolean {
  return Math.abs(screenScale - rasterScale) > 0.001;
}

// What's cut into a desk (below) has its own, since these are small and never depend on the camera. A zoom
// rasters whole panels, and in a shared cache those would push out what's still in use.
const cutCache = new Map<string, Sprite>();
const MAX_CUT_BYTES = 8 * 1024 * 1024;
let cutBytes = 0;

/** Drop every bitmap. Called on a theme change: all chrome is theme colors. */
export function invalidateSprites(): void {
  for (const s of cache.values()) s.image.close();
  cache.clear();
  bytes = 0;
  for (const s of cutCache.values()) s.image.close();
  cutCache.clear();
  cutBytes = 0;
}

export const spriteCount = (): number => cache.size + cutCache.size;

function remember(key: string, s: Sprite): Sprite {
  cache.set(key, s);
  bytes += s.bytes;
  while (bytes > MAX_BYTES && cache.size > 1) {
    const oldest = cache.keys().next().value as string;
    const gone = cache.get(oldest);
    bytes -= gone?.bytes ?? 0;
    gone?.image.close();
    cache.delete(oldest);
  }
  return s;
}

function recall(key: string): Sprite | undefined {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit); // most recently used goes last
  }
  return hit;
}

function shadowMargin(layers: readonly ShadowLayer[], extra = 0): number {
  const m = layers.reduce((acc, l) => Math.max(acc, l.blur * 1.6 + Math.abs(l.dy)), 0);
  return Math.ceil(m + extra + 2);
}

/**
 * Blurred rounded-rect shadows only, with no hard-edged fill: draw far off-canvas and throw the
 * shadow back. A blur holds no fine detail, and it is the slow part, so it is rendered once at
 * scale 1 per size and theme and scaled into each raster. A zoom then never re-blurs.
 */
function shadowBitmap(w: number, h: number, r: number, layers: readonly ShadowLayer[], rev: number, m: number): ImageBitmap | null {
  const blurred = layers.filter((l) => !l.spread); // hairlines are drawn as a stroke
  if (!blurred.length) return null;
  const key = `s|${rev}|${w}|${h}|${r}|${m}|${blurred.map((l) => `${l.dy},${l.blur},${l.color}`).join(';')}`;
  const hit = recall(key);
  if (hit) return hit.image;
  const cw = w + 2 * m;
  const ch = h + 2 * m;
  const { canvas, ctx } = makeCanvas(cw, ch, 1);
  const far = cw + 1000;
  ctx.translate(m, m);
  for (const l of blurred) {
    ctx.save();
    ctx.shadowColor = l.color;
    ctx.shadowBlur = l.blur;
    ctx.shadowOffsetX = far;
    ctx.shadowOffsetY = l.dy;
    // The shape's own alpha multiplies the shadow's, so it stays the new context's opaque default: the shadow draws at its token's strength.
    ctx.beginPath();
    ctx.roundRect(-far, 0, w, h, r);
    ctx.fill();
    ctx.restore();
  }
  return finish(key, canvas, 1, -m, -m).image;
}

function paintShadows(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number, r: number, layers: readonly ShadowLayer[], rev: number, m: number): void {
  const bitmap = shadowBitmap(w, h, r, layers, rev, m);
  if (bitmap) ctx.drawImage(bitmap, -m, -m, w + 2 * m, h + 2 * m);
}

// Finished sprites are immutable ImageBitmaps: a blit then never has to snapshot a canvas.
function makeCanvas(cw: number, ch: number, q: number): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  const canvas = new OffscreenCanvas(Math.ceil(cw * q), Math.ceil(ch * q));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.scale(q, q);
  return { canvas, ctx };
}

function finish(key: string, canvas: OffscreenCanvas, q: number, x: number, y: number): Sprite {
  const { width, height } = canvas;
  return remember(key, { image: canvas.transferToImageBitmap(), x, y, width: width / q, height: height / q, bytes: width * height * 4 });
}

export interface PanelSpec {
  w: number;
  h: number;
  active: boolean;
  /** The desk's style in this theme (`theme/deskStyles.ts`): its base color, and its texture once that's arrived. */
  look: DeskStyleLook;
  /** False for the corner drag's stretched bitmap, which takes its texture as it's drawn (`blitPanelLive`). */
  textured?: boolean;
}

let panelRasters = 0;
/** How many panel bitmaps have been drawn since the page loaded, for tests. A move mustn't add to it. */
export const panelRasterCount = (): number => panelRasters;

/**
 * A desk panel: shadow, fill, hairline, and when active the ring and flat glow. A style's texture is drawn into it,
 * between the fill and the hairline, from the copy nearest this raster scale, anchored at the desk's top-left corner
 * in desk units, so it's part of the desk at every zoom. Until the texture arrives the panel is its style's base color,
 * and a new key makes the textured one once it has.
 */
/**
 * Whether the active ring wears its halo: `backdropOn()` as of the last time the camera was at rest. Latched, not read per
 * draw, so a scene arriving mid-zoom can't change a sprite's key and raster a panel while the camera moves; `WorldStage`
 * syncs it (`syncHalo`) when a scene comes or goes, at once at rest and otherwise when the camera settles.
 */
let haloShown = typeof document !== 'undefined' && backdropOn();
export function syncHalo(): void {
  haloShown = backdropOn();
}

export function panelSprite(spec: PanelSpec, t: Tokens, rev: number, radius: number): Sprite {
  const q = rasterScale;
  const tex = spec.textured !== false ? spec.look.texture : null;
  const lvl = tex ? textureLevel(tex, q) : null;
  // While an office background shows, the active ring gets a 1 px halo outside it (ADR 0094), so it's part of the key.
  const halo = spec.active && haloShown;
  const key = `p|${rev}|${q}|${spec.w}|${spec.h}|${spec.active ? (halo ? 2 : 1) : 0}|${radius}|${spec.look.key}|${lvl ? lvl.level : -1}`;
  const hit = recall(key);
  if (hit) return hit;
  panelRasters += 1;
  const layers = spec.active ? t.elevation.panelActive : t.elevation.panel;
  const m = shadowMargin(layers, RING.glow + RING.width);
  const cw = spec.w + 2 * m;
  const ch = spec.h + 2 * m;
  const { canvas, ctx } = makeCanvas(cw, ch, q);
  ctx.translate(m, m);
  paintShadows(ctx, spec.w, spec.h, radius, layers, rev, m);
  if (spec.active) {
    // The flat glow first, so the panel fill sits on top of it.
    const g = RING.glow;
    ctx.fillStyle = t.ring.activeGlow;
    ctx.beginPath();
    ctx.roundRect(-g, -g, spec.w + 2 * g, spec.h + 2 * g, radius + g);
    ctx.fill();
  }
  ctx.fillStyle = spec.look.base;
  ctx.beginPath();
  ctx.roundRect(0, 0, spec.w, spec.h, radius);
  ctx.fill();
  if (lvl) {
    const pattern = ctx.createPattern(lvl.image, 'repeat');
    if (pattern) {
      pattern.setTransform(new DOMMatrix([1 / lvl.density, 0, 0, 1 / lvl.density, 0, 0]));
      ctx.save();
      ctx.clip();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, spec.w, spec.h);
      ctx.restore();
    }
  }
  if (halo) {
    // Just outside the ring: from its outer edge out by one pixel, in `ring.halo`, so the pair reads on any picture.
    ctx.strokeStyle = t.ring.halo;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(-RING.width / 2 - 0.5, -RING.width / 2 - 0.5, spec.w + RING.width + 1, spec.h + RING.width + 1, radius + RING.width / 2 + 0.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(0, 0, spec.w, spec.h, radius);
  }
  if (spec.active) {
    ctx.strokeStyle = t.ring.activeDesk;
    ctx.lineWidth = RING.width;
  } else {
    ctx.strokeStyle = t.border.hairline;
    ctx.lineWidth = 1;
  }
  ctx.stroke();
  return finish(key, canvas, q, -m, -m);
}

export interface TileSpec {
  w: number;
  h: number;
  /** null draws a plain card (the farthest level of detail, or a widget that draws its own content). An agent's is its look. */
  app: GlyphId | null;
  glyphSize: number;
  radius: number;
  /** Over another tile, or being dragged: `elevation.tileStacked`'s shadow and edge, in place of the resting look (ADR 0064). */
  stacked: boolean;
  /** Resting on a textured desk: `elevation.tileTextured`, which in Dark has an edge. */
  textured?: boolean;
}

export function tileSprite(spec: TileSpec, t: Tokens, rev: number): Sprite {
  const q = rasterScale;
  const key = `t|${rev}|${q}|${spec.w}|${spec.h}|${spec.app ?? ''}|${spec.glyphSize}|${spec.radius}|${spec.stacked ? 1 : 0}|${spec.textured ? 1 : 0}`;
  const hit = recall(key);
  if (hit) return hit;
  const layers = spec.stacked ? t.elevation.tileStacked : spec.textured ? t.elevation.tileTextured : t.elevation.tile;
  const m = shadowMargin(layers, 1);
  const cw = spec.w + 2 * m;
  const ch = spec.h + 2 * m;
  const { canvas, ctx } = makeCanvas(cw, ch, q);
  ctx.translate(m, m);
  paintShadows(ctx, spec.w, spec.h, spec.radius, layers, rev, m);
  ctx.fillStyle = t.surface.tile;
  ctx.beginPath();
  ctx.roundRect(0, 0, spec.w, spec.h, spec.radius);
  ctx.fill();
  const edge = layers.find((l) => l.spread)?.color;
  if (edge) {
    // A spread of 1 is a ring just outside the card, so the stroke's middle is half a unit out, and it keeps its token's strength at 1x.
    ctx.beginPath();
    ctx.roundRect(-0.5, -0.5, spec.w + 1, spec.h + 1, spec.radius + 0.5);
  }
  ctx.strokeStyle = edge ?? t.border.hairline;
  ctx.lineWidth = 1;
  ctx.stroke();
  if (spec.app) {
    ctx.save();
    ctx.translate((spec.w - spec.glyphSize) / 2, (spec.h - spec.glyphSize) / 2);
    drawGlyph(ctx, spec.app, t, spec.glyphSize);
    ctx.restore();
  }
  return finish(key, canvas, q, -m, -m);
}

/** A glyph alone: 22 px for a widget's head, or larger to scale while a tile is resized. */
export function glyphSprite(app: GlyphId, t: Tokens, rev: number, size = 22): Sprite {
  const q = rasterScale;
  const key = `g|${rev}|${q}|${app}|${size}`;
  const hit = recall(key);
  if (hit) return hit;
  const { canvas, ctx } = makeCanvas(size, size, q);
  drawGlyph(ctx, app, t, size);
  return finish(key, canvas, q, 0, 0);
}

// ----- what's cut into a desk's surface (ADR 0064). These are the size of their CSS pixels at every zoom, so
// a bitmap depends on its text, the theme and the raster scale, which here is the device pixel ratio, and
// never on the camera. A raster is the only cost: a move draws what's held.

/** Whole device pixels, so a bitmap at a whole position lands on them exactly, at any ratio. */
const devicePx = (v: number, q: number): number => Math.ceil(v * q) / q;

/**
 * A cut, not an outline, with no blur. The shape in `highlight`, a pixel lower: the cut's lit lower lip. On a
 * clear bitmap the shape in `wall`, then `fill` with source-atop, a pixel lower, so only the top band of the
 * wall is left: the shaded upper wall. Then that bitmap over the lip. `plain` is the shape in text.secondary
 * alone, for prefers-contrast: more.
 */
function cut(cw: number, ch: number, q: number, plain: boolean, t: Tokens, ink: EtchInk, shape: (ctx: OffscreenCanvasRenderingContext2D, dy: number, color: string) => void): OffscreenCanvas {
  const { canvas, ctx } = makeCanvas(cw, ch, q);
  if (plain) {
    shape(ctx, 0, t.text.secondary);
    return canvas;
  }
  if (ink.etch.highlight) shape(ctx, ETCH_DEPTH, ink.etch.highlight);
  const inner = makeCanvas(cw, ch, q);
  shape(inner.ctx, 0, ink.etch.wall);
  inner.ctx.globalCompositeOperation = 'source-atop';
  shape(inner.ctx, ETCH_DEPTH, ink.etch.fill);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(inner.canvas, 0, 0);
  return canvas;
}

/**
 * The colors a cut is made in: a desk style's etch in this theme (`theme/deskStyles.ts`), named by `key` in a cache
 * key. A `DeskStyleLook` is one. The same object every time for a style and theme, so a hold compares it.
 */
export interface EtchInk {
  key: string;
  etch: DeskEtch;
}

/**
 * What a draw holds on to, so a frame on a constant-size bitmap builds no key. A closed bitmap has no width:
 * a theme change ends a hold that way, or being pushed out of the cache, and the next draw makes it again.
 */
export interface EtchHold {
  sprite: Sprite | null;
  text: string;
  plain: boolean;
  rev: number;
  q: number;
  epoch: number;
  ink: EtchInk | null;
}

export const newEtchHold = (): EtchHold => ({ sprite: null, text: '', plain: false, rev: 0, q: 0, epoch: -1, ink: null });

function held(h: EtchHold, text: string, plain: boolean, rev: number, q: number, ink: EtchInk): Sprite | null {
  const s = h.sprite;
  return s && s.image.width > 0 && h.text === text && h.plain === plain && h.rev === rev && h.q === q && h.ink === ink && h.epoch === etchEpoch() ? s : null;
}

function hold(h: EtchHold, s: Sprite, text: string, plain: boolean, rev: number, q: number, ink: EtchInk): Sprite {
  h.sprite = s;
  h.text = text;
  h.plain = plain;
  h.rev = rev;
  h.q = q;
  h.ink = ink;
  h.epoch = etchEpoch();
  return s;
}

let cuts = 0;
/** How many cut bitmaps have been drawn since the page loaded, for tests. A move mustn't add to it. */
export const etchRasters = (): number => cuts;

function recallCut(key: string): Sprite | undefined {
  const hit = cutCache.get(key);
  if (hit) {
    cutCache.delete(key);
    cutCache.set(key, hit);
  }
  return hit;
}

function finishCut(key: string, canvas: OffscreenCanvas, q: number, x: number, y: number): Sprite {
  const { width, height } = canvas;
  const made = { image: canvas.transferToImageBitmap(), x, y, width: width / q, height: height / q, bytes: width * height * 4 };
  cuts += 1;
  cutCache.set(key, made);
  cutBytes += made.bytes;
  while (cutBytes > MAX_CUT_BYTES && cutCache.size > 1) {
    const oldest = cutCache.keys().next().value as string;
    const gone = cutCache.get(oldest);
    cutBytes -= gone?.bytes ?? 0;
    gone?.image.close();
    cutCache.delete(oldest);
  }
  return made;
}

// Each raster is a function of its own: what its closure captures would otherwise be allocated on every call
// to the function holding it, and those are called once per desk per frame.
function rasterName(key: string, text: string, plain: boolean, t: Tokens, ink: EtchInk, q: number): Sprite {
  askForEtchFont(text);
  const pad = devicePx(ETCH_DEPTH + 2, q);
  const above = devicePx(ETCH_SIZE * 1.1, q); // room for an accent over a capital, or a taller fallback font
  const below = devicePx(ETCH_SIZE * 0.4, q);
  const y = pad + above;
  const canvas = cut(etchWidth(text) + 2 * pad, above + below + 2 * pad, q, plain, t, ink, (ctx, dy, color) => {
    setEtchType(ctx);
    ctx.fillStyle = color;
    ctx.fillText(text, pad, y + dy);
  });
  return finishCut(key, canvas, q, -pad, -y);
}

/** A desk's name, cut into its surface. One bitmap per name, theme, desk style and raster scale. Its origin is the name's left end on its baseline. */
export function etchSprite(h: EtchHold, text: string, plain: boolean, t: Tokens, rev: number, q: number, ink: EtchInk): Sprite {
  const known = held(h, text, plain, rev, q, ink);
  if (known) return known;
  const key = `e|${rev}|${ink.key}|${q}|${plain ? 1 : 0}|${etchEpoch()}|${text}`;
  return hold(h, recallCut(key) ?? rasterName(key, text, plain, t, ink, q), text, plain, rev, q, ink);
}

function rasterIcon(key: string, icon: EtchIcon, plain: boolean, t: Tokens, ink: EtchInk, q: number): Sprite {
  const pad = devicePx(ETCH_DEPTH + 1, q);
  const canvas = cut(ETCH_ICON + 2 * pad, ETCH_ICON + 2 * pad, q, plain, t, ink, (ctx, dy, color) => {
    ctx.save();
    ctx.translate(pad, pad + dy);
    drawEtchIcon(ctx, icon, color);
    ctx.restore();
  });
  return finishCut(key, canvas, q, -pad, -pad);
}

// One pair per desk style in this theme, so desks in different styles side by side don't take turns at one hold.
const iconHolds = new WeakMap<EtchInk, Record<EtchIcon, EtchHold>>();

function iconHold(ink: EtchInk, icon: EtchIcon): EtchHold {
  let pair = iconHolds.get(ink);
  if (!pair) {
    pair = { grip: newEtchHold(), sparkle: newEtchHold(), carousel: newEtchHold(), desk: newEtchHold() };
    iconHolds.set(ink, pair);
  }
  return pair[icon];
}

/** An icon in the strip, cut like the name. Its origin is its 16-pixel box's top left. */
export function etchIconSprite(icon: EtchIcon, plain: boolean, t: Tokens, rev: number, q: number, ink: EtchInk): Sprite {
  const h = iconHold(ink, icon);
  const known = held(h, icon, plain, rev, q, ink);
  if (known) return known;
  const key = `i|${rev}|${ink.key}|${q}|${plain ? 1 : 0}|${icon}`;
  return hold(h, recallCut(key) ?? rasterIcon(key, icon, plain, t, ink, q), icon, plain, rev, q, ink);
}

// The digits' baseline in the icon's 16-pixel box: their tops and feet line up with the icon's.
const COUNT_BASELINE = 14;

function rasterCount(key: string, text: string, plain: boolean, t: Tokens, ink: EtchInk, q: number): Sprite {
  askForEtchFont(text);
  const pad = devicePx(ETCH_DEPTH + 1, q);
  const cell = countCell();
  const canvas = cut(ETCH_ICON + COUNT_GAP + text.length * cell + 2 * pad, ETCH_ICON + 2 * pad, q, plain, t, ink, (ctx, dy, color) => {
    ctx.save();
    ctx.translate(pad, pad + dy);
    drawHiddenIcon(ctx, color);
    setCountType(ctx);
    ctx.fillStyle = color;
    for (let n = 0; n < text.length; n += 1) {
      const digit = text[n]!;
      // On a whole device pixel, so the cut's edges stay crisp.
      ctx.fillText(digit, Math.round((ETCH_ICON + COUNT_GAP + n * cell + (cell - countDigitInk(digit)) / 2) * q) / q, COUNT_BASELINE);
    }
    ctx.restore();
  });
  return finishCut(key, canvas, q, -pad, -pad);
}

/**
 * The hidden count's icon and number, cut as one, so a frame is one blit. One bitmap per number, theme and raster
 * scale: a new number is a new bitmap once, and only when it changes. Its origin is the icon's box's top left.
 */
export function etchCountSprite(h: EtchHold, text: string, plain: boolean, t: Tokens, rev: number, q: number, ink: EtchInk): Sprite {
  const known = held(h, text, plain, rev, q, ink);
  if (known) return known;
  const key = `c|${rev}|${ink.key}|${q}|${plain ? 1 : 0}|${etchEpoch()}|${text}`;
  return hold(h, recallCut(key) ?? rasterCount(key, text, plain, t, ink, q), text, plain, rev, q, ink);
}

const undoHold = newEtchHold();
/** "Undo" is the app font in the desk's `deskText`. */
const NO_INK: EtchInk = { key: '', etch: { fill: '', wall: '', highlight: '' } };

/** "Undo" in cleanup's slot: the strip's one word, plain and in the app font. Its origin is its left end on its baseline. */
export function undoSprite(t: Tokens, rev: number, q: number, color: string = t.text.secondary): Sprite {
  const known = held(undoHold, 'Undo', false, rev, q, NO_INK);
  if (known) return known;
  const key = `u|${rev}|${q}|${color}`;
  const hit = recallCut(key);
  if (hit) return hold(undoHold, hit, 'Undo', false, rev, q, NO_INK);
  const pad = devicePx(2, q);
  const above = devicePx(15, q);
  const { canvas, ctx } = makeCanvas(statusTextWidth('Undo') + 2 * pad, above + devicePx(6, q) + pad, q);
  setStatusType(ctx);
  ctx.fillStyle = color;
  ctx.fillText('Undo', pad, above);
  return hold(undoHold, finishCut(key, canvas, q, -pad, -above), 'Undo', false, rev, q, NO_INK);
}

/** A cut bitmap at a screen position, on a context pointed there by `camera.pinToScreen`. */
export function blitPinned(ctx: CanvasRenderingContext2D, s: Sprite, x: number, y: number): void {
  ctx.drawImage(s.image, x + s.x, y + s.y, s.width, s.height);
}

/** A sprite drawn `k` times its size, from its origin at x, y: the name, which scales with its desk. */
export function blitScaled(ctx: CanvasRenderingContext2D, s: Sprite, x: number, y: number, k: number): void {
  ctx.drawImage(s.image, x + s.x * k, y + s.y * k, s.width * k, s.height * k);
}

/**
 * A panel's flat middle is most of the pixels on a desk, and scaling it is the costliest thing a
 * move rasters. While the bitmap is being scaled, fill the middle and scale only the edge bands.
 * The fill runs under the bands, so no seam shows through. At rest the bitmap is drawn whole.
 */
export function blitPanel(ctx: CanvasRenderingContext2D, s: Sprite, w: number, h: number, band: number, fill: string, textured = false): void {
  // A textured middle isn't flat: it's scaled whole, as tiles are. Only a zoom in progress pays for it.
  if (!needsSmoothing() || textured) {
    blit(ctx, s);
    return;
  }
  const q = s.image.width / s.width;
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = fill;
  ctx.fillRect(band - 1, band - 1, w - 2 * band + 2, h - 2 * band + 2);
  const strip = (x: number, y: number, sw: number, sh: number): void => {
    ctx.drawImage(s.image, (x - s.x) * q, (y - s.y) * q, sw * q, sh * q, x, y, sw, sh);
  };
  strip(s.x, s.y, s.width, band - s.y); // top
  strip(s.x, h - band, s.width, s.y + s.height - (h - band)); // bottom
  strip(s.x, band, band - s.x, h - 2 * band); // left
  strip(w - band, band, s.x + s.width - (w - band), h - 2 * band); // right
  ctx.imageSmoothingEnabled = prev;
}

/**
 * A rounded card at any size from one bitmap of it, in nine pieces: four corners as they are, four
 * edges stretched along their length, and a flat middle. This is for sizes that change every frame,
 * where a bitmap per size would raster a shadow per frame. `corner` must reach past the shadow's
 * falloff, so the stretched part of each edge is uniform. At rest the exact-size bitmap is drawn.
 */
function blitStretched(ctx: CanvasRenderingContext2D, s: Sprite, w: number, h: number, corner: number, fill: string): void {
  const q = s.image.width / s.width;
  const base = s.width + 2 * s.x; // the card's own size in the bitmap
  const cx = Math.min(corner, w / 2);
  const cy = Math.min(corner, h / 2);
  const leftW = cx - s.x;
  const topH = cy - s.y;
  const rightW = s.x + s.width - (base - cx);
  const bottomH = s.y + s.height - (base - cy);
  const piece = (sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void => {
    ctx.drawImage(s.image, (sx - s.x) * q, (sy - s.y) * q, sw * q, sh * q, dx, dy, dw, dh);
  };
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = needsSmoothing();
  const mid = base / 2 - 0.5;
  const midW = w - 2 * cx;
  const midH = h - 2 * cy;
  ctx.fillStyle = fill;
  ctx.fillRect(cx - 1, cy - 1, midW + 2, midH + 2);
  if (midW > 0) {
    piece(mid, s.y, 1, topH, cx, s.y, midW, topH);
    piece(mid, base - cy, 1, bottomH, cx, h - cy, midW, bottomH);
  }
  if (midH > 0) {
    piece(s.x, mid, leftW, 1, s.x, cy, leftW, midH);
    piece(base - cx, mid, rightW, 1, w - cx, cy, rightW, midH);
  }
  piece(s.x, s.y, leftW, topH, s.x, s.y, leftW, topH);
  piece(base - cx, s.y, rightW, topH, w - cx, s.y, rightW, topH);
  piece(s.x, base - cy, leftW, bottomH, s.x, h - cy, leftW, bottomH);
  piece(base - cx, base - cy, rightW, bottomH, w - cx, h - cy, rightW, bottomH);
  ctx.imageSmoothingEnabled = prev;
}

// Past the panel's corner and its widest shadow (blur 32, offset 12, in Light), with room to spare.
const PANEL_CORNER = 72;

/**
 * A panel while its corner is being dragged: no bitmap is made after the first frame. A stretched texture would
 * smear along the edges, so the bitmap is the style's flat base, and the texture fills it here, inside the ring,
 * from a pattern kept for this context: the one desk in hand pays for a filtered fill, and no bitmap.
 */
export function blitPanelLive(ctx: CanvasRenderingContext2D, w: number, h: number, active: boolean, t: Tokens, rev: number, radius: number, look: DeskStyleLook): void {
  const base = 2 * PANEL_CORNER + 2;
  blitStretched(ctx, panelSprite({ w: base, h: base, active, look, textured: false }, t, rev, radius), w, h, PANEL_CORNER, look.base);
  const pattern = look.texture ? texturePattern(ctx, look.texture, screenScale) : null;
  if (!pattern) return;
  const inset = (active ? RING.width : 1) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(inset, inset, w - 2 * inset, h - 2 * inset, Math.max(0, radius - inset));
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// Past a widget's corner (20) and the stacked shadow's falloff (blur 14, offset 4), since a tile being resized is being dragged.
const TILE_CORNER = 44;
const LIVE_GLYPH = 96;

/** A tile while its corner is being dragged: the same idea as a panel, with its glyph scaled over it. */
export function blitTileLive(ctx: CanvasRenderingContext2D, w: number, h: number, app: GlyphId | null, t: Tokens, rev: number, radius: number): void {
  const base = 2 * TILE_CORNER + 2;
  blitStretched(ctx, tileSprite({ w: base, h: base, app: null, glyphSize: 0, radius, stacked: true }, t, rev), w, h, TILE_CORNER, t.surface.tile);
  if (!app) return;
  const size = iconGlyphSize(w, h);
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(glyphSprite(app, t, rev, LIVE_GLYPH).image, (w - size) / 2, (h - size) / 2, size, size);
  ctx.imageSmoothingEnabled = prev;
}

/** Run `fn` when the browser is idle (or soon, where idle callbacks are missing). */
export function whenIdle(fn: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(fn, { timeout: 1500 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(fn, 200);
  return () => window.clearTimeout(id);
}

/** Blit a sprite at the origin of a raw context, or at a point. */
export function blit(ctx: CanvasRenderingContext2D, s: Sprite, x = 0, y = 0): void {
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = needsSmoothing();
  ctx.drawImage(s.image, x + s.x, y + s.y, s.width, s.height);
  ctx.imageSmoothingEnabled = prev;
}
