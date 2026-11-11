// What the link does about each thing the desk or gateway can say (design 3.9, 4.2.7), as data.
import { siblingUrl } from '../../platform/hosts';
import type { DeskRefusal } from '../deskLink';

export type CloseAction =
  | 'reconnect' // a new connection, with a fresh token
  | 'deny' // drop the desk: access denied
  | 'replaced' // a newer session from this tab took over: leave it be
  | 'reload' // this bundle is out of date
  | 'hold' // rate limited: reconnect, but not for 30 s
  | 'recheck' // deskd is going away, and maybe coming straight back: retry, the first at about 2 s
  | 'stopping'; // `connect` or the gateway reports the desk going down: stop retrying

/**
 * Why `recheck` isn't `stopping`: no close proves a stop. deskd sent 4503 on every SIGTERM up to
 * 2026.11.05-d0cc217, so the first update past that version still does, and a stop it wasn't told about
 * sends 4002. Only `connect` and the gateway know, so the link keeps trying until one of them says so.
 * The first try waits about 2 s (this backoff step): deskd takes longer than that to return, and sooner
 * `session.open` could reach its link on the way out. A `phase: ready` from the watch ends any wait.
 */
export const RECHECK_FIRST_ATTEMPT = 2;

const NOT_READY_FIRST_MS = 3_000;
const NOT_READY_MAX_MS = 10_000;

/**
 * Until the next `connect` when the last said the desk isn't ready and set no pace of its own. `checks`
 * counts those answers since the last open. A wake nobody here is waiting for (another tab's, say) stays
 * at 3 s; one a member asked for here goes by `wakePollMs`.
 */
export function notReadyRetryMs(checks: number, waking: boolean): number {
  return waking ? NOT_READY_FIRST_MS : Math.min(NOT_READY_FIRST_MS * 1.5 ** checks, NOT_READY_MAX_MS);
}

/**
 * A wake the member asked for in this tab asks `connect` once a second (TD-227 part 3): the desk is up at its
 * hello, and a 3 s poll found out a median 2.3 s later. The gateway's `phase: ready` push (a watch with the
 * wake's own token) usually ends the wait first; this is its fallback.
 */
export const WAKE_POLL_MS = 1_000;
/** Fast for this long into a wake, then `connect`'s own pace. A wake takes 20 to 30 s, a desk's first boot about 45. */
export const WAKE_FAST_FOR_MS = 90_000;
/** `connect` says 3 s for every wake (services/desks `deskTokenAnswer`). More than that is a real ask to slow down. */
const WAKE_USUAL_PACE_MS = 3_000;

/**
 * Until the next `connect` in a wake the member asked for here, from what the last one said. `paceMs` is its
 * `retryAfterSeconds` (or `Retry-After`), 0 if none; `wakeAgeMs` how long since `start: true` went out. A queue
 * for capacity, and any pace above the usual 3 s, are kept; so is the pace once the wake has run long.
 */
export function wakePollMs(i: { phase: string | null; paceMs: number; wakeAgeMs: number }): number {
  if (i.phase === 'queued' || i.paceMs > WAKE_USUAL_PACE_MS || i.wakeAgeMs > WAKE_FAST_FOR_MS) return i.paceMs || NOT_READY_FIRST_MS;
  return WAKE_POLL_MS;
}

/**
 * Every `connect` this tab sends, over a sliding minute, so a fast poll stays inside the API's limit for a
 * member: 30 a minute (ma-platform contract errors.md, "Rate limits"), however many desks are waking. A poll
 * waits for room; a member's own press and a token refresh never do. 24 leaves room for those. A clock that
 * went back forgets what it counted, rather than holding polls for that long.
 */
export class CallWindow {
  private readonly at: number[] = [];
  constructor(
    readonly max: number,
    readonly windowMs: number,
  ) {}

  note(now: number): void {
    this.trim(now);
    this.at.push(now);
  }

  /** How long until one more call fits: 0 if it does now. */
  waitMs(now: number): number {
    this.trim(now);
    const leaving = this.at[this.at.length - this.max];
    return leaving === undefined ? 0 : leaving + this.windowMs - now;
  }

