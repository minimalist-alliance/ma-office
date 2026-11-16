// One person across channels (flow 11): the words a suggestion says, what "Add an email or number" reads, the wire read field
// by field, and the adapter on the mock desk: a link only on a call, Undo, Unlink, Not them, a deskd from before links.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeskLink } from '../../desk/deskLink';
import { LINK_METHODS, MockCourierDesk } from '../../desk/mockDeskCourier';
import { rpcCourierClient } from './client';
import { firstName, firstView, parseEndpoint, rememberView, sourcesPhrase, waysLine, whyLine } from './model';
import { readKeys, readPerson, readSuggestions } from './wire';

let n = 0;
const idem = (): string => `00000000-0000-7000-8000-${String((n += 1)).padStart(12, '0')}`;

function fake(links = true): { desk: MockCourierDesk; link: DeskLink; calls: string[] } {
  const desk = new MockCourierDesk('d-personal-links');
  desk.seed('personal');
  desk.seedLinks();
  if (!links) for (const m of LINK_METHODS) desk.control.refuse[m] = 'not_found';
  const calls: string[] = [];
  const link = {
    deskId: desk.deskId,
    call: (m: string, p: Record<string, unknown> = {}, o?: { idem?: string }) => {
      calls.push(m);
      return desk.answer(m, p, o?.idem);
    },
    subscribe: () => () => undefined,
  } as unknown as DeskLink;
  return { desk, link, calls };
}

beforeEach(() => {
  vi.stubGlobal('window', globalThis);
});

describe('the words', () => {
  const s = { endpoint: { kind: 'phone', value: '+17205550142' }, into: { contactId: 'c', name: 'Dana Ortiz' }, provider: null };
  it('gives each source its one why line', () => {
    expect(firstName('Dana Ortiz')).toBe('Dana');
    expect(whyLine({ ...s, source: 'mac' })).toBe('Your Mac’s contacts list this number on Dana’s card.');
    expect(whyLine({ ...s, source: 'card' })).toBe('On the card you added for Dana.');
    expect(whyLine({ ...s, source: 'provider', provider: 'iCloud' })).toBe('Your iCloud contacts list this on Dana’s card.');
    expect(whyLine({ ...s, endpoint: { kind: 'email', value: 'd@x.example' }, source: 'signature' })).toBe('Dana’s email signature gives this address.');
    expect(whyLine({ ...s, source: 'name' })).toBe('Same name, and nothing else. Check before you link.');
  });
  it('says where the review’s suggestions come from', () => {
    expect(sourcesPhrase([{ source: 'mac', provider: null }, { source: 'card', provider: null }])).toBe('your Mac’s contacts and a card you added');
    expect(sourcesPhrase([{ source: 'mac', provider: null }, { source: 'card', provider: null }, { source: 'card', provider: null }, { source: 'name', provider: null }])).toBe('your Mac’s contacts, cards you added and matching names');
  });
  it('reads what was typed in "Add an email or number"', () => {
    expect(parseEndpoint('D.Ortiz@Studio-Mail.example', 'courier.example')).toEqual({ kind: 'email', value: 'd.ortiz@studio-mail.example' });
    expect(parseEndpoint('dana@courier.example', 'courier.example')).toEqual({ kind: 'ma', value: 'dana@courier.example' });
    expect(parseEndpoint('(720) 555-0142', null)).toEqual({ kind: 'phone', value: '+17205550142' });
    expect(parseEndpoint('+44 20 7946 0958', null)).toEqual({ kind: 'phone', value: '+442079460958' });
    expect(parseEndpoint('dana', null)).toBeNull();
    expect(parseEndpoint('12', null)).toBeNull();
    expect(parseEndpoint('a@b', null)).toBeNull();
  });
  it('lists a person by their first way to reach them, and how many more', () => {
    expect(waysLine({ endpoints: [{ kind: 'email', value: 'dana@ortiz.example', standing: 'known', source: null, provider: null, lastInboundAt: null }] })).toBe('dana@ortiz.example');
    expect(waysLine({ endpoints: [1, 2, 3].map((i) => ({ kind: 'email', value: `d${i}@x.example`, standing: 'known', source: null, provider: null, lastInboundAt: null })) })).toBe('d1@x.example and 2 more');
  });
});

