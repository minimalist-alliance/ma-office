// Desk and app geometry in world units (design 3.3, ADR 0062). A desk has a size of its own, and its
// apps have positions and sizes inside it, in the desk's coordinates. Below them runs a 44-unit strip.
// Phones keep the old cell grid: there, positions come from first-fit, row-major packing of the
// ordered list and aren't read at all. A cell pitch of 92 is a 76 tile plus a 16 gap.
/** `open` is the live app docked to its tile (ADR 0053), above `large`; the phone grid draws it as `large`. */
export type DetailLevel = 'icon' | 'small' | 'wide' | 'large' | 'open';
/**
 * The apps a desk's panel can hold. `agent` is the lead agent's, which opens the whole desk team. `commons` is a Guild
 * Desk's room (task 48): only a guild's panel has it, as only a member's own desks have a Browser.
 */
export type CoreAppId = 'notebook' | 'browser' | 'chat' | 'agent' | 'commons' | 'files';
/** Every other agent is its own app (task 49 item 6): `agent:<agentId>`. See `agentTiles.ts`. */
export type AgentAppId = `agent:${string}`;
export type AppId = CoreAppId | AgentAppId;

const AGENT_APP = /^agent:[a-z0-9][a-z0-9_-]{0,63}$/;
/** An agent's own app, with an id as desk-agent makes them (`ag-` and 12 base32 characters), or a test's. */
export const isAgentApp = (app: unknown): app is AgentAppId => typeof app === 'string' && AGENT_APP.test(app);
export const agentApp = (agentId: string): AgentAppId => `agent:${agentId}`;
export const agentIdOf = (app: string): string | null => (isAgentApp(app) ? app.slice('agent:'.length) : null);
/** What kind of app this is: an agent's own app is an Agent, with its window and its size. */
export const baseApp = (app: AppId): CoreAppId => (isAgentApp(app) ? 'agent' : app);

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutItem extends Rect {
  id: string;
  app: AppId;
}

export interface LayoutDesk extends Rect {
  id: string;
  /** The phone grid's order, and nothing else. How the apps stack is `stack`. */
  items: LayoutItem[];
  /** Item ids, bottom to top (ADR 0064). Left out while it says what the order of `items` says. Read it with `stackOrder`. */
  stack?: string[];
  /** The desk's style, which the member picks from its menu (`theme/deskStyles.ts`). Left out until they do: then it's the default. */
  style?: string;
  /**
   * Carousel mode (the owner, Nov 9): on, each app shows one at a time across the desk, and `app` is the one showing.
   * Left out on a desk that never had it, so it saves as it always did; off keeps `app` for the next time it's on.
   */
  carousel?: DeskCarousel;
}

export interface DeskCarousel {
  on: boolean;
  app: AppId;
}

export interface Slot extends Rect {
  level: DetailLevel;
}

export const G = {
  cell: 76,
  gap: 16,
  pitch: 92,
  padX: 24,
  padTop: 24,
  strip: 44,
  panelRadius: 22,
  tileRadius: 18,
  widgetRadius: 20,
  edge: 8, // how close an app can come to a desk's top and sides
  minApp: 56, // so the glyph and the pointer target stay usable (ADR 0062)
  appHandle: 20,
  appHandleTouch: 28,
  minDeskW: 232, // the longest status line, between its dot and the grip: 40 + 161 + 28, and a little over
  minDeskH: 124, // a minimum-size app, with the top padding and the strip
  phoneCols: 4,
} as const;

export const panelW = (cols: number): number => 2 * G.padX - G.gap + G.pitch * cols;
export const panelH = (rows: number): number => G.padTop + G.strip - G.gap + G.pitch * rows;
export const span = (cells: number): number => cells * G.cell + (cells - 1) * G.gap;

/** World sizes are kept to a hundredth of a unit: continuous to the eye, and short in the layout doc. */
export const roundUnit = (v: number): number => Math.round(v * 100) / 100;

/** Cells (w, h) of each detail level on the phone grid. Two cells is 168 and four is 352, the ADR's thresholds. */
export const CELLS: Record<DetailLevel, { w: number; h: number }> = {
  icon: { w: 1, h: 1 },
  small: { w: 2, h: 2 },
  wide: { w: 4, h: 2 },
  large: { w: 4, h: 4 },
  open: { w: 6, h: 5 },
};

