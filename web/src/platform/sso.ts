// One sign-in for every app (ma-platform contract auth.md §2.8, 0.3.118 draft; draft ADR `draft-signin-across-apps.md`): the
// office's calls to the shared sign-in at `id.<suffix>`. A chunk of its own, loaded only where client-config's `auth.sso` is an
// object with an https origin on this site (`ssoOrigin` in `hosts.ts`), and every call goes to that origin; with it absent the
// office makes no request there at all.
//
// The office never asks `id.` for a code: signed out, it goes to `/_signin/` as before, and those pages do step 2. Here:
// - step 1, `POST /v1/sso/session` with this app's own `desk-web` access token: after `/auth/callback` (Google's return) with
//   the sign-in's first token, seconds after the sign-in (its mark counts only within 2 minutes of it), and once a page load
//   after the first good call, which only joins (`keepShared` in `api.ts`);
// - step 3, `POST /v1/sso/end`, first in Sign out (`signOut` in `session.ts`), which ends every MA app's session in this
//   browser; a failure there is tried once more from the signed-out page (`/signed-out`), which then says so.
// Each is a credentialed `fetch` to that origin alone, body `{}`: the cookie is `id.`'s, HttpOnly, never read here. Nothing
// goes in a URL, and nothing here is logged. It imports nothing, so the first load's chunks stay as they are.

/** How long step 1 may take before the office goes on without it (the sign-in pages give step 2 the same). */
export const SSO_WAIT_MS = 4_000;
/** How long Sign out waits for step 3, as for each of its other calls (`SIGN_OUT_WAIT_MS` in `auth.ts`). */
export const END_WAIT_MS = 3_000;
/** This tab's own sign-out, epoch ms: our sign-in pages on this host don't ask `id.` for a code within 60 s of it (§2.8). */
export const SIGNED_OUT_KEY = 'ma-sso-out';
/**
 * What Sign out leaves for the signed-out page, in this tab's sessionStorage as `ma-sso-out` is: `end` (step 3 got no
 * answer, so the page tries once more) or `end-refused` (step 3 was answered with anything but its 204, a 503 above all: the
 * page says so at once). `session.ts` looks for it by this name before loading this chunk: no note, nothing to wait for.
 */
export const SIGN_OUT_NOTE_KEY = 'ma-sso-sign-out-note';

// The signed-out page's lines (NEW, for Sales; the shared-computer sentence is Sales' "one line", Nov 12).
/** Step 3 failed twice: this app is signed out, others in this browser may not be. */
export const OTHER_APPS_LINE = "You're signed out here, but other Minimalist Alliance apps in this browser may still be signed in. On a shared computer, sign out of each of them too.";

function post(origin: string, route: 'session' | 'end', init: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
  return fetch(`${origin}/v1/sso/${route}`, {
    ...init,
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...init.headers },
    body: '{}',
  });
}

/** Step 1: this browser keeps its shared sign-in, started by a sign-in's own token or joined by any other. Whatever it answers changes nothing. */
export async function keepSharedSignIn(origin: string, accessToken: string): Promise<void> {
  try {
    await post(origin, 'session', { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(SSO_WAIT_MS) });
  } catch {
    /* a refusal, a network failure or the wait running out: the office is as it was */
  }
}

/**
 * How step 3 went: `ended`, its 204; `refused`, any other answer, a `503 unavailable` above all, after which `id.` has
 * cleared its cookie, so a second try would answer 204 with nothing ended; `unanswered`, a network failure or no answer in
 * `END_WAIT_MS`, which is worth one more try.
 */
export type EndOutcome = 'ended' | 'refused' | 'unanswered';

/** Step 3, waited for up to `END_WAIT_MS`; `keepalive`, so leaving after that doesn't cancel it. */
async function end(origin: string): Promise<EndOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<EndOutcome>((done) => {
    timer = setTimeout(() => done('unanswered'), END_WAIT_MS);
  });
  try {
    const answer = post(origin, 'end', { keepalive: true }).then((res): EndOutcome => (res.status === 204 ? 'ended' : 'refused'), (): EndOutcome => 'unanswered');
    return await Promise.race([answer, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The note for a step 3 that didn't end it: `end` to try once more on the signed-out page, `end-refused` not to. */
const endNote = (outcome: EndOutcome): string => (outcome === 'refused' ? 'end-refused' : 'end');

/** Writes this tab's sessionStorage (null removes), and says what was there. Storage that refuses keeps nothing. */
function note(key: string, value: string | null): string | null {
  try {
    const was = sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
    return was;
  } catch {
    return null;
  }
}

/**
 * Step 3, first in Sign out (Security's ruling for every app): ends this browser's shared sign-in, and with it every MA
 * app's session here. Before it, the mark that keeps our sign-in pages from signing this tab back in. Anything but its 204
 * is noted for the signed-out page (`endNote`).
 */
export async function endSharedSignIn(origin: string): Promise<EndOutcome> {
  note(SIGNED_OUT_KEY, String(Date.now()));
  const outcome = await end(origin);
  if (outcome !== 'ended') note(SIGN_OUT_NOTE_KEY, endNote(outcome));
  return outcome;
}

/**
 * The signed-out page: the line for what Sign out noted, or null for none. A step 3 that was refused (a 503) gets its line
 * at once, with no second try: `id.` cleared its cookie with that answer, so a retry would say 204 with the other apps
 * still signed in. One that got no answer gets one more try at `origin` (null: client-config couldn't be read, so no try),
 * and its line unless that ends it. Once: the note goes.
 */
export async function signedOutLine(origin: string | null): Promise<string | null> {
  const noted = note(SIGN_OUT_NOTE_KEY, null);
  const appsOut = noted === 'end-refused' ? false : noted !== 'end' || (origin !== null && (await end(origin)) === 'ended');
  return appsOut ? null : OTHER_APPS_LINE;
}
