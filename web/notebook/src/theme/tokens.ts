// The only file in this package with color literals (the Desk app's rule, ADR 0029).
//
// The Notebook draws with the Desk app's semantic tokens (`--ma-surface-window`, `--ma-text-primary`
// and the rest, made by web/src/theme/themeCss.ts in the app and by demo/brandThemes.ts here, both
// from docs/assets/brand/ui/tokens.json). These are the few colors the brand tokens don't have:
// binder tab colors and the highlight, stored by name and mapped per theme (design 3.12).
// Tab colors come from prototype/src/lib/tokens.js, which the owner has seen.
import type { TabColor } from '../model/types.ts';

export type ThemeId = 'light' | 'dusk' | 'dark';
export const THEME_IDS: ThemeId[] = ['light', 'dusk', 'dark'];

export interface NotebookTokens {
  tab: Record<TabColor, string>;
  /** Behind highlighted text. Text keeps text.primary on it in every theme. */
  highlight: { yellow: string };
}

const light: NotebookTokens = {
  tab: { blue: '#6F95C9', green: '#6AA583', amber: '#D3A24D', rose: '#CF7B86', violet: '#8F7CC4', slate: '#7D8794' },
  highlight: { yellow: '#F6E7A6' },
};

const dusk: NotebookTokens = {
  tab: { blue: '#8EAEDB', green: '#8CC3A2', amber: '#DDB56F', rose: '#DE98A1', violet: '#ADA0DC', slate: '#A3ACB8' },
  highlight: { yellow: '#7A6A33' },
};

const dark: NotebookTokens = {
  tab: { blue: '#6F95C9', green: '#69A682', amber: '#C99A48', rose: '#C7737F', violet: '#8F7CC4', slate: '#8A94A1' },
  highlight: { yellow: '#5E5226' },
};

export const NOTEBOOK_THEMES: Record<ThemeId, NotebookTokens> = { light, dusk, dark };

/** `tab.blue` becomes `--ma-nb-tab-blue`. */
export function notebookThemeCss(): string {
  const block = (t: NotebookTokens): string =>
    [
      ...Object.entries(t.tab).map(([k, v]) => `  --ma-nb-tab-${k}: ${v};`),
      ...Object.entries(t.highlight).map(([k, v]) => `  --ma-nb-highlight-${k}: ${v};`),
    ].join('\n');
  const parts = ['/* Generated from web/notebook/src/theme/tokens.ts. */', `:root {\n${block(light)}\n}`];
  parts.push(`@media (prefers-color-scheme: dark) {\n:root:not([data-theme]) {\n${block(dark)}\n}\n}`);
  for (const id of THEME_IDS) parts.push(`:root[data-theme="${id}"] {\n${block(NOTEBOOK_THEMES[id])}\n}`);
  return parts.join('\n');
}

/**
 * The stylesheet inside an exported HTML file. Light theme values from docs/assets/brand/ui/tokens.json
 * (text.primary, text.secondary, text.link, border.default, surface.sunken), since a file opened
 * anywhere has no theme. Nunito if the reader has it, else the system font.
 */
export function exportCss(): string {
  return [
    'body{margin:0;background:#FFFFFF;color:#2A2E35;font:500 16px/1.6 "Nunito Variable",Nunito,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
    'main{max-width:70ch;margin:0 auto;padding:48px 24px}',
    'h1{font-size:26px;line-height:1.25;margin:0 0 .5em}h2{font-size:19px;margin:1.1em 0 .35em}h3{font-size:16px;margin:1em 0 .3em}',
    'p{margin:0 0 .6em}a{color:#476C9E}mark{background:#F6E7A6;color:inherit}',
    'blockquote{margin:0 0 .8em;padding-left:14px;border-left:3px solid rgba(42,46,53,.14);color:#565A63}',
    'pre{background:#F3F3EF;border-radius:8px;padding:12px 14px;overflow:auto}code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.9em}',
    'ul.tasks{list-style:none;padding-left:0}li.task{display:flex;gap:8px}li.task>div>p{margin:0}li.task.done{color:#62666F;text-decoration:line-through}',
    'hr{border:0;border-top:1px solid rgba(42,46,53,.14);margin:1.2em 0}',
  ].join('\n');
}
