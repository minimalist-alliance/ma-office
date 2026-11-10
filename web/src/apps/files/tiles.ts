// The Files tile on each desk. Files ships ON for every personal and work desk (not a Guild Desk's panel, ADR "Files app"
// decision 9), so a member who already has a layout finds its tile the way an agent's tile comes: put at the first free cell
// by the desk's own sync, quietly. It isn't the member's change, so it saves nothing by itself and doesn't make a desk
// "arranged" (`isUntouched` ignores it). The kill switch `files.enabled` in client-config, default true, takes the tile
// away again. Pure `fitDeskToFiles` first; the store subscription second.
import { placeNewTile } from '../../canvas/agentTiles';
import { roundUnit, settleDesk, stackOrder, withStack, type LayoutDesk } from '../../canvas/layout';
import { clearLayoutDoc } from '../../canvas/layoutDoc';
import { isGuildPanel } from '../../guild/panel';
import { getClientConfig } from '../../platform/clientConfig';
import { applyQuietly, useLayoutStore } from '../../state/layoutStore';
import { removeWindow, windowKey } from '../../state/windowStore';

/** This desk with the Files tile if `on` and it hasn't one, without it if not `on`. The same object if nothing changes. */
export function fitDeskToFiles(desk: LayoutDesk, on: boolean): LayoutDesk {
  if (on === desk.items.some((i) => i.app === 'files')) return desk;
  if (!on) {
    const items = desk.items.filter((i) => i.app !== 'files');
    return withStack({ ...desk, items }, stackOrder({ items, stack: desk.stack }));
  }
  const at = placeNewTile(desk);
  const id = `${desk.id}:files`;
  const items = [...desk.items, { id, app: 'files' as const, x: roundUnit(at.x), y: roundUnit(at.y), w: at.w, h: at.h }];
  return withStack(settleDesk({ ...desk, items }), [...stackOrder(desk), id]);
}

/** Keeps every desk's Files tile as the kill switch (`files.enabled`, default on) says. Returns a stop. */
export function watchFilesTiles(): () => void {
  // Nothing is added or taken away until client-config has been asked: its kill switch may say no.
  let on: boolean | null = null;
  const sync = (): void => {
    if (on === null) return;
    const doc = useLayoutStore.getState();
    const desks: Record<string, LayoutDesk> = { ...doc.desks };
    let changed = false;
    for (const [id, desk] of Object.entries(doc.desks)) {
      const fit = isGuildPanel(id) ? desk : fitDeskToFiles(desk, on);
      if (fit === desk) continue;
      desks[id] = fit;
      changed = true;
      if (!on) removeWindow(windowKey(id, 'files'));
    }
    if (changed) applyQuietly(clearLayoutDoc({ desks, z: doc.z }));
  };
  const off = useLayoutStore.subscribe((s, prev) => {
    if (s.desks !== prev.desks) sync();
  });
  void getClientConfig().then(
    (c) => ((on = c.files?.enabled !== false), sync()),
    () => ((on = true), sync()),
  );
  return off;
}
