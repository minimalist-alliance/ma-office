// The way into desk textures from the initial bundle (`deskTexture.ts` is its own chunk, because the initial JS has a
// 250 KB budget). Asking for a texture fetches the chunk, which then loads the image as before; until it arrives a
// desk is its style's flat base, as it is while an image loads, and `onTextureReady` redraws when the chunk's first
// image lands. Nothing here runs for a desk that wears no texture.
import type { DeskTexture } from '../theme/deskStyles';
import type { TextureLevel } from './deskTexture';

type Mod = typeof import('./deskTexture');

let mod: Mod | null = null;
let asked: Promise<void> | null = null;
const listeners = new Set<() => void>();

function need(): void {
  asked ??= import('./deskTexture').then((m) => {
    mod = m;
    m.onTextureReady(() => listeners.forEach((fn) => fn()));
  }, () => {
    asked = null;
  });
}

/** A texture has arrived: whatever wears it can draw it now. */
export function onTextureReady(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** How many images have been asked for since the page loaded, for tests. */
export const textureLoads = (): number => mod?.textureLoads() ?? 0;

/** Every theme's texture for a style a desk wears, so a theme switch finds them decoded. A flat style has none. */
export function preloadDeskStyle(id: string | undefined): void {
  if (mod) return mod.preloadDeskStyle(id);
  need();
  void asked?.then(() => mod?.preloadDeskStyle(id));
}

/** The copy to fill with at `q`, or null while it's on its way (and then it's asked for). */
export function textureLevel(tex: DeskTexture, q: number): TextureLevel | null {
  if (mod) return mod.textureLevel(tex, q);
  need();
  return null;
}

export function texturePattern(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, tex: DeskTexture, q: number): CanvasPattern | null {
  if (mod) return mod.texturePattern(ctx, tex, q);
  need();
  return null;
}
