// Members' keys in the office (flows 3 to 6, CT-I7): the wire read field by field, the line under a member's name, the
// compare field's rule, an invite's refusals carried to the card, and the adapter on the mock desk: an Add pinned by the link,
// a mismatch, a checked key that changed, its check releasing what it held.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeskLink } from '../../desk/deskLink';
import { MockCourierDesk, mockSafetyNumber } from '../../desk/mockDeskCourier';
import { rpcCourierClient, toCourierError } from './client';
import { memberLine } from './Keys';
import { sameNumber } from './model';
import type { MemberKey } from './types';
import { readMemberKeys } from './wire';

let n = 0;
const idem = (): string => `00000000-0000-7000-8000-${String((n += 1)).padStart(12, '0')}`;
const FP = '3f2a-91c0-7d4e-b815-0a6c-e2f9-5b37-c41d';

function fake(keyChanged = false): { desk: MockCourierDesk; link: DeskLink } {
  const desk = new MockCourierDesk('d-personal-keys');
  desk.seed('personal');
  if (keyChanged) desk.seedKeyChanged();
  const link = {
    deskId: desk.deskId,
    call: (m: string, p: Record<string, unknown> = {}, o?: { idem?: string }) => desk.answer(m, p, o?.idem),
    subscribe: () => () => undefined,
  } as unknown as DeskLink;
  return { desk, link };
}

beforeEach(() => {
  vi.stubGlobal('window', globalThis);
});

const NUM = mockSafetyNumber('x@courier.example');

describe('the wire', () => {
  it('reads each pin field by field and drops what it can’t trust', () => {
    const keys = readMemberKeys({
      keys: [
        { address: 'Rowan.Birch@courier.example', state: 'changed', source: 'invite', safetyNumber: NUM, verifiedAt: 5, newSafetyNumber: NUM, held: 2 },
        { address: 'sam@courier.example', state: 'unverified', source: 'first_use', safetyNumber: '1234', held: -1 },
        { address: 'not an address', state: 'verified' },
        { address: 'kim@courier.example', state: 'odd' },
        { address: 'ola@courier.example', state: 'verified', newSafetyNumber: NUM, held: 3 },
      ],
    });
    expect(keys).toEqual([
      { address: 'rowan.birch@courier.example', state: 'changed', source: 'invite', safetyNumber: NUM, verifiedAt: 5, newSafetyNumber: NUM, held: 2 },
      { address: 'sam@courier.example', state: 'unverified', source: 'first_use', safetyNumber: null, verifiedAt: null, newSafetyNumber: null, held: 0 },
      { address: 'ola@courier.example', state: 'verified', source: null, safetyNumber: null, verifiedAt: null, newSafetyNumber: null, held: 3 },
    ]);
    expect(readMemberKeys(null)).toEqual([]);
  });

  it('carries an invite refusal’s pinned and new safety number, and nothing malformed', () => {
    const e = toCourierError({ code: 'conflict', details: { reason: 'key_changed', newSafetyNumber: NUM } });
    expect([e.code, e.reason, e.newSafetyNumber, e.pinned]).toEqual(['conflict', 'key_changed', NUM, false]);
    expect(toCourierError({ code: 'conflict', details: { reason: 'fingerprint', pinned: true } }).pinned).toBe(true);
    expect(toCourierError({ code: 'conflict', details: { reason: 'key_changed', newSafetyNumber: '<b>1</b>' } }).newSafetyNumber).toBeNull();
  });
});

describe('the words', () => {
  const k = (x: Partial<MemberKey>): MemberKey => ({ address: 'a@courier.example', state: 'unverified', source: null, safetyNumber: NUM, verifiedAt: null, newSafetyNumber: null, held: 0, ...x });
  const now = Date.UTC(2026, 10, 14, 18);
  it('says how a member’s key stands under their name', () => {
    expect(memberLine([], now)).toBeNull();
    expect(memberLine([k({ state: 'none' })], now)).toBeNull();
    expect(memberLine([k({})], now)).toEqual({ state: 'Compare safety numbers', changed: false, check: true });
    expect(memberLine([k({ state: 'verified', source: 'invite', verifiedAt: now })], now)?.state).toBe('Checked by invite link');
    expect(memberLine([k({ state: 'verified', source: 'safety_number', verifiedAt: Date.UTC(2026, 10, 3, 18) })], now)?.state).toBe('Checked Nov 3');
    expect(memberLine([k({ state: 'verified' }), k({ state: 'changed', newSafetyNumber: NUM })], now)).toEqual({ state: 'New key, not checked', changed: true, check: false });
  });

  it('compares a pasted number by its digits only', () => {
    expect(sameNumber(NUM, NUM)).toBe(true);
    expect(sameNumber(NUM.replace(/ /g, ''), NUM)).toBe(true);
    expect(sameNumber(NUM.replace(/ /g, '\n'), NUM)).toBe(true);
    expect(sameNumber(NUM.slice(0, -1), NUM)).toBe(false);
    expect(sameNumber(`${NUM.slice(0, -1)}${NUM.endsWith('0') ? '1' : '0'}`, NUM)).toBe(false);
    expect(sameNumber('', NUM)).toBe(false);
  });
});

