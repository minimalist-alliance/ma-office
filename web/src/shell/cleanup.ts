// Cleaning up a desk (ADR 0062, 0064). `tidyDesk` in canvas/layout.ts decides where things go. This holds the
// one level of undo: in memory, so not across a reload, and good until the next change on that desk.
import { create } from 'zustand';
import { camera } from '../canvas/controller';
import { DESK_GAP, separation, type DeskAt } from '../canvas/deskPush';
import { tidyDesk, withStack, type LayoutDesk, type Point, type Rect } from '../canvas/layout';
import { isPhone } from '../canvas/phone';
import { pushedBy, putDesk, raiseDesk, stackItem, useLayoutStore } from '../state/layoutStore';
import { announce } from './announce';
import { appsInOrder } from './order';

export const CLEANUP_MS = 240;
const OFFER_MS = 10_000;

interface Undo {
  before: LayoutDesk;
  /** The desk as cleanup left it. Any later change stores a new object, and that's what ends the undo. */
  after: LayoutDesk;
  /** The button says "Undo" for the first 10 s. The context menu offers it for as long as it lasts. */
  offered: boolean;
  /** Who a desk that grew pushed aside: where each was, and the object cleanup left it as. */
  pushed: { id: string; home: Point; left: LayoutDesk }[];
  /** Every desk as cleanup left them, to tell what has moved since. */
  left: Record<string, LayoutDesk>;
}

export const useCleanup = create<Record<string, Undo>>(() => ({}));

const tidied = new WeakMap<LayoutDesk, LayoutDesk>();

/** What cleanup would make of this desk: this same desk if it's already tidy. Once per version of a desk. */
function cleaned(desk: LayoutDesk): LayoutDesk {
  let result = tidied.get(desk);
  if (!result) {
    result = tidyDesk(desk);
    tidied.set(desk, result);
  }
  return result;
}

export const needsCleanup = (desk: LayoutDesk): boolean => cleaned(desk) !== desk;

/** Is undo still good: is this desk just as cleanup left it? */
export const canUndoCleanup = (desk: LayoutDesk): boolean => useCleanup.getState()[desk.id]?.after === desk;

/** The proxy button for the strip's control goes in the arrows' order, after the desk's apps. */
export const cleanupProxyId = (deskId: string): string => `cleanup:${deskId}`;

// While this is true for a desk, its apps and its size take the cleanup's glide when the layout moves them.
const glides = new Map<string, number>();
export const isTidying = (deskId: string): boolean => (glides.get(deskId) ?? 0) > performance.now();
/** Any desk mid-glide, or about to be. Asked per document or save, never per frame. */
export function anyTidying(): boolean {
  const now = performance.now();
  for (const until of glides.values()) if (until > now) return true;
  return false;
}

const timers = new Map<string, number>();

function endOffer(id: string): void {
  // It's a render, so it lands after a camera move, never during one.
  if (camera.isMoving()) {
    const off = camera.onSettle(() => {
      off();
      endOffer(id);
    });
    return;
  }
  useCleanup.setState((s) => {
    const entry = s[id];
    return entry ? { [id]: { ...entry, offered: false } } : s;
  });
}

export function cleanUpDesk(id: string): void {
  const desk = useLayoutStore.getState().desks[id];
  if (!desk || isPhone()) return;
  const next = cleaned(desk);
  if (next === desk) return;
  // The stacking order resets to reading order, and the list stays a phone's. Undo brings the old stack back with everything else.
  const stack = appsInOrder(next.items, false).map((i) => i.id);
  // A desk that grows pushes its neighbours (ADR 0064), and they move with it over its 240 ms.
  const others = next.h > desk.h ? pushedBy(id, next) : [];
  const was = useLayoutStore.getState().desks;
  const until = performance.now() + CLEANUP_MS;
  glides.set(id, until);
  for (const o of others) glides.set(o.id, until);
  if (next.h > desk.h) raiseDesk(id);
  const after = putDesk(id, withStack(next, stack), others);
  const left = useLayoutStore.getState().desks;
  const pushed = others.map((o) => ({ id: o.id, home: { x: was[o.id]!.x, y: was[o.id]!.y }, left: left[o.id]! }));
  useCleanup.setState({ [id]: { before: desk, after, offered: true, pushed, left } });
  window.clearTimeout(timers.get(id));
  timers.set(id, window.setTimeout(() => endOffer(id), OFFER_MS));
  announce('Desk cleaned up');
}

/**
 * An app to the front or the back of its desk's stack. Phones have a grid, and nothing stacks there. This
 * alone doesn't end cleanup's undo, or a click on an app would: nothing overlaps after a cleanup, so it can't show
 * until something moves, and that does end it. Undo brings back the stacking from before the cleanup anyway.
 */
export function restack(id: string, itemId: string, to: 'front' | 'back'): void {
  const desk = useLayoutStore.getState().desks[id];
  if (!desk || isPhone()) return;
  const next = stackItem(id, itemId, to);
  const entry = useCleanup.getState()[id];
  if (next && next !== desk && entry?.after === desk) useCleanup.setState({ [id]: { ...entry, after: next } });
}

/**
 * The neighbours that can go back: any that hasn't moved since, unless something else has come to its old place. A
 * desk that has moved since stays where it is, and whatever it's now in the way of stays too.
 */
function neighboursBack(entry: Undo, desks: Record<string, LayoutDesk>): DeskAt[] {
  // By bounds, not by object: a click on an app in a neighbour stores a new object with a new stack, and isn't a move.
  const sameAs = (a: Rect | undefined, b: Rect | undefined): boolean => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  let going = entry.pushed.filter((p) => sameAs(desks[p.id], p.left));
  for (;;) {
    const back = new Map(going.map((p) => [p.id, p.home]));
    const stuck = going.find((p) => Object.values(desks).some((o) => {
      if (o.id === p.id || o.id === entry.before.id || back.has(o.id)) return false;
      // What's where cleanup found it was clear of this desk's old place then, and it still is.
      if (sameAs(o, entry.left[o.id]) && !entry.pushed.some((q) => q.id === o.id)) return false;
      return separation({ ...desks[p.id]!, ...p.home }, o) < DESK_GAP;
    }));
    if (!stuck) return going.map((p) => ({ id: p.id, ...p.home }));
    going = going.filter((p) => p !== stuck);
  }
}

export function undoCleanup(id: string): void {
  const { desks } = useLayoutStore.getState();
  const desk = desks[id];
  const entry = useCleanup.getState()[id];
  if (!desk || !entry || entry.after !== desk) return;
  const back = neighboursBack(entry, desks);
  const until = performance.now() + CLEANUP_MS;
  glides.set(id, until);
  for (const o of back) glides.set(o.id, until);
  putDesk(id, entry.before, back);
  window.clearTimeout(timers.get(id));
  useCleanup.setState((s) => {
    const rest = { ...s };
    delete rest[id];
    return rest;
  }, true);
  announce('Clean up undone');
}
