import { beforeEach, describe, expect, it } from 'vitest';
import type { BrowserMedia } from './deskLink';
import { HIDDEN_CLOSE_MS, IDLE_CHECK_MS, IdleRule, NO_INPUT_CLOSE_MS } from './idle';
import { SOUND_QUIET_MS } from './sound';

const MIN = 60_000;
const HOUR = 60 * MIN;

let clock: number;
let log: string[];
let desks: string[];
let rule: IdleRule;
/** When each desk's session last carried sound, on the test's clock, or null for no session. */
let heard: Record<string, number | null>;
const media = (id: string): BrowserMedia | null => {
  const at = heard[id];
  return at === undefined || at === null ? null : { stream: {} as MediaStream, canPlayVideo: true, silentFor: () => clock - at };
};

/** Passes time the way the interval does: a check each minute. */
const pass = (ms: number): void => {
  const end = clock + ms;
  while (clock < end) {
    clock = Math.min(end, clock + IDLE_CHECK_MS);
    rule.checkAll();
  }
};

beforeEach(() => {
  clock = 1_000_000;
  log = [];
  desks = ['a', 'b'];
  heard = {};
  rule = new IdleRule(
    {
      rest: (id) => log.push(`rest ${id}`),
      resume: (id) => log.push(`resume ${id}`),
      deskIds: () => desks,
      media,
    },
    () => clock,
  );
  rule.checkAll();
});

describe('the constants', () => {
  it('are 60 minutes and 24 hours', () => {
    expect(HIDDEN_CLOSE_MS).toBe(HOUR);
    expect(NO_INPUT_CLOSE_MS).toBe(24 * HOUR);
  });
});

describe('a hidden tab', () => {
  it('closes every desk at 60 minutes, and not before', () => {
    rule.setHidden(true);
    pass(59 * MIN);
    expect(log).toEqual([]);
    pass(MIN);
    expect(log).toEqual(['rest a', 'rest b']);
  });

  it('coming back before 60 minutes does nothing, and starts the count over', () => {
    rule.setHidden(true);
    pass(59 * MIN);
    rule.setHidden(false);
    rule.setHidden(true);
    pass(59 * MIN);
    expect(log).toEqual([]);
  });

  it('coming back after 60 minutes reopens at once', () => {
    rule.setHidden(true);
    pass(HOUR);
    log = [];
    rule.setHidden(false);
    expect(log).toEqual(['resume a', 'resume b']);
  });

  it('going by the clock: one late check still closes, as after a sleeping laptop', () => {
    rule.setHidden(true);
    clock += 5 * HOUR;
    rule.checkAll();
    expect(log).toEqual(['rest a', 'rest b']);
  });

  it('a second hidden event does not restart the count', () => {
    rule.setHidden(true);
    pass(40 * MIN);
    rule.setHidden(true);
    pass(20 * MIN);
    expect(log).toEqual(['rest a', 'rest b']);
  });
});

describe('a visible tab with no input', () => {
  it('closes at 24 hours, each desk on its own input', () => {
    pass(23 * HOUR);
    rule.noteInput('a');
    pass(HOUR);
    expect(log).toEqual(['rest b']);
    pass(23 * HOUR);
    expect(log.filter((l) => l === 'rest a').length).toBeGreaterThan(0);
  });

  it('input on a resting desk reopens that desk at once, and only that one', () => {
    pass(24 * HOUR);
    log = [];
    rule.noteInput('b');
    expect(log).toEqual(['resume b']);
  });

  it('input on an awake desk does nothing but note the time', () => {
    rule.noteInput('a');
    rule.noteInput('a');
    expect(log).toEqual([]);
  });

  it('being visible again is not input: a desk with none for 24 hours stays closed until there is some', () => {
    rule.noteInput('a');
    rule.setHidden(true);
    pass(25 * HOUR);
    log = [];
    rule.noteInput('a'); // hidden, so it can't really happen, but the rule holds either way
    expect(log).toEqual(['rest a']);
    log = [];
    clock += HOUR;
    rule.setHidden(false);
    expect(log).toContain('resume a');
    expect(log).toContain('rest b');
    expect(log).not.toContain('resume b');
  });
});

