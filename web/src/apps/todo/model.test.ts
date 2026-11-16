// To-do's pure rules: the words a date says, the All view's groups, Done's days, snooze times in the desk's zone, the All desks
// merge in Needs you's order, and the wire reader's leniency.
import { describe, expect, it } from 'vitest';
import { dayWords, groupDone, groupOpen, makerName, mergeNeedsYou, snoozeChoices, timeWords, whenOf, zonedMs } from './model';
import type { TodoItem } from './types';
import { plain, readChanges, readItem, readList, readSummary } from './wire';
import { elseParts, elseWords, eventWords, footerParts, footerWords } from './words';

const TZ = 'America/Denver';
const TODAY = '2026-11-12'; // a Thursday
const NOW = Date.UTC(2026, 10, 12, 17, 0); // 10:00 in Denver

const item = (p: Partial<TodoItem>): TodoItem => ({
  id: p.id ?? 'x',
  rev: 1,
  title: 't',
  note: null,
  due: null,
  state: 'open',
  closed: null,
  snoozedUntil: null,
  pinned: false,
  by: 'member',
  source: { kind: 'member', ref: null, label: '' },
  alsoFrom: [],
  mergeCount: 0,
  untrusted: false,
  suggestion: null,
  seen: true,
  group: null,
  createdAt: 0,
  updatedAt: 0,
  trashedAt: null,
  ...p,
});

describe('what a date says', () => {
  it('overdue since a weekday, today with a time, due today, then a day in words; hot only for those and kept ones', () => {
    expect(whenOf(item({ due: { date: '2026-11-10', time: null, by: 'member' } }), TODAY, NOW, TZ)).toEqual({ text: 'Overdue · since Tue', hot: true, group: 'overdue' });
    expect(whenOf(item({ due: { date: '2026-10-01', time: null, by: 'member' } }), TODAY, NOW, TZ).text).toBe('Overdue · since Oct 1');
    expect(whenOf(item({ due: { date: TODAY, time: '15:00', by: 'member' } }), TODAY, NOW, TZ)).toEqual({ text: 'Today · 3:00 pm', hot: true, group: 'today' });
    expect(whenOf(item({ due: { date: TODAY, time: null, by: 'member' } }), TODAY, NOW, TZ).text).toBe('Due today');
    expect(whenOf(item({ due: { date: '2026-11-13', time: null, by: 'member' } }), TODAY, NOW, TZ)).toEqual({ text: 'Tomorrow', hot: false, group: 'later' });
    expect(whenOf(item({ due: { date: '2026-11-14', time: '09:30', by: 'member' } }), TODAY, NOW, TZ).text).toBe('Sat · 9:30 am');
    expect(whenOf(item({ due: { date: '2026-12-25', time: null, by: 'member' } }), TODAY, NOW, TZ).text).toBe('Dec 25');
    expect(whenOf(item({ due: { date: '2027-01-02', time: null, by: 'member' } }), TODAY, NOW, TZ).text).toBe('Jan 2, 2027');
    expect(whenOf(item({ pinned: true }), TODAY, NOW, TZ)).toEqual({ text: 'Kept here', hot: true, group: 'none' });
    expect(whenOf(item({}), TODAY, NOW, TZ)).toEqual({ text: '', hot: false, group: 'none' });
  });

  it('a snoozed one says until when, in the desk’s zone, and is never hot', () => {
    const w = whenOf(item({ snoozedUntil: zonedMs('2026-11-13', '09:00', TZ), due: { date: TODAY, time: null, by: 'member' } }), TODAY, NOW, TZ);
    expect(w).toEqual({ text: 'Snoozed until Tomorrow, 9:00 am', hot: false, group: 'snoozed' });
  });

  it('times and days in words', () => {
    expect(timeWords('00:05')).toBe('12:05 am');
    expect(timeWords('12:00')).toBe('12:00 pm');
    expect(dayWords('2026-11-11', TODAY)).toBe('Yesterday');
    expect(dayWords('2026-11-16', TODAY)).toBe('Mon');
  });
});

