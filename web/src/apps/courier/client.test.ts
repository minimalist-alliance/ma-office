// Courier's adapter over a desk link, against the mock desk (deskd API.md §21), and its wire reader: what it sends, one `idem`
// across a lost reply, the refusals it names, the HTML's slices joined, a sign-in that goes once and is never kept, and every
// reply read field by field.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeskLink } from '../../desk/deskLink';
import { MockCourierDesk } from '../../desk/mockDeskCourier';
import { rpcCourierClient, toCourierError } from './client';
import { isId, readAccounts, readChanged, readHit, readList, readMessage, readStatus } from './wire';

let keys = 0;
const idem = (): string => `00000000-0000-7000-8000-${String((keys += 1)).padStart(12, '0')}`;

interface Fake {
  link: DeskLink;
  desk: MockCourierDesk;
  sent: { m: string; p: Record<string, unknown>; idem?: string }[];
  loseNext: Set<string>;
}

function fake(): Fake {
  const desk = new MockCourierDesk('d-personal-a');
  desk.seed('personal');
  const sent: Fake['sent'] = [];
  const loseNext = new Set<string>();
  const link = {
    deskId: 'd-personal-a',
    call: async (m: string, p: Record<string, unknown> = {}, o?: { idem?: string }) => {
      sent.push({ m, p, ...(o?.idem ? { idem: o.idem } : {}) });
      const r = await desk.answer(m, p, o?.idem);
      if (loseNext.delete(m)) throw Object.assign(new Error('lost'), { code: 'deadline_exceeded', details: {} });
      return r;
    },
    subscribe: (_t: string, fn: (m: unknown) => void) => desk.subscribe((e) => fn({ seq: 1, ...e })),
  } as unknown as DeskLink;
  return { link, desk, sent, loseNext };
}

beforeEach(() => {
  vi.stubGlobal('window', globalThis);
});

describe('reads', () => {
  it('reads the status, the lanes and a conversation', async () => {
    const f = fake();
    const c = rpcCourierClient(f.link, idem);
    const s = await c.status();
    expect(s.state).toBe('on');
    expect(s.lanes.requests.count).toBe(2);
    const people = await c.list({ lane: 'people' });
    expect(people.rows.map((r) => r.contacts[0]?.name)).toEqual(['Sam Lee', 'Dana Ortiz', 'Priya Shah', 'Dana Ortiz']);
    const dana = people.rows[1]!;
    const t = await c.thread(dana.channelId);
    expect(t?.messages.map((m) => m.subject)).toEqual(['Garden plans', 'Re: Garden plans']);
    expect(t?.messages[1]?.auth?.senderConfirmed).toBe(true);
    expect(t?.messages[1]?.attachments.map((a) => a.danger)).toEqual([null, 'program']);
    expect(f.sent.every((s) => s.idem === undefined)).toBe(true);
  });

  it("joins the HTML's slices, and says none where there is none", async () => {
    const f = fake();
    const c = rpcCourierClient(f.link, idem);
    const id = f.desk.find('Re: Garden plans')!;
    f.desk.setHtml(id, `<p>${'x'.repeat(4500)}</p>`);
    expect(await c.html(id)).toBe(`<p>${'x'.repeat(4500)}</p>`);
    expect(f.sent.filter((s) => s.m === 'courier.message.html').map((s) => s.p['from'] ?? 0)).toEqual([0, 2000, 4000]);
    expect(await c.html(f.desk.find('Garden plans')!)).toBeNull();
  });

  it('searches with operators and the zone, and names a bad one', async () => {
    const f = fake();
    const c = rpcCourierClient(f.link, idem);
    const r = await c.search({ q: 'from:dana has:attachment raised', zone: 'America/Denver' });
    expect(r.hits.map((h) => h.subject)).toEqual(['Re: Garden plans']);
    expect(r.hits[0]?.matches.length).toBeGreaterThan(0);
    expect(f.sent.at(-1)?.p).toMatchObject({ q: 'from:dana has:attachment raised', zone: 'America/Denver' });
    await expect(c.search({ q: 'before:yesterday' })).rejects.toMatchObject({ code: 'bad_request', reason: 'date' });
  });
});

