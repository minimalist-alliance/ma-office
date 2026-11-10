// `browser.stream.set`: keeps the desk at what the window wants (docs/interfaces/desk-runtime.md 8.4). One
// call at a time, and only the newest wish matters, so a quick close and reopen can't land out of order.
import type { StreamState } from '../desk/deskLink';
import { backoffMs } from '../desk/rtc/backoff';

/**
 * A first `live` starts Chromium, and a unit can take 35 s (deskd API.md section 10). A fresh root's first took about
 * 73 s on a real desk. Running this out isn't a failure: the work carries on, the state stands, and the picture ends
 * the wait. So the window goes on saying it's starting, with nothing to click.
 */
export const STREAM_DEADLINE_MS = 35_000;

/** A retry won't change the answer until the next session. Everything else (`unavailable`, a timeout) is worth another. */
const FINAL = new Set(['not_found', 'forbidden', 'bad_request', 'unauthorized', 'step_up_required']);

/**
 * `unavailable` with this `reason`: the desk refused to start Chromium on a profile a newer one last ran, which keeps the
 * member's session safe (ADR 0035, deskd API.md section 10). Only a fix on the desk clears it, and each try costs the desk
 * a process and a `crit` line, so nothing asks again by itself: a new session asks once, and so does the member's press.
 */
export const OLDER_THAN_PROFILE = 'chromium_older_than_profile';

const isOlderThanProfile = (err: unknown): boolean => {
  const e = err as { code?: string; details?: { reason?: unknown } } | null;
  return e?.code === 'unavailable' && e.details?.reason === OLDER_THAN_PROFILE;
};

/**
 * `unavailable` with this `reason`: Platform has paused this member's Browser at a bandwidth limit, and the desk says
 * so itself (deskd API.md section 10, ma-platform contract bandwidth.md). Nothing was started, `warm`, `off` and the
 * tabs still work, and the desk lifts it by itself at `resumesAt`. So nothing asks `live` again in this session: the
 * window shows the pause (`bandwidth/StreamPause.tsx`), which asks again at the desk's time.
 */
export const BANDWIDTH_LIMIT = 'bandwidth_limit';

/** The desk's bandwidth pause, with its own reset time (an ISO time, or null if it didn't say), or null for any other answer. */
function bandwidthPauseOf(err: unknown): { resumesAt: string | null } | null {
  const e = err as { code?: string; details?: { reason?: unknown; resumesAt?: unknown } } | null;
  if (e?.code !== 'unavailable' || e.details?.reason !== BANDWIDTH_LIMIT) return null;
  const at = e.details.resumesAt;
  return { resumesAt: typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : null };
}

export interface StreamStatus {
  /** The desk's last word for good, such as `not_found` from a deskd with no Browser yet, or `chromium_older_than_profile`. */
  refused: string | null;
  /** The desk has said yes to `live`. */
  live: boolean;
  /** The desk has said yes to what's wanted, `warm` included: the simple view's browser is there (task 47). */
  ready?: boolean;
  /** The member's own try after `chromium_older_than_profile` is on its way. */
  trying: boolean;
  /** The desk refused `live` with `bandwidth_limit`: no `live` goes again in this session. */
  bandwidthPaused: boolean;
  /** The desk's own time for the end of that pause, or null if it didn't say. */
  resumesAt: string | null;
}

export class StreamControl {
  private want: StreamState = 'off';
  /** What the desk has said yes to in this session. A new session starts at `off` (`view` is false). */
  private have: StreamState = 'off';
  private sessionUp = false;
  private busy = false;
  private epoch = 0;
  private attempt = 0;
  private timer = 0;
  private refused: string | null = null;
  /** The member asked to try again after `chromium_older_than_profile`: one `live` may go. */
  private tryOnce = false;
  private trying = false;
  /** The desk's `bandwidth_limit`, with its `resumesAt`. Only `live` waits on it. */
  private paused: { resumesAt: string | null } | null = null;

  constructor(
    private readonly send: (state: StreamState) => Promise<unknown>,
    private readonly onStatus: (status: StreamStatus) => void,
  ) {}

  set(state: StreamState): void {
    if (state === this.want) return;
    this.want = state;
    this.attempt = 0;
    this.clearTimer();
    this.pump();
  }

