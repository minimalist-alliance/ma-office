import { describe, expect, it } from 'vitest';
import { backoffMs } from './backoff';
import { CallWindow, closeCodeAction, CONNECT_CALLS_PER_MINUTE, notReadyRetryMs, PongWatch, RECHECK_FIRST_ATTEMPT, membershipBack, refusalOf, sessionClosedAction, WAKE_FAST_FOR_MS, wakePollMs } from './policy';

describe('close codes (design 3.9, 4.2.7)', () => {
  it.each([
    [4401, 'reconnect'],
    [4403, 'deny'],
    [4409, 'replaced'],
    [4426, 'reload'],
    [4429, 'hold'],
    [4503, 'recheck'],
    [4000, 'reconnect'],
    [4001, 'reconnect'],
    [4002, 'recheck'],
  ])('%i: %s', (code, action) => {
    expect(closeCodeAction(code)).toBe(action);
  });
});

describe('session.closed reasons (gateway.md 2.3)', () => {
  it.each([
    ['desk_stopping', 'recheck'],
    ['closed_by_desk', 'recheck'],
    ['replaced', 'replaced'],
    ['token_expired', 'reconnect'],
    ['revoked', 'reconnect'],
    ['desk_disconnected', 'reconnect'],
    ['client_gone', 'reconnect'],
    ['identity_mismatch', 'reconnect'],
    ['something_new', 'reconnect'],
  ])('%s: %s', (reason, action) => {
    expect(sessionClosedAction(reason)).toBe(action);
  });
});

describe('retrying after deskd went away', () => {
  it('first tries at about 2 s, jitter included', () => {
    expect(backoffMs(RECHECK_FIRST_ATTEMPT, () => 0)).toBeCloseTo(1_600);
    expect(backoffMs(RECHECK_FIRST_ATTEMPT, () => 1)).toBeCloseTo(2_400);
  });
});

describe('waiting for a desk that is not ready', () => {
  it('grows from 3 s to a 10 s maximum', () => {
    expect([0, 1, 2, 3, 4, 50].map((checks) => notReadyRetryMs(checks, false))).toEqual([3_000, 4_500, 6_750, 10_000, 10_000, 10_000]);
  });

  it('stays at 3 s through a wake nobody here asked for', () => {
    expect([0, 1, 2, 3, 50].map((checks) => notReadyRetryMs(checks, true))).toEqual([3_000, 3_000, 3_000, 3_000, 3_000]);
  });
});

describe('the poll through a wake the member asked for (TD-227 part 3)', () => {
  it("is once a second, whatever connect's usual 3 s says, at every step of the wake", () => {
    for (const phase of ['starting', 'booting', 'connecting', null]) {
      expect(wakePollMs({ phase, paceMs: 3_000, wakeAgeMs: 0 })).toBe(1_000);
      expect(wakePollMs({ phase, paceMs: 0, wakeAgeMs: 30_000 })).toBe(1_000);
    }
  });

  it('keeps a queue for capacity, and any pace above the usual, as connect gives them', () => {
    expect(wakePollMs({ phase: 'queued', paceMs: 3_000, wakeAgeMs: 0 })).toBe(3_000);
    expect(wakePollMs({ phase: 'queued', paceMs: 0, wakeAgeMs: 0 })).toBe(3_000);
    expect(wakePollMs({ phase: 'starting', paceMs: 7_000, wakeAgeMs: 0 })).toBe(7_000);
  });

  it("goes back to connect's pace once the wake has run long", () => {
    expect(wakePollMs({ phase: 'starting', paceMs: 3_000, wakeAgeMs: WAKE_FAST_FOR_MS })).toBe(1_000);
    expect(wakePollMs({ phase: 'starting', paceMs: 3_000, wakeAgeMs: WAKE_FAST_FOR_MS + 1 })).toBe(3_000);
    expect(wakePollMs({ phase: 'starting', paceMs: 0, wakeAgeMs: WAKE_FAST_FOR_MS + 1 })).toBe(3_000);
  });
});

describe('the connect budget: inside the API limit of 30 a minute for a member', () => {
  it('has room for 24 in any minute, and the next waits until the oldest is a minute old', () => {
    expect(CONNECT_CALLS_PER_MINUTE).toBeLessThan(30);
    const w = new CallWindow(24, 60_000);
    for (let t = 0; t < 24_000; t += 1_000) {
      expect(w.waitMs(t)).toBe(0);
      w.note(t);
    }
    expect(w.waitMs(24_000)).toBe(36_000); // the first, at 0, leaves at 60 s
    expect(w.waitMs(59_999)).toBe(1);
    expect(w.waitMs(60_000)).toBe(0);
  });

  it('a poll that always waits for room never puts more than 24 in any minute', () => {
    const w = new CallWindow(24, 60_000);
    const at: number[] = [];
    let t = 0;
    while (t < 10 * 60_000) {
      t += 1_000;
      t += w.waitMs(t);
      w.note(t);
      at.push(t);
    }
    for (const start of at) expect(at.filter((x) => x >= start && x < start + 60_000).length).toBeLessThanOrEqual(24);
  });

  it('forgets what it counted when the clock goes back', () => {
    const w = new CallWindow(2, 60_000);
    w.note(100_000);
    w.note(100_500);
    expect(w.waitMs(100_600)).toBeGreaterThan(0);
    expect(w.waitMs(1_000)).toBe(0);
  });
});

