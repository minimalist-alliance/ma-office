// The member's preferences kept in the layout document's `prefs` (design 9.4), which Platform stores as it comes. Everything
// else in `prefs` goes back as it came. `layoutSync.ts` reads and saves them; a window reads them here.
import { create } from 'zustand';

export interface LayoutPrefs {
  /** "Show provider badges" in the Agent app. */
  showProviderBadges: boolean;
}

const DEFAULTS: LayoutPrefs = { showProviderBadges: true };

export const useLayoutPrefs = create<LayoutPrefs>(() => DEFAULTS);

export const resetLayoutPrefs = (): void => useLayoutPrefs.setState(DEFAULTS);

/** What the document says, as far as this build understands it. */
export function adoptLayoutPrefs(raw: unknown): void {
  const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)['showProviderBadges'] : undefined;
  const next = typeof v === 'boolean' ? v : DEFAULTS.showProviderBadges;
  if (next !== useLayoutPrefs.getState().showProviderBadges) useLayoutPrefs.setState({ showProviderBadges: next });
}

/** The document's `prefs` with what's chosen here written over it. */
export function withPrefs(raw: unknown): Record<string, unknown> {
  return { ...(raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}), showProviderBadges: useLayoutPrefs.getState().showProviderBadges };
}
