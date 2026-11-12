// The desk app host's own chunk (ADR 0054): everything of desk apps but the `app:` id kind, the desk menu's row and the door that
// loads this (`../door.ts`), which hands on what each desk's `apps` topic says and asks this chunk for names, widgets and glyphs.
import { useSession } from '../../platform/session';
import { installedApp, noteApps, useDeskAppsStore } from './store';
import { startAppTiles } from './tiles';
import { setShared } from './deps';
import type { HostDeps } from '../door';

export { default as AppsSheet } from './AppsSheet';
export { AppsLayer } from './AppsLayer';
export { AppsThumb } from './AppsThumb';
export { AppView, AppWindowBody } from './AppView';
export { DeskGlyph, drawGlyph } from './glyph';
export { appsRowShows } from './manage';
export { appOpenable as openable, deskAppName as name, deskAppSummary as summary, dropApps, glyphFor, noteApps, noteAppsRefused, openAppsSheet, shortcutGroups } from './store';
export { startAppTiles } from './tiles';

/** An installed app's window size from its manifest (contract 1.2 `views.window`), with the frame's 44 px title bar. */
export function windowSize(app: Parameters<typeof installedApp>[1]): { w: number; h: number } | null {
  const win = installedApp(undefined, app)?.window;
  return win ? { w: Math.max(360, win.width), h: Math.max(280, win.height + 44) } : null;
}

/**
 * The door's hand-over (`../door.ts`): the first load's redraw, the window states it lends, and what each desk said before this
 * chunk was here. From here on every change this chunk knows of moves the door's count, the kill switch follows client-config,
 * and the tiles are kept level.
 */
export function start(redraw: () => void, deps: HostDeps, said: ReadonlyMap<string, unknown>): void {
  setShared(deps);
  // What each desk said before this chunk was here, as the door kept it: the topic says nothing new until something changes.
  for (const [deskId, msg] of said) noteApps(deskId, msg);
  const sync = (): void => {
    const on = useSession.getState().config?.deskApps?.enabled !== false;
    if (useDeskAppsStore.getState().switchOn !== on) useDeskAppsStore.setState({ switchOn: on });
  };
  sync();
  useSession.subscribe(sync);
  useDeskAppsStore.subscribe(redraw);
  startAppTiles();
  redraw();
}
