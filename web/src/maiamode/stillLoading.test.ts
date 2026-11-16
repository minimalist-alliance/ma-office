// "Still loading your office…" under the chooser (the owner, Nov 16: it said so over an office that had loaded): only while the
// office really is still loading, 10 s in; and it goes once the office is ready.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let ready: (() => void)[] = [];
let saidReady = false;
vi.mock('../chrome/loadingOverlay', () => ({
  onOfficeReady: (fn: () => void) => {
    if (saidReady) {
      fn();
      return () => undefined;
    }
    ready.push(fn);
    return () => {
      ready = ready.filter((f) => f !== fn);
    };
  },
}));
const officeReady = (): void => {
  saidReady = true;
  for (const fn of ready.splice(0)) fn();
};

const line = () => {
  const on = new Set<string>();
  return { on, classList: { toggle: (c: string, v: boolean) => (v ? on.add(c) : on.delete(c), v) } };
};

describe('the still-loading line', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ready = [];
    saidReady = false;
  });
  afterEach(() => vi.useRealTimers());

  it('the office loads while the chooser is up: it never shows', async () => {
    const { followStillLine, STILL_MS } = await import('./stillLoading');
    const l = line();
    followStillLine(l, STILL_MS);
    vi.advanceTimersByTime(2_000);
    officeReady();
    vi.advanceTimersByTime(60_000);
    expect(l.on.has('on')).toBe(false);
  });
  it('the office was ready before the chooser came: it never shows', async () => {
    const { followStillLine } = await import('./stillLoading');
    officeReady();
    const l = line();
    followStillLine(l, 10_000);
    vi.advanceTimersByTime(60_000);
    expect(l.on.has('on')).toBe(false);
  });
  it('still loading at 10 s: it shows then, not before, and goes once the office is ready', async () => {
    const { followStillLine, STILL_MS } = await import('./stillLoading');
    expect(STILL_MS).toBe(10_000);
    const l = line();
    followStillLine(l, STILL_MS);
    vi.advanceTimersByTime(9_999);
    expect(l.on.has('on')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(l.on.has('on')).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(l.on.has('on')).toBe(true);
    officeReady();
    expect(l.on.has('on')).toBe(false);
  });
  it('the chooser gone (an answer, a sign-out): nothing more happens to it', async () => {
    const { followStillLine } = await import('./stillLoading');
    const l = line();
    const stop = followStillLine(l, 10_000);
    stop();
    vi.advanceTimersByTime(20_000);
    officeReady();
    expect(l.on.has('on')).toBe(false);
    expect(ready).toHaveLength(0);
  });
});
