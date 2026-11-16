// An icon tile's fill (the APP-TILES row, the owner, Nov 15): its app's accent's hue at a calm share of its chroma, as a very
// subtle egg-shaped gradient, lightest where the icon sits. The values are `TILE_TINT` (tokens.ts); the bevel and lift are
// `TILE_FACE`. Drawn on the canvas by `canvas/sprites.ts` `tileSprite`, and in the DOM by the Agent app's `AgentMark`.
import { fromOklab, inGamut, oklab, oklch } from './oklab.ts';
import { glassRgba, THEMES, TILE_FACE, TILE_TINT, type ShadowLayer, type ThemeId, type TileTint } from './tokens.ts';

/** The egg's middle and its rim. */
export interface TileFill {
  centre: string;
  rim: string;
}

const fills = new Map<string, TileFill>();
/** Where brown lives, as an OKLCH hue: between Courier's coral (34°) and Notebook's amber (79°). */
const WARM = (65 * Math.PI) / 180;

/**
 * The fill of a tile whose app's accent is `accent` (null: no accent, as an asleep agent's: the tile's own colour). It follows
 * what the theme sliders lay (ADR 0098, release 6.11): the grey cast is `surface.tile`'s and the egg's lightness `TILE_TINT`'s,
 * as laid now, so the cache is keyed by them too.
 */
export function tileFill(accent: string | null, theme: ThemeId): TileFill {
  const k = TILE_TINT[theme];
  const tile = THEMES[theme].surface.tile;
  const key = `${theme}:${accent ?? ''}:${tile}:${k.centre}:${k.rim}`;
  const hit = fills.get(key);
  if (hit) return hit;
  const fill = fillOf(accent, tile, k);
  fills.set(key, fill);
  return fill;
}

/** `tileFill`'s egg from the values given (the theme sliders' chunk works out a setting's before it's laid). */
export function fillOf(accent: string | null, tile: string, k: TileTint): TileFill {
  const [, ta, tb] = oklab(tile);
  let a = ta;
  let b = tb;
  if (accent) {
    const [, ac, ah] = oklch(accent);
    // Brown is a warm hue gone dark: in Zen and Dark an orange-to-amber accent (OKLCH hue about 65°) tints the least.
    const c = Math.min(ac * k.share, k.max) * (1 - k.warm * Math.max(0, Math.cos(ah - WARM)));
    a = ta * k.cast + c * Math.cos(ah);
    b = tb * k.cast + c * Math.sin(ah);
  }
  // Near white there's little room for colour: where the centre would fall outside sRGB its chroma comes down at the same hue
  // (clipping each channel instead turns a blue aqua, the brand review's find). The rim takes the centre's colour, a step
  // darker, so it's never the more colourful: a fall-off, never a rim of colour.
  for (let i = 0; i < 24 && !inGamut([k.centre, a, b]); i++) {
    a *= 0.9;
    b *= 0.9;
  }
  return { centre: fromOklab([k.centre, a, b]), rim: fromOklab([k.rim, a, b]) };
}

/**
 * The egg on a box `w` by `h`: an ellipse a little taller than wide, its middle a little above the box's, so the light sits
 * where the icon is. Shared by the canvas (`createRadialGradient` under a scale) and CSS (`radial-gradient`).
 */
export const EGG = { cx: 0.5, cy: 0.44, rx: 0.68, ry: 0.76, flat: 0.32 } as const;

/** The egg as a CSS background, for a DOM tile; at `alpha`, a see-through one (a DOM tile in glass). */
export const eggCss = (f: TileFill, alpha = 1): string => {
  const at = (hex: string): string => (alpha >= 1 ? hex : glassRgba([1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', '), alpha));
  return `radial-gradient(ellipse ${EGG.rx * 100}% ${EGG.ry * 100}% at ${EGG.cx * 100}% ${EGG.cy * 100}%, ${at(f.centre)} ${EGG.flat * 100}%, ${at(f.rim)})`;
};

/** How wide the bevel is on a tile `w` wide: about 1.45 px on an icon's 76, never under 1 or over 2.2 (a step slighter since 6.6's first cut). */
export const bevelWidth = (w: number): number => Math.min(2.2, Math.max(1, w * 0.019));

const css = (l: ShadowLayer): string => `${l.inset ? 'inset ' : ''}${l.dx ?? 0}px ${l.dy}px ${l.blur}px ${l.spread ?? 0}px ${l.color}`;

/**
 * The bevel and lift as a CSS box-shadow, for a DOM tile `size` px wide (an agent's mark): the lit top edge, a third of it down
 * the left, the shaded foot, then the lift (scaled down under 40 px, where a full one would smudge).
 */
export function tileShadowCss(theme: ThemeId, size: number): string {
  const f = TILE_FACE[theme];
  const b = Math.round(bevelWidth(size) * 2) / 2;
  const k = Math.min(1, size / 40);
  const lift = f.lift.map((l) => ({ ...l, dy: Math.max(0.5, Math.round(l.dy * k * 2) / 2), blur: Math.max(1, Math.round(l.blur * k)) }));
  return [`inset 0 ${b}px 0 ${f.lit}`, `inset ${b / 2}px 0 0 ${third(f.lit)}`, `inset 0 -${b}px 0 ${f.shade}`, ...lift.map(css)].join(', ');
}

/** `rgba(…, a)` at a third of its alpha: the left edge's share of the light, as the window lift's. */
function third(rgba: string): string {
  return rgba.replace(/,\s*([\d.]+)\)$/, (_, a: string) => `, ${Math.round((Number(a) / 3) * 1000) / 1000})`);
}

/** `rgba(…, a)` with no alpha: a gradient's stop that fades a colour out without passing through grey. */
export const clear = (rgba: string): string => rgba.replace(/,\s*[\d.]+\)$/, ', 0)');
