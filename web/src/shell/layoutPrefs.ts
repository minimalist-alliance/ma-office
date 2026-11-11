// The member's preferences kept in the layout document's `prefs` (design 9.4), which Platform stores as it comes. Every
// other key in `prefs` is kept as it came and goes back as it came, so the free tier's chunk (`free/prefs.ts`) reads and
// writes its own keys here with no code of its own in this file. `layoutSync.ts` reads and saves them; a window reads them here.
import { create } from 'zustand';

export interface LayoutPrefs {
  /** "Show provider badges" in the Agent app. */
  showProviderBadges: boolean;
  /** Keys this file doesn't read, as the document had them or as `setLayoutPref` set them. */
  [key: string]: unknown;
}

const DEFAULTS: LayoutPrefs = { showProviderBadges: true };

export const useLayoutPrefs = create<LayoutPrefs>(() => DEFAULTS);

// Replaced, not merged, so nothing of one member's stays for the next.
export const resetLayoutPrefs = (): void => useLayoutPrefs.setState(DEFAULTS, true);

const obj = (raw: unknown): Record<string, unknown> => (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {});

/** What the document says, as far as this build understands it, with every other key as it came. */
export function adoptLayoutPrefs(raw: unknown): void {
  const r = obj(raw);
  const v = r['showProviderBadges'];
  useLayoutPrefs.setState({ ...r, showProviderBadges: typeof v === 'boolean' ? v : DEFAULTS.showProviderBadges }, true);
}

/** The document's `prefs` with what's chosen here written over it. */
export function withPrefs(raw: unknown): Record<string, unknown> {
  return { ...obj(raw), ...useLayoutPrefs.getState() };
}
