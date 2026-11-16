// The viewport (CONCEPT.md §2): the real app from one of the member's desks, live, so they can act in it, built from the office's
// own window parts (`LiveWindow`, the same component an app window holds, in the `ma-window` wrapper). It takes `(deskId, app,
// ref)` from a closed enum (`viewApp`), never a URL, and never a frame origin of its own; a desk the office doesn't list, or an
// app the member can't have, shows nothing. "Open on my desk" leaves the room for that desk and opens the app there.
import { useEffect } from 'react';
import { parseDocRef } from '../apps/documents/wire';
import { setDocTarget } from '../apps/documents/target';
import { appDef } from '../apps/registry';
import type { AppId } from '../canvas/layout';
import { focusDesk, openItem } from '../shell/actions';
import { mayHaveApp } from '../platform/age';
import { useLayoutStore } from '../state/layoutStore';
import { LiveWindow } from '../windows/LiveWindow';
import { closeViewport, leave, type Viewport as Shown } from './ui';
import { W } from './words';

/** Leaves the room for the desk itself, with the app open there (its tile's own way of opening, `openItem`). */
export function openOnDesk(deskId: string, app: AppId): void {
  leave();
  const item = useLayoutStore.getState().desks[deskId]?.items.find((i) => i.app === app);
  // After the desks are back, so the camera's move into the desk is seen.
  window.setTimeout(() => (item ? openItem(deskId, item.id) : focusDesk(deskId)), 80);
}

export function Viewport({ shown, deskName, phone }: { shown: Shown; deskName: string; phone: boolean }) {
  const app = shown.app as AppId;
  const onDesk = useLayoutStore((s) => s.desks[shown.deskId]?.items.some((i) => i.app === app) ?? false);
  // An app the member can't have, one the desk doesn't show as a tile, or one the office has no window for: nothing (MR-L1, MR-L2).
  const def = onDesk && mayHaveApp(app) ? appDef(app, shown.deskId) : null;
  // Documents at a document (her `office_show` `d_…#p3`, deskd API.md §24): the window's body opens its viewer there.
  useEffect(() => {
    const at = shown.app === 'documents' ? parseDocRef(shown.ref) : null;
    if (at) setDocTarget(shown.deskId, { docId: at.docId, page: at.page });
  }, [shown.deskId, shown.app, shown.ref]);
  if (!def?.Window) return null;
  const name = def.name;
  return (
    <section
      className="mm-vp"
      aria-label={`${name} on ${deskName}, ${W.viewport.toLowerCase()}`}
      onKeyDown={(e) => {
        // Esc closes the viewport only, unless the app inside took it first.
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.stopPropagation();
          closeViewport();
        }
      }}
    >
      <header className="mm-vp-head">
        <span className="mm-desk">{deskName}</span>
        <span className="mm-vp-app">{name}</span>
        <span className="mm-vp-sp" />
        {shown.by === 'maia' && !phone && <span className="mm-vp-by">{W.shownByMaia}</span>}
        <button type="button" className="mm-btn" onClick={() => openOnDesk(shown.deskId, app)}>
          {phone ? W.openShort : W.openOnDesk}
        </button>
        <button type="button" className="mm-icon-btn" aria-label={`${W.closeViewport} ${name}`} title={`${W.closeViewport} (Esc)`} onClick={closeViewport}>
          <svg viewBox="0 0 24 24" aria-hidden="true" className="mm-ico">
            <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
          </svg>
        </button>
      </header>
      <LiveWindow key={`${shown.deskId}:${app}`} deskId={shown.deskId} deskName={deskName} app={app} className="mm-vp-body active" />
    </section>
  );
}
