// The ZIP writer against real unzips: Python's zipfile (which CRC-checks every member) and Info-ZIP's unzip -t.
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { archiveOrder } from './archive';
import { FileSink, MemorySink, pythonUnzip, realUnzipTest, scratchDir, sha256Hex } from './testkit';
import { ZipWriter } from './zip';

const dir = scratchDir();
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const save = (name: string, sink: MemorySink): string => {
  const p = join(dir, name);
  writeFileSync(p, sink.bytes());
  return p;
};
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const count = (hay: Uint8Array, sig: number[]): number => {
  let n = 0;
  for (let i = 0; i + 4 <= hay.length; i += 1) if (hay[i] === sig[0] && hay[i + 1] === sig[1] && hay[i + 2] === sig[2] && hay[i + 3] === sig[3]) n += 1;
  return n;
};
const DESCRIPTOR = [0x50, 0x4b, 0x07, 0x08];
const ZIP64_END = [0x50, 0x4b, 0x06, 0x06];

describe('ZipWriter, opened by a real unzip', () => {
  it('writes STORED entries with data descriptors, CRC-32 and UTF-8 names that Python and unzip both accept', async () => {
    const sink = new MemorySink();
    const zip = new ZipWriter(sink, { bufferBytes: 64 * 1024 });
    const big = randomBytes(300_001);
    await zip.add('README.txt', text('hello\n'));
    await zip.addDir('desks/Café/files/Empty folder/');
    await zip.begin('desks/Café/files/notes — ünïcødé.txt', { mtimeMs: Date.UTC(2026, 10, 5, 9, 30), mode: 0o600, sizeHint: big.length });
    for (let at = 0; at < big.length; at += 16372) await zip.data(big.subarray(at, at + 16372));
    expect(await zip.end()).toMatchObject({ size: big.length });
    await zip.add('desks/Café/files/empty.txt', new Uint8Array(0));
    await zip.add('manifest.json', text('{}\n'));
    await zip.finish(archiveOrder);
    const path = save('basic.zip', sink);

    realUnzipTest(path);
    const z = pythonUnzip(path);
    expect(z.bad).toBeNull();
    expect(z.entries.map((e) => e.name)).toEqual(['README.txt', 'manifest.json', 'desks/Café/files/Empty folder/', 'desks/Café/files/notes — ünïcødé.txt', 'desks/Café/files/empty.txt']);
    const notes = z.entries.find((e) => e.name.includes('ünïcødé'))!;
    expect(notes).toMatchObject({ size: big.length, sha256: sha256Hex(big), flag: 0x0808, mode: 0o100600 });
    expect(z.entries.find((e) => e.dir)).toMatchObject({ flag: 0x0800, mode: 0o40755 });
    // Every file has its descriptor after its bytes; the directory has none.
    expect(count(sink.bytes(), DESCRIPTOR)).toBe(4);
    expect(count(sink.bytes(), ZIP64_END)).toBe(0);
  });

  it('rewinds an entry it has begun, header and all, even once part of it has reached the sink', async () => {
    const sink = new MemorySink();
    const zip = new ZipWriter(sink, { bufferBytes: 4096 });
    await zip.add('a.txt', text('first'));
    const before = zip.position;
    await zip.begin('b.bin');
    await zip.data(randomBytes(50_000));
    expect(sink.length).toBeGreaterThan(before);
    await zip.rewind();
    expect(zip.position).toBe(before);
    const again = randomBytes(10_000);
    await zip.begin('b.bin');
    await zip.data(again);
    await zip.end();
    await zip.finish();
    const z = pythonUnzip(save('rewind.zip', sink));
    expect(z.bad).toBeNull();
    expect(z.entries.map((e) => [e.name, e.sha256])).toEqual([
      ['a.txt', sha256Hex(text('first'))],
      ['b.bin', sha256Hex(again)],
    ]);
  });

  it('writes ZIP64 records when told to, however small, and both unzips read them', async () => {
    const sink = new MemorySink();
    const zip = new ZipWriter(sink, { forceZip64: true });
    const body = randomBytes(5000);
    await zip.add('small.bin', body);
    await zip.addDir('folder/');
    await zip.add('folder/x.txt', text('x'));
    await zip.finish();
    const path = save('forced64.zip', sink);
    realUnzipTest(path);
    const z = pythonUnzip(path);
    expect(z.bad).toBeNull();
    expect(z.entries.map((e) => [e.name, e.size])).toEqual([
      ['small.bin', 5000],
      ['folder/', 0],
      ['folder/x.txt', 1],
    ]);
    expect(z.entries[0]?.sha256).toBe(sha256Hex(body));
    expect(count(sink.bytes(), ZIP64_END)).toBe(1);
  });

  it(
    'writes a file past 4 GiB as ZIP64, with an entry after it past 4 GiB too (sparse on disk)',
    async () => {
      const ZERO = new Uint8Array(8 * 1024 * 1024);
      const path = join(dir, 'big64.zip');
      const sink = new FileSink(path, ZERO);
      const zip = new ZipWriter(sink);
      const size = 4 * 1024 ** 3 + ZERO.length; // 4 GiB and 8 MiB
      await zip.add('README.txt', text('big\n'));
      await zip.begin('desks/Personal/files/big.bin', { sizeHint: size });
      for (let at = 0; at < size; at += ZERO.length) await zip.data(ZERO);
      const written = await zip.end();
      expect(written.size).toBe(size);
      const tail = randomBytes(1234);
      await zip.add('desks/Personal/files/after.bin', tail);
      await zip.finish(archiveOrder);
      sink.close();
      expect(statSync(path).size).toBeGreaterThan(size);

      realUnzipTest(path);
      const z = pythonUnzip(path);
      expect(z.bad).toBeNull();
      const big = z.entries.find((e) => e.name.endsWith('big.bin'))!;
      expect(big.size).toBe(size);
      expect(big.crc).toBe(written.crc); // and `bad` is null: Python read all of it and got the same CRC
      const after = z.entries.find((e) => e.name.endsWith('after.bin'))!;
      expect(after.offset).toBeGreaterThan(2 ** 32);
      expect(after.sha256).toBe(sha256Hex(tail));
      const head = Buffer.alloc(4);
      const fd = openSync(path, 'r');
      readSync(fd, head, 0, 4, 0);
      closeSync(fd);
      expect([...head]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    },
    600_000,
  );
});

describe('a write that fails', () => {
  /** A sink whose `failOn`th write throws, as a full disk does, and whose later writes work, as when room comes back. */
  class Flaky extends MemorySink {
    calls = 0;
    constructor(private readonly failOn: number) {
      super();
    }
    override async write(bytes: Uint8Array): Promise<void> {
      this.calls += 1;
      if (this.calls === this.failOn) throw new DOMException('quota', 'QuotaExceededError');
      return super.write(bytes);
    }
  }

  it("doesn't count bytes that never landed, and writes nothing more, so it never finishes a broken archive", async () => {
    const sink = new Flaky(5);
    const zip = new ZipWriter(sink, { bufferBytes: 1024 });
    await zip.add('a.bin', new Uint8Array(4000).fill(1)); // writes 1 and 2: the header, then the bytes
    await zip.checkpoint(); // 3: the descriptor
    expect(zip.position).toBe(sink.length);
    // 4: the next header, then 5, its bytes, fails.
    await expect(zip.add('b.bin', new Uint8Array(4000).fill(2))).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(zip.position).toBe(sink.length); // what the sink has, not what was handed to it
    expect(zip.failure?.err).toMatchObject({ name: 'QuotaExceededError' });
    // Room comes back, and still nothing more is written: the archive would have a hole in it.
    await expect(zip.add('c.bin', text('c'))).rejects.toMatchObject({ name: 'QuotaExceededError' });
    await expect(zip.checkpoint()).rejects.toMatchObject({ name: 'QuotaExceededError' });
    await expect(zip.finish()).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(sink.calls).toBe(5);
  });
});
