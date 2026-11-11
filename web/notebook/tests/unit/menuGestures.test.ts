// A long press by touch, and focus going back after a menu (src/ui/menu/gestures.ts).
import { describe, expect, it, vi } from 'vitest';
import { createFocusReturn, createLongPress, LONG_PRESS_MS, type Focusable } from '../../src/ui/menu/gestures.ts';

function clock() {
  let t = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimer: (id: unknown) => {
      const i = timers.findIndex((x) => x.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    advance(ms: number) {
      t += ms;
      for (const x of [...timers].filter((x) => x.at <= t)) {
        timers.splice(timers.indexOf(x), 1);
        x.fn();
      }
    },
  };
}

describe('long press', () => {
  it('opens after the finger stays down, where it went down', () => {
    const c = clock();
    const on = vi.fn();
    const lp = createLongPress({ onLongPress: on, ...c });
    lp.down(100, 200, 'touch', 1);
    c.advance(LONG_PRESS_MS - 1);
    expect(on).not.toHaveBeenCalled();
    c.advance(1);
    expect(on).toHaveBeenCalledWith(100, 200);
  });

  it('never for a mouse, which has a right button, nor a second finger', () => {
    const c = clock();
    const on = vi.fn();
    const lp = createLongPress({ onLongPress: on, ...c });
    lp.down(1, 1, 'mouse', 1);
    c.advance(2000);
    lp.down(1, 1, 'touch', 2, false);
    c.advance(2000);
    expect(on).not.toHaveBeenCalled();
  });

  it('a pen counts', () => {
    const c = clock();
    const on = vi.fn();
    createLongPress({ onLongPress: on, ...c }).down(5, 5, 'pen', 1);
    c.advance(LONG_PRESS_MS);
    expect(on).toHaveBeenCalledOnce();
  });

  it('lifting early, or moving further than a wobble (a scroll), cancels it', () => {
    const c = clock();
    const on = vi.fn();
    const lp = createLongPress({ onLongPress: on, ...c });
    lp.down(0, 0, 'touch', 1);
    c.advance(200);
    lp.up();
    c.advance(1000);
    lp.down(0, 0, 'touch', 1);
    lp.move(4, 6, 1); // within 10 px
    c.advance(LONG_PRESS_MS);
    expect(on).toHaveBeenCalledOnce();
    lp.down(0, 0, 'touch', 1);
    lp.move(0, 30, 1);
    c.advance(LONG_PRESS_MS);
    expect(on).toHaveBeenCalledOnce();
  });

  it("another pointer's move doesn't cancel it", () => {
    const c = clock();
    const on = vi.fn();
    const lp = createLongPress({ onLongPress: on, ...c });
    lp.down(0, 0, 'touch', 1);
    lp.move(100, 100, 2);
    c.advance(LONG_PRESS_MS);
    expect(on).toHaveBeenCalledOnce();
  });

  it('swallows the click and contextmenu that follow it, and only those', () => {
    const c = clock();
    const lp = createLongPress({ onLongPress: () => {}, ...c });
    expect(lp.justFired()).toBe(false);
    lp.down(0, 0, 'touch', 1);
    c.advance(LONG_PRESS_MS);
    expect(lp.justFired()).toBe(true);
    c.advance(900);
    expect(lp.justFired()).toBe(false);
  });
});

class El implements Focusable {
  focused = 0;
  isConnected = true;
  constructor(readonly name: string) {}
  focus() {
    this.focused += 1;
  }
}
const isEl = (x: unknown): x is El => x instanceof El;

describe('focus going back', () => {
  it('goes back to what had focus when the menu opened', () => {
    const editor = new El('editor');
    let active: unknown = editor;
    const back = createFocusReturn(() => active, isEl);
    back.capture();
    active = new El('menu item');
    expect(back.restore()).toBe(editor);
    expect(editor.focused).toBe(1);
  });

  it('falls back to the row or editor the menu was about if that has gone', () => {
    const gone = new El('gone');
    const row = new El('row');
    const back = createFocusReturn(() => gone, isEl);
    back.capture(row);
    gone.isConnected = false;
    expect(back.restore()).toBe(row);
    expect(row.focused).toBe(1);
  });

  it('uses the fallback when nothing had focus', () => {
    const row = new El('row');
    const back = createFocusReturn(() => null, isEl);
    back.capture(row);
    expect(back.restore()).toBe(row);
  });

  it('goes nowhere when both have gone, and only once', () => {
    const a = new El('a');
    const back = createFocusReturn(() => a, isEl);
    back.capture();
    a.isConnected = false;
    expect(back.restore()).toBeNull();
    a.isConnected = true;
    expect(back.restore()).toBeNull();
    expect(a.focused).toBe(0);
  });

  it('forget: a click away leaves focus with what was clicked', () => {
    const a = new El('a');
    const back = createFocusReturn(() => a, isEl);
    back.capture();
    back.forget();
    expect(back.restore()).toBeNull();
    expect(a.focused).toBe(0);
  });
});
