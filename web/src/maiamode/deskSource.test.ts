// Desk Maia's adapter against the runtime's contract (deskd API.md §23): the readers (her choices, notes and shows, the room's
// state stream, what the office observes) and the source on a fake home desk: the calls it makes, with `idem` on every
// mutation, the access saved when the desk asks for setup, the room's list and her thread as the room reads them. Her model runs
// on Minimalist Alliance's AI service within the member's Maia allowance (the owner, Nov 14): no key is ever asked for here.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as { method: string; params: Record<string, unknown>; idem: string | undefined }[],
  topics: new Map<string, (msg: Record<string, unknown>) => void>(),
  answers: new Map<string, (params: Record<string, unknown>) => unknown>(),
  prefs: {} as Record<string, unknown>,
  saved: [] as Record<string, unknown>[],
}));
vi.stubGlobal('window', { setTimeout, clearTimeout, matchMedia: () => ({ matches: false, addEventListener() {} }) });
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });

const link = {
  deskId: 'd-p',
  call: async (method: string, params: Record<string, unknown> = {}, o?: { idem?: string }) => {
    h.calls.push({ method, params, idem: o?.idem });
    const a = h.answers.get(method);
    return a ? a(params) : {};
  },
  subscribe: (topic: string, fn: (msg: Record<string, unknown>) => void) => {
    h.topics.set(topic, fn);
    return () => h.topics.delete(topic);
  },
};
vi.mock('../desk/liveStore', async () => {
  const { create } = await import('zustand');
  return {
    useLiveStore: create(() => ({ desks: { 'd-p': { link: 'open' }, 'd-w': { link: 'closed' } } as Record<string, { link: string }> })),
    linkOf: (id: string) => (id === 'd-p' ? link : null),
    wakeDesk: () => undefined,
  };
});
vi.mock('../state/deskStore', async () => {
  const { create } = await import('zustand');
  return {
    useDeskStore: create(() => ({
      desks: [
        { id: 'd-p', name: 'Personal', kind: 'personal', vm: 'running' },
        { id: 'd-w', name: 'Work', kind: 'work', vm: 'stopped' },
        { id: 'd-g', name: 'Guild', kind: 'guild', vm: 'running' },
      ],
    })),
  };
});
vi.mock('./prefs', () => ({
  currentPrefs: () => h.prefs,
  savePrefs: (patch: Record<string, unknown>) => {
    h.saved.push(patch);
    Object.assign(h.prefs, patch);
    return h.prefs;
  },
}));

const D = await import('./deskSource');
const { allowanceLines } = await import('./model');

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.calls.length = 0;
  h.topics.clear();
  h.answers.clear();
  h.prefs = {};
  h.saved.length = 0;
  h.answers.set('agent.maia.get', () => ({ maia: { on: true, home: { deskId: 'd-p' }, notesTabId: 'tab-1' } }));
  h.answers.set('agent.thread.get', () => ({ agentId: 'maia', messages: [], seq: 0 }));
  h.answers.set('todo.summary', () => ({ newFromAgents: 2, zone: 'UTC', rev: 1 }));
  h.answers.set('todo.list', () => ({ items: [], zone: 'UTC', rev: 1, next: null, more: 0, newFromAgents: 0, toConfirm: 0, today: '2026-11-14' }));
});

