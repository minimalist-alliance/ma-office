// Cognito Authorization Code + PKCE (contract auth.md section 2).
// Access and ID tokens live in memory. The refresh token is in localStorage, or sessionStorage for a member who
// chose "Until you close the browser" (tokenStore.ts). Refresh runs under the Web Lock `ma-refresh`, because
// rotation makes two concurrent refreshes log the user out.
//
// Only `invalid_grant`, or `ma_session_ended` for a refresh past the member's "Stay signed in" (section 3.3), ends a
// session (section 2.1). Anything else keeps the token and throws
// RefreshUnavailable, which every caller treats like a network failure: a calm state and a retry.
//
// When client-config has auth.signInPath, signing in happens on our own pages. They leave the refresh
// token in tokenStore's place, so the next page load just refreshes. Google still comes back to
// /auth/callback here.
import { getClientConfig, type ClientConfig } from './clientConfig';
import { codeChallenge, decodeJwtPayload, randomString } from './pkce';
import { onSignInPage, signInAddress, type Here } from './signInAddress';
import { clearRefreshToken, clearRefreshTokenIf, HOLD_MS, outlivedChoice, readChoice, readRefreshToken, readSignedInAt, writeRefreshToken, writeSignedInAt } from './tokenStore';
import { endSignedIn, keepSignedIn } from './signedInCookie';

const PENDING_KEY = 'ma.auth.pending';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** A hung request would hold the lock, and so every tab's refresh. */
const REFRESH_TIMEOUT_MS = 15_000;
// The first few retries land inside the token's 30 s grace, in case a lost reply did rotate it.
const RETRY_FIRST_MS = 2_000;
const RETRY_MAX_MS = 30_000;
/** Each pass sends a token the last one didn't, so this is only a guard. */
const MAX_TOKENS_PER_REFRESH = 3;
/**
 * How long sign-out waits for each of its calls (`POST /v1/me/sign-out`, then `/oauth2/revoke`) before going on, as
 * Platform's own sign-out does. Long enough for a slow link, short enough that signing out never hangs. Both are
 * `keepalive`, so leaving sooner doesn't cancel them.
 */
export const SIGN_OUT_WAIT_MS = 3_000;
/**
 * How long "Sign out everywhere" waits for `POST /v1/me/sign-out` to say yes, as Platform's `/account` does. It has to
 * hear it: going on without would tell the member every device is signed out when that may not be so.
 */
export const EVERYWHERE_WAIT_MS = 15_000;

interface Pending {
  state: string;
  nonce: string;
  verifier: string;
}

interface TokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  expires_in: number;
}

let access: { token: string; expiresAt: number; claims: Record<string, unknown> | null } | null = null;
/** This tab sent the stored token, was told the session is over (`isSessionOver`), and cleared it. Nothing else ends a session this way. */
let refusedHere = false;
/** Whose tokens this tab last had: their `sub`. Another tab's sign-in can store someone else's refresh token. */
let member: string | null = null;
const memberListeners = new Set<(sub: string, before: string | null) => void>();

/**
 * Told each time this tab's tokens belong to someone new: the first time it has any, and whenever a refresh or a
 * sign-in brings another member's, as when someone signs in in another tab.
 */
export function onMemberChange(fn: (sub: string, before: string | null) => void): () => void {
  memberListeners.add(fn);
  return () => memberListeners.delete(fn);
}

/** Who's signed in in this tab, with a token to show for it, or null if that isn't known yet. */
export async function currentMember(): Promise<string | null> {
  try {
    await getAccessToken();
  } catch {
    return null;
  }
  return member;
}

export class SignInRequired extends Error {
  constructor(message = 'Sign-in required') {
    super(message);
    this.name = 'SignInRequired';
  }
}

/** The refresh didn't work this time and the token is still stored. The member is still signed in. */
export class RefreshUnavailable extends Error {
  constructor(message = 'Token refresh failed for now') {
    super(message);
    this.name = 'RefreshUnavailable';
  }
}

/**
 * Where our own sign-in pages are, if signing in should go there. If signInPath goes on before the route
 * exists, the SPA fallback answers it with this app, and going there from there would never end: each
 * round would carry the last in its return path. So being there already means managed login takes over.
 * An address on another site is never this page (signInAddress.ts).
 */
export function ownSignInPath(cfg: ClientConfig, here: Here = window.location): string | null {
  const setting = cfg.auth.signInPath;
  return setting && signInAddress(setting, {}, here) && !onSignInPage(setting, here) ? setting : null;
}