/**
 * Where a tile turns `open` (ADR 0053), in cells: 6 x 5, or an app's own minimum where its window needs more. The registry
 * entry reads it as `openMin` (`apps/registry.tsx`); it's here because this file is pure and the registry holds the windows.
 */
const OPEN_MIN: Partial<Record<CoreAppId, { w: number; h: number }>> = { browser: { w: 7, h: 5 } };
export const openMin = (app?: AppId): { w: number; h: number } => (app && OPEN_MIN[baseApp(app)]) || CELLS.open;

let openLevel = true;
/** The kill switch (client-config `openTiles`, `opentile/door.ts`): off, nothing goes past `large`. */
export const setOpenLevel = (on: boolean): void => {
  openLevel = on;
};

/** The largest level that fits in both directions (ADR 0062, 0053). Below small it's an icon. */
export function detailLevel(w: number, h: number, app?: AppId): DetailLevel {
  const open = openMin(app);
  if (openLevel && w >= span(open.w) && h >= span(open.h)) return 'open';
  if (w >= span(4) && h >= span(4)) return 'large';
  if (w >= span(4) && h >= span(2)) return 'wide';
  if (w >= span(2) && h >= span(2)) return 'small';
  return 'icon';
}

/** An icon's glyph is about 60% of the tile, as in the mockup: 48 on a 76 tile. */
export const iconGlyphSize = (w: number, h: number): number => Math.round((Math.min(w, h) * 48) / 76);

export const levelSize = (level: DetailLevel): { w: number; h: number } => ({ w: span(CELLS[level].w), h: span(CELLS[level].h) });

const SMALLER: Record<DetailLevel, DetailLevel | null> = { open: 'large', large: 'wide', wide: 'small', small: 'icon', icon: null };

/** An item wider than its grid renders at the next level that fits. */
export function fittedLevel(level: DetailLevel, cols: number): DetailLevel {
  let s: DetailLevel = level;
  while (CELLS[s].w > cols) {
    const next = SMALLER[s];
    if (!next) break;
    s = next;
  }
  return s;
}

export function packItems(items: readonly { id: string; level: DetailLevel }[], cols: number): { slots: Record<string, Slot>; rows: number } {
  const taken: boolean[][] = [];
  const isFree = (r: number, c: number): boolean => !taken[r]?.[c];
  const slots: Record<string, Slot> = {};
  let rows = 0;
  for (const item of items) {
    const level = fittedLevel(item.level, cols);
    const { w: cw, h: ch } = CELLS[level];
    let placed = false;
    for (let r = 0; !placed; r += 1) {
      for (let c = 0; c <= cols - cw; c += 1) {
        let fits = true;
        for (let dr = 0; dr < ch && fits; dr += 1) {
          for (let dc = 0; dc < cw && fits; dc += 1) fits = isFree(r + dr, c + dc);
        }
        if (!fits) continue;
        for (let dr = 0; dr < ch; dr += 1) {
          taken[r + dr] ??= [];
          for (let dc = 0; dc < cw; dc += 1) taken[r + dr]![c + dc] = true;
        }
        slots[item.id] = { x: G.padX + c * G.pitch, y: G.padTop + r * G.pitch, w: span(cw), h: span(ch), level };
        rows = Math.max(rows, r + ch);
        placed = true;
        break;
      }
    }
  }
  return { slots, rows };
}

const withLevels = (items: readonly LayoutItem[]): { id: string; level: DetailLevel }[] => items.map((i) => ({ id: i.id, level: detailLevel(i.w, i.h, i.app) }));

export interface DeskGeometry {
  w: number;
  h: number;
  slots: Record<string, Slot>;
}

export function deskGeometry(desk: LayoutDesk, phone = false): DeskGeometry {
  if (phone) {
    const { slots, rows } = packItems(withLevels(desk.items), G.phoneCols);
    return { w: panelW(G.phoneCols), h: panelH(Math.max(rows, 1)), slots };
  }
  const slots: Record<string, Slot> = {};
  for (const i of desk.items) slots[i.id] = { x: i.x, y: i.y, w: i.w, h: i.h, level: detailLevel(i.w, i.h, i.app) };
  return { w: desk.w, h: desk.h, slots };
}

