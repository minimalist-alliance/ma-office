import { describe, expect, it } from 'vitest';
import { billingDayLine, DATA_GUARD_FALLBACK } from '../chrome/dataGuardView';
import { DATA_GUARD_STOPPING } from './dataGuardWords';

describe('the data guard words (ma-platform ADR 0110)', () => {
  it('says the next billing day in the member\'s own time zone', () => {
    // 2026-11-18 03:00 UTC is still Nov 17 in Denver, and already Nov 18 in Tokyo.
    expect(billingDayLine('2026-11-18T03:00:00Z', { now: 0, locale: 'en-US', timeZone: 'America/Denver' })).toBe('Your next billing day is Nov 17.');
    expect(billingDayLine('2026-11-18T03:00:00Z', { now: 0, locale: 'en-US', timeZone: 'Asia/Tokyo' })).toBe('Your next billing day is Nov 18.');
  });
  it('says nothing without a date', () => {
    expect(billingDayLine(null)).toBeNull();
    expect(billingDayLine('soon')).toBeNull();
  });
  it('never shows a dollar figure or "absorbed"', () => {
    for (const t of [DATA_GUARD_STOPPING, DATA_GUARD_FALLBACK]) expect(t).not.toMatch(/\$\s?\d|absorbed/i);
    expect(DATA_GUARD_STOPPING).toBe('Your desks are stopping: your data use this month went past your plan.');
  });
});