describe('readers', () => {
  it('reads her choices with her recommendation first, and how they were answered', () => {
    const c = D.readChoices({ question: 'Which?', options: [{ id: 'c1', label: 'A' }, { id: 'c2', label: 'B' }, { id: 'c3', label: '' }], recommended: 'c2', state: 'open', answer: null });
    expect(c?.options).toEqual([{ id: 'c2', label: 'B' }, { id: 'c1', label: 'A' }]);
    expect(c?.answered).toBeNull();
    expect(D.readChoices({ options: [{ id: 'c1', label: 'A' }, { id: 'c2', label: 'B' }], state: 'answered', answer: 'c1' })?.answered).toEqual({ kind: 'option', id: 'c1' });
    expect(D.readChoices({ options: [{ id: 'c1', label: 'A' }, { id: 'c2', label: 'B' }], state: 'answered', answer: 'other' })?.answered).toEqual({ kind: 'other', text: '' });
    expect(D.readChoices({ options: [{ id: 'c1', label: 'A' }, { id: 'c2', label: 'B' }], state: 'passed' })?.answered).toEqual({ kind: 'ignored' });
    expect(D.readChoices({ options: [{ id: 'c1', label: 'Only one' }] })).toBeNull();
    expect(c).toMatchObject({ other: true, pick: true });
  });
  it('reads code’s own question about held notes: no "Other" and no pick of hers', () => {
    const c = D.readChoices({ question: 'Two notes could go either way. Work?', options: [{ id: 'work', label: 'Work' }, { id: 'personal', label: 'Personal' }, { id: 'drop', label: 'Don’t keep' }], other: false, kind: 'notes', noteIds: ['n1', 'n2'], state: 'open' });
    expect(c?.options.map((o) => o.id)).toEqual(['work', 'personal', 'drop']);
    expect(c).toMatchObject({ other: false, pick: false });
  });
  it('reads a reply: the chips with their Undo, a show offer, a failure in code’s words', () => {
    const m = D.readMessage({
      id: 'm1', role: 'assistant', text: 'Noted.', at: 5, state: 'failed', error: 'provider_error', errorDetail: 'unavailable',
      notes: [{ noteId: 'n1', area: 'work', state: 'filed', approvalId: 'ap-1', line: 'Noted for Work' }, { noteId: 'n2', state: 'held', line: 'Noted for Personal' }],
      show: { deskId: 'd-w', app: 'notebook', ref: 'pg-1' },
      choices: { options: [{ id: 'c1', label: 'Yes' }, { id: 'c2', label: 'No' }], recommended: 'c1', state: 'open' },
    } as never);
    expect(m?.notes).toEqual([{ id: 'n1', line: 'Noted for Work', state: 'filed', undo: 'ap-1' }, { id: 'n2', line: 'Noted for Personal', state: 'held', undo: null }]);
    expect(m?.show).toEqual({ deskId: 'd-w', app: 'notebook', ref: 'pg-1' });
    expect(m?.failed).toBe('Maia isn’t available right now. Try again in a few minutes.');
    expect(m?.choices?.id).toBe('m1:choices');
  });
  it('reads a reply that stopped at her allowance, and one whose AI service was down', () => {
    const limit = { id: 'm2', role: 'assistant', text: '', at: 5, state: 'failed', error: 'provider_error', errorDetail: 'limit' };
    expect(D.readMessage({ ...limit, limit: { reason: 'limit_personal', window: 'day', resetsAt: '2020-01-01T00:00:00Z' } } as never)?.failed).toBe('You’ve used today’s Maia allowance.');
    expect(D.readMessage({ ...limit, limit: { reason: 'limit_pool', resetsAt: 'soon' } } as never)?.failed).toBe('The allowance Maia shares across members is used up for now.');
    expect(D.readMessage(limit as never)?.failed).toBe('You’ve used your Maia allowance for now.');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-11-14T19:00:00Z'));
      const later = { reason: 'limit_personal', window: 'day', resetsAt: '2026-11-15T03:00:00Z' };
      const line = D.readMessage({ ...limit, limit: later } as never)?.failed;
      expect(line).toBe(D.allowanceLine(later, Date.now()));
      expect(line).toMatch(/^You’ve used today’s Maia allowance\. It resets (at|tomorrow at) /);
    } finally {
      vi.useRealTimers();
    }
    expect(D.readMessage({ ...limit, errorDetail: 'unavailable' } as never)?.failed).toBe('Maia isn’t available right now. Try again in a few minutes.');
    expect(D.readMessage({ ...limit, error: 'internal', errorDetail: null } as never)?.failed).toBe('That reply didn’t finish. Try again in a moment.');
  });
  it('never shows a message the member didn’t write as theirs', () => {
    expect(D.readMessage({ id: 'u1', role: 'user', text: 'hi', at: 1, origin: { kind: 'timer' } } as never)).toBeNull();
    expect(D.readMessage({ id: 'u2', role: 'user', text: 'hi', at: 1 } as never)).toMatchObject({ from: 'member', text: 'hi' });
  });
  it('shows only the closed enum, and never a URL as a ref', () => {
    expect(D.readShow({ deskId: 'd', app: 'approvals', ref: ['ap-1'] })).toEqual({ deskId: 'd', app: 'agent', ref: 'ap-1' });
    expect(D.readShow({ deskId: 'd', app: 'notebook', ref: 'https://example.org/x' })).toEqual({ deskId: 'd', app: 'notebook', ref: null });
    expect(D.readShow({ deskId: 'd', app: 'courier' })).toBeNull();
    expect(D.readShow({ deskId: 'd', app: 'javascript:alert(1)' })).toBeNull();
  });
  it('shows Documents at a document and page only (deskd API.md §24 `office_show`), and reads her handover card’s pointer', () => {
    const id = 'd_01JCMA00000000000000000001';
    expect(D.readShow({ deskId: 'd', app: 'documents', ref: id })).toEqual({ deskId: 'd', app: 'documents', ref: id });
    expect(D.readShow({ deskId: 'd', app: 'documents', ref: `${id}#p3` })).toEqual({ deskId: 'd', app: 'documents', ref: `${id}#p3` });
    for (const ref of ['Documents/a.pdf', `${id}#page3`, 'https://example.org/x', ['a']]) expect(D.readShow({ deskId: 'd', app: 'documents', ref })).toEqual({ deskId: 'd', app: 'documents', ref: null });
    expect(D.readDoc({ deskId: 'd-personal', docId: id })).toEqual({ deskId: 'd-personal', docId: id });
    expect(D.readDoc({ deskId: 'd-personal', docId: 'd_x' })).toBeNull();
    expect(D.readDoc({ docId: id })).toBeNull();
    const m = D.readMessage({ id: 'm1', role: 'assistant', text: 'Here’s the contract Rosa sent. Page 3 is the change.', at: 1, doc: { deskId: 'd-personal', docId: id } } as never);
    expect(m?.doc).toEqual({ deskId: 'd-personal', docId: id });
    expect(D.readMessage({ id: 'm2', role: 'assistant', text: 'x', at: 1, doc: { deskId: 'd', docId: 'javascript:x' } } as never)?.doc).toBeUndefined();
  });
  it('reads the room: the list as code wrote it, its actions, Later, the foot and the notice', () => {
    const now = 1_000_000_000;
    const r = D.readRoom({
      on: true, killed: false, connecting: false,
      status: { desks: 2, agents: 5, working: 2, line: 'x' },
      todo: {
        items: [
          { id: 'mi-1', kind: 'approval', urgency: 'now', deskId: 'd-w', title: `Scout needs your OK on Work\u202e`, expiresAt: now + 40 * 60_000, action: { kind: 'approvals', deskId: 'd-w', approvalIds: ['ap-9'] }, createdAt: 3 },
          { id: 'mi-2', kind: 'result', urgency: 'next', deskId: 'd-w', title: 'Scout finished', action: { kind: 'result', messageId: 'm-7' } },
          { id: 'mi-3', kind: 'made_up', urgency: 'now', deskId: 'd-w', title: 'x' },
          { id: 'mi-4', kind: 'desk_asleep', urgency: 'urgent!', deskId: 'd-w', title: 'x' },
        ],
        later: { count: 2, lines: ['6 notes today', 'Personal is asleep'] },
      },
      // An older desk's dollar spend is never read: nothing of Maia's is money (the owner, Nov 15).
      spend: { todayMicroUsd: 840000, capMicroUsd: 5000000, line: 'Today $0.84 of $5' },
      foot: { onIt: 2, doneToday: 5, line: 'On it: 2 · Done today: 5 · Today $0.84 of $5' },
      allowance: { fraction: 0.62, resetsAt: '2026-12-01T07:00:00Z', usedUp: false, lighter: false, credits: { month: 2500, monthLeft: 1550, week: 800, weekUsed: 120, day: 200, dayUsed: 90, topUpLeft: 0, drawingFrom: 'week' }, today: 12.5, cap: null },
      notice: { itemId: 'mi-1', at: 77 },
      show: { showId: 's1', deskId: 'd-w', app: 'files', ref: '/Reports', open: true, at: 99 },
    }, now);
    expect(r.attention.map((a) => [a.id, a.urgency, a.title, a.meta, a.go])).toEqual([
      ['mi-1', 'now', 'Scout needs your OK on Work', 'Expires in 40 min', { kind: 'view', app: 'agent', ref: 'ap-9' }],
      ['mi-2', 'next', 'Scout finished', null, { kind: 'chat', messageId: 'm-7' }],
    ]);
    expect(r.later).toEqual({ count: 2, lines: ['6 notes today', 'Personal is asleep'] });
    expect(r.foot).toEqual({ onIt: 2, doneToday: 5, briefs: null });
    expect(r.allowance).toEqual({ fraction: 0.62, resetsAt: '2026-12-01T07:00:00Z', usedUp: false, lighter: false, credits: { month: 2500, monthLeft: 1550, topUpLeft: 0, drawingFrom: 'week' }, today: 12.5, cap: null });
    expect(JSON.stringify(r)).not.toContain('$');
    expect(r.status).toEqual({ desks: 2, agents: 5, working: 2 });
    expect(r.noticeAt).toBe(77);
    expect(r.show).toMatchObject({ deskId: 'd-w', app: 'files', ref: '/Reports', open: true, at: 99 });
  });
  it('observes the member’s own desks only, never a Guild Desk, with each desk’s state and link', () => {
    const desks = [
      { id: 'd-p', name: 'Personal', kind: 'personal', vm: 'running' },
      { id: 'd-g', name: 'Guild', kind: 'guild', vm: 'running' },
      { id: 'd-w', name: 'Work\u202e', kind: 'work', vm: 'error' },
    ] as never;
    const p = D.observePayload(desks, (id) => id === 'd-p', () => ({ agents: [{ id: 'a1', name: 'Scout', status: 'working', approvalsPending: 1 } as never], approvals: [{ approvalId: 'ap', agentId: 'a1', expiresAt: 5 }], todo: { newFromAgents: 1, dueSoon: [] } }), true) as { desks: Record<string, unknown>[]; typing: boolean };
    expect(p.desks.map((d) => [d['deskId'], d['state'], d['link'], d['name']])).toEqual([['d-p', 'running', 'open', 'Personal'], ['d-w', 'failed', 'closed', 'Work']]);
    expect(p.desks[0]?.['agents']).toEqual([{ agentId: 'a1', name: 'Scout', status: 'working', statusDetail: null, approvalsPending: 1 }]);
    expect(p.typing).toBe(true);
  });
  it('reads what her briefs cost, in dollars of the member’s own keys, in all and per desk', () => {
    const r = D.readRoom({
      foot: { onIt: 1, doneToday: 3 },
      spend: { todayMicroUsd: 120000, capMicroUsd: 100000000 },
      briefs: { todayMicroUsd: 1200000, monthMicroUsd: 8400000, budgetMicroUsd: 3000000, desks: [
        { deskId: 'd-w', deskName: 'Work\u202e', todayMicroUsd: 800000, monthMicroUsd: 6100000 },
        { deskId: 'd-p', deskName: 'Personal', todayMicroUsd: 400000, monthMicroUsd: 2300000 },
        { deskName: 'no id', todayMicroUsd: 1 },
      ] },
    });
    expect(r.foot?.briefs).toEqual({ todayUsd: 1.2, monthUsd: 8.4, budgetUsd: 3, desks: [
      { deskId: 'd-w', name: 'Work', todayUsd: 0.8, monthUsd: 6.1 },
      { deskId: 'd-p', name: 'Personal', todayUsd: 0.4, monthUsd: 2.3 },
    ] });
    expect(D.readBriefs({ todayMicroUsd: -5, budgetMicroUsd: 3000000 })).toBeNull();
    expect(D.readBriefs(null)).toBeNull();
  });
  it('shows a held brief’s estimate only on code’s card, as plain text', () => {
    const card = D.readMessage({ id: 'm-c', role: 'assistant', text: 'About $0.40 on your Work Lead would take my briefs past today’s $3 budget. Go ahead?', at: 1, state: 'done',
      choices: { question: 'q', options: [{ id: 'cheaper', label: 'Cheaper way' }, { id: 'go', label: 'Go' }], recommended: 'cheaper', other: false, state: 'open', kind: 'budget' },
      cost: { line: 'About $0.40 · usually $0.20 · Work Lead\u202e', estimateMicroUsd: 400000 } } as never);
    expect(card?.cost).toBe('About $0.40 · usually $0.20 · Work Lead');
    expect(card?.choices?.other).toBe(false);
    const plainReply = D.readMessage({ id: 'm-r', role: 'assistant', text: 'Hi', at: 1, state: 'done', cost: { line: 'About $9' } } as never);
    expect(plainReply?.cost).toBeUndefined();
  });
  it('reads a desk’s team view for her planning: headroom and her briefs’ cost there, counts and dollars only', () => {
    const u = D.readUsage({ zone: 'UTC', today: '2026-11-15', agents: [
      { agentId: 'ag-lead', name: 'Lead', days: [{ date: '2026-11-15', spendMicroUsd: 5 }], headroom: { dayLeftMicroUsd: 1050000, monthLeftMicroUsd: 12300000, runMaxMicroUsd: 2000000, briefMaxMicroUsd: 500000, perTaskMicroUsd: 200000, tasks: 6, perBriefMicroUsd: null, briefs: 0, extra: 'x' } },
      { agentId: 'maia', name: 'Maia', days: [] },
      { agentId: 'ag-bad', headroom: { dayLeftMicroUsd: -1, tasks: 'six' } },
    ], maiaBriefs: { todayMicroUsd: 300000, monthMicroUsd: 900000, today: 1, month: 3 } });
    expect(u.budget).toEqual({
      'ag-lead': { dayLeftMicroUsd: 1050000, monthLeftMicroUsd: 12300000, runMaxMicroUsd: 2000000, briefMaxMicroUsd: 500000, perTaskMicroUsd: 200000, tasks: 6, perBriefMicroUsd: null, briefs: 0 },
      'ag-bad': { dayLeftMicroUsd: null, monthLeftMicroUsd: null, runMaxMicroUsd: null, briefMaxMicroUsd: null, perTaskMicroUsd: null, tasks: null, perBriefMicroUsd: null, briefs: null },
    });
    expect(u.briefs).toEqual({ todayMicroUsd: 300000, monthMicroUsd: 900000, today: 1, month: 3 });
    // And observe carries them to the home desk, per agent and per desk.
    const desks = [{ id: 'd-w', name: 'Work', kind: 'work', vm: 'running' }] as never;
    const p = D.observePayload(desks, () => true, () => ({ agents: [{ id: 'ag-lead', name: 'Lead', status: 'online' } as never, { id: 'ag-x', name: 'X', status: 'online' } as never], approvals: [], todo: null, budget: u.budget, briefs: u.briefs }), false) as { desks: Record<string, unknown>[] };
    const agents = p.desks[0]?.['agents'] as Record<string, unknown>[];
    expect(agents[0]?.['budget']).toEqual(u.budget['ag-lead']);
    expect(agents[1]).not.toHaveProperty('budget');
    expect(p.desks[0]?.['briefs']).toEqual(u.briefs);
  });
  it('lives on the desk the desk names, else Personal', () => {
    const desks = [{ id: 'd-w', kind: 'work' }, { id: 'd-p', kind: 'personal' }, { id: 'd-g', kind: 'guild' }] as never;
    expect(D.pickHome(desks, null)?.id).toBe('d-p');
    expect(D.pickHome(desks, 'd-w')?.id).toBe('d-w');
    expect(D.pickHome(desks, 'd-g')?.id).toBe('d-p');
  });
});