describe('mutations', () => {
  it('carry an idem, and keep it across a lost reply', async () => {
    const f = fake();
    const c = rpcCourierClient(f.link, idem);
    const rows = (await c.list({ lane: 'requests' })).rows;
    f.loseNext.add('courier.request.decide');
    await c.decide(rows[0]!.channelId, 'let_in');
    const tries = f.sent.filter((s) => s.m === 'courier.request.decide');
    expect(tries).toHaveLength(2);
    expect(tries[0]?.idem).toBeDefined();
    expect(tries[1]?.idem).toBe(tries[0]?.idem);
    expect((await c.list({ lane: 'requests' })).rows).toHaveLength(1);
  });

  it("don't try again when the desk refused with a reason", async () => {
    const f = fake();
    const c = rpcCourierClient(f.link, idem);
    f.desk.control.refuse['courier.done'] = { code: 'unavailable', details: { reason: 'switched_off' } };
    const row = (await c.list({ lane: 'people' })).rows[0]!;
    await expect(c.done(row.channelId, 'people', true)).rejects.toMatchObject({ code: 'unavailable', reason: 'switched_off' });
    expect(f.sent.filter((s) => s.m === 'courier.done')).toHaveLength(1);
  });

  it('moves, blocks and deletes as §21 says', async () => {
    const f = fake();
    const c = rpcCourierClient(f.link, idem);
    const req = (await c.list({ lane: 'requests' })).rows.find((r) => r.contacts[0]?.endpoint.value === 'alerts@secure-login.example')!;
    await c.decide(req.channelId, 'block');
    expect(f.desk.blocked()).toEqual([{ kind: 'address', value: 'alerts@secure-login.example' }]);
    expect((await c.list({ lane: 'spam' })).rows.some((r) => r.channelId === req.channelId)).toBe(true);
    const sam = (await c.list({ lane: 'people' })).rows[0]!;
    await c.move(sam.channelId, 'people', 'trash');
    expect((await c.list({ lane: 'trash' })).rows.some((r) => r.channelId === sam.channelId)).toBe(true);
    await c.move(sam.channelId, 'trash', 'restore');
    expect((await c.list({ lane: 'people' })).rows[0]?.channelId).toBe(sam.channelId);
  });

  it('sends a draft with Undo, and says why a medium can’t send', async () => {
    const f = fake();
    const c = rpcCourierClient(f.link, idem);
    const dana = (await c.list({ lane: 'people' })).rows[1]!;
    const d = await c.saveDraft({ channelId: dana.channelId, medium: 'email', accountId: f.desk.gmailAccountId, to: ['dana@ortiz.example'], subject: 'Re: Garden plans', text: 'Yes, Friday works.' });
    await expect(c.saveDraft({ draftId: d.draftId, text: 'stale', baseVersion: d.version + 5 })).rejects.toMatchObject({ code: 'conflict', reason: 'version' });
    const sent = await c.send(d.draftId);
    expect(sent.undoUntil).toBeGreaterThan(Date.now());
    expect(await c.undoSend(sent.outboundId)).toBe(d.draftId);
    const sam = (await c.list({ lane: 'people' })).rows[0]!;
    const d2 = await c.saveDraft({ channelId: sam.channelId, medium: 'ma', text: 'On my way' });
    await expect(c.send(d2.draftId)).rejects.toMatchObject({ code: 'unavailable', reason: 'medium' });
  });
});

describe('linked mailboxes: the sign-in goes once', () => {
  it('sends the secret in that one call and keeps it nowhere', async () => {
    const f = fake();
    const c = rpcCourierClient(f.link, idem);
    const id = await c.addAccount({ address: 'me@fastmail.example', auth: 'app_password', secret: 'abcd efgh ijkl mnop', provider: 'fastmail' });
    expect(id).toMatch(/^imap-[0-9a-f]{20}$/);
    expect(f.sent.filter((s) => s.m === 'courier.accounts.add')).toHaveLength(1);
    expect(f.sent.find((s) => s.m === 'courier.accounts.add')?.p).toMatchObject({ provider: 'fastmail' });
    expect(JSON.stringify(f.desk.control.calls)).not.toContain('abcd efgh');
    const listed = await c.accounts();
    expect(listed.find((a) => a.accountId === id)).toMatchObject({ kind: 'imap', address: 'me@fastmail.example', signedIn: true });
    expect(JSON.stringify(listed)).not.toContain('abcd');
  });

  it("names the provider's refusal and the desk's, without the secret", async () => {
    const f = fake();
    const c = rpcCourierClient(f.link, idem);
    const e1 = await c.addAccount({ address: 'me@gmail.example', auth: 'app_password', secret: 'wrong-password' }).catch((e: unknown) => e);
    expect(e1).toMatchObject({ code: 'forbidden', reason: 'sign_in', provider: 'Gmail' });
    expect(String((e1 as Error).message)).not.toContain('wrong-password');
    f.desk.control.imap = false;
    await expect(c.addAccount({ address: 'me@yahoo.example', auth: 'app_password', secret: 's' })).rejects.toMatchObject({ code: 'unavailable', reason: 'medium' });
  });

  it('never asks again on a new key: a lost reply is asked once more on the same one', async () => {
    const f = fake();
    const c = rpcCourierClient(f.link, idem);
    f.loseNext.add('courier.accounts.add');
    await c.addAccount({ address: 'me@icloud.example', auth: 'app_password', secret: 'pw' });
    const tries = f.sent.filter((s) => s.m === 'courier.accounts.add');
    expect(tries).toHaveLength(2);
    expect(tries[1]?.idem).toBe(tries[0]?.idem);
    expect(f.desk.control.signInsChecked).toBe(1);
  });
});

