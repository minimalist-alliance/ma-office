// Send to my desk's door in the first load (#9, S-141): the office's paste (Ctrl+V or ⌘V with focus on the office itself),
// the link that waited in this tab's sessionStorage across a sign-in, and the two places its chunk draws: the sheet over the
// office and the lines in the notices stack. Nothing of the sheet loads until a link has come.
import { lazy, Suspense, useEffect } from 'react';
import { useSession } from '../platform/session';
import { closeIncoming, linksOn, pastedLink, showIncoming, takePending, useOpen } from './intent';

const loadLayer = () => import('./OpenLayer');
const Sheet = lazy(() => loadLayer().then((m) => ({ default: m.OpenSheet })));
const Notices = lazy(() => loadLayer().then((m) => ({ default: m.OpenNotices })));

/** Focus is on the office itself: not in a field, a window (the stream is in one), a menu or a dialog. */
export function focusOnOffice(el: Element | null): boolean {
  if (!el || el === document.body || el === document.documentElement) return true;
  return !el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .ma-window, [role="dialog"], [role="menu"], [role="listbox"]');
}

/** The sheet, mounted in `Shell.tsx`. Also where a paste on the office and a link waiting from sign-in come in. */
export function OpenSheetDoor() {
  const on = useSession((s) => (s.config ? linksOn(s.config) : s.configFailed ? true : null));
  const incoming = useOpen((s) => s.incoming);

  // After a sign-in trip: the link that waited in this tab, read once.
  useEffect(() => {
    const url = takePending();
    if (url && !useOpen.getState().incoming) showIncoming({ kind: 'link', url });
  }, []);

  useEffect(() => {
    if (!on) return undefined;
    const onPaste = (e: ClipboardEvent): void => {
      if (e.defaultPrevented || useOpen.getState().incoming || !focusOnOffice(document.activeElement)) return;
      const url = pastedLink(e.clipboardData?.getData('text/plain'));
      if (!url) return;
      e.preventDefault();
      showIncoming({ kind: 'link', url });
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [on]);

  // The kill switch, once client-config says: what came is dropped, and the office is as it was.
  useEffect(() => {
    if (on === false && useOpen.getState().incoming) closeIncoming();
  }, [on, incoming]);

  if (!incoming || !on) return null;
  return (
    <Suspense fallback={null}>
      <Sheet />
    </Suspense>
  );
}

/** The lines while a link opens on a desk, and once it has: in the notices stack, once anything was sent from this page. */
export function OpenNoticesDoor() {
  const sending = useOpen((s) => s.sending);
  if (!sending) return null;
  return (
    <Suspense fallback={null}>
      <Notices />
    </Suspense>
  );
}
