// The office tour's setting, written (ADR 0056 decision 9). Never in the first load: the account menu's switch (the
// popovers chunk) and the tour's own chunk share it. Reading is `door.ts`'s `tourOff`.
//
// A change goes to this browser first, then to the layout document once it has been read (written earlier, it could hide
// what another device saved; `door.ts` sends this browser's choice up at the next read if the document has none), and to
// Platform's `preferences.officeTour` only while Platform sends that field, which is its sign that the office may write it.
// Nothing else is kept: no step reached, no times, no counts.
import { writeJson } from '../lib/util';
import { api } from '../platform/api';
import { useSession } from '../platform/session';
import { layoutDocRead, setLayoutPref } from '../shell/layoutSync';
import { layoutMirrorWritable } from '../state/layoutStore';
import { serverTour, TOUR_KEY, TOUR_MIRROR, useTour } from './door';

/** Done, "Don't show this again" and the switch off: `true`. The switch on: `false`, and the tour starts the next time the office opens. */
export function setTourOff(off: boolean): void {
  const me = useSession.getState().me;
  // Part of the saved layout's mirror (ISS-67, Security's ISS67-L1): never written once this page or another tab has signed out.
  if (layoutMirrorWritable()) writeJson(TOUR_MIRROR, { who: me?.userId ?? null, off });
  if (layoutDocRead()) setLayoutPref({ [TOUR_KEY]: off });
  const toPlatform = serverTour(me) !== undefined;
  useTour.setState((s) => ({ tick: s.tick + 1, ...(toPlatform ? { sent: off } : {}) }));
  if (toPlatform) void sendToPlatform(off);
}

/**
 * `PUT /v1/me/preferences {"officeTour": {"off": <bool>}}` (the contract proposed to Platform in
 * `docs/sub-status/walkthrough.md`). A failure says nothing: this browser and the document hold the choice, and this page
 * keeps reading what it sent.
 */
async function sendToPlatform(off: boolean): Promise<void> {
  try {
    await api('/v1/me/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ officeTour: { off } }) });
  } catch {
    /* kept here and in the document */
  }
}
