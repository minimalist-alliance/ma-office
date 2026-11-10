import { describe, expect, it } from 'vitest';
import { defaultDeskStyleId, deskLook, deskStyleOf, deskStyles, isDeskStyleId } from './deskStyles';
import { DESK_STYLE_INKS, THEME_IDS, THEMES } from './tokens';
import { levelCount, levelFor } from '../canvas/deskTexture';

// The same arithmetic as tokens.test.ts, for a style's own colors.
function lum(c: string): number {
  const hex = /^#([0-9a-f]{6})$/i.exec(c);
  if (!hex) throw new Error(`a style's base and fill are opaque hex: ${c}`);
  const n = parseInt(hex[1]!, 16);
  const f = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
}
const contrast = (a: string, b: string): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const isPowerOfTwo = (n: number): boolean => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

describe('the desk style registry', () => {
  const styles = deskStyles();

  it('has the Designer\'s four in order with Light oak the default, then Plain last', () => {
    expect(defaultDeskStyleId()).toBe('oak');
    expect(styles.map((s) => s.id)).toEqual(['oak', 'ash', 'walnut', 'linoleum', 'plain']);
    expect(styles.map((s) => s.name)).toEqual(['Light oak', 'White ash', 'Walnut', 'Linoleum', 'Plain']);
  });

  it('has a 1024 px tile at density 2 for every textured style and theme, and none for plain', () => {
    for (const s of styles) {
      for (const theme of THEME_IDS) {
        const tex = s.looks[theme].texture;
        if (s.id === 'plain') expect(tex).toBeNull();
        else expect(tex, `${s.id}.${theme}`).toMatchObject({ width: 1024, height: 1024, density: 2 });
      }
    }
  });

  it('has unique ids that can be stored, and short names', () => {
    expect(new Set(styles.map((s) => s.id)).size).toBe(styles.length);
    for (const s of styles) {
      expect(isDeskStyleId(s.id), s.id).toBe(true);
      expect(s.name.length, s.id).toBeGreaterThan(0);
      expect(s.name.length, s.id).toBeLessThanOrEqual(16);
    }
  });

  it('has a look for every theme, with its colors from tokens.ts', () => {
    for (const s of styles) {
      for (const theme of THEME_IDS) {
        const look = s.looks[theme];
        expect(look.key).toBe(`${s.id}.${theme}`);
        expect(look.base).toBe(DESK_STYLE_INKS[s.id]![theme].base);
        expect(look.etch).toEqual(DESK_STYLE_INKS[s.id]![theme].etch);
      }
    }
  });

  it('plain is exactly today\'s panel and etch, in every theme, with text.secondary on it', () => {
    for (const theme of THEME_IDS) {
      const look = deskStyleOf('plain').looks[theme];
      expect(look.base).toBe(THEMES[theme].surface.panel);
      expect(look.etch).toEqual(THEMES[theme].etch);
      expect(look.deskText).toBe(THEMES[theme].text.secondary);
      expect(look.texture).toBeNull();
    }
  });

  it('every texture is a power-of-two tile at a density that\'s crisp at 100 % on a 2x screen', () => {
    for (const s of styles) {
      for (const theme of THEME_IDS) {
        const tex = s.looks[theme].texture;
        if (!tex) continue;
        expect(isPowerOfTwo(tex.width) && isPowerOfTwo(tex.height), `${s.id}.${theme}`).toBe(true);
        expect(tex.density, `${s.id}.${theme}`).toBeGreaterThanOrEqual(2);
        expect(tex.src).not.toMatch(/^data:/); // a file of its own, never inlined into the JS
      }
    }
  });

  it('every style keeps the status line readable on its base, and its etch reads as cut in', () => {
    for (const s of styles) {
      for (const theme of THEME_IDS) {
        const { base, etch, deskText } = s.looks[theme];
        // The status line and "Undo" are the style's `deskText`, which holds 4.5:1 on its base.
        expect(contrast(deskText, base), `${s.id}.${theme}`).toBeGreaterThanOrEqual(4.5);
        // In Dark the lit lower lip is the line that reads, and the wall merges with the fill; elsewhere it's the wall.
        const line = theme === 'dark' && etch.highlight?.startsWith('#') ? etch.highlight : etch.wall;
        expect(contrast(etch.fill, line), `${s.id}.${theme}`).toBeGreaterThanOrEqual(s.id === 'plain' ? 1.5 : 2.6);
        // The etched name blends into the desk on purpose (the owner's rule), so it has a floor of 1.5:1 against the desk, not 4.5:1.
        expect(contrast(etch.fill, base), `${s.id}.${theme}`).toBeGreaterThanOrEqual(1.5);
      }
    }
  });
});

