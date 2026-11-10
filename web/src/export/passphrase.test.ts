import { describe, expect, it } from 'vitest';
import { decryptStream, encryptStream, encryptedName, HEADER, passphraseProblem, TAG, WrongPassphrase } from './passphrase';

async function* chunks(parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield p;
}
async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const out: Uint8Array[] = [];
  for await (const c of it) out.push(c);
  const all = new Uint8Array(out.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of out) {
    all.set(c, at);
    at += c.length;
  }
  return all;
}
const bytes = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536)));
  return b;
};
const FAST = { iterations: 1000, record: 1000 };
const enc = (plain: Uint8Array, pass = 'correct horse battery') => collect(encryptStream(chunks([plain]), pass, FAST));

describe('the passphrase on a download', () => {
  it('round-trips archives of every awkward size, in any chunking', async () => {
    for (const n of [0, 1, 999, 1000, 1001, 2000, 4567]) {
      const plain = bytes(n);
      const file = await enc(plain);
      const pieces = [file.slice(0, 7), file.slice(7, 41), file.slice(41, 1500), file.slice(1500)];
      expect(await collect(decryptStream(chunks(pieces), 'correct horse battery'))).toEqual(plain);
    }
  });

  it('writes the documented header and sizes', async () => {
    const file = await enc(bytes(2500));
    expect(new TextDecoder().decode(file.slice(0, 8))).toBe('MAEXPORT');
    expect([...file.slice(8, 12)]).toEqual([1, 1, 1, 0]);
    const v = new DataView(file.buffer, file.byteOffset);
    expect(v.getUint32(12)).toBe(1000);
    expect(v.getUint32(32)).toBe(1000);
    expect(file.length).toBe(HEADER + 2500 + 3 * TAG); // 1000 + 1000 + 500
  });

  it('shows nothing of the archive: the ZIP signature and a known string are not in the file', async () => {
    const plain = new TextEncoder().encode(`PK\u0003\u0004 ${'secret sign-in '.repeat(200)}`);
    const file = await enc(plain);
    expect(new TextDecoder('latin1').decode(file)).not.toContain('secret sign-in');
    expect(new TextDecoder('latin1').decode(file)).not.toContain('PK\u0003\u0004');
  });

  it('refuses a wrong passphrase, a flipped byte, a dropped or swapped record and a file cut short', async () => {
    const plain = bytes(3500);
    const file = await enc(plain);
    const open = (f: Uint8Array, pass = 'correct horse battery') => collect(decryptStream(chunks([f]), pass));
    await expect(open(file, 'correct horse batterz')).rejects.toBeInstanceOf(WrongPassphrase);
    const flipped = file.slice();
    flipped.set([flipped[HEADER + 10]! ^ 1], HEADER + 10);
    await expect(open(flipped)).rejects.toBeInstanceOf(WrongPassphrase);
    const rec = 1000 + TAG;
    const dropped = new Uint8Array([...file.slice(0, HEADER), ...file.slice(HEADER + rec)]);
    await expect(open(dropped)).rejects.toBeInstanceOf(WrongPassphrase);
    const swapped = file.slice();
    swapped.set(file.slice(HEADER + rec, HEADER + 2 * rec), HEADER);
    swapped.set(file.slice(HEADER, HEADER + rec), HEADER + rec);
    await expect(open(swapped)).rejects.toBeInstanceOf(WrongPassphrase);
    await expect(open(file.slice(0, HEADER + 2 * rec))).rejects.toBeInstanceOf(WrongPassphrase); // cut at a record boundary
    await expect(open(file.slice(0, 20))).rejects.toBeInstanceOf(WrongPassphrase);
    await expect(open(file)).resolves.toEqual(plain);
  });

  it('gives two encryptions of one archive nothing in common', async () => {
    const plain = bytes(1500);
    const a = await enc(plain);
    const b = await enc(plain);
    expect(a.slice(16, 32)).not.toEqual(b.slice(16, 32)); // the salt
    expect(a.slice(HEADER)).not.toEqual(b.slice(HEADER));
  });

  it('treats a passphrase as text: composed and decomposed letters are one', async () => {
    const plain = bytes(100);
    const file = await collect(encryptStream(chunks([plain]), 'café au lait 123', FAST));
    expect(await collect(decryptStream(chunks([file]), 'café au lait 123'))).toEqual(plain);
  });

  it('names the file and checks the passphrase kindly', () => {
    expect(encryptedName('minimalist-alliance-export-2026-11-08.zip')).toBe('minimalist-alliance-export-2026-11-08.zip.enc');
    expect(passphraseProblem('short', 'short')).toMatch(/at least 10/);
    expect(passphraseProblem('long enough one', 'long enough two')).toBe("The two don't match.");
    expect(passphraseProblem('long enough one', 'long enough one')).toBeNull();
    expect(passphraseProblem('long enough one', 'long enough one') ?? '').not.toContain('!');
  });
});