describe('errors', () => {
  it('says an older deskd, no session and a provider word apart', () => {
    expect(toCourierError(Object.assign(new Error('x'), { code: 'not_found', details: {} })).code).toBe('old');
    expect(toCourierError(Object.assign(new Error('x'), { code: 'not_found', details: { reason: 'channel' } })).code).toBe('not_found');
    expect(toCourierError({ name: 'DeskNotConnected' }).code).toBe('offline');
    expect(toCourierError(Object.assign(new Error('x'), { code: 'forbidden', details: { reason: 'sign_in', provider: '<b>Gmail</b>' } })).provider).toBeNull();
  });
});

describe('the wire', () => {
  it('drops rows and messages with no id, and cleans what could reorder a line', () => {
    const id = '01JC00000000000000000000AA';
    expect(isId(id)).toBe(true);
    expect(readList({ rows: [{ channelId: 'nope' }, { channelId: id, title: 'Pay‮me', contacts: [{ name: 'A​b', endpoint: { kind: 'email', value: 'a@b.example' } }] }] }).rows).toEqual([
      expect.objectContaining({ channelId: id, title: 'Payme', contacts: [expect.objectContaining({ name: 'Ab' })], lane: 'people', medium: null, last: null }),
    ]);
    const m = readMessage({ messageId: id, text: 'line one\r\nline⁦ two', textMore: true, attachments: [{ name: 'x.exe', danger: 'program' }, { name: 'y', danger: 'bogus' }], auth: { dmarc: 'pass', senderConfirmed: true }, status: 'weird' });
    expect(m).toMatchObject({ text: 'line one\nline two', textMore: true, status: 'received', auth: { senderConfirmed: true } });
    expect(m?.attachments.map((a) => a.danger)).toEqual(['program', null]);
    expect(readMessage({ text: 'no id' })).toBeNull();
  });
  it("keeps a hit's highlights only on the snippet the desk measured", () => {
    const id = '01JC00000000000000000000AA';
    expect(readHit({ messageId: id, channelId: id, snippet: 'the lease', matches: [[4, 9], [8, 99], 'x'] })?.matches).toEqual([[4, 9]]);
    expect(readHit({ messageId: id, channelId: id, snippet: 'the ‮lease', matches: [[5, 10]] })?.matches).toEqual([]);
  });
  it('reads a status, accounts and a change with safe defaults', () => {
    expect(readStatus({ state: 'weird' })).toMatchObject({ state: 'unavailable', lanes: { people: { count: 0, unread: 0 } } });
    expect(readAccounts({ accounts: [{ accountId: 'imap-00000000000000c0de01', kind: 'imap', address: 'a@b.example', signedIn: false }, { accountId: 'x y', kind: 'imap' }, { accountId: 'desk-1', kind: 'pop3' }] })).toEqual([
      { accountId: 'imap-00000000000000c0de01', kind: 'imap', label: '', address: 'a@b.example', state: '', sending: false, signedIn: false, provider: null },
    ]);
    // The sync's provider names the tile "Sign in again" opens; anything that isn't a plain id is none.
    const withSync = (provider: unknown) => readAccounts({ accounts: [{ accountId: 'imap-00000000000000c0de01', kind: 'imap', address: 'a@work.example', sync: { state: 'needs_you', provider } }] })[0]?.provider;
    expect(withSync('gmail')).toBe('gmail');
    expect(withSync('<b>gmail</b>')).toBeNull();
    expect(withSync(7)).toBeNull();
    expect(readChanged({ type: 'changed', channels: null, lanes: ['people', 'nope'], accounts: true })).toEqual({ type: 'changed', channels: null, lanes: ['people'], accounts: true, drafts: false, outbound: false });
  });
});
