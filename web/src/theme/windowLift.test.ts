// The window lift (ADR 0029's addendum): the owner picked option 5 of the Product Designer's sheet on Nov 12, "the top-edge
// highlight plus the contact shadow". These are the Designer's own CSS values, copied from `options.py`'s output for option
// 5 (`design-drafts/window-lift/src`), and the tokens must say exactly the same, in every theme, so the look can't drift.
// `windowlift.shell.spec.ts` pins what the browser computes from them.
import { describe, expect, it } from 'vitest';
import { shadowCss, themeCss, themeTokens } from './themeCss';
import { THEME_IDS, THEMES, WINDOW_LIFT, type ThemeId } from './tokens';

/** Option 5's CSS, as the Designer's `options.py` writes it, per theme. */
const DESIGNER: Record<ThemeId, { rest: string; active: string; edge: string }> = {
  light: {
    rest: '0 1px 3px rgba(20, 30, 50, 0.14), 0 6px 18px rgba(20, 30, 50, 0.11)',
    active: '0 1px 3px rgba(20, 30, 50, 0.18), 0 18px 48px rgba(20, 30, 50, 0.15)',
    edge: 'inset 0 1px 0 rgba(255, 255, 255, 0.9), inset 1px 0 0 rgba(255, 255, 255, 0.3)',
  },
  dusk: {
    rest: '0 1px 2px rgba(16, 20, 30, 0.45), 0 2px 6px rgba(16, 20, 30, 0.26)',
    active: '0 1px 2px rgba(16, 20, 30, 0.50), 0 3px 10px rgba(16, 20, 30, 0.26), 0 0 0 1px rgba(241, 243, 247, 0.14)',
    edge: 'inset 0 1px 0 rgba(241, 243, 247, 0.16), inset 1px 0 0 rgba(241, 243, 247, 0.053)',
  },
  dark: {
    rest: '0 1px 3px rgba(5, 6, 8, 0.55), 0 6px 18px rgba(5, 6, 8, 0.38)',
    active: '0 1px 3px rgba(5, 6, 8, 0.65), 0 12px 36px rgba(5, 6, 8, 0.42), 0 0 0 1px rgba(236, 237, 239, 0.12)',
    edge: 'inset 0 1px 0 rgba(236, 237, 239, 0.1), inset 1px 0 0 rgba(236, 237, 239, 0.033)',
  },
};

/** What the tokens write, exactly, so a change to them shows here as well as on the page. */
const WRITTEN: Record<ThemeId, { rest: string; active: string; edge: string }> = {
  light: {
    rest: '0 1px 3px 0px rgba(20, 30, 50, 0.14), 0 6px 18px 0px rgba(20, 30, 50, 0.11)',
    active: '0 1px 3px 0px rgba(20, 30, 50, 0.18), 0 18px 48px 0px rgba(20, 30, 50, 0.15)',
    edge: 'inset 0 1px 0px 0px rgba(255, 255, 255, 0.9), inset 1px 0px 0px 0px rgba(255, 255, 255, 0.3)',
  },
  dusk: {
    rest: '0 1px 2px 0px rgba(16, 20, 30, 0.45), 0 2px 6px 0px rgba(16, 20, 30, 0.26)',
    active: '0 1px 2px 0px rgba(16, 20, 30, 0.50), 0 3px 10px 0px rgba(16, 20, 30, 0.26), 0 0px 0px 1px rgba(241, 243, 247, 0.14)',
    edge: 'inset 0 1px 0px 0px rgba(241, 243, 247, 0.16), inset 1px 0px 0px 0px rgba(241, 243, 247, 0.053)',
  },
  dark: {
    rest: '0 1px 3px 0px rgba(5, 6, 8, 0.55), 0 6px 18px 0px rgba(5, 6, 8, 0.38)',
    active: '0 1px 3px 0px rgba(5, 6, 8, 0.65), 0 12px 36px 0px rgba(5, 6, 8, 0.42), 0 0px 0px 1px rgba(236, 237, 239, 0.12)',
    edge: 'inset 0 1px 0px 0px rgba(236, 237, 239, 0.1), inset 1px 0px 0px 0px rgba(236, 237, 239, 0.033)',
  },
};

