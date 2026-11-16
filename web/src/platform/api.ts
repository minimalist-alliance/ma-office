// Bearer calls to api. (contract auth.md section 3, errors.md).
import { heardAccountClosed } from './accountClosed';
import { endRevoked, getAccessToken, SignInRequired } from './auth';
import { getClientConfig, type ClientConfig } from './clientConfig';
import { ssoOrigin } from './hosts';
import { decodeJwtPayload } from './pkce';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly requestId: string | null;
  readonly retryable: boolean;
  /** Code-specific, such as `billingUrl` (errors.md). Unknown fields are additive. */
  readonly details: Record<string, unknown> | null;
  /** The `Retry-After` header in seconds, when there is one. */
  readonly retryAfterSec: number | null;
  constructor(
    status: number,
    code: string | null,
    message: string,
    requestId: string | null,
    retryable: boolean,
    details: Record<string, unknown> | null = null,
    retryAfterSec: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryable = retryable;
    this.details = details;
    this.retryAfterSec = retryAfterSec;
  }
}

async function toError(res: Response): Promise<ApiError> {
  let body: { error?: { code?: string; message?: string; requestId?: string; retryable?: boolean; details?: unknown }; message?: string } = {};
  try {
    body = (await res.clone().json()) as typeof body;
  } catch {
    /* no JSON body */
  }
  // API Gateway's authorizer answers with only `message` (errors.md).
  return new ApiError(
    res.status,
    body.error?.code ?? null,
    body.error?.message ?? body.message ?? `HTTP ${res.status}`,
    body.error?.requestId ?? res.headers.get('X-Request-Id'),
    body.error?.retryable ?? res.status >= 500,
    body.error?.details && typeof body.error.details === 'object' ? (body.error.details as Record<string, unknown>) : null,
    Number(res.headers.get('Retry-After')) || null,
  );
}

export interface ApiResult<T> {
  status: number;
  data: T | null;
  etag: string | null;
  /** The `Retry-After` header, when CORS lets the page read it. */
  retryAfter: string | null;
}

let kept: Promise<void> | undefined;

/**
 * Step 1 of the shared sign-in (ma-platform contract auth.md §2.8), once a page load where it's on: with a sign-in's own
 * first token (`/auth/callback`), else the first good call's, not waited for. Its answer changes nothing here.
 */
export function keepShared(cfg: ClientConfig, token: string): Promise<void> {
  const origin = ssoOrigin(cfg);
  return (kept ??= origin ? import('./sso').then((m) => m.keepSharedSignIn(origin, token), () => {}) : Promise.resolve());
}

/**
 * Refreshes once after a 401; a second 401 means the session is over, and where the shared sign-in is on, a second
 * `session_revoked` revokes its refresh token too (`endRevoked`). `onToken` sees each token as it's about to go, and may
 * throw to stop it, for a call that's only right for one member.
 */
export async function api<T>(path: string, init: RequestInit & { etag?: string | null; onToken?: (token: string) => void } = {}): Promise<ApiResult<T>> {
  const cfg = await getClientConfig();
  let sent = '';
  const send = async (force: boolean): Promise<Response> => {
    const token = await getAccessToken(force);
    init.onToken?.(token);
    sent = token;
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (init.etag) headers.set('If-None-Match', init.etag);
    return fetch(`${cfg.api}${path}`, { ...init, headers });
  };
  let res = await send(false);
  if (res.status === 401) res = await send(true);
  if (res.status === 401) {
    if (ssoOrigin(cfg) && (await toError(res)).code === 'session_revoked') await endRevoked(sent);
    throw new SignInRequired();
  }
  if (res.status < 400) void keepShared(cfg, sent);
  if (res.status === 304) return { status: 304, data: null, etag: init.etag ?? null, retryAfter: null };
  if (!res.ok) {
    const err = await toError(res);
    // A closed account, from whichever API says so first (`accountClosed.ts`).
    if (res.status === 403) heardAccountClosed(err.code);
    throw err;
  }
  const text = res.status === 204 ? '' : await res.text();
  return { status: res.status, data: text ? (JSON.parse(text) as T) : null, etag: res.headers.get('ETag'), retryAfter: res.headers.get('Retry-After') };
}

