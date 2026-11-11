// Which tiles an open window of their own covers. A tile the window hides keeps no Tab stop: its focus ring would be drawn
// under the window, where nobody can see it (WCAG 2.4.11). It comes back when the window closes, moves or is made small.
import type { Camera } from '../canvas/camera';
import type { Rect } from '../canvas/layout';
import type { AppWindowState } from '../state/windowStore';

/** Ids of the tiles on `deskId` whose own window, as shown, has their centre under it. `tiles` are in world units. */
export function coveredTiles(
  deskId: string,
  tiles: readonly { id: string; rect: Rect }[],
  windows: readonly AppWindowState[],
  cam: Camera,
  viewport: { w: number; h: number },
  forceFull: boolean,
): string[] {
  const own = windows.filter((w) => w.deskId === deskId && !w.closing);
  if (own.length === 0) return [];
  const out: string[] = [];
  for (const t of tiles) {
    const win = own.find((w) => w.itemId === t.id);
    if (!win) continue;
    const r = forceFull || win.mode === 'full' ? { x: 0, y: 0, w: viewport.w, h: viewport.h } : win.rect;
    const cx = (t.rect.x + t.rect.w / 2) * cam.s + cam.x;
    const cy = (t.rect.y + t.rect.h / 2) * cam.s + cam.y;
    if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) out.push(t.id);
  }
  return out;
}
