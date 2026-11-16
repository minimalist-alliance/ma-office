// The app tiles' glass (the owner's pick C, Nov 16: "I want C restrained for the app tiles"): every icon keeps 3:1 on its tile
// over every desk, the dials are C's, the fallback is the solid tile, and the bitmaps' keys.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deskLook, deskStyles } from './deskStyles';
import { contrastRatio } from './oklab';
import { tileFill } from './tileFace';
import { GLASS_INK_FLOOR, GLASS_TEXT_FLOOR, glassOpacity, glassTextOpacity, opacityFor, overDesk, tileInks } from './tileGlass';
import { AGENT_COLORS, APP_ACCENTS, APP_INKS, GLASS_FACE, THEME_IDS, THEMES, type ThemeId } from './tokens';

/** Every tile's own accent in a theme (null: an agent with no colour yet, the plain tile). */
const accents = (id: ThemeId): [string, string | null][] => [
  ...Object.entries(APP_ACCENTS).map(([app, v]): [string, string] => [app, v[id]]),
  ['office blue', THEMES[id].accent.default],
  ...Object.entries(APP_INKS).map(([app, v]): [string, string] => [app, v[id].accent]),
  ...Object.entries(AGENT_COLORS).map(([c, v]): [string, string] => [`agent:${c}`, v[id]]),
  ['agent with no colour', null],
];

describe('the glass keeps every icon at 3:1', () => {
  for (const id of THEME_IDS) {
    it(`every ink on every tile, over every desk style and in hand (${id})`, () => {
      const grounds = [...deskStyles().map((s) => [s.id, deskLook(s.id, id, false).base] as const), ['in hand', THEMES[id].surface.panel] as const];
      let least = Infinity;
      for (const [style, ground] of grounds) {
        for (const [name, accent] of accents(id)) {
          const body = tileFill(accent, id).centre;
          const a = glassOpacity(GLASS_FACE[id], body, ground, id, accent);
          expect(a, `${style} ${name}`).toBeGreaterThanOrEqual(GLASS_FACE[id].opacity);
          expect(a, `${style} ${name}`).toBeLessThanOrEqual(1);
          const mix = overDesk(body, ground, a);
          for (const ink of [...tileInks(id), ...(accent ? [accent] : [])]) {
            const r = contrastRatio(mix, ink);
            least = Math.min(least, r);
            expect(r, `${ink} on ${name}'s tile over ${style} (${mix}, opacity ${a})`).toBeGreaterThanOrEqual(3);
          }
        }
      }
      // The margin over 3:1 for the sheen and the frost (the wood under the glass isn't one flat colour).
      expect(least).toBeGreaterThanOrEqual(GLASS_INK_FLOOR);
    });
  }

  it('the body stays at its own opacity wherever the desk washes nothing out, and is solid at most', () => {
    // White oak in Light: the sheet's own scene, C's 0.86 as it was.
    const body = tileFill(APP_ACCENTS['notebook']!.light, 'light').centre;
    expect(glassOpacity(GLASS_FACE.light, body, deskLook('white-oak', 'light', false).base, 'light')).toBe(GLASS_FACE.light.opacity);
    // Nothing passes: solid.
    expect(opacityFor(0.5, '#808080', '#808080', () => false)).toBe(1);
    expect(opacityFor(0.5, '#808080', '#808080', () => true)).toBe(0.5);
  });
});

