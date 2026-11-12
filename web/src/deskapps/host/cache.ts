// A view's files, checked once per version and kept in memory (ADR 0054): `apps.view.get`, then `verifyView`. Fetched when the
// office is idle for every installed app on a desk whose link is open, so opening the window meets budget B4 (contract 3.2). A
// refusal is kept too (the same bytes fail the same way); a call that didn't get through isn't, so the next open asks again.
import { liveDeskLink } from './link';
import { reviewKeys } from './keys';
import { verifyView, type Verdict } from './verify';
import { useDeskAppsStore } from './store';
import interUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';

const views = new Map<string, Promise<Verdict>>();
/** What each desk's last catalog said is revoked (`apps.catalog.get`, where it says). */
const revoked = new Map<string, { keys: ReadonlySet<string>; manifests: ReadonlySet<string> }>();

export function noteRevoked(deskId: string, keys: ReadonlySet<string>, manifests: ReadonlySet<string>): void {
  revoked.set(deskId, { keys, manifests });
  // A view checked before the catalog said so is checked again.
  if (keys.size || manifests.size) for (const k of [...views.keys()]) if (k.startsWith(`${deskId}|`)) views.delete(k);
}

const keyOf = (deskId: string, appId: string, version: string): string => `${deskId}|${appId}|${version}`;

/** This app's view at this version, checked. Rejects when the desk couldn't be asked. */
export function viewFor(deskId: string, appId: string, version: string): Promise<Verdict> {
  const key = keyOf(deskId, appId, version);
  let p = views.get(key);
  if (!p) {
    const link = liveDeskLink(deskId);
    if (!link) return Promise.reject(new Error('no link'));
    const r = revoked.get(deskId);
    p = link.call('apps.view.get', { id: appId }).then((raw) => verifyView(raw, reviewKeys(), { appId, ...(r ? { revokedKeys: r.keys, revokedManifests: r.manifests } : {}) }));
    views.set(key, p);
    p.catch(() => {
      if (views.get(key) === p) views.delete(key);
    });
  }
  return p;
}

/** Forget a view, as after its window found it changed under it. */
export const forgetView = (deskId: string, appId: string, version: string): boolean => views.delete(keyOf(deskId, appId, version));

let idleAsk = 0;
/** Every installed app's view on every desk whose link is open, once the office is idle. */
export function prefetchViews(): void {
  if (idleAsk) return;
  const ric = (window as unknown as { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  const run = (): void => {
    idleAsk = 0;
    for (const [deskId, info] of Object.entries(useDeskAppsStore.getState().desks)) {
      if (!info.available || !liveDeskLink(deskId)) continue;
      for (const a of info.apps) if (a.window && a.state !== 'failed' && a.state !== 'disabled') viewFor(deskId, a.id, a.version).catch(() => undefined);
    }
  };
  idleAsk = ric ? ric(run, { timeout: 4000 }) : window.setTimeout(run, 1500);
}

let font: Promise<Uint8Array | null> | null = null;
/** The office's UI font, as bytes, for the view's frame: once, from the office's own origin (`connect-src 'self'`). */
export function fontBytes(): Promise<Uint8Array | null> {
  font ??= fetch(interUrl)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
    .then((b) => new Uint8Array(b))
    .catch(() => {
      font = null;
      return null;
    });
  return font;
}
