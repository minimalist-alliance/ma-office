// Documents' adapter over a desk link, against the mock desk (deskd API.md §25): what it sends, the chips and their Undo by the
// desk's token, one `idem` across a lost reply, the refusals it names, and a page's picture over `bulk` with its boxes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulkChannel, DeskLink } from '../../desk/deskLink';
import { MockBulk, newDataControl } from '../../desk/mockDeskData';
import { MockDocsDesk } from '../../desk/mockDeskDocs';
import { rpcDocsClient, toDocsError } from './client';

let keys = 0;
const idem = (): string => `00000000-0000-7000-8000-${String((keys += 1)).padStart(12, '0')}`;
const CONTRACT = 'd_01JCMA00000000000000000001';
const DANGER = 'd_01JCMA00000000000000000008';

function fake() {
  const desk = new MockDocsDesk('d-personal');
  desk.seed('personal');
  const bulk = new MockBulk(newDataControl(), () => undefined);
  const sent: { m: string; p: Record<string, unknown>; idem?: string }[] = [];
  const loseNext = new Set<string>();
  const link = {
    deskId: 'd-personal',
    call: async (m: string, p: Record<string, unknown> = {}, o?: { idem?: string }) => {
      sent.push({ m, p, ...(o?.idem ? { idem: o.idem } : {}) });
      const r = await desk.answer(m, p, bulk);
      if (loseNext.delete(m)) throw Object.assign(new Error('lost'), { code: 'deadline_exceeded', details: {} });
      return r;
    },
    bulk: (): BulkChannel => bulk,
    onStatus: () => () => undefined,
    subscribe: (_t: string, fn: (m: unknown) => void) => desk.subscribe((e) => fn({ seq: 1, ...e })),
  } as unknown as DeskLink;
  return { link, desk, sent, loseNext };
}

beforeEach(() => {
  vi.stubGlobal('window', globalThis);
});

describe('reads', () => {
  it('lists Needs you with Maybe after, the counts and the end words', async () => {
    const f = fake();
    const c = rpcDocsClient(f.link, idem);
    const l = await c.list({ place: 'needs' });
    expect(f.sent.at(-1)!.p).toEqual({ place: 'needs', limit: 50 });
    expect(l.items.map((d) => d.maybe)).toEqual([false, false, true, true]);
    expect(l.counts).toMatchObject({ needs: 2, maybe: 2 });
    expect(l.end).toBe('That’s all for now.');
    await c.list({ place: 'records', view: 'week' });
    expect(f.sent.at(-1)!.p).toEqual({ place: 'records', view: 'week', limit: 50 });
  });

  it('reads a document whole: copies, versions, Also in', async () => {
    const d = await rpcDocsClient(fake().link, idem).get(CONTRACT);
    expect(d.doc.changedPages).toEqual([3]);
    expect(d.copiesText).toBe('2 copies: Mail, Files');
    expect(d.versions.map((v) => v.milestoneText)).toEqual(['Received from Rosa Ortiz', 'Edited by Writer', 'Received from Rosa Ortiz']);
    expect(d.alsoIn.map((l) => l.label)).toEqual(['Your thread with Rosa']);
  });

  it('searches the title, then inside the text', async () => {
    const c = rpcDocsClient(fake().link, idem);
    expect((await c.search('payment', false)).items).toEqual([]);
    const inside = await c.search('payment', true);
    expect(inside.items.map((d) => [d.id, d.matchedText])).toEqual([[CONTRACT, true]]);
  });

  it('a danger type is refused for text, pages and changes, as `danger`', async () => {
    const c = rpcDocsClient(fake().link, idem);
    for (const call of [() => c.text(DANGER), () => c.page(DANGER, 1, 800), () => c.changes(DANGER)]) {
      await expect(call()).rejects.toMatchObject({ code: 'danger' });
    }
  });

  it('a page comes over bulk as a picture, with its boxes and the changed ones marked', async () => {
    const c = rpcDocsClient(fake().link, idem);
    const { head, blob } = await c.page(CONTRACT, 3, 900);
    expect(head).toMatchObject({ format: 'jpeg', pageCount: 6, width: 900 });
    expect(blob.type).toBe('image/jpeg');
    expect(blob.size).toBe(head.size);
    expect(head.lines.filter((l) => l.changed)).toHaveLength(3);
    expect((await c.page(CONTRACT, 2, 900)).head.lines.some((l) => l.changed)).toBe(false);
  });

  it('names the refusals the window says apart', () => {
    const e = (code: string, details: Record<string, unknown> = {}) => toDocsError(Object.assign(new Error(), { code, details })).code;
    expect(e('not_found')).toBe('old');
    expect(e('not_found', { reason: 'doc' })).toBe('gone');
    expect(e('forbidden', { reason: 'danger', danger: 'program' })).toBe('danger');
    expect(e('unavailable', { reason: 'sandbox' })).toBe('sandbox');
    expect(e('unavailable', { reason: 'switched_off' })).toBe('switched_off');
    expect(e('unavailable', { reason: 'bandwidth_limit' })).toBe('paused');
    expect(toDocsError({ name: 'DeskNotConnected' }).code).toBe('offline');
  });
});

