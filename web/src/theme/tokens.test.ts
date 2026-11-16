import { describe, expect, it } from 'vitest';
import { themeCss, themeTokens } from './themeCss';
import { APP_INKS, THEME_IDS, THEMES, VIEW, type Tokens } from './tokens';
import { oklab } from './oklab';
import { HUES } from '../chrome/avatar';

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
  // Every ground a link sits on, the fills under a tab or a chip included (Light's was 4.48:1 on surface.fill, BRAND-19/20).
  { name: 'text.link', min: 4.5, fg: (t) => t.text.link, on: (t) => [...surfaces(t), ...world(t), t.surface.fill, t.surface.fillStrong, t.accent.subtle] },
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

// The link with no rounding allowance (the Product Designer, BRAND-19/20: Light's was 4.48:1 on surface.fill, which the
// table's rounding let pass).
describe.each(THEME_IDS)('%s text.link', (id) => {
  const t = THEMES[id];
  it('reads at 4.5:1 or more on every ground it sits on, unrounded', () => {
    for (const bg of [...surfaces(t), ...world(t), t.surface.fill, t.surface.fillStrong, t.accent.subtle]) {
      expect(contrast(t.text.link, bg), `${t.text.link} on ${bg}`).toBeGreaterThanOrEqual(4.5);
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

// The owner's rule: no green, brown or warm tint anywhere in the UI (Nov 13). The status colours, and the rating star that
// takes warn's, are the brand's cool palette: a blue (hue 190 to 290), or a neutral (saturation 0.18 or less, the release
// proof's own test). Red stays for a real error only, as the kit's badges note says, so `error` is left out.
function hueSat(hex: string): { h: number; s: number } {
  const { r, g, b } = parse(hex);
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  if (d === 0) return { h: 0, s: 0 };
  const l = (max + min) / 2;
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s: d / (1 - Math.abs(2 * l - 1)) };
}
const cool = (hex: string): boolean => {
  const { h, s } = hueSat(hex);
  return s <= 0.18 || (h >= 190 && h <= 290);
};

describe.each(THEME_IDS)('%s status colours are cool', (id) => {
  const t = THEMES[id];
  it('online, warn, offline and the star: blue or neutral, never green, amber or brown', () => {
    for (const [name, hex] of [['online', t.status.online], ['warn', t.status.warn], ['offline', t.status.offline], ['star', VIEW[id].star]] as const) {
      expect(cool(hex), `${name} ${hex}`).toBe(true);
    }
  });
  it('online is the accent blue, warn a neutral, and the dots stay apart', () => {
    expect(t.status.online).toBe(t.accent.default);
    expect(hueSat(t.status.warn).s).toBeLessThan(hueSat(t.status.online).s / 2);
    expect(new Set([t.status.online, t.status.warn, t.status.offline, t.status.error]).size).toBe(4);
    // warn is the stronger ink: further from the panel than offline's grey, so a waiting dot reads before an idle one.
    expect(contrast(t.status.warn, t.surface.panel)).toBeGreaterThan(contrast(t.status.offline, t.surface.panel) + 1);
    expect(VIEW[id].star).toBe(t.status.warn);
  });
});

// The member avatar's six tints (the owner's no-green, no-warm rule, Nov 16: Zen's cool set taken to Light and Dark). Each
// ink reads at 4.5:1 on both of its tint's stops; every stop is cool (a blue or a cool grey, and blue the largest channel,
// as ma-platform's cool.test.ts asks of the same values); and the six stay apart, at least Zen's closest pair, blue and
// steel (OKLab 0.045 between the stops' middles), so members are told apart in every theme.
const mid = (a: string, b: string): [number, number, number] => {
  const [x, y] = [oklab(a), oklab(b)];
  return [0, 1, 2].map((i) => (x[i]! + y[i]!) / 2) as [number, number, number];
};
describe.each(THEME_IDS)('%s avatar tints', (id) => {
  const a = THEMES[id].avatar;
  const tint = (h: (typeof HUES)[number]) => ({ top: a[`${h}Top`], bottom: a[`${h}Bottom`], ink: a[`${h}Ink`] });
  it.each([...HUES])('%s: its ink reads at 4.5:1 or more on both stops', (h) => {
    const { top, bottom, ink } = tint(h);
    for (const bg of [top, bottom]) expect(contrast(ink, bg), `${ink} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });
  it('are all cool: a blue or a cool grey, never green, amber, brown or rose', () => {
    for (const h of HUES) {
      for (const hex of [tint(h).top, tint(h).bottom]) {
        const { r, g, b } = parse(hex);
        expect(cool(hex), `${h} ${hex}`).toBe(true);
        expect(b >= r && b >= g, `${h} ${hex}: blue is the largest channel`).toBe(true);
      }
    }
  });
  it('are six, each told apart from the rest', () => {
    const mids = HUES.map((h) => mid(tint(h).top, tint(h).bottom));
    for (let i = 0; i < mids.length; i += 1) {
      for (let j = i + 1; j < mids.length; j += 1) {
        const d = Math.hypot(...mids[i]!.map((v, k) => v - mids[j]![k]!));
        expect(d, `${HUES[i]} and ${HUES[j]}`).toBeGreaterThanOrEqual(0.045);
      }
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

// Files' ink, and the Bible's (an installed app's, by its window's `data-app`, ADR 0054).
describe.each(Object.keys(APP_INKS).flatMap((app) => THEME_IDS.map((id) => [app, id] as const)))('%s in %s: its own colors', (app, id) => {
  const ink = APP_INKS[app]![id];
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
  it('is declared only on its own window, in this theme', () => {
    const css = themeCss();
    const at = css.indexOf(`:root[data-theme="${id}"] .ma-window[data-app="${app}"] {`);
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf('}', at));
    expect(block).toContain(`--ma-accent: ${ink.accent};`);
    expect(block).toContain(`--ma-focus-ring: ${ink.accent};`);
    expect(block).toContain(`--ma-surface-sunken: ${ink.sidebar};`);
    expect(block).not.toContain('--ma-text-primary');
    expect(block).not.toContain('--ma-border');
  });
});
