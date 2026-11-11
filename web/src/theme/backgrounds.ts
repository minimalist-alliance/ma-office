// Office backgrounds (ADR 0094): the pure rules. A background is one of the scenes in `public/backgrounds/manifest.json`
// (a photograph behind the office's canvas, under a theme-aware scrim, `surface.backdrop`) or none. The member's choice is
// the layout document's `prefs.background` (rule "The layout follows the member"), an id or "none"; absent means the theme's
// default. Everything that reads the manifest or paints is in `backdrop.ts`, a lazy chunk; this file is in the lazy chunk
// too, and stays free of the DOM so the tests can run it.
import { rgba, type ThemeId } from './tokens';

/** The themes where a scene may show: Zen only (the owner, Nov 11; its id is still `dusk`). In Light and Dark a scene the member chose stays stored and shows nothing, and comes back with Zen. */
export const BACKGROUNDS_IN: ThemeId[] = ['dusk'];

/** The themes whose default, with nothing chosen, is the manifest's first scene. The rest default to none. */
export const DEFAULT_SCENE_IN: ThemeId[] = ['dusk'];

export const NONE = 'none';

/** The shape of an id, the same as a desk style's. */
export const BACKGROUND_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface Scene {
  id: string;
  name: string;
  widths: number[];
  formats: string[];
  /** The scene's average colour, `#rrggbb`: what paints before its placeholder, and what the contrast test measures over. */
  average: string;
  luminance: number;
  /** A tiny copy of the picture as a `data:` URL, painted at once and blurred. */
  placeholder: string;
}

/** The edge bands under the scrim (ADR 0094), as the manifest's `grade.edge_band` tunes them: an rgba colour and two fractions; `sides` 0 (the default) draws none at the sides. */
export interface EdgeBand {
  color: string;
  topBottom: number;
  sides: number;
}

export interface Manifest {
  version: number;
  scenes: Scene[];
  /** Null means the tokens' default (`surface.backdropBand`, 14 % and 12 %). */
  edgeBand: EdgeBand | null;
}

/** A band's reach as a fraction of the height or width, 0 (none) to a half. */
const fraction = (v: unknown): number | null => (typeof v === 'number' && v >= 0 && v <= 0.5 ? v : null);

/** `grade.edge_band`: `{ alpha, top_bottom, sides, color }`, the colour a `#rrggbb`, an `rgb()`/`rgba()` string (its alpha ignored for `alpha`) or `[r, g, b]`. Anything short of all four reads as none. */
export function parseEdgeBand(raw: unknown): EdgeBand | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as { alpha?: unknown; top_bottom?: unknown; sides?: unknown; color?: unknown };
  const alpha = typeof b.alpha === 'number' && b.alpha >= 0 && b.alpha <= 1 ? b.alpha : null;
  const topBottom = fraction(b.top_bottom);
  const sides = fraction(b.sides);
  let rgb: [number, number, number] | null = null;
  if (typeof b.color === 'string' && /^#[0-9a-f]{6}$/i.test(b.color)) {
    const n = parseInt(b.color.slice(1), 16);
    rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  } else if (typeof b.color === 'string' && /^rgba?\(/.test(b.color)) {
    const parts = b.color.slice(b.color.indexOf('(') + 1).split(/[\s,/)]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((c) => Number.isInteger(c) && c >= 0 && c <= 255)) rgb = [parts[0]!, parts[1]!, parts[2]!];
  } else if (Array.isArray(b.color) && b.color.length >= 3 && b.color.slice(0, 3).every((c) => typeof c === 'number' && c >= 0 && c <= 255)) {
    rgb = [b.color[0] as number, b.color[1] as number, b.color[2] as number];
  }
  if (alpha === null || topBottom === null || sides === null || !rgb) return null;
  return { color: rgba(rgb[0], rgb[1], rgb[2], alpha), topBottom, sides };
}

/** The widths a browser asking for less data (`saveData`, `prefers-reduced-data`) stops at. */
export const SAVE_DATA_MAX_WIDTH = 1920;

