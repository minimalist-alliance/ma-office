// When the office reads `/v1/me` again by itself (the owner, Nov 16: "I had to refresh the page to see my avatar"): what
// the member changes in Account settings (their avatar, their name), or in another tab, shows without a reload. Pure; the
// listeners are `platform/session.ts`'s.

/** Coming back to the tab reads `/v1/me` at most this often, as stream quality's store asks (`quality/store.ts`). */
export const ME_RETURN_GAP_MS = 60_000;

/** Tests can shorten the gap, outside production builds only: `?meReturnGapMs=0`. */
export function returnGapMs(): number {
  if (import.meta.env.MODE === 'production') return ME_RETURN_GAP_MS;
  const raw = new URLSearchParams(window.location.search).get('meReturnGapMs');
  const n = raw === null ? NaN : Number(raw);
  return n >= 0 ? n : ME_RETURN_GAP_MS;
}

export interface ReturnState {
  /** The tab is hidden again (or still). */
  hidden: boolean;
  /** Signed in, with Platform's word on who (`me`), not only this browser's last-known record or nobody yet. */
  signedIn: boolean;
  known: boolean;
  now: number;
  /** When `/v1/me` was last asked for, by anything; 0 for never. */
  askedAt: number;
  gap: number;
}

/** Coming back to the tab: ask again only when it shows, someone signed in is known, and the last ask is `gap` ago or more. */
export function rereadOnReturn(s: ReturnState): boolean {
  return !s.hidden && s.signedIn && s.known && s.now - s.askedAt >= s.gap;
}
