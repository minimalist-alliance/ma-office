// Courier's spam and safety, and attachments into Files, in the office (Waves 3.2 and 3.1, API.md §21): the warnings read field
// by field, Report spam and Save to Files over the mock desk (a dangerous type only with the second press), and the forged
// contact's mail in Requests.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeskLink } from '../../desk/deskLink';
import { MockCourierDesk } from '../../desk/mockDeskCourier';
import { rpcCourierClient } from './client';
import { readMessage, readSaved, readWarnings } from './wire';

let n = 0;
const idem = (): string => `00000000-0000-7000-8000-${String((n += 1)).padStart(12, '0')}`;

function fake(): { desk: MockCourierDesk; link: DeskLink } {
  const desk = new MockCourierDesk('d-personal-safety');
  desk.seed('personal');
  desk.seedSafety();
  const link = { deskId: desk.deskId, call: (m: string, p: Record<string, unknown> = {}, o?: { idem?: string }) => desk.answer(m, p, o?.idem), subscribe: () => () => undefined } as unknown as DeskLink;
  return { desk, link };
}

beforeEach(() => {
  vi.stubGlobal('window', globalThis);
});

describe('the wire', () => {
  it('reads warnings field by field, at most four, and nothing of an unknown kind', () => {
    expect(
      readWarnings([
        { kind: 'not_usual_address', contactId: 'c', name: 'Dana‮ Ortiz' },
        { kind: 'lookalike', domain: 'PAYPA1.example', like: 'paypal.com' },
        { kind: 'lookalike', domain: '<b>', like: 'paypal.com' },
        { kind: 'punycode', domain: 'xn--pypal-4ve.example' },
        { kind: 'gossip' },
        { kind: 'name_held_address' },
        { kind: 'name_held_address' },
      ]),
    ).toEqual([
      { kind: 'not_usual_address', contactId: 'c', name: 'Dana Ortiz' },
      { kind: 'lookalike', domain: 'paypa1.example', like: 'paypal.com' },
      { kind: 'punycode', domain: 'xn--pypal-4ve.example' },
      { kind: 'name_held_address' },
    ]);
    const m = readMessage({ messageId: '01JC0000000000000000000000', screen: 'filter', warnings: 'nope' });
    expect(m?.screen).toBe('filter');
    expect(m?.warnings).toEqual([]);
    expect(readMessage({ messageId: '01JC0000000000000000000000', screen: 'member' })?.screen).toBeNull();
    expect(readSaved({ path: 'Courier/2026-11-14 Plans/a.pdf', name: 'a.pdf', already: true })).toEqual({ path: 'Courier/2026-11-14 Plans/a.pdf', name: 'a.pdf', already: true });
    expect(readSaved({})).toBeNull();
  });
});

describe('on the mock desk', () => {
  it('reports spam with Undo back where it was, and keeps a forged contact out of the blocks', async () => {
    const { desk, link } = fake();
    const c = rpcCourierClient(link, idem);
    const reqs = (await c.list({ lane: 'requests' })).rows;
    const forged = reqs.find((r) => r.contacts[0]?.known)!;
    expect(forged.contacts[0]?.name).toBe('Dana Ortiz');
    const t = (await c.thread(forged.channelId, 'requests'))!;
    const ids = t.messages.map((m) => m.messageId);
    expect(await c.report(ids, true)).toBe(1);
    expect(desk.blocked().some((b) => b.value === 'dana@ortiz.example')).toBe(false);
    expect(desk.laneOf(ids[0]!)).toBe('spam');
    await c.moveMessages(ids, 'restore');
    expect(desk.laneOf(ids[0]!)).toBe('requests');
    // The stranger who borrows Dana's name carries both warnings.
    const pal = reqs.find((r) => r.contacts[0]?.endpoint.value === 'dana.ortiz@0rtiz-mail.example')!;
    expect(pal.last?.warned).toBe(true);
    const m = (await c.thread(pal.channelId, 'requests'))!.messages[0]!;
    expect(m.warnings.map((w) => w.kind)).toEqual(['not_usual_address', 'lookalike']);
  });

  it('saves an attachment to Files, a dangerous one only with the second press, and never twice', async () => {
    const { desk, link } = fake();
    const c = rpcCourierClient(link, idem);
    const id = desk.find('Re: Garden plans')!;
    const pdf = await c.saveAttachment(id, '2', false);
    expect(pdf.path).toMatch(/^Courier\/\d{4}-\d{2}-\d{2} Garden plans\/garden-sketch\.pdf$/);
    expect(pdf.already).toBe(false);
    expect((await c.saveAttachment(id, '2', false)).already).toBe(true);
    await expect(c.saveAttachment(id, '3', false)).rejects.toMatchObject({ code: 'forbidden', reason: 'danger' });
    expect((await c.saveAttachment(id, '3', true)).name).toBe('planting-tool.exe');
  });
});