/** World-space box of a desk, used for camera fitting and culling. */
export function deskBounds(desk: LayoutDesk, phone = false): Rect {
  const g = deskGeometry(desk, phone);
  return { x: desk.x, y: desk.y, w: g.w, h: g.h };
}

export function unionBounds(rects: readonly Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** The smallest a desk can be and still hold its apps above the strip. */
export function minDeskSize(items: readonly Rect[]): { w: number; h: number } {
  let w: number = G.minDeskW;
  let h: number = G.minDeskH;
  for (const i of items) {
    w = Math.max(w, i.x + i.w + G.edge);
    h = Math.max(h, i.y + i.h + G.strip);
  }
  return { w, h };
}

/** A size the desk can take: free above its minimum, and never smaller than what it holds. */
export function fitDeskSize(items: readonly Rect[], w: number, h: number): { w: number; h: number } {
  const min = minDeskSize(items);
  return { w: roundUnit(Math.max(min.w, w)), h: roundUnit(Math.max(min.h, h)) };
}

/** A desk as the old cell grid would draw it. Saved layouts from before free placement become this. */
export function deskFromGrid(d: {
  id: string;
  x: number;
  y: number;
  cols: number;
  rows: number;
  items: readonly { id: string; app: AppId; level: DetailLevel }[];
}): LayoutDesk {
  const cols = Math.max(2, d.cols);
  const { slots, rows } = packItems(d.items, cols);
  const items = d.items.map((i) => {
    const s = slots[i.id]!;
    return { id: i.id, app: i.app, x: s.x, y: s.y, w: s.w, h: s.h };
  });
  return { id: d.id, x: d.x, y: d.y, w: Math.max(panelW(cols), G.minDeskW), h: panelH(Math.max(d.rows, rows, 1)), items };
}

export const DEFAULT_ITEMS: readonly CoreAppId[] = ['chat', 'notebook', 'browser', 'agent'];

/**
 * A new primary desk: 584 x 236, with the four apps as icons in a row of six at the top. Two rows is 168 of
 * work height, so there's a free band under them to move through and room to reach widget height (ADR 0062).
 * Only a desk with nothing saved gets this: a saved or migrated one keeps its own size.
 */
export function defaultDesk(id: string, x: number, y: number, apps: readonly AppId[] = DEFAULT_ITEMS): LayoutDesk {
  return deskFromGrid({ id, x, y, cols: 6, rows: 2, items: apps.map((app) => ({ id: `${id}:${app}`, app, level: 'icon' })) });
}

/** New desks go to the first free slot right of the last desk in the bottom row (design 3.7). */
export function placeNewDesk(existing: readonly LayoutDesk[]): { x: number; y: number } {
  if (!existing.length) return { x: 0, y: 0 };
  const bottom = Math.max(...existing.map((d) => d.y));
  const row = existing.filter((d) => d.y === bottom);
  const right = Math.max(...row.map((d) => d.x + d.w));
  return { x: right + 72, y: bottom };
}

// ----- the strip along a desk's bottom edge (ADR 0064). Its status line is in desk units and scales with the
// camera, at the strip's left. The etched name (at its center) and icons (at its right) are part of the desk's surface
// and scale with it (ADR 0064, Nov 9 note): the sizes here are at 100 %, in desk units, and on screen they're times the
// zoom. Both hide when the name would be under ETCH_MIN_PX.

/** The etched name's size at 100 % zoom; on screen it's this times the zoom. */
export const ETCH_SIZE = 14;
/** Under this many CSS px on screen the name hides: it can't be read. */
export const ETCH_MIN_PX = 7;
/** Does the name show at this zoom? */
export const nameShows = (s: number): boolean => ETCH_SIZE * s >= ETCH_MIN_PX;
/** The raster scale for the name at this zoom: the device scale, doubled each time the zoom passes a power of two above 100 %, so a zoom in stays sharp without a bitmap per wheel tick. */
export const nameRaster = (q: number, s: number): number => q * (s <= 1 ? 1 : Math.min(4, 2 ** Math.ceil(Math.log2(s))));
/** An etched icon's box. */
export const ETCH_ICON = 16;
/** The name's baseline above the desk's bottom edge at 100 % zoom; on screen it's this times the zoom. */
export const ETCH_BASELINE = 17;
/** How far the cut goes, at every raster scale: a CSS pixel, so 2 device pixels at 2x. */
export const ETCH_DEPTH = 1;

export const STRIP = {
  dotX: G.padX + 4,
  /** Where the status text starts, and how far along it starts with a provider mark beside it. */
  textX: G.padX + 16,
  markW: 20,
  /** How close the name comes to the status line, the icons or the desk's edges. */
  clear: 12,
  /** A desk under either of these, in desk units, has no icons, which clears the way for the name. */
  iconsMinW: 290,
  iconsMinH: 72,
  /** Every icon's center above the bottom edge: the name's center line, with its lip. */
  iconUp: 22,
  target: 28,
  targetTouch: 44,
  /** Between two icons' targets, and from the grip's target to the desk's right edge. On touch a target is its own margin. */
  gap: 8,
  gripRight: 6,
  /** What the hidden count's slot adds to an icon's target for its number. With a digit centered in it, the count's ink is as far from cleanup's as cleanup's is from the grip's. */
  countNumber: 18,
  padRadius: 8,
  /**
   * Under this width, in desk units, the carousel's switch isn't in the row, and its slot isn't held: the row is the grip,
   * cleanup and the count as it always was. The icons scale with the desk, so this is the desk's own size and no zoom's.
   * Past it, the longest status line still fits beside the switch (`layout.test.ts`).
   */
  switchMinW: 300,
} as const;

export const stripTarget = (touch: boolean): number => (touch ? STRIP.targetTouch : STRIP.target);

/** The hidden count's slot: an icon's target, and room for its number. 46 px with a mouse. */
export const countSlotW = (touch: boolean): number => stripTarget(touch) + STRIP.countNumber;

/** Do the icons show at all? The first thing to go when there's no room. */
export const iconsFit = (wPx: number, hPx: number): boolean => wPx >= STRIP.iconsMinW && hPx >= STRIP.iconsMinH;

/** The longest status line, in desk units: what `G.minDeskW` was made to hold between its dot and the grip. */
export const STATUS_LONGEST = 161;

/**
 * Is the carousel's switch in the row of a desk `w` by `h` units? Only with its icons showing, at least `switchMinW` wide,
 * and with the longest status line still fitting beside it. The icons scale with the desk, so no zoom comes into it.
 */
export function switchFits(w: number, h: number): boolean {
  if (!iconsFit(w, h) || w < STRIP.switchMinW) return false;
  const clear = slotRight('carousel', false) + (STRIP.target + ETCH_ICON) / 2;
  return w - STRIP.textX - clear >= STATUS_LONGEST;
}

/**
 * Each icon's slot, from the desk's right edge to the slot's right end: the grip, the carousel's switch (`withSwitch`,
 * on a desk wide enough on screen for it: `switchFits`), cleanup, then the hidden count, a gap apart, so the row is even
 * and has no hole in it. `heldW` is how wide cleanup's slot is held,
 * and 0 when it isn't: with a mouse it's held whenever the desk needs cleaning up, at rest too, so the count doesn't
 * move when the pointer comes and the sparkle with it. Like the grip's and the switch's slots, which are held at rest,
 * so the switch is in the same place in both modes.
 */
export function slotRight(slot: 'grip' | 'carousel' | 'cleanup' | 'count', touch: boolean, heldW = 0, withSwitch = false): number {
  const grip = touch ? 0 : STRIP.gripRight;
  if (slot === 'grip') return grip;
  const gap = touch ? 0 : STRIP.gap;
  const carousel = grip + stripTarget(touch) + gap;
  if (slot === 'carousel') return carousel;
  const cleanup = withSwitch ? carousel + stripTarget(touch) + gap : carousel;
  if (slot === 'cleanup') return cleanup;
  return heldW ? cleanup + heldW + gap : cleanup;
}

/**
 * A panel's corner is 22 units round, so it grows with the zoom while the grip doesn't. Past about 1.45x the
 * grip's hover pad, a 28 px square with an 8 px radius, would poke out of the corner, so the whole row moves
 * in by this much to keep it on the panel. Nothing moves below that.
 */
export function cornerInset(s: number): number {
  const r = G.panelRadius * s;
  const px = STRIP.padRadius;
  const padX = STRIP.gripRight + px; // its round corner's center, from the desk's right edge
  const padY = STRIP.iconUp - STRIP.target / 2 + px; // and from its bottom edge
  if (r <= padY) return 0;
  return Math.max(0, r - padX - Math.sqrt((r - px) ** 2 - (r - padY) ** 2));
}

/**
 * From the desk's right edge to the left end of what's in the way of the name. The grip's slot stays
 * reserved even at rest, so the name doesn't change when the pointer enters the desk, and so does cleanup's
 * while it's held. `heldW` is that slot's width, and 0 when it isn't held. `count` is whether the hidden count shows.
 */
export function iconsLeft(touch: boolean, inset: number, heldW: number, count: boolean, withSwitch = false): number {
  if (count) return slotRight('count', touch, heldW, withSwitch) + countSlotW(touch) + inset;
  if (heldW) return slotRight('cleanup', touch, 0, withSwitch) + heldW + inset;
  return slotRight(withSwitch ? 'carousel' : 'grip', touch) + stripTarget(touch) + inset;
}

/** How wide the name can be: centered on the desk, and `clear` from everything at either side. 0 on either side is the desk's edge. */
export function nameRoom(deskPx: number, leftEndPx: number, rightPx: number): number {
  const half = deskPx / 2;
  return Math.max(0, 2 * (half - Math.max(leftEndPx, rightPx) - STRIP.clear));
}

/** Where the status text stops, from the desk's right edge: the hidden count, cleanup's slot while it's held, or the glyph of the carousel's switch or the grip. */
export function statusClear(touch: boolean, inset: number, heldW: number, count: boolean, withSwitch = false): number {
  if (count || heldW) return iconsLeft(touch, inset, heldW, count, withSwitch);
  return slotRight(withSwitch ? 'carousel' : 'grip', touch) + (stripTarget(touch) + ETCH_ICON) / 2 + inset;
}

/** How far the carousel's stage stands in from the desk's top and sides, in desk units. Its bottom is the strip's top. */
export const CAROUSEL_INSET = 12;

/** The carousel's stage on a desk of this size, in the desk's own units: all of the panel above the strip, a little in. */
export const carouselStage = (w: number, h: number): Rect => ({
  x: CAROUSEL_INSET,
  y: CAROUSEL_INSET,
  w: Math.max(0, w - 2 * CAROUSEL_INSET),
  h: Math.max(0, h - CAROUSEL_INSET - G.strip),
});

/** How much of the strip the status text can use, in desk units, up to `rightPx` from the desk's right edge on screen. */
export const statusRoom = (deskW: number, textX: number, s: number, rightPx: number): number => deskW - textX - rightPx / s;

/** The name hides rather than show fewer than this many characters before its ellipsis. */
export const MIN_NAME_CHARS = 4;

/** All of the name if it fits, its start with an ellipsis if at least four characters fit, and otherwise nothing. */
export function fitNameText(text: string, room: number, widthOf: (s: string) => number): string {
  if (widthOf(text) <= room) return text;
  const cut = fitToWidth(text, room, widthOf);
  return Array.from(cut).length - 1 >= MIN_NAME_CHARS && widthOf(cut) <= room ? cut : '';
}

/** All of this text if it fits, otherwise as much of its start as fits with an ellipsis. */
export function fitToWidth(text: string, room: number, widthOf: (s: string) => number): string {
  if (widthOf(text) <= room) return text;
  const chars = Array.from(text);
  const cut = (n: number): string => `${chars.slice(0, n).join('').trimEnd()}…`;
  let lo = 0;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (widthOf(cut(mid)) <= room) lo = mid;
    else hi = mid - 1;
  }
  return cut(lo);
}

