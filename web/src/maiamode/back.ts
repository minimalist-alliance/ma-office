// Back (the focus shield; CONCEPT.md §7.3 and §7.4, deskd API.md §23 `back`): when a card appears, this browser keeps its working
// set in memory, keyed by the card (the desk and camera, the open windows with their places and stacking, the active one, the
// item); when the desk says the one thing is done, "Back to …" restores it exactly. It never leaves the browser and isn't kept
// across a reload. Pure parts, tested in `back.test.ts`; `shieldActions.ts` applies a plan to the stores.
import type { Rect } from '../canvas/layout';
import type { FocusRef } from './focus';

export interface WinSnap {
  key: string;
  deskId: string;
  app: string;
  itemId: string;
  mode: 'window' | 'full';
  rect: Rect;
  z: number;
}

export interface Snapshot {
  cardId: string;
  at: number;
  surface: 'room' | 'desk' | 'overview' | 'phone';
  camera: 'overview' | 'desk' | 'free';
  deskId: string | null;
  windows: WinSnap[];
  active: string | null;
  item: FocusRef | null;
  /** In her room: the viewport's desk and app, else null. */
  viewport: { deskId: string; app: string } | null;
}

/** The windows as `windowStore` holds them (only what Back needs). */
export interface WinNow {
  key: string;
  deskId: string;
  app: string;
  itemId: string;
  mode: 'window' | 'full';
  rect: Rect;
  z: number;
  closing: boolean;
}

export function takeSnapshot(p: {
  cardId: string;
  at: number;
  surface: Snapshot['surface'];
  camera: Snapshot['camera'];
  deskId: string | null;
  windows: readonly WinNow[];
  active: string | null;
  item: FocusRef | null;
  viewport?: Snapshot['viewport'];
}): Snapshot {
  const windows = p.windows
    .filter((w) => !w.closing)
    .map((w) => ({ key: w.key, deskId: w.deskId, app: w.app, itemId: w.itemId, mode: w.mode, rect: { ...w.rect }, z: w.z }))
    .sort((a, b) => a.z - b.z);
  return { cardId: p.cardId, at: p.at, surface: p.surface, camera: p.camera, deskId: p.deskId, windows, active: windows.some((w) => w.key === p.active) ? p.active : null, item: p.item, viewport: p.viewport ?? null };
}

export interface RestorePlan {
  /** Where the camera goes: the overview, or a desk. Null leaves it. */
  camera: { mode: 'overview' } | { mode: 'desk'; deskId: string } | null;
  /** Windows opened since (the one thing's among them): closed, so the set is as it was. */
  close: string[];
  /** Windows the set had that aren't open now: opened again, at their places. */
  open: WinSnap[];
  /** Every window of the set, at its place and size. */
  places: { key: string; rect: Rect; mode: 'window' | 'full' }[];
  /** Raised in this order (lowest first), so the stacking comes back. */
  raise: string[];
  active: string | null;
}

/** How to get from the windows now to the snapshot: pure, so a test can say exactly what Back does. */
export function restorePlan(s: Snapshot, now: readonly WinNow[], view: { camera: Snapshot['camera']; deskId: string | null }): RestorePlan {
  const open = new Map(now.filter((w) => !w.closing).map((w) => [w.key, w]));
  const keep = new Set(s.windows.map((w) => w.key));
  const camera: RestorePlan['camera'] =
    s.camera === 'overview' ? (view.camera === 'overview' ? null : { mode: 'overview' }) : s.deskId && (view.deskId !== s.deskId || view.camera === 'overview') ? { mode: 'desk', deskId: s.deskId } : null;
  return {
    camera,
    close: [...open.keys()].filter((k) => !keep.has(k)),
    open: s.windows.filter((w) => !open.has(w.key)),
    places: s.windows.filter((w) => {
      const cur = open.get(w.key);
      return !cur || cur.mode !== w.mode || cur.rect.x !== w.rect.x || cur.rect.y !== w.rect.y || cur.rect.w !== w.rect.w || cur.rect.h !== w.rect.h;
    }).map((w) => ({ key: w.key, rect: { ...w.rect }, mode: w.mode })),
    raise: s.windows.map((w) => w.key),
    active: s.active,
  };
}

/** The snapshots this page holds: one per card, the last 10, in memory only. */
export class Snapshots {
  private readonly map = new Map<string, Snapshot>();
  constructor(private readonly max = 10) {}
  put(s: Snapshot): void {
    if (this.map.has(s.cardId)) return; // the first sight of a card is where the member was
    this.map.set(s.cardId, s);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  get(cardId: string): Snapshot | null {
    return this.map.get(cardId) ?? null;
  }
  drop(cardId: string): void {
    this.map.delete(cardId);
  }
  clear(): void {
    this.map.clear();
  }
}
