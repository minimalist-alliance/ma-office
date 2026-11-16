// The close hold's notice in the office (ma-platform contract auth.md section 2.7, `sub/lost-app-close-hold`; status
// docs/sub-status/close-hold-notice.md). A member with no card on file who loses their authenticator app has one way out:
// support closes the account at its address's request after 7 days, unless the account is used first. When a sign-in or a
// refresh stops it, `GET /v1/me` carries `notices: [{kind: "close_hold_cancelled", at, requestedAt}]` until the member
// dismisses it, for every app. Pure: the card (`Card.tsx`) and its one call are this folder's lazy chunk, which
// `shell/Shell.tsx` loads only when `/v1/me` carries this kind. Words follow the brand kit's voice: plain, calm, no
// exclamation marks. Every sentence is in `WORDS`, so a change from Sales is one edit here.
import type { Me } from '../platform/api';

/** The one kind the office shows. `Shell.tsx` keeps its own copy of the string, so the first load needn't import this. */
export const CLOSE_HOLD_KIND = 'close_hold_cancelled';

export interface CloseHold {
  /** When the request was stopped (the account was used): an ISO time. */
  at: string;
  /** When the request came in, or null. */
  requestedAt: string | null;
}

const time = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);

/**
 * The stopped request's notice from `GET /v1/me`, or null. Anything not in the contract's shape is none, never an error:
 * `notices` absent or not an array, another kind, an `at` that isn't a time. A `requestedAt` that isn't a time is null.
 */
export function closeHoldOf(me: Pick<Me, 'notices'> | null | undefined): CloseHold | null {
  const list: unknown = me?.notices;
  if (!Array.isArray(list)) return null;
  for (const n of list as unknown[]) {
    if (!n || typeof n !== 'object') continue;
    const { kind, at, requestedAt } = n as { kind?: unknown; at?: unknown; requestedAt?: unknown };
    if (kind !== CLOSE_HOLD_KIND) continue;
    const when = time(at);
    if (when) return { at: when, requestedAt: time(requestedAt) };
  }
  return null;
}

/** "November 12, 2026", in UTC, as `/account` and the mail say it. */
export const dayOf = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

/** Sales' words (Nov 12), as the UI/UX Engineer passed them on. `/account`'s card has the same, but for "on this page". */
export const WORDS = {
  title: 'We stopped a request to close your account',
  asked: (requestedAt: string | null): string =>
    requestedAt
      ? `On ${dayOf(requestedAt)}, someone writing from this account's email address asked us to close it.`
      : "Someone writing from this account's email address asked us to close it.",
  used: (at: string): string => `Your account was used on ${dayOf(at)}, so the account stays open and nothing was deleted.`,
  notYou: "If that wasn't you, someone may be able to read your email. Change your email password.",
  dismiss: 'Got it',
  dismissed: 'Notice dismissed.',
  failed: "That didn't save. Try again.",
} as const;

/** The card's body: the request, then why the account stays open. */
export const bodyOf = (n: CloseHold): string => `${WORDS.asked(n.requestedAt)} ${WORDS.used(n.at)}`;

/** What the polite live region says once, as the card shows: its title and body. */
export const saidOf = (n: CloseHold): string => `${WORDS.title}. ${bodyOf(n)}`;

/** The dismiss route (POST, Bearer, no body; contract auth.md section 2.7): `200 {kind, dismissed: true}`, gone for every app. */
export const DISMISS_PATH = `/v1/me/notices/${CLOSE_HOLD_KIND}/dismiss`;

/** `GET /v1/me` without the notice, as the dismiss leaves it. */
export function withoutCloseHold<T extends Pick<Me, 'notices'>>(me: T): T {
  return Array.isArray(me.notices) ? { ...me, notices: me.notices.filter((n) => n?.kind !== CLOSE_HOLD_KIND) } : me;
}
