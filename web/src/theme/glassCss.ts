// The app tiles' glass (`GLASS_FACE`, the owner's pick C, Nov 16) for any element of the office's DOM: one recipe, the same
// dials as the canvas's (`canvas/glass.ts`), as static CSS. These are its custom properties, by theme (`--ma-glass-*` in
// themes.css, `themeCss.ts`, at build time); `styles/glass.css` is the class that wears them (`.ma-glass`) and its fallback.
// No `backdrop-filter` and no live blur: a body a little see-through, a light that hugs the rim, depth and lift.
//
// The body is the office blue's tile tint (the Browser's tile), the egg, at the glass's opacity raised so every ink keeps its
// floor over each ground a DOM element sits on here (`GLASS_GROUNDS`): the loader's and the office's world, a desk's panel.
// The office's chrome (its bars, notices, menus and popovers, the open tile's frame; `docs/sub-status/office-glass.md`) can sit
// over anything (an open tile's app, a window, the Browser's picture, a photo), so it wears the dense body (`bodyDense`): the
// same egg at the opacity where every ink keeps its floor over any ground at all, black to white, with the sheen and a pressed
// state on top. There's no frost in CSS, so what's behind shows sharp, if faintly: a desk's edge or a photo through a bar's pill
// reads as glass, but words or icons under a menu read as a ghost of them. So what holds words over the office's content (its
// menus, popovers and notices) wears the full body (`bodyFull`): the same egg, opaque, its glass the light on it.
//
// The theme sliders (ADR 0098) tune it at run time (release 6.11): `tune/glass.ts`, in their own chunk, works these out again from
// a setting's tokens and glass (`GlassSource`), and lays what changed as the same properties. At build time it's today's theme.
import { EGG, tileFill, type TileFill } from './tileFace.ts';
import { contrastRatio } from './oklab.ts';
import { opacityFor, overDesk } from './tileGlass.ts';
import { GLASS_ANY_GROUNDS, GLASS_FACE, glassRgba, THEMES, type GlassFace, type ShadowLayer, type ThemeId, type Tokens } from './tokens.ts';

export { GLASS_ANY_GROUNDS };

/** What the glass is worked out from: a theme's tokens, its dials, and its body's egg (the office blue's). Today's by default. */
export interface GlassSource {
  t: Tokens;
  g: GlassFace;
  egg: TileFill;
  /** The least the dense body may be (the theme sliders keep today's: never more see-through than 6.10's chrome). */
  denseAtLeast?: number;
}
const today = (id: ThemeId): GlassSource => ({ t: THEMES[id], g: GLASS_FACE[id], egg: tileFill(THEMES[id].accent.default, id) });

/** `#rrggbb` as `r, g, b`. */
const rgbOf = (hex: string): string => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ');

/** What a DOM element in glass sits on: the overlay's and the office's world, and a desk's panel. */
export const GLASS_GROUNDS = (id: ThemeId, t: Tokens = THEMES[id]): string[] => [t.surface.worldBase, t.surface.worldHi, t.surface.worldLo, t.surface.panel];

/** Text on DOM glass keeps 4.5:1 (every text ink), and an icon or a control's edge 3:1 (the glyph ink, the accent). */
export const glassDomInks = (id: ThemeId, t: Tokens = THEMES[id]): { ink: string; floor: number }[] => {
  return [
    ...[t.text.primary, t.text.secondary, t.text.tertiary, t.text.link, t.switcher.text].map((ink) => ({ ink, floor: 4.5 })),
    ...[t.glyph.default, t.accent.default].map((ink) => ({ ink, floor: 3 })),
  ];
};

/**
 * A glass control's states, as a wash of the theme's own text ink over the body (under the sheen): hovered, and pressed or on
 * (the shield on, a menu's button while its menu is open). Light darkens, as its solid chrome does; Zen and Dark lighten.
 */
