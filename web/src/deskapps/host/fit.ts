// Where installed apps' tiles go (ADR 0054), pure: one tile per installed app on its desk, a new one at the first free spot as an
// agent's tile is placed (`placeNewTile`), and none for an app that isn't installed. Tested in `fit.test.ts`.
import { placeNewTile } from '../../canvas/agentTiles';
import { isDeskApp, roundUnit, settleDesk, stackOrder, withStack, type LayoutDesk, type LayoutItem } from '../../canvas/layout';
import { deskApp, deskAppIdOf } from './ids';

/** An app tile's item id: the desk's, then its app, as every other tile's. */
export const appItemId = (deskId: string, appId: string): string => `${deskId}:${deskApp(appId)}`;

/** This desk with one tile per installed app and none for any other. The same object if nothing changes. */
export function fitDeskToApps(desk: LayoutDesk, installed: readonly string[]): LayoutDesk {
  const want = new Set(installed);
  const kept = desk.items.filter((i) => !isDeskApp(i.app) || want.has(deskAppIdOf(i.app) ?? ''));
  const have = new Set(kept.flatMap((i) => (isDeskApp(i.app) ? [deskAppIdOf(i.app)] : [])));
  const missing = installed.filter((id) => !have.has(id));
  if (kept.length === desk.items.length && !missing.length) return desk;
  let next: LayoutDesk = withStack({ ...desk, items: kept }, stackOrder({ items: kept, stack: desk.stack }));
  for (const id of missing) {
    const at = placeNewTile(next);
    const item: LayoutItem = { id: appItemId(desk.id, id), app: deskApp(id), x: roundUnit(at.x), y: roundUnit(at.y), w: at.w, h: at.h };
    // On top, at the end: it's the newest thing on the desk.
    next = withStack(settleDesk({ ...next, items: [...next.items, item] }), [...stackOrder(next), item.id]);
  }
  return next;
}

/** What the Apps sheet shows, from what the desk and its catalog say. Pure, for `fit.test.ts`'s neighbour `sheet.test.ts`. */
export type SheetState = 'asleep' | 'connecting' | 'off' | 'failed' | 'loading' | 'none' | 'detail' | 'list';

export function sheetState(i: { open: boolean; asleep: boolean; available: boolean | null; load: 'loading' | 'ready' | 'failed'; rows: number; detail: boolean }): SheetState {
  if (!i.open) return i.asleep ? 'asleep' : 'connecting';
  if (i.available === false) return 'off';
  if (!i.rows) return i.load === 'failed' ? 'failed' : i.load === 'loading' ? 'loading' : 'none';
  return i.detail ? 'detail' : 'list';
}

/** A row's action: Open (and Remove for whoever manages apps), Add to desk, why it can't be added, or nothing. */
export type RowAction = { kind: 'open'; remove: boolean } | { kind: 'add' } | { kind: 'why'; reason: string | null } | { kind: 'none' };

export function rowAction(r: { installed: boolean; installable: boolean | null; reason: string | null }, manage: boolean): RowAction {
  if (r.installed) return { kind: 'open', remove: manage };
  if (!manage || r.installable === null) return { kind: 'none' };
  return r.installable ? { kind: 'add' } : { kind: 'why', reason: r.reason };
}
