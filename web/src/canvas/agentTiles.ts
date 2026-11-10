// Every agent is its own app on the desk (task 49 item 6). The lead keeps the `agent` tile, so every layout saved before keeps
// working, and opens the whole desk team. Each other agent is an item with app `agent:<agentId>`, placed and removed as the
// desk's `agent.state` says: a new one at the first free spot in the rows of icons a new desk starts with (DEFAULT_ITEMS), a
// gone one off the layout. Pure, so a desk with nothing to change is this same object, and tested in agentTiles.test.ts.
import { agentApp, agentIdOf, G, isAgentApp, overlaps, roundUnit, settleDesk, stackOrder, withStack, type LayoutDesk, type LayoutItem, type Rect } from './layout';

export interface TileAgent {
  id: string;
  lead: boolean;
}

/** An agent tile's item id: the desk's, then its app, as a new desk names its own (`defaultDesk`). */
export const agentItemId = (deskId: string, agentId: string): string => `${deskId}:${agentApp(agentId)}`;

/**
 * Where a new app goes: the first cell, row by row from the top left, that keeps a gap from everything on the desk, on the
 * same 92-unit pitch a new desk's icons sit on. Past the desk's bottom, the desk grows to hold it (`settleDesk`).
 */
export function placeNewTile(desk: Pick<LayoutDesk, 'w' | 'items'>): Rect {
  const cols = Math.max(1, Math.floor((desk.w - 2 * G.padX + G.gap) / G.pitch));
  const near = 0.01;
  for (let r = 0; r < 256; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const box = { x: G.padX + c * G.pitch, y: G.padTop + r * G.pitch, w: G.cell, h: G.cell };
      const room = { x: box.x - G.gap + near, y: box.y - G.gap + near, w: box.w + 2 * (G.gap - near), h: box.h + 2 * (G.gap - near) };
      if (!desk.items.some((i) => overlaps(room, i))) return box;
    }
  }
  return { x: G.padX, y: G.padTop, w: G.cell, h: G.cell };
}

/**
 * This desk with one tile for each of its agents but the lead, as `agents` says. Null: the desk hasn't said, and nothing
 * changes. A tile whose agent is gone goes, the lead's own `agent:` tile included (it has the `agent` tile); a new agent's
 * comes at the end of the list (the phone grid's order) and on top of the stack. The same object if nothing changed.
 */
export function fitDeskToAgents(desk: LayoutDesk, agents: readonly TileAgent[] | null): LayoutDesk {
  if (!agents) return desk;
  const staff = agents.filter((a) => !a.lead).map((a) => a.id);
  const keep = new Set(staff);
  const kept = desk.items.filter((i) => !isAgentApp(i.app) || keep.has(agentIdOf(i.app) ?? ''));
  const have = new Set(kept.flatMap((i) => (isAgentApp(i.app) ? [agentIdOf(i.app)] : [])));
  const missing = staff.filter((id) => !have.has(id));
  if (kept.length === desk.items.length && !missing.length) return desk;
  let next: LayoutDesk = withStack({ ...desk, items: kept }, stackOrder({ items: kept, stack: desk.stack }));
  for (const agentId of missing) {
    const at = placeNewTile(next);
    const item: LayoutItem = { id: agentItemId(desk.id, agentId), app: agentApp(agentId), x: roundUnit(at.x), y: roundUnit(at.y), w: at.w, h: at.h };
    const items = [...next.items, item];
    // On top: it's the newest thing on the desk.
    next = withStack(settleDesk({ ...next, items }), [...stackOrder(next), item.id]);
  }
  return next;
}
