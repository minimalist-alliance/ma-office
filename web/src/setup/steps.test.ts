// The setup circle's rules (S-121): each tier's steps, progress, What's new's one item, the offer and what the circle holds.
import { describe, expect, it } from 'vitest';
import { DEFAULT_TIER_NAMES } from '../platform/tiers';
import { offerTitle } from './labels';
import { circleOf, fittingIds, offerFor, pickWhatsNew, progressOf, readItem, setupLabel, stepsFor, type StepContext, type WhatsNewItem } from './steps';
import { offerLines, STEP_WORDS } from './words';

const ctx = (over: Partial<StepContext>): StepContext => ({ tier: 'officer', teen: false, guildsOpen: true, filesOn: true, maiaTrial: true, ...over });
const T0 = Date.parse('2026-11-10T12:00:00Z');
const ok = (href: string): string | null => (href.startsWith('https://platform.') ? href : null);

describe('each tier’s steps (the draft’s table)', () => {
  it('lists them in order, at most seven', () => {
    expect(stepsFor(ctx({ tier: 'free' }))).toEqual(['browser', 'agent-key', 'files', 'maia-trial']);
    expect(stepsFor(ctx({ tier: 'alliance' }))).toEqual(['browser', 'agent-key', 'files', 'guild-join']);
    expect(stepsFor(ctx({ tier: 'officer' }))).toEqual(['work-desk', 'browser', 'agent-key', 'files', 'guild-join', 'name-desks']);
    expect(stepsFor(ctx({ tier: 'lead' }))).toEqual(['found-guild', 'invite', 'work-desk', 'browser', 'agent-key', 'files', 'name-desks']);
    for (const tier of ['free', 'alliance', 'officer', 'lead'] as const) expect(stepsFor(ctx({ tier })).length).toBeLessThanOrEqual(7);
  });
  it('a teen has no Agent step', () => {
    expect(stepsFor(ctx({ tier: 'free', teen: true }))).toEqual(['browser', 'files', 'maia-trial']);
    expect(stepsFor(ctx({ tier: 'alliance', teen: true }))).toEqual(['browser', 'files', 'guild-join']);
  });
  it('guild steps only while guilds are open, Files only while it’s on, Maia’s trial only where there is one', () => {
    expect(stepsFor(ctx({ tier: 'lead', guildsOpen: false }))).toEqual(['work-desk', 'browser', 'agent-key', 'files', 'name-desks']);
    expect(stepsFor(ctx({ tier: 'officer', filesOn: false }))).not.toContain('files');
    expect(stepsFor(ctx({ tier: 'free', maiaTrial: false }))).toEqual(['browser', 'agent-key', 'files']);
  });
  it('every step has a title, a line and a button, none over 20 words', () => {
    for (const [id, w] of Object.entries(STEP_WORDS)) {
      expect(w.title && w.line && w.button).toBeTruthy();
      // `agent-key`'s line is the free models spec's, verbatim, at 21 (agent-free-key §8, for Sales; STATUS asks which rule wins).
      expect(w.line.split(/\s+/).length).toBeLessThanOrEqual(id === 'agent-key' ? 21 : 20);
    }
  });
});

describe('progress', () => {
  it('done and skipped both fill a segment, and the rest are open in order', () => {
    const p = progressOf(['browser', 'agent-key', 'files', 'maia-trial'], { done: ['files'], skipped: ['browser'] });
    expect(p.settled).toBe(2);
    expect(p.open).toEqual(['agent-key', 'maia-trial']);
    expect(setupLabel(p)).toBe('Setup: 2 of 4 done');
  });
  it('a change of tier keeps every done id: new steps join, old ones leave the count', () => {
    const before = progressOf(stepsFor(ctx({ tier: 'alliance' })), { done: ['browser', 'files', 'guild-join'], skipped: ['agent-key'] });
    expect(before.open).toEqual([]);
    const after = progressOf(stepsFor(ctx({ tier: 'officer' })), { done: ['browser', 'files', 'guild-join'], skipped: ['agent-key'] });
    expect(after.open).toEqual(['work-desk', 'name-desks']);
    expect(setupLabel(after)).toBe('Setup: 4 of 6 done');
  });
});

const item = (over: Record<string, unknown> = {}): unknown => ({
  id: 'simple-1',
  title: 'A quieter Browser',
  line: 'Pages you read come through simpler.',
  action: { app: 'browser' },
  from: '2026-11-01T00:00:00Z',
  until: '2026-12-01T00:00:00Z',
  ...over,
});
const read = (over: Record<string, unknown> = {}): WhatsNewItem => readItem(item(over), ok)!;

