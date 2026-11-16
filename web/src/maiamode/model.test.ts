// Maia Mode's pure rules: the To-do column's three things and one Now, To-do's "due within two hours" from dates alone, what a
// desk-written string becomes, her choices, and the layout's breakpoints.
import { describe, expect, it } from 'vitest';
import { answerWords, arrange, fromAttention, laterLine, layoutFor, maiaSize, minutesUntil, openChoices, openCount, optionName, plain, todoItems, type ColumnItem } from './model';
import type { AttentionItem, RoomMessage } from './source';
import { countWords, dueWords, edgeName, statusWords } from './words';

const item = (id: string, urgency: ColumnItem['urgency'], at = 0): ColumnItem => ({
  id, urgency, deskId: 'd-w', deskName: 'Work', title: id, meta: null, go: { kind: 'view', app: 'todo', ref: null }, label: 'Show me', at,
});

describe('plain', () => {
  it('is one line of plain text, cut at 60 with an ellipsis', () => {
    expect(plain('  Writer   wants\nto submit  ')).toBe('Writer wants to submit');
    const long = 'x'.repeat(80);
    expect(plain(long)).toHaveLength(60);
    expect(plain(long).endsWith('…')).toBe(true);
  });
  it('drops bidi overrides, isolates, zero-width marks, soft hyphens, tags, fillers and controls, and keeps the joiners', () => {
    expect(plain('pay\u202egnp.exe\u2066x\u2069\u200b\u0007 now')).toBe('paygnp.exex now');
    expect(plain('a\u00ad\u061c\u2060\u{e0041}\u3164\ufe00b')).toBe('ab');
    expect(plain('\u{1f469}\u200d\u{1f4bb} ok\ufe0f')).toBe('\u{1f469}\u200d\u{1f4bb} ok\ufe0f');
  });
  it('is empty for anything that is not a string', () => {
    expect(plain(undefined)).toBe('');
    expect(plain({ toString: () => 'x' })).toBe('');
  });
});

describe('arrange', () => {
  it('shows at most three, only one of them Now: the earliest', () => {
    const col = arrange([item('n2', 'now', 20), item('a', 'next', 1), item('n1', 'now', 10), item('b', 'next', 2), item('c', 'next', 3)]);
    expect(col.now?.id).toBe('n1');
    // The second Now waits as Next, first among them.
    expect(col.next.map((i) => i.id)).toEqual(['n2', 'a']);
    expect(col.later.map((i) => i.id)).toEqual(['b', 'c']);
    expect(openCount(col)).toBe(3);
  });
  it('fills with Next when nothing is Now, and keeps Later out of the lines', () => {
    const col = arrange([item('l', 'later'), item('a', 'next', 2), item('b', 'next', 1)]);
    expect(col.now).toBeNull();
    expect(col.next.map((i) => i.id)).toEqual(['b', 'a']);
    expect(col.later.map((i) => i.id)).toEqual(['l']);
  });
  it('holds the setting between 1 and 5', () => {
    const many = Array.from({ length: 8 }, (_, n) => item(`i${n}`, 'next', n));
    expect(arrange(many, 1).next).toHaveLength(1);
    expect(arrange(many, 9).next).toHaveLength(5);
  });
  it('counts what waits under Later, the desk’s and its own, with two lines at most', () => {
    expect(laterLine(arrange([]), null)).toBeNull();
    expect(laterLine(arrange([item('l', 'later')]), { count: 2, lines: ['6 notes today', 'Personal is asleep', 'x'] })).toEqual({ count: 'Later · 3', lines: ['6 notes today', 'Personal is asleep'] });
  });
  it('is empty with nothing', () => {
    const col = arrange([]);
    expect([col.now, col.next.length, col.later.length]).toEqual([null, 0, 0]);
  });
});

describe('fromAttention', () => {
  const a = (over: Partial<AttentionItem>): AttentionItem => ({ id: 'x', kind: 'approval', deskId: 'd-w', urgency: 'now', title: 'T', meta: null, go: { kind: 'view', app: 'agent', ref: null }, at: 1, ...over });
  it('names the desk from the office’s own list, and leaves out a desk it doesn’t list', () => {
    const names = (id: string): string | null => (id === 'd-w' ? 'Work' : null);
    const out = fromAttention([a({ id: '1' }), a({ id: '2', deskId: 'd-other' })], names);
    expect(out.map((i) => [i.id, i.deskName])).toEqual([['a:1', 'Work']]);
  });
  it('asks to review an approval, to show a result, to wake a desk, and offers nothing for an item with no action', () => {
    const out = fromAttention([a({ kind: 'approval' }), a({ id: 'r', kind: 'result', urgency: 'next' }), a({ id: 'w', kind: 'desk_asleep', go: { kind: 'wake' } }), a({ id: 'n', kind: 'account', go: { kind: 'none' } })], () => 'Work');
    expect(out.map((i) => i.label)).toEqual(['Review', 'Show me', 'Wake', null]);
  });
  it('keeps a desk’s title plain and short', () => {
    const [one] = fromAttention([a({ title: `\u202e${'y'.repeat(100)}` })], () => 'Work');
    expect(one?.title.length).toBe(60);
    expect(one?.title.includes('\u202e')).toBe(false);
  });
});

