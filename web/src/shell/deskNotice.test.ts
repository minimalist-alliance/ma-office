import { describe, expect, it } from 'vitest';
import type { Me } from '../platform/api';
import { desksOpacity, desksStopped } from '../canvas/stoppedDim';
import { membershipCard, noDeskNotice, stopCard, type NoDeskInput } from './deskNotice';

const me = (status?: string): Me => ({ userId: 'u', membership: { status } });
const input = (p: Partial<NoDeskInput>): NoDeskInput => ({ list: 'empty', me: null, meFailed: false, ...p });
const teen = (status: string | undefined, parent: string | null): Me => ({ userId: 'u', membership: { status, ageBand: 'teen', adultFrom: '2029-08-01', parent } });

describe('noDeskNotice', () => {
  it('shows nothing until both the list and /v1/me have answered', () => {
    expect(noDeskNotice(input({ list: 'loading', me: me('unpaid') }))).toBeNull();
    expect(noDeskNotice(input({ list: 'loading', me: me('active') }))).toBeNull();
    expect(noDeskNotice(input({ list: 'empty', me: null }))).toBeNull();
  });

  it.each([
    ['unpaid', 'welcome'],
    ['waitlisted', 'waitlist'],
    ['suspended', 'inactive'],
    ['ended', 'inactive'],
    ['closed', 'inactive'],
  ])('%s from /v1/me is the %s card', (status, card) => {
    expect(noDeskNotice(input({ me: me(status) }))).toBe(card);
  });

  it.each(['active', 'canceling', 'past_due'])('%s from /v1/me is the on-its-way notice, never a card', (status) => {
    expect(noDeskNotice(input({ me: me(status) }))).toBe('empty');
    expect(noDeskNotice(input({ list: 'error', me: me(status) }))).toBe('error');
  });

  it('promises nothing when /v1/me failed or names no status', () => {
    expect(noDeskNotice(input({ meFailed: true }))).toBe('error');
    expect(noDeskNotice(input({ me: me(undefined) }))).toBeNull();
  });

  it('a list that failed is the error notice, unless the membership says why there are no desks', () => {
    expect(noDeskNotice(input({ list: 'error', me: me('active') }))).toBe('error');
    expect(noDeskNotice(input({ list: 'error', me: null }))).toBe('error');
    expect(noDeskNotice(input({ list: 'error', me: me('unpaid') }))).toBe('welcome');
  });
});

describe('membershipCard', () => {
  it('takes the proposal’s other names for never paid', () => {
    expect(membershipCard('none')).toBe('welcome');
    expect(membershipCard('pending')).toBe('welcome');
  });

  it('has no card for a member, or for a status it doesn’t know', () => {
    for (const s of ['active', 'canceling', 'past_due', 'something_new', undefined]) expect(membershipCard(s)).toBeNull();
  });

  it('a teen waiting on a parent has that card, whatever the list did', () => {
    expect(noDeskNotice(input({ me: teen('unpaid', 'pending') }))).toBe('parent');
    expect(noDeskNotice(input({ list: 'error', me: teen('unpaid', 'pending') }))).toBe('parent');
    expect(noDeskNotice(input({ me: teen(undefined, 'pending') }))).toBe('parent');
    expect(noDeskNotice(input({ me: teen('parent_pending', 'pending') }))).toBe('parent');
    expect(noDeskNotice(input({ list: 'loading', me: teen('unpaid', 'pending') }))).toBeNull();
  });

  it('a held or ended account keeps its own card, and the list stays first', () => {
    expect(noDeskNotice(input({ me: teen('suspended', 'pending') }))).toBe('inactive');
    expect(noDeskNotice(input({ me: teen('ended', 'pending') }))).toBe('inactive');
    expect(noDeskNotice(input({ me: teen('waitlisted', 'pending') }))).toBe('waitlist');
  });

  it('a teen with no parent step, or whose parent is done, is on the welcome card as anyone unpaid is', () => {
    expect(noDeskNotice(input({ me: teen('unpaid', null) }))).toBe('welcome');
    expect(noDeskNotice(input({ me: teen('unpaid', 'done') }))).toBe('welcome');
    expect(noDeskNotice(input({ me: teen('active', null) }))).toBe('empty');
  });

  it('parent means nothing without the band: only the server says who is a teen', () => {
    const adult: Me = { userId: 'u', membership: { status: 'unpaid', ageBand: 'adult', parent: 'pending' } };
    const none: Me = { userId: 'u', membership: { status: 'unpaid', parent: 'pending' } };
    expect(noDeskNotice(input({ me: adult }))).toBe('welcome');
    expect(noDeskNotice(input({ me: none }))).toBe('welcome');
  });
});