// ----- free placement (ADR 0062, 0064). Apps stay above the strip and inside the desk, at their minimum size or
// larger, and anything can go over anything. A desk's `stack` says how they're stacked. Its `items` list is only
// the phone grid's order, and nothing stacks there.

export interface Point {
  x: number;
  y: number;
}

// Everything stored has two decimals (roundUnit), so an edge and its neighbor differ only by float noise.
const EPS = 1e-6;
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Where an app can be on a desk of this size. It may reach the strip's top edge. */
export const workArea = (w: number, h: number): Rect => ({ x: G.edge, y: G.edge, w: w - 2 * G.edge, h: h - G.edge - G.strip });

/** Touching isn't overlapping. */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
}

/** In the work area, and at least the minimum size. */
export function isPlaced(r: Rect, area: Rect): boolean {
  const inside = r.x >= area.x - EPS && r.y >= area.y - EPS && r.x + r.w <= area.x + area.w + EPS && r.y + r.h <= area.y + area.h + EPS;
  return inside && r.w >= G.minApp - EPS && r.h >= G.minApp - EPS;
}

/** A move: exactly where it's asked, as far as the desk's edges allow. */
export function clampMove(r: Rect, to: Point, area: Rect): Point {
  return { x: roundUnit(clamp(to.x, area.x, area.x + area.w - r.w)), y: roundUnit(clamp(to.y, area.y, area.y + area.h - r.h)) };
}