describe('ctl liveness (design 4.2.7)', () => {
  it('stays up while pongs come back', () => {
    const w = new PongWatch();
    for (let i = 0; i < 10; i += 1) {
      expect(w.tick(false)).toBe(false);
      w.pong();
    }
  });

  it('goes down at the third missed pong', () => {
    const w = new PongWatch();
    expect(w.tick(false)).toBe(false); // the first PING goes out: nothing was owed yet
    expect(w.tick(false)).toBe(false); // miss 1
    expect(w.tick(false)).toBe(false); // miss 2
    expect(w.tick(false)).toBe(true); // miss 3
  });

  it('forgives misses when a pong arrives', () => {
    const w = new PongWatch();
    w.tick(false);
    w.tick(false);
    w.tick(false);
    w.pong();
    expect(w.anyMissed()).toBe(false);
    expect(w.tick(false)).toBe(false);
    expect(w.tick(false)).toBe(false);
    expect(w.tick(false)).toBe(false);
  });

  it('treats misses in a hidden tab as soft, and rechecks on focus', () => {
    const w = new PongWatch();
    for (let i = 0; i < 8; i += 1) expect(w.tick(true)).toBe(false);
    expect(w.anyMissed()).toBe(true);
    expect(w.isDown()).toBe(true); // what focus looks at after its grace period
    w.pong(); // the recheck's PING came back: it was only the throttled timers
    expect(w.isDown()).toBe(false);
  });
});

describe('refusalOf (contract 0.3.11)', () => {
  const OFFICE = 'office.minimalistalliance.com';
  it('the membership, with a billing link only on a sibling host over https', () => {
    expect(refusalOf('account_suspended', { billingUrl: 'https://platform.minimalistalliance.com/billing' }, OFFICE)).toEqual({ kind: 'suspended', billingUrl: 'https://platform.minimalistalliance.com/billing' });
    expect(refusalOf('account_inactive', { billingUrl: 'https://platform.minimalistalliance.com/billing' }, OFFICE)?.kind).toBe('inactive');
    for (const bad of ['http://platform.minimalistalliance.com/billing', 'https://office.minimalistalliance.com/x', 'https://evil.example/billing', 'javascript:alert(1)', '', null, 7]) {
      expect(refusalOf('account_suspended', { billingUrl: bad }, OFFICE)).toEqual({ kind: 'suspended', billingUrl: null });
    }
    expect(refusalOf('account_inactive', null, OFFICE)).toEqual({ kind: 'inactive', billingUrl: null });
  });

  it('desk_unavailable keeps nothing that came with it', () => {
    expect(refusalOf('desk_unavailable', { billingUrl: 'https://platform.minimalistalliance.com/billing', reason: 'x' }, OFFICE)).toEqual({ kind: 'unavailable', billingUrl: null });
  });

  it('anything else is not one of these', () => {
    for (const code of ['forbidden', 'membership_unpaid', 'invalid_state', null, undefined, '__proto__']) expect(refusalOf(code, {}, OFFICE)).toBeNull();
  });
});

describe('membershipBack: whether a membership refusal may ask connect again', () => {
  it.each([
    ['active', true],
    ['past_due', true],
    ['canceling', true],
    ['suspended', false],
    ['ended', false],
    ['unpaid', false],
    ['waitlisted', false],
    [undefined, false],
    [null, false],
    ['ACTIVE', false],
    [42, false],
  ])('%s: %s', (status, back) => {
    expect(membershipBack(status)).toBe(back);
  });
});

describe('refusalOf: data_guard (ma-platform ADR 0110)', () => {
  const OFFICE = 'office.minimalistalliance.com';
  it('keeps the platform\'s words and the billing day as given', () => {
    expect(refusalOf('data_guard', { resumesAt: '2026-11-17T07:00:00.000Z', contact: 'support' }, OFFICE, 'Your desks were stopped.')).toEqual({
      kind: 'data_guard', billingUrl: null, message: 'Your desks were stopped.', resumesAt: '2026-11-17T07:00:00.000Z',
    });
  });
  it('survives a missing message or a bad date', () => {
    expect(refusalOf('data_guard', { resumesAt: 'nope' }, OFFICE, '  ')).toEqual({ kind: 'data_guard', billingUrl: null, message: null, resumesAt: null });
    expect(refusalOf('data_guard', null, OFFICE)).toEqual({ kind: 'data_guard', billingUrl: null, message: null, resumesAt: null });
  });
});