export const GLASS_STATE: Record<ThemeId, { hover: number; press: number }> = {
  light: { hover: 0.05, press: 0.1 },
  dusk: { hover: 0.07, press: 0.13 },
  dark: { hover: 0.06, press: 0.11 },
};

/** `over` (`rgb`, at `a`) laid on the opaque `under`, in sRGB as the browser composites. */
const lay = (under: string, rgb: string, a: number): string =>
  overDesk(`#${rgb.split(',').map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`, under, a);

/** What a pressed control holds: its label (the primary text ink) at 4.5:1 and its icon at 3:1. */
const controlInks = (t: Tokens): { ink: string; floor: number }[] => [{ ink: t.text.primary, floor: 4.5 }, ...[t.text.primary, t.glyph.default, t.accent.default].map((ink) => ({ ink, floor: 3 }))];

/**
 * The dense body's opacity: the lowest from the glass's own up where every DOM ink keeps its floor over any ground, at the egg's
 * middle and rim, under the full sheen (its top left), and a control's inks under the pressed wash. Never under `glassBody`'s.
 */
export function glassBodyDense(id: ThemeId, src: GlassSource = today(id)): { centre: string; rim: string; alpha: number } {
  const b = glassBody(id, src);
  const holds = denseHolds(id, src);
  const least = Math.max(b.alpha, src.denseAtLeast ?? 0);
  const alpha = Math.max(least, ...[...GLASS_GROUNDS(id, src.t), ...GLASS_ANY_GROUNDS].flatMap((ground) => [b.centre, b.rim].map((at) => opacityFor(least, at, ground, holds))));
  return { centre: b.centre, rim: b.rim, alpha };
}

/** Whether a body as mixed keeps every DOM ink at its floor, under the sheen, and a control's inks pressed (the wash, then the sheen). */
function denseHolds(id: ThemeId, { t, g }: GlassSource): (mix: string) => boolean {
  const wash = rgbOf(t.text.primary);
  const keeps = (mix: string, inks: { ink: string; floor: number }[]): boolean =>
    [mix, lay(mix, g.spec, g.sheen)].every((top) => inks.every(({ ink, floor }) => contrastRatio(top, ink) >= floor));
  return (mix: string): boolean => keeps(mix, glassDomInks(id, t)) && keeps(lay(mix, wash, GLASS_STATE[id].press), controlInks(t));
}

/** Whether the opaque body (the full one, and the most any body rises to) keeps every ink at its floor, middle and rim. */
export const glassHolds = (id: ThemeId, src: GlassSource): boolean => [src.egg.centre, src.egg.rim].every(denseHolds(id, src));

/** The body's colours (the office blue's egg) and its opacity: the glass's own, or more where a ground would wash an ink out. */
export function glassBody(id: ThemeId, src: GlassSource = today(id)): { centre: string; rim: string; alpha: number } {
  const fill = src.egg;
  const inks = glassDomInks(id, src.t);
  const holds = (mix: string): boolean => inks.every(({ ink, floor }) => contrastRatio(mix, ink) >= floor);
  const alpha = Math.max(...GLASS_GROUNDS(id, src.t).map((ground) => opacityFor(src.g.opacity, fill.centre, ground, holds)));
  return { centre: fill.centre, rim: fill.rim, alpha };
}

/** The light comes from the top left, as on the canvas. */
const LIGHT = (-3 * Math.PI) / 4;
const lit = (a: number): number => Math.max(0, Math.cos(a - LIGHT));
const away = (a: number): number => Math.max(0, Math.cos(a - LIGHT - Math.PI));
/** The specular's alpha at angle `a` (the canvas's: 0 to the right, clockwise). */
export const specAlpha = (g: GlassFace, a: number): number => g.specFloor + (g.specPeak - g.specFloor) * lit(a) ** 6 + Math.max(0, g.specBack - g.specFloor) * away(a) ** 8;

