// Whether an icon's tile wears the glass (`GLASS_FACE` in tokens.ts, the owner's pick, Nov 16: "I want C restrained for the app
// tiles"), and how opaque its body must be to keep every icon at 3:1. Always, except under reduced transparency or more contrast,
// where the tile is the solid face (`TILE_FACE`), exactly as release 6.6 drew it. Nothing here moves, so reduced motion has nothing
// to stop.
import { moreContrast } from '../lib/util.ts';
import { contrastRatio } from './oklab.ts';
import { APP_ACCENTS, APP_INKS, GLASS_FACE, THEMES, type GlassFace, type ThemeId } from './tokens.ts';

const transparencyQuery = typeof window === 'undefined' || !window.matchMedia ? null : window.matchMedia('(prefers-reduced-transparency: reduce)');
/** Cheap enough to read in a draw. */
export const reducedTransparency = (): boolean => transparencyQuery?.matches ?? false;

export function onTransparencyChange(fn: () => void): () => void {
  transparencyQuery?.addEventListener('change', fn);
  return () => transparencyQuery?.removeEventListener('change', fn);
}

/** Whether icons' tiles are glass now: not under reduced transparency or more contrast. */
export const glassOn = (): boolean => !reducedTransparency() && !moreContrast();

/** The glass to draw in `theme` now, or null for the solid tile. */
export const glassFace = (theme: ThemeId): GlassFace | null => (glassOn() ? GLASS_FACE[theme] : null);

/**
 * The inks every icon's tile may carry in this theme: each app's accent, the inks of Files and the Bible, the office blue, the glyph.
 * Kept per token object, which the theme sliders replace whenever they lay a colour (the glyph's ink is a grey they move).
 */
const inks = new WeakMap<object, string[]>();
export function tileInks(theme: ThemeId): string[] {
  const t = THEMES[theme];
  let hit = inks.get(t);
  if (!hit) {
    hit = [...Object.values(APP_ACCENTS).map((a) => a[theme]), ...Object.values(APP_INKS).map((i) => i[theme].accent), t.accent.default, t.glyph.default];
    inks.set(t, hit);
  }
  return hit;
}

/** The 3:1 floor for an icon, with a margin for the sheen and the frost (the wood under the glass isn't one flat colour). */
export const GLASS_INK_FLOOR = 3.12;

const hex2 = (v: number): string => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
const rgb = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** The body (`#rrggbb`) at `a` over the desk's colour, as the canvas mixes them (in sRGB). */
export const overDesk = (body: string, desk: string, a: number): string => {
  const b = rgb(body);
  const d = rgb(desk);
  return `#${b.map((v, i) => hex2(v * a + d[i]! * (1 - a))).join('')}`;
};

/** A widget's words on its card (the canvas's `ItemTile`): 4.5:1, with the same margin as the icons' for the frost and the grain. */
export const GLASS_TEXT_FLOOR = 4.62;

const wordOpacities = new Map<string, number>();
/**
 * How opaque a widget's card in glass must be over a desk of colour `desk` (the office, Nov 16: the rest of the office in the
 * tiles' glass): every text ink at 4.5:1 (`GLASS_TEXT_FLOOR`) and every icon ink at 3:1 (its head's glyph), from the glass's own
 * opacity up to solid.
 */
export function glassTextOpacity(g: GlassFace, body: string, desk: string, theme: ThemeId): number {
  const t = THEMES[theme];
  const words = [t.text.primary, t.text.secondary, t.text.tertiary];
  const key = `${g.opacity}|${body}|${desk}|${theme}|${words}|${t.glyph.default}`;
  const hit = wordOpacities.get(key);
  if (hit !== undefined) return hit;
  const a = opacityFor(g.opacity, body, desk, (mix) => words.every((ink) => contrastRatio(mix, ink) >= GLASS_TEXT_FLOOR) && tileInks(theme).every((ink) => contrastRatio(mix, ink) >= GLASS_INK_FLOOR));
  wordOpacities.set(key, a);
  return a;
}

/**
 * The least opacity, from `start` up in steps of 0.01, at which the body over `ground` passes `holds` (its colour as mixed); 1,
 * the body solid, where none under it does.
 */
export function opacityFor(start: number, body: string, ground: string, holds: (mix: string) => boolean): number {
  for (let a = start; a < 1; a = Math.round((a + 0.01) * 100) / 100) if (holds(overDesk(body, ground, a))) return a;
  return 1;
}

const opacities = new Map<string, number>();
/**
 * How opaque the glass's body must be over a desk of colour `desk` so every icon ink keeps 3:1 on it (`GLASS_INK_FLOOR`): at least
 * the theme's own `opacity`, more where the desk behind would wash the icons out (a light wood under a Dark tile, Walnut under a
 * Light one), up to solid. `own` is the tile's own accent when it isn't one of `tileInks` (an agent's colour). The canvas mixes in
 * sRGB, so this does too.
 */
export function glassOpacity(g: GlassFace, body: string, desk: string, theme: ThemeId, own: string | null = null): number {
  const key = `${g.opacity}|${body}|${desk}|${theme}|${own ?? ''}|${THEMES[theme].glyph.default}`;
  const hit = opacities.get(key);
  if (hit !== undefined) return hit;
  const all = own ? [...tileInks(theme), own] : tileInks(theme);
  const a = opacityFor(g.opacity, body, desk, (mix) => all.every((ink) => contrastRatio(mix, ink) >= GLASS_INK_FLOOR));
  opacities.set(key, a);
  return a;
}
