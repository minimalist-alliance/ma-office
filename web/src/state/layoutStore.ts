// Layout doc (design 3.8): desk positions, sizes and apps. Metadata only. Mirrored in localStorage for
// an instant first paint. shell/layoutSync.ts keeps it level with Platform's copy, and layoutDoc.ts holds
// the format and its migration.
import { create } from 'zustand';
import { readJson, writeJson } from '../lib/util';
import { fitDeskSize, isPlaced, levelSize, restacked, roundUnit, settleDesk, stackOrder, withStack, workArea, type DeskCarousel, type DetailLevel, type LayoutDesk, type Rect } from '../canvas/layout';
import { createDeskPush, separateDesks, separation, type DeskAt } from '../canvas/deskPush';
import { clearLayoutDoc, fitDeskToBand, fitDocToBand, freshDesk, LAYOUT_KEY, LAYOUT_KEY_V1, migrateLayoutV1, readLayoutDoc, type LayoutDoc } from '../canvas/layoutDoc';
import { currentBand } from '../platform/age';
import { defaultDeskStyleId } from '../theme/deskStyles';

// Saved desks that overlap are cleared here, before anything paints. A doc that needed no moves isn't written.
function load(): LayoutDoc {
  const doc = readLayoutDoc(readJson(LAYOUT_KEY));
  if (doc) {
    const clear = clearLayoutDoc(doc);
    if (clear !== doc) writeJson(LAYOUT_KEY, clear);
    return clear;
  }
  const old = migrateLayoutV1(readJson(LAYOUT_KEY_V1));
  if (!old) return { desks: {}, z: [] };
  const clear = clearLayoutDoc(old);
  writeJson(LAYOUT_KEY, clear);
  return clear;
}

export const useLayoutStore = create<LayoutDoc>(load);

let persist = true;
let timer = 0;
useLayoutStore.subscribe((s) => {
  if (!persist) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = 0;
    writeJson(LAYOUT_KEY, s);
  }, 1000);
});

/** The fixtures' layout stays out of the mirror, and out of Platform's copy. */
export const isSavingLayout = (): boolean => persist;

/** The page is going away: the mirror's debounce won't get to run. */
export function flushLayoutMirror(): void {
  if (!persist || !timer) return;
  window.clearTimeout(timer);
  timer = 0;
  writeJson(LAYOUT_KEY, useLayoutStore.getState());
}

// A change that didn't come from the member, and so isn't theirs to save: what Platform's copy says, and what
// the desk list says. The store's subscribers run inside setState, so this is true only for them.
let quiet = false;
export const isQuietChange = (): boolean => quiet;

function quietly(fn: () => void): void {
  quiet = true;
  try {
    fn();
  } finally {
    quiet = false;
  }
}

export function applyQuietly(doc: LayoutDoc): void {
  quietly(() => useLayoutStore.setState({ desks: doc.desks, z: doc.z }));
}

let expected: Record<string, LayoutDesk> = {};

/**
 * Desks a document has places for that the list hasn't heard of yet: one made in another browser, or another member's after a
 * sign-in in another tab. That document won't be read twice, so when the list does hear of one, this is where it goes.
 */
export function expectDesks(desks: Record<string, LayoutDesk>): void {
  expected = desks;
}

/** Fixtures use this: their layout must never land in a real browser's mirror. */
export function setLayoutDirect(desks: LayoutDesk[]): void {
  persist = false;
  useLayoutStore.setState({ desks: Object.fromEntries(desks.map((d) => [d.id, d])), z: desks.map((d) => d.id) });
}

/**
 * `/v1/me` has said this member's age band: the desks here become what that band has. Quiet, like what the list and
 * Platform say: it isn't the member's change, so it saves nothing by itself. Their next real change saves it. The mirror
 * follows at once, so the next load of this browser paints it right, before `/v1/me` has answered.
 */