const r4 = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 10000) / 10000;
/** A conic gradient round the middle, `alpha(a)` in `rgb`, in 36 steps; CSS's `from 90deg` starts where the canvas's 0 is. */
function conic(rgb: string, alpha: (a: number) => number): string {
  const n = 36;
  const stops: string[] = [];
  for (let i = 0; i <= n; i += 1) stops.push(`${glassRgba(rgb, r4(alpha((i / n) * 2 * Math.PI)))} ${Math.round((i / n) * 3600) / 10}deg`);
  return `conic-gradient(from 90deg, ${stops.join(', ')})`;
}

const px = (v: number): string => `${Math.round(v * 100) / 100}px`;
const shadow = (l: ShadowLayer): string => `${l.inset ? 'inset ' : ''}${px(l.dx ?? 0)} ${px(l.dy)} ${px(l.blur)} ${px(l.spread ?? 0)} ${l.color}`;

/**
 * Every `--ma-glass-*` property of a theme:
 *  - `body`: the egg (the tile's own shape: taller than wide, its middle a little above), at the body's opacity.
 *  - `sheen`: depth from light, a broad sheen down from the top left.
 *  - `spec`: the rim light, a conic gradient for a ring `specWidth` wide (brightest at the top left, a faint glint opposite).
 *  - `glow`: the soft light inside it, a share of the same, for a ring `glowWidth` wide.
 *  - `spec-width`, `glow-width`: those rings' widths.
 *  - `depth`: the thick edge away from the light, as inset shadows (a deepening at the foot and right, a hint all round).
 *  - `lift`: the contact shadow under a soft one.
 *  - `body-dense`: the body for the office's chrome, which can sit over anything (`glassBodyDense`).
 *  - `body-full`: the same egg, opaque: menus, popovers and notices, whose words would otherwise sit on a sharp ghost of what's
 *    behind them.
 *  - `hover`, `press`: a control's states, as colours (`GLASS_STATE`): an element in glass lays one over its body as
 *    `--ma-glass-state`, and a control inside one can take it as its own background.
 */
export function glassCssTokens(id: ThemeId, src: GlassSource = today(id)): Record<string, string> {
  const g = src.g;
  const body = glassBody(id, src);
  const depth = g.depthAlpha;
  const egg = (b: { centre: string; rim: string; alpha: number }): string =>
    `radial-gradient(ellipse ${EGG.rx * 100}% ${EGG.ry * 100}% at ${EGG.cx * 100}% ${EGG.cy * 100}%, ${glassRgba(rgbOf(b.centre), b.alpha)} ${EGG.flat * 100}%, ${glassRgba(rgbOf(b.rim), b.alpha)})`;
  const ink = rgbOf(src.t.text.primary);
  return {
    body: egg(body),
    bodyDense: egg(glassBodyDense(id, src)),
    bodyFull: egg({ ...body, alpha: 1 }),
    hover: glassRgba(ink, GLASS_STATE[id].hover),
    press: glassRgba(ink, GLASS_STATE[id].press),
    // The canvas's runs from the top left corner to (18 %, 62 %) of the box: on a square, 164 degrees, fading out by 52 %.
    sheen: `linear-gradient(164deg, ${glassRgba(g.spec, g.sheen)}, ${glassRgba(g.spec, 0)} 52%)`,
    spec: conic(g.spec, (a) => specAlpha(g, a)),
    glow: conic(g.spec, (a) => g.glow * specAlpha(g, a)),
    specWidth: px(g.specWidth),
    glowWidth: px(g.glowWidth),
    depth: [
      shadow({ dx: -1, dy: -1, blur: 3, spread: -1, color: glassRgba(g.depth, r4(depth)), inset: true }),
      shadow({ dy: 0, blur: 1.5, color: glassRgba(g.depth, r4(depth * 0.25)), inset: true }),
    ].join(', '),
    lift: g.lift.map(shadow).join(', '),
  };
}
