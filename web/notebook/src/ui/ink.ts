// The Notebook's own ink, on its own so the office's glyph tokens can read it without the rest of the palette (`palette.ts` re-exports it).
import type { ThemeId } from '../theme/tokens.ts';

/**
 * The Notebook's own scheme, "Navy ink": the office's blue turned a little toward navy, on cool surfaces (hue 255, accent 262).
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
export const NOTEBOOK_SCHEME_NAME = 'Navy ink';
export const NOTEBOOK_SCHEME: Record<ThemeId, NotebookInk> = {
  light: { window: '#FBFCFE', sidebar: '#EFF3F8', accent: '#536992', accentHover: '#455B82', accentPressed: '#384D73', accentSubtle: '#E1ECFF', onAccent: '#FFFFFF', link: '#536992' },
  dusk: { window: '#4B5160', sidebar: '#444A59', accent: '#B6C8E9', accentHover: '#C2D5F6', accentPressed: '#A9BBDC', accentSubtle: '#3B475C', onAccent: '#1B2029', link: '#C2D5F6' },
  dark: { window: '#24272C', sidebar: '#1D2126', accent: '#94A5C5', accentHover: '#A3B5D5', accentPressed: '#8496B5', accentSubtle: '#2A354A', onAccent: '#14171B', link: '#94A5C5' },
};

