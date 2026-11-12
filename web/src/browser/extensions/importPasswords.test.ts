import { describe, expect, it } from 'vitest';
import type { BulkChannel } from '../../desk/deskLink';
import { CHUNK_BYTES, MAX_PASSWORDS_FILE, sendPasswordsFile } from './importPasswords';

type Call = { m: string; p: Record<string, unknown>; idem: string | undefined; deadlineMs: number | undefined };

/** A desk link that records every call and every frame, and keeps each frame's own copy, as a data channel's `send` does. */
function fakeLink(opts: { answers?: Record<string, Array<unknown | Error>>; sendFailsAt?: number; noBulk?: boolean } = {}) {
  const calls: Call[] = [];
  const frames: { id: number; seq: number; bytes: Uint8Array }[] = [];
  let drains = 0;
  const answers = opts.answers ?? {};
  const bulk: BulkChannel = {
    onChunk: null,
    onCredit: null,
    credit: () => undefined,
    send: (id, seq, payload) => {
      if (opts.sendFailsAt === seq) return false;
      frames.push({ id, seq, bytes: payload.slice() });
      return true;
    },
    drained: () => {
      drains += 1;
      return Promise.resolve();
    },
  };
  const link = {
    call: (m: string, p: Record<string, unknown> = {}, o?: { idem?: string; deadlineMs?: number }) => {
      calls.push({ m, p, idem: o?.idem, deadlineMs: o?.deadlineMs });
      const queue = answers[m];
      const next = queue && queue.length > 0 ? queue.shift() : m === 'browser.import.begin' ? { uploadId: 'U'.repeat(22), transferId: 7, window: p['size'], size: p['size'] } : m === 'browser.import.finish' ? { kind: 'passwords', found: 3, added: 2, alreadySaved: 1, refused: 0 } : {};
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    bulk: () => (opts.noBulk ? null : bulk),
  };
  return { link: link as never, calls, frames, drains: () => drains };
}

const deskError = (code: string, details: Record<string, unknown> = {}): Error => Object.assign(new Error(code), { code, details });

/** A file of `size` bytes, every byte non-zero, so a zeroed one shows. */
const file = (size: number): Uint8Array => {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) b[i] = (i % 251) + 1;
  return b;
};

