// Demo only: serves `virtual:ma-brand-themes.css`, the Desk app's semantic tokens as CSS custom
// properties with the app's names (`surface.tile` -> `--ma-surface-tile`, `accent.default` ->
// `--ma-accent`), read from the brand kit's final values in docs/assets/brand/ui/tokens.json.
// Inside the Desk app, the app's own themes.css provides the same properties, so this goes away.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const TOKENS = fileURLToPath(new URL('../../../docs/assets/brand/ui/tokens.json', import.meta.url));
const ID = 'virtual:ma-brand-themes.css';
const RESOLVED = `\0${ID}`;
const THEMES = ['light', 'dusk', 'dark'] as const;
const SCHEME: Record<(typeof THEMES)[number], string> = { light: 'light', dusk: 'dark', dark: 'dark' };

interface Layer {
  dy: number;
  blur: number;
  spread?: number;
  color: string;
}
type Final = string | Layer[];

const kebab = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const shadow = (layers: Layer[]): string =>
  layers.length ? layers.map((l) => `0 ${l.dy}px ${l.blur}px ${l.spread ?? 0}px ${l.color}`).join(', ') : 'none';

export function brandCss(): string {
  const json = JSON.parse(readFileSync(TOKENS, 'utf8')) as { themes: Record<string, Record<string, { final: Final }>> };
  const block = (id: (typeof THEMES)[number]): string => {
    const entries = Object.entries(json.themes[id] ?? {}).map(([name, { final }]) => {
      const [group = '', key = ''] = name.split('.');
      const prop = key === 'default' ? `--ma-${kebab(group)}` : `--ma-${kebab(group)}-${kebab(key)}`;
      return `  ${prop}: ${typeof final === 'string' ? final : shadow(final)};`;
    });
    return `${entries.join('\n')}\n  color-scheme: ${SCHEME[id]};`;
  };
  const parts = ['/* Generated from docs/assets/brand/ui/tokens.json by demo/brandThemes.ts. */', `:root {\n${block('light')}\n}`];
  parts.push(`@media (prefers-color-scheme: dark) {\n:root:not([data-theme]) {\n${block('dark')}\n}\n}`);
  for (const id of THEMES) parts.push(`:root[data-theme="${id}"] {\n${block(id)}\n}`);
  return parts.join('\n');
}

export function brandThemesPlugin(): Plugin {
  return {
    name: 'ma-brand-themes',
    resolveId: (id) => (id === ID ? RESOLVED : null),
    load: (id) => (id === RESOLVED ? brandCss() : null),
  };
}
