// The mock desk's To-do against deskd's API.md §22, so the window's tests run against the store's contract and not a guess.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockTodoDesk } from './mockDeskTodo';

const DAY = 24 * 3600 * 1000;
// Thursday, Nov 12 2026, 10:00 in Denver.
const NOW = Date.UTC(2026, 10, 12, 17, 0);
let n = 0;
const idem = (): string => `00000000-0000-7000-8000-${String((n += 1)).padStart(12, '0')}`;

function desk(): MockTodoDesk {
  return new MockTodoDesk('d-t', { now: () => NOW, zone: 'America/Denver' });
}
type Rec = Record<string, unknown>;
const call = (d: MockTodoDesk, m: string, p: Rec = {}, key: string | undefined = m === 'todo.list' || m === 'todo.get' || m === 'todo.summary' || m === 'todo.changes' ? undefined : idem()): Promise<Rec> => d.answer(m, p, key) as Promise<Rec>;
const ids = (r: Rec): string[] => (r['items'] as { title: string }[]).map((i) => i.title);
const fails = async (p: Promise<unknown>): Promise<{ code: string; details: Rec }> => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; details: Rec };
  }
  throw new Error('it did not refuse');
};

beforeEach(() => {
  vi.stubGlobal('window', globalThis);
});

describe('Needs you (§22)', () => {
  it('holds open, unsnoozed items that are overdue, due today or pinned, in that order, five at most, with more and the footer', async () => {
    const d = desk();
    d.put({ title: 'later', due: { date: '2026-11-20', time: null, by: 'member' } });
    d.put({ title: 'today plain', due: { date: '2026-11-12', time: null, by: 'member' }, createdAt: NOW - 5 });
    d.put({ title: 'today 15', due: { date: '2026-11-12', time: '15:00', by: 'member' } });
    d.put({ title: 'today 09', due: { date: '2026-11-12', time: '09:00', by: 'member' } });
    d.put({ title: 'overdue old', due: { date: '2026-11-01', time: null, by: 'member' } });
    d.put({ title: 'overdue new', due: { date: '2026-11-10', time: null, by: 'member' } });
    d.put({ title: 'kept early', pinned: true, pinnedAt: NOW - 100 });
    d.put({ title: 'kept late', pinned: true, pinnedAt: NOW - 10 });
    d.put({ title: 'snoozed', due: { date: '2026-11-12', time: null, by: 'member' }, snoozedUntil: NOW + DAY });
    d.put({ title: 'closed', due: { date: '2026-11-12', time: null, by: 'member' }, state: 'done', closed: { at: NOW, by: 'member' } });
    d.agentAdd({ title: 'new from inbox', by: 'agent:inbox', source: { kind: 'courier', ref: { messageId: 'm' }, label: 'Email' } });
    const r = await call(d, 'todo.list', { view: 'needs_you' });
    expect(ids(r)).toEqual(['overdue old', 'overdue new', 'today 09', 'today 15', 'today plain']);
    expect(r['more']).toBe(2);
    expect(r['footer']).toEqual({ newFromAgents: 1, toConfirm: 0 });
    expect(r['today']).toBe('2026-11-12');
    expect(r['zone']).toBe('America/Denver');
  });

  it('kept ones come latest pin first', async () => {
    const d = desk();
    d.put({ title: 'kept early', pinned: true, pinnedAt: NOW - 100 });
    d.put({ title: 'kept late', pinned: true, pinnedAt: NOW - 10 });
    expect(ids(await call(d, 'todo.list', { view: 'needs_you' }))).toEqual(['kept late', 'kept early']);
  });

  it('summary: the counts, and badge is overdue plus due today', async () => {
    const d = desk();
    d.put({ title: 'a', due: { date: '2026-11-11', time: null, by: 'member' } });
    d.put({ title: 'b', due: { date: '2026-11-12', time: null, by: 'member' } });
    d.put({ title: 'c', due: { date: '2026-11-13', time: null, by: 'member' } });
    d.put({ title: 'd', pinned: true });
    const s = await call(d, 'todo.summary');
    expect(s).toMatchObject({ open: 4, needsYou: 3, overdue: 1, dueToday: 1, badge: 2, today: '2026-11-12', zone: 'America/Denver' });
  });
});