describe('cards C, D and E from /v1/me (ma-platform contract desks.md 0.3.69)', () => {
  const NOW = Date.parse('2026-11-20T12:00:00Z');
  const AHEAD = '2026-12-06T07:00:00Z';
  const PAST = '2026-11-01T07:00:00Z';
  const STOPPED = '2026-11-06T07:00:00Z';
  const stopped = (status: string, stoppedBy: string | null, dataDeleteAt: string | null, stoppedAt: string | null = STOPPED): Me => ({
    userId: 'u',
    membership: { status, stoppedBy, stoppedAt, dataDeleteAt },
  });
  const notice = (m: Me) => noDeskNotice(input({ me: m, now: NOW }));

  it('paused (C): suspended for a payment, with a readable stop and the deletion date ahead', () => {
    expect(notice(stopped('suspended', 'payment', AHEAD))).toBe('paused');
    expect(notice(stopped('suspended', 'payment', PAST))).toBe('inactive');
    expect(notice(stopped('suspended', 'payment', AHEAD, null))).toBe('inactive');
    expect(notice(stopped('suspended', 'payment', AHEAD, 'last week'))).toBe('inactive');
  });

  it('kept until a date (D) while it is ahead, then welcome back (E)', () => {
    expect(notice(stopped('ended', 'member', AHEAD))).toBe('kept');
    expect(notice(stopped('ended', 'member', PAST))).toBe('welcomeBack');
    expect(notice(stopped('ended', 'member', AHEAD, null))).toBe('kept'); // D and E show no stop date
  });

  it('a safety suspension, a hold, or anything we did is other, and other is always F', () => {
    for (const status of ['suspended', 'ended', 'closed']) {
      expect(notice(stopped(status, 'other', null, null))).toBe('inactive');
      expect(notice(stopped(status, 'other', AHEAD))).toBe('inactive'); // even if a date came with it
    }
  });

  it('F for anything it can’t read plainly: no fields (an older Platform), an unknown reason, the wrong pairing, a bad date', () => {
    expect(notice(me('suspended'))).toBe('inactive');
    expect(notice(me('ended'))).toBe('inactive');
    expect(notice(stopped('suspended', 'something_new', AHEAD))).toBe('inactive');
    expect(notice(stopped('ended', 'payment', AHEAD))).toBe('inactive'); // ended after a failed payment: no offer
    expect(notice(stopped('suspended', 'member', AHEAD))).toBe('inactive');
    expect(notice(stopped('closed', 'member', AHEAD))).toBe('inactive');
    expect(notice(stopped('ended', 'member', 'soon'))).toBe('inactive');
    expect(notice(stopped('ended', 'member', null))).toBe('inactive');
  });

  it('never for a member, whatever the fields say', () => {
    for (const status of ['unpaid', 'waitlisted', 'active', 'past_due', 'canceling']) {
      expect(stopCard(stopped(status, 'payment', AHEAD).membership, NOW)).toBeNull();
      expect(stopCard(stopped(status, 'member', AHEAD).membership, NOW)).toBeNull();
    }
    expect(notice(stopped('unpaid', 'payment', AHEAD))).toBe('welcome');
    expect(notice(stopped('active', 'member', PAST))).toBe('empty');
  });

  it('nothing until the list has answered, as for every card', () => {
    expect(noDeskNotice(input({ list: 'loading', me: stopped('ended', 'member', AHEAD), now: NOW }))).toBeNull();
    expect(noDeskNotice(input({ list: 'error', me: stopped('ended', 'member', AHEAD), now: NOW }))).toBe('kept');
  });

  it('a teen whose parent hasn’t agreed keeps their stop card, as a held or ended account does', () => {
    const t: Me = { userId: 'u', membership: { status: 'ended', stoppedBy: 'member', stoppedAt: STOPPED, dataDeleteAt: AHEAD, ageBand: 'teen', parent: 'pending' } };
    expect(notice(t)).toBe('kept');
  });
});

