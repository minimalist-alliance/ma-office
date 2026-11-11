// DRAFT, not imported by the app: tile G, the Alliance Member tile, from the membership card proposal ("Copy"). Cards C,
// D and E, drafted here first, are live in `membershipCards.tsx` since `/v1/me` says why a membership stopped (ma-platform
// contract desks.md 0.3.69). Tile G waits for that tier to be on sale, its price, and a `membership.tier` for it.

// ----- G: the Alliance Member tile. A desk-sized slot in canvas space beside the member's desk (the Look), which is
// canvas work in `src/canvas/` and waits for that tier to be on sale. Only its words and "Not now" are drafted here.
export const TILE_G = {
  title: 'Room for work and life',
  body: 'Membership adds a Personal and a Work desk, each its own private desk. Move up any time and pay only the difference for the rest of the month.',
  action: 'See membership',
  notNow: 'Not now',
} as const;

/** Proposal point 7: "Not now" hides the tile for 30 days, in this browser. */
export const TILE_G_QUIET_MS = 30 * 24 * 60 * 60 * 1000;
export const TILE_G_KEY = 'ma.tileG.notNow.v1';

/** Whether tile G may show, given when "Not now" was last pressed (ms since epoch, or nothing). */
export function tileGShows(notNowAt: number | null, now: number): boolean {
  return notNowAt === null || !Number.isFinite(notNowAt) || notNowAt > now || now - notNowAt >= TILE_G_QUIET_MS;
}
