// An app tile's face (APP-TILES, the owner, Nov 15 night: a clean bevel and lift, no inner glow; each icon's tile tinted by
// its app's accent, calm, with a very subtle egg-shaped gradient; Courier's accent less brown).
import { describe, expect, it } from 'vitest';
import { contrastRatio, oklab, oklch } from './oklab';
import { bevelWidth, clear, eggCss, tileFill, tileShadowCss } from './tileFace';
import { AGENT_COLORS, APP_ACCENTS, APP_INKS, THEME_IDS, THEMES, TILE_FACE, TILE_TINT, type ThemeId } from './tokens';

const BIBLE = 'app:com.minimalistalliance.bible';
/** Every accent a tile is tinted by, in a theme: the apps' own, the office blue (Browser), the Bible's Lapis, every agent colour. */
const accents = (id: ThemeId): [string, string][] => [
  ...Object.entries(APP_ACCENTS).map(([app, v]): [string, string] => [app, v[id]]),
  ['browser', THEMES[id].accent.default],
  ['bible', APP_INKS[BIBLE]![id].accent],
  ...Object.entries(AGENT_COLORS).map(([c, v]): [string, string] => [`agent:${c}`, v[id]]),
];
const chroma = (hex: string): number => oklch(hex)[1];
const deg = (hex: string): number => ((oklch(hex)[2] * 180) / Math.PI + 360) % 360;

describe('the tile face', () => {
  for (const id of THEME_IDS) {
    const tile = THEMES[id].surface.tile;
    it(`every accent holds 3:1 or more on its tinted tile where the icon sits (${id})`, () => {
      for (const [name, hex] of accents(id)) {
        const { centre } = tileFill(hex, id);
        expect(contrastRatio(hex, centre), `${name} ${hex} on ${centre}`).toBeGreaterThanOrEqual(3);
      }
    });
    it(`is a calm tint and a very subtle egg, with no rim of colour (${id})`, () => {
      const k = TILE_TINT[id];
      const [, ta, tb] = oklab(tile);
      const most = k.max + k.cast * Math.hypot(ta, tb) + 0.002; // the accent's share, over what's kept of the tile's cast
      for (const [name, hex] of accents(id)) {
        const { centre, rim } = tileFill(hex, id);
        expect(centre, name).not.toBe(tile);
        expect(chroma(centre), name).toBeLessThanOrEqual(most);
        // The rim is the centre a step darker, never more colourful: a fall-off, not a glow.
        expect(Math.abs(chroma(rim) - chroma(centre)), name).toBeLessThan(0.003);
        // At the accent's own hue: in Light's near white the chroma comes down, the hue never turns (a blue never goes aqua).
        if (chroma(centre) > 0.004) expect(Math.abs(((deg(centre) - deg(hex) + 540) % 360) - 180), name).toBeLessThan(id === 'light' ? 6 : 360);
        const dl = oklab(centre)[0] - oklab(rim)[0];
        expect(dl, name).toBeGreaterThan(0.01);
        expect(dl, name).toBeLessThan(0.035);
      }
    });
    it(`keeps the tile's own lightness where the icon sits in Zen and Dark, a step under white in Light (${id})`, () => {
      for (const [, hex] of accents(id)) {
        const l = oklab(tileFill(hex, id).centre)[0];
        expect(Math.abs(l - (id === 'light' ? 0.98 : oklab(tile)[0]))).toBeLessThan(0.004);
      }
    });
    it(`no colour is the tile's own (${id})`, () => {
      const { centre } = tileFill(null, id);
      const [la, aa, ba] = oklab(centre);
      const [lb, ab, bb] = oklab(tile);
      expect(Math.hypot(aa - ab, ba - bb)).toBeLessThan(0.004);
      expect(Math.abs(la - lb)).toBeLessThan(id === 'light' ? 0.022 : 0.004);
    });
    if (id !== 'light') {
      it(`gives a warm accent the least tint, so no tile reads brown (${id})`, () => {
        const k = TILE_TINT[id];
        const [, ta, tb] = oklab(tile);
        // What the accent adds to what's kept of the tile's own cast: a warm one's is well under the most a tint gives.
        const added = (hex: string): number => {
          const [, a, b] = oklab(hex);
          return Math.hypot(a - ta * k.cast, b - tb * k.cast);
        };
        for (const app of ['notebook', 'courier'] as const) {
          const warm = tileFill(APP_ACCENTS[app]![id], id).centre;
          const [, wa, wb] = oklab(warm);
          expect(added(warm), app).toBeLessThan(k.max * 0.65);
          expect(Math.hypot(wa, wb), app).toBeLessThan(0.015);
        }
      });
    }
    it(`bevels with crisp edges and lifts with soft shadows only: no inset blur, no glow (${id})`, () => {
      const css = tileShadowCss(id, 76);
      const insets = css.split(/,\s*(?![^(]*\))/).filter((l) => l.startsWith('inset'));
      expect(insets).toHaveLength(3);
      for (const l of insets) expect(l.split(/\s+/)[3], l).toMatch(/^0(px)?$/); // blur 0
      // The lift casts down, never round the tile.
      for (const l of TILE_FACE[id].lift) {
        expect(l.dy).toBeGreaterThan(0);
        expect(l.spread ?? 0).toBe(0);
        expect(l.inset ?? false).toBe(false);
      }
      expect(clear(TILE_FACE[id].lit)).toMatch(/, 0\)$/);
    });
  }
  it('sizes the bevel by the tile, about 1.45 px on an icon', () => {
    expect(bevelWidth(76)).toBeCloseTo(1.444, 2);
    expect(bevelWidth(20)).toBe(1);
    expect(bevelWidth(400)).toBe(2.2);
  });
  it('draws the same egg in CSS as on the canvas', () => {
    expect(eggCss({ centre: '#FAFAFA', rim: '#F0F0F0' })).toBe('radial-gradient(ellipse 68% 76% at 50% 44%, #FAFAFA 32%, #F0F0F0)');
  });
});

describe("Courier's accent (COURIER-ACCENT)", () => {
  it('is coral, less brown than clay: redder and a step more colourful, still muted, 3:1 on the tile and panel', () => {
    for (const id of THEME_IDS) {
      const hex = APP_ACCENTS['courier']![id];
      expect(deg(hex), id).toBeGreaterThan(25);
      expect(deg(hex), id).toBeLessThan(36);
      // Still muted: no more colourful than the palette's most colourful other accent in that theme, near enough.
      const most = Math.max(...Object.entries(APP_ACCENTS).filter(([app]) => app !== 'courier').map(([, v]) => chroma(v[id])));
      expect(chroma(hex), id).toBeLessThanOrEqual(most + 0.01);
      expect(contrastRatio(hex, THEMES[id].surface.tile), id).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(hex, THEMES[id].surface.panel), id).toBeGreaterThanOrEqual(3);
    }
  });
  it("stays apart from Commons' rose and Notebook's amber", () => {
    for (const id of THEME_IDS) {
      const c = oklab(APP_ACCENTS['courier']![id]);
      for (const other of ['commons', 'notebook']) {
        const o = oklab(APP_ACCENTS[other]![id]);
        expect(Math.hypot(c[0] - o[0], c[1] - o[1], c[2] - o[2]), `${other} ${id}`).toBeGreaterThan(0.04);
      }
    }
  });
});
