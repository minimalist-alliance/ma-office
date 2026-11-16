import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Me } from './api';
import { ACCOUNT_CLOSED, exportUntilOf, forgetAccountClosed, heardAccountClosed, isAccountClosed, useAccountClosed, whenClosedHeard } from './accountClosed';

afterEach(() => {
  forgetAccountClosed();
  whenClosedHeard(() => {});
});

describe('heardAccountClosed (ma-platform contract moderation.md section 8)', () => {
  it('takes only account_closed, and asks /v1/me again once', () => {
    const again = vi.fn();
    whenClosedHeard(again);
    for (const code of [null, undefined, 'forbidden', 'account_inactive', 'account_suspended', 'session_revoked', 'desk_unavailable']) heardAccountClosed(code);
    expect(useAccountClosed.getState().heard).toBe(false);
    expect(again).not.toHaveBeenCalled();
    heardAccountClosed(ACCOUNT_CLOSED);
    heardAccountClosed('account_closed');
    expect(useAccountClosed.getState().heard).toBe(true);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('goes with the member: a sign-out or another account forgets it', () => {
    heardAccountClosed('account_closed');
    forgetAccountClosed();
    expect(useAccountClosed.getState().heard).toBe(false);
  });
});

describe('isAccountClosed', () => {
  const me = (membership: Me['membership']): Me => ({ userId: 'u', membership });
  it('from /v1/me’s membership.closed, or from an API that said so', () => {
    expect(isAccountClosed(me({ status: 'ended', stoppedBy: 'other', closed: true }), false)).toBe(true);
    expect(isAccountClosed(me({ status: 'active' }), true)).toBe(true);
    expect(isAccountClosed(null, true)).toBe(true);
  });
  it('never for an ended or suspended account that isn’t closed, whatever stopped it', () => {
    for (const stoppedBy of ['other', 'member', 'payment', null]) {
      expect(isAccountClosed(me({ status: 'ended', stoppedBy }), false)).toBe(false);
      expect(isAccountClosed(me({ status: 'suspended', stoppedBy }), false)).toBe(false);
    }
    expect(isAccountClosed(me({ status: 'ended', closed: false }), false)).toBe(false);
    expect(isAccountClosed(null, false)).toBe(false);
  });
});

describe('exportUntilOf', () => {
  it('the contract’s pair: a date with held false; null when held; neither sent is not said', () => {
    expect(exportUntilOf({ closed: true, exportUntil: '2026-12-12T18:04:00Z', held: false })).toBe('2026-12-12T18:04:00Z');
    expect(exportUntilOf({ closed: true, exportUntil: null, held: true })).toBeNull();
    expect(exportUntilOf({ closed: true })).toBeUndefined();
  });

  it('held wins over any date, and a date alone or a null alone still reads', () => {
    expect(exportUntilOf({ exportUntil: '2026-12-12T18:04:00Z', held: true })).toBeNull();
    expect(exportUntilOf({ exportUntil: '2026-12-12T18:04:00Z' })).toBe('2026-12-12T18:04:00Z');
    expect(exportUntilOf({ exportUntil: null })).toBeNull();
    expect(exportUntilOf({ held: false })).toBeUndefined();
    expect(exportUntilOf({})).toBeUndefined();
    expect(exportUntilOf({ exportUntil: 'in 30 days' })).toBeUndefined();
    expect(exportUntilOf(undefined)).toBeUndefined();
  });
});
