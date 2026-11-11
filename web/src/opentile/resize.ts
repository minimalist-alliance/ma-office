// An open tile's grip (ADR 0053): any corner or edge, where a window's are. Free placement as everywhere on a larger screen
// (ADR 0062): exactly what's asked, from an app's minimum size up to the edges of the desk's work area. In the layer's chunk.
import { G, roundUnit, type Rect } from '../canvas/layout';

export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const EDGES: readonly Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** `r` with this edge or corner moved by `dx, dy` units. The opposite edges stay where they are. */
export function resizeFrom(r: Rect, edge: Edge, dx: number, dy: number, area: Rect): Rect {
  let { x, y, w, h } = r;
  if (edge.includes('e')) w = clamp(r.w + dx, G.minApp, area.x + area.w - r.x);
  if (edge.includes('s')) h = clamp(r.h + dy, G.minApp, area.y + area.h - r.y);
  if (edge.includes('w')) {
    x = clamp(r.x + dx, area.x, r.x + r.w - G.minApp);
    w = r.x + r.w - x;
  }
  if (edge.includes('n')) {
    y = clamp(r.y + dy, area.y, r.y + r.h - G.minApp);
    h = r.y + r.h - y;
  }
  return { x: roundUnit(x), y: roundUnit(y), w: roundUnit(w), h: roundUnit(h) };
}
