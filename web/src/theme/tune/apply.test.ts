// Laying the sliders' colours (`apply.ts`): in the token objects, in place, each changed theme's top-level object replaced
// (so `t` selectors draw again and `THEMES[id] === t` holds), and as custom properties on <html> for the theme on show;
// today's values back when nothing is laid. Also this browser's copy (`mirror.ts`): read strictly, and its property names
// are themeCss.ts's.
import { beforeAll, describe, expect, it } from 'vitest';
import { flattenTokens } from '../themeCss';
import { parseMirror, propOf } from './mirror';

// A <html> with only what apply.ts touches: its inline style.
const props = new Map<string, string>();
const style = {
  setProperty: (k: string, v: string) => void props.set(k, v),
  removeProperty: (k: string) => void props.delete(k),
  getPropertyValue: (k: string) => props.get(k) ?? '',
};
let apply: typeof import('./apply');
let tokens: typeof import('../tokens');

beforeAll(async () => {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { style } };
  tokens = await import('../tokens');
  apply = await import('./apply');
});

describe('layFlats', () => {
  it('writes into the groups in place, swaps the top-level object, and sets the theme on show only', () => {
    const before = tokens.THEMES.light;
    const etch = before.etch;
    const changed = apply.layFlats({ light: { 'surface.panel': '#F0F1F3', 'etch.fill': '#707070' }, dark: { 'surface.panel': '#202124' } }, 'light');
    expect(changed).toBe(true);
    expect(tokens.THEMES.light).not.toBe(before);
    expect(tokens.THEMES.light.surface.panel).toBe('#F0F1F3');
    // The same group objects: anything that kept one (a Plain desk's etch) follows.
    expect(tokens.THEMES.light.etch).toBe(etch);
    expect(etch.fill).toBe('#707070');
    expect(props.get('--ma-surface-panel')).toBe('#F0F1F3');
    expect(props.get('--ma-etch-fill')).toBe('#707070');
    expect(tokens.THEMES.dark.surface.panel).toBe('#202124');
  });
  it('switching theme swaps the properties to that theme', () => {
    apply.layProps('dark');
    expect(props.get('--ma-surface-panel')).toBe('#202124');
    expect(props.has('--ma-etch-fill')).toBe(false);
  });
  it('nothing laid puts today back, everywhere', () => {
    const changed = apply.layFlats({}, 'dark');
    expect(changed).toBe(true);
    expect(tokens.THEMES.light.surface.panel).toBe(apply.pristine('light')['surface.panel']);
    expect(tokens.THEMES.light.etch.fill).toBe(apply.pristine('light')['etch.fill']);
    expect(tokens.THEMES.dark.surface.panel).toBe(apply.pristine('dark')['surface.panel']);
    expect(props.size).toBe(0);
    expect(apply.layFlats({}, 'light')).toBe(false);
  });
});

describe('the mirror', () => {
  const good = { who: 'u-1', blue: 40, contrast: 70, flats: { light: { 'surface.panel': '#FAFAFA', 'border.hairline': 'rgba(16, 24, 40, 0.09)' } } };
  it('reads a good copy', () => {
    expect(parseMirror(JSON.stringify(good))).toEqual(good);
  });
  it('refuses anything off, whole', () => {
    for (const bad of [
      { ...good, who: 1 },
      { ...good, blue: 101 },
      { ...good, contrast: 2.5 },
      { ...good, flats: { light: { 'surface.panel': 'url(x)' } } },
      { ...good, flats: { light: { 'surface.panel': 'red; --x: 1' } } },
      { ...good, flats: { light: { '__proto__.x': '#FFFFFF' } } },
      { ...good, flats: { light: 'x' } },
      // The glass's own: gradients and shadows of rgba() colours only.
      { ...good, flats: { light: { 'glass.body': 'url(x)' } } },
      { ...good, flats: { light: { 'glass.body': 'radial-gradient(ellipse at 50% 44%, url(x))' } } },
      { ...good, flats: { light: { 'glass.lift': 'var(--x)' } } },
      { ...good, flats: { light: { 'glass.body': '#FFFFFF; color: red' } } },
      { ...good, flats: { light: { 'tileGlass.specPeak': 'calc(1)' } } },
    ]) expect(parseMirror(JSON.stringify(bad))).toBeNull();
    expect(parseMirror('{')).toBeNull();
    expect(parseMirror(null)).toBeNull();
  });
  it('reads the glass (release 6.11): the DOM recipe as properties, the canvas\'s numbers and colours', () => {
    const glass = {
      ...good,
      flats: {
        dark: {
          'glass.body': 'radial-gradient(ellipse 68% 76% at 50% 44%, rgba(40, 45, 54, 0.88) 32%, rgba(36, 41, 50, 0.88))',
          'glass.spec': 'conic-gradient(from 90deg, rgba(236, 237, 239, 0.07) 0deg, rgba(236, 237, 239, 0.0703) 10deg)',
          'glass.lift': '0px 1px 1.5px 0px rgba(5, 6, 8, 0.41), 0px 4px 10px 0px rgba(5, 6, 8, 0.275)',
          'glass.depth': 'inset -1px -1px 3px -1px rgba(5, 6, 8, 0.165), inset 0px 0px 1.5px 0px rgba(5, 6, 8, 0.0413)',
          'glass.sheen': 'linear-gradient(164deg, rgba(236, 237, 239, 0.028), rgba(236, 237, 239, 0) 52%)',
          'tileGlass.specPeak': '0.336',
          'tileGlass.spec': '236, 237, 239',
          'tileLiftContact.color': 'rgba(5, 6, 8, 0.413)',
          'tileTint.centre': '0.3089',
        },
      },
    };
    expect(parseMirror(JSON.stringify(glass))).toEqual(glass);
  });
  it("names the properties as themeCss.ts does (the canvas's glass, `tile*`, is never one)", () => {
    const names = new Map(flattenTokens(tokens.THEMES.light).map(([k]) => [k, true]));
    for (const k of Object.keys(apply.pristine('light'))) if (!k.startsWith('tile')) expect(names.has(propOf(k)), `${k} -> ${propOf(k)}`).toBe(true);
    expect(Object.keys(apply.pristine('light'))).toContain('tileGlass.specPeak');
    expect(propOf('accent.default')).toBe('--ma-accent');
    expect(propOf('surface.fillStrong')).toBe('--ma-surface-fill-strong');
  });
});