describe('a passwords file on its way to the desk', () => {
  it('goes as begin, its bytes in 16,372-byte CHUNKs in order on bulk, then finish; the counts come back', async () => {
    const { link, calls, frames } = fakeLink();
    const size = CHUNK_BYTES * 2 + 100;
    const bytes = file(size);
    const want = bytes.slice();
    const counts = await sendPasswordsFile(link, bytes);
    expect(counts).toEqual({ found: 3, added: 2, alreadySaved: 1, refused: 0 });
    expect(calls.map((c) => c.m)).toEqual(['browser.import.begin', 'browser.import.finish']);
    expect(calls[0]?.p).toEqual({ kind: 'passwords', size });
    expect(calls[1]?.p).toEqual({ uploadId: 'U'.repeat(22) });
    // Mutations, each with its own key; finish with room for a big file.
    expect(calls[0]?.idem).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[1]?.idem).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[1]?.deadlineMs).toBe(120_000);
    expect(frames.map((f) => [f.id, f.seq, f.bytes.length])).toEqual([
      [7, 0, CHUNK_BYTES],
      [7, 1, CHUNK_BYTES],
      [7, 2, 100],
    ]);
    const joined = new Uint8Array(size);
    let at = 0;
    for (const f of frames) {
      joined.set(f.bytes, at);
      at += f.bytes.length;
    }
    expect(joined).toEqual(want);
    // Nothing of the file is left in the caller's buffer.
    expect(bytes.every((b) => b === 0)).toBe(true);
    // Nothing of it in a call's params either: only its size.
    expect(JSON.stringify(calls)).not.toContain(String.fromCharCode(...want.slice(0, 20)));
  });

  it('waits for bulk to drain every 16 frames, as the Files app’s uploads do', async () => {
    const { link, frames, drains } = fakeLink();
    await sendPasswordsFile(link, file(CHUNK_BYTES * 40));
    expect(frames).toHaveLength(40);
    expect(drains()).toBe(2);
  });

  it('a file of exactly 2 MiB goes; one byte more is refused here, before begin, and zeroed', async () => {
    const ok = fakeLink();
    await sendPasswordsFile(ok.link, file(MAX_PASSWORDS_FILE));
    expect(ok.frames).toHaveLength(Math.ceil(MAX_PASSWORDS_FILE / CHUNK_BYTES));
    const big = fakeLink();
    const bytes = file(MAX_PASSWORDS_FILE + 1);
    await expect(sendPasswordsFile(big.link, bytes)).rejects.toMatchObject({ code: 'too_large' });
    expect(big.calls).toEqual([]);
    expect(bytes.every((b) => b === 0)).toBe(true);
  });

  it('an empty file is not a passwords export, and nothing is asked of the desk', async () => {
    const { link, calls } = fakeLink();
    await expect(sendPasswordsFile(link, new Uint8Array(0))).rejects.toMatchObject({ code: 'bad_request', details: { reason: 'format' } });
    expect(calls).toEqual([]);
  });

  it('a begin the desk refuses sends no byte and needs no abort; the bytes are zeroed', async () => {
    const { link, calls, frames } = fakeLink({ answers: { 'browser.import.begin': [deskError('conflict', { reason: 'busy' })] } });
    const bytes = file(500);
    await expect(sendPasswordsFile(link, bytes)).rejects.toMatchObject({ code: 'conflict' });
    expect(frames).toEqual([]);
    expect(calls.map((c) => c.m)).toEqual(['browser.import.begin']);
    expect(bytes.every((b) => b === 0)).toBe(true);
  });

  it('a session that goes part way: the desk’s copy is aborted, and this one zeroed', async () => {
    const { link, calls } = fakeLink({ sendFailsAt: 1 });
    const bytes = file(CHUNK_BYTES * 3);
    await expect(sendPasswordsFile(link, bytes)).rejects.toThrow();
    expect(calls.map((c) => c.m)).toEqual(['browser.import.begin', 'browser.import.abort']);
    expect(calls[1]?.p).toEqual({ uploadId: 'U'.repeat(22) });
    expect(calls[1]?.idem).toBeTruthy();
    expect(bytes.every((b) => b === 0)).toBe(true);
  });

  it('no bulk channel after begin: aborted too', async () => {
    const { link, calls } = fakeLink({ noBulk: true });
    await expect(sendPasswordsFile(link, file(10))).rejects.toThrow();
    expect(calls.map((c) => c.m)).toEqual(['browser.import.begin', 'browser.import.abort']);
  });

  it('a lost finish reply is asked again with the same key, which gets the stored result', async () => {
    const { link, calls } = fakeLink({ answers: { 'browser.import.finish': [deskError('deadline_exceeded'), { found: 1, added: 1, alreadySaved: 0, refused: 0 }] } });
    expect(await sendPasswordsFile(link, file(10))).toEqual({ found: 1, added: 1, alreadySaved: 0, refused: 0 });
    const finishes = calls.filter((c) => c.m === 'browser.import.finish');
    expect(finishes).toHaveLength(2);
    expect(finishes[0]?.idem).toBe(finishes[1]?.idem);
  });

  it('a file that isn’t a passwords export comes back as deskd says, and the desk’s copy is aborted', async () => {
    const { link, calls } = fakeLink({ answers: { 'browser.import.finish': [deskError('bad_request', { reason: 'format' })] } });
    await expect(sendPasswordsFile(link, file(10))).rejects.toMatchObject({ code: 'bad_request', details: { reason: 'format' } });
    expect(calls.map((c) => c.m)).toEqual(['browser.import.begin', 'browser.import.finish', 'browser.import.abort']);
  });

  it('counts deskd doesn’t give, or gives oddly, read as 0', async () => {
    const { link } = fakeLink({ answers: { 'browser.import.finish': [{ found: '3', added: -1, alreadySaved: 2.7 }] } });
    expect(await sendPasswordsFile(link, file(10))).toEqual({ found: 0, added: 0, alreadySaved: 2, refused: 0 });
  });
});
