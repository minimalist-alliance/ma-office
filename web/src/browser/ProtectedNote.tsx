// The Browser window's small note when protected playback fails (TD-225). Tied to the tab where it happened (the desk says
// it on that tab, and a new page clears it), calm, and dismissible; dismissed, it stays gone for that site until the page is
// reloaded. See `protectedPlayback.ts` for the signal.
import { useState } from 'react';
import type { BrowserTab } from '../desk/deskLink';
import { openOnDevice } from './openOnDevice';
import { ProtectedWatch } from './protectedPlayback';
import './cards.css';

// The Product Designer's sentence (Nov 11, 03:48; Sales OKs it): no "yet", and one name for the place, as the button has.
export const PROTECTED_WORDS = 'This video is protected, so it can’t play on a desk.';

export function ProtectedNote({ deskId, tabs, hidden }: { deskId: string; tabs: readonly BrowserTab[]; hidden: boolean }) {
  const [watch] = useState(() => new ProtectedWatch(deskId));
  const [, bump] = useState(0);
  const note = hidden ? null : watch.noteFor(tabs);
  if (!note) return null;
  return (
    <div className="br-card" role="status" data-testid="browser-protected" data-tab={note.tabId}>
      <span className="br-card-one">{PROTECTED_WORDS}</span>
      <button type="button" className="br-card-link" onClick={() => openOnDevice(note.url)}>
        Open on this device
      </button>
      <button type="button" className="br-card-x" aria-label="Dismiss" onClick={() => { watch.dismiss(note.origin); bump((n) => n + 1); }}>
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  );
}
