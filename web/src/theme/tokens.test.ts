import { describe, expect, it } from 'vitest';
import { themeCss, themeTokens } from './themeCss';
import { APP_INKS, THEME_IDS, THEMES, type Tokens } from './tokens';

type Rgba = { r: number; g: number; b: number; a: number };

function parse(c: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(c);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(c);
  if (!m) throw new Error(`can't parse ${c}`);
  const [r, g, b, a] = m[1]!.split(',').map((s) => Number(s.trim()));
  return { r: r!, g: g!, b: b!, a: a ?? 1 };
}

const over = (top: Rgba, under: Rgba): Rgba => ({
  r: top.r * top.a + under.r * (1 - top.a),
  g: top.g * top.a + under.g * (1 - top.a),
  b: top.b * top.a + under.b * (1 - top.a),
  a: 1,
});

function luminance({ r, g, b }: Rgba): number {
  const f = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fg: string, bg: string): number {
  const b = parse(bg);
  const l1 = luminance(over(parse(fg), b));
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const surfaces = (t: Tokens): string[] => [t.surface.tile, t.surface.panel, t.surface.window, t.surface.overlay, t.surface.sunken];
const world = (t: Tokens): string[] => [t.surface.worldHi, t.surface.worldBase, t.surface.worldLo];

// The pairs of design 3.12's contrast table. Text needs 4.5:1; UI parts and graphics need 3:1.
const PAIRS: { name: string; min: number; fg: (t: Tokens) => string; on: (t: Tokens) => string[] }[] = [
  { name: 'text.primary', min: 4.5, fg: (t) => t.text.primary, on: (t) => [...surfaces(t), ...world(t)] },
  { name: 'text.secondary', min: 4.5, fg: (t) => t.text.secondary, on: (t) => [...surfaces(t), ...world(t)] },
  { name: 'text.tertiary', min: 4.5, fg: (t) => t.text.tertiary, on: surfaces },
  { name: 'text.primary on accent.subtle', min: 4.5, fg: (t) => t.text.primary, on: (t) => [t.accent.subtle] },
  { name: 'text.link', min: 4.5, fg: (t) => t.text.link, on: (t) => [t.surface.tile, t.surface.panel, t.surface.window, t.surface.overlay, t.accent.subtle] },
  { name: 'text.onAccent', min: 4.5, fg: (t) => t.text.onAccent, on: (t) => [t.accent.default, t.accent.hover, t.accent.pressed] },
  { name: 'badge.fg', min: 4.5, fg: (t) => t.badge.fg, on: (t) => [t.badge.bg] },
  { name: 'mark.fg', min: 4.5, fg: (t) => t.mark.fg, on: (t) => [t.mark.disc] },
  { name: 'switcher.text', min: 4.5, fg: (t) => t.switcher.text, on: (t) => [t.switcher.selected] },
  { name: 'focus.ring', min: 3, fg: (t) => t.focus.ring, on: (t) => [t.surface.tile, t.surface.panel, t.surface.window, t.surface.overlay, ...world(t)] },
  { name: 'ring.activeDesk', min: 3, fg: (t) => t.ring.activeDesk, on: (t) => [t.surface.panel, ...world(t)] },
  { name: 'badge.bg', min: 3, fg: (t) => t.badge.bg, on: (t) => [t.surface.tile, t.surface.panel] },
  // ADR 0064's table. Text, so 4.5, and 3 behind an icon on hover, which isn't text.
  { name: 'etch.fill', min: 4.5, fg: (t) => t.etch.fill, on: (t) => [t.surface.panel] },
  { name: 'etch.fill on an icon\'s hover pad', min: 3, fg: (t) => t.etch.fill, on: (t) => [t.surface.fill] },
  { name: 'status.online', min: 3, fg: (t) => t.status.online, on: (t) => [t.surface.tile, t.surface.panel] },
  { name: 'status.warn', min: 3, fg: (t) => t.status.warn, on: (t) => [t.surface.tile, t.surface.panel] },
  // The decided values (Notebook look 6 of 9), set against the kit's surfaces. `surface.fill` is a hovered menu row, where Dusk's old `#F7BEB7` was 4.37.
  { name: 'text.danger', min: 4.5, fg: (t) => t.text.danger, on: (t) => [t.surface.window, t.surface.overlay, t.surface.fill] },
  { name: 'status.error', min: 3, fg: (t) => t.status.error, on: (t) => [t.surface.tile, t.surface.panel] },
  { name: 'status.offline', min: 3, fg: (t) => t.status.offline, on: (t) => [t.surface.tile, t.surface.panel] },
  { name: 'border.strong', min: 3, fg: (t) => t.border.strong, on: (t) => [t.surface.window, t.surface.tile, t.surface.sunken, t.switcher.track] },
  { name: 'glyph', min: 3, fg: (t) => t.glyph.default, on: (t) => [t.surface.tile, t.surface.panel] },
  { name: 'accent', min: 3, fg: (t) => t.accent.default, on: (t) => [t.surface.tile, t.surface.panel, t.surface.window] },
];

describe.each(THEME_IDS)('%s contrast', (id) => {
  const t = THEMES[id];
  it.each(PAIRS)('$name', ({ fg, on, min }) => {
    for (const bg of on(t)) {
      // Design 3.12 rounds down to one decimal, so 4.5 is "at least 4.5 before rounding up".
      expect(contrast(fg(t), bg), `${fg(t)} on ${bg}`).toBeGreaterThanOrEqual(min - 0.05);
    }
  });
});

describe('the etch (ADR 0064)', () => {
  it('has the contrast in the ADR\'s table, in every theme', () => {
    expect(contrast(THEMES.light.etch.fill, THEMES.light.surface.panel)).toBeCloseTo(4.56, 2);
    expect(contrast(THEMES.dusk.etch.fill, THEMES.dusk.surface.panel)).toBeCloseTo(6.72, 2); // Zen (ADR 0093)
    expect(contrast(THEMES.dark.etch.fill, THEMES.dark.surface.panel)).toBeCloseTo(6.56, 2);
  });

  it('its wall is darker than its fill, and its highlight lighter than the panel, so it reads as cut in', () => {
    for (const id of THEME_IDS) {
      const { etch, surface } = THEMES[id];
      expect(contrast(etch.wall, '#000000'), id).toBeLessThan(contrast(etch.fill, '#000000'));
      expect(contrast(etch.fill, etch.wall), id).toBeGreaterThanOrEqual(1.5);
      expect(etch.highlight, id).not.toBe(surface.panel);
    }
  });
});

describe('Zen (dusk) purity', () => {
  const values = themeTokens('dusk').map(([, v]) => v.toLowerCase());
  it('holds no pure black or white, in any notation', () => {
    for (const v of values) {
      expect(v).not.toMatch(/#000\b|#000000\b|#fff\b|#ffffff\b/);
      expect(v).not.toMatch(/rgba?\(\s*0\s*,\s*0\s*,\s*0\b/);
      expect(v).not.toMatch(/rgba?\(\s*255\s*,\s*255\s*,\s*255\b/);
      expect(v).not.toMatch(/\b(black|white)\b/);
    }
  });
  it('has cool near-whites (ADR 0093, in place of ADR 0050\'s neutral ones)', () => {
    expect(THEMES.dusk.text.primary).toBe('#F1F3F7');
    expect(THEMES.dusk.text.secondary).toBe('#DFE3EA');
    expect(THEMES.dusk.text.tertiary).toBe('#D3D8E0');
    // The neutral white is gone from the set, hex and rgba alike: the lines are the cool white too.
    for (const v of values) expect(v).not.toMatch(/#fafafa|250,\s*250,\s*250/);
  });
});

describe('themes.css', () => {
  const css = themeCss();
  it('has a block per theme with its color-scheme', () => {
    for (const id of THEME_IDS) expect(css).toContain(`:root[data-theme="${id}"]`);
    expect(css).toContain('color-scheme: dark');
    expect(css).toContain('color-scheme: light');
  });
  it('names tokens as the design does, and every theme has the same names', () => {
    expect(css).toContain('--ma-surface-tile: #474D5B');
    const names = THEME_IDS.map((id) => themeTokens(id).map(([k]) => k).join());
    expect(new Set(names).size).toBe(1);
  });
});

describe.each(THEME_IDS)('%s: Files\' own colors', (id) => {
  const ink = APP_INKS["files"]![id];
  const t = THEMES[id];
  it('meets the Product Designer\'s ratios on its own surfaces', () => {
    expect(contrast(t.text.primary, ink.window)).toBeGreaterThanOrEqual(7 - 0.05);
    expect(contrast(t.text.secondary, ink.sidebar)).toBeGreaterThanOrEqual(4.5 - 0.05);
    expect(contrast(t.text.primary, ink.accentSubtle)).toBeGreaterThanOrEqual(4.5 - 0.05);
    expect(contrast(ink.onAccent, ink.accent)).toBeGreaterThanOrEqual(4.5 - 0.05);
    expect(contrast(ink.onAccent, ink.accentHover)).toBeGreaterThanOrEqual(4.5 - 0.05);
    for (const bg of [ink.window, ink.sidebar]) {
      expect(contrast(ink.accent, bg)).toBeGreaterThanOrEqual(3 - 0.05);
      expect(contrast(ink.link, bg)).toBeGreaterThanOrEqual(4.5 - 0.05);
    }
  });
  it('is declared only on the Files window, in this theme', () => {
    const css = themeCss();
    const at = css.indexOf(`:root[data-theme="${id}"] .ma-window[data-app="files"] {`);
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf('}', at));
    expect(block).toContain(`--ma-accent: ${ink.accent};`);
    expect(block).toContain(`--ma-focus-ring: ${ink.accent};`);
    expect(block).toContain(`--ma-surface-sunken: ${ink.sidebar};`);
    expect(block).not.toContain('--ma-text-primary');
    expect(block).not.toContain('--ma-border');
  });
});