  private trim(now: number): void {
    if ((this.at[this.at.length - 1] ?? -Infinity) > now) this.at.length = 0;
    while ((this.at[0] ?? Infinity) <= now - this.windowMs) this.at.shift();
  }
}

export const CONNECT_CALLS_PER_MINUTE = 24;

/** `CLOSE {code}` on `ctl`. */
export function closeCodeAction(code: number): CloseAction {
  switch (code) {
    case 4403:
      return 'deny';
    case 4409:
      return 'replaced';
    case 4426:
      return 'reload';
    case 4429:
      return 'hold';
    case 4002: // `deskd_restarting`, or `internal`
    case 4503:
      return 'recheck';
    default:
      return 'reconnect'; // 4401, and the desk's other 4000-4399
  }
}

/** `session.closed {reason}` from the gateway. A revoked member hears it from the next `connect`. */
export function sessionClosedAction(reason: string): CloseAction {
  if (reason === 'desk_stopping' || reason === 'closed_by_desk') return 'recheck';
  if (reason === 'replaced') return 'replaced';
  return 'reconnect'; // `desk_disconnected` too: the gateway knows the link is gone, and `connect` will say so
}

/** The codes `refusalOf` knows. */
export const REFUSAL_CODES: ReadonlySet<string> = new Set(['desk_unavailable', 'account_suspended', 'account_inactive', 'data_guard']);

/**
 * A refusal from `connect` the member should see (contract desks.md, 0.3.11), or null for anything else. None is
 * retried. `desk_unavailable` keeps nothing of what came with it, since the page may say nothing about why.
 */
export function refusalOf(code: string | null | undefined, details: unknown, hostname: string, message?: string | null): DeskRefusal | null {
  let kind: DeskRefusal['kind'];
  switch (code) {
    case 'data_guard': {
      // The data guard (ma-platform ADR 0110): the platform's words as given, and the member's next billing day.
      const resumes = details && typeof details === 'object' ? (details as Record<string, unknown>)['resumesAt'] : null;
      const at = typeof resumes === 'string' && !Number.isNaN(Date.parse(resumes)) ? resumes : null;
      return { kind: 'data_guard', billingUrl: null, message: typeof message === 'string' && message.trim() ? message : null, resumesAt: at };
    }
    case 'desk_unavailable':
      return { kind: 'unavailable', billingUrl: null };
    case 'account_suspended':
      kind = 'suspended';
      break;
    case 'account_inactive':
      kind = 'inactive';
      break;
    default:
      return null;
  }
  const raw = details && typeof details === 'object' ? (details as Record<string, unknown>)['billingUrl'] : null;
  return { kind, billingUrl: siblingUrl(raw, hostname)?.href ?? null };
}

/**
 * Whether `GET /v1/me`'s `membership.status` says `connect` would no longer refuse for the membership: it refuses only
 * `suspended` and `ended` (desks.md, 0.3.11). Anything else unknown or missing waits for the next look.
 */
export function membershipBack(status: unknown): boolean {
  return status === 'active' || status === 'past_due' || status === 'canceling';
}

const MISSES_DOWN = 3;

/** `ctl` liveness: three missed pongs mark the link down, unless the tab is hidden and timers lie. */
export class PongWatch {
  private misses = 0;
  private sawPong = true;

  /** Each 10 s, before sending a PING. True means the link is down. */
  tick(hidden: boolean): boolean {
    if (!this.sawPong) this.misses += 1;
    this.sawPong = false;
    return this.misses >= MISSES_DOWN && !hidden;
  }

  pong(): void {
    this.misses = 0;
    this.sawPong = true;
  }

  /** On tab focus: are there misses worth looking at again? */
  anyMissed(): boolean {
    return this.misses > 0;
  }

  /** After a grace period since focus. */
  isDown(): boolean {
    return this.misses >= MISSES_DOWN;
  }

  reset(): void {
    this.pong();
  }
}
