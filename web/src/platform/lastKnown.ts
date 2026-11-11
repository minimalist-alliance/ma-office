// What the office last drew for this member, so a returning visit draws it at once and refreshes it quietly
// (stale-while-revalidate; the owner, Nov 10: "some items like the avatar on office take a while to load"). The avatar
// waited for client-config, a token refresh and `GET /v1/me` in a row; the usage circle for `GET /v1/desks/bandwidth`.
//
// One record, `ma-desk-web-last-known`, kept beside the refresh token (`tokenStore.ts`): this tab's sessionStorage when
// the member's "Stay signed in" is `browser` (a borrowed computer forgets it with the browser), localStorage otherwise,
// and gone with the token, so a sign-out, a refused refresh (`invalid_grant`, `ma_session_ended`) and a `session_revoked`
// (`forgetMember` in `session.ts`) all take it. The desk list's mirror (`ma.desks.v1`, `deskStore.ts`) lives beside it
// and follows the same record.
//
// Per account: the record carries the account's `sub` and the sign-in it was written under (`signedInAt`, the ID token's
// `auth_time`, which only a new sign-in changes). It's drawn only while that sign-in is this browser's, and the first
// token says whose session it is: anyone else's and it's forgotten, with what was drawn from it.
//
// Only what the chrome draws, and nothing that isn't already the member's own on this computer: the name, the initials,
// the seal, the picture's address, the meter's numbers and client-config (which anyone can read). No tokens, no email, no
// membership status (the no-desk cards wait for Platform's own word), no age band (the age rules wait for `/v1/me`).
// Every storage access is in try/catch (`tokenStore.ts`'s helpers): storage that's blocked or full means no head start.
import { usableConfig, type ClientConfig } from './clientConfig';
import { hasStoredToken, LAST_KNOWN_KEY, readBeside, readSignedInAt, writeBeside } from './tokenStore';

export const LAST_KNOWN_VERSION = 1;

/** The member as the avatar and the account menu draw them. */
export interface LastMe {
  userId: string;
  displayName: string | null;
  initials: string;
  /** `membership.badge`: the seal, or null. */
  badge: string | null;
  /** The checked picture's address and the built avatar's recipe (the profile picture's `avatarUrl` and `avatar`), when Platform sends them. */
  avatarUrl?: string;
  avatar?: unknown;
}

export interface LastKnown {
  v: number;
  sub: string;
  signedInAt: number | null;
  me?: LastMe;
  config?: ClientConfig;
  /** The meter, as `parseMeter` left it. Read back through `parseMeter`. */
  usage?: unknown;
}

type Part = 'me' | 'config' | 'usage';

const MAX_RECORD = 64 * 1024;
const MAX_AVATAR = 4 * 1024;
const str = (v: unknown): v is string => typeof v === 'string';

/** Whose tokens this tab has, once the first one has said. Writes before that wait in `pending`. */
let member: string | null = null;
let pending: Partial<Record<Part, unknown>> = {};

function parse(raw: string | null): LastKnown | null {
  if (!raw || raw.length > MAX_RECORD) return null;
  try {
    const r = JSON.parse(raw) as Partial<LastKnown> | null;
    if (!r || r.v !== LAST_KNOWN_VERSION || !str(r.sub) || !r.sub) return null;
    const at = typeof r.signedInAt === 'number' && Number.isFinite(r.signedInAt) ? r.signedInAt : null;
    return { ...r, v: LAST_KNOWN_VERSION, sub: r.sub, signedInAt: at };
  } catch {
    return null;
  }
}

const stored = (): LastKnown | null => parse(readBeside(LAST_KNOWN_KEY));

/** The record, if it was written under this browser's current sign-in: what a returning visit may draw at once. */
export function readLastKnown(): LastKnown | null {
  const r = stored();
  if (!r || r.signedInAt !== readSignedInAt()) return null;
  return r;
}

