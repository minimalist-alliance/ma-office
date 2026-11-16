// The theme sliders' colour math on the office's own tokens (the owner's pick, Nov 14: blue range A and the sheet's
// contrast range; ~/ma-coord/design-drafts/theme-sliders/). At every slider position, in Light, Zen and Dark: the default
// is today exactly, no cool grey or blue turns warm, green or brown, text keeps 4.5:1, and what the sheet leaves alone
// stays as it is.
import { describe, expect, it } from 'vitest';
import { THEME_IDS, THEMES, type ThemeId } from '../tokens';
import { pristine } from './apply';
import { CHECK_SURFACES, CHECK_TEXT, changedOnly, clampTune, classOf, contrastRatio, parseColor, rgbToOklch, tuneFlat, warmOffenders } from './xf';

const flat = (id: ThemeId): Record<string, string> => pristine(id);
const STEPS = Array.from({ length: 21 }, (_, i) => i * 5);

describe('the default is today', () => {
  it.each(THEME_IDS)('%s: blue 100, contrast 50 changes nothing', (id) => {
    const { out, fixes } = tuneFlat(flat(id), { blue: 100, contrast: 50 });
    expect(out).toBe(flat(id));
    expect(fixes).toEqual([]);
  });
  it('pristine is tokens.ts as written', () => {
    expect(flat('light')['surface.panel']).toBe(THEMES.light.surface.panel);
    expect(flat('dark')['text.link']).toBe(THEMES.dark.text.link);
  });
});

describe('every position, every theme', () => {
  for (const id of THEME_IDS) {
    it(`${id}: no warm, green or brown, and text holds 4.5:1 (a 5-step grid of both sliders)`, () => {
      const warm: string[] = [];
      const notCool: string[] = [];
      const low: string[] = [];
      for (const blue of STEPS) for (const contrast of STEPS) {
        const { out } = tuneFlat(flat(id), { blue, contrast });
        warm.push(...warmOffenders(out).map((w) => `${blue}/${contrast} ${w}`));
        // And by the blunter rule: every colour a slider wrote has its blue channel largest or tied (a cool or exact grey).
        for (const [k, v] of Object.entries(changedOnly(flat(id), out))) {
          const c = parseColor(v)!;
          const [r, g, b] = [c.r, c.g, c.b].map((x) => Math.round(x * 255)) as [number, number, number];
          if (b < r || b < g) notCool.push(`${blue}/${contrast} ${k} ${v}`);
        }
        if (blue === 100 && contrast === 50) continue;
        for (const t of CHECK_TEXT) for (const s of CHECK_SURFACES) {
          const r = contrastRatio(out[t]!, out[s]!);
          if (r < 4.5) low.push(`${blue}/${contrast} ${t} on ${s} ${r.toFixed(2)}`);
        }
      }
      expect(warm).toEqual([]);
      expect(notCool).toEqual([]);
      expect(low).toEqual([]);
    });
  }
});

describe('blue (range A: grey to today)', () => {
  it.each(THEME_IDS)('%s: at 0 every cool grey is grey, and the accent never moves', (id) => {
    const { out } = tuneFlat(flat(id), { blue: 0, contrast: 50 });
    for (const [k, v] of Object.entries(out)) {
      const c = parseColor(v);
      if (!c) continue;
      if (classOf(k) === 'neutral') expect(rgbToOklch(c).C, `${k} ${v}`).toBeLessThanOrEqual(0.004);
      // Text tokens may move for the floor, never the accent's own.
      if (classOf(k) === 'accent' && !k.startsWith('text.')) expect(v, k).toBe(flat(id)[k]);
    }
  });
  it.each(THEME_IDS)('%s: what the sheet leaves alone stays (status.error, danger, avatars, seals, halo, the backdrop)', (id) => {
    for (const blue of [0, 40, 80]) for (const contrast of [0, 50, 100]) {
      const changed = Object.keys(changedOnly(flat(id), tuneFlat(flat(id), { blue, contrast }).out));
      expect(changed.filter((k) => /^(status\.error|text\.danger|text\.onAccent|badge\.fg|avatar\.|seal\.|ring\.halo|surface\.backdrop)/.test(k))).toEqual([]);
    }
  });
  it('lowering blue lowers a grey chroma steadily', () => {
    const at = (blue: number): number => rgbToOklch(parseColor(tuneFlat(flat('light'), { blue, contrast: 50 }).out['surface.worldBase']!)!).C;
    expect(at(0)).toBeLessThan(at(50));
    expect(at(50)).toBeLessThan(at(100));
  });
});

describe('contrast', () => {
  it.each(THEME_IDS)('%s: low pulls the ground toward the window, high pushes it away', (id) => {
    const L = (contrast: number): number => rgbToOklch(parseColor(tuneFlat(flat(id), { blue: 100, contrast }).out['surface.worldBase']!)!).L;
    const Lw = rgbToOklch(parseColor(flat(id)['surface.window']!)!).L;
    expect(Math.abs(L(0) - Lw)).toBeLessThan(Math.abs(L(50) - Lw));
    expect(Math.abs(L(100) - Lw)).toBeGreaterThan(Math.abs(L(50) - Lw));
  });
  it('hairlines fade low and strengthen high (alpha)', () => {
    const a = (contrast: number): number => parseColor(tuneFlat(flat('light'), { blue: 100, contrast }).out['border.hairline']!)!.a;
    expect(a(0)).toBeLessThan(a(50));
    expect(a(100)).toBeGreaterThan(a(50));
  });
});

describe('clampTune', () => {
  it('reads anything off as the default, rounds, and holds 0..100', () => {
    expect(clampTune(null)).toEqual({ blue: 100, contrast: 50 });
    expect(clampTune({ blue: 140, contrast: -3 })).toEqual({ blue: 100, contrast: 0 });
    expect(clampTune({ blue: 12.6 } as never)).toEqual({ blue: 13, contrast: 50 });
    expect(clampTune({ blue: Number.NaN, contrast: '9' } as never)).toEqual({ blue: 100, contrast: 50 });
  });
});