// A widget's card in glass (the office's glass, Nov 16: "Probably all of the UI elements in office actually"): the office blue's
// egg, never the app's tint, its body keeping the widget's words at 4.5:1 and its head's glyph at 3:1 over every desk style.
describe('a widget\'s card keeps its words at 4.5:1', () => {
  for (const id of THEME_IDS) {
    it(`every text ink and every icon ink on the card, over every desk style and in hand (${id})`, () => {
      const t = THEMES[id];
      const body = tileFill(t.accent.default, id).centre;
      const grounds = [...deskStyles().map((s) => [s.id, deskLook(s.id, id, false).base] as const), ['in hand', t.surface.panel] as const];
      let least = Infinity;
      for (const [style, ground] of grounds) {
        const a = glassTextOpacity(GLASS_FACE[id], body, ground, id);
        expect(a, style).toBeGreaterThanOrEqual(GLASS_FACE[id].opacity);
        expect(a, style).toBeLessThanOrEqual(1);
        const mix = overDesk(body, ground, a);
        for (const ink of [t.text.primary, t.text.secondary, t.text.tertiary]) {
          const r = contrastRatio(mix, ink);
          least = Math.min(least, r);
          expect(r, `${ink} on the card over ${style} (${mix}, opacity ${a})`).toBeGreaterThanOrEqual(4.5);
        }
        for (const ink of tileInks(id)) expect(contrastRatio(mix, ink), `${ink} over ${style}`).toBeGreaterThanOrEqual(3);
      }
      expect(least).toBeGreaterThanOrEqual(GLASS_TEXT_FLOOR);
    });
  }
});

describe('the dials are the prototype\'s C', () => {
  it('restrained: a mostly solid body, a faint lens, a light that is barely there', () => {
    expect(GLASS_FACE.light).toMatchObject({ opacity: 0.86, band: 0.14, lens: 0.15, frost: 2.5, specPeak: 0.7, specBack: 0.14, specFloor: 0.1, specWidth: 1, glow: 0.2, glowWidth: 2.5, sheen: 0.06, depthAlpha: 0.04 });
    expect(GLASS_FACE.dusk).toMatchObject({ opacity: 0.88, band: 0.14, lens: 0.15, frost: 2.5, specPeak: 0.3, specBack: 0.1, specFloor: 0.07, specWidth: 1, glow: 0.2, glowWidth: 2.5, sheen: 0.03, depthAlpha: 0.08 });
    expect(GLASS_FACE.dark).toMatchObject({ opacity: 0.88, band: 0.14, lens: 0.15, frost: 2.5, specPeak: 0.24, specBack: 0.08, specFloor: 0.05, specWidth: 1, glow: 0.2, glowWidth: 2.5, sheen: 0.02, depthAlpha: 0.11 });
    for (const id of THEME_IDS) {
      // A contact shadow under a soft one, only ever down; no bevel, no hairline (no spread).
      expect(GLASS_FACE[id].lift).toHaveLength(2);
      for (const l of GLASS_FACE[id].lift) {
        expect(l.dy).toBeGreaterThan(0);
        expect(l.spread ?? 0).toBe(0);
        expect(l.inset ?? false).toBe(false);
      }
    }
  });
});

describe('the fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });
  const withMedia = async (on: Record<string, boolean>): Promise<typeof import('./tileGlass')> => {
    vi.resetModules();
    vi.stubGlobal('window', {
      matchMedia: (q: string) => ({ matches: Object.entries(on).some(([k, v]) => v && q.includes(k)), addEventListener: () => undefined, removeEventListener: () => undefined }),
    });
    return import('./tileGlass');
  };

  it('glass by default, on by default (prelaunch: features ship on); no switch', async () => {
    const g = await withMedia({});
    expect(g.glassOn()).toBe(true);
    for (const id of THEME_IDS) expect(g.glassFace(id)).toEqual(GLASS_FACE[id]);
  });
  it('reduced transparency: the solid tile', async () => {
    const g = await withMedia({ 'prefers-reduced-transparency': true });
    expect(g.reducedTransparency()).toBe(true);
    expect(g.glassOn()).toBe(false);
    for (const id of THEME_IDS) expect(g.glassFace(id)).toBeNull();
  });
  it('more contrast: the solid tile', async () => {
    const g = await withMedia({ 'prefers-contrast': true });
    expect(g.glassOn()).toBe(false);
    for (const id of THEME_IDS) expect(g.glassFace(id)).toBeNull();
  });
});
