// Courier's bytes over bulk (Wave 3.1): the reader keeps early pieces, writes in order, credits as it writes, and keeps nothing
// that doesn't match the desk's trailer and its reply; a cancel, a gap or a silence ends it on the desk too.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulkChannel, DeskLink } from '../../desk/deskLink';
import { readHead, readTransfer } from './bulk';

async function sha(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
}
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
async function trailer(bytes: Uint8Array, size = bytes.length): Promise<Uint8Array> {
  const t = new Uint8Array(40);
  t.set(await sha(bytes));
  new DataView(t.buffer).setBigUint64(32, BigInt(size));
  return t;
}

function rig() {
  const credits: [number, number][] = [];
  const bulk: BulkChannel = {
    onChunk: null,
    onCredit: null,
    credit: (id, n) => void credits.push([id, n]),
    send: () => true,
    drained: () => Promise.resolve(),
  };
  let status: ((s: string) => void) | null = null;
  const link = { deskId: 'd-1', bulk: () => bulk, onStatus: (fn: (s: string) => void) => ((status = fn), () => (status = null)) } as unknown as DeskLink;
  const chunk = (id: number, seq: number, end: boolean, payload: Uint8Array): void => bulk.onChunk?.(id, seq, end, payload);
  return { bulk, link, credits, chunk, drop: () => status?.('closed') };
}

beforeEach(() => {
  vi.stubGlobal('window', globalThis);
});

