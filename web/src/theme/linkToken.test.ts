// The kit's Light text.link is #355F91 since 2026-11-11, the Product Designer's pick: one link blue on every Light
// surface the kit colors (the office's own accent.hover today). ma-platform holds its account site, Management Console and
// sign-in pages to the same value, and reads this file from our origin/main to check it (`web/platform/src/linkParity.test.ts`
// there), so a change here is a change there: move them together. This test holds the kit's half: the token, the sign-in
// mock that carries it, and 4.86:1 or more (rounded to two places, as contrast.txt does) on every opaque Light surface.
// Zen and Dark aren't touched.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const LINK = '#355F91';
const BRAND = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'assets');
const kit = JSON.parse(readFileSync(join(BRAND, 'brand', 'ui', 'tokens.json'), 'utf8')) as {
  themes: Record<string, Record<string, { final?: unknown }>>;
};
const light = kit.themes['light']!;

function ratio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return Math.round(((x! + 0.05) / (y! + 0.05)) * 100) / 100;
}

// Every opaque Light surface, and the accent wash (a selected row): the grounds a link can sit on.
const GROUNDS = Object.entries(light)
  .filter(([k, v]) => (k.startsWith('surface.') || k === 'accent.subtle') && typeof v.final === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v.final))
  .map(([k, v]) => [k, v.final as string] as const);

describe("the kit's Light link (one link blue, Nov 11)", () => {
  it(`text.link's final is ${LINK}`, () => {
    expect(light['text.link']!.final).toBe(LINK);
  });

  it('reads at 4.86:1 or more on every opaque Light surface', () => {
    expect(GROUNDS.map(([k]) => k)).toEqual(expect.arrayContaining(['surface.worldHi', 'surface.worldBase', 'surface.worldLo', 'surface.panel', 'surface.tile', 'surface.sunken', 'surface.fill', 'surface.fillStrong', 'accent.subtle']));
    for (const [k, hex] of GROUNDS) expect(ratio(LINK, hex), `text.link on ${k} ${hex}`).toBeGreaterThanOrEqual(4.86);
  });

  it("the sign-in mock's Light --link is the same", () => {
    const mock = readFileSync(join(BRAND, 'signin', 'mock.html'), 'utf8');
    const lightBlock = /\[data-ma=light\]\{([^}]*)\}/.exec(mock)?.[1] ?? '';
    expect(/--link:(#[0-9a-fA-F]{6})/.exec(lightBlock)?.[1]?.toUpperCase()).toBe(LINK);
  });
});
