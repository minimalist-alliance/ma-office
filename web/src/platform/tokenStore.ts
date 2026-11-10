// The refresh token, on this origin only. Access and ID tokens stay in memory (auth.ts).
//
// "Stay signed in" (the owner, 2026-11-07): it lives in exactly one place, under `ma-desk-web-refresh`, the key every
// app keeps as `ma-<app>-refresh`. In sessionStorage when the member chose "Until you close the browser" (`browser`),
// and in localStorage for 30, 7 or 1 day, and whenever the choice isn't known, as Platform's refresh fails open to 30
// days. So a reload and a browser restart keep the member signed in, until Platform refuses a refresh or they sign
// out. Nothing here ages a token: a refused refresh is the only way a session ends by itself.
//
// sessionStorage is one tab's. Tabs holding a copy keep in step over a BroadcastChannel (`follow`), so a rotation in
// one tab, or a move between the two stores, never strands another. A tab opened later starts with none.
//
// Before this, the token was in IndexedDB (`ma-desk`, store `kv`, key `refresh`). A token found only there moves to
// localStorage on first read, so nobody is signed out by the update, and the old sign-in pages' handoff still lands.

/** Platform's `preferences.staySignedIn` (`GET /v1/me`). */
export type StaySignedIn = '30d' | '7d' | '1d' | 'browser';
const CHOICES: readonly string[] = ['30d', '7d', '1d', 'browser'];

/** The member's choice, or null when it isn't one of the four (a Platform without it, or an unknown value). */
export function staySignedInOf(value: unknown): StaySignedIn | null {
  return typeof value === 'string' && CHOICES.includes(value) ? (value as StaySignedIn) : null;
}

export const REFRESH_KEY = 'ma-desk-web-refresh';
const LEGACY_DB = 'ma-desk';

type Where = 'local' | 'session';
const storageOf = (where: Where): Storage => (where === 'local' ? localStorage : sessionStorage);

function get(where: Where): string | null {
  try {
    return storageOf(where).getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

/** False if the browser refused it (storage blocked or full). */
function put(where: Where, token: string | null): boolean {
  try {
    if (token === null) storageOf(where).removeItem(REFRESH_KEY);
    else storageOf(where).setItem(REFRESH_KEY, token);
    return true;
  } catch {
    return false;
  }
}

/**
 * What another tab says it did: the token `from` is now `to`, kept in `where`. `to` null is gone (a sign-out, a refusal).
 * `from === to` is a move between the stores.
 */
export interface Moved {
  from: string;
  to: string | null;
  where: Where | null;
}

/**
 * What this tab's sessionStorage copy becomes on hearing `msg`: a token, null to drop it, or undefined to leave it. Only
 * a copy of `from` follows, except that a move into sessionStorage is taken up by a tab with none, which was reading
 * the same token from localStorage.
 */
export function follow(mine: string | null, msg: Moved): string | null | undefined {
  if (mine === msg.from) return msg.where === 'session' && msg.to ? msg.to : null;
  if (mine === null && msg.where === 'session' && msg.to !== null && msg.to === msg.from) return msg.to;
  return undefined;
}

let channel: BroadcastChannel | null | undefined;

/** This tab listens from its first read, which is at boot (`hasStoredSession`). */
function listen(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(REFRESH_KEY) : null;
  if (channel) {
    channel.onmessage = (e: MessageEvent<Moved>) => {
      const next = follow(get('session'), e.data);
      if (next !== undefined) put('session', next);
    };
  }
  return channel;
}

function tell(msg: Moved): void {
  try {
    listen()?.postMessage(msg);
  } catch {
    /* another tab finds out from its next refresh */
  }
}

// ----- the old IndexedDB store, read once and removed

/** The token in the old store, without creating that database if it isn't there. */
function legacyToken(): Promise<string | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(LEGACY_DB);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => req.transaction?.abort(); // it wasn't there: leave it that way
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const get = db.transaction('kv').objectStore('kv').get('refresh');
        get.onsuccess = () => {
          db.close();
          resolve(typeof get.result === 'string' ? get.result : null);
        };
        get.onerror = () => {
          db.close();
          resolve(null);
        };
      } catch {
        db.close();
        resolve(null);
      }
    };
  });
}

