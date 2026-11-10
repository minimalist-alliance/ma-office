import { describe, expect, it } from 'vitest';
import { FREE_WAIT, freeLabel, freeUntil, startStatus } from './free';

// Local times, so the words don't depend on the machine's zone.
const at = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime();
const iso = (ms: number): string => new Date(ms).toISOString();
const NOW = at(2026, 11, 8, 9, 30); // a Sunday

describe('freeUntil', () => {
  it('is the time while it is ahead, and null once it has passed or is bad', () => {
    expect(freeUntil(iso(NOW + 60_000), NOW)?.getTime()).toBe(NOW + 60_000);
    expect(freeUntil(iso(NOW), NOW)).toBeNull();
    expect(freeUntil(iso(NOW - 1), NOW)).toBeNull();
    for (const bad of [null, undefined, '', 'soon']) expect(freeUntil(bad, NOW)).toBeNull();
  });
});

describe('freeLabel', () => {
  it('says the time today, the weekday and time within a week, and the date past that, in en-US', () => {
    expect(freeLabel(iso(at(2026, 11, 8, 17, 0)), NOW, 'en-US')).toBe('Free Maia until 5:00 PM');
    expect(freeLabel(iso(at(2026, 11, 9, 0, 0)), NOW, 'en-US')).toBe('Free Maia until Mon 12:00 AM');
    expect(freeLabel(iso(at(2026, 11, 14, 17, 0)), NOW, 'en-US')).toBe('Free Maia until Sat 5:00 PM');
    expect(freeLabel(iso(at(2026, 12, 1, 0, 0)), NOW, 'en-US')).toBe('Free Maia until Dec 1');
  });

  it("says nothing once it's over, and never names a model", () => {
    expect(freeLabel(iso(NOW - 1000), NOW)).toBeNull();
    expect(freeLabel(null, NOW)).toBeNull();
    const words = freeLabel(iso(NOW + 3_600_000), NOW, 'en-US') ?? '';
    expect(words).toMatch(/^Free Maia until /);
    expect(words).not.toMatch(/gemma|qwen|llama|claude|gpt|model/i);
  });
});

describe('startStatus', () => {
  it('says she is thinking on free Maia until her first words, and nothing otherwise', () => {
    const free = { until: iso(NOW + 3_600_000) };
    expect(startStatus(free, '')).toBe(FREE_WAIT);
    expect(startStatus(free, 'Here')).toBeNull();
    expect(startStatus(null, '')).toBeNull();
    expect(FREE_WAIT).toBe('Free Maia is thinking. This can take a minute.');
    expect(FREE_WAIT).not.toMatch(/gemma|qwen|llama|claude|gpt|model|!/i);
  });
});
