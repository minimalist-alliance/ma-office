// A closed account (ma-platform contract moderation.md section 8): an account the platform closed, whose one way in is the
// office, to download its data inside its window. `GET /v1/me` says so with `membership.closed: true`; any other API may
// say so first, with `403 account_closed`, so that answer is heard here from wherever it comes (`api.ts`, Maia's
// `net.ts`) and the office shows the closed card at once (`shell/deskNotice.ts`), then asks `/v1/me` again for its date.
// Nothing here says why an account was closed: nothing sent says why either.
import { create } from 'zustand';
import type { Me } from './api';

/** The error code (contract moderation.md section 13): "This account is closed." */
export const ACCOUNT_CLOSED = 'account_closed';

/** `heard`: an API answered `403 account_closed` to this member's token since they signed in. */
export const useAccountClosed = create<{ heard: boolean }>(() => ({ heard: false }));

let onHeard: (() => void) | null = null;

/** The session asks `/v1/me` again when one is heard, for `membership.closed` and the window's end. */
export function whenClosedHeard(fn: () => void): void {
  onHeard = fn;
}

/** An API's error code: `account_closed` closes the office, once. Any other code is nothing to do with it. */
export function heardAccountClosed(code: string | null | undefined): void {
  if (code !== ACCOUNT_CLOSED || useAccountClosed.getState().heard) return;
  useAccountClosed.setState({ heard: true });
  onHeard?.();
}

/** Signed out, or another member's tokens now: what was heard was the last member's. */
export function forgetAccountClosed(): void {
  if (useAccountClosed.getState().heard) useAccountClosed.setState({ heard: false });
}

/** Whether this account is closed: `/v1/me` says so, or an API did. */
export function isAccountClosed(me: Me | null | undefined, heard: boolean): boolean {
  return heard || me?.membership?.closed === true;
}

/**
 * The end of the closed account's download window, from `/v1/me`'s `membership.exportUntil` and `membership.held`
 * (contract section 8, 0.3.117 draft amended Nov 12). A date: that end. `null`: no download, as `held: true` or
 * `exportUntil: null` says (held, which the member must not learn). `undefined`: neither said (a Platform from before
 * them), or not a date; the member is signed in, which a closed account can only be inside its window, so the download
 * is offered with no date rather than a guessed one.
 */
export function exportUntilOf(membership: Me['membership'] | null | undefined): string | null | undefined {
  if (membership?.held === true) return null;
  const raw = membership?.exportUntil;
  if (raw === null) return null;
  return typeof raw === 'string' && !Number.isNaN(Date.parse(raw)) ? raw : undefined;
}
