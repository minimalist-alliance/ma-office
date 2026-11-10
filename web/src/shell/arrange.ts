// Moving and resizing from the keyboard (ADR 0062, follow-up 6). On a focused app or desk, `m` moves
// and `r` resizes. Arrows change it by 8 units, Shift+arrows by 40. Enter keeps the change and Esc
// restores where it started. Every step is announced, so this works with no canvas in view at all.
import { createDeskPush, type DeskAt, type DeskPush } from '../canvas/deskPush';
import { fitDeskSize, nudgeMove, nudgeResize, workArea, type LayoutDesk, type LayoutItem, type Rect } from '../canvas/layout';
import { isPhone } from '../canvas/phone';
import { useDeskStore } from '../state/deskStore';
import { placeDesks, placeItem, useLayoutStore } from '../state/layoutStore';
import { getView, setView } from '../state/viewStore';
import { appLabel, focusBack } from './actions';
import { announce } from './announce';
import { restack } from './cleanup';

export type EditKind = 'move' | 'resize';

interface Edit {
  kind: EditKind;
  deskId: string;
  itemId: string | null;
  /** Where it started, for Esc. */
  start: Rect;
  /** A desk pushes its neighbours aside, worked out from where everything was when this began (ADR 0064). */
  push: DeskPush | null;
  /** Where every desk was, so Esc restores the neighbours too. */
  homes: readonly DeskAt[];
}

const STEP = 8;
const BIG_STEP = 40;
const CANT = "Can't go further";

let edit: Edit | null = null;
// A live region only speaks when its text changes, and "Can't go further" can come twice in a row.
let cantToggle = false;

function sayCant(): void {
  cantToggle = !cantToggle;
  announce(cantToggle ? CANT : `${CANT}.`);
}

function find(id: string): { desk: LayoutDesk; item: LayoutItem | null } | null {
  const { desks } = useLayoutStore.getState();
  const own = desks[id];
  if (own) return { desk: own, item: null };
  for (const desk of Object.values(desks)) {
    const item = desk.items.find((i) => i.id === id);
    if (item) return { desk, item };
  }
  return null;
}

const rectOf = (r: Rect): Rect => ({ x: r.x, y: r.y, w: r.w, h: r.h });
const deskName = (id: string): string => `${useDeskStore.getState().desks.find((d) => d.id === id)?.name ?? 'This'} desk`;

/** Start on whatever the keyboard is on. False if that's not something that can move here. */
export function beginEdit(kind: EditKind): boolean {
  const id = getView().kbFocus;
  const found = id ? find(id) : null;
  if (!found || isPhone()) return false;
  const { desk, item } = found;
  const all = Object.values(useLayoutStore.getState().desks);
  edit = {
    kind,
    deskId: desk.id,
    itemId: item?.id ?? null,
    start: rectOf(item ?? desk),
    push: item ? null : createDeskPush(all, desk.id),
    homes: item ? [] : all.map(({ id: did, x, y }) => ({ id: did, x, y })),
  };
  if (item) restack(desk.id, item.id, 'front'); // picked up
  setView({ kbEdit: kind });
  const name = item ? appLabel(item.app, desk.id) : deskName(desk.id);
  announce(`${kind === 'move' ? 'Moving' : 'Resizing'} ${name}. Arrows change it by ${STEP}, Shift and arrows by ${BIG_STEP}. Enter keeps it, Esc restores it.`);
  return true;
}

/** One keyboard step on a desk, with its neighbours. Hands back the words for who is out of place because of it. */
function placeDesk(e: Edit, bounds: Rect): string {
  const places = e.push?.final(bounds) ?? [];
  placeDesks(e.deskId, bounds, places);
  const aside = places.filter((p) => {
    const home = e.homes.find((h) => h.id === p.id);
    return p.id !== e.deskId && home && (home.x !== p.x || home.y !== p.y);
  });
  if (!aside.length) return '';
  return aside.length === 1 ? `, ${deskName(aside[0]!.id)} pushed aside` : `, ${aside.length} desks pushed aside`;
}

function step(dx: -1 | 0 | 1, dy: -1 | 0 | 1, size: number): void {
  if (!edit) return;
  const { kind, deskId, itemId } = edit;
  const desk = useLayoutStore.getState().desks[deskId];
  if (!desk) return;
  if (!itemId) {
    if (kind === 'move') {
      const x = desk.x + dx * size;
      const y = desk.y + dy * size;
      const aside = placeDesk(edit, { x, y, w: desk.w, h: desk.h });
      announce(`${deskName(deskId)} at ${Math.round(x)}, ${Math.round(y)}${aside}`);
      return;
    }
    const next = fitDeskSize(desk.items, desk.w + dx * size, desk.h + dy * size);
    if (next.w === desk.w && next.h === desk.h) {
      sayCant();
      return;
    }
    const aside = placeDesk(edit, { x: desk.x, y: desk.y, ...next });
    announce(`${deskName(deskId)}, ${Math.round(next.w)} by ${Math.round(next.h)}${aside}`);
    return;
  }
  const item = desk.items.find((i) => i.id === itemId);
  if (!item) return;
  const area = workArea(desk.w, desk.h);
  if (kind === 'move') {
    const to = nudgeMove(item, dx, dy, size, area);
    if (!to) {
      sayCant();
      return;
    }
    placeItem(deskId, itemId, { ...rectOf(item), ...to });
    announce(`${appLabel(item.app, deskId)} at ${Math.round(to.x)}, ${Math.round(to.y)}`);
    return;
  }
  const to = nudgeResize(item, dx, dy, size, area);
  if (!to) {
    sayCant();
    return;
  }
  placeItem(deskId, itemId, { ...rectOf(item), ...to });
  announce(`${appLabel(item.app, deskId)}, ${Math.round(to.w)} by ${Math.round(to.h)}`);
}

/** Enter, or anything that takes the keyboard elsewhere, keeps the change. Esc restores it. */
export function finishEdit(keep: boolean): void {
  if (!edit) return;
  const { deskId, itemId, start, homes } = edit;
  edit = null;
  setView({ kbEdit: null });
  if (!keep) {
    if (itemId) placeItem(deskId, itemId, start);
    else placeDesks(deskId, start, homes);
    announce('Restored');
    return;
  }
  announce('Kept');
  // Its place in reading order may have changed, so the button moved in the DOM, and that can drop focus.
  if (itemId) requestAnimationFrame(() => focusBack(itemId));
}

/** A key while editing. True if it was taken. */
export function editKey(e: KeyboardEvent): boolean {
  if (!edit) return false;
  const size = e.shiftKey ? BIG_STEP : STEP;
  switch (e.key) {
    case 'ArrowLeft':
      step(-1, 0, size);
      break;
    case 'ArrowRight':
      step(1, 0, size);
      break;
    case 'ArrowUp':
      step(0, -1, size);
      break;
    case 'ArrowDown':
      step(0, 1, size);
      break;
    case 'Enter':
      finishEdit(true);
      break;
    case 'Escape':
      finishEdit(false);
      break;
    case 'Tab':
      finishEdit(true);
      return false;
    default:
      return false;
  }
  e.preventDefault();
  return true;
}

