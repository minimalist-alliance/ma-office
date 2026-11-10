import { describe, expect, it } from 'vitest';
import { formatUsd, offerFrom } from './membershipOffer';

describe('offerFrom', () => {
  it('is Pay open only with enabled exactly true and a usable officer price, as on the account page', () => {
    expect(offerFrom({ billing: { enabled: true, officerMonthlyUsd: 100 } })).toEqual({ open: true, allianceMonthlyUsd: null });
    for (const cfg of [
      null,
      {},
      { billing: null },
      { billing: { enabled: false, officerMonthlyUsd: 100 } },
      { billing: { enabled: 'true', officerMonthlyUsd: 100 } },
      { billing: { enabled: true } },
      { billing: { enabled: true, officerMonthlyUsd: 0 } },
      { billing: { enabled: true, officerMonthlyUsd: '100' } },
      { billing: { enabled: true, officerMonthlyUsd: Number.NaN } },
    ]) {
      expect(offerFrom(cfg)).toEqual({ open: false, allianceMonthlyUsd: null });
    }
  });

  it('carries the Alliance price only when there is one and Pay is open', () => {
    expect(offerFrom({ billing: { enabled: true, officerMonthlyUsd: 100, allianceMonthlyUsd: 10 } }).allianceMonthlyUsd).toBe(10);
    expect(offerFrom({ billing: { enabled: true, officerMonthlyUsd: 100, allianceMonthlyUsd: -5 } }).allianceMonthlyUsd).toBeNull();
    expect(offerFrom({ billing: { enabled: true, officerMonthlyUsd: 100, allianceMonthlyUsd: '10' } }).allianceMonthlyUsd).toBeNull();
    expect(offerFrom({ billing: { enabled: false, officerMonthlyUsd: 100, allianceMonthlyUsd: 10 } }).allianceMonthlyUsd).toBeNull();
  });
});

describe('offerFrom, with contract tiers.md', () => {
  it('reads officerMonthlyUsd first: with the alias beside it, and after the alias has gone', () => {
    expect(offerFrom({ billing: { enabled: true, officerMonthlyUsd: 100, memberMonthlyUsd: 100, leadMonthlyUsd: 200 } })).toEqual({ open: true, allianceMonthlyUsd: null });
    expect(offerFrom({ billing: { enabled: true, officerMonthlyUsd: 100, leadMonthlyUsd: 200 } })).toEqual({ open: true, allianceMonthlyUsd: null });
    expect(offerFrom({ billing: { enabled: true, officerMonthlyUsd: 100, allianceMonthlyUsd: 5 } })).toEqual({ open: true, allianceMonthlyUsd: 5 });
    expect(offerFrom({ billing: { enabled: false, officerMonthlyUsd: 100 } }).open).toBe(false);
    expect(offerFrom({ billing: { enabled: true, leadMonthlyUsd: 200 } }).open).toBe(false);
  });

  it('falls back to memberMonthlyUsd only where officerMonthlyUsd is absent, as before Platform renamed it', () => {
    expect(offerFrom({ billing: { enabled: true, memberMonthlyUsd: 100 } })).toEqual({ open: true, allianceMonthlyUsd: null });
    expect(offerFrom({ billing: { enabled: true, memberMonthlyUsd: 100, allianceMonthlyUsd: 10 } })).toEqual({ open: true, allianceMonthlyUsd: 10 });
    expect(offerFrom({ billing: { enabled: true, memberMonthlyUsd: 0 } }).open).toBe(false);
    // Present but unusable, the new name decides: the old one never covers it up.
    for (const bad of [0, -1, '100', null, Number.NaN]) {
      expect(offerFrom({ billing: { enabled: true, officerMonthlyUsd: bad, memberMonthlyUsd: 100 } }).open).toBe(false);
    }
  });
});

describe('formatUsd', () => {
  it('shows whole dollars bare and cents when there are some, as Platform does', () => {
    expect(formatUsd(10)).toBe('$10');
    expect(formatUsd(5)).toBe('$5');
    expect(formatUsd(7.5)).toBe('$7.50');
    expect(formatUsd(1200)).toBe('$1,200');
  });
});
