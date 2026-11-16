// The theme sliders on the office's glass (`glass.ts`, release 6.11; the owner, Nov 16: "Yes, do it"). At the default nothing
// changes; at the corners (0/0, 0/100, 100/0, 100/100) in every theme the glass's greys follow Blue the way every other grey
// does and never land warm, Contrast calms or sharpens the light within C's own, and every ink keeps its floor on the glass as
// it's drawn: text 4.5:1 and icons 3:1 on the DOM's bodies over their grounds (the dense one over any ground at all, under the
// sheen and pressed; the full one opaque), and on the canvas's tiles and widgets' cards over every desk style and in hand.
import { beforeAll, describe, expect, it } from 'vitest';
import { GLASS_ANY_GROUNDS, glassBody, glassBodyDense, glassCssTokens, glassDomInks, GLASS_GROUNDS, GLASS_STATE } from '../glassCss';
import { contrastRatio, oklch } from '../oklab';
import { deskLook, deskStyles } from '../deskStyles';
import { THEME_IDS, type ThemeId, type Tokens } from '../tokens';
import type * as Tokens_ from '../tokens';
import type * as Apply from './apply';
import type * as Glass from './glass';
import type * as TileFace from '../tileFace';
import type * as TileGlass from '../tileGlass';
import { tuneFlat, type Tune } from './xf';

// A <html> with only what apply.ts touches: its inline style.
const props = new Map<string, string>();
const style = {
  setProperty: (k: string, v: string) => void props.set(k, v),
  removeProperty: (k: string) => void props.delete(k),
  getPropertyValue: (k: string) => props.get(k) ?? '',
};
let apply: typeof Apply;
let glass: typeof Glass;
let tokens: typeof Tokens_;
let face: typeof TileFace;
let tileGlass: typeof TileGlass;

beforeAll(async () => {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { style } };
  tokens = await import('../tokens');
  apply = await import('./apply');
  glass = await import('./glass');
  face = await import('../tileFace');
  tileGlass = await import('../tileGlass');
});

const CORNERS: Tune[] = [
  { blue: 0, contrast: 0 },
  { blue: 0, contrast: 100 },
  { blue: 100, contrast: 0 },
  { blue: 100, contrast: 100 },
];
const name = (t: Tune): string => `${t.blue}/${t.contrast}`;
/** The setting's tokens and glass for one theme, from the same functions the chunk runs. */
const tuned = (id: ThemeId, t: Tune): ReturnType<typeof Glass.tunedGlass> => glass.tunedGlass(id, t, tuneFlat(apply.pristine(id), t).out);
/** What a setting lays, every theme (the chunk's `flatsFor`, without its imports of the session and the network). */
const flats = (t: Tune): Partial<Record<ThemeId, Record<string, string>>> => {
  const out: Partial<Record<ThemeId, Record<string, string>>> = {};
  for (const id of THEME_IDS) {
    const base = apply.pristine(id);
    const out1 = tuneFlat(base, t).out;
    const d: Record<string, string> = {};
    for (const [k, v] of Object.entries(out1)) if (base[k] !== v) d[k] = v;
    out[id] = { ...d, ...glass.glassFor(id, t, out1) };
  }
  return out;
};

const hex = (rgb: string): string => `#${rgb.split(',').map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
const solid = (rgba: string): string => hex(rgba.replace(/^rgba?\(|\)$/g, '').split(',').slice(0, 3).join(','));
/** The no-warm rule (xf.ts's): any colour with chroma over 0.004 has its OKLCH hue in 230..275. */
const cool = (c: string): boolean => {
  const [, C, h] = oklch(c);
  const deg = ((h * 180) / Math.PI + 360) % 360;
  return C <= 0.004 || (deg >= 230 && deg <= 275);
};
/** Every grey from black to white and the primaries: anything at all behind the office's chrome. */
const ANYTHING = [...Array.from({ length: 18 }, (_, i) => `#${Math.min(255, i * 15).toString(16).padStart(2, '0').repeat(3)}`), '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#00FFFF', '#FF00FF', ...GLASS_ANY_GROUNDS];

