// What reaches the member, as the office reads it (the focus shield; deskd API.md §23 topic `agent.maia`'s `reach` and the
// `agent.maia.reach.*` results): read leniently, plain text cut to its limits, never a URL as a ref; the card only on the device the
// desk names; `{who}` filled here; All held newest first by desk; the settings; and the welcome's Q4 to Q7 as `reach.set`'s params.
import { describe, expect, it } from 'vitest';
import { clockWords, fillWho, heldByDesk, readGo, readHeld, readReach, readSettings, reachFromWelcome, shownHere } from './reach';

const CONTRACT = {
  on: true,
  device: 'dv-k3j9abcd1234',
  line: { kind: 'held', text: '6 held · nothing urgent', held: 6, dot: 'none', action: null },
  card: {
    cardId: 'mc-1', itemId: 'mi-1', level: 'interrupt', kind: 'approval', deskId: 'd-work', source: 'Work · Invoices agent', what: 'The invoice agent needs your OK.', why: 'Expires in 40 min',
    whyMore: null, go: { kind: 'approvals', deskId: 'd-work', approvalIds: ['ap-1'] }, goLabel: 'Review', choices: [{ id: 'in_20', label: 'In 20 min' }], quote: null, first: null, after: null,
    at: 1763100000000, tuckAt: null,
    more: [{ itemId: 'mi-2', kind: 'message', source: 'Personal · Courier', what: '{who} wrote on Personal', why: 'Rosa is on your list', go: { kind: 'show', deskId: 'd-p', app: 'courier', ref: 'ch-9' }, goLabel: 'Reply' }],
    who: { deskId: 'd-work', contactId: '01JD4Z7K9QW3M8N2P5R6S7T8V9' },
  },
  catchup: null,
  back: null,
  working: { label: 'Q3 plan' },
  hold: null,
  held: { count: 6, now: 0 },
};

