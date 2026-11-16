// `desk.attention.set` for one link (task 46, lever 2; deskd API.md section 10, "Nobody looking"): the wire logic each
// link uses to say whether its desk is looked at, which `../attention.ts` decides. Only the links use it, so it's in the
// link's own chunk, out of the first load since `sub/mm-js-budget`.
import { backoffMs } from './backoff';
import { DeskNotConnected, type PhoneDevice } from '../deskLink';

/** deskd gives up on a call by then. Setting it is cheap, so a long wait means the session is in trouble. */
export const ATTENTION_DEADLINE_MS = 5_000;

/** Asking again won't change the answer in this session: a deskd that doesn't know the method, or a token without the scope. */
const FINAL = new Set(['not_found', 'bad_request', 'forbidden', 'unauthorized']);

/**
 * `desk.attention.set {seen, device?}` for one link. Not a mutation and idempotent, so no `idem`. One call at a time and
 * only the newest wish goes, so a quick switch away and back can't land out of order. A new session hears the wish again
 * whatever the last one heard, since the desk keeps it per session. A final no stops asking until the next session.
 * `device` is the phone the Browser shows on (deskd API.md section 10, "On a phone"); a deskd before it ignores it.
 */
export class AttentionSignal {
  private wish: boolean | null = null;
  private phone: PhoneDevice | null = null;
  private isUp = false;
  /** What this session's desk has said yes to: `seen` and the device, as `key` writes them. */
  private heard: string | null = null;
  private busy = false;
  private stopped = false;
  private epoch = 0;
  private attempt = 0;
  private timer = 0;
  /** The desk's last answer in this session: `ok`, or the error's code. For tests and the real-desk check. */
  answer: string | null = null;

  constructor(private readonly send: (seen: boolean, device: PhoneDevice | null) => Promise<unknown>) {}

  /** What the office wants this desk to hear now. Goes at once if a session is up and nothing is on its way. */
  want(seen: boolean): void {
    if (this.wish === seen) return;
    this.wish = seen;
    this.again();
  }

  /** The phone the Browser's picture fills, or null. Goes with `seen`, at once, and with every `seen` after. */
  device(d: PhoneDevice | null): void {
    if (key(true, d) === key(true, this.phone)) return;
    this.phone = d;
    this.again();
  }

  private again(): void {
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
    if (!this.isUp || this.busy || this.timer || this.stopped || this.wish === null || key(this.wish, this.phone) === this.heard) return;
    const seen = this.wish;
    const device = this.phone;
    const epoch = this.epoch;
    this.busy = true;
    this.send(seen, device).then(
      () => {
        if (epoch !== this.epoch) return;
        this.busy = false;
        this.heard = key(seen, device);
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

const key = (seen: boolean, d: PhoneDevice | null): string => `${seen}:${d ? `${d.width}x${d.height}` : ''}`;
