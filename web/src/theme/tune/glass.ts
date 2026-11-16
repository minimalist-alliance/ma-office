// The theme sliders on the office's glass (release 6.11; the owner, Nov 16: "Yes, do it"). In the sliders' chunk (`engine.ts`),
// beside the colour math: for one theme at a setting, the glass as the DOM recipe (`--ma-glass-*`, `glassCss.ts`) and the canvas
// (`GLASS_FACE`, `TILE_TINT`) draw it, as flat keys that `apply.ts` lays with the theme's tokens (`glass.*` as properties on
// <html>, `tile*` into the objects). Only what differs from today's glass; nothing at the default (`flatsFor` stops first).
//
// Blue moves the glass's cool greys the way it moves every other one: through xf.ts's own `tuneFlat` (chroma times s, hue and L
// kept, the hue-keeping 8-bit rounding that never lands warm), as pseudo-tokens. The DOM body's egg (the office blue's, centre
// and rim) goes in as two surfaces beside today's `surface.window`, so Contrast pulls it toward the window by xf's own pull; the
// rim light's and sheen's tint, the depth's tint and the lift's two tints go in as `mark.*`, a neutral group Contrast leaves be.
// On the canvas a tile's grey cast is `surface.tile`, laid already (`tileFill` follows it); each app's accent tint stays put.
//
// Contrast sets the light: low is calmer (a gentler rim light, glow and sheen, a shallower depth, a softer lift, the body nearer
// the window), high crisper (a stronger rim and depth, the body a step further out). The canvas tile's body follows Contrast's
// pull in lightness too (`TILE_TINT`'s centre and rim), keeping its accent's chroma share, so tiles and chrome stay one glass.
// The floors follow from the tuned inks and grounds: the body's opacity rises where it must (`glassBody`, `glassBodyDense`; on
// the canvas `glassOpacity`, `glassTextOpacity`), all on the laid tokens and this tuned face. Where even an opaque body would
// fall under a floor (in Zen at the top of Contrast, the lighter body and the whiter wash take a pressed control's blue under
// 3:1), the body's pull eases back toward today's, five points of Contrast at a time, until it holds; the light keeps the
// setting's. Tiles and chrome take the same pull, so they stay one glass.
import { glassBodyDense, glassCssTokens, glassHolds } from '../glassCss';
import { contrastRatio, oklab } from '../oklab';
import { fillOf } from '../tileFace';
import { GLASS_INK_FLOOR, GLASS_TEXT_FLOOR } from '../tileGlass';
import { AGENT_COLORS, APP_ACCENTS, APP_INKS, GLASS_FACE, TILE_TINT, type GlassFace, type ThemeId, type TileTint, type Tokens } from '../tokens';
import { pristine } from './apply';
import { tuneFlat, type Flat, type Tune } from './xf';

/** Contrast's multipliers at contrast 0 and 100 (1 at the default, 50), straight lines between. */
export const GLASS_CONTRAST = {
  /** The rim's light, the soft light inside it (a share of it) and the sheen: their alpha. */
  light: [0.65, 1.4],
  /** The depth inside the edge, away from the light: its alpha. */
  depth: [0.6, 1.5],
  /** The lift's two shadows: their alpha. */
  lift: [0.75, 1.25],
  /** A surface's distance from `surface.window` in L: xf.ts's `CONTRAST_G`, for the canvas tile's body (pinned by a test). */
  surface: [0.55, 1.7],
} as const;

/** One of `GLASS_CONTRAST`'s at k = contrast / 100. */
export const contrastAt = ([lo, hi]: readonly [number, number], k: number): number => (k <= 0.5 ? lo + (1 - lo) * (k / 0.5) : 1 + (hi - 1) * ((k - 0.5) / 0.5));

