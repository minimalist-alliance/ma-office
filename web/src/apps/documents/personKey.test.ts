import { describe, expect, it } from 'vitest';
import { chooseKey, makeKey, readKeyInfo, syncKeys, type KeyDesk } from './personKeySync';

let n = 0;
const idem = (): string => `idem-${(n += 1)}`;
const K1 = 'a'.repeat(64);
const K2 = 'b'.repeat(64);

/** A desk's Documents in memory: its secret, whether the office set it and when; or no Documents at all. */
function desk(id: string, init: { key?: string; at?: number; old?: boolean; refuseSet?: boolean } = {}) {
  const state = { key: init.key ?? null, at: init.at ?? null, own: `own-${id}`, sets: 0, idems: [] as string[] };
  const d: KeyDesk & { state: typeof state } = {
    deskId: id,
    state,
    call: (method, params, idem) => {
      if (init.old) return Promise.reject(Object.assign(new Error('nf'), { code: 'not_found' }));
      if (method === 'docs.key.get') {
        return Promise.resolve(state.key ? { keyId: state.key.slice(0, 8), shared: true, key: state.key, at: state.at } : { keyId: '0badf00d', shared: false });
      }
      if (method === 'docs.key.set') {
        if (init.refuseSet) return Promise.reject(Object.assign(new Error('u'), { code: 'unavailable' }));
        state.sets += 1;
        state.key = params['key'] as string;
        state.at = params['at'] as number;
        if (idem) state.idems.push(idem);
        return Promise.resolve({ keyId: state.key.slice(0, 8), changed: true });
      }
      return Promise.reject(new Error(method));
    },
  };
  return d;
}

describe('readKeyInfo', () => {
  it('takes a shared key with its time, and never a desk-made one', () => {
    expect(readKeyInfo({ keyId: 'abcd1234', shared: true, key: K1, at: 5 })).toEqual({ keyId: 'abcd1234', shared: true, key: K1, at: 5 });
    expect(readKeyInfo({ keyId: 'abcd1234', shared: false, key: K1, at: 5 })).toEqual({ keyId: 'abcd1234', shared: false, key: null, at: null });
    expect(readKeyInfo({ keyId: 'abcd1234', shared: true, key: 'XYZ', at: 5 })?.shared).toBe(false);
    expect(readKeyInfo({ keyId: 'abcd1234', shared: true, key: K1 })?.shared).toBe(false);
    expect(readKeyInfo({ shared: true, key: K1, at: 5 })).toBeNull();
    expect(readKeyInfo('nope')).toBeNull();
  });
});

describe('chooseKey', () => {
  it('keeps the earliest made, ties by the key, else makes one', () => {
    const a = { keyId: 'a', shared: true, key: K2, at: 10 };
    const b = { keyId: 'b', shared: true, key: K1, at: 20 };
    expect(chooseKey([a, b, null], () => 'x', 99)).toEqual({ key: K2, at: 10 });
    expect(chooseKey([{ ...a, at: 20 }, b], () => 'x', 99)).toEqual({ key: K1, at: 20 });
    expect(chooseKey([{ keyId: 'c', shared: false, key: null, at: null }, null], () => 'made', 99)).toEqual({ key: 'made', at: 99 });
  });

  it('makes 64 hex characters, different each time', () => {
    const k = makeKey();
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(makeKey()).not.toBe(k);
  });
});

describe('syncKeys', () => {
  it("gives every desk one new secret when none has the office's", async () => {
    const work = desk('w');
    const home = desk('p');
    expect(await syncKeys([work, home], idem, () => K1, () => 1000)).toBe(2);
    expect(work.state.key).toBe(K1);
    expect(home.state.key).toBe(K1);
    expect(work.state.at).toBe(1000);
    // Each mutation carries its own key, for a retry of a lost reply.
    expect(work.state.idems).toHaveLength(1);
    // Again: nothing to give.
    expect(await syncKeys([work, home], idem, () => K2, () => 2000)).toBe(0);
  });

  it("gives a desk opened later the one the others have, and two browsers' keys settle on the earliest", async () => {
    const home = desk('p', { key: K2, at: 50 });
    const fresh = desk('n');
    expect(await syncKeys([home, fresh], idem, () => K1, () => 1000)).toBe(1);
    expect(fresh.state).toMatchObject({ key: K2, at: 50 });
    const other = desk('o', { key: K1, at: 40 });
    expect(await syncKeys([home, fresh, other], idem, () => 'c'.repeat(64), () => 1000)).toBe(2);
    expect([home.state.key, fresh.state.key, other.state.key]).toEqual([K1, K1, K1]);
  });

  it('leaves out a desk without Documents, and one that refuses for now', async () => {
    const old = desk('x', { old: true });
    const busy = desk('y', { refuseSet: true });
    const home = desk('p');
    expect(await syncKeys([old, busy, home], idem, () => K1, () => 1)).toBe(1);
    expect(home.state.key).toBe(K1);
    expect(busy.state.key).toBeNull();
    expect(await syncKeys([old], idem, () => K1, () => 1)).toBe(0);
  });
});
