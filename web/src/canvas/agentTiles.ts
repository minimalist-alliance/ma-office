// Every agent is its own app on the desk (task 49 item 6). The lead keeps the `agent` tile, so every layout saved before keeps
// working, and opens the whole desk team. Each other agent is an item with app `agent:<agentId>`, placed and removed as the
// desk's `agent.state` says: a new one at the first free spot in the rows of icons a new desk starts with (DEFAULT_ITEMS), a
// gone one off the layout. Pure, so a desk with nothing to change is this same object, and tested in agentTiles.test.ts.
import { bigEnough } from '../opentile/model';
import { agentApp, agentIdOf, detailLevel, G, isAgentApp, isPlaced, overlaps, roundUnit, settleDesk, stackOrder, withStack, workArea, type AppId, type LayoutDesk, type LayoutItem, type Rect } from './layout';

export interface TileAgent {
  id: string;
  lead: boolean;
}

/** An agent tile's item id: the desk's, then its app, as a new desk names its own (`defaultDesk`). */
export const agentItemId = (deskId: string, agentId: string): string => `${deskId}:${agentApp(agentId)}`;

/**
 * The zoom the office frames a desk of this size at on this screen (`shell/actions.ts` `deskScaleFor`, as `deskFit` frames
 * it), or null where that doesn't apply: a phone, whose desk is its cell grid, or a test that leaves it out.
 */
export type DeskScale = (w: number, h: number) => number | null;

const NEAR = 0.01;
/** Free: nothing on the desk comes within a gap of it. */
const keepsGap = (desk: Pick<LayoutDesk, 'items'>, box: Rect): boolean => {
  const room = { x: box.x - G.gap + NEAR, y: box.y - G.gap + NEAR, w: box.w + 2 * (G.gap - NEAR), h: box.h + 2 * (G.gap - NEAR) };
  return !desk.items.some((i) => overlaps(room, i));
};

/**
 * The first cell, row by row from the top left, that keeps a gap from everything on the desk, on the same 92-unit pitch a new
 * desk's icons sit on. `inside`: only a cell above the desk's strip as it is; else the rows go on past its bottom.
 */
function gridCell(desk: Pick<LayoutDesk, 'w' | 'h' | 'items'>, inside: boolean): Rect | null {
  const cols = Math.max(1, Math.floor((desk.w - 2 * G.padX + G.gap) / G.pitch));
  for (let r = 0; r < 256; r += 1) {
    const y = G.padTop + r * G.pitch;
    if (inside && y + G.cell > desk.h - G.strip) return null;
    for (let c = 0; c < cols; c += 1) {
      const box = { x: G.padX + c * G.pitch, y, w: G.cell, h: G.cell };
      if (keepsGap(desk, box)) return box;
    }
  }
  return null;
}

/**
 * Any spot of this size on the desk as it is, off the grid if need be (a gap beside an open app, say): the corners the desk's
 * edges and its apps make, the topmost first, then the leftmost, each keeping a gap from everything. Null when none is left.
 */
export function freeSpot(desk: Pick<LayoutDesk, 'w' | 'h' | 'items'>, size: number = G.cell): Rect | null {
  const area = workArea(desk.w, desk.h);
  const xs = new Set<number>([G.padX, desk.w - G.padX - size]);
  const ys = new Set<number>([G.padTop, desk.h - G.strip - size]);
  for (const i of desk.items) {
    xs.add(i.x + i.w + G.gap);
    xs.add(i.x - G.gap - size);
    ys.add(i.y + i.h + G.gap);
    ys.add(i.y - G.gap - size);
  }
  const sx = [...xs].sort((a, b) => a - b);
  for (const y of [...ys].sort((a, b) => a - b)) {
    for (const x of sx) {
      const box = { x, y, w: size, h: size };
      if (isPlaced(box, area) && keepsGap(desk, box)) return box;
    }
  }
  return null;
}

/**
 * Where a new app goes: the first free cell of the grid inside the desk, else any free spot inside it (`freeSpot`), so a
 * desk grows only when it's full. Past the desk's bottom, the next free cell below, and the desk grows to hold it
 * (`settleDesk`); `withNewTile` picks the way a full desk grows.
 */
