// The theme as a view gets it (contract 3.2, ADR 0065, ADR 0054): a flat map of the office's semantic tokens by their dotted
// names (`surface.window`, `text.primary`, `accent.default` …), plus `theme` and `font`, at start and again on a switch. A view
// sets them as `--ma-surface-window` and so on (the sample's `applyTheme`). The set only grows: `docs/app-api/view-bridge.md`.
// An app's own ink (`APP_INKS` in `theme/tokens.ts`, keyed `app:<manifest id>`, the Bible's Lapis first) is read from its
// window, where themes.css re-declares the inked properties: the view gets what its window shows, and importing `APP_INKS`
// here would put every ink in the first load's tokens chunk.
import { THEMES, type ThemeId } from '../../theme/tokens';

/** The UI font's family, which the frame loads from bytes for the view (`frame.ts`), and the stack after it. */
export const VIEW_FONT_FAMILY = 'Inter Variable';
const FONT_STACK = `"${VIEW_FONT_FAMILY}", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

const GROUPS = {
  surface: ['window', 'sunken', 'fill', 'fillStrong', 'overlay', 'scrim'],
  text: ['primary', 'secondary', 'tertiary', 'link', 'onAccent', 'disabled', 'danger'],
  glyph: ['default', 'soft', 'page'],
  accent: ['default', 'hover', 'pressed', 'subtle'],
  border: ['hairline', 'default', 'strong'],
  focus: ['ring'],
  status: ['online', 'warn', 'error'],
} as const;

/** The tokens an app's ink re-declares on its window's root (`theme/themeCss.ts` `appInkProps`), and the property for each. */
const INKED = [
  ['surface.window', '--ma-surface-window'],
  ['surface.sunken', '--ma-surface-sunken'],
  ['accent.default', '--ma-accent'],
  ['accent.hover', '--ma-accent-hover'],
  ['accent.pressed', '--ma-accent-pressed'],
  ['accent.subtle', '--ma-accent-subtle'],
  ['focus.ring', '--ma-focus-ring'],
  ['text.onAccent', '--ma-text-on-accent'],
  ['text.link', '--ma-text-link'],
] as const;

/**
 * The tokens for `theme`, with the ink of the window `at` sits in (the view's frame): outside an inked window (another app's,
 * an open tile, the phone carousel) the office's own, as the app's window rule says. Read after the theme's `data-theme` is set.
 */
export function viewTokens(theme: ThemeId, at?: Element | null): Record<string, string> {
  const t = THEMES[theme] as unknown as Record<string, Record<string, unknown>>;
  const out: Record<string, string> = { theme, font: FONT_STACK };
  for (const [group, keys] of Object.entries(GROUPS)) {
    for (const key of keys) {
      const v = t[group]?.[key];
      if (typeof v === 'string') out[`${group}.${key}`] = v;
    }
  }
  if (at?.closest('.ma-window[data-app]')) {
    const css = getComputedStyle(at);
    for (const [token, prop] of INKED) {
      const v = css.getPropertyValue(prop).trim();
      if (v) out[token] = v;
    }
  }
  return out;
}