describe("a message's first view (the Designer's call 1)", () => {
  const from = { me: false as const, contactId: 'c1', name: 'Dana', endpoint: { kind: 'email', value: 'dana@ortiz.example' }, known: true };
  it("opens people's mail as text, Updates as sent, and keeps the member's last choice per sender", () => {
    expect(firstView({ from, lane: 'people', bulk: false })).toBe('text');
    expect(firstView({ from: { ...from, endpoint: { kind: 'email', value: 'news@city.example' } }, lane: 'updates', bulk: true })).toBe('html');
    rememberView({ from }, 'html');
    expect(firstView({ from, lane: 'people', bulk: false })).toBe('html');
  });
});

describe('the wire', () => {
  it('reads suggestions, people and keys field by field', () => {
    const list = readSuggestions({
      suggestions: [
        { endpoint: { kind: 'phone', value: '+1720‮5550142' }, fromContactId: 'a', channelId: '01JC0000000000000000000000', into: { contactId: 'b', name: 'Dana Ortiz' }, source: 'mac', strength: 'card' },
        { endpoint: { kind: 'email', value: 'x@y.example' }, into: { contactId: 'b', name: '' }, source: 'mac' },
        { endpoint: { kind: 'email', value: 'x@y.example' }, into: { contactId: 'b', name: 'B' }, source: 'gossip' },
        { endpoint: { kind: 'email', value: 'x@y.example' }, into: { contactId: 'b', name: 'B' }, source: 'name', provider: '<b>' },
      ],
    });
    expect(list).toHaveLength(2);
    expect(list[0]?.endpoint.value).toBe('+17205550142');
    expect(list[1]?.strength).toBe('name');
    expect(list[1]?.provider).toBeNull();
    const p = readPerson({ contactId: 'c', name: 'Dana', named: true, endpoints: [{ kind: 'email', value: 'dana@ortiz.example', source: 'added' }, { kind: '', value: 'x' }, { kind: 'phone', value: '+1', source: 'nonsense' }] });
    expect(p?.endpoints.map((e) => e.source)).toEqual(['added', null]);
    expect(readKeys({ available: true, fingerprint: '3F2A-91C0-7D4E-B815-0A6C-E2F9-5B37-C41D' }).fingerprint).toBe('3f2a-91c0-7d4e-b815-0a6c-e2f9-5b37-c41d');
    expect(readKeys({ available: true, fingerprint: '3f2a91c0' })).toEqual({ available: false, fingerprint: null });
  });
});