/** A resize from the bottom-right corner: exactly what's asked, from the minimum size up to the desk's edges. */
export function clampResize(r: Rect, w: number, h: number, area: Rect): { w: number; h: number } {
  return { w: roundUnit(clamp(w, G.minApp, area.x + area.w - r.x)), h: roundUnit(clamp(h, G.minApp, area.y + area.h - r.y)) };
}

/** An arrow key: one step, stopping only at the edge of the work area. Null if it can't go further. */
export function nudgeMove(r: Rect, dx: -1 | 0 | 1, dy: -1 | 0 | 1, step: number, area: Rect): Point | null {
  const next = clampMove(r, { x: r.x + dx * step, y: r.y + dy * step }, area);
  return Math.abs(next.x - r.x) < EPS && Math.abs(next.y - r.y) < EPS ? null : next;
}

/** An arrow key while resizing. Null if it can't change. */
export function nudgeResize(r: Rect, dw: -1 | 0 | 1, dh: -1 | 0 | 1, step: number, area: Rect): { w: number; h: number } | null {
  const next = clampResize(r, r.w + dw * step, r.h + dh * step, area);
  return Math.abs(next.w - r.w) < EPS && Math.abs(next.h - r.h) < EPS ? null : next;
}

/**
 * A desk's apps, bottom to top: the ones `stack` lists, in its order, then any it doesn't, in the list's order.
 * Ids that aren't on this desk, and repeats, don't count. With no `stack` it's just the list's order.
 */
