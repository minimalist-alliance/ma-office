// To-do's adapter over a desk link, against the mock desk (deskd API.md §22): what it sends, how it reads, one `idem` across a
// lost reply, a stale `rev` sent again with only the member's fields, the refusals it names, and the export over `bulk`.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulkChannel, DeskLink } from '../../desk/deskLink';
import { MockBulk, newDataControl } from '../../desk/mockDeskData';
import { MockTodoDesk } from '../../desk/mockDeskTodo';
import { rebase, rpcTodoClient, toTodoError, type Item } from './client';

const NOW = Date.UTC(2026, 10, 12, 17, 0);
let keys = 0;
const idem = (): string => `00000000-0000-7000-8000-${String((keys += 1)).padStart(12, '0')}`;

interface Fake {
  link: DeskLink;
  desk: MockTodoDesk;
  sent: { m: string; p: Record<string, unknown>; idem?: string }[];
  /** The next reply of this method is lost after the desk did it (the session dropped on the way back). */
  loseNext: Set<string>;
}

function fake(): Fake {
  const desk = new MockTodoDesk('d-a', { now: () => NOW, zone: 'America/Denver' });
  const bulk = new MockBulk(newDataControl(), () => undefined);
  const sent: Fake['sent'] = [];
  const loseNext = new Set<string>();
  const link = {
    deskId: 'd-a',
    call: async (m: string, p: Record<string, unknown> = {}, o?: { idem?: string }) => {
      sent.push({ m, p, ...(o?.idem ? { idem: o.idem } : {}) });
      const r = await desk.answer(m, p, o?.idem, bulk);
      if (loseNext.delete(m)) throw Object.assign(new Error('lost'), { code: 'deadline_exceeded', details: {} });
      return r;
    },
    bulk: (): BulkChannel => bulk,
    subscribe: (_t: string, fn: (m: unknown) => void) => desk.subscribe((e) => fn({ seq: 1, ...e })),
  } as unknown as DeskLink;
  return { link, desk, sent, loseNext };
}

beforeEach(() => {
  vi.stubGlobal('window', globalThis);
});

describe('reads', () => {
  it('lists every page of a view, 100 at a time, and reads the footer, today and zone', async () => {
    const f = fake();
    for (let i = 0; i < 230; i += 1) f.desk.put({ title: `t${i}` });
    const c = rpcTodoClient(f.link, idem);
    const all = await c.listAll({ view: 'open' });
    expect(all.items).toHaveLength(230);
    expect(f.sent.filter((s) => s.m === 'todo.list').map((s) => s.p['limit'])).toEqual([100, 100, 100]);
    const needs = await c.list({ view: 'needs_you' });
    expect(f.sent.at(-1)!.p).toEqual({ view: 'needs_you' });
    expect(needs).toMatchObject({ today: '2026-11-12', zone: 'America/Denver', more: 0, newFromAgents: 0, toConfirm: 0 });
    expect(await c.summary()).toMatchObject({ open: 230, badge: 0 });
  });

  it('a deskd before §22 (not_found with no reason) is `old`; a missing item is not_found; a cap is `cap`', async () => {
    expect(toTodoError(Object.assign(new Error(), { code: 'not_found', details: {} })).code).toBe('old');
    expect(toTodoError(Object.assign(new Error(), { code: 'not_found', details: { reason: 'item' } })).code).toBe('not_found');
    expect(toTodoError(Object.assign(new Error(), { code: 'conflict', details: { reason: 'cap', which: 'open' } })).code).toBe('cap');
    expect(toTodoError(Object.assign(new Error(), { name: 'DeskNotConnected' })).code).toBe('offline');
  });
});

describe('a source from another desk', () => {
  it('keeps kind desk, so its source line and its untrusted mark show (a kind it doesn’t know reads as the member’s)', async () => {
    const { readSource } = await import('./wire');
    expect(readSource({ kind: 'desk', ref: { deskId: 'd-work', messageId: 'env-1' }, label: 'Message from Lead on another of your desks' })).toEqual({
      kind: 'desk',
      ref: { deskId: 'd-work', messageId: 'env-1' },
      label: 'Message from Lead on another of your desks',
    });
    const { sourceNoun, openWhere } = await import('./words');
    expect(sourceNoun('desk')).toBe('a message another of your desks sent');
    const { W } = await import('./words');
    expect(W.untrusted(sourceNoun('desk'))).toBe('Made from a message another of your desks sent. Check it before you act on it.');
    expect(openWhere('desk')).toBe('the Agent');
  });
});