describe('linking on the mock desk', () => {
  it('suggests, links only when asked, undoes exactly, and lets a Requests number in', async () => {
    const f = fake();
    const c = rpcCourierClient(f.link, idem);
    const all = (await c.suggestions())!;
    expect(all.map((s) => `${s.endpoint.value} > ${s.into.name} (${s.strength})`)).toEqual([
      '+17205550142 > Dana Ortiz (card)',
      'sam@leeworks.example > Sam Lee (card)',
      'kim.park@mail.example > Kim Park (card)',
      'jordan.s@mail.example > Jordan Smith (name)',
      '+13035550199 > Kim Park (card)',
    ]);
    // Nothing is linked by a suggestion alone.
    expect(f.calls.filter((m) => m === 'courier.links.link')).toHaveLength(0);
    const dana = all[0]!;
    const before = (await c.list({ lane: 'people' })).rows.length;
    const r = await c.link({ into: dana.into.contactId, endpoint: dana.endpoint });
    expect(r.linkId).toBeTruthy();
    const after = await c.list({ lane: 'people' });
    expect(after.rows.length).toBe(before - 1);
    const t = await c.thread(r.channelId!);
    expect(t?.messages.map((m) => m.text)).toContain('Landed. Taxi now.');
    expect((await c.suggestions())!.some((s) => s.endpoint.value === '+17205550142')).toBe(false);
    await c.undoLink(r.linkId!);
    expect((await c.list({ lane: 'people' })).rows.length).toBe(before);
    // A Requests number linked to Kim: in, and in People.
    const kim = (await c.suggestions())!.find((s) => s.endpoint.value === '+13035550199')!;
    const reqs = (await c.status()).lanes.requests.count;
    await c.link({ into: kim.into.contactId, endpoint: kim.endpoint });
    expect((await c.status()).lanes.requests.count).toBe(reqs - 1);
  });

  it("unlinks one endpoint back to its own conversation, and remembers Not them", async () => {
    const f = fake();
    const c = rpcCourierClient(f.link, idem);
    const sam = (await c.suggestions())!.find((s) => s.into.name === 'Sam Lee')!;
    await c.link({ into: sam.into.contactId, endpoint: sam.endpoint });
    const person = (await c.person(sam.into.contactId))!;
    expect(person.endpoints.map((e) => e.value).sort()).toEqual(['sam.lee@courier.example', 'sam@leeworks.example']);
    const u = await c.unlink(sam.endpoint);
    expect(u.channelId).toBeTruthy();
    expect((await c.person(sam.into.contactId))!.endpoints.map((e) => e.value)).toEqual(['sam.lee@courier.example']);
    const t = await c.thread(u.channelId!);
    expect(t?.messages.map((m) => m.subject)).toEqual(['Studio keys']);
    const jordan = (await c.suggestions())!.find((s) => s.strength === 'name')!;
    await c.dismiss(jordan.endpoint, jordan.into.contactId);
    expect((await c.suggestions())!.some((s) => s.strength === 'name')).toBe(false);
    expect(await c.lookup({ kind: 'email', value: 'jordan.s@mail.example' })).toMatchObject({ name: 'Jordan Smith', messages: 1 });
    expect(await c.lookup({ kind: 'email', value: 'new@x.example' })).toMatchObject({ contactId: null, messages: 0 });
  });

  it('on a deskd from before links: no suggestions, and never a merge in a link’s place', async () => {
    const f = fake(false);
    const c = rpcCourierClient(f.link, idem);
    expect(await c.suggestions()).toBeNull();
    expect(await c.lookup({ kind: 'email', value: 'x@y.example' })).toBeNull();
    const rows = (await c.list({ lane: 'people' })).rows;
    const from = rows.find((r) => r.contacts[0]?.endpoint.value === 'sam@leeworks.example')!;
    const into = rows.find((r) => r.contacts[0]?.endpoint.value === 'sam.lee@courier.example')!;
    // A whole person too: the desk can't link, so nothing joins (a merge without Undo would be a silent one).
    await expect(c.link({ into: into.contacts[0]!.contactId, from: from.contacts[0]!.contactId })).rejects.toMatchObject({ code: 'old' });
    expect(f.calls).not.toContain('courier.contact.merge');
    await expect(c.link({ into: into.contacts[0]!.contactId, endpoint: { kind: 'email', value: 'x@y.example' } })).rejects.toMatchObject({ code: 'old' });
    expect((await c.list({ lane: 'people' })).rows.find((r) => r.channelId === from.channelId)).toBeTruthy();
  });

  it("gives this desk's fingerprint, or none on a desk without keys", async () => {
    const f = fake();
    const c = rpcCourierClient(f.link, idem);
    expect((await c.keys()).fingerprint).toBe('3f2a-91c0-7d4e-b815-0a6c-e2f9-5b37-c41d');
    f.desk.fingerprint = null;
    expect(await c.keys()).toEqual({ available: false, fingerprint: null });
  });
});