export function stackOrder(desk: Pick<LayoutDesk, 'items' | 'stack'>): string[] {
  const ids = desk.items.map((i) => i.id);
  if (!desk.stack) return ids;
  const known = new Set(ids);
  return [...new Set([...desk.stack.filter((id) => known.has(id)), ...ids])]; // a Set keeps what came first
}

/** This desk stacked in this order. An order that says what the list says isn't stored, so a desk that never stacked saves as it always did. */
export function withStack(desk: LayoutDesk, order: readonly string[]): LayoutDesk {
  const next = { ...desk };
  delete next.stack;
  const same = order.length === desk.items.length && order.every((id, n) => id === desk.items[n]!.id);
  if (!same) next.stack = [...order];
  return next;
}

/** This app at the front or the back of a stacking order. The same array if it's already there, or isn't in it. */
export function restacked(order: readonly string[], itemId: string, to: 'front' | 'back'): readonly string[] {
  if (!order.includes(itemId) || (to === 'front' ? order[order.length - 1] : order[0]) === itemId) return order;
  const rest = order.filter((id) => id !== itemId);
  return to === 'front' ? [...rest, itemId] : [itemId, ...rest];
}

/**
 * The apps that overlap one below them in the stack (ADR 0064), which are the ones that need the stronger look to
 * read against what's under them. Worked out when a layout changes, never per pointer move. The bottom app never counts.
 */
export function overOthers(desk: Pick<LayoutDesk, 'items' | 'stack'>): Set<string> {
  const byId = new Map(desk.items.map((i) => [i.id, i]));
  const below: LayoutItem[] = [];
  const over = new Set<string>();
  for (const id of stackOrder(desk)) {
    const item = byId.get(id)!;
    if (below.some((b) => overlaps(item, b))) over.add(id);
    below.push(item);
  }
  return over;
}