describe('readReach', () => {
  it('reads §23’s example as it is', () => {
    const r = readReach(CONTRACT)!;
    expect(r.on).toBe(true);
    expect(r.device).toBe('dv-k3j9abcd1234');
    expect(r.line).toEqual({ kind: 'held', text: '6 held · nothing urgent', held: 6, dot: 'none', action: null });
    expect(r.card).toMatchObject({ cardId: 'mc-1', level: 'interrupt', goLabel: 'Review', go: { kind: 'approvals', deskId: 'd-work', approvalIds: ['ap-1'] }, choices: [{ id: 'in_20', label: 'In 20 min' }], who: { deskId: 'd-work', contactId: '01JD4Z7K9QW3M8N2P5R6S7T8V9' } });
    expect(r.card?.more).toEqual([{ itemId: 'mi-2', kind: 'message', source: 'Personal · Courier', what: '{who} wrote on Personal', why: 'Rosa is on your list', go: { kind: 'show', deskId: 'd-p', app: 'courier', ref: 'ch-9' }, goLabel: 'Reply' }]);
    expect(r.working).toEqual({ label: 'Q3 plan' });
    expect(r.held).toEqual({ count: 6, now: 0 });
  });
  it('is null while Desk Maia is off, and lenient with junk: nothing throws, a bad field is dropped', () => {
    expect(readReach(null)).toBeNull();
    expect(readReach('x')).toBeNull();
    const r = readReach({ on: true, line: { kind: 'shout', text: 7, dot: 'red' }, card: { cardId: 'mc' }, catchup: { groups: 4 }, back: { cardId: 'mc-1' }, held: { count: -3 }, device: 'phone' })!;
    expect(r.line).toEqual({ kind: 'clear', text: 'All clear', held: 0, dot: 'none', action: null });
    expect(r.card).toBeNull();
    expect(r.catchup).toBeNull();
    expect(r.back).toBeNull();
    expect(r.device).toBeNull();
  });
  it('reads every line kind and its action', () => {
    const line = (l: unknown) => readReach({ on: true, line: l })!.line;
    expect(line({ kind: 'heads_up', text: 'One thing in a moment', dot: 'accent' })).toMatchObject({ kind: 'heads_up', dot: 'accent', action: null });
    expect(line({ kind: 'back', text: 'Back to Q3 plan', action: { kind: 'back', cardId: 'mc-1' } }).action).toEqual({ kind: 'back', cardId: 'mc-1' });
    expect(line({ kind: 'pickup', text: 'Pick up: Q3 plan', action: { kind: 'pickup', itemId: 'mi-4' } }).action).toEqual({ kind: 'pickup', itemId: 'mi-4', cardId: null });
    expect(line({ kind: 'pickup', text: 'Pick up: Q3 plan', action: { kind: 'pickup', itemId: 'mi-4', cardId: 'mc-9' } }).action).toEqual({ kind: 'pickup', itemId: 'mi-4', cardId: 'mc-9' });
    expect(line({ kind: 'heads_up', text: 'One thing in a moment', dot: 'accent', action: { kind: 'heads_up', cardId: 'mc-8' } }).action).toEqual({ kind: 'heads_up', cardId: 'mc-8' });
    expect(line({ kind: 'catchup', text: 'Your 1:00 catch-up is ready', action: { kind: 'catchup', catchupId: 'cu-1' } }).action).toEqual({ kind: 'catchup', catchupId: 'cu-1' });
    expect(line({ kind: 'hold', text: 'Holding until 11:30 · your list still gets through', action: { kind: 'open', href: 'https://x' } }).action).toBeNull();
  });
  it('reads a catch-up in code’s order, with its question, and a Back', () => {
    const r = readReach({
      on: true,
      catchup: {
        catchupId: 'cu-1', kind: 'catchup', head: 'Your 1:00 catch-up · 5 things, nothing urgent', at: 1, waiting: true, end: 'That’s all for now.', lines: ['Cleared without you: 6 updates'],
        groups: [
          { id: 'records', label: 'Records', items: [], summary: '2 receipts' },
          { id: 'needs_you', label: 'Needs you', items: [{ itemId: 'mi-1', line: 'Writer needs your OK', go: { kind: 'approvals', deskId: 'd-w', approvalIds: ['ap'] }, goLabel: 'Review', choices: [{ id: 'sooner', label: 'Sooner next time' }] }], summary: null },
          { id: 'gossip', label: 'Gossip', items: [], summary: 'x' },
        ],
        question: { questionId: 'tag_contact', text: 'Is {who} family, a client, or neither?', choices: [{ id: 'family', label: 'Family' }, { id: 'clients', label: 'A client' }, { id: 'neither', label: 'Neither' }], who: { deskId: 'd-p', contactId: '01JD4Z7K9QW3M8N2P5R6S7T8V9' } },
      },
      back: { cardId: 'mc-1', label: 'Back to Q3 plan', resume: 'You were on Q3 plan in Notebook, Work. Last change 3 min ago.', deskId: 'd-w', app: 'notebook', item: { kind: 'page', id: 'pg-1' }, surface: 'desk', until: 9 },
    })!;
    expect(r.catchup?.groups.map((g) => g.id)).toEqual(['needs_you', 'records']);
    expect(r.catchup?.question?.who).toEqual({ deskId: 'd-p', contactId: '01JD4Z7K9QW3M8N2P5R6S7T8V9' });
    expect(r.catchup?.waiting).toBe(true);
    expect(r.back).toMatchObject({ cardId: 'mc-1', app: 'notebook', item: { kind: 'page', id: 'pg-1' } });
  });
  it('reads every go, and never a URL as a ref', () => {
    expect(readGo({ kind: 'doc', deskId: 'd-w', docId: 'doc-1' })).toEqual({ kind: 'doc', deskId: 'd-w', docId: 'doc-1' });
    expect(readGo({ kind: 'back', cardId: 'mc-1', deskId: 'd-w', app: 'notebook', item: { kind: 'page', id: 'pg-1' } })).toEqual({ kind: 'back', cardId: 'mc-1', deskId: 'd-w', app: 'notebook', item: { kind: 'page', id: 'pg-1' } });
    expect(readGo({ kind: 'show', deskId: 'd-w', app: 'browser', ref: 'https://evil.example' })).toEqual({ kind: 'show', deskId: 'd-w', app: 'browser', ref: null });
    expect(readGo({ kind: 'show', deskId: 'd-w', app: 'approvals', ref: 'ap-1' })).toMatchObject({ app: 'agent' });
    expect(readGo({ kind: 'navigate', href: 'https://x' })).toEqual({ kind: 'none' });
  });
  it('cuts what a desk wrote to plain text', () => {
    const r = readReach({ ...CONTRACT, card: { ...CONTRACT.card, what: `Pay now‮ ${'x'.repeat(300)}` } })!;
    expect(r.card?.what.length).toBeLessThanOrEqual(200);
    expect(r.card?.what).not.toContain('‮');
  });
});