// Her allowance's line, in the member's own time: pinned to Denver (UTC-7 in November) and en-US, at noon on Saturday Nov 14.
describe('allowanceLine', () => {
  const now = Date.parse('2026-11-14T19:00:00Z');
  const at = (resetsAt: unknown, reason: unknown = 'limit_personal', window: unknown = 'day'): string => D.allowanceLine({ reason, window, resetsAt }, now, 'en-US', 'America/Denver');
  const five = '5:00\u00a0PM';
  it('says which allowance, for each window, the trial and the shared pool', () => {
    const r = '2026-11-15T00:00:00Z';
    expect(at(r, 'limit_personal', 'day')).toBe(`You’ve used today’s Maia allowance. It resets at ${five}.`);
    expect(at(r, 'limit_personal', 'week')).toBe(`You’ve used this week’s Maia allowance. It resets at ${five}.`);
    expect(at(r, 'limit_personal', 'month')).toBe(`You’ve used this month’s Maia allowance. It renews at ${five}.`);
    expect(at(r, 'limit_personal', 'memberTrial')).toBe(`You’ve used Maia’s allowance for your trial. It resets at ${five}.`);
    expect(at(r, 'limit_trial', null)).toBe(`You’ve used Maia’s allowance for your trial. It resets at ${five}.`);
    expect(at(r, 'limit_pool', undefined)).toBe(`The allowance Maia shares across members is used up for now. It resets at ${five}.`);
    expect(at(r, 'limit_pool', null)).toBe(`The allowance Maia shares across members is used up for now. It resets at ${five}.`);
  });
  it('says the reset later today, tomorrow, on a weekday within six days, or on a date', () => {
    expect(at('2026-11-15T00:00:00Z')).toBe(`You’ve used today’s Maia allowance. It resets at ${five}.`);
    // The member's own day, not UTC's: 11:59 PM is still today in Denver, midnight is tomorrow.
    expect(at('2026-11-15T06:59:00Z')).toBe('You’ve used today’s Maia allowance. It resets at 11:59\u00a0PM.');
    expect(at('2026-11-15T07:00:00Z')).toBe('You’ve used today’s Maia allowance. It resets tomorrow at 12:00\u00a0AM.');
    expect(at('2026-11-16T00:00:00Z')).toBe(`You’ve used today’s Maia allowance. It resets tomorrow at ${five}.`);
    expect(at('2026-11-18T00:00:00Z')).toBe(`You’ve used today’s Maia allowance. It resets on Tuesday at ${five}.`);
    expect(at('2026-11-21T00:00:00Z')).toBe(`You’ve used today’s Maia allowance. It resets on Friday at ${five}.`);
    expect(at('2026-11-22T00:00:00Z')).toBe('You’ve used today’s Maia allowance. It resets on November 21.');
    expect(at('2026-12-01T07:00:00Z', 'limit_personal', 'month')).toBe('You’ve used this month’s Maia allowance. It renews on December 1.');
  });
  it('leaves the reset out when it’s past, missing or unreadable', () => {
    for (const bad of ['2026-11-14T18:00:00Z', '2026-11-14T19:00:00Z', undefined, null, '', 'soon', 1_763_168_400_000, 'x'.repeat(50)]) expect(at(bad)).toBe('You’ve used today’s Maia allowance.');
    expect(D.allowanceLine({ reason: 'limit_personal', window: 'day', resetsAt: '2026-11-15T00:00:00Z' }, now, 'en-US', 'Not/AZone')).toBe('You’ve used today’s Maia allowance.');
  });
  it('says “your Maia allowance for now” for a reason or window it doesn’t know, with its reset', () => {
    expect(at('2026-11-15T00:00:00Z', 'limit_galaxy', 'year')).toBe(`You’ve used your Maia allowance for now. It resets at ${five}.`);
    expect(at('2026-11-15T00:00:00Z', 'limit_personal', null)).toBe(`You’ve used your Maia allowance for now. It resets at ${five}.`);
    expect(D.allowanceLine({ window: 'day', resetsAt: '2026-11-15T00:00:00Z' }, now, 'en-US', 'America/Denver')).toBe(`You’ve used your Maia allowance for now. It resets at ${five}.`);
    expect(D.allowanceLine(null, now, 'en-US', 'America/Denver')).toBe('You’ve used your Maia allowance for now.');
    expect(D.allowanceLine('limit', now, 'en-US', 'America/Denver')).toBe('You’ve used your Maia allowance for now.');
  });
  it('is one plain line: no exclamation mark, no key, no button words', () => {
    const line = at('2026-11-18T00:00:00Z');
    expect(line).not.toMatch(/[!\n]|key|Use /);
  });
  it('says the month’s allowance renews, and the member’s own cap picks up again: a date or time, never a countdown', () => {
    expect(at('2026-12-01T07:00:00Z', 'limit_personal', 'month')).toBe('You’ve used this month’s Maia allowance. It renews on December 1.');
    expect(at('2026-11-15T07:00:00Z', 'limit_cap', 'day')).toBe('Maia has used the credits you set for today. She picks up again tomorrow at 12:00\u00a0AM.');
    expect(at(undefined, 'limit_cap', 'day')).toBe('Maia has used the credits you set for today.');
    for (const line of [at('2026-12-01T07:00:00Z', 'limit_personal', 'month'), at('2026-11-15T07:00:00Z', 'limit_cap', 'day'), at('2026-11-15T00:00:00Z')]) {
      expect(line).not.toMatch(/\bin \d|\d+\s*(h|hr|hours?|min|minutes?)\b|\$/);
    }
  });
});