describe('resting', () => {
  it('rest is asked again on each check, so a link that came back on its own goes back to rest', () => {
    pass(24 * HOUR);
    const before = log.length;
    pass(MIN);
    expect(log.length).toBe(before + 2);
  });

  it('forget drops a desk that has left the list', () => {
    pass(24 * HOUR);
    desks = ['a'];
    rule.forget('b');
    log = [];
    rule.noteInput('b');
    expect(log).toEqual([]);
  });

  it('a new desk starts its count when first seen', () => {
    pass(23 * HOUR);
    desks = ['a', 'b', 'c'];
    pass(2 * HOUR);
    expect(log.filter((l) => l === 'rest c')).toEqual([]);
    expect(log.filter((l) => l === 'rest a').length).toBeGreaterThan(0);
  });
});

describe('sound in a hidden tab (task 22, ADR 0038)', () => {
  /** Desk `a` plays sound the whole time: each check finds it just heard. */
  const playing = (ms: number): void => {
    const end = clock + ms;
    while (clock < end) {
      clock = Math.min(end, clock + IDLE_CHECK_MS);
      heard['a'] = clock - 500;
      rule.checkAll();
    }
  };

  it('keeps a desk playing sound open past 60 minutes, and closes the quiet one as before', () => {
    rule.setHidden(true);
    playing(5 * HOUR);
    expect(new Set(log)).toEqual(new Set(['rest b'])); // asked again on each check
  });

  it('closes it within two checks of the sound stopping, as it is already past 60 minutes', () => {
    rule.setHidden(true);
    playing(2 * HOUR);
    log = [];
    pass(IDLE_CHECK_MS);
    expect(log).toEqual(['rest b']); // a minute and a half since it was heard: within the quiet time and a check's gap
    pass(IDLE_CHECK_MS);
    expect(log).toContain('rest a');
    expect(SOUND_QUIET_MS + IDLE_CHECK_MS).toBe(2 * IDLE_CHECK_MS);
  });

  it('sound before 60 minutes that has stopped counts from the hiding, as before', () => {
    rule.setHidden(true);
    playing(20 * MIN);
    pass(40 * MIN);
    expect(log).toEqual(['rest a', 'rest b']);
  });

  it('a session replaced between two checks is not taken for silence', () => {
    rule.setHidden(true);
    playing(2 * HOUR);
    heard['a'] = null; // between sessions
    pass(IDLE_CHECK_MS);
    heard['a'] = -Infinity; // a new session, nothing heard yet
    expect(log.filter((l) => l === 'rest a')).toEqual([]);
  });

  it('the 24-hour rule still closes it, sound or not', () => {
    rule.setHidden(true);
    playing(24 * HOUR);
    expect(log).toContain('rest a');
  });

  it('a target that cannot tell keeps the old rule', () => {
    const quiet: string[] = [];
    const r = new IdleRule({ rest: (id) => quiet.push(id), resume: () => {}, deskIds: () => ['a'] }, () => clock);
    r.setHidden(true);
    clock += HOUR;
    r.checkAll();
    expect(quiet).toEqual(['a']);
  });
});

describe('a running file transfer (the Files app)', () => {
  const busy = new Set<string>();
  const mk = (): void => {
    log = [];
    busy.clear();
    rule = new IdleRule({ rest: (id) => log.push(`rest ${id}`), resume: (id) => log.push(`resume ${id}`), deskIds: () => desks, media, busy: (id) => busy.has(id) }, () => clock);
    rule.checkAll();
  };

  it('keeps a hidden tab open past 60 minutes, and counts as input, so the 24 hours start over when it ends', () => {
    mk();
    busy.add('a');
    rule.setHidden(true);
    pass(5 * HOUR);
    expect(log).not.toContain('rest a');
    expect(log).toContain('rest b');
    busy.delete('a');
    rule.setHidden(true);
    pass(HOUR);
    expect(log).toContain('rest a');
  });

  it('a paused transfer is not busy: the rule applies as ever', () => {
    mk();
    rule.setHidden(true);
    pass(HOUR + 2 * MIN);
    expect(log).toContain('rest a');
    expect(log).toContain('rest b');
  });

  it('a desk that was resting comes back when a transfer starts', () => {
    mk();
    rule.setHidden(true);
    pass(HOUR + 2 * MIN);
    log = [];
    busy.add('a');
    rule.checkAll();
    expect(log).toContain('resume a');
  });
});