function dropLegacy(): void {
  try {
    indexedDB.deleteDatabase(LEGACY_DB);
  } catch {
    /* nothing to drop */
  }
}

// ----- the store

/** This tab's token: its own sessionStorage copy first, then the browser's localStorage one. */
export async function readRefreshToken(): Promise<string | null> {
  listen();
  const here = get('session') ?? get('local');
  if (here !== null) return here;
  const old = await legacyToken();
  if (old === null) return null;
  // Read again: another tab may have moved it while this looked.
  const now = get('session') ?? get('local');
  if (now !== null) return now;
  if (put('local', old)) dropLegacy();
  return old;
}

/** A new token for this tab: where its last one was, and in localStorage when it had none. Throws if the browser refuses. */
export async function writeRefreshToken(token: string): Promise<void> {
  const old = get('session');
  if (old !== null) {
    if (!put('session', token)) throw new Error('sessionStorage refused the token');
    if (old !== token) tell({ from: old, to: token, where: 'session' });
    return;
  }
  if (!put('local', token)) throw new Error('localStorage refused the token');
}

function clearHere(token: string | null): void {
  put('session', null);
  put('local', null);
  dropExtras();
  if (token !== null) tell({ from: token, to: null, where: null });
}

/**
 * Clears the token only if it's still the one refused, so this can't wipe what another tab has just rotated to. False
 * means what's stored has changed, or gone.
 */
export async function clearRefreshTokenIf(refused: string): Promise<boolean> {
  if ((get('session') ?? get('local')) !== refused) return false;
  clearHere(refused);
  dropLegacy();
  return true;
}

/** Sign-out: from both stores, the old one, and every tab's copy. */
export async function clearRefreshToken(): Promise<void> {
  clearHere(get('session') ?? get('local'));
  dropLegacy();
}

async function underLock(fn: () => void): Promise<void> {
  if (navigator.locks) await navigator.locks.request('ma-refresh', async () => fn());
  else fn();
}

/**
 * Puts the token where the member's choice says, at once, as each `GET /v1/me` answers: sessionStorage for `browser`,
 * localStorage for anything else, an unknown choice included. Under the refresh lock, so it can't land in the middle of
 * a rotation. Never signs anyone out: if the browser won't take it in the new place, it stays where it was.
 */
export async function placeRefreshToken(choice: StaySignedIn | null): Promise<void> {
  await underLock(() => {
    const inSession = get('session');
    const inLocal = get('local');
    if (choice === 'browser') {
      if (inLocal === null) return;
      if (inSession === null && !put('session', inLocal)) return;
      put('local', null);
      moveExtras('local', 'session');
      tell({ from: inLocal, to: inLocal, where: 'session' });
      return;
    }
    if (inSession === null || !put('local', inSession)) return;
    put('session', null);
    moveExtras('session', 'local');
    tell({ from: inSession, to: inSession, where: 'local' });
  });
}

/** Each answer from `GET /v1/me` puts the token where the member's "Stay signed in" says. A Platform without it says nothing. */
export function placeTokenFor(me: { preferences?: { staySignedIn?: unknown; staySignedInSince?: unknown } | null } | null | undefined): void {
  const prefs = me?.preferences;
  if (prefs && typeof prefs === 'object') {
    rememberChoice(prefs);
    void placeRefreshToken(staySignedInOf(prefs.staySignedIn));
  }
}

// ----- the member's own session length (contract auth.md section 3.3, item 2)
//
// Two small values kept beside the refresh token, in the store it is in, so they move and go with it: `signedInAt` (the
// ID token's `auth_time` from this sign-in, in epoch seconds; a refresh never changes it) and the latest choice with when
// it was saved. This is the member's chosen session length, not a sign-in-age check: it never applies to 30 days and
// never refuses an action. Nothing else in this app reads the time of a sign-in.
export const SIGNED_IN_AT_KEY = 'ma-desk-web-signed-in-at';
export const CHOICE_KEY = 'ma-desk-web-session-choice';
const EXTRAS = [SIGNED_IN_AT_KEY, CHOICE_KEY];