describe('readTransfer', () => {
  it('writes every piece in order, early ones included, and resolves only once the trailer and the reply agree', async () => {
    const r = rig();
    const data = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
    const parts = [data.subarray(0, 1_000_000), data.subarray(1_000_000, 2_000_000), data.subarray(2_000_000)];
    const out: number[] = [];
    const stop = vi.fn(() => Promise.resolve());
    const named = hex(await sha(data));
    const p = readTransfer(
      r.link,
      async () => {
        // The first piece (within the first credit window, as the desk sends) overtakes the reply.
        r.chunk(7, 0, false, parts[0]!);
        return { transferId: 7, size: data.length, sha256: named, name: 'a.bin' };
      },
      stop,
      async (b) => void out.push(b.length),
    );
    await new Promise((res) => setTimeout(res, 0));
    r.chunk(7, 1, false, parts[1]!);
    r.chunk(9, 0, false, new Uint8Array(5)); // another transfer's: ignored
    r.chunk(7, 2, false, parts[2]!);
    r.chunk(7, 3, true, await trailer(data));
    const head = await p;
    expect(head).toMatchObject({ transferId: 7, size: data.length });
    expect(out.reduce((a, b) => a + b, 0)).toBe(data.length);
    expect(r.credits.length).toBeGreaterThan(0);
    expect(r.credits.every(([id]) => id === 7)).toBe(true);
    expect(stop).not.toHaveBeenCalled();
  });

  it('lets another transfer already running stream on without crowding out ours (CF-I3)', async () => {
    const r = rig();
    const data = new Uint8Array(200_000).fill(7);
    const out: number[] = [];
    const p = readTransfer(
      r.link,
      async () => {
        // Another download's pieces, mid-stream and more than our window, arrive before our reply; then our first piece.
        for (let i = 5; i < 100; i += 1) r.chunk(3, i, false, new Uint8Array(16_000));
        r.chunk(8, 0, false, data);
        return { transferId: 8, size: data.length, sha256: hex(await sha(data)) };
      },
      () => Promise.resolve(),
      async (b) => void out.push(b.length),
    );
    await new Promise((res) => setTimeout(res, 0));
    r.chunk(8, 1, true, await trailer(data));
    await expect(p).resolves.toMatchObject({ transferId: 8 });
    expect(out.reduce((a, b) => a + b, 0)).toBe(data.length);
  });

  it('keeps nothing whose bytes differ from what the desk named, and stops the transfer', async () => {
    const r = rig();
    const data = new Uint8Array(100).fill(1);
    const stop = vi.fn(() => Promise.resolve());
    const named = hex(await sha(new Uint8Array(100).fill(2)));
    const p = readTransfer(r.link, async () => ({ transferId: 1, size: 100, sha256: named }), stop, async () => undefined);
    await new Promise((res) => setTimeout(res, 0));
    r.chunk(1, 0, false, data);
    r.chunk(1, 1, true, await trailer(data));
    await expect(p).rejects.toMatchObject({ code: 'broken', details: { reason: 'trailer' } });
    expect(stop).toHaveBeenCalledWith(1);
  });

  it('refuses a gap, more bytes than named, a cancel, a dropped session and a silence', async () => {
    const named = { transferId: 2, size: 10, sha256: '0'.repeat(64) };
    let r = rig();
    let p = readTransfer(r.link, async () => named, () => Promise.resolve(), async () => undefined);
    await new Promise((res) => setTimeout(res, 0));
    r.chunk(2, 1, false, new Uint8Array(1));
    await expect(p).rejects.toMatchObject({ code: 'broken', details: { reason: 'seq' } });

    r = rig();
    p = readTransfer(r.link, async () => named, () => Promise.resolve(), async () => undefined);
    await new Promise((res) => setTimeout(res, 0));
    r.chunk(2, 0, false, new Uint8Array(11));
    await expect(p).rejects.toMatchObject({ code: 'broken', details: { reason: 'size' } });

    r = rig();
    const ac = new AbortController();
    const stop = vi.fn(() => Promise.resolve());
    p = readTransfer(r.link, async () => named, stop, async () => undefined, { signal: ac.signal });
    await new Promise((res) => setTimeout(res, 0));
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(stop).toHaveBeenCalledWith(2);

    r = rig();
    p = readTransfer(r.link, async () => named, () => Promise.resolve(), async () => undefined);
    await new Promise((res) => setTimeout(res, 0));
    r.drop();
    await expect(p).rejects.toMatchObject({ code: 'offline' });

    r = rig();
    p = readTransfer(r.link, async () => named, () => Promise.resolve(), async () => undefined, { stallMs: 20 });
    await expect(p).rejects.toMatchObject({ code: 'stalled' });
  });

  it('says offline with no session, and passes the desk’s own refusal on', async () => {
    const r = rig();
    const none = { ...r.link, bulk: () => null } as unknown as DeskLink;
    await expect(readTransfer(none, async () => ({}), () => Promise.resolve(), async () => undefined)).rejects.toMatchObject({ code: 'offline' });
    const refused = Object.assign(new Error('x'), { code: 'forbidden', details: { reason: 'danger' } });
    await expect(readTransfer(r.link, () => Promise.reject(refused), () => Promise.resolve(), async () => undefined)).rejects.toBe(refused);
  });

  it('reads the reply field by field', () => {
    expect(readHead({ transferId: 1, size: 2, sha256: 'a'.repeat(64) })).toMatchObject({ transferId: 1, size: 2 });
    expect(readHead({ transferId: -1, size: 2, sha256: 'a'.repeat(64) })).toBeNull();
    expect(readHead({ transferId: 1, size: 2, sha256: 'A'.repeat(64) })).toBeNull();
    expect(readHead({ transferId: 1.5, size: 2, sha256: 'a'.repeat(64) })).toBeNull();
    expect(readHead(null)).toBeNull();
  });
});

describe('what a download is named, and an archive list', async () => {
  const { fileNameOf, readArchive } = await import('./wire');
  it('names a file as one plain line, never a path', () => {
    expect(fileNameOf('../../etc/passwd', 'x')).toBe('.._.._etc_passwd'.replace(/^\.+/, ''));
    expect(fileNameOf('re‮port.pdf', 'x')).toBe('report.pdf');
    expect(fileNameOf('  ...  ', 'attachment')).toBe('attachment');
    expect(fileNameOf('a'.repeat(300) + '.pdf', 'x')).toMatch(/^a{116}\.pdf$/);
    expect(fileNameOf(42, 'message')).toBe('message');
  });
  it('reads an archive list field by field, at most 500 entries', () => {
    const a = readArchive({ format: 'tar', entries: [{ name: 'a.exe', bytes: 3, danger: 'program' }, { name: '' }, { name: 'd/', dir: true, danger: 'nope' }], total: 9, truncated: true });
    expect(a).toEqual({ format: 'tar', entries: [{ name: 'a.exe', bytes: 3, dir: false, encrypted: false, danger: 'program' }, { name: 'd/', bytes: 0, dir: true, encrypted: false, danger: null }], total: 9, truncated: true, danger: null });
    expect(readArchive({ entries: Array.from({ length: 900 }, (_, i) => ({ name: `f${i}` })) }).entries).toHaveLength(500);
  });
});
