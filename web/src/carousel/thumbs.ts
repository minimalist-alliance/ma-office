// Which of a desk's apps a phone's thumb row shows as tabs, and which go under its "+" (the UI/UX Engineer's call, Nov 14:
// staging's 360 px row had To-do scrolled out of reach behind the "+"). Pure, for the stage's chunk and `thumbs.test.ts`.
//
// - Every tab is a finger's 44 px at least, beside the row's own parts (its padding, the divider, "Back to the desk").
// - Everything fits: every app has a tab, and the "+" (where the desk's Apps row shows) opens the Apps sheet as before.
// - It doesn't: the "+" holds what's left ("More apps"), then the Apps sheet's row. Each app is treated alike, whatever kind
//   it is: the shown app always keeps its tab, an app that's coming later (Courier until its switch, `comingLater`) is the
//   first to go under the "+", then the last in the desk's order. The tabs keep the desk's order, so the marker and a swipe
//   still move one tab at a time.
import type { AppId } from '../canvas/layout';

/** A tab's least width: a finger's. */
export const THUMB_MIN = 44;
/** The row's own parts: its padding (8 and 10), the divider (1, with 12 and 10 around it) and "Back to the desk" (44). */
export const ROW_FIXED = 85;
/** The "+", kept whole (`.thumb.thumb-apps`). */
export const PLUS_W = 52;

export interface ThumbSplit {
  /** The apps with a tab, in the desk's order. */
  row: AppId[];
  /** The apps under the "+", in the desk's order. Empty when every app has its tab. */
  under: AppId[];
}

/**
 * The split for a row this wide (CSS px): `plus` is whether the "+" shows even with every app in the row (the desk's Apps row
 * shows); `later` says an app is coming later.
 */
export function splitThumbs(apps: readonly AppId[], shown: AppId | null, width: number, plus: boolean, later: (app: AppId) => boolean): ThumbSplit {
  const avail = width - ROW_FIXED;
  if (apps.length * THUMB_MIN + (plus ? PLUS_W : 0) <= avail) return { row: [...apps], under: [] };
  const room = Math.max(1, Math.floor((avail - PLUS_W) / THUMB_MIN)); // beside the "+"
  const rest = apps.filter((a) => a !== shown);
  const rank = [...(shown && apps.includes(shown) ? [shown] : []), ...rest.filter((a) => !later(a)), ...rest.filter((a) => later(a))];
  const keep = new Set(rank.slice(0, room));
  return { row: apps.filter((a) => keep.has(a)), under: apps.filter((a) => !keep.has(a)) };
}
