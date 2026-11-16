import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The loading overlay's marks (ADR 0058; the Product Designer's design): the page carries the kit's three marks whole, and
// `loading.css` shows the theme's (ADR 0066 and its Zen addendum): `primary` on Light, the Zen mark on Zen, `on-dark` on
// Dark. Only each root tag changes, gaining a class and `aria-hidden`. This reads the harness's copy of ma-platform's
// `sites/desk-loader/` files, the same the specs load, against this repo's own mark files.
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const page = read('../../harness/loader/index.html');
const css = read('../../harness/loader/loading.css');
const overlay = page.slice(page.indexOf('<div id="ma-ld"'), page.indexOf('</body>'));
const svgs = overlay.match(/<svg [\s\S]*?<\/svg>/g) ?? [];
const ROOT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 915 568" width="915" height="568">';
const MARKS = [
  { file: 'ma-mark-primary.svg', cls: 'ma-ld-l', theme: 'light', prefix: 'ma-primary-' },
  { file: 'ma-mark-zen.svg', cls: 'ma-ld-z', theme: 'dusk', prefix: 'ma-zen-' },
  { file: 'ma-mark-on-dark.svg', cls: 'ma-ld-d', theme: 'dark', prefix: 'ma-on-dark-' },
] as const;

describe("the loading overlay's marks", () => {
  it('are three, one a theme, in the order Light, Zen, Dark', () => {
    expect(svgs).toHaveLength(3);
  });

  MARKS.forEach(({ file, cls, theme, prefix }, i) => {
    it(`${theme}: the kit's ${file}, byte for byte after its root tag`, () => {
      const kit = read(`../assets/brand/${file}`).trim();
      expect(kit.startsWith(ROOT)).toBe(true);
      const svg = svgs[i]!;
      expect(svg.slice(0, svg.indexOf('>') + 1)).toBe(`<svg xmlns="http://www.w3.org/2000/svg" class="ma-ld-m ${cls}" aria-hidden="true" viewBox="0 0 915 568" width="915" height="568">`);
      expect(svg.slice(svg.indexOf('>') + 1)).toBe(kit.slice(ROOT.length));
      // Its own ids only, every reference its own: the three can share a page (the kit's prefixes).
      const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
      for (const id of ids) expect(id.startsWith(prefix), id).toBe(true);
      for (const [, ref] of svg.matchAll(/url\(#([^)]+)\)/g)) expect(ids, ref).toContain(ref);
      expect(css).toContain(`[data-theme="${theme}"] .${cls}`);
    });
  });

  it('no id is on the page twice, and nothing in the overlay takes focus', () => {
    const ids = [...overlay.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(overlay).not.toMatch(/<(a|button|input|select|textarea)\b|tabindex/);
  });
});
