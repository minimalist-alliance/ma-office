// Desk apps (S-97, ADR 0054), all that's in the first load: the door to the host's own chunk (`host/`), which holds everything
// else (what each desk says, the tiles' widgets, the sheet, the window, the checks, the bridge, the budget). It loads once a
// desk's `apps` topic says apps are available or installed, or the layout holds an app's tile; until then an app's tile is a
// plain tile, named "App". What the shell asks of an installed app goes through here, plain until the host is in.
import { create } from 'zustand';

type Host = typeof import('./host/index');

/** The first load's own window states, handed to the host (`watch.ts`): imported there, they stay in the first load's main chunk. */
export interface HostDeps {
  PanelBody: typeof import('../browser/BrowserWindow').PanelBody;
  deskPanel: typeof import('../notebook/panel').deskPanel;
  windowVm: typeof import('../desk/windowVm').windowVm;
}

/** The host once it's here, and a count the host moves whenever what it knows changes, for the first load's parts to redraw. */
export const useDoor = create<{ host: Host | null; rev: number }>(() => ({ host: null, rev: 0 }));

/**
 * The host once it's here, null before: what the shell asks of an installed app goes straight to it (`host?.name(...)`), with
 * the plain answer while it's null ("App", no widget, the generic glyph's blank, openable). A live binding, so no wrappers.
 */
export let host: Host | null = null;
let loading: Promise<void> | undefined;
/** What each desk's `apps` topic last said before the host was here, for the host to start from (its chunk loads after). */
const said = new Map<string, unknown>();

/**
 * Where the host's chunk comes from, and the window states it borrows: `deskapps/watch.ts` sets both, from the shell's own
 * first-load module. Imported by the host itself, the windows' desk states (`browser/BrowserWindow`, `desk/windowVm`,
 * `notebook/panel`) were split out of the first load's main chunk into a chunk of their own, 3 KB more of first load.
 */
let importHost: (() => Promise<Host>) | undefined;
let deps: HostDeps;
export const setHostImport = (f: () => Promise<Host>, d: HostDeps): void => {
  importHost = f;
  deps = d;
};

/** Loads the host's chunk, once. A load that failed is tried again the next time something asks. */
export function loadHost(): void {
  loading ??= importHost?.().then(
    (m) => {
      host = m;
      m.start(() => useDoor.setState((s) => ({ rev: s.rev + 1 })), deps, said);
      useDoor.setState({ host: m });
    },
    () => {
      loading = undefined;
    },
  );
}

/** What a desk's `apps` topic says (`desk/liveStore.ts`). */
export function noteApps(deskId: string, msg: unknown): void {
  if (host) host.noteApps(deskId, msg);
  else {
    said.set(deskId, msg);
    // A desk that says apps are available loads the host (one with an app's tile in its layout does too, `watch.ts`).
    if ((msg as { available?: unknown } | null)?.available === true) loadHost();
  }
}