/** The `prefs.background` value as far as this build reads it: an id, "none", or nothing. Anything else reads as nothing. */
export function parseBackgroundPref(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw === NONE || BACKGROUND_ID.test(raw)) return raw;
  return undefined;
}

/** The theme's scene with nothing chosen: the manifest's first in `DEFAULT_SCENE_IN`, none elsewhere. */
export function defaultScene(theme: ThemeId, scenes: readonly Scene[]): Scene | null {
  return DEFAULT_SCENE_IN.includes(theme) ? (scenes[0] ?? null) : null;
}

/**
 * The scene to show for a preference in a theme: "none" shows none, a known id shows it, and anything else (nothing
 * chosen, or an id this manifest doesn't have, which stays stored as it came) shows the theme's default. A theme outside
 * `BACKGROUNDS_IN` shows none whatever was chosen.
 */
export function sceneFor(pref: string | undefined, theme: ThemeId, scenes: readonly Scene[]): Scene | null {
  if (!BACKGROUNDS_IN.includes(theme)) return null;
  if (pref === NONE) return null;
  if (pref !== undefined) {
    const found = scenes.find((s) => s.id === pref);
    if (found) return found;
  }
  return defaultScene(theme, scenes);
}

/** The manifest as fetched, or null if it isn't one this build can read. Scenes without what's needed are left out. */
export function parseManifest(raw: unknown): Manifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as { version?: unknown; scenes?: unknown; grade?: { edge_band?: unknown } };
  if (m.version !== 1 || !Array.isArray(m.scenes)) return null;
  const scenes: Scene[] = [];
  for (const s of m.scenes as Partial<Scene>[]) {
    if (!s || typeof s.id !== 'string' || !BACKGROUND_ID.test(s.id) || typeof s.name !== 'string') continue;
    if (!Array.isArray(s.widths) || !s.widths.every((w) => typeof w === 'number' && w > 0) || !s.widths.length) continue;
    if (!Array.isArray(s.formats) || !s.formats.every((f) => typeof f === 'string') || !s.formats.length) continue;
    if (typeof s.average !== 'string' || !/^#[0-9a-f]{6}$/i.test(s.average)) continue;
    if (typeof s.placeholder !== 'string' || !s.placeholder.startsWith('data:image/')) continue;
    scenes.push({ id: s.id, name: s.name, widths: [...s.widths].sort((a, b) => a - b), formats: s.formats, average: s.average, luminance: typeof s.luminance === 'number' ? s.luminance : 0, placeholder: s.placeholder });
  }
  return scenes.length ? { version: 1, scenes, edgeBand: parseEdgeBand(m.grade?.edge_band) } : null;
}

/** One file's URL: `<base>backgrounds/<id>/<width>.<format>`, `base` ending in a slash (`import.meta.env.BASE_URL`). */
export const sceneUrl = (base: string, scene: Scene, width: number, format: string): string => `${base}backgrounds/${scene.id}/${width}.${format}`;

/** The `srcset` for one format: every width the scene has, up to `maxWidth` (at least the smallest, so there's always one). */
export function srcsetFor(base: string, scene: Scene, format: string, maxWidth = Infinity): string {
  const widths = scene.widths.filter((w) => w <= maxWidth);
  const use = widths.length ? widths : scene.widths.slice(0, 1);
  return use.map((w) => `${sceneUrl(base, scene, w, format)} ${w}w`).join(', ');
}

/** The `<picture>`'s sources in order: every format but the last is a `<source type>`, the last is the `<img>`'s own. */
export function pictureSources(base: string, scene: Scene, maxWidth = Infinity): { type: string; srcset: string }[] {
  // AVIF first where the manifest has it, so a browser that decodes it takes the smaller file; WebP is every browser's.
  const order = [...scene.formats].sort((a, b) => Number(b === 'avif') - Number(a === 'avif'));
  return order.map((f) => ({ type: `image/${f}`, srcset: srcsetFor(base, scene, f, maxWidth) }));
}
