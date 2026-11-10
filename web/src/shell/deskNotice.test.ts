import { describe, expect, it } from 'vitest';
import type { Me } from '../platform/api';
import { membershipCard, noDeskNotice, type NoDeskInput } from './deskNotice';

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
