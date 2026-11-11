// The palette and the Notebook's scheme (src/ui/palette.ts), the Product Designer's values: six colors on ids c1..c6, and
// the contrast each use needs in every theme, so a later pick is held to the same bar.
import { describe, expect, it } from 'vitest';
import { exportPalette, isPaletteId, NOTEBOOK_SCHEME, PALETTE, paletteCss, paletteName, paletteRank, SCHEME_SCOPE, toPaletteId } from '../../src/ui/palette.ts';

const lum = (hex: string): number => {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string): number => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

// The office's own values the scheme leaves alone: text.primary, and the page (surface.tile). web/src/theme/tokens.ts.
const OFFICE = {
  light: { text: '#2B2D31', tile: '#FFFFFF' },
  dusk: { text: '#FAFAFA', tile: '#50565F' },
  dark: { text: '#ECEDEF', tile: '#2A2D33' },
} as const;
const THEMES = ['light', 'dusk', 'dark'] as const;

describe('palette', () => {
  it("is the Designer's six by the tabs' names, amber first as the default highlight", () => {
    expect(PALETTE.map((p) => [p.id, p.name])).toEqual([
      ['amber', 'Amber'],
      ['blue', 'Blue'],
      ['green', 'Green'],
      ['rose', 'Rose'],
      ['violet', 'Violet'],
      ['slate', 'Slate'],
    ]);
  });

  it('every value is a six-digit hex color', () => {
    for (const p of PALETTE) for (const t of THEMES) for (const v of Object.values(p[t])) expect(v).toMatch(/^#[0-9A-F]{6}$/i);
    for (const t of THEMES) for (const v of Object.values(NOTEBOOK_SCHEME[t])) expect(v).toMatch(/^#[0-9A-F]{6}$/i);
  });

  for (const t of THEMES) {
    describe(t, () => {
      const ink = NOTEBOOK_SCHEME[t];
      const office = OFFICE[t];
      const strong = t === 'light' ? 7 : 4.5;
      for (const p of PALETTE) {
        const v = p[t];
        it(`${p.name}: text.primary on its highlight and on its callout`, () => {
          expect(contrast(office.text, v.highlight)).toBeGreaterThanOrEqual(strong);
          expect(contrast(office.text, v.callout)).toBeGreaterThanOrEqual(strong);
        });
        it(`${p.name}: its text on the window, the page and its own callout`, () => {
          expect(contrast(v.text, ink.window)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(v.text, office.tile)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(v.text, v.callout)).toBeGreaterThanOrEqual(4.5);
        });
        it(`${p.name}: its label shows on the page list (always with its name; under 3:1 is a question for the Designer)`, () => {
          expect(contrast(v.label, ink.sidebar)).toBeGreaterThanOrEqual(2);
        });
      }
      it('the scheme: text, links and the accent hold their contrast', () => {
        expect(contrast(office.text, ink.window)).toBeGreaterThanOrEqual(7);
        expect(contrast(office.text, ink.sidebar)).toBeGreaterThanOrEqual(7);
        expect(contrast(office.text, ink.accentSubtle)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(ink.link, ink.window)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(ink.link, ink.sidebar)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(ink.onAccent, ink.accent)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(ink.accent, ink.window)).toBeGreaterThanOrEqual(3);
        expect(contrast(ink.accent, ink.sidebar)).toBeGreaterThanOrEqual(3);
      });
    });
  }

  it('reads names and order; anything else reads as none', () => {
    expect(isPaletteId('green')).toBe(true);
    expect(isPaletteId('c7')).toBe(false);
    expect(isPaletteId('yellow')).toBe(false);
    expect(isPaletteId('#FF0000')).toBe(false);
    expect(toPaletteId('c8')).toBeNull();
    expect(toPaletteId(undefined)).toBeNull();
    expect(paletteName('blue')).toBe('Blue');
    expect(paletteName(null)).toBe('');
    expect(paletteRank('amber')).toBe(0);
    expect(paletteRank('slate')).toBe(5);
    expect(paletteRank(null)).toBe(6);
    expect(paletteRank('c7')).toBe(6);
  });

  it('gives files that leave the app the light values, a block being its callout', () => {
    const out = exportPalette();
    expect(Object.keys(out)).toEqual(['amber', 'blue', 'green', 'rose', 'violet', 'slate']);
    const c2 = PALETTE[1]!;
    expect(out.blue).toEqual({ name: 'Blue', highlight: c2.light.highlight, text: c2.light.text, block: c2.light.callout, label: c2.light.label });
  });

  it('serves a variable per id, use and theme, and the scheme on the Notebook alone', () => {
    const css = paletteCss();
    for (const p of PALETTE) for (const k of ['highlight', 'text', 'callout', 'label']) expect(css).toContain(`--ma-nb-${p.id}-${k}:`);
    for (const t of THEMES) expect(css).toContain(`:root[data-theme="${t}"] ${SCHEME_SCOPE} {\n  --ma-surface-window: ${NOTEBOOK_SCHEME[t].window};`);
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(SCHEME_SCOPE).toContain('.ma-window[data-app="notebook"]');
    // Nothing of the scheme lands on :root itself, where the office would take it.
    expect(css).not.toMatch(/:root(\[data-theme="\w+"\])? \{\n {2}--ma-surface-window/);
  });
});
