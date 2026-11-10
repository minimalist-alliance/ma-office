// A desk style's texture on the canvas (`theme/deskStyles.ts`). An image is fetched only when a desk that wears it
// is drawn, or at idle for the other two themes of a style in use, so a theme switch has it ready. It's decoded off
// the main thread (`createImageBitmap`) and kept, with smaller copies for zoomed-out views made only when one is
// needed, each half the one before. A panel's bitmap (`sprites.ts`) is filled from the copy nearest its raster scale,
// so at rest the texture is part of a 1:1 blit like the rest of the panel: crisp at any zoom and device pixel ratio,
// and a pan or a zoom costs nothing more than it did. A failed image leaves the desk its style's flat base, silently.
import { deskStyleOf, type DeskTexture } from '../theme/deskStyles';
import { THEME_IDS } from '../theme/tokens';

interface Entry {
  state: 'loading' | 'ready' | 'failed';
  /** Full size first, then each half the last, made once each, so a draw that asks again allocates nothing. */
  levels: TextureLevel[];
}

export interface TextureLevel {
  image: ImageBitmap;
  /** Which copy: 0 is the image itself. */
  level: number;
  /** Its pixels per desk unit. */
  density: number;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let loads = 0;

/** A texture has arrived: whatever wears it can draw it now. */
export function onTextureReady(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** How many images have been asked for since the page loaded, for tests. */
export const textureLoads = (): number => loads;

function load(tex: DeskTexture): Entry {
  const entry: Entry = { state: 'loading', levels: [] };
  entries.set(tex.src, entry);
  loads += 1;
  const img = new Image();
  img.decoding = 'async';
  // A built-in's `src` is a key (`theme/deskStyleFiles.ts`); a test's is already a URL.
  import('../theme/deskStyleFiles')
    .then((f) => {
      img.src = f.DESK_STYLE_FILES[tex.src] ?? tex.src;
      return img.decode();
    })
    .then(() => createImageBitmap(img))
    .then((bitmap) => {
      entry.levels = [{ image: bitmap, level: 0, density: tex.density }];
      entry.state = 'ready';
      listeners.forEach((fn) => fn());
    }, () => {
      entry.state = 'failed';
    });
  return entry;
}

/** Fetch and decode it now, without drawing it. */
export function preloadTexture(tex: DeskTexture): void {
  if (!entries.has(tex.src)) load(tex);
}

/** Every theme's texture for a style a desk wears, so a theme switch finds them decoded. A flat style has none. */
export function preloadDeskStyle(id: string | undefined): void {
  const style = deskStyleOf(id);
  for (const theme of THEME_IDS) {
    const tex = style.looks[theme].texture;
    if (tex) preloadTexture(tex);
  }
}

/**
 * Which copy to draw at `q` bitmap pixels per desk unit: the smallest that still has at least that many, so it's only
 * ever scaled down by less than half (where plain bilinear filtering holds every detail), or up past the full image.
 */
export function levelFor(density: number, q: number, levels: number): number {
  if (!(q > 0)) return 0;
  return Math.max(0, Math.min(levels - 1, Math.floor(Math.log2(density / q))));
}

/** How many copies an image this size can have: down to 32 pixels on its shorter side. */
export const levelCount = (width: number, height: number): number => Math.max(1, Math.floor(Math.log2(Math.min(width, height) / 32)) + 1);

/**
 * Half of a tile, every pixel the mean of the four under it. Bilinear sampling at exactly half lands each sample on
 * the corner between four pixels, so this is a box filter, and no sample reaches past an edge: the copy still tiles.
 */
function half(src: ImageBitmap): ImageBitmap {
  const canvas = new OffscreenCanvas(Math.max(1, src.width >> 1), Math.max(1, src.height >> 1));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas.transferToImageBitmap();
}

/** The copy to fill with at `q`, or null while it's on its way (and then it's asked for). */
export function textureLevel(tex: DeskTexture, q: number): TextureLevel | null {
  const entry = entries.get(tex.src) ?? load(tex);
  if (entry.state !== 'ready') return null;
  const first = entry.levels[0]!.image;
  const level = levelFor(tex.density, q, levelCount(first.width, first.height));
  while (entry.levels.length <= level) {
    const n = entry.levels.length;
    entry.levels.push({ image: half(entry.levels[n - 1]!.image), level: n, density: tex.density / 2 ** n });
  }
  return entry.levels[level]!;
}

/** A fill for a context, in desk units, from the copy for `q`. Patterns are kept per context, since one belongs to the context that made it. */
const patterns = new WeakMap<CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, Map<string, CanvasPattern>>();

export function texturePattern(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, tex: DeskTexture, q: number): CanvasPattern | null {
  const lvl = textureLevel(tex, q);
  if (!lvl) return null;
  let mine = patterns.get(ctx);
  if (!mine) {
    mine = new Map();
    patterns.set(ctx, mine);
  }
  const key = `${tex.src}|${lvl.level}`;
  const known = mine.get(key);
  if (known) return known;
  const made = ctx.createPattern(lvl.image, 'repeat');
  if (!made) return null;
  made.setTransform(new DOMMatrix([1 / lvl.density, 0, 0, 1 / lvl.density, 0, 0]));
  mine.set(key, made);
  return made;
}