// Her credits in the column's foot (contract 0.4.8; the owner, Nov 15): never money, never a countdown. Denver, en-US, noon Nov 14.
describe('her credits', () => {
  const now = Date.parse('2026-11-14T19:00:00Z');
  const credits = (drawingFrom: unknown, more: Record<string, unknown> = {}): Record<string, unknown> => ({ fraction: 0.62, resetsAt: '2026-12-01T07:00:00Z', usedUp: false, lighter: false, credits: { month: 2500, monthLeft: 1550, week: 800, weekUsed: 120, day: 200, dayUsed: 90, topUpLeft: 0, drawingFrom }, today: 12.5, cap: null, ...more });
  const lines = (raw: unknown): ReturnType<typeof allowanceLines> => allowanceLines(D.readAllowance(raw), now, 'en-US', 'America/Denver');
  const countdown = /\bin \d|\d+\s*(h|hr|hours?|min|minutes?)\b/;
  it('says what’s left of the month’s credits and when they renew, as a date', () => {
    expect(lines(credits('day'))).toEqual({ left: 'Maia credits: 1,550 of 2,500 left · renews December 1', note: null, cap: null });
  });
  it('says where she’s drawing from once today’s share is used: pace only', () => {
    expect(lines(credits('week')).note).toBe('Today’s share is used, so Maia is drawing on this week’s.');
    expect(lines(credits('month')).note).toBe('Today’s and this week’s shares are used, so Maia is drawing on this month’s.');
    const topUp = credits('topUp');
    (topUp['credits'] as Record<string, unknown>)['topUpLeft'] = 300;
    (topUp['credits'] as Record<string, unknown>)['monthLeft'] = 0;
    expect(lines(topUp)).toEqual({ left: 'Maia credits: 0 of 2,500 left · renews December 1', note: 'This month’s credits are used, so Maia is drawing on your top-up credits: 300 left.', cap: null });
    expect(lines(credits('somewhere')).note).toBeNull();
  });
  it('says plainly when she’s on a lighter model, until the month renews', () => {
    const lighter = credits('lighter', { lighter: true, fraction: 0 });
    (lighter['credits'] as Record<string, unknown>)['monthLeft'] = 0;
    expect(lines(lighter)).toEqual({ left: 'Maia credits: 0 of 2,500 left · renews December 1', note: 'Your Maia credits are used up, so Maia is on a lighter model until December 1.', cap: null });
    // By drawingFrom alone, and with a renewal it can't read.
    expect(lines(credits('lighter')).note).toBe('Your Maia credits are used up, so Maia is on a lighter model until December 1.');
    expect(lines(credits('lighter', { resetsAt: 'soon' })).note).toBe('Your Maia credits are used up, so Maia is on a lighter model until your credits renew.');
    // Renewing tomorrow, or later today: still a date or a time of day.
    expect(lines(credits('lighter', { resetsAt: '2026-11-15T07:00:00Z' })).note).toBe('Your Maia credits are used up, so Maia is on a lighter model until tomorrow.');
    expect(lines(credits('day', { resetsAt: '2026-11-15T00:00:00Z' })).left).toBe('Maia credits: 1,550 of 2,500 left · renews at 5:00\u00a0PM');
  });
  it('shows the day cap the member set, in credits', () => {
    expect(lines(credits('day', { today: 12.5, cap: 200 })).cap).toBe('Today 12.5 of your 200-credit cap');
    expect(lines(credits('day', { today: 1234.567, cap: 5000 })).cap).toBe('Today 1,234.57 of your 5,000-credit cap');
  });
  it('a tier that shares its allowance, or an older desk: the share left, or nothing', () => {
    expect(lines({ fraction: 0.62, resetsAt: '2026-11-15T00:00:00Z', usedUp: false, lighter: false, today: 0, cap: null })).toEqual({ left: 'Maia allowance: 62% left', note: null, cap: null });
    expect(lines({ fraction: 0.62, resetsAt: '2026-11-15T00:00:00Z', usedUp: true, today: 0, cap: null }).left).toBe('Maia allowance: 0% left');
    expect(lines({ today: 0, cap: null })).toEqual({ left: null, note: null, cap: null });
    expect(lines(undefined)).toEqual({ left: null, note: null, cap: null });
    expect(D.readAllowance(null)).toBeNull();
    // Credits out of their shape: none.
    expect(D.readAllowance({ fraction: 0.5, credits: { month: 'lots', monthLeft: -1 } })?.credits).toBeNull();
  });
  it('never says money, and never counts down', () => {
    for (const from of ['day', 'week', 'month', 'topUp', 'lighter']) {
      const l = lines(credits(from, { cap: 200, lighter: from === 'lighter' }));
      for (const line of [l.left, l.note, l.cap]) {
        expect(line ?? '').not.toContain('$');
        expect(line ?? '').not.toMatch(countdown);
        expect(line ?? '').not.toMatch(/[!]|USD|dollar/i);
      }
    }
  });
});