export function fitLayoutToBand(): void {
  quietly(() => useLayoutStore.setState((s) => {
    const doc = fitDocToBand(s, currentBand());
    return doc === s ? s : { desks: doc.desks, z: doc.z };
  }));
  flushLayoutMirror();
}

/** Every listed desk gets a layout entry; desks no longer listed lose theirs. */
export function reconcileLayout(ids: readonly string[]): void {
  const band = currentBand();
  quietly(() => useLayoutStore.setState((s) => {
    const desks: Record<string, LayoutDesk> = {};
    const placed: LayoutDesk[] = [];
    for (const id of ids) {
      const d = s.desks[id];
      if (d) {
        desks[id] = d;
        placed.push(d);
      }
    }
    for (const id of ids) {
      if (desks[id]) continue;
      const known = expected[id] && fitDeskToBand(expected[id], band);
      const d = known && placed.every((o) => separation(known, o) >= 0) ? known : freshDesk(id, placed, band);
      desks[id] = d;
      placed.push(d);
    }
    const z = [...s.z.filter((id) => desks[id]), ...ids.filter((id) => !s.z.includes(id))];
    const same = z.length === s.z.length && z.every((id, i) => id === s.z[i]) && Object.keys(desks).length === Object.keys(s.desks).length;
    return same ? s : { desks, z };
  }));
}

const sameBounds = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

function withPlaces(desks: Record<string, LayoutDesk>, places: readonly DeskAt[]): Record<string, LayoutDesk> {
  let out = desks;
  for (const { id, x, y } of places) {
    const d = out[id];
    if (!d || (d.x === x && d.y === y)) continue;
    if (out === desks) out = { ...desks };
    out[id] = { ...d, x, y };
  }
  return out;
}

/** The last check on any write that changes a desk's bounds. Nothing it's given should overlap, so normally it's a no-op. */
function checked(desks: Record<string, LayoutDesk>, keep: string, z: readonly string[]): Record<string, LayoutDesk> {
  return withPlaces(desks, separateDesks(Object.values(desks), [keep, ...[...z].reverse()], true));
}

/** Where everything else goes if this desk takes these bounds: only what would actually move. */
export function pushedBy(id: string, bounds: Rect): DeskAt[] {
  const { desks } = useLayoutStore.getState();
  return createDeskPush(Object.values(desks), id).final(bounds).filter((d) => d.id !== id && (desks[d.id]!.x !== d.x || desks[d.id]!.y !== d.y)).map(({ id: did, x, y }) => ({ id: did, x, y }));
}

// Everything that changes a desk's bounds comes through here or `placeDesks`, so nothing can write an overlap.
function patchDesk(id: string, fn: (d: LayoutDesk) => LayoutDesk): void {
  useLayoutStore.setState((s) => {
    const d = s.desks[id];
    if (!d) return s;
    const next = fn(d);
    if (sameBounds(d, next)) return { desks: { ...s.desks, [id]: next } };
    const pushed = withPlaces(s.desks, createDeskPush(Object.values(s.desks), id).final(next).filter((p) => p.id !== id));
    return { desks: checked({ ...pushed, [id]: next }, id, s.z) };
  });
}

