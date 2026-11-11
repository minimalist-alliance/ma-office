// Where a menu goes, as pure math (tests/unit/menuPlacement.test.ts).
//
// On a desktop a context menu opens at the pointer, or under the focused thing from the keyboard, and flips to stay on screen.
// On a phone ("compact": narrow, or a coarse pointer) it never covers what it acts on: the selection, or the row that was
// pressed. It goes wholly below that, or wholly above it, or, if neither side has room for all of it, on the side with more
// room, shortened to fit and scrolling inside. Submenus open in place there (Menu.tsx), so one rectangle is all it needs.

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Placement {
  left: number;
  top: number;
  /** Set when the menu has to scroll to fit. */
  maxHeight?: number;
  /** Set on a phone: the menu's width. */
  width?: number;
}

export const EDGE = 8;
const GAP = 6;
/** Below this many pixels on both sides, a phone's menu takes what it can and scrolls. */
const MIN_SIDE = 96;
/** A phone's menu is as wide as this, or the screen less its edges. */
export const COMPACT_WIDTH = 300;

export const rectOf = (r: { left: number; top: number; right: number; bottom: number }): Rect => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
export const pointRect = (x: number, y: number): Rect => ({ left: x, top: y, right: x, bottom: y });
export const overlaps = (a: Rect, b: Rect): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** A desktop menu at a point (a right click) or under a rectangle (a key, on a focused row or a selection). */
export function placeMenu(anchor: Rect, size: { w: number; h: number }, view: { w: number; h: number }): Placement {
  const point = anchor.left === anchor.right && anchor.top === anchor.bottom;
  let left = anchor.left;
  let top = point ? anchor.top : anchor.bottom + 4;
  if (left + size.w > view.w - EDGE) left = point ? anchor.left - size.w : anchor.right - size.w;
  if (top + size.h > view.h - EDGE) top = (point ? anchor.top : anchor.top - 4) - size.h;
  left = Math.max(EDGE, Math.min(left, view.w - size.w - EDGE));
  const maxHeight = view.h - 2 * EDGE;
  top = Math.max(EDGE, Math.min(top, view.h - Math.min(size.h, maxHeight) - EDGE));
  return size.h > maxHeight ? { left, top, maxHeight } : { left, top };
}

/** A submenu beside its item: to the right of its menu, or to the left if there's no room, level with the item. */
export function placeSubmenu(item: Rect, menu: Rect, size: { w: number; h: number }, view: { w: number; h: number }): Placement {
  let left = menu.right - 4;
  if (left + size.w > view.w - EDGE) left = menu.left - size.w + 4;
  left = Math.max(EDGE, Math.min(left, view.w - size.w - EDGE));
  const maxHeight = view.h - 2 * EDGE;
  let top = item.top - 6;
  top = Math.max(EDGE, Math.min(top, view.h - Math.min(size.h, maxHeight) - EDGE));
  return size.h > maxHeight ? { left, top, maxHeight } : { left, top };
}

/**
 * A phone's menu, clear of `avoid` (the selection, or the pressed row) whatever happens. Centered on it across, as far as the
 * screen allows, then below it, above it, or on the roomier side, shortened.
 */
export function placeCompact(avoid: Rect, height: number, view: { w: number; h: number }): Placement {
  const width = Math.min(COMPACT_WIDTH, view.w - 2 * EDGE);
  const centre = (avoid.left + avoid.right) / 2;
  const left = Math.max(EDGE, Math.min(centre - width / 2, view.w - width - EDGE));
  const below = view.h - EDGE - (avoid.bottom + GAP);
  const above = avoid.top - GAP - EDGE;
  if (height <= below) return { left, top: avoid.bottom + GAP, width };
  if (height <= above) return { left, top: avoid.top - GAP - height, width };
  if (below >= above && below >= MIN_SIDE) return { left, top: avoid.bottom + GAP, width, maxHeight: below };
  if (above >= MIN_SIDE) return { left, top: EDGE, width, maxHeight: above };
  // Neither side has room (a selection as tall as the screen): the larger side all the same, never over it.
  return below >= above
    ? { left, top: avoid.bottom + GAP, width, maxHeight: Math.max(0, below) }
    : { left, top: EDGE, width, maxHeight: Math.max(0, above) };
}
