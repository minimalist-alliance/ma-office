// Installed apps' tiles (ADR 0054): one tile per installed app on its desk, placed at the first free spot the way an agent's
// tile is (`placeNewTile`), and taken off when the desk says the app's gone (Remove keeps its data, not its tile). Quiet, like
// the agent and Files tiles: it isn't the member's change, so it saves nothing by itself and doesn't make a desk "arranged".
// Only a desk that has said what's installed is touched. A tile that goes takes its window with it. Pure `fitDeskToApps` first.
import { isDeskApp, type LayoutDesk } from '../../canvas/layout';
import { clearLayoutDoc } from '../../canvas/layoutDoc';
import { applyQuietly, useLayoutStore } from '../../state/layoutStore';
import { removeWindow, windowKey } from '../../state/windowStore';
import { useDeskAppsStore, type AppRecord, type TileInfo } from './store';
import { widgetOf } from './widget';
import { prefetchViews } from './cache';
import { fitDeskToApps } from './fit';

function sync(): void {
  const doc = useLayoutStore.getState();
  const said = useDeskAppsStore.getState().desks;
  let desks: Record<string, LayoutDesk> = doc.desks;
  const gone: string[] = [];
  for (const [id, desk] of Object.entries(doc.desks)) {
    const info = said[id];
    if (!info) continue;
    const fit = fitDeskToApps(desk, info.apps.map((a) => a.id));
    if (fit === desk) continue;
    if (desks === doc.desks) desks = { ...doc.desks };
    desks[id] = fit;
    for (const i of desk.items) if (isDeskApp(i.app) && !fit.items.some((x) => x.id === i.id)) gone.push(windowKey(id, i.app));
  }
  if (desks !== doc.desks) applyQuietly(clearLayoutDoc({ desks, z: doc.z }));
  for (const key of gone) removeWindow(key);
}

/** Each record's tile, kept per record so the canvas sees the same object until the desk says something new. */
const made = new WeakMap<AppRecord, TileInfo>();
function tileOf(rec: AppRecord): TileInfo {
  let t = made.get(rec);
  if (!t) {
    t = { summary: widgetOf(rec) };
    made.set(rec, t);
  }
  return t;
}

/** The tiles' widgets and words, for every desk that has said what's installed. */
function noteTiles(): void {
  const { desks, tiles } = useDeskAppsStore.getState();
  const next: Record<string, Record<string, TileInfo>> = {};
  let changed = Object.keys(tiles).length !== Object.keys(desks).length;
  for (const [deskId, info] of Object.entries(desks)) {
    const was = tiles[deskId];
    const same = !!was && Object.keys(was).length === info.apps.length && info.apps.every((r) => was[r.id] === tileOf(r));
    next[deskId] = same ? was : Object.fromEntries(info.apps.map((r) => [r.id, tileOf(r)]));
    changed ||= !same;
  }
  if (changed) useDeskAppsStore.setState({ tiles: next });
}

/** Keeps every desk's app tiles level with what it says is installed, and prefetches their views when idle. Returns a stop. */
export function startAppTiles(): () => void {
  const offApps = useDeskAppsStore.subscribe((s, prev) => {
    if (s.desks === prev.desks) return;
    noteTiles();
    sync();
    prefetchViews();
  });
  const offLayout = useLayoutStore.subscribe((s, prev) => {
    if (s.desks !== prev.desks) sync();
  });
  noteTiles();
  sync();
  prefetchViews();
  return () => {
    offApps();
    offLayout();
  };
}