// The member's one wallet (contract 0.4.10, the coordinator's decision of Nov 15): Maia and their agents on MA's credits share
// one balance, spent month first, then starting, then top-ups. Denver, en-US, noon Nov 14.
describe('the one wallet', () => {
  const now = Date.parse('2026-11-14T19:00:00Z');
  const wallet = (drawingFrom: unknown, c: Record<string, unknown> = {}, more: Record<string, unknown> = {}): Record<string, unknown> => ({ fraction: 0.62, resetsAt: '2026-12-01T07:00:00Z', usedUp: false, lighter: false, credits: { left: 2060, month: 2500, monthLeft: 1550, week: 800, weekUsed: 120, day: 200, dayUsed: 90, starting: 210, topUpLeft: 300, drawingFrom, ...c }, today: 12.5, cap: null, ...more });
  const lines = (raw: unknown): ReturnType<typeof allowanceLines> => allowanceLines(D.readAllowance(raw), now, 'en-US', 'America/Denver');
  it('says what’s left in all, its renewal, and its parts: the month’s, starting, top-up', () => {
    expect(lines(wallet('day'))).toEqual({ left: 'Credits: 2,060 left · renews December 1', detail: '1,550 of this month’s 2,500 · 210 starting · 300 top-up', note: null, cap: null });
    expect(D.readAllowance(wallet('day'))?.credits).toMatchObject({ left: 2060, starting: 210, topUpLeft: 300 });
  });
  it('a tier with no monthly part: no month, no renewal', () => {
    expect(lines(wallet('starting', { left: 210, month: 0, monthLeft: 0, topUpLeft: 0 }))).toEqual({ left: 'Credits: 210 left', detail: '210 starting', note: 'This month’s credits are used, so your starting credits are in use: 210 left.', cap: null });
  });
  it('says what’s in use, never who, once today’s share is used: pace only', () => {
    expect(lines(wallet('week')).note).toBe('Today’s share is used, so this week’s is in use.');
    expect(lines(wallet('month')).note).toBe('Today’s and this week’s shares are used, so this month’s is in use.');
    expect(lines(wallet('starting', { monthLeft: 0 })).note).toBe('This month’s credits are used, so your starting credits are in use: 210 left.');
    expect(lines(wallet('topUp', { monthLeft: 0, starting: 0, left: 300 })).note).toBe('This month’s and your starting credits are used, so your top-up credits are in use: 300 left.');
  });
  it('says plainly when Maia and the agents are on the lighter model', () => {
    const lighter = lines(wallet('lighter', { left: 0, monthLeft: 0, starting: 0, topUpLeft: 0, lighterLeft: 12 }, { lighter: true, fraction: 0 }));
    expect(lighter).toEqual({ left: 'Credits: 0 left · renews December 1', detail: '0 of this month’s 2,500', note: 'Your credits are used up, so Maia and your agents are on a lighter model until December 1.', cap: null });
  });
  it('never says money and never counts down, whatever the wallet', () => {
    for (const from of ['day', 'week', 'month', 'starting', 'topUp', 'lighter']) {
      const l = lines(wallet(from, {}, { cap: 200, lighter: from === 'lighter' }));
      for (const line of [l.left, l.detail, l.note, l.cap]) {
        expect(line ?? '').not.toMatch(/\$|USD|dollar/i);
        expect(line ?? '').not.toMatch(/\bin \d|\d+\s*(h|hr|hours?|min|minutes?)\b/);
      }
    }
  });
  it('used up with no lighter share for the plan (`none`): a plain line, never the lighter model', () => {
    const none = lines(wallet('none', { left: 0, month: 0, monthLeft: 0, starting: 0, topUpLeft: 0 }, { lighter: true }));
    expect(none).toEqual({ left: 'Credits: 0 left', detail: null, note: 'Your credits are used up for now.', cap: null });
    expect(D.readAllowance(wallet('none', { left: 0 }, { lighter: true }))?.lighter).toBe(false);
    // A plan with no monthly part on the lighter model: no renewal to name.
    expect(lines(wallet('lighter', { left: 0, month: 0, monthLeft: 0, starting: 0, topUpLeft: 0 }, { lighter: true })).note).toBe('Your credits are used up, so Maia and your agents are on a lighter model for now.');
  });
  it('the wallet’s refusals: used up with no reset, and today’s lighter share with one', () => {
    expect(D.allowanceLine({ reason: 'credits_used', resetsAt: null }, now, 'en-US', 'America/Denver')).toBe('Your credits are used up for now.');
    expect(D.allowanceLine({ reason: 'limit_lighter', window: 'day', resetsAt: '2026-11-15T00:00:00Z' }, now, 'en-US', 'America/Denver')).toBe('Today’s lighter-model share is used up. It resets at 5:00\u00a0PM.');
  });
  it('an older desk (no left): Maia’s own credits, as before', () => {
    expect(lines(wallet('day', { left: undefined })).left).toBe('Maia credits: 1,550 of 2,500 left · renews December 1');
  });
});

