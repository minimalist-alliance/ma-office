// The only file in this package with color literals (the Desk app's rule, ADR 0029).
//
// Commons draws its chrome with the Desk app's semantic tokens (`--ma-surface-window`,
// `--ma-text-primary`, `--ma-accent` and the rest, made by web/src/theme/themeCss.ts). These are
// the colors those tokens don't have: board inks, note fills and member colors. Each is stored on
// the board by name and drawn from the viewer's theme, so "ink" is dark on Light and light on Dark.
import type { Ink } from '../board/model.ts';

export type ThemeId = 'light' | 'dusk' | 'dark';
export const THEME_IDS: ThemeId[] = ['light', 'dusk', 'dark'];

export interface CommonsTokens {
  /** Strokes, shapes and text. `ink` follows the theme's primary text. */
  ink: Record<Ink, string>;
  /** Sticky note fills, by the same names, and the text on them. Notes are paper in every theme:
   *  muted pastels with dark text on Dusk and Dark, rather than dark tints that read as mud. */
  note: Record<Ink, string>;
  noteText: string;
  noteShadow: string;
  /** Cursors and avatars. The member's initial sits on it in memberFg. */
  member: string[];
  memberFg: string;
  /** The board's dot grid, the eraser's trail and the marquee fill. */
  grid: string;
  eraser: string;
  marquee: string;
}

const light: CommonsTokens = {
  ink: { ink: '#2B2D31', blue: '#3D6FA8', green: '#2A7D4F', amber: '#9A6A0C', red: '#C33A30', violet: '#7357B8' },
  note: { ink: '#ECEEF2', blue: '#DCE8F8', green: '#DBF0E2', amber: '#FBEFC4', red: '#F9DEDF', violet: '#E8E1F8' },
  noteText: '#2B2D31',
  noteShadow: 'rgba(20, 30, 50, 0.12)',
  member: ['#3D6FA8', '#2A7D4F', '#946200', '#C33A30', '#7357B8', '#1A7575', '#A8457F', '#5F6B7A'],
  memberFg: '#FFFFFF',
  grid: 'rgba(16, 24, 40, 0.13)',
  eraser: 'rgba(95, 97, 102, 0.28)',
  marquee: 'rgba(61, 111, 168, 0.08)',
};

const dusk: CommonsTokens = {
  ink: { ink: '#FAFAFA', blue: '#A6C3EC', green: '#8DD5A6', amber: '#EBC274', red: '#F4A399', violet: '#C7B8F0' },
  note: { ink: '#C9CED6', blue: '#B4CAEA', green: '#B3DCC1', amber: '#E8D18E', red: '#EBBDB8', violet: '#CFC4EC' },
  noteText: '#1E232B',
  noteShadow: 'rgba(15, 18, 24, 0.30)',
  member: ['#A6C3EC', '#8DD5A6', '#EBC274', '#F4A399', '#C7B8F0', '#8AD3D0', '#EBA9D2', '#C5CCD6'],
  memberFg: '#1E232B',
  grid: 'rgba(250, 250, 250, 0.14)',
  eraser: 'rgba(250, 250, 250, 0.22)',
  marquee: 'rgba(166, 195, 236, 0.10)',
};

const dark: CommonsTokens = {
  ink: { ink: '#ECEDEF', blue: '#7FA7DD', green: '#4CC27E', amber: '#E0A23A', red: '#F0646A', violet: '#A890E0' },
  note: { ink: '#AEB4BD', blue: '#9AB4D9', green: '#97C6A8', amber: '#D6BC6E', red: '#DBA3A0', violet: '#B4A6DA' },
  noteText: '#16181C',
  noteShadow: 'rgba(0, 0, 0, 0.40)',
  member: ['#7FA7DD', '#4CC27E', '#E0A23A', '#F0646A', '#A890E0', '#46B8B6', '#D77DB5', '#9AA5B3'],
  memberFg: '#14171B',
  grid: 'rgba(236, 237, 239, 0.10)',
  eraser: 'rgba(236, 237, 239, 0.20)',
  marquee: 'rgba(127, 167, 221, 0.10)',
};

export const COMMONS_THEMES: Record<ThemeId, CommonsTokens> = { light, dusk, dark };

/** `member[3]` becomes `--ma-cm-member-3`, `note.blue` `--ma-cm-note-blue`. */
export function commonsThemeCss(): string {
  const block = (t: CommonsTokens): string =>
    [
      ...Object.entries(t.ink).map(([k, v]) => `  --ma-cm-ink-${k}: ${v};`),
      ...Object.entries(t.note).map(([k, v]) => `  --ma-cm-note-${k}: ${v};`),
      `  --ma-cm-note-text: ${t.noteText};`,
      ...t.member.map((v, i) => `  --ma-cm-member-${i}: ${v};`),
      `  --ma-cm-member-fg: ${t.memberFg};`,
    ].join('\n');
  const parts = ['/* Generated from apps/commons/web/src/theme/tokens.ts. */', `:root {\n${block(light)}\n}`];
  parts.push(`@media (prefers-color-scheme: dark) {\n:root:not([data-theme]) {\n${block(dark)}\n}\n}`);
  for (const id of THEME_IDS) parts.push(`:root[data-theme="${id}"] {\n${block(COMMONS_THEMES[id])}\n}`);
  return parts.join('\n');
}

/** The theme the page shows: `data-theme` on <html>, else the system's preference. */
export function currentTheme(): ThemeId {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'light' || t === 'dusk' || t === 'dark') return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