describe('the item, the views and the filters', () => {
  it("open's group, deskd's judgment in the desk's zone, and the views' orders", async () => {
    const d = desk();
    d.put({ title: 'none' });
    d.put({ title: 'up', due: { date: '2026-11-14', time: null, by: 'member' } });
    d.put({ title: 'over', due: { date: '2026-11-02', time: null, by: 'member' } });
    d.put({ title: 'snz', snoozedUntil: NOW + DAY });
    const r = await call(d, 'todo.list', { view: 'open' });
    expect((r['items'] as { title: string; group: string }[]).map((i) => [i.title, i.group])).toEqual([
      ['over', 'overdue'],
      ['up', 'upcoming'],
      ['none', 'no_date'],
      ['snz', 'snoozed'],
    ]);
  });

  it('by, source and q (every word, by prefix) filter; limit and next page', async () => {
    const d = desk();
    d.put({ title: 'Sign the lease renewal' });
    d.agentAdd({ title: 'Pay the water bill', by: 'agent:inbox', source: { kind: 'courier', ref: { messageId: 'x' }, label: 'Email' } });
    d.agentAdd({ title: 'Renew the domain', by: 'agent:scout', source: { kind: 'browser', ref: { url: 'https://example.com' }, label: 'Page' } });
    expect(ids(await call(d, 'todo.list', { view: 'open', by: 'agents' }))).toEqual(['Pay the water bill', 'Renew the domain']);
    expect(ids(await call(d, 'todo.list', { view: 'open', by: 'member' }))).toEqual(['Sign the lease renewal']);
    expect(ids(await call(d, 'todo.list', { view: 'open', source: 'courier' }))).toEqual(['Pay the water bill']);
    expect(ids(await call(d, 'todo.list', { view: 'open', q: 'ren' }))).toEqual(['Sign the lease renewal', 'Renew the domain']);
    expect(ids(await call(d, 'todo.list', { view: 'open', q: 'lea ren' }))).toEqual(['Sign the lease renewal']);
    const p1 = await call(d, 'todo.list', { view: 'open', limit: 2 });
    expect((p1['items'] as unknown[]).length).toBe(2);
    const p2 = await call(d, 'todo.list', { view: 'open', limit: 2, cursor: p1['next'] });
    expect(ids(p2)).toEqual(['Renew the domain']);
    expect(p2['next']).toBeNull();
    expect((await fails(call(d, 'todo.list', { view: 'open', limit: 101 }))).code).toBe('bad_request');
    expect((await fails(call(d, 'todo.list', { view: 'nope' }))).details).toEqual({ reason: 'view' });
  });

  it('a title is one line with no hidden characters, 1 to 200; a member add is the member’s', async () => {
    const d = desk();
    const { item } = (await call(d, 'todo.add', { title: '  Call\nthe \u202ebank\u200b  ' })) as { item: Rec };
    expect(item).toMatchObject({ title: 'Call the bank', by: 'member', source: { kind: 'member', ref: null }, state: 'open', seen: true, pinned: false, closed: null });
    expect((await fails(call(d, 'todo.add', { title: '' }))).details).toEqual({ reason: 'title' });
    expect((await fails(call(d, 'todo.add', { title: 'x'.repeat(201) }))).code).toBe('bad_request');
  });
});

describe('rev, idem and the refusals', () => {
  it('rev is one desk-wide counter; update names it, and a moved one is precondition_failed with the rev', async () => {
    const d = desk();
    const a = (await call(d, 'todo.add', { title: 'a' }))['item'] as { id: string; rev: number };
    const b = (await call(d, 'todo.add', { title: 'b' }))['item'] as { id: string; rev: number };
    expect(b.rev).toBe(a.rev + 1);
    const e = await fails(call(d, 'todo.update', { id: a.id, rev: a.rev - 1, title: 'x' }));
    expect(e).toMatchObject({ code: 'precondition_failed', details: { reason: 'rev', rev: a.rev } });
    const u = (await call(d, 'todo.update', { id: a.id, rev: a.rev, title: 'a2' }))['item'] as { rev: number; title: string };
    expect(u).toMatchObject({ title: 'a2', rev: b.rev + 1 });
  });

  it('the same idem answers the same result once; with other params it is conflict idem', async () => {
    const d = desk();
    const key = idem();
    const one = await call(d, 'todo.add', { title: 'once' }, key);
    const two = await call(d, 'todo.add', { title: 'once' }, key);
    expect(two).toBe(one);
    expect(ids(await call(d, 'todo.list', { view: 'open' }))).toEqual(['once']);
    expect((await fails(call(d, 'todo.add', { title: 'other' }, key))).details).toEqual({ reason: 'idem' });
    expect((await fails(call(d, 'todo.add', { title: 'no key' }, ''))).code).toBe('bad_request');
  });

  it('closed, trashed and no_suggestion are conflicts; a closed close changes nothing', async () => {
    const d = desk();
    const it = (await call(d, 'todo.add', { title: 't' }))['item'] as { id: string; rev: number };
    const closed = (await call(d, 'todo.close', { id: it.id, as: 'done' }))['item'] as { rev: number; closed: { by: string } };
    expect(closed.closed.by).toBe('member');
    expect(((await call(d, 'todo.close', { id: it.id, as: 'done' }))['item'] as { rev: number }).rev).toBe(closed.rev);
    expect((await fails(call(d, 'todo.update', { id: it.id, rev: closed.rev, title: 'x' }))).details).toEqual({ reason: 'closed' });
    expect((await fails(call(d, 'todo.answer', { id: it.id, accept: true }))).details).toEqual({ reason: 'no_suggestion' });
    await call(d, 'todo.trash', { id: it.id });
    expect((await fails(call(d, 'todo.reopen', { id: it.id }))).details).toEqual({ reason: 'trashed' });
    await call(d, 'todo.restore', { id: it.id });
    expect((await fails(call(d, 'todo.get', { id: 'nope' }))).details).toEqual({ reason: 'id' });
  });

  it('the cap on open items is conflict cap open', async () => {
    const d = desk();
    for (let i = 0; i < 2000; i += 1) d.put({ title: `t${i}` });
    expect((await fails(call(d, 'todo.add', { title: 'one more' }))).details).toEqual({ reason: 'cap', which: 'open' });
  });
});