describe('the adapter on the mock desk', () => {
  it('adds a member by an invite: checked by the link, its safety number shown', async () => {
    const { link } = fake();
    const c = rpcCourierClient(link, idem);
    const r = await c.addMember({ name: 'rowan.birch', fingerprint: FP, displayName: 'Rowan Birch' });
    expect(r.checked).toBe(true);
    expect(r.channelId).toMatch(/^[0-9A-Z]{26}$/);
    const keys = await c.memberKeys(r.contactId);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ address: 'rowan.birch@courier.example', state: 'verified', source: 'invite' });
    expect(memberLine(keys, Date.now())?.state).toBe('Checked by invite link');
  });

  it('refuses a link that doesn’t match, saying whether this desk had a key', async () => {
    const { link } = fake();
    const c = rpcCourierClient(link, idem);
    const bad = '0000-91c0-7d4e-b815-0a6c-e2f9-5b37-c41d';
    const fresh = await c.addMember({ name: 'kim.park', fingerprint: bad, displayName: '' }).catch((e: unknown) => toCourierError(e));
    expect(fresh).toMatchObject({ code: 'conflict', reason: 'fingerprint', pinned: false });
    const known = await c.addMember({ name: 'sam.lee', fingerprint: bad, displayName: '' }).catch((e: unknown) => toCourierError(e));
    expect(known).toMatchObject({ code: 'conflict', reason: 'fingerprint', pinned: true });
  });

  it('shows a checked key that changed with its new number; checking it adds them', async () => {
    const { link } = fake();
    const c = rpcCourierClient(link, idem);
    await c.addMember({ name: 'rowan.birch', fingerprint: FP, displayName: 'Rowan Birch' });
    const changed = await c.addMember({ name: 'rowan.birch', fingerprint: `1111${FP.slice(4)}`, displayName: '' }).catch((e: unknown) => toCourierError(e));
    expect(changed).toMatchObject({ code: 'conflict', reason: 'key_changed', newSafetyNumber: mockSafetyNumber('rowan.birch@courier.example#new') });
    const wrong = await c.verifyKey('rowan.birch@courier.example', NUM).catch((e: unknown) => toCourierError(e));
    expect(wrong).toMatchObject({ code: 'conflict', reason: 'safety_number' });
    expect(await c.verifyKey('rowan.birch@courier.example', mockSafetyNumber('rowan.birch@courier.example#new'))).toEqual({ released: 0 });
    const again = await c.addMember({ name: 'rowan.birch', fingerprint: `1111${FP.slice(4)}`, displayName: '' });
    expect(again.checked).toBe(true);
  });

  it('holds a changed key’s messages until the member checks it, then lets them in', async () => {
    const { desk, link } = fake(true);
    const c = rpcCourierClient(link, idem);
    const rowan = (await c.people('Rowan')).find((x) => x.name === 'Rowan Birch')!;
    const [k] = await c.memberKeys(rowan.contactId);
    expect(k).toMatchObject({ state: 'changed', held: 1, newSafetyNumber: mockSafetyNumber('rowan.birch@courier.example#new') });
    const before = desk.control.calls.length;
    expect(await c.verifyKey(k!.address, k!.newSafetyNumber!)).toEqual({ released: 1 });
    expect(desk.control.calls.slice(before).map((x) => x.m)).toEqual(['courier.contact.verify']);
    expect((await c.memberKeys(rowan.contactId))[0]).toMatchObject({ state: 'verified', held: 0, newSafetyNumber: null, safetyNumber: k!.newSafetyNumber });
  });

  it('gives no keys where the desk can’t say (a deskd before Wave 2.5)', async () => {
    const { desk, link } = fake();
    desk.control.refuse['courier.contact.keys'] = 'not_found';
    const c = rpcCourierClient(link, idem);
    const sam = (await c.people('Sam')).find((x) => x.name === 'Sam Lee')!;
    expect(await c.memberKeys(sam.contactId)).toEqual([]);
  });
});