export interface Me {
  userId: string;
  /** Maia Mode for this account (ma-platform contract desks.md "Maia Mode"): `enabled` only for a listed adult, not Free, while it's on. Read only through `allowedFor` in `maiamode/prefs.ts`. */
  maiaMode?: { enabled?: boolean };
  email?: string;
  displayName?: string | null;
  /** The checked profile picture's address, or null (ma-platform profile-picture.md). Read through `pictureOf` in `chrome/avatar.ts`. */
  avatarUrl?: string | null;
  /** `{kind: "upload", url, setAt}` or `{kind: "built", config, setAt}`; read through `pictureOf` and `builtRecipeOf`. */
  avatar?: unknown;
  /**
   * `tier` is `alliance`, `officer` or `lead`, or before the migration `member` or none (`readTier` in `tiers.ts`), and
   * `badge` the tier's badge while the membership is live, or null (contract tiers.md section 5).
   */
  membership?: {
    status?: string;
    tier?: string;
    badge?: string | null;
    comped?: boolean;
    billingUrl?: string;
    /** Absent or `null`: the app behaves as it always has. Read only through `platform/age.ts` (ma-platform contract age.md, section 3). */
    ageBand?: string | null;
    /** Teens only. For Platform: this app never works a band out from it. */
    adultFrom?: string | null;
    /** `pending`, `done`, or `null` when no parent is needed: not every teen has a parent step. */
    parent?: string | null;
    /**
     * Why the desks stopped, in the member's own terms only (ma-platform contract desks.md 0.3.69): `payment`, `member`,
     * `other` (anything else, never more specific), or `null`. With `stoppedAt` and `dataDeleteAt`, read only through
     * `stopCard` in `shell/deskNotice.ts`, which picks the office's card C, D or E. Absent, as from a Platform from before: F.
     */
    stoppedBy?: string | null;
    stoppedAt?: string | null;
    dataDeleteAt?: string | null;
    /**
     * The card Stripe charges next stops working before that charge (ma-platform contract billing.md 0.3.86, card rescue):
     * `{month, year, last4}`, else null. Read only through `menuNoteOf` in `platform/billingNote.ts`.
     */
    cardExpiresSoon?: unknown;
    /** Not built by Platform yet: `{kind: 'payment_failed', stopsAt}` while a payment has failed. Read only through `menuNoteOf`. */
    billingNote?: unknown;
    /**
     * `true` for an account the platform closed (ma-platform contract moderation.md section 8), absent otherwise: no app
     * offers Rejoin. It comes with `status: ended` and `stoppedBy: other`. Read only through `platform/accountClosed.ts`.
     */
    closed?: boolean;
    /**
     * A closed account's download window's end (contract moderation.md section 8, 0.3.117 draft amended Nov 12): the users
     * row's `ban_export_until`, or `null` when the ban held the export. Absent for every other member. Read only through
     * `exportUntilOf`.
     */
    exportUntil?: string | null;
    /** With `exportUntil`: `true` when the ban held the export (then `exportUntil` is `null`). Read only through `exportUntilOf`. */
    held?: boolean;
  };
  /** Platform groups, such as `owner` (contract desks.md). Read only to show the owner what only he sees, never for access. */
  roles?: string[];
  /** The guilds the member is in, with their role now (contract tiers.md section 5). Read only by card D (`chrome/endedCard.tsx`): a Founder who leads one. */
  guilds?: Array<{ guildId?: unknown; role?: unknown } | null>;
  /**
   * `staySignedIn`: `30d`, `7d`, `1d` or `browser`, the member's "Stay signed in" (ma-platform `auth.md`). Read only through `placeTokenFor` in
   * `tokenStore.ts`. `officeTour` (`{off}`, proposed to Platform, ADR 0056): the office tour's setting, absent until Platform
   * sends it; read only through `tour/door.ts`.
   */
  preferences?: { staySignedIn?: unknown; staySignedInSince?: unknown; officeTour?: unknown } | null;
  /**
   * What the member hears about until they dismiss it (ma-platform contract auth.md section 2.7): today only
   * `close_hold_cancelled`, a request to close the account that its use stopped. Absent from an older Platform: none.
   * Read only through `closeHoldOf` in `closehold/words.ts`; `shell/Shell.tsx` only looks for the kind.
   */
  notices?: Array<{ kind?: unknown; at?: unknown; requestedAt?: unknown } | null>;
}

