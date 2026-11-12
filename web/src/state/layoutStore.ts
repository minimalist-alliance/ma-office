// Layout doc (design 3.8): desk positions, sizes and apps. Metadata only. Mirrored in localStorage for
// an instant first paint. shell/layoutSync.ts keeps it level with Platform's copy, and layoutDoc.ts holds
// the format and its migration.
import { create } from 'zustand';
import { readJson, writeJson } from '../lib/util';
import { fitDeskSize, isPlaced, levelSize, restacked, roundUnit, settleDesk, stackOrder, withStack, workArea, type DeskCarousel, type DetailLevel, type LayoutDesk, type Rect } from '../canvas/layout';
import { createDeskPush, separateDesks, separation, type DeskAt } from '../canvas/deskPush';
import { clearLayoutDoc, fitDeskToBand, fitDocToBand, freshDesk, LAYOUT_KEY, LAYOUT_KEY_V1, migrateLayoutV1, readLayoutDoc, type LayoutDoc } from '../canvas/layoutDoc';
import { currentBand } from '../platform/age';
import { MIRROR_KEY as BACKDROP_KEY } from '../theme/backdropMirror';
import { defaultDeskStyleId } from '../theme/deskStyles';

// ----- the mirror, and whose it is (ISS-67)
//
// What this browser keeps of the account's saved layout (ADR 0005 and its addendum): the document's desks (`ma.layout.v2`,
// and `ma.layout.v1` from before), what hasn't reached Platform yet (`ma.layout.sync.v1`), the document's preferences that
// are mirrored for a reload or the first frame (the free tier's, the setup circle's, the background), and whose all of it
// is (`ma.layout.owner.v1`, the token's `sub`). It's one copy for every desk the member has, Personal, Work and Guild,
// whatever the scope shows. Every signed-out state wipes all of it (`forgetLayoutMirror`, from `platform/session.ts`). It's
// written only while a refresh token is kept in this browser (`mirrorFollowsToken`), so a tab that another tab has signed
// out has nothing to write it back with. A sign-in as anyone else finds it gone, from storage and memory (`layoutMirrorFor`).

export const LAYOUT_SYNC_KEY = 'ma.layout.sync.v1';
export const LAYOUT_OWNER_KEY = 'ma.layout.owner.v1';
/** Every key of the mirror. `free/prefs.ts` and `setup/prefs.ts` are lazy chunks, so theirs are written out here; `layoutMirror.test.ts` holds them to it. */
export const LAYOUT_MIRROR_KEYS: readonly string[] = [LAYOUT_KEY, LAYOUT_KEY_V1, LAYOUT_SYNC_KEY, 'ma.free.prefs.v1', 'ma.setup.prefs.v1', BACKDROP_KEY, LAYOUT_OWNER_KEY];

// ----- the member's other caches (ISS-89)
//
// What else this browser keeps of a member goes with the mirror: on the same signed-out states, per account by the same
// owner, and written only while `layoutMirrorWritable()`. Each module has its own constant, mostly in lazy chunks, so the
// keys are written out here and a wipe never waits on a chunk; `memberCaches.test.ts` holds them to each module's own.
/**
 * localStorage: stream quality and its desk levels (`quality/store.ts`), the boots told (`platform/bootNotice.ts`), the
 * bandwidth heads-up seen (`bandwidth/BandwidthCircle.tsx`), the Guild Desk's privacy line seen (`guild/GuildLayer.tsx`),
 * the members shown the touch hint (`browser/touchInput.ts`), the connect-time report's cap (`desk/rtc/connectRtt.ts`),
 * and the owner's About disclosure (`chrome/AccountPanel.tsx`).
 */
export const MEMBER_CACHE_KEYS: readonly string[] = ['ma.streamQuality.v1', 'ma.streamQuality.desks.v1', 'ma.boots.seen.v1', 'ma.bandwidth.notice.v1', 'ma.guild.privacy.v1', 'ma.browser.touchHint.v1', 'ma.rttCapped.v1', 'ma.menu.about.v1'];
/**
 * This tab's sessionStorage: Maia's conversation and whether her panel was open (`maia/`), and whose they are (the owner
 * key again), since a tab's own storage can outlast its member in localStorage (a reload after a sign-in elsewhere).
 */
export const MEMBER_TAB_KEYS: readonly string[] = ['ma.maia.conversation.v1', 'ma.maia.open.v1', LAYOUT_OWNER_KEY];

function drop(store: () => Storage, keys: readonly string[]): void {
  for (const key of keys) {
    try {
      store().removeItem(key);
    } catch {
      /* storage refused: there's nothing there to take */
    }
  }
}

function storedOwner(): string | null {
  try {
    return window.localStorage.getItem(LAYOUT_OWNER_KEY);
  } catch {
    return null;
  }
}

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

/** Whose the layout in memory is: the owner it was loaded with, then each token's `sub`. Null while nobody has said. */
let owner: string | null = storedOwner();
/** This page reached a signed-out state: nothing more of the mirror is written from it, nor saved to Platform. */
let held = false;
/** A layout put in memory that isn't the member's change and needn't be written: another account's going. */
let muted = false;

/** Whether a refresh token is kept in this browser. `platform/session.ts` hands in `tokenStore.hasStoredToken` as it loads. */
let tokenKept: () => boolean = () => true;
/** Handed in rather than imported: importing the token store here splits it into a chunk of its own, 0.4 KB more initial JS. */
export function mirrorFollowsToken(kept: () => boolean): void {
  tokenKept = kept;
}