/** How long each shorter choice lasts, from the later of the sign-in and the save. `browser` is 12 hours: a server can't see a close. */
export const HOLD_MS: Record<string, number> = { '7d': 7 * 86_400_000, '1d': 86_400_000, browser: 12 * 3_600_000 };

function getIn(where: Where, key: string): string | null {
  try {
    return storageOf(where).getItem(key);
  } catch {
    return null;
  }
}

function putIn(where: Where, key: string, value: string | null): void {
  try {
    if (value === null) storageOf(where).removeItem(key);
    else storageOf(where).setItem(key, value);
  } catch {
    /* the next refresh or GET /v1/me writes it again */
  }
}

/** Where the token is: this tab's sessionStorage copy first, else the browser's localStorage. */
const tokenWhere = (): Where => (get('session') !== null ? 'session' : 'local');

function setExtra(key: string, value: string): void {
  const where = tokenWhere();
  putIn(where, key, value);
  putIn(where === 'local' ? 'session' : 'local', key, null);
}

function moveExtras(from: Where, to: Where): void {
  for (const key of EXTRAS) {
    const value = getIn(from, key);
    if (value !== null) putIn(to, key, value);
    putIn(from, key, null);
  }
}

function dropExtras(): void {
  for (const key of EXTRAS) {
    putIn('session', key, null);
    putIn('local', key, null);
  }
}

/** When this sign-in happened, as the ID token's `auth_time` (epoch seconds), or null if not kept yet. */
export function readSignedInAt(): number | null {
  const n = Number(getIn(tokenWhere(), SIGNED_IN_AT_KEY));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function writeSignedInAt(authTimeSeconds: unknown): void {
  if (typeof authTimeSeconds === 'number' && Number.isFinite(authTimeSeconds) && authTimeSeconds > 0) setExtra(SIGNED_IN_AT_KEY, String(authTimeSeconds));
}

export function readChoice(): { staySignedIn: StaySignedIn | null; staySignedInSince: string | null } {
  try {
    const kept = JSON.parse(getIn(tokenWhere(), CHOICE_KEY) ?? 'null') as { staySignedIn?: unknown; staySignedInSince?: unknown } | null;
    return { staySignedIn: staySignedInOf(kept?.staySignedIn), staySignedInSince: typeof kept?.staySignedInSince === 'string' ? kept.staySignedInSince : null };
  } catch {
    return { staySignedIn: null, staySignedInSince: null };
  }
}

/** The latest `preferences` from `GET /v1/me`, so a page load can decide before its first call. */
export function rememberChoice(prefs: { staySignedIn?: unknown; staySignedInSince?: unknown }): void {
  if (get('session') === null && get('local') === null) return;
  setExtra(CHOICE_KEY, JSON.stringify({ staySignedIn: staySignedInOf(prefs.staySignedIn), staySignedInSince: typeof prefs.staySignedInSince === 'string' ? prefs.staySignedInSince : null }));
}

/**
 * The choice this browser's session has outlived, or null. `7d`, `1d` and `browser` count from the later of `signedInAt`
 * and `staySignedInSince`, so saving a shorter choice never ends a session on the spot. Never `30d`, an unknown choice,
 * or a token with no `signedInAt` yet (the next refresh brings it).
 */
export function outlivedChoice(now: number = Date.now()): StaySignedIn | null {
  const { staySignedIn, staySignedInSince } = readChoice();
  const length = staySignedIn ? HOLD_MS[staySignedIn] : undefined;
  const at = readSignedInAt();
  if (!staySignedIn || length === undefined || at === null) return null;
  const since = staySignedInSince ? Date.parse(staySignedInSince) : NaN;
  const start = Math.max(at * 1000, Number.isFinite(since) ? since : 0);
  return now - start > length ? staySignedIn : null;
}