describe('the All view and Done', () => {
  it('groups by deskd’s group where it says one: Overdue, Today, a heading a day, No date (kept first), Snoozed folded', () => {
    const g = groupOpen(
      [
        item({ id: 'n', group: 'no_date', createdAt: 2 }),
        item({ id: 'k', group: 'no_date', pinned: true, createdAt: 1 }),
        item({ id: 'u2', group: 'upcoming', due: { date: '2026-11-20', time: null, by: 'member' } }),
        item({ id: 'u1', group: 'upcoming', due: { date: '2026-11-13', time: null, by: 'member' } }),
        item({ id: 'o', group: 'overdue', due: { date: '2026-11-02', time: null, by: 'member' } }),
        item({ id: 't', group: 'today', due: { date: TODAY, time: null, by: 'member' } }),
        item({ id: 's', group: 'snoozed', snoozedUntil: NOW + 1 }),
      ],
      TODAY,
      NOW,
      TZ,
    );
    expect(g.map((x) => [x.title, x.items.map((i) => i.id), !!x.folded])).toEqual([
      ['Overdue', ['o'], false],
      ['Today', ['t'], false],
      ['Tomorrow', ['u1'], false],
      ['Friday, November 20', ['u2'], false],
      ['No date', ['k', 'n'], false],
      ['Snoozed', ['s'], true],
    ]);
  });

  it('Done: a heading per day it closed on, newest first', () => {
    const g = groupDone([item({ id: 'a', closed: { at: NOW - 3 * 86400_000, by: 'member' } }), item({ id: 'b', closed: { at: NOW, by: 'member' } }), item({ id: 'c', closed: { at: NOW - 86400_000, by: 'agent:inbox' } })], TODAY, TZ);
    expect(g.map((x) => [x.title, x.items.map((i) => i.id)])).toEqual([
      ['Today', ['b']],
      ['Yesterday', ['c']],
      ['Monday, November 9', ['a']],
    ]);
  });
});

describe('snooze times, in the desk’s own zone', () => {
  it('a wall time is the right instant across a change of offset', () => {
    expect(zonedMs('2026-11-12', '09:00', TZ)).toBe(Date.UTC(2026, 10, 12, 16, 0)); // MST
    expect(zonedMs('2026-07-01', '09:00', TZ)).toBe(Date.UTC(2026, 6, 1, 15, 0)); // MDT
    expect(zonedMs('2026-11-12', '09:00', 'UTC')).toBe(Date.UTC(2026, 10, 12, 9, 0));
  });

  it('Later today (three hours on, on the hour), Tomorrow morning at 9, Next week on Monday at 9; none of later after 6 pm', () => {
    const c = snoozeChoices(NOW, TZ);
    expect(c.map((x) => x.label)).toEqual(['Later today, 1:00 pm', 'Tomorrow morning', 'Next week, Mon']);
    expect(c.map((x) => x.until)).toEqual([Date.UTC(2026, 10, 12, 20, 0), Date.UTC(2026, 10, 13, 16, 0), Date.UTC(2026, 10, 16, 16, 0)]);
    expect(snoozeChoices(Date.UTC(2026, 10, 13, 2, 0), TZ).map((x) => x.key)).toEqual(['tomorrow', 'week']);
  });
});

describe('All desks, put together in the browser', () => {
  it('one order across desks, each by its own today, the first five, the rest counted with each desk’s more', () => {
    const work = [item({ id: 'w-over', due: { date: '2026-11-10', time: null, by: 'member' } }), item({ id: 'w-15', due: { date: TODAY, time: '15:00', by: 'member' } })];
    const home = [item({ id: 'h-over', due: { date: '2026-11-01', time: null, by: 'member' } }), item({ id: 'h-09', due: { date: TODAY, time: '09:00', by: 'member' } }), item({ id: 'h-today', due: { date: TODAY, time: null, by: 'member' } }), item({ id: 'h-kept', pinned: true })];
    const m = mergeNeedsYou([
      { deskId: 'work', items: work, more: 0, newFromAgents: 1, toConfirm: 0, today: TODAY },
      { deskId: 'home', items: home, more: 2, newFromAgents: 2, toConfirm: 1, today: TODAY },
    ]);
    expect(m.items.map((i) => i.id)).toEqual(['h-over', 'w-over', 'h-09', 'w-15', 'h-today']);
    expect(m.items[1]!.deskId).toBe('work');
    expect(m).toMatchObject({ more: 3, newFromAgents: 3, toConfirm: 1 });
  });

  it('a maker is You, the agent’s name its desk knows, the name the item kept, or An agent', () => {
    expect(makerName('member', null, null)).toBe('You');
    expect(makerName('agent:a', 'Inbox', 'Old')).toBe('Inbox');
    expect(makerName('agent:a', null, 'Old')).toBe('Old');
    expect(makerName('agent:a', null, null)).toBe('An agent');
  });
});