describe('chips and Undo', () => {
  it('Not important makes a rule and says it in the desk’s words; Undo puts it back by the desk’s token', async () => {
    const f = fake();
    const c = rpcDocsClient(f.link, idem);
    const r = await c.tap('d_01JCMA00000000000000000002', 'not_important');
    expect(r.toast?.text).toBe('Not important: Invoices from Northwind go to Records now.');
    expect(r.doc?.place).toBe('records');
    expect((await c.list({ place: 'needs' })).items.map((d) => d.id)).not.toContain('d_01JCMA00000000000000000002');
    expect(await c.rules()).toHaveLength(2);
    await c.undo(r.toast!.undo!);
    expect((await c.list({ place: 'needs' })).items.map((d) => d.id)).toContain('d_01JCMA00000000000000000002');
    expect(await c.rules()).toHaveLength(1);
  });

  it('Not now holds it until the next catch-up; Done leaves Needs you; Sooner moves it there', async () => {
    const c = rpcDocsClient(fake().link, idem);
    expect((await c.tap(CONTRACT, 'not_now')).toast?.text).toMatch(/^Held until \d{1,2}:\d{2} (am|pm)$/);
    expect((await c.tap('d_01JCMA00000000000000000003', 'done')).toast?.text).toBe('Done');
    const s = await c.tap('d_01JCMA00000000000000000005', 'sooner');
    expect(s.toast?.text).toBe('Newsletters from Field Notes go to Needs you now.');
    expect((await c.list({ place: 'needs' })).items.map((d) => d.id)).toEqual(['d_01JCMA00000000000000000002', 'd_01JCMA00000000000000000005', 'd_01JCMA00000000000000000004']);
  });

  it('carries one idem across a lost reply, and a refusal is final', async () => {
    const f = fake();
    const c = rpcDocsClient(f.link, idem);
    f.loseNext.add('docs.tap');
    await c.tap(CONTRACT, 'done');
    const taps = f.sent.filter((s) => s.m === 'docs.tap');
    expect(taps).toHaveLength(2);
    expect(taps[0]!.idem).toBe(taps[1]!.idem);
    await expect(c.undo('u_nothing')).rejects.toMatchObject({ code: 'not_found' });
    expect(f.sent.filter((s) => s.m === 'docs.undo')).toHaveLength(1);
  });

  it('restores a version with its toast, answers a question, and says when it was seen', async () => {
    const f = fake();
    const c = rpcDocsClient(f.link, idem);
    const t = await c.restore(CONTRACT, 'v_01JCMA00000000000000000002');
    expect(t?.text).toBe('Restored. The newer one is kept as a version.');
    expect((await c.questions())[0]!.id).toBe('q_firstsort');
    await c.answer('q_firstsort', 'later');
    expect((await c.questions())[0]!.kind).toBe('file');
    await c.seen(CONTRACT, 3, 1234.4);
    expect(f.sent.at(-1)).toMatchObject({ m: 'docs.seen', p: { id: CONTRACT, page: 3, ms: 1234 } });
    expect((await c.get(CONTRACT)).doc).toMatchObject({ lastPage: 3, changedPages: [] });
  });

  it('the topic says ids and counts only', async () => {
    const f = fake();
    const c = rpcDocsClient(f.link, idem);
    const heard: unknown[] = [];
    const off = c.watch((e) => heard.push(e));
    await c.tap(CONTRACT, 'done');
    off();
    expect(heard).toEqual([{ type: 'changed', rev: 2, ids: [CONTRACT], counts: { needs: 1, maybe: 2, read: 2, records: 3, working: 1 } }]);
  });
});
