// The office tour's steps as data, moving through them, and where the card goes (ADR 0056; the Product Designer's spec,
// `~/ma-coord/design-drafts/walkthrough/README.md`). Pure: what's on screen is asked of `present`, which `TourLayer.tsx`
// answers live from the office's own markup, so a step whose target isn't there is passed over, never pointed at.

export type Side = 'below' | 'above' | 'right' | 'left';

/** Named conditions a step can ask for (`when`), answered by the layer from the member's desks. */
export type Condition = 'oneDesk' | 'personalAndWork';

/**
 * One step, as the Designer and Sales hand them over. `anchor`: a stable CSS selector of the office's own markup (the
 * first match on screen is the target), `null` for a centred card, or a named finder: `@desks` (every own desk on
 * screen, in one hole), `@guild` (a Guild Desk on screen) or `@app` (the Browser tile on the first own desk on screen).
 * `pad` grows the hole round the target. The hole's corners are the target's own, measured on screen, grown by `pad`, so
 * they run parallel to it (the owner, Nov 13); `radius` overrides that (`circle` for a round button). `placement`: the
 * first side the card tries (below, then above, right and left after it). `phone`: false leaves the step out on a phone,
 * or replaces its anchor and placement there.
 */
export interface TourStep {
  id: string;
  anchor: string | null;
  title: string;
  body: string;
  placement?: Side;
  pad?: number;
  radius?: number | 'circle';
  when?: Condition;
  phone?: false | { anchor?: string | null; placement?: Side };
}

/** The steps for this screen and member: phone variants applied, conditions met. Targets are checked later, live. */
export function stepsFor(all: readonly TourStep[], { phone, holds }: { phone: boolean; holds: (c: Condition) => boolean }): TourStep[] {
  return all.flatMap((s) => {
    if (s.when && !holds(s.when)) return [];
    if (!phone || s.phone === undefined) return [s];
    if (s.phone === false) return [];
    const p = s.phone;
    return [{ ...s, anchor: p.anchor !== undefined ? p.anchor : s.anchor, ...(p.placement ? { placement: p.placement } : {}) }];
  });
}

export type Present = (step: TourStep) => boolean;

/** The first step that's there, or -1: nothing to show. */
export const first = (steps: readonly TourStep[], present: Present): number => steps.findIndex(present);

/** The next step that's there after `i`, or -1: the tour is done. */
export function next(steps: readonly TourStep[], i: number, present: Present): number {
  for (let j = i + 1; j < steps.length; j++) if (present(steps[j]!)) return j;
  return -1;
}

/** The step before `i` that's there, or `i` itself at the start. */
export function back(steps: readonly TourStep[], i: number, present: Present): number {
  for (let j = i - 1; j >= 0; j--) if (present(steps[j]!)) return j;
  return i;
}

/** "{n} of {total}", counting only the steps that are there (and `i` itself, while it shows). */
export function position(steps: readonly TourStep[], i: number, present: Present): { n: number; total: number } {
  let n = 0;
  let total = 0;
  steps.forEach((s, j) => {
    if (j !== i && !present(s)) return;
    total += 1;
    if (j <= i) n += 1;
  });
  return { n, total };
}

// ----- geometry

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Size {
  w: number;
  h: number;
}

export const grow = (r: Rect, p: number): Rect => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p });

/**
 * The hole's corner radius: the target's own corner (`targetR`, on screen) grown by the pad, so the hole's edge runs
 * parallel to the target's at every point, and never more than half the hole's short side (a pill stays a pill).
 */
export function holeRadius(targetR: number, pad: number, hole: Size, override?: number | 'circle'): number {
  const cap = Math.min(hole.w, hole.h) / 2;
  if (override === 'circle') return cap;
  const r = override ?? Math.max(0, targetR) + pad;
  return Math.min(r, cap);
}

/**
 * A CSS `border-top-left-radius` as px on screen: `18px`, `50%` (of the box's short side, near enough for a corner), or an
 * elliptical `12px 8px` (its first value). `scale` is the element's on-screen size over its own, for a box under a
 * transform. Anything unreadable is 0: a square corner.
 */
