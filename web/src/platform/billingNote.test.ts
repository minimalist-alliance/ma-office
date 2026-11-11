import { describe, expect, it } from 'vitest';
import { cardExpired, cardLine, cardSoonOf, menuNoteOf, stopsOnLine } from './billingNote';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const BILLING = 'https://platform.example.com/billing';

describe('the account menu note (still 32)', () => {
  it('is nothing from a Platform without card rescue, or without a billing page', () => {
    expect(menuNoteOf({}, BILLING, NOW)).toBeNull();
    expect(menuNoteOf({ cardExpiresSoon: null }, BILLING, NOW)).toBeNull();
    expect(menuNoteOf(undefined, BILLING, NOW)).toBeNull();
    expect(menuNoteOf({ cardExpiresSoon: { month: 11, year: 2026, last4: '4242' } }, null, NOW)).toBeNull();
  });
  it('says the card, quietly', () => {
    expect(menuNoteOf({ cardExpiresSoon: { month: 11, year: 2026, last4: '4242' } }, BILLING, NOW)).toEqual({ kind: 'card', text: 'Card ending 4242 expires 11/26.', link: BILLING });
  });
  it('says expired once it has, from the first of the next month, UTC', () => {
    const c = { month: 11, year: 2026, last4: '4242' };
    expect(cardExpired(c, Date.parse('2026-11-30T23:59:59Z'))).toBe(false);
    expect(cardExpired(c, Date.parse('2026-12-01T00:00:00Z'))).toBe(true);
    expect(cardLine(c, Date.parse('2026-12-02T00:00:00Z'))).toBe('Card ending 4242 expired 11/26.');
  });
  it('puts a failed payment first', () => {
    expect(menuNoteOf({ billingNote: { kind: 'payment_failed', stopsAt: '2026-12-08T00:00:00Z' }, cardExpiresSoon: { month: 11, year: 2026, last4: '4242' } }, BILLING, NOW)).toEqual({ kind: 'payment', text: "Your last payment didn't go through.", link: BILLING });
  });
  it('reads nothing it can\'t trust', () => {
    expect(cardSoonOf({ month: 13, year: 2026, last4: '4242' })).toBeNull();
    expect(cardSoonOf({ month: 11, year: 26, last4: '4242' })).toBeNull();
    expect(cardSoonOf({ month: 11, year: 2026, last4: '42<b>' })).toBeNull();
    expect(menuNoteOf({ billingNote: { kind: 'something_else' } }, BILLING, NOW)).toBeNull();
  });
});

describe('Stops on (still 14)', () => {
  it('names the day, in UTC', () => {
    expect(stopsOnLine('2026-12-01T18:04:00Z')).toBe('Stops on December 1');
    expect(stopsOnLine(null)).toBeNull();
    expect(stopsOnLine('not a date')).toBeNull();
  });
});
