// To-do's views bar: a count's blue holds 4.5:1 on the bar's fill (an unselected tab) and on the window (the selected
// one) in Light, Zen and Dark. The colour is a `color-mix` of two tokens in todo.css, read from there and mixed here as
// the browser does (`in srgb`: each channel, as written, weighted).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEME_IDS, THEMES, type Tokens } from '../../theme/tokens';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'todo.css'), 'utf8');

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lum = (c: [number, number, number]): number => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: [number, number, number], b: [number, number, number]): number => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

/** `--ma-text-link` to `t.text.link`. */
const token = (t: Tokens, name: string): string => {
  const [group, ...rest] = name.replace(/^--ma-/, '').split('-');
  const key = rest.join('-').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) || 'default';
  const v = (t as unknown as Record<string, Record<string, unknown>>)[group!]?.[key];
  if (typeof v !== 'string') throw new Error(`no token ${name}`);
  return v;
};

describe("To-do's tab counts", () => {
  const rule = /\.todo-views b \{([^}]*)\}/.exec(css)?.[1] ?? '';
  const mix = /color:\s*color-mix\(in srgb, var\((--ma-[\w-]+)\) (\d+)%, var\((--ma-[\w-]+)\)\)/.exec(rule);

  it('are a mix of two tokens, never a literal', () => {
    expect(mix, rule).not.toBeNull();
  });

  it.each(THEME_IDS)('hold 4.5:1 on the bar and on the selected tab in %s', (id) => {
    const t = THEMES[id];
    const [, a, pct, b] = mix!;
    const p = Number(pct) / 100;
    const [ca, cb] = [rgb(token(t, a!)), rgb(token(t, b!))];
    const count = ca.map((v, i) => Math.round(v * p + cb[i]! * (1 - p))) as [number, number, number];
    expect(contrast(count, rgb(t.surface.fill)), `on surface.fill ${t.surface.fill}`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(count, rgb(t.surface.window)), `on surface.window ${t.surface.window}`).toBeGreaterThanOrEqual(4.5);
    // Still a blue: the link's hue, not the text's grey.
    expect(count[2]).toBeGreaterThan(count[0]);
  });
});
