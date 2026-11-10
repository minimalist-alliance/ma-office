// Office activity keeps Maia awake: the owner, "Her eyes cannot be closed the whole time!"
import { describe, expect, it } from 'vitest';
import { STREAM_USE_EVERY_MS, WAKE_EVERY_MS, watchOfficeActivity } from './officeActivity';

function rig(opts: { hidden?: boolean } = {}) {
  const listeners = new Map<string, { fn: EventListener; options: unknown }>();
  const target = {
    addEventListener: (type: string, fn: EventListener, options: unknown) => void listeners.set(type, { fn, options }),
    removeEventListener: (type: string) => void listeners.delete(type),
  } as unknown as Window;
  const clock = { t: 1000 };
  const timers = new Map<number, () => void>();
  let next = 1;
  let uses = 0;
  const activity = watchOfficeActivity(() => void uses++, {
    target,
    now: () => clock.t,
    hidden: () => !!opts.hidden,
    setInterval: (fn) => {
      timers.set(next, fn);
      return next++;
    },
    clearInterval: (id) => void timers.delete(id as number),
  });
  const fire = (type: string) => listeners.get(type)?.fn(new Event(type));
  return { activity, listeners, clock, timers, fire, uses: () => uses };
}

describe('office activity keeps her awake', () => {
  it('any input anywhere in the office counts, on passive capture listeners that see what a desk window stops', () => {
    const r = rig();
    expect([...r.listeners.keys()].sort()).toEqual(['keydown', 'pointerdown', 'pointermove', 'touchstart', 'wheel']);
    for (const { options } of r.listeners.values()) expect(options).toEqual({ capture: true, passive: true });
    r.fire('keydown');
    expect(r.uses()).toBe(1);
  });

  it(`a flood of pointer moves wakes her at most once every ${WAKE_EVERY_MS} ms`, () => {
    const r = rig();
    for (let i = 0; i < 100; i++) {
      r.fire('pointermove');
      r.clock.t += 10;
    }
    expect(r.uses()).toBe(1);
    r.clock.t += WAKE_EVERY_MS;
    r.fire('wheel');
    expect(r.uses()).toBe(2);
  });

  it('a desk stream playing counts as use while it plays, and stops counting when it stops', () => {
    const r = rig();
    r.activity.setStreaming(true);
    expect(r.uses()).toBe(1);
    expect(r.timers.size).toBe(1);
    r.activity.setStreaming(true);
    expect(r.timers.size).toBe(1);
    const tick = [...r.timers.values()][0] as () => void;
    r.clock.t += STREAM_USE_EVERY_MS;
    tick();
    expect(r.uses()).toBe(2);
    expect(STREAM_USE_EVERY_MS).toBeLessThan(30_000); // her shortest sleep setting
    r.activity.setStreaming(false);
    expect(r.timers.size).toBe(0);
  });

  it('a hidden tab wakes nothing, and stop removes every listener and timer', () => {
    const hidden = rig({ hidden: true });
    hidden.fire('pointerdown');
    expect(hidden.uses()).toBe(0);
    const r = rig();
    r.activity.setStreaming(true);
    r.activity.stop();
    expect(r.listeners.size).toBe(0);
    expect(r.timers.size).toBe(0);
  });
});
