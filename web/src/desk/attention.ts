// One live picture per member (task 46, lever 2; deskd API.md section 10, "Nobody looking", and ADR 0045). The office tells
// each desk whether it's looked at, per session, with `desk.attention.set {seen}`, and hears back on topic
// `desk.attention {seen, frozen}`. Nobody looking for 5 s, the desk cuts every session's media, sound included; for 60 s
// with nothing working its Chromium, it freezes it. Looked at again, it thaws and sends media at once. The office keeps a
// still up until the first real frame (`browser/driver.ts`).
//
// This file is the one place that decides "looked at", and the wire logic each link uses to say it.
import type { CameraMode } from '../state/viewStore';
import { backoffMs } from './rtc/backoff';
import { DeskNotConnected } from './deskLink';

/**
 * The desk whose windows are on screen: the active desk, in desk or free mode. The overview parks every window
 * (design 3.6), so it shows none, and nothing at all shows while the office itself isn't (the export page).
 * `WindowLayer` parks the rest by this same rule.
 */
export function shownDesk(v: { mode: CameraMode; activeDesk: string | null }, officeShown = true): string | null {
  return officeShown && v.mode !== 'overview' ? v.activeDesk : null;
}

/**
 * The one desk the member is looking at: the shown desk while the tab can be seen, or while it's hidden and the member is
 * `listening`, as that desk plays sound to this tab (ADR 0038: the desk would otherwise cut the sound with the picture).
 * Every other desk is unseen.
 */
export function lookedAtDesk(v: { mode: CameraMode; activeDesk: string | null }, hidden: boolean, officeShown = true, listening = false): string | null {
  return hidden && !listening ? null : shownDesk(v, officeShown);
}

/** deskd gives up on a call by then. Setting it is cheap, so a long wait means the session is in trouble. */
export const ATTENTION_DEADLINE_MS = 5_000;

/** Asking again won't change the answer in this session: a deskd that doesn't know the method, or a token without the scope. */
const FINAL = new Set(['not_found', 'bad_request', 'forbidden', 'unauthorized']);

/**
 * `desk.attention.set {seen}` for one link. Not a mutation and idempotent, so no `idem`. One call at a time and only the
 * newest wish goes, so a quick switch away and back can't land out of order. A new session hears the wish again whatever
 * the last one heard, since the desk keeps it per session. A final no stops asking until the next session.
 */
export class AttentionSignal {
  private wish: boolean | null = null;
  private isUp = false;
  /** What this session's desk has said yes to. */
  private heard: boolean | null = null;
  private busy = false;
  private stopped = false;
  private epoch = 0;
  private attempt = 0;
  private timer = 0;
  /** The desk's last answer in this session: `ok`, or the error's code. For tests and the real-desk check. */
  answer: string | null = null;

  constructor(private readonly send: (seen: boolean) => Promise<unknown>) {}

  /** What the office wants this desk to hear now. Goes at once if a session is up and nothing is on its way. */
  want(seen: boolean): void {
    if (this.wish === seen) return;
    this.wish = seen;
    this.attempt = 0;
    this.clearTimer();
    this.pump();
  }

  /** A new session is open. Its desk knows nothing of this office's wish yet. */
  up(): void {
    this.epoch += 1;
    this.isUp = true;
    this.heard = null;
    this.busy = false;
    this.stopped = false;
    this.answer = null;
    this.attempt = 0;
    this.clearTimer();
    this.pump();
  }

  /** The session is gone, and whatever was on its way with it. */
  down(): void {
    this.epoch += 1;
    this.isUp = false;
    this.heard = null;
    this.busy = false;
    this.clearTimer();
  }

  private clearTimer(): void {
    window.clearTimeout(this.timer);
    this.timer = 0;
  }

  private pump(): void {
    if (!this.isUp || this.busy || this.timer || this.stopped || this.wish === null || this.wish === this.heard) return;
    const seen = this.wish;
    const epoch = this.epoch;
    this.busy = true;
    this.send(seen).then(
      () => {
        if (epoch !== this.epoch) return;
        this.busy = false;
        this.heard = seen;
        this.answer = 'ok';
        this.attempt = 0;
        this.pump();
      },
      (err: unknown) => {
        if (epoch !== this.epoch) return;
        this.busy = false;
        const code = (err as { code?: string } | null)?.code ?? '';
        this.answer = code || (err instanceof DeskNotConnected ? 'not_connected' : 'error');
        if (FINAL.has(code)) {
          this.stopped = true;
          return;
        }
        // The session is going: the next one asks again from `up()`.
        if (err instanceof DeskNotConnected) return;
        this.timer = window.setTimeout(() => {
          this.timer = 0;
          this.pump();
        }, backoffMs(this.attempt));
        this.attempt += 1;
      },
    );
  }
}