export function placeNewTile(desk: Pick<LayoutDesk, 'w' | 'h' | 'items'>): Rect {
  return gridCell(desk, true) ?? freeSpot(desk) ?? gridCell(desk, false) ?? { x: G.padX, y: G.padTop, w: G.cell, h: G.cell };
}

/** An open tile live at this zoom (ADR 0053's 480 x 320 CSS px on screen). */
const liveAt = (i: Rect, s: number): boolean => bigEnough(i.w * s, i.h * s);

/**
 * This desk with a new tile the office puts there itself (an agent's, Files', To-do's, an installed app's), quietly and on top
 * of the stack: in a free spot inside the desk if there's one (`placeNewTile`). A full desk grows to hold it, downward as it
 * always has, unless it holds an open tile and `scale` says how the office frames it here: then it grows the way that keeps
 * the desk's zoom (a column on the right of a desk that fills the screen's height), and never so an open tile that's live
 * goes under the size a live tile needs. If both ways would, the tile goes in a smaller free spot (`G.minApp`) if there is
 * one, and only then grows the desk the way that costs least.
 */
export function withNewTile(desk: LayoutDesk, id: string, app: AppId, scale?: DeskScale): LayoutDesk {
  let at = gridCell(desk, true) ?? freeSpot(desk);
  let size = { w: desk.w, h: desk.h };
  if (!at) {
    const down = gridCell(desk, false) ?? { x: G.padX, y: G.padTop, w: G.cell, h: G.cell };
    const tall = { w: desk.w, h: Math.max(desk.h, down.y + down.h + G.strip) };
    const open = desk.items.filter((i) => detailLevel(i.w, i.h, i.app) === 'open');
    const now = open.length && scale ? scale(desk.w, desk.h) : null;
    at = down;
    size = tall;
    if (now !== null && scale) {
      const rightmost = Math.max(desk.w - G.padX, ...desk.items.map((i) => i.x + i.w));
      const side = { x: rightmost + G.gap, y: G.padTop, w: G.cell, h: G.cell };
      const wide = { w: side.x + side.w + G.padX, h: Math.max(desk.h, side.y + side.h + G.strip) };
      const sTall = scale(tall.w, tall.h) ?? now;
      const sWide = scale(wide.w, wide.h) ?? now;
      const best = sWide > sTall + 1e-6 ? { at: side, size: wide, s: sWide } : { at: down, size: tall, s: sTall };
      const small = open.some((i) => liveAt(i, now) && !liveAt(i, best.s)) ? freeSpot(desk, G.minApp) : null;
      if (small) {
        at = small;
        size = { w: desk.w, h: desk.h };
      } else {
        at = best.at;
        size = best.size;
      }
    }
  }
  const item: LayoutItem = { id, app, x: roundUnit(at.x), y: roundUnit(at.y), w: at.w, h: at.h };
  return withStack(settleDesk({ ...desk, ...size, items: [...desk.items, item] }), [...stackOrder(desk), id]);
}

/**
 * This desk with one tile for each of its agents but the lead, as `agents` says. Null: the desk hasn't said, and nothing
 * changes. A tile whose agent is gone goes, the lead's own `agent:` tile included (it has the `agent` tile); a new agent's
 * comes at the end of the list (the phone grid's order) and on top of the stack (`withNewTile`). The same object if nothing changed.
 */
export function fitDeskToAgents(desk: LayoutDesk, agents: readonly TileAgent[] | null, scale?: DeskScale): LayoutDesk {
  if (!agents) return desk;
  const staff = agents.filter((a) => !a.lead).map((a) => a.id);
  const keep = new Set(staff);
  const kept = desk.items.filter((i) => !isAgentApp(i.app) || keep.has(agentIdOf(i.app) ?? ''));
  const have = new Set(kept.flatMap((i) => (isAgentApp(i.app) ? [agentIdOf(i.app)] : [])));
  const missing = staff.filter((id) => !have.has(id));
  if (kept.length === desk.items.length && !missing.length) return desk;
  let next: LayoutDesk = withStack({ ...desk, items: kept }, stackOrder({ items: kept, stack: desk.stack }));
  // Each on top: it's the newest thing on the desk.
  for (const agentId of missing) next = withNewTile(next, agentItemId(desk.id, agentId), agentApp(agentId), scale);
  return next;
}
