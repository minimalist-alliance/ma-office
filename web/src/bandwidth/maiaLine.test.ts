import { describe, expect, it } from 'vitest';
import type { MaiaState } from '../maia/gate';
import { readState } from '../maia/gate';
import { maiaLine } from './maiaLine';

const c = { now: Date.parse('2026-11-09T12:00:00Z'), locale: 'en-US', timeZone: 'America/Denver' };
const st = (o: Record<string, unknown>): MaiaState => readState({ enabled: true, usedFraction: 0.02, ...o })!;

describe('maiaLine', () => {
  it('says the share, rounded down', () => {
    expect(maiaLine(st({ usedFraction: 0.02 }), c)).toBe("Maia: 2% of this month's allowance used");
    expect(maiaLine(st({ usedFraction: 0.379 }), c)).toBe("Maia: 37% of this month's allowance used");
    expect(maiaLine(st({ usedFraction: 0.29 }), c)).toBe("Maia: 29% of this month's allowance used");
    expect(maiaLine(st({ usedFraction: 0.999 }), c)).toBe("Maia: 99% of this month's allowance used");
  });
  it('says under 1% and none', () => {
    expect(maiaLine(st({ usedFraction: 0.004 }), c)).toBe("Maia: under 1% of this month's allowance used");
    expect(maiaLine(st({ usedFraction: 0 }), c)).toBe("Maia: none of this month's allowance used yet");
  });
  it('limited with free Maia keeps answering', () => {
    expect(maiaLine(st({ limited: 'personal', usedFraction: 1, free: { enabled: true, active: true, until: '2026-12-01T07:00:00Z' } }), c)).toBe(
      "Maia: this month's allowance is used. She keeps answering on free Maia.",
    );
  });
  it('limited without free Maia says when it resets, in the member time', () => {
    expect(maiaLine(st({ limited: 'personal', usedFraction: 1, resetsAt: '2026-12-01T07:00:00Z' }), c)).toBe(
      "Maia: this month's allowance is used. It resets Dec 1.",
    );
    expect(maiaLine(st({ limited: 'pool', usedFraction: 1, free: { enabled: true, active: false, until: null }, resetsAt: '2026-12-01T07:00:00Z' }), c)).toContain('It resets');
  });
  it('shows nothing when she is not open to the member', () => {
    expect(maiaLine(null, c)).toBeNull();
    expect(maiaLine(st({ enabled: false }), c)).toBeNull();
    expect(maiaLine(readState({ enabled: false }), c)).toBeNull();
    expect(maiaLine(readState({ enabled: true }), c)).toBeNull();
  });
});