/**
 * The mirror may be written: this page hasn't signed out, a refresh token is kept in this browser, and what's stored is
 * this tab's account's, or nobody's yet. That last is ISS-89's: a tab that another tab signed out, still drawing the
 * last member on the access token it holds, finds a token kept again once someone signs in there, and that sign-in has
 * already named the mirror theirs (`layoutMirrorFor`), so the last member's writes go nowhere.
 */
export const layoutMirrorWritable = (): boolean => {
  if (held || !tokenKept()) return false;
  const stored = storedOwner();
  return owner === null || stored === null || stored === owner;
};
/** This page has signed out: `shell/layoutSync.ts` saves nothing more, the keepalive save as it goes included. */
export const layoutMirrorHeld = (): boolean => held;

function writeMirror(s: LayoutDoc): void {
  if (!layoutMirrorWritable()) return;
  // Whose it is goes first, so another tab reading the layout already knows.
  try {
    if (owner !== null && storedOwner() !== owner) window.localStorage.setItem(LAYOUT_OWNER_KEY, owner);
  } catch {
    /* storage refused: the layout below is refused too */
  }
  writeJson(LAYOUT_KEY, s);
}

let persist = true;
let timer = 0;
useLayoutStore.subscribe((s) => {
  if (!persist || muted) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = 0;
    writeMirror(s);
  }, 1000);
});

/** The fixtures' layout stays out of the mirror, and out of Platform's copy. */
export const isSavingLayout = (): boolean => persist;

/** The page is going away: the mirror's debounce won't get to run. */
export function flushLayoutMirror(): void {
  if (!persist || !timer) return;
  window.clearTimeout(timer);
  timer = 0;
  writeMirror(useLayoutStore.getState());
}

/**
 * A signed-out state (`platform/session.ts`): every key of the mirror goes, and the member's other caches with it
 * (`MEMBER_CACHE_KEYS`, and this tab's `MEMBER_TAB_KEYS`; ISS-89). `hold`: this page is the one signing out, so
 * nothing more is written from it, not the debounce, a flush or a save as it goes. What's in memory goes with the page.
 * Another tab's sign-out passes false: this tab has no token left to write with, and writes again if one comes back.
 */
export function forgetLayoutMirror(hold = true): void {
  if (hold) held = true;
  window.clearTimeout(timer);
  timer = 0;
  drop(() => window.localStorage, [...LAYOUT_MIRROR_KEYS, ...MEMBER_CACHE_KEYS]);
  drop(() => sessionStorage, MEMBER_TAB_KEYS);
}

/**
 * This tab's tokens are `sub`'s: the first ones, or another account's after a sign-in in another tab (`onMemberChange`).
 * A mirror another account wrote goes from storage. A layout this tab holds from another account goes from memory,
 * replaced by what's stored for `sub` (another tab of theirs wrote it) or by nothing, which the desk list and Platform's
 * document fill. `listed` is what the desk list says now: those desks keep a layout, at a new desk's places where nothing
 * of `sub`'s has one, never the last account's arrangement. The session then drops the list itself and asks for the new
 * account's at once (ISS-89), so the office shows the list loading, and any desk the new list names again draws at once
 * at those places. A mirror nobody has named, which a build before this one wrote, is `sub`'s. False if any was someone
 * else's.
 */
export function layoutMirrorFor(sub: string, listed: readonly string[] = []): boolean {
  const stored = storedOwner();
  const fits = stored === null || stored === sub;
  if (!fits) forgetLayoutMirror(false);
  const mine = owner === null || owner === sub;
  owner = sub;
  // This tab's own keys (ISS-89): another account's go, and they're named for `sub`. None named, from a build before
  // this one, are `sub`'s, as the mirror's are.
  try {
    const tab = sessionStorage.getItem(LAYOUT_OWNER_KEY);
    if (!mine || (tab !== null && tab !== sub)) drop(() => sessionStorage, MEMBER_TAB_KEYS);
    if (!held) sessionStorage.setItem(LAYOUT_OWNER_KEY, sub);
  } catch {
    /* no storage for this tab: nothing kept to name */
  }
  if (!fits || !mine) {
    // Not one write of the last account's layout may land after this, under anyone's name.
    window.clearTimeout(timer);
    timer = 0;
    expected = {};
    const doc = stored === sub ? load() : { desks: {}, z: [] };
    // Written nowhere: this tab's next real change, or the list's next answer, writes what's `sub`'s.
    muted = true;
    try {
      quietly(() => useLayoutStore.setState({ desks: doc.desks, z: doc.z }));
      if (listed.length) reconcileLayout(listed);
    } finally {
      muted = false;
    }
  }
  // Named at once, before the sign-in's refresh token is stored (ISS-89), so a tab still drawing someone else can't
  // name it theirs in between. Only this tab's own tokens get here, so it's never a signed-out tab's write.
  if (stored !== sub && !held) {
    try {
      window.localStorage.setItem(LAYOUT_OWNER_KEY, sub);
    } catch {
      /* the next write of the layout names it */
    }
  }
  return fits && mine;
}

/** Another tab's write of the mirror is this tab's to take: this page hasn't signed out, and it's the same account's, or nobody has said. */
export function mirrorIsOurs(): boolean {
  if (held) return false;
  const stored = storedOwner();
  return stored === null || owner === null || stored === owner;
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
