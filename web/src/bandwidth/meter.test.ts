import { afterEach, describe, expect, it } from 'vitest';
import { setCurrentBand } from '../platform/age';
import { circleLabel, formatBytes, formatReset, headsUp, parseMeter, pausedCopy, ringShare, ringWindow, stateLine, type BandwidthMeter } from './meter';

const GB = 1e9;
// Friday 6 Nov 2026, noon UTC. The week resets Monday 9 Nov 00:00 UTC, which is Sunday 5 pm in Denver.
const NOW = Date.parse('2026-11-06T12:00:00Z');
const c = { now: NOW, locale: 'en-US', timeZone: 'America/Denver' };

function meter(weekBytes: number, over: Partial<BandwidthMeter> & { monthBytes?: number } = {}): BandwidthMeter {
  const { monthBytes = weekBytes, ...rest } = over;
  const raw = {
    tier: 'officer',
    week: { usedBytes: weekBytes, usedGb: weekBytes / GB, limitGb: 30, startsAt: '2026-11-02T00:00:00.000Z', resetsAt: '2026-11-09T00:00:00.000Z' },
    month: { usedBytes: monthBytes, usedGb: monthBytes / GB, limitGb: 100, startsAt: '2026-11-01T00:00:00.000Z', resetsAt: '2026-12-01T00:00:00.000Z' },
    state: 'ok',
    limitedBy: null,
    warnAtPct: 80,
    enforced: true,
    paused: false,
    resumesAt: null,
    asOf: '2026-11-06T11:59:00.000Z',
    pollAfterSeconds: 60,
    ...rest,
  };
  return parseMeter(raw)!;
}

describe('parseMeter', () => {
  it('takes what Platform sends and refuses what it isn\'t', () => {
    const m = meter(12.34 * GB);
    expect(m.week.limitGb).toBe(30);
    expect(m.state).toBe('ok');
    expect(parseMeter(null)).toBeNull();
    expect(parseMeter({ week: {} })).toBeNull();
    expect(parseMeter({ ...m, month: { ...m.month, resetsAt: 'soon' } })).toBeNull();
  });

  it('reads an unknown state from the numbers, so a new word can\'t hide a limit', () => {
    expect(parseMeter({ ...meter(31 * GB), state: 'brand-new' })!.state).toBe('limit');
    expect(parseMeter({ ...meter(25 * GB), state: undefined })!.state).toBe('warn');
  });

  it('keeps a poll sensible', () => {
    expect(parseMeter({ ...meter(0), pollAfterSeconds: 0 })!.pollAfterSeconds).toBe(60);
    expect(parseMeter({ ...meter(0), pollAfterSeconds: 100_000 })!.pollAfterSeconds).toBe(600);
  });
});

describe('the ring', () => {
  it('shows the week, unless the month is nearer its limit', () => {
    expect(ringWindow(meter(15 * GB, { monthBytes: 20 * GB }))).toBe('week');
    expect(ringShare(meter(15 * GB, { monthBytes: 20 * GB }))).toBeCloseTo(0.5);
    expect(ringWindow(meter(3 * GB, { monthBytes: 90 * GB }))).toBe('month');
    expect(ringShare(meter(3 * GB, { monthBytes: 90 * GB }))).toBeCloseTo(0.9);
  });

  it('is full at or past the limit, and empty at nothing', () => {
    expect(ringShare(meter(45 * GB, { state: 'limit', limitedBy: 'week' }))).toBe(1);
    expect(ringShare(meter(0))).toBe(0);
  });
});