describe('What’s new', () => {
  it('reads an item field by field, and drops one it can’t use', () => {
    expect(read()).toMatchObject({ id: 'simple-1', action: { app: 'browser' }, tiers: null, ages: null });
    expect(readItem(item({ action: { href: 'https://platform.localhost/news' } }), ok)?.action).toEqual({ href: 'https://platform.localhost/news' });
    expect(readItem(item({ action: { href: 'https://evil.example/' } }), ok)).toBeNull();
    expect(readItem(item({ action: { app: 'claude' } }), ok)).toBeNull();
    expect(readItem(item({ title: '' }), ok)).toBeNull();
    expect(readItem(item({ title: 'x'.repeat(61) }), ok)).toBeNull();
    expect(readItem(item({ until: '2026-10-01T00:00:00Z' }), ok)).toBeNull();
    expect(readItem(item({ tiers: ['lead', 'pro'] }), ok)?.tiers).toEqual(['lead']);
    expect(readItem('nope', ok)).toBeNull();
  });
  it('shows only the newest that fits, and only if it isn’t seen: older ones are dropped, not queued', () => {
    const older = read({ id: 'a', from: '2026-11-02T00:00:00Z' });
    const newer = read({ id: 'b', from: '2026-11-05T00:00:00Z' });
    const who = { tier: 'officer' as const, band: null };
    expect(pickWhatsNew([older, newer], who, [], T0)?.id).toBe('b');
    expect(pickWhatsNew([older, newer], who, ['b'], T0)).toBeNull();
    expect(fittingIds([older, newer], who, T0)).toEqual(['a', 'b']);
  });
  it('fits the tier and the age band, and its dates', () => {
    const forLead = read({ tiers: ['lead'] });
    const adults = read({ ages: ['adult'] });
    expect(pickWhatsNew([forLead], { tier: 'officer', band: null }, [], T0)).toBeNull();
    expect(pickWhatsNew([adults], { tier: 'alliance', band: 'teen' }, [], T0)).toBeNull();
    expect(pickWhatsNew([adults], { tier: 'alliance', band: 'adult' }, [], T0)?.id).toBe('simple-1');
    expect(pickWhatsNew([read()], { tier: 'free', band: null }, [], Date.parse('2026-12-02T00:00:00Z'))).toBeNull();
  });
});

describe('the upgrade offer', () => {
  it('names the next tier up, and never {officer} or {lead} to a teen', () => {
    expect(offerFor('free', false, true)).toBe('alliance');
    expect(offerFor('free', true, true)).toBe('alliance');
    expect(offerFor('alliance', false, true)).toBe('officer');
    expect(offerFor('alliance', true, true)).toBeNull();
    expect(offerFor('officer', false, true)).toBe('lead');
    expect(offerFor('officer', false, false)).toBeNull();
    expect(offerFor('lead', false, true)).toBeNull();
  });
  it('its words name the tiers from the setting, and a figure Platform doesn’t send leaves its line out', () => {
    const names = { alliance: 'Ally', officer: 'Captain', lead: 'Chief' };
    expect(offerTitle('alliance', names)).toBe('More room with Ally');
    expect(offerTitle('officer', names)).toBe('Room for a Work desk');
    expect(offerTitle('lead', DEFAULT_TIER_NAMES)).toBe('Lead a guild of your own');
    expect(offerLines('alliance', names, { allianceDrive: '25 GB', officerWeekly: null })).toEqual(['No daily Browser limit', 'A 25 GB drive', 'Maia included']);
    expect(offerLines('alliance', names, { allianceDrive: null, officerWeekly: null })).toEqual(['No daily Browser limit', 'Maia included']);
    expect(offerLines('officer', names, { allianceDrive: null, officerWeekly: '30 GB' })).toEqual(['Captain adds a Work desk, private and walled off from this one.', '30 GB of bandwidth a week', 'Desks you can name']);
    expect(offerLines('officer', names, { allianceDrive: null, officerWeekly: null })).toEqual(['Captain adds a Work desk, private and walled off from this one.', 'Captain has more each week', 'Desks you can name']);
    expect(offerLines('lead', names, { allianceDrive: null, officerWeekly: null })).toEqual(['Chief includes a guild of your own, with a Guild Desk for its members.']);
  });
});

describe('what the circle holds', () => {
  const done = progressOf(['browser'], { done: ['browser'], skipped: [] });
  const open = progressOf(['browser'], { done: [], skipped: [] });
  const base = { hidden: false, progress: done, afterOn: true, whatsNew: null, offer: null, offerNotNowUntil: null, now: T0 };
  it('setup while any step is open', () => {
    expect(circleOf({ ...base, progress: open }).kind).toBe('setup');
  });
  it('after setup: What’s new, then the offer, or nothing at all', () => {
    expect(circleOf(base)).toEqual({ kind: 'none' });
    expect(circleOf({ ...base, offer: 'officer' })).toEqual({ kind: 'after', whatsNew: null, offer: 'officer' });
    expect(circleOf({ ...base, whatsNew: read() })).toMatchObject({ kind: 'after', offer: null });
  });
  it('Not now puts the card away for its 30 days, not the circle', () => {
    expect(circleOf({ ...base, offer: 'officer', offerNotNowUntil: T0 + 1 })).toEqual({ kind: 'none' });
    expect(circleOf({ ...base, offer: 'officer', whatsNew: read(), offerNotNowUntil: T0 + 1 })).toMatchObject({ kind: 'after', offer: null });
    expect(circleOf({ ...base, offer: 'officer', offerNotNowUntil: T0 - 1 }).kind).toBe('after');
  });
  it('hidden is the member’s word, in every state; the kill switch takes only the after-setup state', () => {
    expect(circleOf({ ...base, hidden: true, progress: open })).toEqual({ kind: 'none' });
    expect(circleOf({ ...base, hidden: true, offer: 'officer' })).toEqual({ kind: 'none' });
    expect(circleOf({ ...base, afterOn: false, offer: 'officer' })).toEqual({ kind: 'none' });
    expect(circleOf({ ...base, afterOn: false, progress: open }).kind).toBe('setup');
  });
});