/**
 * True when there's no record or it's from this browser's current sign-in. The desk list's mirror is drawn only then:
 * after a sign-in since (perhaps someone else's), what's kept may be another member's.
 */
export function lastKnownFitsSession(): boolean {
  const r = stored();
  return !r || r.signedInAt === readSignedInAt();
}

/** The account menu's member, from what `/v1/me` said. Null for anything that isn't one. */
export function lastMeOf(me: unknown, initials: string): LastMe | null {
  if (!me || typeof me !== 'object') return null;
  const m = me as Record<string, unknown>;
  if (!str(m['userId']) || !m['userId']) return null;
  const membership = (m['membership'] ?? null) as Record<string, unknown> | null;
  const badge = membership && str(membership['badge']) ? membership['badge'] : null;
  const out: LastMe = { userId: m['userId'], displayName: str(m['displayName']) ? m['displayName'] : null, initials, badge };
  const url = m['avatarUrl'];
  if (str(url) && /^https:\/\//.test(url) && url.length <= 2048) out.avatarUrl = url;
  const avatar = m['avatar'];
  if (avatar && typeof avatar === 'object') {
    try {
      if (JSON.stringify(avatar).length <= MAX_AVATAR) out.avatar = avatar;
    } catch {
      /* not JSON: not kept */
    }
  }
  return out;
}

/** A kept member checked again on the way out of storage: what was written may not be what's read. */
export function checkedLastMe(v: unknown): LastMe | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  if (!str(m['userId']) || !m['userId'] || !str(m['initials'])) return null;
  return lastMeOf({ userId: m['userId'], displayName: m['displayName'], membership: { badge: m['badge'] }, avatarUrl: m['avatarUrl'], avatar: m['avatar'] }, m['initials']);
}

/** Client-config, checked enough to draw from: it must still say where the API and sign-in are. */
export const checkedConfig = (v: unknown): ClientConfig | null => usableConfig(v);

function write(r: LastKnown): void {
  let raw: string;
  try {
    raw = JSON.stringify(r);
  } catch {
    return;
  }
  if (raw.length > MAX_RECORD) return;
  if (raw === readBeside(LAST_KNOWN_KEY)) return;
  writeBeside(LAST_KNOWN_KEY, raw);
}

function put(sub: string, parts: Partial<Record<Part, unknown>>): void {
  if (!hasStoredToken()) return; // nothing to keep it beside: a sign-out on its way, say
  const cur = stored();
  const base: LastKnown = cur && cur.sub === sub ? cur : { v: LAST_KNOWN_VERSION, sub, signedInAt: null };
  const next: LastKnown = { ...base, signedInAt: readSignedInAt() };
  for (const [k, value] of Object.entries(parts) as [Part, unknown][]) {
    if (value === null || value === undefined) delete next[k];
    else next[k] = value as never;
  }
  write(next);
}

/**
 * A fresh answer, for next time. Null removes that part (a meter Platform no longer has). Before the first token has
 * said whose session this is, it waits, and `lastKnownFor` writes it.
 */
export function rememberLastKnown(part: Part, value: unknown): void {
  if (member === null) {
    pending[part] = value;
    return;
  }
  put(member, { [part]: value });
}

/**
 * This tab's tokens are `sub`'s. False when the record was someone else's: it's gone, and the caller takes down what
 * it drew from it. Anything waiting is written for `sub`.
 */
export function lastKnownFor(sub: string): boolean {
  member = sub;
  const cur = stored();
  const theirs = !cur || cur.sub === sub;
  if (!theirs) writeBeside(LAST_KNOWN_KEY, null);
  const waiting = pending;
  pending = {};
  if (Object.keys(waiting).length) put(sub, waiting);
  return theirs;
}

/** Sign-out, a dead session, a refusal: nothing of the member stays, in either store. */
export function forgetLastKnown(): void {
  pending = {};
  writeBeside(LAST_KNOWN_KEY, null);
}

/** Tests only. */
export function resetLastKnownForTests(): void {
  member = null;
  pending = {};
}
