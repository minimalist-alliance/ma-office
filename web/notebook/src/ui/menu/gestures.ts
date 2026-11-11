// What opens a context menu besides a right click: a long press on a touch screen, and focus to go back to after it closes.
// Both are plain objects over injected timers and elements, so tests/unit/menuGestures.test.ts runs them without a DOM.

export interface LongPressOptions {
  /** How long a finger stays down, ms. */
  delay?: number;
  /** How far it may wander and still count, px. */
  slop?: number;
  onLongPress: (x: number, y: number) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  now?: () => number;
}

export const LONG_PRESS_MS = 500;
const SLOP_PX = 10;
/** After a long press, the click and the browser's own contextmenu that follow it are the press's, not new ones. */
const SWALLOW_MS = 800;

/** A long press by touch or pen. A mouse never long-presses: it has a right button. */
export function createLongPress(opts: LongPressOptions) {
  const delay = opts.delay ?? LONG_PRESS_MS;
  const slop = opts.slop ?? SLOP_PX;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const now = opts.now ?? (() => Date.now());
  let timer: unknown = null;
  let start: { x: number; y: number; id: number } | null = null;
  let firedAt = -Infinity;

  const cancel = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    start = null;
  };

  return {
    down(x: number, y: number, pointerType: string, id: number, isPrimary = true): void {
      cancel();
      if (pointerType === 'mouse' || !isPrimary) return;
      start = { x, y, id };
      timer = setTimer(() => {
        timer = null;
        if (!start) return;
        firedAt = now();
        const at = start;
        start = null;
        opts.onLongPress(at.x, at.y);
      }, delay);
    },
    move(x: number, y: number, id: number): void {
      if (start && start.id === id && Math.hypot(x - start.x, y - start.y) > slop) cancel();
    },
    up(): void {
      cancel();
    },
    cancel,
    /** True just after a long press opened a menu: swallow the click and the contextmenu that come with the finger lifting. */
    justFired(): boolean {
      return now() - firedAt < SWALLOW_MS;
    },
    /** A second finger, a scroll or the page going away. */
    pending(): boolean {
      return timer !== null;
    },
  };
}
export type LongPress = ReturnType<typeof createLongPress>;

export interface Focusable {
  focus(opts?: { preventScroll?: boolean }): void;
  readonly isConnected: boolean;
}

/**
 * Where focus goes back to when a menu closes: what had it when the menu opened, if that's still in the page; else the
 * fallback (the row or the editor the menu was about), if that is.
 */
export function createFocusReturn<T extends Focusable>(active: () => unknown, isFocusable: (el: unknown) => el is T) {
  let saved: T | null = null;
  let fallback: T | null = null;
  return {
    capture(fb?: T | null): void {
      const a = active();
      saved = isFocusable(a) ? a : null;
      fallback = fb ?? null;
    },
    restore(): T | null {
      const to = saved?.isConnected ? saved : fallback?.isConnected ? fallback : null;
      saved = null;
      fallback = null;
      to?.focus({ preventScroll: true });
      return to;
    },
    forget(): void {
      saved = null;
      fallback = null;
    },
  };
}