/**
 * Whether signing in means managed login: no setting, or one that can't be used. That's not ownSignInPath being
 * null, which also means the setting is on and its route isn't there yet: that stays on the card, with its button.
 */
export function usesManagedLogin(cfg: ClientConfig, here: Here = window.location): boolean {
  return !signInAddress(cfg.auth.signInPath, {}, here);
}

/** `by: 'replace'` is for going by itself, so Back can't land on a page that sends the member straight back. */
export async function startSignIn(cfg: ClientConfig, provider?: 'Google', by: 'assign' | 'replace' = 'assign'): Promise<void> {
  const go = (url: string): void => (by === 'replace' ? window.location.replace(url) : window.location.assign(url));
  const own = provider ? null : ownSignInPath(cfg);
  const address = own && signInAddress(own, { return: window.location.pathname + window.location.search });
  if (address) {
    go(address);
    return;
  }
  const pending: Pending = { state: randomString(), nonce: randomString(), verifier: randomString(48) };
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.auth.clientId,
    redirect_uri: cfg.auth.redirectUri,
    scope: cfg.auth.scopes.join(' '),
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: await codeChallenge(pending.verifier),
    code_challenge_method: 'S256',
  });
  if (provider) q.set('identity_provider', provider);
  go(`${cfg.auth.domain}/oauth2/authorize?${q.toString()}`);
}

/** `signedIn`: this came from finishing a sign-in. A refresh keeps `signedInAt`, and only fills it in when it was never kept. */
async function noteSignedIn(res: TokenResponse, signedIn: boolean): Promise<void> {
  if (!res.refresh_token) return;
  await writeRefreshToken(res.refresh_token);
  if (signedIn || readSignedInAt() === null) writeSignedInAt((res.id_token ? decodeJwtPayload(res.id_token) : null)?.['auth_time']);
}

function keep(res: TokenResponse): void {
  refusedHere = false;
  const claims = res.id_token ? decodeJwtPayload(res.id_token) : null;
  access = {
    token: res.access_token,
    expiresAt: Date.now() + res.expires_in * 1000,
    claims: claims ?? access?.claims ?? null,
  };
  // The access token's own `sub` first: a refresh needn't bring an ID token, and the old one's claims are someone's.
  const sub = decodeJwtPayload(res.access_token)?.['sub'] ?? claims?.['sub'];
  if (typeof sub !== 'string' || !sub || sub === member) return;
  const before = member;
  member = sub;
  for (const fn of memberListeners) fn(sub, before);
}