describe('the words', () => {
  it('shows the real number: MB under a GB, a decimal under 100 GB', () => {
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(4_560_000)).toBe('4.6 MB');
    expect(formatBytes(340_000_000)).toBe('340 MB');
    expect(formatBytes(12_349_000_000)).toBe('12.3 GB');
    expect(formatBytes(29_999_000_000)).toBe('29.9 GB'); // never rounds up to the limit
    expect(formatBytes(150_700_000_000)).toBe('150 GB');
  });

  it('says when the week resets in the member\'s own time, and a far reset by its date', () => {
    expect(formatReset('2026-11-09T00:00:00.000Z', c)).toBe('Sun 5:00 PM');
    expect(formatReset('2026-12-01T00:00:00.000Z', c)).toBe('Nov 30 5:00 PM');
    expect(formatReset('2026-12-01T00:00:00.000Z', { ...c, timeZone: 'UTC' })).toBe('Dec 1');
  });

  it('puts the numbers in the circle\'s name, for a screen reader', () => {
    expect(circleLabel(meter(12.34 * GB), c)).toBe('Bandwidth: 12.3 GB of 30 GB used this week. Resets Sun 5:00 PM.');
    const paused = meter(30.2 * GB, { state: 'limit', limitedBy: 'week', paused: true, resumesAt: '2026-11-09T00:00:00.000Z' });
    expect(circleLabel(paused, c)).toBe('Bandwidth: 30.2 GB of 30 GB used this week. Browser paused until Sun 5:00 PM.');
    const notEnforced = meter(30.2 * GB, { state: 'limit', limitedBy: 'week', enforced: false, resumesAt: '2026-11-09T00:00:00.000Z' });
    expect(circleLabel(notEnforced, c)).toBe('Bandwidth: 30.2 GB of 30 GB used this week. Limit reached.');
  });

  it('a calm line for each state, and none when all is well', () => {
    expect(stateLine(meter(5 * GB), c)).toBeNull();
    expect(stateLine(meter(24.5 * GB, { state: 'warn' }), c)).toBe("You've used 81% of this week's bandwidth. At the limit, the Browser pauses until the week resets. Notebook and Agent keep working.");
    expect(stateLine(meter(24.5 * GB, { state: 'warn', enforced: false }), c)).toBe("You've used 81% of this week's bandwidth.");
    expect(stateLine(meter(31 * GB, { state: 'limit', limitedBy: 'week', paused: true, resumesAt: '2026-11-09T00:00:00.000Z' }), c)).toBe(
      'The Browser is paused until Sun 5:00 PM. Notebook and Agent keep working.',
    );
    expect(stateLine(meter(31 * GB, { state: 'limit', limitedBy: 'week', enforced: false }), c)).toBe("You're past this week's limit.");
  });

  it('a heads-up once per week at the warning line, and once per pause', () => {
    expect(headsUp(meter(5 * GB), c)).toBeNull();
    expect(headsUp(meter(24.5 * GB, { state: 'warn' }), c)).toEqual({ key: 'warn:2026-11-02T00:00:00.000Z', text: "You've used 81% of this week's bandwidth: 24.5 GB of 30 GB." });
    const paused = headsUp(meter(31 * GB, { state: 'limit', limitedBy: 'week', paused: true, resumesAt: '2026-11-09T00:00:00.000Z' }), c)!;
    expect(paused.key).toBe('paused:2026-11-09T00:00:00.000Z');
    expect(paused.text).toBe('Bandwidth limit reached. The Browser is paused until Sun 5:00 PM. Notebook and Agent keep working.');
  });

  it('what a paused Browser says, for the week and for the month', () => {
    const week = pausedCopy(meter(31 * GB, { state: 'limit', limitedBy: 'week', paused: true, resumesAt: '2026-11-09T00:00:00.000Z' }), 'Browser', c);
    expect(week).toEqual({ title: 'Browser is paused until Sun 5:00 PM', body: "You've used this week's 30 GB of bandwidth. Notebook and Agent keep working, and your tabs are safe." });
    const month = pausedCopy(meter(10 * GB, { monthBytes: 100 * GB, state: 'limit', limitedBy: 'month', paused: true, resumesAt: '2026-12-01T00:00:00.000Z' }), 'Browser', c);
    expect(month.title).toBe('Browser is paused until Nov 30 5:00 PM');
    expect(month.body).toContain("this month's 100 GB");
  });
});

describe("a desk's own pause (deskd's bandwidth_limit)", () => {
  it("says the desk's time, not the meter's, and the numbers only while the meter is at its limit too", () => {
    const atLimit = meter(3 * GB, { state: 'limit', limitedBy: 'week', paused: true, resumesAt: '2026-11-06T11:55:00.000Z' });
    // The meter's reset has passed by this clock; the desk's hasn't. The desk's time is what's said.
    expect(pausedCopy(atLimit, 'Browser', c, '2026-11-06T12:04:00.000Z')).toEqual({
      title: 'Browser is paused until Fri 5:04 AM',
      body: "You've used this week's 30 GB of bandwidth. Notebook and Agent keep working, and your tabs are safe.",
    });
    // No meter, or one that isn't at its limit: no numbers, and nothing that isn't so.
    expect(pausedCopy(null, 'Browser', c, '2026-11-09T07:00:00.000Z')).toEqual({
      title: 'Browser is paused until Mon 12:00 AM',
      body: "You've reached your bandwidth limit. Notebook and Agent keep working, and your tabs are safe.",
    });
    expect(pausedCopy(meter(5 * GB), 'Browser', c, null)).toEqual({
      title: 'Browser is paused until your bandwidth resets',
      body: "You've reached your bandwidth limit. Notebook and Agent keep working, and your tabs are safe.",
    });
  });
});

