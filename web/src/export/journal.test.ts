// The journal at rest: sealed, so IndexedDB holds no name, hash or desk of the member's; only the key (which won't
// leave WebCrypto), the epoch, a time and the chosen file's handle are kept as they are.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freshMeta, MemoryKv, SealedJournal, type Secret } from './journal';
import { newKey, Nonces } from './seal';
import { contains } from './testkit';

const MARKER = 'MA-PLAINTEXT-MARKER-91c2';
const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
});

describe('SealedJournal', () => {
  it('keeps nothing of the member in the clear, and reads back what it was given', async () => {
    const kv = new MemoryKv();
    const secret: Secret = { key: await newKey(), epoch: 1, at: 1000 };
    const meta = {
      ...freshMeta({ id: 'x', madeAt: '2026-11-06T10:00:00.000Z', fileName: `${MARKER}.zip`, target: 'browser', ended: false, desks: [{ deskId: 'd-1', name: MARKER, folder: MARKER }] }),
      pos: 4096,
      open: { name: `desks/${MARKER}/a.bin`, crc: 1, size: 10, offset: 0, start: 0, time: 0, date: 0, zip64: false, dir: false, mode: 0o600, part: 'files', path: `${MARKER}/a.bin`, sha: { h: [1, 2, 3, 4, 5, 6, 7, 8], block: [], length: 0 } },
      doneBytes: 10,
    };
    const entries = [{ name: `desks/${MARKER}/x.txt`, crc: 2, size: 3, offset: 0, time: 0, date: 0, zip64: false, dir: false, mode: 0o600, sha256: 'ab'.repeat(32) }];
    const now = vi.fn(() => 5000);
    const j = new SealedJournal(kv, secret, new Nonces(1), now);
    await j.save(meta, entries);
    await j.save({ ...meta, doneBytes: 20 }, [{ ...entries[0]!, name: `desks/${MARKER}/y.txt` }]);

    for (const b of [kv.meta!, ...kv.entries]) {
      expect(contains(b, MARKER)).toBe(false);
      expect(contains(b, 'abababab')).toBe(false);
      expect(contains(b, 'desks/')).toBe(false);
    }
    expect(Object.keys(kv.secret!).sort()).toEqual(['at', 'epoch', 'key']);
    expect(kv.secret!.at).toBe(5000);
    expect(store.get('ma.export.at')).toBe('5000');

    const back = await new SealedJournal(kv, kv.secret!, null).load();
    expect(back?.meta.desks[0]?.name).toBe(MARKER);
    expect(back?.meta.doneBytes).toBe(20);
    expect(back?.entries.map((e) => e.name)).toEqual([`desks/${MARKER}/x.txt`, `desks/${MARKER}/y.txt`]);
  });

  it('counts the 6 hours from progress, not from saving', async () => {
    const kv = new MemoryKv();
    let t = 1000;
    const j = new SealedJournal(kv, { key: await newKey(), epoch: 1, at: 0 }, new Nonces(1), () => t);
    const meta = freshMeta({ id: 'x', madeAt: '2026-11-06T10:00:00.000Z', fileName: 'a.zip', target: 'browser', ended: false, desks: [] });
    await j.save({ ...meta, doneBytes: 5, pos: 50 }, []);
    t = 9000;
    await j.save({ ...meta, doneBytes: 5, pos: 50 }, []); // nothing moved on
    expect(kv.secret!.at).toBe(1000);
    t = 12_000;
    await j.save({ ...meta, doneBytes: 6, pos: 60 }, []);
    expect(kv.secret!.at).toBe(12_000);
  });

  it("can't be read without its key", async () => {
    const kv = new MemoryKv();
    await new SealedJournal(kv, { key: await newKey(), epoch: 1, at: 0 }, new Nonces(1)).save(freshMeta({ id: 'x', madeAt: '2026-11-06T10:00:00.000Z', fileName: 'a.zip', target: 'browser', ended: false, desks: [] }), []);
    await expect(new SealedJournal(kv, { key: await newKey(), epoch: 1, at: 0 }, null).load()).rejects.toThrow();
  });
});