describe('words', () => {
  it('the footer, everything else, and History', () => {
    expect(footerWords(2, 1)).toBe('2 new from agents · 1 to confirm');
    expect(footerWords(0, 1)).toBe('1 to confirm');
    expect(elseWords({ comingUp: 6, noDate: 7, snoozed: 2 })).toBe('6 coming up · 7 with no date · 2 snoozed');
    expect(eventWords('close', 'Inbox', { state: 'not_needed' })).toBe('Inbox marked it not needed');
    expect(eventWords('pin', 'You', { pinned: true })).toBe('You kept it in Needs you');
    expect(eventWords('pin', 'You', { pinned: false })).toBe('You took it out of Needs you');
  });

  it('a suggestion in History says which it asked, as its card and the Agent’s chip do', () => {
    const asked = (as: string) => ({ suggestion: { as, by: 'agent:a', reason: 'r', at: 1 } });
    expect(eventWords('suggest', 'Inbox', asked('done'))).toBe('Inbox asked if it’s done');
    expect(eventWords('suggest', 'Inbox', asked('not_needed'))).toBe('Inbox asked if it’s still needed');
    expect(eventWords('suggest', 'Inbox', null)).toBe('Inbox asked if it’s done');
    expect(eventWords('answer', 'You', { suggestion: null }, asked('done'))).toBe('You answered “Looks done?”');
    expect(eventWords('answer', 'You', { suggestion: null, state: 'not_needed' }, asked('not_needed'))).toBe('You answered “Not needed any more?”');
    expect(eventWords('answer', 'You', { suggestion: null })).toBe('You answered “Looks done?”');
  });

  it('the quiet lines bold their counts, as the pick sheet does', () => {
    expect(footerParts(2, 1)).toEqual([['2 new', ' from agents'], ['1', ' to confirm']]);
    expect(footerParts(0, 3)).toEqual([['3', ' to confirm']]);
    expect(footerParts(0, 0)).toEqual([]);
    expect(elseParts({ comingUp: 6, noDate: 7, snoozed: 2 })).toEqual([['6', ' coming up'], ['7', ' with no date'], ['2', ' snoozed']]);
    expect(elseParts({ comingUp: 0, noDate: 1, snoozed: 0 })).toEqual([['1', ' with no date']]);
  });
});

describe('the wire, read leniently (§22)', () => {
  it('an item: defaults for what is missing, bidi controls out, nothing without an id or title', () => {
    expect(readItem({ title: 'no id' })).toBeNull();
    expect(readItem({ id: 'a' })).toBeNull();
    const it = readItem({ id: 'a', title: 'Pay \u202ethe bill', due: { date: '2026-11-12', time: '25:00' }, state: 'weird', closed: { at: 5, by: 'agent:x' }, pinned: true, seen: false, group: 'today', source: { kind: 'courier', label: 'Email', ref: { messageId: 'm' } }, suggestion: { as: 'done', by: 'agent:x', reason: 'r' } })!;
    expect(it).toMatchObject({ title: 'Pay the bill', due: { date: '2026-11-12', time: null, by: 'member' }, state: 'open', closed: { at: 5, by: 'agent:x' }, pinned: true, seen: false, group: 'today', source: { kind: 'courier', label: 'Email' }, suggestion: { as: 'done', reason: 'r' } });
    expect(readItem({ id: 'b', title: 't' })).toMatchObject({ seen: true, pinned: false, group: null, source: { kind: 'member', ref: null, label: '' }, alsoFrom: [], note: null });
    expect(readItem({ id: 'c', title: 't', source: { kind: 'telepathy' } })!.source.kind).toBe('member');
  });

  it('desk text loses format and control characters (bidi, ALM, zero-width, BOM), a note keeps its newlines (TDA-L1)', () => {
    expect(plain('Email from Ann\u061c\u200b\ufeff \u202eevil\u202c\u0007')).toBe('Email from Ann evil');
    expect(plain('one\ntwo\tthree')).toBe('onetwothree');
    expect(plain('one\ntwo\u200b', true)).toBe('one\ntwo');
    // The joiners emoji and scripts need, and the emoji selectors, stay; the Hangul fillers and other selectors go (TDA-I6).
    expect(plain('a\u200db\ufe0f\u3164c\ufe01\u{e0100}')).toBe('a\u200db\ufe0fc');
    expect(readItem({ id: 'a', title: 't', note: 'a\nb\u202e' })!.note).toBe('a\nb');
    expect(readItem({ id: 'a', title: 't', source: { kind: 'courier', label: 'Ann\u200f<b>' } })!.source.label).toBe('Ann<b>');
  });

  it('a list and the summary: the footer, the zone (UTC for one this browser can’t use), counts never negative', () => {
    const l = readList({ items: [{ id: 'a', title: 't' }, { nope: 1 }], next: 'c1', rev: 9, today: '2026-11-12', zone: 'Mars/Olympus', more: 2, footer: { newFromAgents: 1, toConfirm: 3 } });
    expect(l).toMatchObject({ next: 'c1', rev: 9, today: '2026-11-12', zone: 'UTC', more: 2, newFromAgents: 1, toConfirm: 3 });
    expect(l.items).toHaveLength(1);
    expect(readSummary({ open: -3, badge: 2, zone: 'America/Denver' })).toMatchObject({ open: 0, badge: 2, zone: 'America/Denver', today: '' });
    expect(readChanges({ changes: [{ rev: 3, id: 'a', op: 'add' }, { rev: 4 }], rev: 4, reset: false })).toEqual({ changes: [{ rev: 3, id: 'a', op: 'add' }], rev: 4, reset: false });
  });
});
