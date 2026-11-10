// An open tab learns that a new release shipped, and says so calmly. It never reloads by itself: a reload closes the
// member's windows and drops what lives only in this tab (held text, an address draft), so that's the member's call.
//
// What a reload would load is client-config's `version`, the release pointer the Platform loader reads to pick the
// bundle (ma-platform `sites/desk-loader/loader.js`), so that's what's asked, against the version this bundle was
// built as (`__MA_VERSION__`, also in its `ma-release.json`). A rollback reads as a new version too, rightly.
// Rarely, and never while the tab is hidden: a tab coming back after a while asks at once.
import { create } from 'zustand';
import { fetchClientConfig, type ClientConfig } from './clientConfig';

declare const __MA_VERSION__: string;

/** How often a visible tab asks. One small request; nothing waits on it. */
export const VERSION_CHECK_MS = 15 * 60_000;

export interface VersionWatch {
  /** The version this tab is running. */
  running: string;
  /** What a reload would load now, or nothing if that isn't known. */
  latest: () => Promise<string | undefined>;
  /** Once, with the newer version. Nothing is asked after it. */
  onReady: (version: string) => void;
  everyMs?: number;
  now?: () => number;
  doc?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
}

/** Starts asking. The first ask is a turn away, since the page has only just loaded what's current. Returns a stop. */
export function watchVersion(w: VersionWatch): () => void {
  const every = w.everyMs ?? VERSION_CHECK_MS;
  const now = w.now ?? (() => Date.now());
  const doc = w.doc ?? document;
  let lastAsked = now();
  let timer = 0;
  let asking = false;
  let stopped = false;

  const schedule = (): void => {
    window.clearTimeout(timer);
    timer = 0;
    if (stopped || asking || doc.hidden) return;
    timer = window.setTimeout(() => void ask(), Math.max(0, lastAsked + every - now()));
  };

  const ask = async (): Promise<void> => {
    timer = 0;
    if (stopped || doc.hidden) return;
    asking = true;
    lastAsked = now();
    let latest: string | undefined;
    try {
      latest = await w.latest();
    } catch {
      // Offline, or the API is down: say nothing, and ask again next turn.
    }
    asking = false;
    lastAsked = now(); // a turn from the answer, so a slow one can't bring the next ask straight after it
    if (stopped) return;
    if (latest && latest !== w.running) {
      stop();
      w.onReady(latest);
      return;
    }
    schedule();
  };

  const onVisibility = (): void => schedule();

  const stop = (): void => {
    stopped = true;
    window.clearTimeout(timer);
    doc.removeEventListener('visibilitychange', onVisibility);
  };

  doc.addEventListener('visibilitychange', onVisibility);
  schedule();
  return stop;
}

/** `ready` is the newer version, once heard; `dismissed` is the member putting the notice away for this page. */
export const useNewVersion = create<{ ready: string | null; dismissed: boolean }>(() => ({ ready: null, dismissed: false }));

export function dismissNewVersion(): void {
  useNewVersion.setState({ dismissed: true });
}

/** Tests can shorten the wait, outside production builds only: `?versionEveryMs=500`. */
function everyMs(): number {
  if (import.meta.env.MODE === 'production') return VERSION_CHECK_MS;
  const n = Number(new URLSearchParams(window.location.search).get('versionEveryMs'));
  return n > 0 ? n : VERSION_CHECK_MS;
}

/** For the signed-in shell. `npm run dev` has no client-config to ask, so it asks nothing. */
/** `onConfig` sees each fresh client-config too, for what else it says, such as the tier names. */
export function startVersionWatch(onConfig: (config: ClientConfig) => void = () => {}): () => void {
  if (import.meta.env.DEV) return () => {};
  return watchVersion({
    running: __MA_VERSION__,
    latest: async () => {
      const config = await fetchClientConfig(AbortSignal.timeout(15_000));
      onConfig(config);
      return config.version;
    },
    onReady: (version) => useNewVersion.setState({ ready: version }),
    everyMs: everyMs(),
  });
}
