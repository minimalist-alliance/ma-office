// The Notebook's colors: its own scheme ("Paper and ink") and the organizing colors a note's highlight, text color, callout
// and page label map to. Values from the Product Designer, ~/ma-coord/design-drafts/app-colors/ (tokens.json,
// `apps.notebook` and `notebookColors`), Nov 10: their picks, to build on while the owner chooses from the stills. Another
// pick changes only the values below (the Designer's src/make_tokens.py writes them).
//
// Notes store a color's name, the binder tabs' six (`blue`, `green`, `amber`, `rose`, `violet`, `slate`; `model/colors.ts`),
// never a value, so a change here restyles every note in every theme and rewrites none (ADR 0091). Amber comes first in the
// menus: it's the default highlight, and the old yellow reads as it. tests/unit/palette.test.ts holds any palette to:
//   - text.primary on a highlight and on a callout, 4.5:1 or more (7:1 in Light, as the Designer has it);
//   - colored text, 4.5:1 on the Notebook's window, its page and its own callout;
//   - a label (a dot by a page's name, the swatches in menus), always shown with its name or carrying it for screen readers.
//
// This file and src/theme/tokens.ts are the only ones here with color literals (eslint.config.js).
import { PALETTE_IDS, type PaletteColors, type PaletteId } from '../model/colors.ts';
import type { ThemeId } from '../theme/tokens.ts';

export { PALETTE_IDS, type PaletteId };

export interface PaletteValues {
  /** Behind highlighted text, which keeps text.primary. */
  highlight: string;
  /** Colored text. */
  text: string;
  /** A callout block's background; its left rule is `label`. */
  callout: string;
  /** A page's label dot, a callout's rule, and every swatch in the menus. */
  label: string;
}

export interface PaletteEntry {
  /** Its name, as notes store it and the Designer's `notebookColors` keys it: the binder tabs' color names. */
  id: PaletteId;
  /** What a screen reader says and a tooltip shows. */
  name: string;
  light: PaletteValues;
  dusk: PaletteValues;
  dark: PaletteValues;
}

/** In menu order: amber first (the default highlight), then the binder tabs' order. */
export const PALETTE: readonly PaletteEntry[] = [
  {
    id: 'amber',
    name: 'Amber',
    light: { highlight: '#F6E7A6', text: '#815B0B', callout: '#FCF3E6', label: '#D3A24D' },
    dusk: { highlight: '#7A6A33', text: '#F2D2A0', callout: '#564B3B', label: '#DDB56F' },
    dark: { highlight: '#5E5226', text: '#DDB77A', callout: '#382F20', label: '#C99A48' },
  },
  {
    id: 'blue',
    name: 'Blue',
    light: { highlight: '#D7E8FF', text: '#3B649B', callout: '#EFF5FE', label: '#6F95C9' },
    dusk: { highlight: '#496D9E', text: '#BFDAFF', callout: '#434E5E', label: '#8EAEDB' },
    dark: { highlight: '#2B4E7C', text: '#98C0F8', callout: '#27313F', label: '#6F95C9' },
  },
  {
    id: 'green',
    name: 'Green',
    light: { highlight: '#CBF1DA', text: '#23744D', callout: '#EAF9EF', label: '#6AA583' },
    dusk: { highlight: '#397B58', text: '#AEE7C5', callout: '#405247', label: '#8CC3A2' },
    dark: { highlight: '#155B3A', text: '#8BD0A8', callout: '#24352B', label: '#69A682' },
  },
  {
    id: 'rose',
    name: 'Rose',
    light: { highlight: '#FFDCDF', text: '#934954', callout: '#FEF1F2', label: '#CF7B86' },
    dusk: { highlight: '#97555E', text: '#FEC7CD', callout: '#5C4749', label: '#DE98A1' },
    dark: { highlight: '#753740', text: '#F1A6AE', callout: '#3D2B2D', label: '#C7737F' },
  },
  {
    id: 'violet',
    name: 'Violet',
    light: { highlight: '#E8E1FF', text: '#685696', callout: '#F5F3FE', label: '#8F7CC4' },
    dusk: { highlight: '#706199', text: '#DAD0FF', callout: '#4E4A5C', label: '#ADA0DC' },
    dark: { highlight: '#514278', text: '#C2B2F2', callout: '#312E3D', label: '#8F7CC4' },
  },
  {
    id: 'slate',
    name: 'Slate',
    light: { highlight: '#E3E6EB', text: '#5E646C', callout: '#F3F4F6', label: '#7D8794' },
    dusk: { highlight: '#676C74', text: '#D3D8DF', callout: '#4B4D4F', label: '#A3ACB8' },
    dark: { highlight: '#484E54', text: '#B8BEC6', callout: '#2F3032', label: '#8A94A1' },
  },
];

/**
 * The Notebook's own scheme, "Paper and ink": the office's blue turned a little toward indigo, on surfaces a hair warm.
 * Each value re-declares one office property inside the Notebook (the Designer's table, and the Desk app's `AppInk`):
 * `window` is `--ma-surface-window`, `sidebar` `--ma-surface-sunken`, the accents `--ma-accent*` and `--ma-focus-ring`,
 * `accentSubtle` `--ma-accent-subtle`, `onAccent` `--ma-text-on-accent`, `link` `--ma-text-link`. Text, borders, status and
 * danger stay the office's.
 */
