// Turns the token objects into CSS custom properties. Used by the Vite plugin
// (vite-plugins/themes.ts) at build time and by the unit tests.
import { COLOR_SCHEME, THEME_IDS, THEMES, VIEW, type ShadowLayer, type ThemeId } from './tokens.ts';

const kebab = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export function shadowCss(layers: ShadowLayer[]): string {
  if (!layers.length) return 'none';
  return layers.map((l) => `0 ${l.dy}px ${l.blur}px ${l.spread ?? 0}px ${l.color}`).join(', ');
}

/** `surface.tile` becomes `--ma-surface-tile`; a `default` key collapses, so `accent.default` is `--ma-accent`. */
export function flattenTokens(t: object): [string, string][] {
  const out: [string, string][] = [];
  for (const [group, values] of Object.entries(t) as [string, Record<string, string | ShadowLayer[]>][]) {
    for (const [key, value] of Object.entries(values)) {
      const name = key === 'default' ? `--ma-${kebab(group)}` : `--ma-${kebab(group)}-${kebab(key)}`;
      out.push([name, typeof value === 'string' ? value : shadowCss(value)]);
    }
  }
  return out;
}

/** Every custom property of a theme: the shared tokens and the simplified view's (`--ma-view-*`). */
export function themeTokens(id: ThemeId): [string, string][] {
  return flattenTokens({ ...THEMES[id], view: VIEW[id] });
}

function block(id: ThemeId): string {
  const props = themeTokens(id).map(([k, v]) => `  ${k}: ${v};`);
  return `${props.join('\n')}\n  color-scheme: ${COLOR_SCHEME[id]};`;
}

export function themeCss(): string {
  const parts = ['/* Generated from src/theme/tokens.ts by vite-plugins/themes.ts. */'];
  // A device with no saved preference and no boot script result still gets the right theme.
  parts.push(`:root {\n${block('light')}\n}`);
  parts.push(`@media (prefers-color-scheme: dark) {\n:root:not([data-theme]) {\n${block('dark')}\n}\n}`);
  for (const id of THEME_IDS) parts.push(`:root[data-theme="${id}"] {\n${block(id)}\n}`);
  return parts.join('\n');
}
