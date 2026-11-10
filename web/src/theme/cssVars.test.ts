// Every `var(--ma-…)` the app reads is a token from tokens.ts, or a property the app itself sets. A name that's
// neither reads as nothing, so its rule quietly doesn't draw: `--ma-border-default` (the token is `--ma-border`) left
// fifteen borders undrawn, in every theme, until task 34.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { themeTokens } from './themeCss';
import { THEME_IDS } from './tokens';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const sources = walk(SRC).filter((f) => /\.(css|tsx?)$/.test(f) && !/\.test\.tsx?$/.test(f));
const text = new Map(sources.map((f) => [f, readFileSync(f, 'utf8')]));
const names = (re: RegExp, only: (f: string) => boolean = () => true): Set<string> =>
  new Set([...text].filter(([f]) => only(f)).flatMap(([, t]) => [...t.matchAll(re)].map((m) => m[1] as string)));

describe('CSS custom properties', () => {
  const tokens = new Set(THEME_IDS.flatMap((id) => themeTokens(id).map(([name]) => name)));
  // Set by the app: declared in a stylesheet, set with setProperty, or a key of an inline style object.
  const own = new Set([
    ...names(/(--ma-[a-z0-9-]+)\s*:/g, (f) => f.endsWith('.css')),
    ...names(/setProperty\(\s*['"`](--ma-[a-z0-9-]+)/g),
    ...names(/['"](--ma-[a-z0-9-]+)['"]\s*:/g, (f) => !f.endsWith('.css')),
  ]);
  const read = names(/var\(\s*(--ma-[a-z0-9-]+)/g);

  it('finds what it checks', () => {
    expect(sources.some((f) => f.endsWith('app.css'))).toBe(true);
    expect(read.size).toBeGreaterThan(20);
    expect(tokens.has('--ma-border')).toBe(true);
  });

  it('reads only names that exist', () => {
    expect([...read].filter((name) => !tokens.has(name) && !own.has(name)).sort()).toEqual([]);
  });

  it('every theme has every token, so none is missing in one theme alone', () => {
    const light = themeTokens('light').map(([name]) => name).sort();
    for (const id of THEME_IDS) expect(themeTokens(id).map(([name]) => name).sort(), id).toEqual(light);
  });
});