describe("the week's reset in the member's own zone (finding 1, the client half)", () => {
  // Contract bandwidth.md has no zone yet, so Platform's week is Monday 00:00 UTC, which a Denver member reads as Sunday.
  // Whatever Platform sends, it's shown in the member's own time: a week moved to their own Monday needs nothing here.
  it("today's UTC week reads as Sunday evening in Denver; a week on Denver's Monday reads as Mon 12:00 AM", () => {
    expect(circleLabel(meter(12 * GB), c)).toBe('Bandwidth: 12 GB of 30 GB used this week. Resets Sun 5:00 PM.');
    const local = parseMeter({ ...meter(12 * GB), week: { ...meter(12 * GB).week, startsAt: '2026-11-02T07:00:00.000Z', resetsAt: '2026-11-09T07:00:00.000Z' } })!;
    expect(circleLabel(local, c)).toBe('Bandwidth: 12 GB of 30 GB used this week. Resets Mon 12:00 AM.');
  });
});

describe('the words for a teen', () => {
  afterEach(() => setCurrentBand(null));
  const paused = meter(30 * GB, { state: 'limit', limitedBy: 'week', paused: true, resumesAt: '2026-11-09T00:00:00.000Z' });
  const warned = meter(25 * GB, { state: 'warn' });

  it('never names the Agent, everywhere it would say what keeps working', () => {
    setCurrentBand('teen');
    const said = [stateLine(paused, c), stateLine(warned, c), headsUp(paused, c)?.text, pausedCopy(paused, 'Browser', c).body];
    for (const line of said) {
      expect(line).toContain('Notebook keeps working');
      expect(line).not.toContain('Agent');
    }
    expect(pausedCopy(paused, 'Browser', c).body).toBe("You've used this week's 30 GB of bandwidth. Notebook keeps working, and your tabs are safe.");
  });

  it('everyone else hears Notebook and Agent', () => {
    for (const band of [null, 'adult'] as const) {
      setCurrentBand(band);
      expect(pausedCopy(paused, 'Browser', c).body).toContain('Notebook and Agent keep working');
    }
  });
});

describe('only apps the member has', () => {
  afterEach(() => setCurrentBand(null));
  const paused = meter(30 * GB, { state: 'limit', limitedBy: 'week', paused: true, resumesAt: '2026-11-09T00:00:00.000Z' });
  const warned = meter(25 * GB, { state: 'warn' });

  it("never names Chat, which isn't built, for any age", () => {
    for (const band of [null, 'adult', 'teen'] as const) {
      setCurrentBand(band);
      for (const line of [stateLine(paused, c), stateLine(warned, c), headsUp(paused, c)?.text, pausedCopy(paused, 'Browser', c).body]) expect(line).not.toContain('Chat');
    }
  });
});

describe('the data guard on the meter (ma-platform ADR 0110)', () => {
  const guard = { message: 'Your desks were stopped because the data they sent this month went well past what your plan includes.', since: '2026-11-09T23:10:00.000Z', resumesAt: '2026-11-18T03:00:00.000Z' };
  it('reads dataGuard, and null when it is absent or malformed', () => {
    expect(meter(1 * GB).dataGuard).toBeNull();
    expect(meter(1 * GB, { dataGuard: guard } as never).dataGuard).toEqual(guard);
    expect(meter(1 * GB, { dataGuard: { message: '' } } as never).dataGuard).toBeNull();
    expect(meter(1 * GB, { dataGuard: 'x' } as never).dataGuard).toBeNull();
  });
  it('names it in the circle\'s accessible name and the heads-up (the message as given), once per flag', () => {
    const m = meter(1 * GB, { dataGuard: guard } as never);
    expect(circleLabel(m, c)).toContain('Desks stopped: data use past your plan.');
    const h = headsUp(m, c)!;
    expect(h.key).toBe(`guard:${guard.since}`);
    expect(h.text).toBe(guard.message);
  });
  it('never says a dollar figure or "absorbed"', () => {
    const m = meter(1 * GB, { dataGuard: guard } as never);
    expect([circleLabel(m, c), headsUp(m, c)!.text].join(' ')).not.toMatch(/\$\s?\d|absorbed/i);
  });
});
