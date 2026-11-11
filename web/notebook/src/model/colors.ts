// Notebook colors as data (ADR 0091): highlight and text color on text, a color on blocks, a label on pages. What's
// stored is always a color's name, never a value: the binder tabs' six (`TAB_COLORS`), so one color means the same thing
// everywhere, a page labeled green, a green highlight and a green callout (the Product Designer's spec, `notebookColors`).
// A theme or a new palette never rewrites anyone's notes. The values for each name, per theme, are the UI's
// (`ui/palette.ts`); this file has none, so the desk's service, which bundles `model/` alone, never needs them. Pure.
import { TAB_COLORS, type TabColor } from './types.ts';

/** The six names, in the tabs' order. There's no red: red is for danger and errors. */
export const PALETTE_IDS = TAB_COLORS;
export type PaletteId = TabColor;

/** What the toolbar's one-click highlight writes, and what an old page's `yellow` reads as: today's yellow is amber. */
export const DEFAULT_HIGHLIGHT: PaletteId = 'amber';
/** The only highlight value before colors' names (design 3.12's one color). Kept as stored; read as amber. */
export const LEGACY_HIGHLIGHT = 'yellow';

/** Blocks that take `color`. A list's items are colored one by one; the lists themselves take it too, from import. */
export const COLOR_BLOCK_TYPES = ['paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem', 'taskItem', 'bulletList', 'orderedList', 'taskList'] as const;

export function isPaletteId(v: unknown): v is PaletteId {
  return typeof v === 'string' && (PALETTE_IDS as readonly string[]).includes(v);
}

/** A stored value as a name, or null for none. Anything else (a hex someone wrote, a later palette's name) draws as none. */
export function paletteId(v: unknown): PaletteId | null {
  return isPaletteId(v) ? v : null;
}

/** A highlight mark's `color` as a name: names as they are, the old `yellow` (or none at all) as amber, the default. */
export function highlightId(v: unknown): PaletteId | null {
  if (v === undefined || v === null || v === LEGACY_HIGHLIGHT) return DEFAULT_HIGHLIGHT;
  return paletteId(v);
}

/**
 * Light-theme values per name, for files that leave the app (HTML, Markdown, the notebook file), as `#RRGGBB`: the spec's
 * four roles. `name` is what a member reads ("Amber").
 */
export type PaletteColors = Record<PaletteId, { name: string; highlight: string; text: string; callout: string; label: string }>;
export type PaletteRole = 'highlight' | 'text' | 'callout' | 'label';

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)` or `rgba(...)` as [r, g, b], or null. Named colors aren't mapped. */
export function parseCssColor(css: string): [number, number, number] | null {
  const s = css.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return [...(m[1] as string)].map((c) => parseInt(c + c, 16)) as [number, number, number];
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) {
    const hex = m[1] as string;
    if (m[2] === '00') return null; // fully transparent: no color at all
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  }
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+%?)\s*)?\)$/.exec(s);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    const rgb = [m[1], m[2], m[3]].map((x) => Math.min(255, Number(x)));
    return rgb as [number, number, number];
  }
  return null;
}

/** A color that means "no color" in that role: near white behind text, near black or near white as text. */
function plainFor([r, g, b]: [number, number, number], role: PaletteRole): boolean {
  const light = Math.min(r, g, b) >= 0xf0;
  if (role === 'text') return light || Math.max(r, g, b) <= 0x40;
  return light;
}

/**
 * Foreign input (pasted HTML, an imported file from elsewhere): the name whose `role` color is nearest, by distance in RGB
 * weighted for the eye. Null if the color can't be read, so the caller drops it.
 */
export function nearestPaletteId(css: string, palette: PaletteColors, role: PaletteRole): PaletteId | null {
  const want = parseCssColor(css);
  if (!want) return null;
  // What other apps put on every run isn't a choice anyone made: a white page behind text, black or white text itself.
  if (plainFor(want, role)) return null;
  let best: PaletteId | null = null;
  let bestD = Infinity;
  for (const id of PALETTE_IDS) {
    const have = parseCssColor(palette[id]?.[role] ?? '');
    if (!have) continue;
    const rMean = (want[0] + have[0]) / 2;
    const dr = want[0] - have[0];
    const dg = want[1] - have[1];
    const db = want[2] - have[2];
    const d = (2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db;
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}
