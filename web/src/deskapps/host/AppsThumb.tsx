// A phone's way to the Apps sheet (ADR 0054; the UI/UX Engineer's call): phones have no desk menu, so the phone carousel's thumb
// row ends with an Apps button wherever the desk menu's Apps row would show. It opens the sheet, full screen there. Its glyph is
// a plus in a rounded square, outlined in the glyph tones like its neighbours and never accent-filled (the Designer, Nov 11):
// the four squares stay the office's own.
import { appsRowShows } from './manage';
import { openAppsSheet, useDeskAppsStore } from './store';

export function AppsThumb({ deskId }: { deskId: string }) {
  const shows = useDeskAppsStore((s) => appsRowShows(deskId, s));
  if (!shows) return null;
  return (
    <button type="button" className="thumb thumb-apps" aria-label="Apps" data-testid="thumb-apps" onClick={() => openAppsSheet(deskId)}>
      <svg width={28} height={28} viewBox="0 0 48 48" aria-hidden="true" className="app-glyph" data-glyph="add">
        <rect x="8" y="8" width="32" height="32" rx="9" fill="var(--ma-glyph-page)" stroke="var(--ma-glyph-soft)" strokeWidth="2.2" />
        <path d="M24 16.5v15M16.5 24h15" stroke="var(--ma-glyph)" strokeWidth="2.6" strokeLinecap="round" />
      </svg>
    </button>
  );
}