describe('a desk\'s style', () => {
  it('is the default when nothing is stored, or an id this build doesn\'t know', () => {
    expect(deskStyleOf(undefined).id).toBe(defaultDeskStyleId());
    expect(deskStyleOf('walnut-from-a-newer-build').id).toBe(defaultDeskStyleId());
    expect(deskStyleOf('').id).toBe(defaultDeskStyleId());
  });

  it('looks are the same objects every time, so a draw compares them and builds nothing', () => {
    for (const theme of THEME_IDS) {
      expect(deskLook('oak', theme, false)).toBe(deskLook(undefined, theme, false));
      expect(deskLook('plain', theme, true)).toBe(deskLook('plain', theme, true));
    }
  });

  it('under more contrast it\'s today\'s flat surface whatever the style, with no texture', () => {
    for (const theme of THEME_IDS) {
      const look = deskLook('plain', theme, true);
      expect(look.texture).toBeNull();
      expect(look.base).toBe(THEMES[theme].surface.panel);
      expect(look.key).toBe(`flat.${theme}`);
    }
  });

  it.each([
    ['plain', true],
    ['oak-2', true],
    ['', false],
    ['Oak', false],
    ['-oak', false],
    ['oak oak', false],
    ['a'.repeat(33), false],
    [7, false],
    [null, false],
  ])('%j is %s as a stored id', (v, ok) => {
    expect(isDeskStyleId(v)).toBe(ok);
  });
});

describe('the copy of a texture a raster uses', () => {
  it('is the smallest that still has as many pixels per unit as the raster, so it\'s never scaled down by half or more', () => {
    // A 1024 tile at 4 px a unit has copies at 4, 2, 1, 0.5, 0.25 and 0.125.
    expect(levelCount(1024, 1024)).toBe(6);
    expect(levelFor(4, 4, 6)).toBe(0);
    expect(levelFor(4, 3.5, 6)).toBe(0); // 175 % at 2x: the full image, scaled down a little
    expect(levelFor(4, 6, 6)).toBe(0); // 300 % at 2x: the full image, scaled up
    expect(levelFor(4, 2, 6)).toBe(1);
    expect(levelFor(4, 1.99, 6)).toBe(1);
    expect(levelFor(4, 1, 6)).toBe(2);
    expect(levelFor(4, 0.4, 6)).toBe(3); // 20 % at 2x
    expect(levelFor(4, 0.2, 6)).toBe(4); // 20 % at 1x
    expect(levelFor(4, 0.01, 6)).toBe(5); // never past the smallest
    for (let q = 0.2; q <= 6; q += 0.05) {
      const n = levelFor(4, q, 6);
      const density = 4 / 2 ** n;
      expect(q / density).toBeGreaterThan(n === 5 ? 0 : 0.5);
      if (n > 0) expect(density).toBeGreaterThanOrEqual(q - 1e-9);
    }
  });

  it('a bad scale gets the full image', () => {
    expect(levelFor(4, 0, 6)).toBe(0);
    expect(levelFor(4, Number.NaN, 6)).toBe(0);
  });

  it('smaller tiles have fewer copies, down to 32 pixels', () => {
    expect(levelCount(512, 512)).toBe(5);
    expect(levelCount(2048, 1024)).toBe(6);
    expect(levelCount(32, 32)).toBe(1);
    expect(levelCount(16, 16)).toBe(1);
  });
});