describe('writes', () => {
  it('a lost reply is asked again with the same idem, and the desk does it once', async () => {
    const f = fake();
    const c = rpcTodoClient(f.link, idem);
    f.loseNext.add('todo.add');
    const item = await c.add('Call the bank', { date: '2026-11-13' });
    expect(item.title).toBe('Call the bank');
    const adds = f.sent.filter((s) => s.m === 'todo.add');
    expect(adds).toHaveLength(2);
    expect(adds[0]!.idem).toBe(adds[1]!.idem);
    expect(adds[0]!.p).toEqual({ title: 'Call the bank', due: { date: '2026-11-13' } });
    expect((await c.listAll({ view: 'open' })).items).toHaveLength(1);
  });

  it('a stale rev reads the item again and sends only the member’s fields onto the newest copy', async () => {
    const f = fake();
    const c = rpcTodoClient(f.link, idem);
    const seen = await c.add('Old title');
    // Elsewhere (another device), the note changes.
    const other = rpcTodoClient(f.link, idem);
    await other.update(seen, { note: 'from the phone' });
    const done = await c.update(seen, { title: 'New title' });
    expect(done).toMatchObject({ title: 'New title', note: 'from the phone' });
    const updates = f.sent.filter((s) => s.m === 'todo.update');
    expect(updates.at(-1)!.p).toEqual({ id: seen.id, rev: done.rev - 1, title: 'New title' });
  });

  it('rebase keeps only what the member changed from what they saw', () => {
    const base = { title: 'a', note: null, due: { date: '2026-11-12', time: null, by: 'member' } } as unknown as Item;
    expect(rebase(base, { title: 'a', note: null, due: { date: '2026-11-12' } })).toEqual({});
    expect(rebase(base, { title: 'b' })).toEqual({ title: 'b' });
    expect(rebase(base, { due: null })).toEqual({ due: null });
  });

  it('every mutation goes with an idem; a refusal is not retried', async () => {
    const f = fake();
    const c = rpcTodoClient(f.link, idem);
    const it0 = await c.add('t');
    await c.close(it0.id, 'done');
    await c.reopen(it0.id);
    await c.pin(it0.id, true);
    await c.snooze(it0.id, NOW + 3600_000);
    await c.trash(it0.id);
    await c.restore(it0.id);
    const writes = f.sent.filter((s) => !['todo.list', 'todo.get', 'todo.summary'].includes(s.m));
    expect(writes.every((w) => typeof w.idem === 'string')).toBe(true);
    const before = f.sent.length;
    await expect(c.answer(it0.id, true)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'no_suggestion' } });
    expect(f.sent.length).toBe(before + 1);
  });

  it('seen sends the ids it is given, and nothing for none', async () => {
    const f = fake();
    const c = rpcTodoClient(f.link, idem);
    await c.seen([]);
    expect(f.sent).toHaveLength(0);
    const a = f.desk.agentAdd({ title: 'n', by: 'agent:inbox', source: { kind: 'courier', ref: { messageId: '1' }, label: 'Email' } });
    await c.seen([a.id]);
    // A mutation, so it goes with an idem, and the desk takes it (Security's TDA-L3).
    expect(f.sent[0]).toMatchObject({ m: 'todo.seen', p: { ids: [a.id] }, idem: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect((await c.get(a.id)).item?.seen).toBe(true);
  });
});

describe('the export', () => {
  it('comes over bulk, credited as read, to its END, as a Markdown checklist', async () => {
    const f = fake();
    f.desk.put({ title: 'Open one' });
    f.desk.put({ title: 'Done one', state: 'done', closed: { at: NOW, by: 'member' } });
    const c = rpcTodoClient(f.link, idem);
    const file = await c.exportFile('md');
    const text = new TextDecoder().decode(file.bytes);
    expect(text).toContain('- [ ] Open one');
    expect(text).toContain('- [x] Done one');
    expect(file.type).toBe('text/markdown');
  });
});

describe('the topic', () => {
  it('hears each change with its id and rev', async () => {
    const f = fake();
    const c = rpcTodoClient(f.link, idem);
    const heard: unknown[] = [];
    const off = c.watch((m) => heard.push(m));
    const item = await c.add('x');
    off();
    await c.close(item.id, 'done');
    expect(heard).toEqual([expect.objectContaining({ op: 'add', id: item.id, rev: item.rev })]);
  });
});