describe('today', () => {
  for (const id of THEME_IDS) {
    it(`today's glass is themes.css's, and the default lays nothing (${id})`, () => {
      const today = glass.todaysGlass(id);
      for (const [k, v] of Object.entries(glassCssTokens(id))) expect(today[`glass.${k}`], k).toBe(v);
      expect(glass.glassFor(id, { blue: 100, contrast: 50 }, apply.pristine(id))).toEqual({});
      const t = tuned(id, { blue: 100, contrast: 50 });
      expect(t.g).toEqual(tokens.GLASS_FACE[id]);
      expect(t.tint).toEqual(tokens.TILE_TINT[id]);
    });
  }

  it("the canvas tile's pull is xf.ts's own (CONTRAST_G), and the light's multipliers are modest", () => {
    // A grey surface far from the window, through xf.ts: its distance from the window in L, times the pull.
    for (const k of [0, 25, 75, 100]) {
      const flat = { 'surface.window': '#FFFFFF', 'surface.probe': '#6A6A6A' };
      const out = tuneFlat(flat, { blue: 100, contrast: k }).out;
      const L = (c: string): number => oklch(c)[0];
      const pull = (L(out['surface.probe']!) - 1) / (L('#6A6A6A') - 1);
      expect(pull, `contrast ${k}`).toBeCloseTo(glass.contrastAt(glass.GLASS_CONTRAST.surface, k / 100), 2);
    }
    for (const [lo, hi] of [glass.GLASS_CONTRAST.light, glass.GLASS_CONTRAST.depth, glass.GLASS_CONTRAST.lift]) {
      expect(lo).toBeGreaterThanOrEqual(0.6);
      expect(hi).toBeLessThanOrEqual(1.5);
    }
    expect(glass.contrastAt([0.6, 1.5], 0.5)).toBe(1);
  });
});