/** Each theme's own near-white, which its lit edge is drawn in (tokens.ts: Light's white, Zen's and Dark's hairline white). */
const LINE: Record<ThemeId, string> = { light: '255, 255, 255', dusk: '241, 243, 247', dark: '236, 237, 239' };

interface Layer { inset: boolean; x: number; y: number; blur: number; spread: number; rgba: number[] }

/** A box-shadow list as numbers: either spelling of a layer (`0` or `0px`, a missing spread, `0.50` or `0.5`) reads the same. */
function layers(css: string): Layer[] {
  return css.split(/,(?![^(]*\))/).map((part) => {
    const rgba = /rgba\(([^)]*)\)/.exec(part)![1]!.split(',').map(Number);
    const words = part.replace(/rgba\([^)]*\)/, '').trim().split(/\s+/);
    const inset = words[0] === 'inset';
    const [x = 0, y = 0, blur = 0, spread = 0] = words.slice(inset ? 1 : 0).map((w) => parseFloat(w));
    return { inset, x, y, blur, spread, rgba };
  });
}

const token = (id: ThemeId, name: string): string => themeTokens(id).find(([k]) => k === name)![1];

describe.each(THEME_IDS)('the window lift in %s', (id) => {
  it('is the Designer\'s option 5, layer for layer', () => {
    expect(layers(shadowCss(WINDOW_LIFT[id].rest))).toEqual(layers(DESIGNER[id].rest));
    expect(layers(shadowCss(WINDOW_LIFT[id].active))).toEqual(layers(DESIGNER[id].active));
    expect(layers(shadowCss(WINDOW_LIFT[id].edge))).toEqual(layers(DESIGNER[id].edge));
  });

  it('writes exactly these custom properties', () => {
    expect(token(id, '--ma-window-lift-rest')).toBe(WRITTEN[id].rest);
    expect(token(id, '--ma-window-lift-active')).toBe(WRITTEN[id].active);
    expect(token(id, '--ma-window-lift-edge')).toBe(WRITTEN[id].edge);
  });

  it('lights the edge from the top left in the theme\'s own near-white, the left a third of the top', () => {
    const [top, left] = layers(WRITTEN[id].edge);
    expect(top).toMatchObject({ inset: true, x: 0, y: 1, blur: 0, spread: 0 });
    expect(left).toMatchObject({ inset: true, x: 1, y: 0, blur: 0, spread: 0 });
    expect(top!.rgba.slice(0, 3).join(', ')).toBe(LINE[id]);
    expect(left!.rgba.slice(0, 3).join(', ')).toBe(LINE[id]);
    expect(left!.rgba[3]).toBeCloseTo(top!.rgba[3]! / 3, 3);
  });

  it('keeps the contact shadow tight, and no taller than the shadow it replaces', () => {
    const reach = (css: string): number => Math.max(...layers(css).map((l) => l.y + l.blur));
    const rest = layers(WRITTEN[id].rest);
    expect(rest[0]!.y).toBe(1);
    expect(rest[0]!.blur).toBeLessThanOrEqual(3);
    expect(reach(WRITTEN[id].rest)).toBeLessThan(reach(token(id, '--ma-elevation-menu')));
    expect(reach(WRITTEN[id].active)).toBeLessThan(reach(token(id, '--ma-elevation-window')));
  });
});

describe('the window lift in the theme sheet', () => {
  const css = themeCss();
  it('is in every theme\'s block, and in the dark fallback for a device with no theme yet', () => {
    for (const id of THEME_IDS) {
      const block = css.slice(css.indexOf(`:root[data-theme="${id}"] {`));
      expect(block.slice(0, block.indexOf('}')), id).toContain(`--ma-window-lift-edge: ${WRITTEN[id].edge};`);
    }
    const fallback = css.slice(css.indexOf(':root:not([data-theme]) {'));
    expect(fallback.slice(0, fallback.indexOf('}'))).toContain(`--ma-window-lift-active: ${WRITTEN.dark.active};`);
    const light = css.slice(css.indexOf(':root {'));
    expect(light.slice(0, light.indexOf('}'))).toContain(`--ma-window-lift-rest: ${WRITTEN.light.rest};`);
  });

  it('stays out of the tokens the app reads at run time, so it costs the bundle nothing', () => {
    for (const id of THEME_IDS) expect(Object.keys(THEMES[id])).not.toContain('windowLift');
  });
});