describe('the source on a home desk', () => {
  it('reads the room and her thread, and observes what the office sees', async () => {
    const s = D.deskSource();
    await tick();
    expect(h.topics.has('agent.maia')).toBe(true);
    expect(h.topics.has('agent.conversation:maia')).toBe(true);
    h.topics.get('agent.maia')?.({ type: 'snapshot', seq: 1, on: true, connecting: false, todo: { items: [{ id: 'mi-1', kind: 'todos', urgency: 'next', deskId: 'd-w', title: '3 new to-dos on Work', action: { kind: 'show', deskId: 'd-w', app: 'todo', ref: 'needs_you' } }], later: { count: 0, lines: [] } } });
    h.topics.get('agent.conversation:maia')?.({ type: 'snapshot', seq: 1, messages: [{ id: 'm1', role: 'assistant', text: 'Hello', at: 1, state: 'done' }] });
    expect(s.get().link).toBe('ready');
    expect(s.get().attention[0]?.go).toEqual({ kind: 'view', app: 'todo', ref: 'needs_you' });
    expect(s.get().messages.map((m) => m.text)).toEqual(['Hello']);
    await new Promise((r) => setTimeout(r, 600));
    const observe = h.calls.find((c) => c.method === 'agent.maia.observe');
    expect((observe?.params['desks'] as { deskId: string }[]).map((d) => d.deskId)).toEqual(['d-p', 'd-w']);
    expect(observe?.idem).toBeUndefined();
    s.close();
  });
  it('marks how each line came: the thread it opened on is just there, a new or still-written reply glides, a republish keeps it', async () => {
    const s = D.deskSource();
    await tick();
    const conv = h.topics.get('agent.conversation:maia')!;
    conv({ type: 'snapshot', seq: 1, messages: [{ id: 'm1', role: 'assistant', text: 'Hello', at: 1, state: 'done' }, { id: 'm2', role: 'assistant', text: 'Still', at: 2, state: 'streaming' }] });
    const live = (id: string): boolean | undefined => s.get().messages.find((m) => m.id === id)?.live;
    expect(live('m1')).toBe(false);
    expect(live('m2')).toBe(true);
    conv({ type: 'message', seq: 2, message: { id: 'm3', role: 'assistant', text: '', at: 3, state: 'streaming' } });
    conv({ type: 'delta', seq: 3, messageId: 'm3', runId: 'r', text: 'Welcome. I’m glad you’re here.' });
    expect(live('m3')).toBe(true);
    conv({ type: 'delta', seq: 4, messageId: 'm4', runId: 'r', text: 'A reply first seen by its words.' });
    expect(live('m4')).toBe(true);
    // Her old reply republished (its choices answered): it doesn't glide again.
    conv({ type: 'message', seq: 5, message: { id: 'm1', role: 'assistant', text: 'Hello', at: 1, state: 'done' } });
    expect(live('m1')).toBe(false);
    // A reconnect's snapshot keeps each line as it came.
    conv({ type: 'snapshot', seq: 6, messages: [{ id: 'm1', role: 'assistant', text: 'Hello', at: 1, state: 'done' }, { id: 'm3', role: 'assistant', text: 'Welcome. I’m glad you’re here.', at: 3, state: 'done' }] });
    expect(live('m1')).toBe(false);
    expect(live('m3')).toBe(true);
    s.close();
  });
  it('sends with idem, answers a choice, saves her access when the desk asks for setup, and turns off', async () => {
    let first = true;
    h.answers.set('agent.message.send', () => {
      if (first) {
        first = false;
        throw Object.assign(new Error('setup'), { code: 'precondition_failed', details: { reason: 'setup' } });
      }
      return { messageId: 'm-9', runId: 'r-1' };
    });
    const s = D.deskSource();
    await tick();
    s.send('Compare three laptops', { choices: 'm1:choices', as: 'other' });
    await tick();
    await tick();
    const sends = h.calls.filter((c) => c.method === 'agent.message.send');
    expect(sends).toHaveLength(2);
    expect(sends[1]?.params).toEqual({ agentId: 'maia', text: 'Compare three laptops', choice: { messageId: 'm1', other: true } });
    expect(sends.every((c) => typeof c.idem === 'string')).toBe(true);
    const access = h.calls.find((c) => c.method === 'agent.access.set');
    expect(access?.params).toEqual({ agentId: 'maia', apps: { notebook: true, files: false, browser: false, courier: false, todos: true }, auto: { notebook: { tabId: 'tab-1' }, files: null, todos: true } });
    expect(s.get().messages.at(-1)).toMatchObject({ id: 'm-9', from: 'member' });
    s.choose('m1', 'c2');
    s.undoNote('ap-1');
    s.snooze('mi-1');
    s.setOn(false);
    await tick();
    expect(h.calls.filter((c) => c.idem).map((c) => [c.method, c.params])).toEqual(expect.arrayContaining([
      ['agent.maia.choose', { messageId: 'm1', choiceId: 'c2' }],
      ['agent.approval.undo', { approvalId: 'ap-1' }],
      ['agent.maia.item.snooze', { itemId: 'mi-1' }],
      ['agent.maia.set', { on: false }],
    ]));
    s.typing(true);
    s.seen(true);
    expect(h.calls.filter((c) => !c.idem && (c.method === 'agent.maia.typing' || c.method === 'agent.maia.seen')).map((c) => c.params)).toEqual([{ typing: true }, { back: true }]);
    s.close();
  });
  it('a message refused at her day’s limit says so, not “try again” (release 4’s B7)', async () => {
    h.answers.set('agent.message.send', () => {
      throw Object.assign(new Error('limit_reached'), { code: 'precondition_failed', details: { reason: 'limit_reached' } });
    });
    const s = D.deskSource();
    await tick();
    s.send('Hello Maia');
    await tick();
    await tick();
    expect(s.get().problem).toEqual({ line: 'You’ve used your Maia allowance for now.', action: null });
    s.close();
  });
  it('a send refused because her AI service isn’t offered says so plainly, once, with no button, and keeps nothing to send later', async () => {
    h.answers.set('agent.message.send', () => {
      throw Object.assign(new Error('no_service'), { code: 'unavailable', details: { reason: 'no_service' } });
    });
    h.answers.set('agent.maia.choose', () => {
      throw Object.assign(new Error('no_service'), { code: 'unavailable', details: { reason: 'no_service' } });
    });
    const s = D.deskSource();
    await tick();
    s.send('Hello Maia');
    for (let i = 0; i < 4; i += 1) await tick();
    expect(s.get().problem).toEqual({ line: 'Maia isn’t available right now. Try again in a few minutes.', action: null });
    // An answer, not a lost reply: not asked again.
    expect(h.calls.filter((c) => c.method === 'agent.message.send')).toHaveLength(1);
    expect(s.get().messages).toEqual([]);
    s.choose('m1', 'c1');
    for (let i = 0; i < 4; i += 1) await tick();
    expect(h.calls.filter((c) => c.method === 'agent.maia.choose')).toHaveLength(1);
    expect(s.get().problem?.line).toBe('Maia isn’t available right now. Try again in a few minutes.');
    // Fine again: the next words go, and nothing refused before goes with them.
    h.answers.set('agent.message.send', () => ({ messageId: 'm-2', runId: 'r-2' }));
    s.send('Are you there?');
    for (let i = 0; i < 4; i += 1) await tick();
    expect(h.calls.filter((c) => c.method === 'agent.message.send').map((c) => c.params['text'])).toEqual(['Hello Maia', 'Are you there?']);
    expect(s.get().problem).toBeNull();
    s.close();
  });
  it('a send refused for an older disclosure asks for the current one, keeps nothing to send later, and stops asking once it’s on', async () => {
    h.prefs = { on: true, disclosure: { version: 2, at: 'x' }, home: 'd-p' };
    h.answers.set('agent.message.send', () => {
      throw Object.assign(new Error('disclosure'), { code: 'precondition_failed', details: { reason: 'disclosure' } });
    });
    const s = D.deskSource();
    await tick();
    expect(s.get().disclosure).toBe(false);
    s.send('Hello Maia');
    for (let i = 0; i < 4; i += 1) await tick();
    expect(s.get().disclosure).toBe(true);
    expect(s.get().problem).toBeNull();
    // This browser's acceptance goes too, so the switch reads off until the member accepts the current one.
    expect(h.saved).toContainEqual({ disclosure: null });
    expect(h.prefs['disclosure']).toBeNull();
    expect(h.calls.filter((c) => c.method === 'agent.message.send')).toHaveLength(1);
    h.answers.set('agent.message.send', () => ({ messageId: 'm-1', runId: 'r-1' }));
    await expect(s.setOn(true)).resolves.toBe(true);
    expect(h.calls.find((c) => c.method === 'agent.maia.set')?.params).toEqual({ on: true, disclosure: 'maia-mode-v2', homeDeskId: 'd-p' });
    expect(s.get().disclosure).toBe(false);
    for (let i = 0; i < 4; i += 1) await tick();
    // The refused words were never kept: the member sends them again.
    expect(h.calls.filter((c) => c.method === 'agent.message.send')).toHaveLength(1);
    expect(s.get().messages).toEqual([]);
    s.close();
  });
  it('an ask the desk then refuses to turn on is said, and the next refusal asks again', async () => {
    h.answers.set('agent.message.send', () => {
      throw Object.assign(new Error('disclosure'), { code: 'precondition_failed', details: { reason: 'disclosure' } });
    });
    h.answers.set('agent.maia.set', () => {
      throw Object.assign(new Error('tier'), { code: 'forbidden', details: { reason: 'tier' } });
    });
    const s = D.deskSource();
    await tick();
    s.send('Hello Maia');
    for (let i = 0; i < 4; i += 1) await tick();
    expect(s.get().disclosure).toBe(true);
    await expect(s.setOn(true)).resolves.toBe(false);
    expect(s.get().disclosure).toBe(false);
    expect(s.get().problem?.line).toBe('Maia isn’t available on your home desk.');
    s.send('Hello again');
    for (let i = 0; i < 4; i += 1) await tick();
    expect(s.get().disclosure).toBe(true);
    s.close();
  });
  it('a choice refused for an older disclosure asks for the current one too', async () => {
    h.answers.set('agent.maia.choose', () => {
      throw Object.assign(new Error('disclosure'), { code: 'precondition_failed', details: { reason: 'disclosure' } });
    });
    const s = D.deskSource();
    await tick();
    s.choose('m1', 'c2');
    for (let i = 0; i < 4; i += 1) await tick();
    expect(s.get().disclosure).toBe(true);
    s.close();
  });
  it('never asks for a key for her: no key offer, no bind and no key line are left', () => {
    const code = readFileSync(new URL('./deskSource.ts', import.meta.url), 'utf8');
    for (const gone of [/no_key/, /agent\.bind/, /keyFix|needKey/, /\bowed\b/, /’s key/, /Add a key/, /API key/]) expect(code).not.toMatch(gone);
  });
  it('turns on with the accepted disclosure and the home desk, saves her access, and keeps where she lives', async () => {
    h.answers.set('agent.maia.get', () => ({ maia: { on: false, home: { deskId: 'd-p' }, notesTabId: 'tab-1' } }));
    const s = D.deskSource();
    const done = s.setOn(true);
    await tick();
    await expect(done).resolves.toBe(true);
    const set = h.calls.find((c) => c.method === 'agent.maia.set');
    expect(set?.params).toEqual({ on: true, disclosure: 'maia-mode-v2', homeDeskId: 'd-p' });
    expect(D.DISCLOSURE_ID).toBe('maia-mode-v2');
    expect(typeof set?.idem).toBe('string');
    expect(h.calls.some((c) => c.method === 'agent.access.set')).toBe(true);
    expect(h.saved).toContainEqual({ home: 'd-p' });
    s.close();
  });
  it('never turns the desk back on from this browser’s prefs: the room follows the desk (MR-M1)', async () => {
    h.prefs = { on: true, disclosure: { version: 2, at: 'x' }, home: 'd-p' };
    h.answers.set('agent.maia.get', () => ({ maia: { on: false, home: { deskId: 'd-p' } } }));
    const s = D.deskSource();
    await tick();
    await tick();
    expect(h.calls.some((c) => c.method === 'agent.maia.set')).toBe(false);
    expect(s.get().deskOff).toBe(true);
    s.close();
  });
  it('turns off on the home desk the prefs name, and deletes the history there', async () => {
    h.prefs = { home: 'd-p' };
    const s = D.deskSource();
    await expect(s.setOn(false)).resolves.toBe(true);
    await expect(s.forget()).resolves.toBe(true);
    expect(h.calls.filter((c) => c.idem).map((c) => [c.method, c.params])).toEqual([
      ['agent.maia.set', { on: false }],
      ['agent.maia.forget', {}],
    ]);
    s.close();
  });
  it('a home desk its switch doesn’t list says so, and isn’t taken for the member’s off (§23 not_listed)', async () => {
    h.prefs = { on: true, disclosure: { version: 2, at: 'x' } };
    h.answers.set('agent.maia.get', () => ({ maia: { on: false, listed: false, killed: false, home: { deskId: 'd-p' } } }));
    const s = D.deskSource();
    await tick();
    await tick();
    expect(s.get().deskOff).toBe(false);
    expect(s.get().problem?.line).toBe('Maia isn’t on your home desk yet.');
    h.topics.get('agent.maia')?.({ type: 'snapshot', seq: 1, on: false, listed: false, killed: false });
    expect(s.get().deskOff).toBe(false);
    expect(s.get().problem?.line).toBe('Maia isn’t on your home desk yet.');
    expect(h.calls.some((c) => c.method === 'agent.maia.set')).toBe(false);
    s.close();
  });
  it('says plainly when her home desk has Maia Mode switched off', async () => {
    const s = D.deskSource();
    await tick();
    h.topics.get('agent.maia')?.({ type: 'snapshot', seq: 2, on: false, killed: true });
    expect(s.get().problem?.line).toBe('Maia is switched off on your home desk.');
    s.close();
  });
});