/** A drop, or a keyboard step: this desk's bounds and everything it pushed, in one write. A desk with nothing to change keeps its object. */
export function placeDesks(id: string, bounds: Rect, others: readonly DeskAt[]): void {
  useLayoutStore.setState((s) => {
    const d = s.desks[id];
    if (!d) return s;
    const next = sameBounds(d, bounds) ? d : { ...d, x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
    const desks = withPlaces(s.desks, others.filter((p) => p.id !== id));
    if (next === d && desks === s.desks) return s;
    return { desks: checked({ ...desks, [id]: next }, id, s.z) };
  });
}

/** A desk goes where it's dropped, with no grid (ADR 0062), and anything in the way goes aside (ADR 0064). */
export function moveDesk(id: string, x: number, y: number): void {
  patchDesk(id, (d) => ({ ...d, x: roundUnit(x), y: roundUnit(y) }));
}

/** A desk takes any size that still holds its apps (ADR 0062). */
export function resizeDesk(id: string, w: number, h: number): void {
  patchDesk(id, (d) => ({ ...d, ...fitDeskSize(d.items, w, h) }));
}

/** Phones: the list order is the grid's order. The stack doesn't follow it: what's on top on a larger screen stays on top. */
export function reorderItems(id: string, order: readonly string[]): void {
  patchDesk(id, (d) => {
    const byId = new Map(d.items.map((i) => [i.id, i]));
    const items = order.flatMap((x) => {
      const item = byId.get(x);
      return item ? [item] : [];
    });
    return withStack({ ...d, items }, stackOrder(d));
  });
}

/** Phones: an app's detail level is its size. It keeps a place for a larger screen, and doesn't move the others. */
export function setItemLevel(id: string, itemId: string, level: DetailLevel): void {
  patchDesk(id, (d) => settleDesk({ ...d, items: d.items.map((i) => (i.id === itemId ? { ...i, ...levelSize(level) } : i)) }, new Set([itemId])));
}

/** Put an app here, over whatever is there. A place outside the desk (one that changed mid-drag) is refused. */
export function placeItem(id: string, itemId: string, rect: Rect): boolean {
  const d = useLayoutStore.getState().desks[id];
  if (!d || !isPlaced(rect, workArea(d.w, d.h))) return false;
  patchDesk(id, (cur) => ({ ...cur, items: cur.items.map((i) => (i.id === itemId ? { ...i, ...rect } : i)) }));
  return true;
}

/** An app to the front or the back of its desk's stack (ADR 0064), with the list left as it is. Hands back what's stored; the same desk if that changed nothing. */
export function stackItem(id: string, itemId: string, to: 'front' | 'back'): LayoutDesk | undefined {
  const d = useLayoutStore.getState().desks[id];
  if (!d) return undefined;
  const order = stackOrder(d);
  const next = restacked(order, itemId, to);
  return next === order ? d : putDesk(id, withStack(d, next));
}

/** Cleanup and its undo: a desk's whole new state and the neighbours that go with it. Hands back what's stored, since "no change since" is this same object. */
export function putDesk(id: string, desk: LayoutDesk, others: readonly DeskAt[] = []): LayoutDesk {
  useLayoutStore.setState((s) => ({ desks: checked({ ...withPlaces(s.desks, others), [id]: desk }, id, s.z) }));
  return desk;
}

/**
 * The member picked a style for this desk from its menu (`theme/deskStyles.ts`). It's their change, so it saves like any
 * other. False, and nothing stored, if the desk already wears it: picking the default on a desk that never chose is no change.
 */
export function setDeskStyle(id: string, style: string): boolean {
  const d = useLayoutStore.getState().desks[id];
  if (!d || d.style === style || (d.style === undefined && style === defaultDeskStyleId())) return false;
  useLayoutStore.setState((s) => {
    const cur = s.desks[id];
    return cur ? { desks: { ...s.desks, [id]: { ...cur, style } } } : s;
  });
  return true;
}

/**
 * The desk's carousel (`carousel/model.ts`): the member's own change, so it saves like any other, and only on this desk.
 * False, and nothing stored, if it's already so.
 */
export function setCarousel(id: string, carousel: DeskCarousel): boolean {
  const d = useLayoutStore.getState().desks[id];
  if (!d || (d.carousel?.on === carousel.on && d.carousel?.app === carousel.app)) return false;
  useLayoutStore.setState((s) => {
    const cur = s.desks[id];
    return cur ? { desks: { ...s.desks, [id]: { ...cur, carousel: { on: carousel.on, app: carousel.app } } } } : s;
  });
  return true;
}

export function raiseDesk(id: string): void {
  useLayoutStore.setState((s) => (s.z[s.z.length - 1] === id ? s : { z: [...s.z.filter((x) => x !== id), id] }));
}