describe('suggestions, Undo, seen and changes', () => {
  it('answer: accept closes as suggested, by the member; Not yet clears it', async () => {
    const d = desk();
    const a = d.agentAdd({ title: 'Pay', by: 'agent:inbox', source: { kind: 'courier', ref: { messageId: '1' }, label: 'Email' } });
    d.suggest(a.id, 'done', 'agent:inbox', 'found a receipt');
    expect(((await call(d, 'todo.list', { view: 'needs_you' }))['footer'] as Rec)['toConfirm']).toBe(1);
    const yes = (await call(d, 'todo.answer', { id: a.id, accept: true }))['item'] as Rec;
    expect(yes).toMatchObject({ state: 'done', suggestion: null, closed: { by: 'member' } });
    const b = d.agentAdd({ title: 'Book', by: 'agent:inbox', source: { kind: 'courier', ref: { messageId: '2' }, label: 'Email' } });
    d.suggest(b.id, 'not_needed', 'agent:inbox', 'cancelled');
    expect((await call(d, 'todo.answer', { id: b.id, accept: false }))['item']).toMatchObject({ state: 'open', suggestion: null });
  });

  it("undo puts an event's before back while its after still holds, else conflict changed; an add's undo closes it not needed", async () => {
    const d = desk();
    const it = (await call(d, 'todo.add', { title: 'one' }))['item'] as { id: string; rev: number };
    const two = (await call(d, 'todo.update', { id: it.id, rev: it.rev, title: 'two' }))['item'] as { rev: number };
    const edit = ((await call(d, 'todo.get', { id: it.id }))['events'] as { id: string; op: string }[])[0]!;
    expect(edit.op).toBe('edit');
    await call(d, 'todo.update', { id: it.id, rev: two.rev, title: 'three' });
    expect((await fails(call(d, 'todo.undo', { eventId: edit.id }))).details).toEqual({ reason: 'changed' });
    const last = ((await call(d, 'todo.get', { id: it.id }))['events'] as { id: string }[])[0]!;
    expect(((await call(d, 'todo.undo', { eventId: last.id }))['item'] as { title: string }).title).toBe('two');
    const events = (await call(d, 'todo.get', { id: it.id }))['events'] as { id: string; op: string }[];
    expect(events.map((e) => e.op)).toEqual(['undo', 'edit', 'edit', 'add']);
    const add = events.at(-1)!;
    expect((await call(d, 'todo.undo', { eventId: add.id }))['item']).toMatchObject({ state: 'not_needed' });
    expect((await fails(call(d, 'todo.undo', { eventId: 'nope' }))).details).toEqual({ reason: 'event' });
  });

  it('seen marks agent items, and the topic and todo.changes say what moved', async () => {
    const d = desk();
    const heard: Rec[] = [];
    d.subscribe((m) => heard.push(m));
    const start = d.currentRev;
    const a = d.agentAdd({ title: 'New', by: 'agent:inbox', source: { kind: 'courier', ref: { messageId: '1' }, label: 'Email' } });
    expect(a.seen).toBe(false);
    await call(d, 'todo.seen', { ids: [a.id, 'not-an-item'] });
    expect(((await call(d, 'todo.get', { id: a.id }))['item'] as { seen: boolean }).seen).toBe(true);
    expect(heard.map((h) => h['op'])).toEqual(['add', 'seen']);
    const ch = await call(d, 'todo.changes', { since: start });
    expect(ch).toMatchObject({ reset: false, rev: d.currentRev, changes: [{ id: a.id, op: 'add' }, { id: a.id, op: 'seen' }] });
  });

  it('snooze takes ms within 400 days, or null to wake it; pin is the member’s', async () => {
    const d = desk();
    const it = (await call(d, 'todo.add', { title: 's', due: { date: '2026-11-12' } }))['item'] as { id: string };
    expect((await fails(call(d, 'todo.snooze', { id: it.id, until: NOW + 401 * DAY }))).details).toEqual({ reason: 'until' });
    await call(d, 'todo.snooze', { id: it.id, until: NOW + DAY });
    expect(ids(await call(d, 'todo.list', { view: 'needs_you' }))).toEqual([]);
    await call(d, 'todo.snooze', { id: it.id, until: null });
    expect(ids(await call(d, 'todo.list', { view: 'needs_you' }))).toEqual(['s']);
  });
});