async function postToken(cfg: ClientConfig, body: URLSearchParams, signal?: AbortSignal): Promise<Response> {
  return fetch(`${cfg.auth.domain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal,
  });
}

async function underRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  return navigator.locks ? (navigator.locks.request('ma-refresh', fn) as Promise<T>) : fn();
}

/** Handles /auth/callback. Throws with a calm message for the sign-in screen. */
export async function finishSignIn(search: string): Promise<void> {
  const params = new URLSearchParams(search);
  const raw = sessionStorage.getItem(PENDING_KEY);
  sessionStorage.removeItem(PENDING_KEY);
  const pending = raw ? (JSON.parse(raw) as Pending) : null;
  if (params.get('error')) throw new SignInRequired('Sign-in was cancelled. You can try again.');
  const code = params.get('code');
  if (!pending || !code || params.get('state') !== pending.state) {
    throw new SignInRequired("That sign-in couldn't be verified. Please try again.");
  }
  const cfg = await getClientConfig();
  const res = await postToken(cfg, new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.auth.clientId,
    code,
    redirect_uri: cfg.auth.redirectUri,
    code_verifier: pending.verifier,
  }));
  if (!res.ok) throw new SignInRequired("That sign-in didn't complete. Please try again.");
  const tokens = (await res.json()) as TokenResponse;
  const claims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : null;
  if (claims?.['nonce'] !== pending.nonce) throw new SignInRequired("That sign-in couldn't be verified. Please try again.");
  // Under the lock, so another tab's refresh on its way can't land after this and bring the old session back.
  const replaced = await underRefreshLock(async () => {
    const old = await readRefreshToken();
    keep(tokens);
    await noteSignedIn(tokens, true);
    // What this sign-in replaced, once the new token is what's stored (a write the browser refuses throws, above). If
    // Cognito handed back the same token, or brought none, there's nothing old.
    return old !== null && old !== tokens.refresh_token && (await readRefreshToken()) === tokens.refresh_token ? old : null;
  });
  // The session this replaced is over here, so end it at Cognito too (ISS-68, as `ma-platform`'s Platform app does), as
  // sign-out does. Not waited for, and it never throws: a revoke that fails or hangs changes nothing about this sign-in.
  if (replaced) void revokeRefreshToken(cfg, replaced);
  // The landing's signed-in cookie, for the member's "Stay signed in" (signedInCookie.ts).
  keepSignedIn(readChoice().staySignedIn, cfg);
}

/**
 * The session is over: exactly `invalid_grant` in the JSON body, or the trigger refusing a refresh past the member's own
 * "Stay signed in" choice, which is a failed trigger (a 400 with free text in `error`) naming `ma_session_ended`
 * (contract auth.md §3.3; the word, not Cognito's sentence around it). Any other failed trigger is "try again".
 */
function isSessionOver(body: string): boolean {
  try {
    const error = (JSON.parse(body) as { error?: unknown } | null)?.error;
    return error === 'invalid_grant' || (typeof error === 'string' && error.includes('ma_session_ended'));
  } catch {
    return false;
  }
}

function parseTokens(body: string): TokenResponse | null {
  try {
    const tokens = JSON.parse(body) as Partial<TokenResponse> | null;
    return typeof tokens?.access_token === 'string' && typeof tokens.expires_in === 'number' ? (tokens as TokenResponse) : null;
  } catch {
    return null;
  }
}

async function postRefresh(cfg: ClientConfig, refreshToken: string): Promise<{ ok: boolean; status: number; body: string }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REFRESH_TIMEOUT_MS);
  try {
    const res = await postToken(cfg, new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cfg.auth.clientId,
      refresh_token: refreshToken,
    }), abort.signal);
    return { ok: res.ok, status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

let endedBy: string | null = null;

/** The choice that ended this browser's session, once, for the sign-in screen's line (§3.3 item 4). */
export function takeEndedChoice(): 'ended-7d' | 'ended-1d' | 'ended-browser' | null {
  const choice = endedBy;
  endedBy = null;
  return choice && Object.hasOwn(HOLD_MS, choice) ? (`ended-${choice}` as 'ended-7d') : null;
}

/** Revoke the token (§3.3 item 1; never throws), forget it, and say why. Not if another tab already rotated it away. */
async function endHere(cfg: ClientConfig, refreshToken: string, choice: string | null): Promise<void> {
  if ((await readRefreshToken()) !== refreshToken) return;
  await revokeRefreshToken(cfg, refreshToken);
  if (await clearRefreshTokenIf(refreshToken)) {
    endSignedIn(cfg);
    access = null;
    refusedHere = true;
    endedBy = choice;
    throw new SignInRequired();
  }
}

async function refreshLocked(cfg: ClientConfig): Promise<void> {
  for (let tried = 0; tried < MAX_TOKENS_PER_REFRESH; tried += 1) {
    // Read inside the lock: another tab may have just rotated it.
    const refreshToken = await readRefreshToken();
    if (!refreshToken) throw new SignInRequired();
    // The member's own session length (§3.3 item 2): past it, this browser's session is over, as if the server had said so.
    const outlived = outlivedChoice();
    if (outlived) {
      await endHere(cfg, refreshToken, outlived);
      continue; // rotated away by another tab meanwhile: its newer token gets its own check
    }
    const reply = await postRefresh(cfg, refreshToken);
    if (reply.ok) {
      const tokens = parseTokens(reply.body);
      if (!tokens) throw new RefreshUnavailable('the token reply had no tokens');
      // Stored while this was out, by a sign-in or a sign-out that didn't wait for the lock: that's newer than this
      // answer, so it mustn't be overwritten. Read again, and use what's there.
      if ((await readRefreshToken()) !== refreshToken) continue;
      keep(tokens);
      // This tab has its access token whether or not the write works.
      await noteSignedIn(tokens, false).catch(() => undefined);
      keepSignedIn(readChoice().staySignedIn, cfg); // a refresh renews the landing's signed-in cookie too
      return;
    }
    if (!isSessionOver(reply.body)) throw new RefreshUnavailable(`token refresh -> ${reply.status}`);
    // `ma_session_ended` leaves the token alive at Cognito, and a sign-in on this app anywhere would revive it: revoke it
    // (§3.3 item 1). Either way it goes from here.
    const ended = reply.body.includes('ma_session_ended');
    if (ended) {
      await endHere(cfg, refreshToken, readChoice().staySignedIn);
      continue;
    }
    if (await clearRefreshTokenIf(refreshToken)) {
      endSignedIn(cfg);
      access = null;
      refusedHere = true;
      throw new SignInRequired();
    }
    // What was refused has been rotated away by another tab, or by a sign-in. The newer one may be fine.
  }
  throw new RefreshUnavailable('the stored token keeps changing');
}

let inFlight: Promise<void> | null = null;
let failures = 0;
let retryAt = 0;

async function runRefresh(): Promise<void> {
  const cfg = await getClientConfig();
  await underRefreshLock(() => refreshLocked(cfg));
}

function retryDelayMs(failed: number): number {
  return Math.min(RETRY_FIRST_MS * 2 ** failed, RETRY_MAX_MS) * (0.8 + 0.4 * Math.random());
}

/** At most one request per tab, and after a failure none until the backoff is up, however many callers ask. */
function refresh(): Promise<void> {
  if (inFlight) return inFlight;
  if (Date.now() < retryAt) return Promise.reject(new RefreshUnavailable('waiting to try again'));
  inFlight = runRefresh().then(
    () => {
      failures = 0;
      retryAt = 0;
    },
    (err: unknown) => {
      if (err instanceof SignInRequired) {
        failures = 0;
        retryAt = 0;
        throw err;
      }
      retryAt = Date.now() + retryDelayMs(failures);
      failures += 1;
      throw err instanceof RefreshUnavailable ? err : new RefreshUnavailable(err instanceof Error ? err.message : undefined);
    },
  ).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** The network or the member came back: the next caller may try without waiting out the backoff. */
export function retryRefreshNow(): void {
  retryAt = 0;
}

/**
 * A valid access token, refreshed when under 5 minutes are left. Throws SignInRequired when the session
 * is over, and RefreshUnavailable when the token is kept but there's no access token to give for now.
 */
export async function getAccessToken(forceRefresh = false): Promise<string> {
  if (forceRefresh || !access || access.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
    try {
      await refresh();
    } catch (err) {
      // A refresh that can't happen yet costs nothing while the token we hold still works.
      if (err instanceof RefreshUnavailable && !forceRefresh && access && Date.now() < access.expiresAt) return access.token;
      throw err;
    }
  }
  if (!access) throw new SignInRequired();
  return access.token;
}

/**
 * Whether a SignInRequired means this session is really dead: this tab's own refresh had its token refused.
 * False for one with no token to send, as after a sign-out in another tab, and for a second 401 from the API. A
 * link can be the first to hear it, so the flag outlasts that call, until a refresh works.
 */
export function sessionWasRefused(): boolean {
  return refusedHere;
}

export async function hasStoredSession(): Promise<boolean> {
  return (await readRefreshToken()) !== null || access !== null;
}

/** `call` until it settles, or `SIGN_OUT_WAIT_MS`, whichever is first. It never throws: sign-out goes on either way. */
export async function forAtMost(call: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((done) => {
    timer = setTimeout(done, SIGN_OUT_WAIT_MS);
  });
  await Promise.race([call.then(() => {}, () => {}), waited]);
  clearTimeout(timer);
}

/** `call` until it settles, or `ms`, whichever is first. True only if it settled without throwing. Never throws. */
export async function answeredWithin(call: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<boolean>((done) => {
    timer = setTimeout(() => done(false), ms);
  });
  try {
    return await Promise.race([call.then(() => true, () => false), waited]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Revoke the refresh token at Cognito, and wait for its answer to arrive in full. `fetch` resolves on the headers, so
 * leaving then cut off the rest, and the revoke ended as cancelled (Platform's sign-out had the same, fixed in its
 * `revokeRefreshToken`). `keepalive` lets it finish if the wait runs out.
 */
async function revokeRefreshToken(cfg: ClientConfig, token: string): Promise<void> {
  const answered = fetch(`${cfg.auth.domain}/oauth2/revoke`, {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, client_id: cfg.auth.clientId }),
  }).then((res) => res.text());
  await forAtMost(answered); // the token is gone from this browser either way
}

/** Steps 3 and 4 of contract auth.md section 6, after the caller has done step 1 and closed links. */
export async function endSession(cfg: ClientConfig | null): Promise<void> {
  const refreshToken = await readRefreshToken();
  await clearRefreshToken();
  endSignedIn(cfg); // before the logout, everywhere or here
  access = null;
  if (!cfg) {
    window.location.assign('/signed-out');
    return;
  }
  if (refreshToken) await revokeRefreshToken(cfg, refreshToken);
  const q = new URLSearchParams({ client_id: cfg.auth.clientId, logout_uri: cfg.auth.logoutUri });
  window.location.assign(`${cfg.auth.domain}/logout?${q.toString()}`);
}
