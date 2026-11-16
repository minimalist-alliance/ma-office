// The tiles of the first-party apps that ship ON for every personal and work desk after the default row: Files (ADR "Files
// app" decision 9), To-do (the To-do VISION, "on by default") and Documents (draft ADR "Documents"; a teen's desk has it
// too, deskd API.md §24). None goes on a Guild Desk's panel. A member who already
// has a layout finds the tile the way an agent's tile comes: put in the first free spot by the desk's own sync, quietly. It
// isn't the member's change, so it saves nothing by itself and doesn't make a desk "arranged" (`isUntouched` ignores it). Each
// app's kill switch in client-config (`files.enabled`, `todo.enabled`, `documents.enabled`, default true) takes its tile away again. Pure
// `fitDeskToApp` first; the store subscription second.
import { withNewTile, type DeskScale } from '../canvas/agentTiles';
import { placeScale } from '../canvas/placeScale';
import { stackOrder, withStack, type LayoutDesk } from '../canvas/layout';
import { clearLayoutDoc } from '../canvas/layoutDoc';
import { isGuildPanel } from '../guild/panel';
import { getClientConfig, type ClientConfig } from '../platform/clientConfig';
import { applyQuietly, useLayoutStore } from '../state/layoutStore';
import { removeWindow, windowKey } from '../state/windowStore';

export type ShippedApp = 'files' | 'todo' | 'documents';

/** This desk with `app`'s tile if `on` and it hasn't one, without it if not `on`. The same object if nothing changes. */
export function fitDeskToApp(desk: LayoutDesk, app: ShippedApp, on: boolean, scale?: DeskScale): LayoutDesk {
  if (on === desk.items.some((i) => i.app === app)) return desk;
  if (!on) {
    const items = desk.items.filter((i) => i.app !== app);
    return withStack({ ...desk, items }, stackOrder({ items, stack: desk.stack }));
  }
  // In a free spot before the desk grows, and never so an open tile that's live goes under live size (`withNewTile`).
  return withNewTile(desk, `${desk.id}:${app}`, app, scale);
}

/** The Files tile, as it always was. */
export const fitDeskToFiles = (desk: LayoutDesk, on: boolean): LayoutDesk => fitDeskToApp(desk, 'files', on);

/** Keeps every desk's tiles of these apps as their kill switches say (default on), placed for this screen (`placeScale`). Returns a stop. */
export function watchAppTiles(apps: readonly ShippedApp[] = ['files', 'todo', 'documents']): () => void {
  // Nothing is added or taken away until client-config has been asked: its kill switch may say no.
  let on: Record<ShippedApp, boolean> | null = null;
  const sync = (): void => {
    if (on === null) return;
    const doc = useLayoutStore.getState();
    const desks: Record<string, LayoutDesk> = { ...doc.desks };
    let changed = false;
    for (const [id, desk] of Object.entries(doc.desks)) {
      if (isGuildPanel(id)) continue;
      let fit = desk;
      for (const app of apps) {
        const next = fitDeskToApp(fit, app, on[app], placeScale);
        if (next !== fit && !on[app]) removeWindow(windowKey(id, app));
        fit = next;
      }
      if (fit === desk) continue;
      desks[id] = fit;
      changed = true;
    }
    if (changed) applyQuietly(clearLayoutDoc({ desks, z: doc.z }));
  };
  const off = useLayoutStore.subscribe((s, prev) => {
    if (s.desks !== prev.desks) sync();
  });
  const read = (c: ClientConfig | null): void => {
    on = { files: c?.files?.enabled !== false, todo: c?.todo?.enabled !== false, documents: c?.documents?.enabled !== false };
    sync();
  };
  void getClientConfig().then(read, () => read(null));
  return off;
}