  /** A new session is open. The desk knows nothing of this tab's wishes yet. */
  up(): void {
    this.epoch += 1;
    this.sessionUp = true;
    this.have = 'off';
    this.busy = false;
    this.refused = null;
    this.paused = null;
    this.tryOnce = false;
    this.trying = false;
    this.attempt = 0;
    this.clearTimer();
    this.report();
    this.pump();
  }

  /** The desk took away what this needs, by another way than this call. It's final until the next session. */
  refuse(code: string): void {
    this.refused = code;
    this.tryOnce = false;
    this.clearTimer();
    this.report();
  }

  /**
   * The member's press, after `chromium_older_than_profile`: one `live`, and the window says what it said until the
   * desk answers. Nothing else lifts that refusal but a new session.
   */
  retry(): void {
    if (this.refused !== OLDER_THAN_PROFILE || this.want !== 'live' || this.busy) return;
    this.tryOnce = true;
    this.pump();
  }

  /** Ask again for what's wanted, even if the desk said yes: `live` also starts any unit that has stopped by itself. */
  again(): void {
    if (this.busy || this.timer || this.refused || this.paused) return;
    this.have = 'off';
    this.pump();
  }

  /** Nothing left to tell this session's desk. */
  settled(): boolean {
    return !this.sessionUp || this.refused !== null || (this.paused !== null && this.want === 'live' && !this.busy) || (this.want === this.have && !this.busy);
  }

  /** The session is gone, and whatever was on its way with it. */
  down(): void {
    this.epoch += 1;
    this.sessionUp = false;
    this.have = 'off';
    this.busy = false;
    this.tryOnce = false;
    this.trying = false;
    this.clearTimer();
    this.report();
  }

  private clearTimer(): void {
    window.clearTimeout(this.timer);
    this.timer = 0;
  }

  private report(): void {
    this.onStatus({
      refused: this.refused,
      live: !this.refused && this.have === 'live' && this.want === 'live',
      ready: !this.refused && this.have !== 'off' && this.have === this.want,
      trying: this.trying,
      bandwidthPaused: this.paused !== null,
      resumesAt: this.paused?.resumesAt ?? null,
    });
  }

  private pump(): void {
    // A final no ends the asking, but a closed window can still say `off` to a desk that once said yes.
    if (!this.sessionUp || this.busy || this.timer || (this.refused && this.want !== 'off' && !this.tryOnce) || this.want === this.have) return;
    if (this.paused && this.want === 'live') return; // the desk's pause: `warm` and `off` still go
    const state = this.want;
    const epoch = this.epoch;
    this.busy = true;
    this.trying = this.tryOnce;
    this.tryOnce = false;
    if (this.trying) this.report();
    this.send(state).then(
      () => {
        if (epoch !== this.epoch) return;
        this.busy = false;
        this.trying = false;
        this.have = state;
        this.attempt = 0;
        if (this.refused === OLDER_THAN_PROFILE) this.refused = null; // the desk has been fixed
        this.report();
        this.pump();
      },
      (err: unknown) => {
        if (epoch !== this.epoch) return;
        this.busy = false;
        this.trying = false;
        const pause = bandwidthPauseOf(err);
        if (pause) {
          // Final for `live` in this session, with no retry: the desk lifts it at its own time, and the window asks then.
          this.paused = pause;
          this.have = 'off';
          this.attempt = 0;
          this.report();
          this.pump();
          return;
        }
        if (isOlderThanProfile(err)) {
          // Final, as below, and deskd has put this session `off`.
          this.refused = OLDER_THAN_PROFILE;
          this.have = 'off';
          this.attempt = 0;
          this.report();
          return;
        }
        // Any other answer to the member's try: the desk has changed, so go on as for any session.
        if (this.refused === OLDER_THAN_PROFILE) {
          this.refused = null;
          this.report();
        }
        const code = (err as { code?: string } | null)?.code ?? '';
        if (FINAL.has(code)) {
          this.refused = code;
          this.report();
          return;
        }
        if (code === 'deadline_exceeded') {
          // Stopped waiting, ourselves or deskd: the work carries on and the state stands, so there's no call for another.
          this.have = state;
          this.attempt = 0;
          this.report();
          this.pump();
          return;
        }
        // `unavailable`: a unit failed, and this session is `off` until it asks again.
        this.timer = window.setTimeout(() => {
          this.timer = 0;
          this.pump();
        }, backoffMs(this.attempt));
        this.attempt += 1;
      },
    );
  }
}