/** The smallest box of an app left showing, in units, that's still something to press (ADR 0064). */
export const HIDDEN_MIN = 12;

/**
 * Is there a box of HIDDEN_MIN by HIDDEN_MIN inside `r` that nothing in `above` overlaps? A box that fits anywhere
 * can slide left and then up until something stops it, and it fits there too. What stops it is `r`'s own left and top
 * edges, or the right and bottom edges of what's above, so those are the only places worth trying.
 */
function showsEnough(r: Rect, above: readonly Rect[]): boolean {
  const over = above.filter((a) => overlaps(r, a));
  if (!over.length) return true;
  const lastX = r.x + r.w - HIDDEN_MIN + EPS;
  const lastY = r.y + r.h - HIDDEN_MIN + EPS;
  for (const x of [r.x, ...over.map((a) => a.x + a.w)]) {
    if (x < r.x - EPS || x > lastX) continue;
    for (const y of [r.y, ...over.map((a) => a.y + a.h)]) {
      if (y < r.y - EPS || y > lastY) continue;
      const box = { x, y, w: HIDDEN_MIN, h: HIDDEN_MIN };
      if (!over.some((a) => overlaps(box, a))) return true;
    }
  }
  return false;
}

/**
 * The apps with nothing left to press (ADR 0064), top of the stack first: what the union of everything above an app
 * leaves of it holds no box of HIDDEN_MIN by HIDDEN_MIN. A hidden app still covers what's under it. Units, so the zoom
 * doesn't change it, and worked out once per version of a layout, never per frame or pointer move.
 */
export function hiddenItems(desk: Pick<LayoutDesk, 'items' | 'stack'>): string[] {
  const byId = new Map(desk.items.map((i) => [i.id, i]));
  const order = stackOrder(desk);
  const above: LayoutItem[] = [];
  const hidden: string[] = [];
  for (let n = order.length - 1; n >= 0; n -= 1) {
    const item = byId.get(order[n]!)!;
    if (!showsEnough(item, above)) hidden.push(item.id);
    above.push(item);
  }
  return hidden;
}

/** The free spot nearest to this box. Null if it fits nowhere. */
export function nearestFree(r: Rect, others: readonly Rect[], area: Rect): Point | null {
  const xs = [r.x, area.x, area.x + area.w - r.w, ...others.flatMap((o) => [o.x - r.w, o.x + o.w])];
  const ys = [r.y, area.y, area.y + area.h - r.h, ...others.flatMap((o) => [o.y - r.h, o.y + o.h])];
  let best: Point | null = null;
  let bestD = Infinity;
  for (const x of xs) {
    for (const y of ys) {
      const box = { x, y, w: r.w, h: r.h };
      const d = Math.hypot(x - r.x, y - r.y);
      if (d < bestD && isPlaced(box, area) && !others.some((o) => overlaps(box, o))) {
        best = { x, y };
        bestD = d;
      }
    }
  }
  return best;
}

// ----- cleanup (ADR 0062, 0064): the apps in reading order, each at the top-left-most free spot, 16 apart and
// 24 from the edges, whatever it starts from: it reads only where they are, so even apps stacked exactly on top of
// each other come apart the same way every time. It never changes a size, and the desk only ever grows, downward.

// Apps within half a tile of a row's top read as that row, so a rough row keeps its left-to-right order.
const ROW_SLACK = G.cell / 2;
const TIDY_PASSES = 6;

const byPlace = (a: LayoutItem, b: LayoutItem): number => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1);

/** Top then left, by rows. */
export function tidyOrder(items: readonly LayoutItem[]): LayoutItem[] {
  const rows: LayoutItem[][] = [];
  let top = -Infinity;
  for (const item of [...items].sort(byPlace)) {
    if (item.y >= top + ROW_SLACK) {
      rows.push([]);
      top = item.y;
    }
    rows[rows.length - 1]!.push(item);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x || byPlace(a, b)));
}

const sameIds = (a: readonly LayoutItem[], b: readonly LayoutItem[]): boolean => a.every((item, i) => item.id === b[i]?.id);

