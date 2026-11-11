// Open tiles (ADR 0053, the owner, Nov 11): "When I expand the apps enough, they are supposed to actually be viewable and
// usable right there on my desk". A tile at the `open` level (`canvas/layout.ts`) is the app's own window component, live,
// docked to the tile as DOM over the canvas (`OpenTileLayer.tsx`, its own chunk). Pure rules only, so the canvas, the
// keyboard, `openWindow` and the layer agree, and they're tested on their own. In the initial bundle: it's small.
import { detailLevel, overlaps, stackOrder, type AppId, type LayoutDesk, type Rect } from '../canvas/layout';
import { mayHaveApp } from '../platform/age';

/** Under this width on screen, at rest, an open tile draws its `large` widget instead: the carousel's rule. */
export const OPEN_LIVE_MIN_W = 480;
/** And under this height: the head and enough of the app to use. */
export const OPEN_LIVE_MIN_H = 320;
/** At most this many live at once, the largest on screen first; the rest draw their widget. */
export const MAX_LIVE = 4;

export interface Cam {
  x: number;
  y: number;
  s: number;
}

/** A tile's box on screen, in CSS pixels, for its desk at `desk` in the world and this camera. */
export const tileOnScreen = (desk: { x: number; y: number }, item: Rect, cam: Cam): { left: number; top: number; width: number; height: number } => ({
  left: (desk.x + item.x) * cam.s + cam.x,
  top: (desk.y + item.y) * cam.s + cam.y,
  width: item.w * cam.s,
  height: item.h * cam.s,
});

/** Is a tile this big on screen one that can hold the live app? */
export const bigEnough = (wPx: number, hPx: number): boolean => wPx >= OPEN_LIVE_MIN_W && hPx >= OPEN_LIVE_MIN_H;

/**
 * Which of a desk's tiles are live, for a camera at rest and a viewport: those at `open`, whose app has no window open on
 * this desk (its window wins), with nothing above them in the stack over them (the canvas can't draw over the DOM, so a
 * covered tile stays a drawing, stacked as the canvas stacks it), at least `bigEnough` and partly on screen. The largest
 * on screen first, one place per app (two tiles of one app: the larger), at most `MAX_LIVE`. The caller has already
 * asked the rest: the shown desk, not a phone, not in carousel mode, the switch on.
 */
export function liveTiles(desk: Pick<LayoutDesk, 'x' | 'y' | 'items' | 'stack'>, cam: Cam, vp: { w: number; h: number }, windowApps: ReadonlySet<AppId>): string[] {
  const order = stackOrder(desk);
  const byId = new Map(desk.items.map((i) => [i.id, i]));
  const found: { id: string; app: AppId; seen: number; z: number }[] = [];
  order.forEach((id, z) => {
    const item = byId.get(id)!;
    if (detailLevel(item.w, item.h, item.app) !== 'open' || windowApps.has(item.app) || !mayHaveApp(item.app)) return;
    if (order.slice(z + 1).some((above) => overlaps(byId.get(above)!, item))) return;
    const b = tileOnScreen(desk, item, cam);
    if (!bigEnough(b.width, b.height)) return;
    const seen = Math.max(0, Math.min(b.left + b.width, vp.w) - Math.max(b.left, 0)) * Math.max(0, Math.min(b.top + b.height, vp.h) - Math.max(b.top, 0));
    if (seen > 0) found.push({ id, app: item.app, seen, z });
  });
  found.sort((a, b) => b.seen - a.seen || b.z - a.z);
  const apps = new Set<AppId>();
  const live: string[] = [];
  for (const f of found) {
    if (live.length >= MAX_LIVE) break;
    if (apps.has(f.app)) continue;
    apps.add(f.app);
    live.push(f.id);
  }
  return live;
}
