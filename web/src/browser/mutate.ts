// A mutation's retries (deskd API.md section 10). One thing the member did keeps one `idem` across every retry, so a
// lost reply still works: the same key gets the stored reply, and the command never goes out twice. Nothing here ever
// makes a second key, because `unavailable` doesn't always mean nothing happened. A page hung for 5 s can still type,
// so a new key on `browser.text.insert` could type the text twice. If the member asks again, that's a new call here.
//
// - `deadline_exceeded`, `cancelled`: it may have gone out. Retry to find out.
// - `unavailable`: nothing was done, so retry on backoff. From the deskd release that sends `mayHaveApplied`, the same
//   key runs it. bf3c366 and older store the error and replay it for 10 minutes, so there this waits and gives up:
//   slower, and never twice.
// - `unavailable` or `internal` with `mayHaveApplied: true`: it may have gone out, and the member should know. Back to
//   the caller.
// - `unavailable` with `reason: "active_tab"`: nothing was done, and nothing changes until the member acts. Back to the
//   caller.
//
// A key only protects while deskd keeps the reply, and a deskd restart loses it. A session that goes takes its unanswered
// calls with it (`PeerSession.close`), so a lost reply is never retried on a new session: the caller hears, and the
// member decides. Only `unavailable` with no flag waits long enough to cross one, and that says nothing was done.
import { DeskNotConnected } from '../desk/deskLink';
import { uuidv7 } from '../desk/idem';
import { backoffMs } from '../desk/rtc/backoff';

/** Past Chromium's slowest start: a fresh root's first took about 73 s on a real desk. It's cheap, as nothing was done. */
const UNAVAILABLE_GIVE_UP_MS = 120_000;
/** So what the member asked for goes soon after Chromium is up, not a long backoff later. */
const UNAVAILABLE_RETRY_MAX_MS = 5_000;
const LOST_REPLY_RETRIES = 2;

const code = (err: unknown): string => (err as { code?: string } | null)?.code ?? '';
const details = (err: unknown): { reason?: unknown; mayHaveApplied?: unknown } => (err as { details?: { reason?: unknown; mayHaveApplied?: unknown } } | null)?.details ?? {};
const lostReply = (err: unknown): boolean => code(err) === 'deadline_exceeded' || code(err) === 'cancelled';

/** It failed, and it may still have happened. Trying again is the member's call, once they've looked. */
export const mayHaveGoneOut = (err: unknown): boolean => details(err).mayHaveApplied === true || lostReply(err) || (err instanceof DeskNotConnected && err.inFlight);

/** It's certain this didn't happen: deskd's answer has no flag, which says nothing was done (API.md section 4), or it never left here. */
export const certainlyNotDone = (err: unknown): boolean => !mayHaveGoneOut(err) && (code(err) !== '' || err instanceof DeskNotConnected);

/** `idem` is the action's own key when it outlives one run here, as Send to my desk's does across Try again (`open/sendToDesk.ts`). */
export async function mutate<T>(call: (idem: string) => Promise<T>, idem: string = uuidv7()): Promise<T> {
  const started = Date.now();
  let attempt = 0;
  let lost = 0;
  for (;;) {
    try {
      return await call(idem);
    } catch (err) {
      const nothingDone = code(err) === 'unavailable' && details(err).reason !== 'active_tab' && details(err).mayHaveApplied !== true;
      if (nothingDone && Date.now() - started < UNAVAILABLE_GIVE_UP_MS) {
        await new Promise((done) => window.setTimeout(done, Math.min(backoffMs(attempt), UNAVAILABLE_RETRY_MAX_MS)));
        attempt += 1;
      } else if (lostReply(err) && lost < LOST_REPLY_RETRIES) {
        lost += 1;
      } else {
        // An earlier try may have gone out, and now there's no session to ask.
        if (lost > 0 && err instanceof DeskNotConnected) err.inFlight = true;
        throw err;
      }
    }
  }
}
