// "We stopped a request to close your account" in the office (ma-platform contract auth.md section 2.7; the words and the
// rules are `words.ts`'s). This folder is its own chunk: `shell/Shell.tsx` loads it only while `GET /v1/me` carries a
// `close_hold_cancelled` notice, so no member without one fetches any of it.
//
// A card among the shell's notices, which stays until the member says "Got it". It's said once a page load, through the
// shell's polite live region (the card itself isn't live, so a screen reader doesn't say it twice), and it never takes
// focus. "Got it" dismisses it for every app; a failure keeps it and says so (`role="alert"`, a new line each try), with
// focus still on the button. Done, focus goes back to where it came into the card from, and the region says so.
//
// With no desks, the office's own card is the whole office: this one shows in its place until "Got it", then that one.
//
// Account settings (the framed `/account`) shows the same notice with its own "Got it": the office's hides while that's
// open, so the two never show at once, and `/v1/me` is read again when it closes, so one dismissed there goes here too.
import { useEffect, useId, useRef, useState, type FocusEvent } from 'react';
import { api } from '../platform/api';
import { useSession } from '../platform/session';
import { useSettingsStore } from '../settings/settingsStore';
import { announce } from '../shell/announce';
import { bodyOf, closeHoldOf, DISMISS_PATH, saidOf, withoutCloseHold, WORDS } from './words';
import './closeHold.css';

/** Once per office load, per member and notice: said once, and gone for good once dismissed here. */
const said = new Set<string>();
const done = new Set<string>();

export default function CloseHoldNotice() {
  const me = useSession((s) => s.me);
  const settingsOpen = useSettingsStore((s) => s.open);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const id = useId();
  const card = useRef<HTMLElement>(null);
  const cameFrom = useRef<HTMLElement | null>(null);
  const notice = closeHoldOf(me);
  const key = notice && me ? `${me.userId} ${notice.at}` : '';
  const show = !!notice && !done.has(key) && !settingsOpen;

  useEffect(() => {
    if (!show || !notice || said.has(key)) return;
    said.add(key);
    announce(saidOf(notice));
  }, [show, key, notice]);

  // A close of Account settings asks whether the notice is still there: every close reads `/v1/me` again (`session.ts`).

  if (!show || !notice || !me) return null;

  const enter = (e: FocusEvent<HTMLElement>): void => {
    const from = e.relatedTarget;
    if (from instanceof HTMLElement && !e.currentTarget.contains(from)) cameFrom.current = from;
  };

  async function dismiss(): Promise<void> {
    if (busy || !me) return;
    setBusy(true);
    setFailed(false);
    try {
      await api<{ kind: string; dismissed: boolean }>(DISMISS_PATH, { method: 'POST' });
    } catch {
      setFailed(true);
      setBusy(false);
      return;
    }
    const hadFocus = !!card.current?.contains(document.activeElement);
    const back = cameFrom.current;
    done.add(key);
    // With no desks the office's own card was waiting behind this one (`closeHold.css`): it's said with the dismiss.
    const own = document.querySelector('.desk-notice h2')?.textContent;
    announce(own ? `${WORDS.dismissed} ${own}.` : WORDS.dismissed);
    const now = useSession.getState().me;
    if (now?.userId === me.userId) useSession.setState({ me: withoutCloseHold(now) });
    setBusy(false);
    if (hadFocus && back?.isConnected) back.focus({ preventScroll: true });
  }

  return (
    <section ref={card} className="notice close-hold" aria-labelledby={`${id}-h`} onFocus={enter} data-testid="close-hold-notice">
      <h2 id={`${id}-h`} className="close-hold-title">
        {WORDS.title}
      </h2>
      <p>{bodyOf(notice)}</p>
      <p>{WORDS.notYou}</p>
      {failed && (
        <p className="close-hold-error" role="alert" data-testid="close-hold-error">
          {WORDS.failed}
        </p>
      )}
      <button type="button" className="btn close-hold-ok" aria-disabled={busy || undefined} onClick={() => void dismiss()} data-testid="close-hold-dismiss">
        {WORDS.dismiss}
      </button>
    </section>
  );
}