export interface NotebookInk {
  window: string;
  sidebar: string;
  accent: string;
  accentHover: string;
  accentPressed: string;
  accentSubtle: string;
  onAccent: string;
  link: string;
}
export const NOTEBOOK_SCHEME_NAME = 'Paper and ink';
export const NOTEBOOK_SCHEME: Record<ThemeId, NotebookInk> = {
  light: { window: '#FFFCF6', sidebar: '#F6F2EA', accent: '#5C639F', accentHover: '#4F548F', accentPressed: '#424680', accentSubtle: '#E6EAFE', onAccent: '#FFFFFF', link: '#5C639F' },
  dusk: { window: '#4B5162', sidebar: '#444A5A', accent: '#BCC4F4', accentHover: '#CAD1FE', accentPressed: '#B0B7E7', accentSubtle: '#41445C', onAccent: '#1E232B', link: '#CAD1FE' },
  dark: { window: '#282724', sidebar: '#22201D', accent: '#9AA1D0', accentHover: '#A9B1E0', accentPressed: '#8B92BF', accentSubtle: '#30334A', onAccent: '#14171B', link: '#9AA1D0' },
};

const BY_ID = new Map<string, PaletteEntry>(PALETTE.map((p) => [p.id, p]));

/** A color this palette has. */
export function isPaletteId(v: unknown): v is PaletteId {
  return typeof v === 'string' && BY_ID.has(v);
}

/** A color as stored, or null for none or a name this build doesn't know. */
export function toPaletteId(v: unknown): PaletteId | null {
  return isPaletteId(v) ? v : null;
}

export function paletteEntry(id: PaletteId): PaletteEntry | undefined {
  return BY_ID.get(id);
}

export function paletteName(id: PaletteId | null | undefined): string {
  return (id && BY_ID.get(id)?.name) || '';
}

/** Where a color sorts in the menus: palette order, and none (or an unknown name) after every color. */
export function paletteRank(id: unknown): number {
  const i = isPaletteId(id) ? PALETTE.findIndex((p) => p.id === id) : -1;
  return i < 0 ? PALETTE.length : i;
}

/**
 * The light theme's values, for files that leave the app (HTML and Markdown exports, the notebook file), where there's no
 * theme: `model/colors.ts`' `PaletteColors`, `block` being the callout.
 */
export function exportPalette(): PaletteColors {
  return Object.fromEntries(
    PALETTE.map((p) => [p.id, { name: p.name, highlight: p.light.highlight, text: p.light.text, block: p.light.callout, label: p.light.label }]),
  ) as unknown as PaletteColors;
}

/** The properties the scheme re-declares, in order. */
export function schemeProps(ink: NotebookInk): [string, string][] {
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

/**
 * Where the scheme applies: the Notebook (`.ma-nb`), its menus (`.ma-nb-portal`), and on a desk the Notebook's own window,
 * title bar included (`.ma-window[data-app="notebook"]`, as the Desk app's `APP_INKS` scopes Files). Nothing outside them.
 */
export const SCHEME_SCOPE = ':is(.ma-nb, .ma-nb-portal, .ma-window[data-app="notebook"])';

/**
 * The palette and the scheme as CSS, per theme, in the shape of the Notebook's other tokens: `--ma-nb-amber-highlight`,
 * `-text`, `-callout`, `-label`, then the scheme's properties on `SCHEME_SCOPE`. Served with `notebookThemeCss()` by
 * vite-plugins/notebookThemes.ts.
 */
export function paletteCss(): string {
  const themes: ThemeId[] = ['light', 'dusk', 'dark'];
  const vars = (t: ThemeId): string =>
    PALETTE.flatMap((p) => (['highlight', 'text', 'callout', 'label'] as const).map((k) => `  --ma-nb-${p.id}-${k}: ${p[t][k]};`)).join('\n');
  const ink = (t: ThemeId): string => schemeProps(NOTEBOOK_SCHEME[t]).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  const parts = [`/* Generated from web/notebook/src/ui/palette.ts: the organizing colors and "${NOTEBOOK_SCHEME_NAME}". */`];
  parts.push(`:root {\n${vars('light')}\n}`, `:root ${SCHEME_SCOPE} {\n${ink('light')}\n}`);
  parts.push(`@media (prefers-color-scheme: dark) {\n:root:not([data-theme]) {\n${vars('dark')}\n}\n:root:not([data-theme]) ${SCHEME_SCOPE} {\n${ink('dark')}\n}\n}`);
  for (const t of themes) parts.push(`:root[data-theme="${t}"] {\n${vars(t)}\n}`, `:root[data-theme="${t}"] ${SCHEME_SCOPE} {\n${ink(t)}\n}`);
  return parts.join('\n');
}

/** Swatches in a color submenu: the six, then "None", in one row. */
export const SWATCH_COLUMNS = PALETTE.length + 1;