const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const hexOf = (rgb: string): string => `#${rgb.split(',').map((v) => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
const rgbOf = (hex: string): string => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ');
/** `rgba(r, g, b, a)` with its alpha times `k`, as tokens.ts spells one. */
const timesAlpha = (rgba: string, k: number): string => rgba.replace(/,\s*([\d.]+)\)$/, (_, a: string) => `, ${Math.round(Math.min(1, Number(a) * k) * 1000) / 1000})`);

/** A flat's keys as token groups, for `glassCssTokens` (it reads a few surfaces and inks). */
function tokensOf(flat: Flat): Tokens {
  const t: Record<string, Record<string, string>> = {};
  for (const [k, v] of Object.entries(flat)) {
    const [group = '', key = ''] = k.split('.');
    (t[group] ??= {})[key] = v;
  }
  return t as unknown as Tokens;
}

/** The canvas's glass from a flat's `tile*` keys (today's, from `pristine`): its dials and its body's lightness. */
function canvasOf(flat: Flat, id: ThemeId): { g: GlassFace; tint: TileTint } {
  const shape = GLASS_FACE[id] as unknown as Record<string, unknown>;
  const g: Record<string, unknown> = { ...shape };
  const tint: Record<string, unknown> = { ...TILE_TINT[id] };
  for (const [k, v] of Object.entries(flat)) {
    const [group = '', key = ''] = k.split('.');
    if (group === 'tileGlass' && key in g) g[key] = typeof shape[key] === 'number' ? Number(v) : v;
    if (group === 'tileTint' && key in tint) tint[key] = Number(v);
  }
  const lift = (GLASS_FACE[id].lift).map((l, i) => ({ ...l, color: flat[i ? 'tileLiftSoft.color' : 'tileLiftContact.color'] ?? l.color }));
  return { g: { ...(g as unknown as GlassFace), lift }, tint: tint as unknown as TileTint };
}

/** The `tile*` keys of a canvas glass (`apply.ts` writes them into `GLASS_FACE` and `TILE_TINT`). */
function canvasKeys(g: GlassFace, tint: TileTint): Flat {
  const out: Flat = {};
  for (const k of ['spec', 'depth', 'specPeak', 'specBack', 'specFloor', 'sheen', 'depthAlpha'] as const) out[`tileGlass.${k}`] = String(g[k]);
  out['tileLiftContact.color'] = g.lift[0]!.color;
  out['tileLiftSoft.color'] = g.lift[1]!.color;
  out['tileTint.centre'] = String(tint.centre);
  out['tileTint.rim'] = String(tint.rim);
  return out;
}

/** Everything about one theme's glass, as flat keys: the DOM recipe's (`glass.*`) and the canvas's (`tile*`). */
function glassKeys(id: ThemeId, t: Tokens, g: GlassFace, tint: TileTint, egg: { centre: string; rim: string }, denseAtLeast?: number): Flat {
  const out: Flat = {};
  for (const [k, v] of Object.entries(glassCssTokens(id, { t, g, egg, denseAtLeast }))) out[`glass.${k}`] = v;
  return { ...out, ...canvasKeys(g, tint) };
}

const todaysDense = new Map<ThemeId, number>();
/**
 * Today's dense body's opacity (the chrome's: 0.97, 0.98, 0.96): a setting never makes it more see-through, so stronger inks
 * at the top of Contrast leave the bars as they were, and softer ones at the foot raise it as far as their floors need.
 */
function denseToday(id: ThemeId): number {
  let hit = todaysDense.get(id);
  if (hit === undefined) {
    const base = pristine(id);
    const { g, tint } = canvasOf(base, id);
    hit = glassBodyDense(id, { t: tokensOf(base), g, egg: fillOf(base['accent.default']!, base['surface.tile']!, tint) }).alpha;
    todaysDense.set(id, hit);
  }
  return hit;
}

const today = new Map<ThemeId, Flat>();
/** Today's glass, as `glassFor` would spell it (themes.css's values: `glass.test.ts` checks). */
export function todaysGlass(id: ThemeId): Flat {
  let hit = today.get(id);
  if (!hit) {
    const base = pristine(id);
    const { g, tint } = canvasOf(base, id);
    hit = glassKeys(id, tokensOf(base), g, tint, fillOf(base['accent.default']!, base['surface.tile']!, tint));
    today.set(id, hit);
  }
  return hit;
}

/**
 * One theme's glass at a setting, all of it (`glassFor` keeps only what changed): `tuned` is the theme's tokens through the
 * sliders (`tuneFlat(pristine(id), tune).out`). Also what the tests read.
 */
export function tunedGlass(id: ThemeId, tune: Tune, tuned: Flat): { keys: Flat; g: GlassFace; tint: TileTint; egg: { centre: string; rim: string }; t: Tokens; denseAtLeast: number } {
  const base = pristine(id);
  const k = tune.contrast / 100;
  const { g: g0, tint: tint0 } = canvasOf(base, id);
  const egg0 = fillOf(base['accent.default']!, base['surface.tile']!, tint0);
  // Blue (and Contrast's pull on the body) through xf.ts itself.
  const p = tuneFlat(
    {
      'surface.window': base['surface.window']!,
      'surface.glassCentre': egg0.centre,
      'surface.glassRim': egg0.rim,
      'mark.glassSpec': hexOf(g0.spec),
      'mark.glassDepth': hexOf(g0.depth),
      'mark.glassLiftContact': g0.lift[0]!.color,
      'mark.glassLiftSoft': g0.lift[1]!.color,
    },
    tune,
  ).out;
  const light = contrastAt(GLASS_CONTRAST.light, k);
  const depth = contrastAt(GLASS_CONTRAST.depth, k);
  const lift = contrastAt(GLASS_CONTRAST.lift, k);
  const g: GlassFace = {
    ...g0,
    spec: rgbOf(p['mark.glassSpec']!),
    depth: rgbOf(p['mark.glassDepth']!),
    specPeak: r4(Math.min(1, g0.specPeak * light)),
    specBack: r4(Math.min(1, g0.specBack * light)),
    specFloor: r4(Math.min(1, g0.specFloor * light)),
    sheen: r4(Math.min(1, g0.sheen * light)),
    depthAlpha: r4(Math.min(1, g0.depthAlpha * depth)),
    lift: [
      { ...g0.lift[0]!, color: timesAlpha(p['mark.glassLiftContact']!, lift) },
      { ...g0.lift[1]!, color: timesAlpha(p['mark.glassLiftSoft']!, lift) },
    ],
  };
  const t = tokensOf(tuned);
  // The body, DOM and canvas: Contrast's pull, eased back toward today's only as far as the floors need.
  const Lw = oklab(base['surface.window']!)[0];
  const bodyAt = (c: number): { egg: { centre: string; rim: string }; tint: TileTint } => {
    const e = c === tune.contrast ? p : tuneFlat({ 'surface.window': base['surface.window']!, 'surface.glassCentre': egg0.centre, 'surface.glassRim': egg0.rim }, { blue: tune.blue, contrast: c }).out;
    const pull = contrastAt(GLASS_CONTRAST.surface, c / 100);
    return {
      egg: { centre: e['surface.glassCentre']!, rim: e['surface.glassRim']! },
      // The canvas tile's lightness, pulled as a surface is (its accent's chroma share is `tileFill`'s, as ever).
      tint: c === 50 ? tint0 : { ...tint0, centre: r4(Lw + (tint0.centre - Lw) * pull), rim: r4(Lw + (tint0.rim - Lw) * pull) },
    };
  };
  let body = bodyAt(tune.contrast);
  for (const c of easedBack(tune.contrast)) {
    body = bodyAt(c);
    if (glassHolds(id, { t, g, egg: body.egg }) && tileHolds(id, t, tuned['surface.tile']!, body.tint)) break;
  }
  const denseAtLeast = denseToday(id);
  return { keys: glassKeys(id, t, g, body.tint, body.egg, denseAtLeast), g, tint: body.tint, egg: body.egg, t, denseAtLeast };
}

/** The setting's Contrast, then five points at a time toward the default and on past it. */
function easedBack(c: number): number[] {
  const out = [c];
  const dir = c > 50 ? -5 : 5;
  for (let v = c + dir; v >= 0 && v <= 100; v += dir) out.push(v);
  return out;
}

/** Whether an opaque canvas tile keeps every icon at 3:1 (with the glass's margin) on every app's tint, and a card its words. */
function tileHolds(id: ThemeId, t: Tokens, tile: string, tint: TileTint): boolean {
  const inks = [...Object.values(APP_ACCENTS).map((a) => a[id]), ...Object.values(APP_INKS).map((i) => i[id].accent), t.accent.default, t.glyph.default];
  const owners: (string | null)[] = [...inks, ...Object.values(AGENT_COLORS).map((c) => c[id]), null];
  const card = fillOf(t.accent.default, tile, tint).centre;
  return (
    owners.every((own) => {
      const body = fillOf(own, tile, tint).centre;
      return [...inks, ...(own ? [own] : [])].every((ink) => contrastRatio(body, ink) >= GLASS_INK_FLOOR);
    }) && [t.text.primary, t.text.secondary, t.text.tertiary].every((ink) => contrastRatio(card, ink) >= GLASS_TEXT_FLOOR)
  );
}

/** What `apply.ts` lays for one theme's glass at a setting: only what differs from today's. */
export function glassFor(id: ThemeId, tune: Tune, tuned: Flat): Flat {
  const was = todaysGlass(id);
  const out: Flat = {};
  for (const [k, v] of Object.entries(tunedGlass(id, tune, tuned).keys)) if (was[k] !== v) out[k] = v;
  return out;
}