/**
 * Each app in turn, at the first free spot going down and then across. Below everything there's always
 * room, which is how the desk grows. `keepOrder` also refuses a spot that would change the reading order.
 */
export function tidyPack(order: readonly LayoutItem[], deskW: number, keepOrder = false): LayoutItem[] {
  const placed: LayoutItem[] = [];
  for (const item of order) {
    // An app wider than the padding allows stays centered, with what margin it has, since the desk keeps its width.
    const left = Math.min(G.padX, roundUnit((deskW - item.w) / 2));
    const right = deskW - G.padX;
    const xs = [left, ...placed.map((p) => roundUnit(p.x + p.w + G.gap))].sort((a, b) => a - b);
    const ys = [G.padTop as number, ...placed.map((p) => roundUnit(p.y + p.h + G.gap))].sort((a, b) => a - b);
    let spot: LayoutItem | null = null;
    for (const y of ys) {
      for (const x of xs) {
        if (x !== left && x + item.w > right + EPS) continue;
        const box = { x: x - G.gap, y: y - G.gap, w: item.w + 2 * G.gap, h: item.h + 2 * G.gap };
        if (placed.some((p) => overlaps(box, p))) continue;
        const here = { ...item, x, y };
        if (keepOrder && !sameIds(tidyOrder([...placed, here]), [...placed, here])) continue;
        spot = here;
        break;
      }
      if (spot) break;
    }
    placed.push(spot!);
  }
  return placed;
}

/**
 * The desk cleaned up, or this same desk if it's already tidy. Running it on its own result changes nothing,
 * by construction. Filling a hole can change the reading order, so one pass isn't enough: the next pass would
 * see a different order and may place things differently. So it packs until the order it reads is the order
 * it packed. Everything here depends only on the starting order and the desk's width. If that never settles,
 * it packs once more without letting the order change, and reading that result gives the same starting order,
 * so a second run takes the same path to the same place.
 */
export function tidyDesk(desk: LayoutDesk): LayoutDesk {
  const first = tidyOrder(desk.items);
  let order = first;
  let placed: LayoutItem[] | null = null;
  for (let pass = 0; pass < TIDY_PASSES && !placed; pass += 1) {
    const next = tidyPack(order, desk.w);
    const read = tidyOrder(next);
    if (sameIds(order, read)) placed = next;
    order = read;
  }
  placed ??= tidyPack(first, desk.w, true);
  const was = new Map(desk.items.map((i) => [i.id, i]));
  const h = Math.max(desk.h, ...placed.map((p) => roundUnit(p.y + p.h + G.strip)));
  if (h === desk.h && placed.every((p) => was.get(p.id)?.x === p.x && was.get(p.id)?.y === p.y)) return desk;
  // The list keeps its order, since that's a phone's grid, and this is only about places.
  const at = new Map(placed.map((p) => [p.id, p]));
  return { ...desk, h, items: desk.items.map((i) => at.get(i.id)!) };
}

/**
 * Any stored desk made valid: apps at their minimum size or larger, inside the desk, which grows to hold them.
 * Nothing is dropped, the list and the stack keep their order, and overlaps stay as they are. Only the apps in
 * `needRoom`, which have no place of their own to keep, look for a free spot, and stay put if there's none.
 */
export function settleDesk(desk: LayoutDesk, needRoom: ReadonlySet<string> = new Set()): LayoutDesk {
  const sized = desk.items.map((i) => ({
    ...i,
    x: roundUnit(Math.max(i.x, G.edge)),
    y: roundUnit(Math.max(i.y, G.edge)),
    w: roundUnit(Math.max(i.w, G.minApp)),
    h: roundUnit(Math.max(i.h, G.minApp)),
  }));
  const { w, h } = fitDeskSize(sized, desk.w, desk.h);
  const area = workArea(w, h);
  const placed: LayoutItem[] = sized.filter((i) => !needRoom.has(i.id));
  const items = sized.map((item) => {
    if (!needRoom.has(item.id)) return item;
    const spot = nearestFree(item, placed, area);
    const here = spot ? { ...item, x: roundUnit(spot.x), y: roundUnit(spot.y) } : item;
    placed.push(here);
    return here;
  });
  return { ...desk, w, h, items };
}
