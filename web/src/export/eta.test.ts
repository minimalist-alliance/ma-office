import { describe, expect, it } from 'vitest';
import { Eta, FIRST_ESTIMATE_MS, timeLeft } from './eta';

const MB = 1_000_000;

describe('Eta', () => {
  it('says nothing until 10 s are in', () => {
    const e = new Eta();
    for (let t = 0; t < FIRST_ESTIMATE_MS; t += 1000) e.sample(t, (t / 1000) * MB, 100 * MB);
    expect(e.left()).toBeNull();
    e.sample(FIRST_ESTIMATE_MS, 10 * MB, 100 * MB);
    expect(e.left()).toBeCloseTo(90, 0);
  });

  it('takes the rate over the last 30 s, so an old fast start is forgotten', () => {
    const e = new Eta();
    let done = 0;
    for (let t = 0; t <= 60_000; t += 1000) {
      done += t < 20_000 ? 10 * MB : 1 * MB;
      e.sample(t, done, 1000 * MB);
    }
    expect(e.rate()).toBeCloseTo(1 * MB, -3);
  });

  it("doesn't jump with a burst: the time left moves a little at a time", () => {
    const e = new Eta();
    let done = 0;
    let shown: number[] = [];
    for (let t = 0; t <= 300_000; t += 1000) {
      done += t === 90_000 ? 20 * MB : 0.7 * MB; // one burst of 20 MB in a steady 0.7 MB/s
      e.sample(t, done, 32_000 * MB);
      const s = e.left();
      if (s !== null) shown.push(s);
    }
    shown = shown.slice(1);
    for (let i = 1; i < shown.length; i += 1) expect(Math.abs(shown[i]! - shown[i - 1]!) / shown[i - 1]!).toBeLessThan(0.12);
    expect(timeLeft(shown[shown.length - 1]!)).toBe('About 13 hours left');
  });

  it('is asked as often as the page likes without moving: only a sample moves it', () => {
    const e = new Eta();
    for (let t = 0; t <= 15_000; t += 1000) e.sample(t, t * 1000, 1e9);
    const once = e.left();
    for (let i = 0; i < 50; i += 1) expect(e.left()).toBe(once);
  });

  it('starts its window again when what is done falls, as when a file is read again', () => {
    const e = new Eta();
    for (let t = 0; t <= 20_000; t += 1000) e.sample(t, t * 1000, 1e9);
    e.sample(21_000, 0, 1e9);
    expect(e.rate()).toBeNull();
  });
});

describe('timeLeft', () => {
  it.each([
    [null, null],
    [5, 'Less than a minute left'],
    [59, 'Less than a minute left'],
    [80, 'About a minute left'],
    [5 * 60 + 10, 'About 5 minutes left'],
    [9 * 60 + 20, 'About 9 minutes left'],
    [23 * 60, 'About 25 minutes left'],
    [52 * 60, 'About 50 minutes left'],
    [58 * 60, 'About an hour left'],
    [100 * 60, 'About 2 hours left'],
    [13.2 * 3600, 'About 13 hours left'],
  ] as [number | null, string | null][])('%s s reads "%s"', (s, text) => {
    expect(timeLeft(s)).toBe(text);
  });
});
