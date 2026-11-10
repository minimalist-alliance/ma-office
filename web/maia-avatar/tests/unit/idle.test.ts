// The sleep clock on a fake clock: 5 minutes without use, one timer, held while she thinks or speaks.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { IdleClock, SLEEP_AFTER_MS, sleepAfter } from '../../src/idle.js';

let armed = 0;
const timers = {
  now: () => Date.now(),
  set: (fn: () => void, ms: number) => { armed += 1; return setTimeout(fn, ms); },
  clear: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
};
beforeEach(() => { vi.useFakeTimers({ now: 0 }); armed = 0; });
afterEach(() => vi.useRealTimers());

test('the default is 5 minutes, and only a positive number changes it', () => {
  expect(SLEEP_AFTER_MS).toBe(300_000);
  for (const bad of [undefined, null, 0, -5, Number.NaN, Infinity, '300']) expect(sleepAfter(bad)).toBe(300_000);
  expect(sleepAfter(30_000)).toBe(30_000);
});

test('asleep at exactly 5 minutes without use, not a millisecond before', () => {
  const asleep = vi.fn();
  new IdleClock(SLEEP_AFTER_MS, asleep, timers);
  vi.advanceTimersByTime(299_999);
  expect(asleep).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(asleep).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(3_600_000);
  expect(asleep).toHaveBeenCalledTimes(1); // once asleep, the clock waits for use
});

test('use starts the wait again, with one timer however often she is used', () => {
  const asleep = vi.fn();
  const clock = new IdleClock(SLEEP_AFTER_MS, asleep, timers);
  for (let s = 1; s <= 200; s += 1) { vi.advanceTimersByTime(1000); clock.touch(); } // a hover a second for 200 s
  expect(armed).toBe(1);
  vi.advanceTimersByTime(299_999);
  expect(asleep).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(asleep).toHaveBeenCalledTimes(1);
  expect(armed).toBe(2); // the first came due at 300 s, saw the use at 200 s, and waited the rest
  clock.touch(); // used again after sleeping: the wait starts over
  vi.advanceTimersByTime(300_000);
  expect(asleep).toHaveBeenCalledTimes(2);
});

test('held while she thinks or speaks, and letting go counts as use', () => {
  const asleep = vi.fn();
  const clock = new IdleClock(60_000, asleep, timers);
  vi.advanceTimersByTime(30_000);
  clock.hold(true);
  vi.advanceTimersByTime(3_600_000);
  expect(asleep).not.toHaveBeenCalled();
  clock.hold(false);
  vi.advanceTimersByTime(59_999);
  expect(asleep).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(asleep).toHaveBeenCalledTimes(1);
});

test('destroy leaves no timer behind', () => {
  const asleep = vi.fn();
  const clock = new IdleClock(1000, asleep, timers);
  clock.destroy();
  clock.touch();
  vi.advanceTimersByTime(10_000);
  expect(asleep).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
