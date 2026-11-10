// A push while a desk is in hand (ADR 0064). `deskPush.ts` works out where everything goes. This writes it to Konva
// through the camera, with no React and no store, until the drop: one store write, for everything that moved.
import { camera } from './controller';
import { createDeskPush, type DeskPush } from './deskPush';
import type { Rect } from './layout';
import { placeDesks, useLayoutStore } from '../state/layoutStore';

interface Live {
  id: string;
  push: DeskPush;
  homes: { id: string; x: number; y: number }[];
}

let live: Live | null = null;

/** The desk's taken in hand: everything as it is now is what the whole drag is worked out from. */
export function beginPush(id: string): void {
  if (live) dropPushOf(live);
  camera.finishGlides();
  const desks = Object.values(useLayoutStore.getState().desks);
  live = { id, push: createDeskPush(desks, id), homes: desks.map((d) => ({ id: d.id, x: d.x, y: d.y })) };
}

export function pushTo(id: string, held: Rect): void {
  if (live?.id !== id) return;
  camera.updateDeskRect(id, held);
  for (const d of live.push.step(held)) {
    if (d.changed && d.id !== id) camera.placeDesk(d.id, d.x, d.y);
  }
}

function dropPushOf(l: Live, held?: Rect): void {
  live = null;
  const bounds = held ?? useLayoutStore.getState().desks[l.id];
  if (!bounds) return;
  const places = l.push.final(bounds);
  for (const d of places) {
    if (d.changed && d.id !== l.id) camera.placeDesk(d.id, d.x, d.y);
  }
  placeDesks(l.id, bounds, places);
}

/** The drop: one store write. False if this desk isn't the one in hand any more. */
export function dropPush(id: string, held: Rect): boolean {
  if (live?.id !== id) return false;
  dropPushOf(live, held);
  return true;
}

/** The desk went away mid-drag. Everything goes back, since the store never heard of any of it. */
export function cancelPush(id: string): void {
  if (live?.id !== id) return;
  for (const home of live.homes) {
    if (home.id !== id) camera.placeDesk(home.id, home.x, home.y);
  }
  live = null;
}
