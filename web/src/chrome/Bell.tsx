// The top bar's bell (ma-platform ADR 0125 §9, contract notifications.md): the member's notifications, one list across
// the office, the account site and Community Forums. The panel is the one every bell renders (`packages/bell-kit`
// SPEC.md, vendored from ma-platform): the rows, their words, the time and the count come from the kit's model; this
// file only lays them out with the office's tokens. A small count in the accent tint, never red, capped at "9+". No
// sound, no toast. The panel behaves as the account menu's: a dialog, shut by a click outside or Esc, and the keyboard
// goes back to the bell. Hidden until `/v1/me` has answered, and while the kill switch is off (`503 notifications_paused`).
// The panel's rows are `BellPanel.tsx`, in the top bar's popovers chunk; the list is asked for here, the moment it opens.
import { useEffect, useRef, useState } from 'react';
import { bellLabel, countLabel } from '../../../packages/bell-kit/model.mjs';
import { useOnDemand } from '../lib/onDemand';
import { loadNotifications, postSeen, setUnread, startUnreadWatch, useNotifications } from '../platform/notifications';
import { useSession } from '../platform/session';
import type { BellList } from './BellPanel';
import { Icon } from './icons';
import { popovers } from './popoversChunk';

const FOCUSABLE = 'a[href], button:not(:disabled)';

export function Bell() {
  const signedIn = useSession((s) => s.me !== null);
  const paused = useNotifications((s) => s.paused);

  // The count is asked only while the member is signed in; signed out, what was known goes with them.
  useEffect(() => {
    if (!signedIn) return undefined;
    const stop = startUnreadWatch();
    return () => {
      stop();
      useNotifications.setState({ unread: null, etag: null, paused: false });
    };
  }, [signedIn]);

  if (!signedIn || paused) return null;
  return <BellMenu />;
}

function BellMenu() {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<BellList>('loading');
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const unread = useNotifications((s) => s.unread);
  const [now, setNow] = useState(() => Date.now());

  // Shut by a click outside or Esc, as the account menu is; Tab and Shift+Tab stay among the bell and the panel's controls.
  useEffect(() => {
    if (!open) return undefined;
    const el = ref.current;
    const onDown = (e: PointerEvent): void => {
      if (!el?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        btnRef.current?.focus();
      } else if (e.key === 'Tab' && el) {
        const ring = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('pointerdown', onDown);
    el?.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      el?.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Opening: the list, and "seen" (it marks nothing read). The list's `unread` is the freshest count there is.
  useEffect(() => {
    if (!open) return undefined;
    let gone = false;
    setList('loading');
    setNow(Date.now());
    void postSeen().catch(() => {});
    void loadNotifications().then((r) => {
      if (gone) return;
      if (!r) {
        setList('failed');
        return;
      }
      setList({ items: r.items });
      setUnread(r.unread);
    });
    return () => {
      gone = true;
    };
  }, [open]);

  const count = unread ?? 0;
  const pill = countLabel(count);
  // The panel is the popovers chunk's (`BellPanel.tsx`), here from the page's first idle moment.
  const Panel = useOnDemand(popovers, open && 'open')?.BellPanel;

  return (
    <div className="menu-wrap" ref={ref}>
      <button
        ref={btnRef}
        type="button"
        className={`icon-btn chrome bell-btn${open ? ' on' : ''}`}
        aria-expanded={open}
        aria-controls="bell-panel"
        aria-label={bellLabel(count)}
        title="Notifications"
        onClick={() => setOpen((v) => !v)}
        data-testid="bell"
      >
        <Icon name="bell" />
        {pill && (
          <span className="bell-count" aria-hidden="true" data-testid="bell-count">
            {pill}
          </span>
        )}
      </button>
      {open && Panel && <Panel list={list} setList={setList} count={count} now={now} />}
    </div>
  );
}