describe('where it shows', () => {
  it('only on the device the desk names, on any when it names none, and nothing with “Show everything as it comes”', () => {
    const r = readReach(CONTRACT);
    expect(shownHere(r, 'dv-k3j9abcd1234')).toBe(true);
    expect(shownHere(r, 'dv-otherdevice00')).toBe(false);
    expect(shownHere(readReach({ ...CONTRACT, device: null }), 'dv-otherdevice00')).toBe(true);
    expect(shownHere(readReach({ ...CONTRACT, on: false }), 'dv-k3j9abcd1234')).toBe(false);
    expect(shownHere(null, 'dv-k3j9abcd1234')).toBe(false);
  });
  it('fills {who} with the name from that desk’s Courier, else “Someone”', () => {
    expect(fillWho('{who} wrote on Personal', 'Rosa')).toBe('Rosa wrote on Personal');
    expect(fillWho('{who} wrote on Personal', null)).toBe('Someone wrote on Personal');
    expect(fillWho('A document from {who} needs you', null)).toBe('A document from someone needs you');
    expect(fillWho('Expires in 40 min', 'Rosa')).toBe('Expires in 40 min');
    expect(fillWho('Personal · {who}', null)).toBe('Personal · Someone');
  });
});

describe('All held', () => {
  it('reads newest first, grouped by desk', () => {
    const items = readHeld({
      items: [
        { itemId: 'a', kind: 'result', deskId: 'd-w', deskName: 'Work', title: 'Old result', level: 'hold', reason: 'Read later', at: 1 },
        { itemId: 'b', kind: 'message', deskId: 'd-p', deskName: 'Personal', title: 'New message', level: 'periphery', reason: null, at: 3 },
        { itemId: 'c', kind: 'notes', deskId: 'd-w', deskName: 'Work', title: 'Notes', level: 'hold', at: 2 },
        { itemId: '', title: 'no id' },
      ],
    });
    expect(items.map((i) => i.itemId)).toEqual(['b', 'c', 'a']);
    expect(heldByDesk(items).map((g) => [g.deskName, g.items.map((i) => i.itemId)])).toEqual([
      ['Personal', ['b']],
      ['Work', ['c', 'a']],
    ]);
  });
});

describe('What reaches you', () => {
  it('reads the settings, what’s learned and the counts, and defaults what’s out of shape', () => {
    const v = readSettings({
      reach: {
        letThrough: [
          { ruleId: 'mr-1', kind: 'group', group: 'family', anyTime: true, source: 'welcome' },
          { ruleId: 'mr-2', kind: 'person', person: { pendingName: 'Rosa' }, anyTime: false },
          { ruleId: 'mr-3', kind: 'person', person: { deskId: 'd-p', contactId: '01JD4Z7K9QW3M8N2P5R6S7T8V9' } },
          { kind: 'group', group: 'enemies' },
        ],
        holdAll: false, catchUps: ['09:00', '13:00', '25:00'], focusHours: [{ from: '09:00', to: '12:00' }, { from: 'x', to: 'y' }], quietHours: null, evenings: 'let', detail: 'loud', showAll: true,
        learned: [{ ruleId: 'ml-1', line: 'Newsletters wait for catch-ups', at: 5 }],
        counts: { heldToday: 4, deliveredToday: 1, missedThisWeek: 0 },
      },
    });
    expect(v.letThrough.map((r) => r.kind)).toEqual(['group', 'person', 'person']);
    expect(v.catchUps).toEqual(['09:00', '13:00']);
    expect(v.focusHours).toEqual([{ from: '09:00', to: '12:00' }]);
    expect(v.evenings).toBe('let');
    expect(v.detail).toBe('paragraph');
    expect(v.showAll).toBe(true);
    expect(v.learned).toEqual([{ ruleId: 'ml-1', line: 'Newsletters wait for catch-ups', at: 5, who: null }]);
    expect(v.counts).toEqual({ heldToday: 4, deliveredToday: 1, missedThisWeek: 0 });
  });
});

