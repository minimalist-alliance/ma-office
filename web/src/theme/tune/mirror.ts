// This browser's copy of the member's theme-slider colours (`ma.appearance.v1`; `apply.ts` says why). Tiny and free of
// imports, since `theme/boot.ts` reads it before anything else paints: `layBootProps` sets the boot theme's custom
// properties on <html> with the first frame.
import type { ResolvedTheme } from '../resolve';

export const MIRROR_KEY = 'ma.appearance.v1';

/** Each theme's changed tokens, dotted keys (`surface.panel`) to the colour laid over today's. */
export type Flats = Partial<Record<ResolvedTheme, Record<string, string>>>;

export interface Mirror {
  /** The member whose setting this is (their `sub`). */
  who: string;
  blue: number;
  contrast: number;
  flats: Flats;
}

const THEMES: readonly ResolvedTheme[] = ['light', 'dusk', 'dark'];
const KEY = /^[a-z][A-Za-z]{0,31}\.[a-z][A-Za-z]{0,31}$/;
// Only what tokens.ts and the glass spell: hexes, rgba() colours, numbers and `r, g, b` (the canvas's glass, `tile*`), and the
// DOM glass's gradients and shadows of them (`glass.*`), in px, % and deg. No other word, so never a url(), a var() or a second
// declaration: nothing else is ever set as a property.
const VALUE = /^(?:[\da-fA-F\s,.%#)-]|rgba?\(|(?:conic|linear|radial)-gradient\(|ellipse|from|at|deg|px|inset)+$/;
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100 ? v : null);

/** Read strictly: anything off is no mirror at all. */
export function parseMirror(raw: string | null): Mirror | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as Partial<Mirror> | null;
    const blue = int(m?.blue);
    const contrast = int(m?.contrast);
    if (!m || typeof m.who !== 'string' || blue === null || contrast === null || !m.flats || typeof m.flats !== 'object') return null;
    const flats: Flats = {};
    for (const id of THEMES) {
      const f = (m.flats as Record<string, unknown>)[id];
      if (f === undefined) continue;
      if (!f || typeof f !== 'object') return null;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(f)) {
        if (!KEY.test(k) || typeof v !== 'string' || !VALUE.test(v)) return null;
        out[k] = v;
      }
      flats[id] = out;
    }
    return { who: m.who, blue, contrast, flats };
  } catch {
    return null;
  }
}

const kebab = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** A dotted key's custom property, themeCss.ts's rule: `surface.tile` is `--ma-surface-tile`, `accent.default` is `--ma-accent`. */
export function propOf(k: string): string {
  const [group = '', key = ''] = k.split('.');
  return key === 'default' ? `--ma-${kebab(group)}` : `--ma-${kebab(group)}-${kebab(key)}`;
}

/** The boot theme's laid colours (and glass) on <html>, with the first frame. `apply.ts` keeps them in step after. */
export function layBootProps(root: HTMLElement, theme: ResolvedTheme, raw: string | null): void {
  const m = parseMirror(raw);
  for (const [k, v] of Object.entries(m?.flats[theme] ?? {})) if (!k.startsWith('tile')) root.style.setProperty(propOf(k), v);
}
