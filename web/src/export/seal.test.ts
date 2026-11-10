// The working copy at rest: no byte of the member's in the clear, a key WebCrypto won't hand out, records that can't be
// moved, and an archive that decrypts to exactly what a real unzip accepts, however it was cut back and carried on.
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { archiveOrder } from './archive';
import { newKey, Nonces, OVERHEAD, RECORD, SealedSink, SLOT, unseal } from './seal';
import { bytesOf, contains, MemoryBlocks, MemorySink, pythonUnzip, realUnzipTest, scratchDir, sha256Hex } from './testkit';
import { ZipWriter } from './zip';

const dir = scratchDir();
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const MARKER = 'MA-PLAINTEXT-MARKER-7f3a';
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

async function plain(blocks: MemoryBlocks, key: CryptoKey): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of unseal(blocks, blocks.size(), key)) parts.push(p);
  return Buffer.concat(parts);
}

/** The same entries into any sink: a marker in names and in bytes, and a file across several records. */
async function writeArchive(sink: { write(b: Uint8Array): Promise<void>; truncate(n: number): Promise<void> }): Promise<void> {
  const zip = new ZipWriter(sink);
  await zip.add(`desks/${MARKER}/notes.txt`, text(`${MARKER} `.repeat(5000)));
  await zip.add('desks/Personal/files/big.bin', bytesOf(RECORD * 2 + 12_345, 9));
  await zip.add('desks/Personal/files/after.txt', text(MARKER));
  await zip.finish(archiveOrder);
}

describe('the sealed working copy', () => {
  it('uses a key WebCrypto will never hand out', async () => {
    const key = await newKey();
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    await expect(crypto.subtle.exportKey('jwk', key)).rejects.toThrow();
  });

  it('never uses an IV twice: a domain, the epoch, then a counter', () => {
    const a = new Nonces(1);
    const b = new Nonces(2);
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) for (const iv of [a.next(0), a.next(1), b.next(0), b.next(1)]) seen.add(Buffer.from(iv).toString('hex'));
    expect(seen.size).toBe(4000);
    expect(() => new Nonces(0)).toThrow();
  });

  it('holds no plaintext marker anywhere, and decrypts to the very archive a plain write makes, which both unzips accept', async () => {
    const key = await newKey();
    const blocks = new MemoryBlocks();
    const sealed = new SealedSink(blocks, key, new Nonces(1));
    await writeArchive(sealed);
    await sealed.flush();
    expect(contains(blocks.buf, MARKER)).toBe(false);
    expect(contains(blocks.buf, 'desks/')).toBe(false);

    const reference = new MemorySink();
    await writeArchive(reference);
    const out = await plain(blocks, key);
    expect(sha256Hex(out)).toBe(sha256Hex(reference.bytes()));
    const path = join(dir, 'sealed.zip');
    writeFileSync(path, out);
    realUnzipTest(path);
    expect(pythonUnzip(path).entries.map((e) => e.name)).toContain(`desks/${MARKER}/notes.txt`);
  });

  it('refuses records that were moved, changed, or sealed under another key', async () => {
    const key = await newKey();
    const blocks = new MemoryBlocks();
    const sealed = new SealedSink(blocks, key, new Nonces(1));
    await sealed.write(bytesOf(RECORD * 2, 3));
    await sealed.flush();
    const swapped = new MemoryBlocks();
    swapped.buf = Buffer.concat([blocks.buf.subarray(SLOT, 2 * SLOT), blocks.buf.subarray(0, SLOT)]);
    await expect(plain(swapped, key)).rejects.toThrow();
    const changed = new MemoryBlocks();
    changed.buf = blocks.buf.slice();
    changed.buf[100] = changed.buf[100]! ^ 1;
    await expect(plain(changed, key)).rejects.toThrow();
    await expect(plain(blocks, await newKey())).rejects.toThrow();
  });

  it('cuts back into a sealed record and carries on, as a resume does, from a fresh sink over the same storage', async () => {
    const key = await newKey();
    const blocks = new MemoryBlocks();
    const first = new SealedSink(blocks, key, new Nonces(1));
    const data = bytesOf(RECORD * 3, 5);
    await first.write(data.subarray(0, RECORD * 2 + 500));
    await first.flush();
    const cut = RECORD + 777; // inside record 1, sealed whole
    const again = new SealedSink(blocks, key, new Nonces(2));
    await again.truncate(cut);
    expect(blocks.size()).toBe(SLOT + OVERHEAD + 777); // what's kept of record 1 is sealed again straight away
    expect(sha256Hex(await plain(blocks, key))).toBe(sha256Hex(data.subarray(0, cut)));
    await again.write(data.subarray(cut));
    await again.flush();
    expect(sha256Hex(await plain(blocks, key))).toBe(sha256Hex(data));
  });
});

describe('a tab killed while it carried on', () => {
  it('between sealing a cut record and cutting the rest off, the next Carry on still opens it', async () => {
    const key = await newKey();
    const blocks = new MemoryBlocks();
    const data = bytesOf(900_000, 1);
    const first = new SealedSink(blocks, key, new Nonces(1));
    await first.write(data);
    await first.flush();
    // A Carry on cuts back to 100 000: its seal lands, and the tab goes before the truncate does.
    const truncate = blocks.truncate.bind(blocks);
    blocks.truncate = async () => {};
    await new SealedSink(blocks, key, new Nonces(2)).truncate(100_000);
    blocks.truncate = truncate;
    expect(blocks.size()).toBe(OVERHEAD + 900_000); // the short record, then the long one's tail
    // The next Carry on, to the same point.
    const third = new SealedSink(blocks, key, new Nonces(3));
    await third.truncate(100_000);
    expect(blocks.size()).toBe(OVERHEAD + 100_000);
    expect(sha256Hex(await plain(blocks, key))).toBe(sha256Hex(data.subarray(0, 100_000)));
    await third.write(data.subarray(100_000));
    await third.flush();
    expect(sha256Hex(await plain(blocks, key))).toBe(sha256Hex(data));
  });
});