describe('C and D over a member’s stopped desks (S-82)', () => {
  const NOW = Date.parse('2026-11-20T12:00:00Z');
  const AHEAD = '2026-12-06T07:00:00Z';
  const PAST = '2026-11-01T07:00:00Z';
  const STOPPED = '2026-11-06T07:00:00Z';
  const stopped = (status: string, stoppedBy: string | null, dataDeleteAt: string | null): Me => ({
    userId: 'u',
    membership: { status, stoppedBy, stoppedAt: STOPPED, dataDeleteAt },
  });
  const over = (m: Me | null, list: NoDeskInput['list'] = 'ready') => noDeskNotice({ list, me: m, meFailed: false, hasDesks: true, now: NOW });

  it('C for a payment suspension and D for a member’s own end, with desks listed', () => {
    expect(over(stopped('suspended', 'payment', AHEAD))).toBe('paused');
    expect(over(stopped('ended', 'member', AHEAD))).toBe('kept');
  });

  it('E, F and the rest stay off the desks', () => {
    expect(over(stopped('ended', 'member', PAST))).toBeNull(); // E
    expect(over(stopped('suspended', 'payment', PAST))).toBeNull();
    expect(over(stopped('suspended', 'other', AHEAD))).toBeNull(); // F
    expect(over(stopped('suspended', null, null))).toBeNull();
    expect(over(stopped('closed', 'member', AHEAD))).toBeNull();
  });

  it('an active member, an unknown one, and a failed me see nothing', () => {
    expect(over(stopped('active', 'payment', AHEAD))).toBeNull();
    expect(over({ userId: 'u', membership: { status: 'canceling' } })).toBeNull();
    expect(over(null)).toBeNull();
    expect(noDeskNotice({ list: 'ready', me: null, meFailed: true, hasDesks: true, now: NOW })).toBeNull();
  });

  it('waits for the list, and a stale list still shows the card', () => {
    expect(over(stopped('ended', 'member', AHEAD), 'loading')).toBeNull();
    expect(over(stopped('ended', 'member', AHEAD), 'error')).toBe('kept');
  });

  it('without desks it is as before', () => {
    expect(noDeskNotice({ list: 'empty', me: stopped('ended', 'member', AHEAD), meFailed: false, now: NOW })).toBe('kept');
    expect(noDeskNotice({ list: 'empty', me: stopped('ended', 'member', PAST), meFailed: false, now: NOW })).toBe('welcomeBack');
  });
});

describe('desksStopped (S-82)', () => {
  const stopped = (membership: Me['membership']): boolean =>
    desksStopped({ list: 'ready', me: { userId: 'u', membership }, meFailed: false, hasDesks: true, now: Date.parse('2026-11-11T00:00:00Z') });
  const later = '2026-12-01T00:00:00Z';
  it('is true behind C and D only', () => {
    expect(stopped({ status: 'suspended', stoppedBy: 'payment', stoppedAt: '2026-11-01T00:00:00Z', dataDeleteAt: later })).toBe(true);
    expect(stopped({ status: 'ended', stoppedBy: 'member', dataDeleteAt: later })).toBe(true);
  });
  it('is false for an active member, E, F and A', () => {
    expect(stopped({ status: 'active' })).toBe(false);
    expect(stopped({ status: 'ended', stoppedBy: 'member', dataDeleteAt: '2026-11-02T00:00:00Z' })).toBe(false);
    expect(stopped({ status: 'suspended', stoppedBy: 'other', dataDeleteAt: later })).toBe(false);
    expect(stopped({ status: 'unpaid' })).toBe(false);
  });
  it('is false while no desk is listed, and the group opacity is 0.35 or 1', () => {
    expect(desksStopped({ list: 'empty', me: { userId: 'u', membership: { status: 'ended', stoppedBy: 'member', dataDeleteAt: later } }, meFailed: false, hasDesks: false })).toBe(false);
    expect(desksOpacity(true)).toBe(0.35);
    expect(desksOpacity(false)).toBe(1);
  });
});
