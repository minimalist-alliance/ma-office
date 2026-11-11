// Turns the token objects into CSS custom properties. Used by the Vite plugin
// (vite-plugins/themes.ts) at build time and by the unit tests.
import { APP_INKS, COLOR_SCHEME, THEME_IDS, THEMES, VIEW, type AppInk, type ShadowLayer, type ThemeId } from './tokens.ts';

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

/** The office's properties an app's ink re-declares on its window's root (see `AppInk`). */
export function appInkProps(ink: AppInk): [string, string][] {
  return [
    ['--ma-surface-window', ink.window],
    ['--ma-surface-sunken', ink.sidebar],
    ['--ma-accent', ink.accent],
    ['--ma-accent-hover', ink.accentHover],
    ['--ma-accent-pressed', ink.accentPressed],
    ['--ma-focus-ring', ink.accent],
    ['--ma-accent-subtle', ink.accentSubtle],
    ['--ma-text-on-accent', ink.onAccent],
    ['--ma-text-link', ink.link],
  ];
}

/** `.ma-window[data-app="files"]` carries the app's colors in each theme; `prefers-contrast: more` keeps them (they meet the same ratios). */
function appThemeCss(): string[] {
  const rule = (theme: string, app: string, ink: AppInk): string =>
    `${theme} .ma-window[data-app="${app}"] {\n${appInkProps(ink).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`;
  const out: string[] = [];
  for (const [app, inks] of Object.entries(APP_INKS)) {
    out.push(rule(':root', app, inks.light));
    out.push(`@media (prefers-color-scheme: dark) {\n${rule(':root:not([data-theme])', app, inks.dark)}\n}`);
    for (const id of THEME_IDS) out.push(rule(`:root[data-theme="${id}"]`, app, inks[id]));
  }
  return out;
}

export function themeCss(): string {
  const parts = ['/* Generated from src/theme/tokens.ts by vite-plugins/themes.ts. */'];
  // A device with no saved preference and no boot script result still gets the right theme.
  parts.push(`:root {\n${block('light')}\n}`);
  parts.push(`@media (prefers-color-scheme: dark) {\n:root:not([data-theme]) {\n${block('dark')}\n}\n}`);
  for (const id of THEME_IDS) parts.push(`:root[data-theme="${id}"] {\n${block(id)}\n}`);
  parts.push(...appThemeCss());
  return parts.join('\n');
}
