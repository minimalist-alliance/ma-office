// A desk's hidden apps (ADR 0064): the ones with nothing left to press. `hiddenItems` in canvas/layout.ts decides
// which. This keeps the answer for each version of a desk, opens the list, and acts on a choice from it.
import { create } from 'zustand';
import { camera } from '../canvas/controller';
import { hiddenItems, type LayoutDesk, type LayoutItem } from '../canvas/layout';
import { setView } from '../state/viewStore';
import { appLabel, focusBack } from './actions';
import { announce } from './announce';
import { restack } from './cleanup';
import { appsInOrder } from './order';

const known = new WeakMap<LayoutDesk, readonly LayoutItem[]>();

/**
 * This desk's hidden apps, in reading order, like the keyboard meets them. Once per version of a desk however many
 * things ask, since any change stores a new object: a drop or a raise works it out, and a move or a frame never does.
 */
export function hiddenOn(desk: LayoutDesk): readonly LayoutItem[] {
  let found = known.get(desk);
  if (!found) {
    const ids = new Set(hiddenItems(desk));
    found = ids.size ? appsInOrder(desk.items, false).filter((i) => ids.has(i.id)) : [];
    known.set(desk, found);
  }
  return found;
}

/** The hidden count's proxy button goes in the arrows' order, after cleanup's. */
export const hiddenProxyId = (deskId: string): string => `hidden:${deskId}`;

export const hiddenLabel = (count: number, deskName: string): string => `${count} hidden ${count === 1 ? 'app' : 'apps'} on the ${deskName} desk`;
export const noHiddenLabel = (deskName: string): string => `No hidden apps on the ${deskName} desk`;

/** The list opens even for a single app, so the icon always does the same thing. */
export function openHiddenList(deskId: string, fromKeyboard: boolean): void {
  setView({ hiddenList: { deskId, fromKeyboard } });
}

export function closeHiddenList(): void {
  setView({ hiddenList: null });
}

export const RING_MS = 600;

/** The app just chosen from the list, which wears a ring so the eye finds it. `n` starts its animation again for a second choice. */
export const useRing = create<{ ring: { deskId: string; itemId: string; n: number } | null }>(() => ({ ring: null }));

let ringTimer = 0;
let offRingMove = (): void => {};
let rings = 0;

function endRing(): void {
  window.clearTimeout(ringTimer);
  offRingMove();
  offRingMove = () => {};
  useRing.setState({ ring: null });
}

// It's on the proxy layer, which follows the camera only at rest, so a move ends it rather than leave it behind.
function ringItem(deskId: string, itemId: string): void {
  endRing();
  rings += 1;
  useRing.setState({ ring: { deskId, itemId, n: rings } });
  ringTimer = window.setTimeout(endRing, RING_MS);
  const off = camera.onMove(endRing);
  offRingMove = () => {
    off();
  };
}

/** Choosing one: it comes to the front, the list closes and it's ringed. From the keyboard, focus goes to it. */
export function chooseHidden(deskId: string, item: LayoutItem, fromKeyboard: boolean): void {
  closeHiddenList();
  restack(deskId, item.id, 'front');
  ringItem(deskId, item.id);
  announce(`${appLabel(item.app, deskId)} brought to front`);
  if (fromKeyboard) focusBack(item.id);
}
