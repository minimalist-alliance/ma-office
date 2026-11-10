// When she falls asleep: after `ms` without use (docs/maia.md §14, "Sleep"). One timer, checked when it's due, so
// use that comes often (a hover, a key in her chat) only writes a number and never touches the timer.

export const SLEEP_AFTER_MS = 5 * 60 * 1000;

export interface IdleTimers {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}

const realTimers: IdleTimers = {
  now: () => performance.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export class IdleClock {
  private last = 0;
  private timer: unknown = null;
  private held = false;
  private done = false;

  constructor(
    private readonly ms: number,
    private readonly onIdle: () => void,
    private readonly timers: IdleTimers = realTimers,
  ) {
    this.touch();
  }

  /** She was used: the wait starts again from now. */
  touch(): void {
    if (this.done) return;
    this.last = this.timers.now();
    if (!this.held) this.arm(this.ms);
  }

  /** The clock doesn't run while she's thinking or speaking. Letting go counts as use. */
  hold(on: boolean): void {
    if (this.held === on) return;
    this.held = on;
    if (on) this.disarm();
    else this.touch();
  }

  destroy(): void {
    this.done = true;
    this.disarm();
  }

  private arm(ms: number): void {
    if (this.timer === null) this.timer = this.timers.set(() => this.due(), ms);
  }

  private disarm(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  private due(): void {
    this.timer = null;
    if (this.held || this.done) return;
    const left = this.last + this.ms - this.timers.now();
    if (left > 0) this.arm(left);
    else this.onIdle();
  }
}

/** `sleepAfterMs` from the caller, or the default. Anything that isn't a positive finite number is the default. */
export function sleepAfter(ms: unknown): number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : SLEEP_AFTER_MS;
}