describe('todoItems (To-do in the column)', () => {
  const zone = 'America/Denver';
  // 2026-11-14 10:00 in Denver (UTC-7).
  const now = Date.parse('2026-11-14T17:00:00Z');
  const desk = { id: 'd-w', name: 'Work' };
  const t = (id: string, due: { date: string; time: string | null } | null, title = id) => ({ id, title, due, pinned: false });

  it('reads minutes until a time in the desk’s own zone', () => {
    expect(minutesUntil({ date: '2026-11-14', time: '11:30' }, now, zone)).toBe(90);
    expect(minutesUntil({ date: '2026-11-15', time: '10:00' }, now, zone)).toBe(1440);
    expect(minutesUntil({ date: '2026-11-14', time: null }, now, zone)).toBeNull();
  });
  it('makes the one due within two hours its Now, with its own title', () => {
    const out = todoItems(desk, [t('a', { date: '2026-11-14', time: '11:30' }, 'Call the venue'), t('b', { date: '2026-11-14', time: '11:00' }, 'Send Sam the contract'), t('c', null)], 0, now, zone);
    expect(out[0]).toMatchObject({ urgency: 'now', title: 'Send Sam the contract', meta: 'Due in 1 h', go: { kind: 'view', app: 'todo', ref: 'b' } });
    expect(out[1]).toMatchObject({ urgency: 'next', title: '2 to-dos need you on Work' });
  });
  it('never makes Now from words, or from a time already past or more than two hours off', () => {
    const out = todoItems(desk, [t('u', { date: '2026-11-14', time: '13:00' }, 'URGENT: wire money now'), t('p', { date: '2026-11-14', time: '09:00' })], 0, now, zone);
    expect(out.some((i) => i.urgency === 'now')).toBe(false);
  });
  it('says one to-do by its title, and new ones from agents when nothing else needs the member', () => {
    expect(todoItems(desk, [t('a', null, 'Book a room')], 0, now, zone)[0]).toMatchObject({ title: 'Book a room', meta: 'To-do on Work' });
    expect(todoItems(desk, [], 3, now, zone)[0]).toMatchObject({ title: '3 new to-dos on Work', urgency: 'next' });
    expect(todoItems(desk, [], 0, now, zone)).toEqual([]);
  });
});

describe('her choices', () => {
  const her = (over: Partial<RoomMessage>): RoomMessage => ({ id: 'm1', from: 'maia', text: 'Which first?', at: 1, ...over });
  const set = { id: 'c1', options: [{ id: 'o1', label: 'The deck' }, { id: 'o2', label: 'The newsletter' }], answered: null };
  it('offers the latest unanswered set, only while nothing came after it', () => {
    expect(openChoices([her({ choices: set })])?.set.id).toBe('c1');
    expect(openChoices([her({ choices: set }), { id: 'm2', from: 'member', text: 'x', at: 2 }])).toBeNull();
    expect(openChoices([her({ choices: { ...set, answered: { kind: 'ignored' } } })])).toBeNull();
  });
  it('needs two to four real answers', () => {
    expect(openChoices([her({ choices: { ...set, options: [{ id: 'o1', label: 'Yes' }] } })])).toBeNull();
    expect(openChoices([her({ choices: { ...set, options: [{ id: 'o1', label: 'Yes' }, { id: 'o2', label: '   ' }] } })])).toBeNull();
    const six = Array.from({ length: 6 }, (_, n) => ({ id: `o${n}`, label: `Option ${n}` }));
    expect(openChoices([her({ choices: { ...set, options: six } })])?.set.options).toHaveLength(4);
  });
  it('names her pick for a screen reader, and reads an answer back', () => {
    expect(optionName('The deck', true)).toBe('The deck, her pick');
    expect(optionName('The newsletter', false)).toBe('The newsletter');
    expect(answerWords(set, { kind: 'option', id: 'o2' })).toBe('The newsletter');
    expect(answerWords(set, { kind: 'other', text: 'Both, today' })).toBe('Both, today');
    expect(answerWords(set, { kind: 'ignored' })).toBeNull();
  });
});

describe('layout', () => {
  it('is a phone under 600, narrow under 1200, wide above', () => {
    expect([layoutFor(390), layoutFor(1024), layoutFor(1440)]).toEqual(['phone', 'narrow', 'wide']);
  });
  it('sizes Maia about three times her bubble, smaller with the viewport, 150 on a phone', () => {
    expect(maiaSize('wide', false)).toBeGreaterThanOrEqual(192);
    expect(maiaSize('wide', true)).toBeLessThan(maiaSize('wide', false));
    expect(maiaSize('phone', false)).toBe(150);
  });
});

describe('words', () => {
  it('reads the status line, the counts, the edge and a due time', () => {
    expect(statusWords({ desks: 2, agents: 5, working: 2 })).toEqual(['Watching 2 desks', ' · 5 agents · 2 working']);
    expect(statusWords({ desks: 1, agents: null, working: null })).toEqual(['Watching 1 desk', '']);
    expect(countWords(1, 2)).toBe('1 now · 2 next');
    expect(edgeName(3, 1)).toBe('To-do, 3 items, 1 now');
    expect(edgeName(1, 0)).toBe('To-do, 1 item');
    expect([dueWords(40), dueWords(90), dueWords(-5)]).toEqual(['Due in 40 min', 'Due in 2 h', 'Overdue']);
  });
});