describe('at the corners', () => {
  for (const id of THEME_IDS) {
    for (const tune of CORNERS) {
      it(`Blue moves the glass's greys and never warm, Contrast its light (${id}, ${name(tune)})`, () => {
        const t0 = tuned(id, { blue: 100, contrast: 50 });
        const t = tuned(id, tune);
        // Every tuned glass colour is cool or an exact grey.
        const colours = [t.egg.centre, t.egg.rim, hex(t.g.spec), hex(t.g.depth), ...t.g.lift.map((l) => solid(l.color))];
        for (const c of colours) expect(cool(c), `${c}`).toBe(true);
        for (const v of Object.values(t.keys)) for (const m of v.matchAll(/rgba\((\d+), (\d+), (\d+)/g)) expect(cool(hex(`${m[1]},${m[2]},${m[3]}`)), v.slice(0, 60)).toBe(true);
        // Blue 0: the greys at chroma 0 (the rounding keeps them exact greys).
        if (tune.blue === 0) for (const c of colours) expect(oklch(c)[1], c).toBeLessThanOrEqual(0.004);
        // Blue 100: the tints as today's (Contrast moves the light's alpha, never its colour).
        if (tune.blue === 100) {
          expect([t.g.spec, t.g.depth]).toEqual([t0.g.spec, t0.g.depth]);
          expect(t.g.lift.map((l) => solid(l.color))).toEqual(t0.g.lift.map((l) => solid(l.color)));
        }
        // Contrast: calmer light at 0, crisper at 100.
        const calmer = tune.contrast < 50;
        for (const k of ['specPeak', 'specBack', 'specFloor', 'sheen', 'depthAlpha'] as const) {
          if (t0.g[k] === 0) continue;
          if (calmer) expect(t.g[k], k).toBeLessThan(t0.g[k]);
          else expect(t.g[k], k).toBeGreaterThan(t0.g[k]);
        }
        const alpha = (c: string): number => Number(/,\s*([\d.]+)\)$/.exec(c)![1]);
        if (calmer) expect(alpha(t.g.lift[1]!.color)).toBeLessThan(alpha(t0.g.lift[1]!.color));
        else expect(alpha(t.g.lift[1]!.color)).toBeGreaterThan(alpha(t0.g.lift[1]!.color));
        // The body: nearer the window when calmer; when crisper, further, as far as the floors allow (Zen's stays put).
        const Lw = oklch(apply.pristine(id)['surface.window']!)[0];
        const far = (L: number): number => Math.abs(L - Lw);
        if (calmer) expect(far(t.tint.centre)).toBeLessThan(far(t0.tint.centre));
        else expect(far(t.tint.centre)).toBeGreaterThanOrEqual(far(t0.tint.centre));
        if (!calmer && id === 'dark') expect(far(t.tint.centre)).toBeGreaterThan(far(t0.tint.centre) + 0.01);
        // Only what changed is laid, and every key is one apply.ts knows.
        const laid = glass.glassFor(id, tune, tuneFlat(apply.pristine(id), tune).out);
        expect(Object.keys(laid).length).toBeGreaterThan(0);
        for (const k of Object.keys(laid)) expect(k).toMatch(/^(glass|tileGlass|tileLiftContact|tileLiftSoft|tileTint)\./);
      });

      it(`the DOM glass keeps text at 4.5:1 and icons at 3:1 (${id}, ${name(tune)})`, () => {
        const t = tuned(id, tune);
        const src = { t: t.t, g: t.g, egg: t.egg, denseAtLeast: t.denseAtLeast };
        const inks = glassDomInks(id, t.t);
        const sheen = (mix: string): string => overHex(hex(t.g.spec), mix, t.g.sheen);
        const top = (mix: string): string[] => [mix, sheen(mix)];
        // C's own body over its grounds.
        const b = glassBody(id, src);
        for (const ground of GLASS_GROUNDS(id, t.t)) for (const at of [b.centre, b.rim]) {
          const mix = tileGlass.overDesk(at, ground, b.alpha);
          for (const { ink, floor } of inks) expect(contrastRatio(mix, ink), `${ink} on ${mix}`).toBeGreaterThanOrEqual(floor);
        }
        // The dense body over anything, under the sheen, and a control pressed; and the full body, opaque.
        const d = glassBodyDense(id, src);
        const wash = hex(t.t.text.primary.slice(1).match(/../g)!.map((h) => parseInt(h, 16)).join(','));
        for (const [alpha, grounds] of [[d.alpha, [...ANYTHING, ...GLASS_GROUNDS(id, t.t)]], [1, ['#000000']]] as [number, string[]][]) {
          for (const ground of grounds) for (const at of [d.centre, d.rim]) {
            const mix = tileGlass.overDesk(at, ground, alpha);
            for (const surface of top(mix)) for (const { ink, floor } of inks) expect(contrastRatio(surface, ink), `${ink} on ${surface} over ${ground} at ${alpha}`).toBeGreaterThanOrEqual(floor);
            // Pressed: the wash over the body, the sheen over both (the recipe's layers, top first: sheen, state, fill).
            for (const pressed of top(tileGlass.overDesk(wash, mix, GLASS_STATE[id].press))) {
              expect(contrastRatio(pressed, t.t.text.primary), `a pressed label on ${pressed}`).toBeGreaterThanOrEqual(4.5);
              for (const ink of [t.t.glyph.default, t.t.accent.default]) expect(contrastRatio(pressed, ink), `a pressed ${ink} on ${pressed} over ${ground}`).toBeGreaterThanOrEqual(3);
            }
          }
        }
        expect(d.alpha).toBeLessThanOrEqual(1);
        // Never more see-through than today's chrome.
        expect(d.alpha).toBeGreaterThanOrEqual(glassBodyDense(id).alpha);
      });

      it(`the canvas's tiles and cards keep icons at 3:1 and words at 4.5:1 over every desk (${id}, ${name(tune)})`, () => {
        apply.layFlats(flats(tune), id);
        try {
          const T: Tokens = tokens.THEMES[id];
          const g = tokens.GLASS_FACE[id];
          const grounds = [...deskStyles().map((s) => [s.id, deskLook(s.id, id, false).base] as const), ['in hand', T.surface.panel] as const];
          const accents: (string | null)[] = [...Object.values(tokens.APP_ACCENTS).map((a) => a[id]), T.accent.default, ...Object.values(tokens.APP_INKS).map((i) => i[id].accent), ...Object.values(tokens.AGENT_COLORS).map((c) => c[id]), null];
          for (const [style, ground] of grounds) {
            for (const accent of accents) {
              const fill = face.tileFill(accent, id);
              const a = tileGlass.glassOpacity(g, fill.centre, ground, id, accent);
              const mix = tileGlass.overDesk(fill.centre, ground, a);
              for (const ink of [...tileGlass.tileInks(id), ...(accent ? [accent] : [])]) expect(contrastRatio(mix, ink), `${ink} on ${accent} over ${style} at ${a}`).toBeGreaterThanOrEqual(3);
            }
            const card = face.tileFill(T.accent.default, id).centre;
            const a = tileGlass.glassTextOpacity(g, card, ground, id);
            const mix = tileGlass.overDesk(card, ground, a);
            for (const ink of [T.text.primary, T.text.secondary, T.text.tertiary]) expect(contrastRatio(mix, ink), `${ink} on a card over ${style}`).toBeGreaterThanOrEqual(4.5);
            for (const ink of tileGlass.tileInks(id)) expect(contrastRatio(mix, ink)).toBeGreaterThanOrEqual(3);
          }
          // The tiles' grey cast is the laid `surface.tile`'s, and the canvas's glass is the tuned one.
          expect(face.tileFill(null, id)).toEqual(face.fillOf(null, T.surface.tile, tokens.TILE_TINT[id]));
          expect(g.spec).toBe(tuned(id, tune).g.spec);
          expect(tokens.TILE_TINT[id].centre).toBe(tuned(id, tune).tint.centre);
          for (const c of [face.tileFill(null, id).centre, face.tileFill(null, id).rim, face.tileFill(T.accent.default, id).centre]) expect(cool(c), c).toBe(true);
        } finally {
          apply.layFlats({}, id);
        }
      });
    }
  }

  it("this browser's copy keeps every corner's glass (read back whole, so the next load's first frame has it)", async () => {
    const { parseMirror } = await import('./mirror');
    for (const tune of [...CORNERS, { blue: 37, contrast: 63 }, { blue: 81, contrast: 12 }]) {
      const m = { who: 'u-1', ...tune, flats: flats(tune) };
      expect(parseMirror(JSON.stringify(m)), name(tune)).toEqual(m);
    }
  });

  it('laying nothing puts the canvas glass back as it was, and never sets a tile key as a property', () => {
    const before = JSON.stringify(tokens.GLASS_FACE);
    const tint = JSON.stringify(tokens.TILE_TINT);
    apply.layFlats(flats({ blue: 0, contrast: 100 }), 'dark');
    expect([...props.keys()].some((p) => p.startsWith('--ma-glass-body'))).toBe(true);
    expect([...props.keys()].some((p) => p.startsWith('--ma-tile'))).toBe(false);
    expect(JSON.stringify(tokens.GLASS_FACE)).not.toBe(before);
    apply.layFlats({}, 'dark');
    expect(JSON.stringify(tokens.GLASS_FACE)).toBe(before);
    expect(JSON.stringify(tokens.TILE_TINT)).toBe(tint);
    expect(props.size).toBe(0);
  });
});

/** `over` (#rrggbb) at `a` on `under`, in sRGB. */
const overHex = (over: string, under: string, a: number): string => tileGlass.overDesk(over, under, a);
