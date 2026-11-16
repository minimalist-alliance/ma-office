// The office's one CSS glass (the owner, Nov 16: the app tiles' C on the mode chooser's highlight and Maia's bubble, then
// "Probably all of the UI elements in office"): C's dials, text at 4.5:1 and icons at 3:1 on it over every ground, the fallback.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { glassBody, glassBodyDense, glassCssTokens, glassDomInks, GLASS_ANY_GROUNDS, GLASS_GROUNDS, GLASS_STATE, specAlpha } from './glassCss';
import { contrastRatio } from './oklab';
import { themeTokens } from './themeCss';
import { overDesk } from './tileGlass';
import { GLASS_FACE, THEME_IDS, THEMES } from './tokens';

describe('the CSS glass', () => {
  for (const id of THEME_IDS) {
    const t = THEMES[id];
    it(`text keeps 4.5:1 and an icon 3:1 on its body, middle and rim, over every ground (${id})`, () => {
      const b = glassBody(id);
      expect(b.alpha).toBeGreaterThanOrEqual(GLASS_FACE[id].opacity);
      expect(b.alpha).toBeLessThanOrEqual(1);
      for (const ground of GLASS_GROUNDS(id)) {
        for (const at of [b.centre, b.rim]) {
          const mix = overDesk(at, ground, b.alpha);
          for (const ink of [t.text.primary, t.text.secondary, t.text.tertiary, t.text.link]) expect(contrastRatio(mix, ink), `${ink} on ${mix}`).toBeGreaterThanOrEqual(4.5);
          for (const ink of [t.glyph.default, t.accent.default]) expect(contrastRatio(mix, ink), `${ink} on ${mix}`).toBeGreaterThanOrEqual(3);
        }
      }
    });
    it(`is C's light: brightest at the top left, a faint glint opposite, the floor elsewhere (${id})`, () => {
      const g = GLASS_FACE[id];
      expect(specAlpha(g, (-3 * Math.PI) / 4)).toBeCloseTo(g.specPeak, 6);
      expect(specAlpha(g, Math.PI / 4)).toBeCloseTo(g.specBack, 6);
      expect(specAlpha(g, -Math.PI / 4)).toBeCloseTo(g.specFloor, 2);
      const css = glassCssTokens(id);
      expect(css['specWidth']).toBe(`${g.specWidth}px`);
      expect(css['glowWidth']).toBe(`${g.glowWidth}px`);
      expect(css['spec']).toMatch(/^conic-gradient\(from 90deg, /);
      expect(css['body']).toMatch(/^radial-gradient\(ellipse 68% 76% at 50% 44%, /);
      expect(css['lift']).not.toMatch(/inset/);
      expect(css['depth']).toMatch(/^inset /);
    });
    it(`is in themes.css as --ma-glass-* (${id})`, () => {
      const names = themeTokens(id).map(([k]) => k);
      for (const k of ['body', 'body-dense', 'body-full', 'hover', 'press', 'sheen', 'spec', 'glow', 'spec-width', 'glow-width', 'depth', 'lift']) expect(names).toContain(`--ma-glass-${k}`);
    });
    // The office's chrome (Nov 16, "Probably all of the UI elements in office actually") can sit over anything: an open tile's
    // app, a window, the Browser's picture, a photo. Every grey from black to white, and the primaries, stand in for anything.
    const anything = [...Array.from({ length: 18 }, (_, i) => `#${Math.min(255, i * 15).toString(16).padStart(2, '0').repeat(3)}`), '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#00FFFF', '#FF00FF', ...GLASS_GROUNDS(id)];
    const spec = (rgb: string): string => `#${rgb.split(',').map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
    it(`the dense body keeps text at 4.5:1 and icons at 3:1 over any ground, under the sheen, and a control's ink pressed (${id})`, () => {
      const d = glassBodyDense(id);
      const g = GLASS_FACE[id];
      expect(d.alpha).toBeGreaterThanOrEqual(glassBody(id).alpha);
      expect(d.alpha).toBeLessThan(1);
      const wash = spec(t.text.primary.slice(1).match(/../g)!.map((h) => parseInt(h, 16)).join(','));
      for (const ground of [...anything, ...GLASS_ANY_GROUNDS]) {
        for (const at of [d.centre, d.rim]) {
          const mix = overDesk(at, ground, d.alpha);
          for (const top of [mix, overDesk(spec(g.spec), mix, g.sheen)]) {
            for (const { ink, floor } of glassDomInks(id)) expect(contrastRatio(top, ink), `${ink} on ${top} over ${ground}`).toBeGreaterThanOrEqual(floor);
            const pressed = overDesk(wash, top, GLASS_STATE[id].press);
            expect(contrastRatio(pressed, t.text.primary), `a pressed label on ${pressed} over ${ground}`).toBeGreaterThanOrEqual(4.5);
            for (const ink of [t.glyph.default, t.accent.default]) expect(contrastRatio(pressed, ink), `a pressed icon on ${pressed}`).toBeGreaterThanOrEqual(3);
          }
        }
      }
    });
    it(`the full body is the same egg, opaque, and the states are washes of the theme's own ink (${id})`, () => {
      const css = glassCssTokens(id);
      const b = glassBody(id);
      const hex = (h: string): string => h.slice(1).match(/../g)!.map((v) => parseInt(v, 16)).join(', ');
      expect(css['bodyFull']).toContain(`rgba(${hex(b.centre)}, 1)`);
      expect(css['bodyFull']).toContain(`rgba(${hex(b.rim)}, 1)`);
      expect(css['hover']).toBe(`rgba(${hex(t.text.primary)}, ${GLASS_STATE[id].hover})`);
      expect(css['press']).toBe(`rgba(${hex(t.text.primary)}, ${GLASS_STATE[id].press})`);
      expect(GLASS_STATE[id].press).toBeGreaterThan(GLASS_STATE[id].hover);
    });
  }

  it('one recipe: every wearer falls back under reduced transparency or more contrast, and nothing blurs live', () => {
    const css = readFileSync(new URL('../styles/glass.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/backdrop-filter|filter:\s*blur/);
    const [main, fallback] = css.split('@media (prefers-reduced-transparency: reduce), (prefers-contrast: more)');
    const wearers = (block: string, pseudo = ''): string[] => [...block.matchAll(new RegExp(`(\\.[a-z][\\w-]*)${pseudo.replace(/:/g, ':')}\\s*[,{]`, 'g'))].map((m) => m[1]!);
    const worn = [...new Set(wearers(main!))];
    expect(worn).toEqual(['.ma-glass', '.mm-ch-card', '.maia-bubble']);
    expect([...new Set(wearers(fallback!))]).toEqual(worn);
    for (const p of ['::before', '::after']) expect([...new Set(wearers(fallback!, p))]).toEqual(worn);
    expect(fallback).toMatch(/background: var\(--ma-glass-solid-bg, none\)/);
    expect(fallback).toMatch(/content: none/);
    // The office's chrome (the class): the dense body, a clear line that the fallback brings back, the light on the outer edge.
    expect(main).toMatch(/var\(--ma-glass-fill, var\(--ma-glass-body\)\)/);
    expect(main).toMatch(/--ma-glass-fill: var\(--ma-glass-body-dense\)/);
    expect(main).toMatch(/--ma-glass-line: transparent/);
    expect(fallback).toMatch(/--ma-glass-line: initial/);
    expect(main).toMatch(/inset: calc\(-1 \* var\(--ma-glass-edge, 0px\)\)/);
  });

  // Every element of the office's own markup that wears the class names its fallback, so reduced transparency or more contrast
  // is today's look, and never sets what the recipe owns in a rule of its own weight or more that comes later.
  it('every wearer\'s stylesheet gives it a solid look to fall back to, and none blurs', () => {
    const files = ['../styles/app.css', '../bandwidth/bandwidth.css', '../setup/setup.css', '../zoom/zoom.css', '../chrome/markMenu.css', '../opentile/opentile.css', '../maiamode/shield/shield.css'];
    const all = files.map((f) => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
    expect(all).not.toMatch(/backdrop-filter/);
    for (const wearer of ['.icon-btn.ma-glass', '.chip-btn.ma-glass', '.segmented.ma-glass', '.notice.ma-glass', '.menu.ma-glass', '.account-glass.ma-glass', '.bw-btn', '.bw-panel', '.su-btn', '.app-zoom-pop', '.mark-surface', '.open-tile', '.sh-wrap', '.office-notice', '.hints', '.desk-nav', '.edit-name']) {
      const rules = [...all.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, sel]) => sel!.split(',').some((x) => x.trim().startsWith(wearer)));
      expect(rules.length, wearer).toBeGreaterThan(0);
      expect(rules.some(([, , body]) => /--ma-glass-solid-bg/.test(body!)), `${wearer} names its solid look`).toBe(true);
    }
  });
});
