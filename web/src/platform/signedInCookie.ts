// The landing's signed-in cookie (S-148; ma-platform contract auth.md section 3.4). The landing is static and can't see a session,
// so every app that keeps one sets `ma_signed_in=1` on the parent domain when a sign-in completes or a refresh renews it, and
// clears it when its session ends; the landing then shows "Your office" in place of "Sign in". It holds no identity and proves
// nothing. ma-platform's `packages/signed-in-kit` is this file's equal for the other apps (and for our own sign-in pages on
// office., the hand-off landing's included), with the same strings and tests.
//
// Only where client-config carries `signedInCookie: {name, domain}`, which Platform sends in prod alone: staging's hosts are
// `*.staging.<apex>`, and a parent-domain cookie there would reach the live landing. Absent (staging, local), nothing is set or
// cleared. The hostname never decides.
//
// Set (auth.ts, tokenStore.ts): a sign-in finishing at /auth/callback, every refresh, and the member's "Stay signed in" read from
// GET /v1/me or changed. Cleared: Sign out and Sign out everywhere (`endSession`), and a refresh refused for good (`endHere`, and
// `invalid_grant`).
import { loadedConfig, type ClientConfig } from './clientConfig';

/** Max-Age per "Stay signed in" choice, as long as the refresh token's; `browser` is a session cookie; anything else 30 days. */
export const SIGNED_IN_MAX_AGE: Readonly<Record<'30d' | '7d' | '1d' | 'browser', number | null>> = Object.freeze({ '30d': 2_592_000, '7d': 604_800, '1d': 86_400, browser: null });

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const DOMAIN = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/** Client-config's `signedInCookie`, or null where it's absent or isn't a plain name and host name. */
export function signedInSetting(config: { signedInCookie?: unknown } | null | undefined): { name: string; domain: string } | null {
  const s = config?.signedInCookie;
  if (!s || typeof s !== 'object') return null;
  const { name, domain } = s as { name?: unknown; domain?: unknown };
  return typeof name === 'string' && NAME.test(name) && typeof domain === 'string' && DOMAIN.test(domain) ? { name, domain } : null;
}

/** The `document.cookie` string that sets it for `choice`, or null without the setting. Never HttpOnly: the landing reads it. */
export function signedInCookie(config: { signedInCookie?: unknown } | null | undefined, choice: unknown): string | null {
  const s = signedInSetting(config);
  if (!s) return null;
  const age = typeof choice === 'string' && Object.hasOwn(SIGNED_IN_MAX_AGE, choice) ? SIGNED_IN_MAX_AGE[choice as '30d'] : SIGNED_IN_MAX_AGE['30d'];
  return `${s.name}=1; Domain=${s.domain}; Path=/; ${age === null ? '' : `Max-Age=${age}; `}Secure; SameSite=Lax`;
}

/** The string that clears it: the same name, domain, path and flags, `Max-Age=0`. */
export function signedOutCookie(config: { signedInCookie?: unknown } | null | undefined): string | null {
  const s = signedInSetting(config);
  return s ? `${s.name}=; Domain=${s.domain}; Path=/; Max-Age=0; Secure; SameSite=Lax` : null;
}

function write(doc: { cookie: string } | undefined, cookie: string | null): boolean {
  if (!doc || cookie === null) return false;
  try {
    doc.cookie = cookie;
    return true;
  } catch {
    return false; // cookies blocked: the landing says "Sign in", which opens the office anyway
  }
}

export const setSignedIn = (config: { signedInCookie?: unknown } | null | undefined, choice: unknown, doc: { cookie: string } | undefined = globalThis.document): boolean =>
  write(doc, signedInCookie(config, choice));

export const clearSignedIn = (config: { signedInCookie?: unknown } | null | undefined, doc: { cookie: string } | undefined = globalThis.document): boolean =>
  write(doc, signedOutCookie(config));

// With the client-config this page has loaded, never a request for it: a session here never exists without it (every sign-in,
// refresh and sign-out goes through it first), and a cookie is never a reason to call the API.

/** A session is kept here, for `choice` (null when not known yet: 30 days, where the token is kept then too). Never throws. */
export function keepSignedIn(choice: string | null, cfg?: ClientConfig | null): void {
  try {
    const now = cfg ?? loadedConfig();
    if (now) setSignedIn(now, choice);
  } catch {
    /* a sign only: nothing here may stop a sign-in or a refresh */
  }
}

/** This app's session ended, before it leaves for the logout. Never throws. */
export function endSignedIn(cfg?: ClientConfig | null): void {
  try {
    const now = cfg ?? loadedConfig();
    if (now) clearSignedIn(now);
  } catch {
    /* a sign only: nothing here may stop a sign-out */
  }
}