export function cssRadius(value: string, box: Size, scale = 1): number {
  const v = value.trim().split(/\s+/)[0] ?? '';
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const px = v.endsWith('%') ? (n / 100) * Math.min(box.w, box.h) : n * scale;
  return Math.min(px, Math.min(box.w, box.h) / 2);
}

export function union(rs: readonly Rect[]): Rect {
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
}

/** How much of `r` is inside the window, 0 to 1. A target under 60 % on screen is "not there" (the Designer's rule). */
export function onScreenShare(r: Rect, view: Size): number {
  if (r.w <= 0 || r.h <= 0) return 0;
  const ix = Math.max(0, Math.min(r.x + r.w, view.w) - Math.max(r.x, 0));
  const iy = Math.max(0, Math.min(r.y + r.h, view.h) - Math.max(r.y, 0));
  return (ix * iy) / (r.w * r.h);
}

/** The card's place: `side` null is no caret (centred, or inside the hole); `caret` is its offset along the card's edge. */
export interface Placed {
  x: number;
  y: number;
  side: Side | null;
  caret: number | null;
}

/** 14 px off the hole, at least 16 px from the window's edges, the caret 18 px or more from the card's corners. */
export const GAP = 14;
export const EDGE = 16;
const CARET = 14;
const CARET_IN = 18;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Where the card goes beside a hole (the Designer's section 2): the first side with room, from `prefer` and then below,
 * above, right and left; centred with no hole (the intro); and with no side free (one desk filling the screen), inside the
 * hole at its lower right, 24 px in, with no caret, which keeps the desk's first tiles and its name in view.
 */
export function placeCard(hole: Rect | null, card: Size, view: Size, prefer: Side = 'below'): Placed {
  if (!hole) return { x: Math.round((view.w - card.w) / 2), y: Math.round((view.h - card.h) / 2), side: null, caret: null };
  const room: Record<Side, boolean> = {
    below: view.h - (hole.y + hole.h) - GAP - EDGE >= card.h,
    above: hole.y - GAP - EDGE >= card.h,
    right: view.w - (hole.x + hole.w) - GAP - EDGE >= card.w,
    left: hole.x - GAP - EDGE >= card.w,
  };
  const order: Side[] = [prefer, 'below', 'above', 'right', 'left'];
  const side = order.find((s) => room[s]);
  if (!side) {
    return { x: Math.min(hole.x + hole.w, view.w - EDGE) - card.w - 24, y: Math.min(hole.y + hole.h, view.h - EDGE) - card.h - 24, side: null, caret: null };
  }
  const cx = hole.x + hole.w / 2;
  const cy = hole.y + hole.h / 2;
  if (side === 'below' || side === 'above') {
    const x = clamp(cx - card.w / 2, EDGE, view.w - card.w - EDGE);
    return { x, y: side === 'below' ? hole.y + hole.h + GAP : hole.y - GAP - card.h, side, caret: clamp(cx - x - CARET / 2, CARET_IN, card.w - CARET_IN - CARET) };
  }
  const y = clamp(cy - card.h / 2, EDGE, view.h - card.h - EDGE);
  return { x: side === 'right' ? hole.x + hole.w + GAP : hole.x - GAP - card.w, y, side, caret: clamp(cy - y - CARET / 2, CARET_IN, card.h - CARET_IN - CARET) };
}

/** A phone docks the card to the bottom, or to the top when the hole's bottom edge comes within 24 px of the card's top. */
export function phoneDock(hole: Rect | null, cardH: number, view: Size): 'top' | 'bottom' {
  return hole && hole.y + hole.h > view.h - 12 - cardH - 24 ? 'top' : 'bottom';
}

/** Which way the card comes in, 6 px toward its target: from below when it sits below, and so on; with no caret, it rises. */
export function arrival(side: Side | null, d = 6): { dx: number; dy: number } {
  if (side === 'above') return { dx: 0, dy: -d };
  if (side === 'right') return { dx: d, dy: 0 };
  if (side === 'left') return { dx: -d, dy: 0 };
  return { dx: 0, dy: d };
}