describe('the welcome’s Q4 to Q7 (reachFromWelcome)', () => {
  it('Skip is the contract’s default: due today and money; 9:00, 1:00, 5:00; no focus hours; a short paragraph', () => {
    expect(reachFromWelcome({})).toEqual({
      params: {
        letThrough: [
          { kind: 'match', match: 'due_today', anyTime: false, source: 'welcome' },
          { kind: 'match', match: 'money', anyTime: false, source: 'welcome' },
        ],
        holdAll: false,
        catchUps: ['09:00', '13:00', '17:00'],
        focusHours: [],
        detail: 'paragraph',
      },
      over: [],
    });
  });
  it('Q4: Family (any time), My boss or clients (one entry), due today, bills as money, names straight to the desk', () => {
    const r = reachFromWelcome({ q4: ['family', 'boss', 'byName'], names: ['Rosa', ' rosa ', 'Sam'] });
    expect(r.params.letThrough).toEqual([
      { kind: 'group', group: 'family', anyTime: true, source: 'welcome' },
      { kind: 'group', group: 'boss_clients', anyTime: false, source: 'welcome' },
      { kind: 'person', person: { pendingName: 'Rosa' }, anyTime: false, source: 'welcome' },
      { kind: 'person', person: { pendingName: 'Sam' }, anyTime: false, source: 'welcome' },
    ]);
    expect(reachFromWelcome({ q4: ['due', 'bills'] }).params.letThrough.map((x) => (x.kind === 'match' ? x.match : x.kind))).toEqual(['due_today', 'money']);
  });
  it('Q4: at most 5; the rest come back as over, for the welcome to ask which to swap', () => {
    const r = reachFromWelcome({ q4: ['family', 'boss', 'due', 'bills', 'byName'], names: ['Rosa', 'Sam', 'Lee'] });
    expect(r.params.letThrough).toHaveLength(5);
    expect(r.over).toEqual([
      { kind: 'person', person: { pendingName: 'Sam' }, anyTime: false, source: 'welcome' },
      { kind: 'person', person: { pendingName: 'Lee' }, anyTime: false, source: 'welcome' },
    ]);
  });
  it('Q4: Nothing, hold it all is holdAll with an empty list', () => {
    expect(reachFromWelcome({ q4: ['nothing'] }).params).toMatchObject({ letThrough: [], holdAll: true });
  });
  it('Q5: the four choices', () => {
    expect(reachFromWelcome({ q5: 'three' }).params.catchUps).toEqual(['09:00', '13:00', '17:00']);
    expect(reachFromWelcome({ q5: 'two' }).params.catchUps).toEqual(['09:00', '17:00']);
    expect(reachFromWelcome({ q5: 'often' }).params.catchUps).toEqual(['09:00', '11:00', '13:00', '15:00', '17:00']);
    expect(reachFromWelcome({ q5: 'ask' }).params.catchUps).toEqual([]);
  });
  it('Q6: mornings 9 to 12, afternoons 2 to 5, “It varies” and “No set times” none', () => {
    expect(reachFromWelcome({ q6: ['mornings'] }).params.focusHours).toEqual([{ from: '09:00', to: '12:00' }]);
    expect(reachFromWelcome({ q6: ['mornings', 'afternoons'] }).params.focusHours).toEqual([{ from: '09:00', to: '12:00' }, { from: '14:00', to: '17:00' }]);
    expect(reachFromWelcome({ q6: ['varies'] }).params.focusHours).toEqual([]);
    expect(reachFromWelcome({ q6: ['none'] }).params.focusHours).toEqual([]);
  });
  it('Q7: one line, a short paragraph, the full picture', () => {
    expect(['line', 'paragraph', 'full', null].map((q7) => reachFromWelcome({ q7 }).params.detail)).toEqual(['line', 'paragraph', 'full', 'paragraph']);
  });
});

describe('times', () => {
  it('says a desk-zone wall time in this browser’s locale', () => {
    expect(clockWords('13:00', 'en-US')).toBe('1:00 PM');
    expect(clockWords('13:00', 'en-GB')).not.toMatch(/PM/);
    expect(clockWords('nope')).toBe('nope');
  });
});