/** The Desk object fields the app reads (contract desks.md). Unknown fields and enum values are safe. */
export interface PlatformDesk {
  deskId: string;
  kind: string;
  name: string;
  state: string;
  phase?: string | null;
  stopAt?: string | null;
  stopReason?: string | null;
  /** Only after a cost guard stop (contract desks.md "Traffic stops", TD-162). Read only through `trafficStopOf`. */
  stopDetail?: unknown;
  agentStatus?: string | null;
  badges?: { total?: number; apps?: Record<string, number> } | null;
  queue?: { position?: number } | null;
  lastError?: { code?: string; message?: string } | null;
  runtime?: { version?: string; deskApi?: string } | null;
  nextDowntime?: { endAt?: string; active?: boolean } | null;
  allowedActions?: string[];
  /** `"self"` on a desk on the member's own computer (contract desks.md 0.3.13, selfhost.md). Absent on a cloud desk. */
  hosting?: string;
  /** Only on `hosting: "self"` (contract desks.md 0.3.43, selfhost.md §4): when the platform first saw the desk's current boot, the boot before it (null on the first), and the last time a second copy was refused. */
  bootFirstSeenAt?: string | null;
  previousBootFirstSeenAt?: string | null;
  bootRefusedAt?: string | null;
  /** `true` on the Alliance Member's hosted small desk (contract desks.md 0.3.20, ma-platform ADR 0097). Absent otherwise. */
  startsWithOffice?: boolean;
  /** Not built by Platform yet: a desk a step down ends at renewal (a Work desk below Officer), and when. */
  endsAt?: string | null;
  /** `true` on a kept desk the plan doesn't include, a Work desk after a step down (contract desks.md 0.3.24, ADR 0130): stopped, data kept, `allowedActions: ["export"]`. */
  notInPlan?: boolean;
  /** `retained` only: when the snapshot goes (contract desks.md). A Work desk ended by a step down may carry it (the spec's shape, not built). */
  retainedUntil?: string | null;
  /** When the desk's state last changed (contract desks.md): the day a step down stopped it, where `endsAt` is absent. */
  stateChangedAt?: string | null;
}

export interface DesksResponse {
  membership?: { status?: string; billingUrl?: string };
  desks: PlatformDesk[];
  pollAfterSeconds?: number;
}

/** Contract desks.md. `layout` is null, and `version` 0, if this member has never saved. */
export interface LayoutResponse {
  version: number;
  updatedAt?: string | null;
  layout: unknown;
}

export const getMe = () => api<Me>('/v1/me');
/** Nothing waits on these, but a save that never answers would hold up the next one. */
const LAYOUT_TIMEOUT_MS = 15_000;
export const getDeskLayout = (etag: string | null, onToken: (token: string) => void) => api<LayoutResponse>('/v1/me/desk-layout', { etag, onToken, signal: AbortSignal.timeout(LAYOUT_TIMEOUT_MS) });
/** `keepalive` lets it outlive the page. A browser may refuse one over its own 64 KiB limit, and the save then waits for the next load. */
export const putDeskLayout = (body: string, ifMatch: string, keepalive: boolean, onToken: (token: string) => void) =>
  api<LayoutResponse>('/v1/me/desk-layout', {
    method: 'PUT',
    keepalive,
    onToken,
    signal: AbortSignal.timeout(LAYOUT_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', 'If-Match': ifMatch },
    body,
  });
export const getDesks = (etag?: string | null) => api<DesksResponse>('/v1/desks', { etag: etag ?? null });
/**
 * Renames a desk (contract tiers.md section 8): the name only, a label, for a desk whose `allowedActions` has `rename`.
 * Answers the desk object with its new name. Its kind never changes.
 */
export const patchDeskName = (deskId: string, name: string) =>
  api<PlatformDesk>(`/v1/desks/${encodeURIComponent(deskId)}`, {
    method: 'PATCH',
    signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
/**
 * Step 1 of sign-out (contract auth.md section 6): this session only (`everywhere` is the account's own, in Account
 * settings). `keepalive`, so sign-out can go on to the revoke and the logout without cutting this off.
 */
export const postSignOut = () =>
  api<void>('/v1/me/sign-out', {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: '{"everywhere":false}',
  });

/** The signed-in member's `sub`, read from the access token; null when it has none. */
export async function accessSub(): Promise<string | null> {
  const sub = decodeJwtPayload(await getAccessToken())?.['sub'];
  return typeof sub === 'string' ? sub : null;
}
