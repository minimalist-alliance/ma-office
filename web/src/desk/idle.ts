// The idle rule (design 4.2.8, 10.5): a forgotten tab mustn't keep a desk awake, because an open session is what
// counts as a client being there. So a tab closes a desk's sessions after 60 minutes hidden, or after 24 hours
// with no input on that desk even if visible (2 hours on a free or an Alliance desk, which stop soon after, ISS-64b), and keeps only its watches. Watches never keep a desk awake, and
// nothing here can wake one: `rest` and `resume` both go `connect {start: false}`. The 60 minutes wait while the
// desk plays sound (`sound.ts`, ADR 0038), so music in a hidden tab plays on; the 24 hours don't.
//
// Pure apart from what it's handed, so it runs on a fake clock in tests.

import type { BrowserMedia } from './deskLink';
import { LastSound, SOUND_QUIET_MS } from './sound';

export const HIDDEN_CLOSE_MS = 60 * 60 * 1000;
export const NO_INPUT_CLOSE_MS = 24 * 60 * 60 * 1000;
/** A visible tab with no input on a desk that has an idle limit (free and Alliance, ADR 0090 addendum) lets go after this, not 24 hours. */
export const LIMITED_NO_INPUT_CLOSE_MS = 2 * 60 * 60 * 1000;
export const IDLE_CHECK_MS = 60_000;

export interface IdleTarget {
  /** Close this desk's sessions and keep its watch. Doing it again is harmless. */
  rest(deskId: string): void;
  /** The rule no longer holds: open a session again. Does nothing to a link that isn't resting. */
  resume(deskId: string): void;
  deskIds(): Iterable<string>;
  /** This desk's session's media, if one is open: whether it's playing sound. */
  media?(deskId: string): BrowserMedia | null | undefined;
  /**
   * A file transfer is running on this desk (the Files app, ADR 0026 lists "file transfers" as activity). It keeps the session
   * open in a hidden tab and counts as input, so neither rule closes it. A paused transfer is not running.
   */
  busy?(deskId: string): boolean;
  /**
   * This desk has a short idle limit on the Platform (a free or an Alliance desk), so a visible, untouched tab lets go of it
   * after `LIMITED_NO_INPUT_CLOSE_MS` instead of `NO_INPUT_CLOSE_MS`. Absent or false: the 24 hours, as for an Officer, Founder (role lead),
   * Guild or self-hosted desk.
   */
  limited?(deskId: string): boolean;
}

export class IdleRule {
  private readonly lastInput = new Map<string, number>();
  private readonly resting = new Set<string>();
  private readonly sound = new Map<string, LastSound>();
  private hiddenSince: number | null = null;

  constructor(
    private readonly target: IdleTarget,
    private readonly now: () => number = Date.now,
  ) {}

  /** Real input on this desk. Called on every such event, so this stays a map write. */
  noteInput(deskId: string): void {
    this.lastInput.set(deskId, this.now());
    if (this.resting.has(deskId)) this.check(deskId);
  }

  setHidden(hidden: boolean): void {
    if (!hidden) this.hiddenSince = null;
    else this.hiddenSince ??= this.now();
    this.checkAll();
  }

  /** Timers can run late in a hidden tab or a sleeping laptop, so this goes by the clock, not by how often it's called. */
  checkAll(): void {
    for (const deskId of this.target.deskIds()) this.check(deskId);
  }

  forget(deskId: string): void {
    this.lastInput.delete(deskId);
    this.resting.delete(deskId);
    this.sound.delete(deskId);
  }

  /** Asked at every check, and it allows a check's gap, so a session replaced between two isn't taken for silence. */
  private soundPlaying(deskId: string): boolean {
    let sound = this.sound.get(deskId);
    if (!sound) this.sound.set(deskId, (sound = new LastSound(this.now, SOUND_QUIET_MS + IDLE_CHECK_MS)));
    return sound.playing(this.target.media?.(deskId));
  }

  private check(deskId: string): void {
    const now = this.now();
    let last = this.lastInput.get(deskId);
    if (last === undefined) {
      last = now; // first seen: arriving counts as being here
      this.lastInput.set(deskId, now);
    }
    if (this.target.busy?.(deskId)) {
      // A running transfer is the member's own doing: it is activity, so the desk stays awake and the clocks start over.
      this.lastInput.set(deskId, now);
      if (this.resting.delete(deskId)) this.target.resume(deskId);
      return;
    }
    const sound = this.soundPlaying(deskId);
    const hiddenTooLong = this.hiddenSince !== null && now - this.hiddenSince >= HIDDEN_CLOSE_MS && !sound;
    // A limited desk's 2 hours wait while it plays sound (the same signal as the hidden rule's), so music in a visible tab goes on;
    // the 24 hours then still close it, as for every desk.
    const noInputMs = this.target.limited?.(deskId) && !sound ? LIMITED_NO_INPUT_CLOSE_MS : NO_INPUT_CLOSE_MS;
    if (hiddenTooLong || now - last >= noInputMs) {
      this.resting.add(deskId);
      this.target.rest(deskId);
    } else if (this.resting.delete(deskId)) {
      this.target.resume(deskId);
    }
  }
}
