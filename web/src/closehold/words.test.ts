import { describe, expect, it } from 'vitest';
import { bodyOf, closeHoldOf, dayOf, DISMISS_PATH, saidOf, withoutCloseHold, WORDS } from './words';

const AT = '2026-11-14T09:30:00.000Z';
const REQUESTED = '2026-11-12T10:00:00.000Z';
const KIND = 'close_hold_cancelled';

describe('closeHoldOf', () => {
  it('reads the notice of its kind', () => {
    expect(closeHoldOf({ notices: [{ kind: KIND, at: AT, requestedAt: REQUESTED }] })).toEqual({ at: AT, requestedAt: REQUESTED });
  });

  it('takes a missing or bad requestedAt as none', () => {
    expect(closeHoldOf({ notices: [{ kind: KIND, at: AT, requestedAt: null }] })).toEqual({ at: AT, requestedAt: null });
    expect(closeHoldOf({ notices: [{ kind: KIND, at: AT }] })).toEqual({ at: AT, requestedAt: null });
    expect(closeHoldOf({ notices: [{ kind: KIND, at: AT, requestedAt: 'last week' }] })).toEqual({ at: AT, requestedAt: null });
  });

  it('is none for no notices, another kind, or an at that is not a time', () => {
    expect(closeHoldOf(null)).toBeNull();
    expect(closeHoldOf({})).toBeNull();
    expect(closeHoldOf({ notices: [] })).toBeNull();
    expect(closeHoldOf({ notices: 'close_hold_cancelled' as never })).toBeNull();
    expect(closeHoldOf({ notices: { kind: KIND, at: AT } as never })).toBeNull();
    expect(closeHoldOf({ notices: [null, { kind: 'something_new', at: AT }] })).toBeNull();
    expect(closeHoldOf({ notices: [{ kind: KIND, at: 'yesterday' }] })).toBeNull();
    expect(closeHoldOf({ notices: [{ kind: KIND, at: 1731576600000 }] })).toBeNull();
    expect(closeHoldOf({ notices: [{ kind: KIND }] })).toBeNull();
  });

  it('skips a bad one for a good one of the same kind', () => {
    expect(closeHoldOf({ notices: [{ kind: 'something_new', at: AT }, { kind: KIND, at: 'soon' }, { kind: KIND, at: AT }] })?.at).toBe(AT);
  });
});

describe('the words', () => {
  it('says the day in UTC, as the account page and the mail do', () => {
    expect(dayOf(REQUESTED)).toBe('November 12, 2026');
    expect(dayOf('2026-11-12T23:30:00-05:00')).toBe('November 13, 2026');
    expect(dayOf('2026-12-01T00:10:00+02:00')).toBe('November 30, 2026');
  });

  it('with the request day', () => {
    expect(bodyOf({ at: AT, requestedAt: REQUESTED })).toBe(
      "On November 12, 2026, someone writing from this account's email address asked us to close it. Your account was used on November 14, 2026, so the account stays open and nothing was deleted.",
    );
  });

  it('without it', () => {
    expect(bodyOf({ at: AT, requestedAt: null })).toBe(
      "Someone writing from this account's email address asked us to close it. Your account was used on November 14, 2026, so the account stays open and nothing was deleted.",
    );
  });

  it('the rest, exactly, and no passkey line', () => {
    expect(WORDS.title).toBe('We stopped a request to close your account');
    expect(WORDS.notYou).toBe("If that wasn't you, someone may be able to read your email. Change your email password.");
    expect(WORDS.dismiss).toBe('Got it');
    expect(WORDS.failed).toBe("That didn't save. Try again.");
    const all = Object.values(WORDS).filter((w) => typeof w === 'string').join(' ') + bodyOf({ at: AT, requestedAt: REQUESTED });
    expect(all).not.toMatch(/passkey|!|@/i);
  });

  it('the live region says the title and the body', () => {
    expect(saidOf({ at: AT, requestedAt: null })).toBe(`We stopped a request to close your account. ${bodyOf({ at: AT, requestedAt: null })}`);
  });
});

describe('the dismiss', () => {
  it('posts to the kind\'s route', () => {
    expect(DISMISS_PATH).toBe('/v1/me/notices/close_hold_cancelled/dismiss');
  });

  it('leaves /v1/me without that notice, and the others as they were', () => {
    const me = { userId: 'u-1', notices: [{ kind: KIND, at: AT }, { kind: 'something_new', at: AT }] };
    expect(withoutCloseHold(me)).toEqual({ userId: 'u-1', notices: [{ kind: 'something_new', at: AT }] });
    expect(me.notices).toHaveLength(2);
    const older: { userId: string; notices?: [] } = { userId: 'u-1' };
    expect(withoutCloseHold(older)).toBe(older);
  });
});
