// One desk's copy against a fake desk that sends `bulk` as deskd does: several reads at once, credit granted only after
// writing, the trailer checked, and a dropped session carried on from the byte it reached.
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../desk/deskLink', () => ({
  DeskNotConnected: class DeskNotConnected extends Error {
    inFlight: boolean;
    constructor(deskId: string, inFlight = false) {
      super(`Desk ${deskId} is not connected`);
      this.inFlight = inFlight;
    }
  },
}));

const { DeskCopy, DeskUnavailable, MAX_IN_FLIGHT } = await import('./copier');
const { ZipWriter } = await import('./zip');
const { bytesOf, FakeDesk, MemorySink, pythonUnzip, scratchDir, sha256Hex } = await import('./testkit');
type FakeEntry = import('./testkit').FakeEntry;

const MiB = 1024 * 1024;
const dir = scratchDir();
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  vi.stubGlobal('window', globalThis);
});

async function copy(desk: InstanceType<typeof FakeDesk>, name: string, signal = new AbortController().signal) {
  const sink = new MemorySink();
  const zip = new ZipWriter(sink);
  const progress: { phase: string; filesDone: number; bytesDone: number }[] = [];
  const result = await new DeskCopy(desk.link(), zip, 'desks/Personal/', (p) => progress.push(p), signal).run();
  await zip.finish();
  const path = join(dir, name);
  writeFileSync(path, sink.bytes());
  return { result, z: pythonUnzip(path), progress };
}

const file = (part: string, path: string, n: number, seed: number): FakeEntry => ({ part, path, bytes: bytesOf(n, seed) });

describe('DeskCopy', () => {
  it('copies every part, page by page, into desks/<name>/<part>/, every file checked against its trailer', async () => {
    const entries: FakeEntry[] = [
      { part: 'browser', path: 'profile', type: 'dir' },
      { part: 'browser', path: 'profile/Default', type: 'dir' },
      file('browser', 'profile/Default/Cookies', 40_000, 1),
      file('browser', 'profile/Default/History', 2 * MiB + 17, 2),
      file('files', 'a.txt', 10, 3),
      file('files', 'é/b.txt', 0, 4),
      { part: 'files', path: 'latest', type: 'link', target: 'a.txt' },
    ];
    const desk = new FakeDesk(entries);
    desk.pageSize = 2;
    const { result, z } = await copy(desk, 'parts.zip');
    expect(z.bad).toBeNull();
    expect(z.entries.map((e) => e.name)).toEqual([
      'desks/Personal/',
      'desks/Personal/browser/',
      'desks/Personal/browser/profile/',
      'desks/Personal/browser/profile/Default/',
      'desks/Personal/browser/profile/Default/Cookies',
      'desks/Personal/browser/profile/Default/History',
      'desks/Personal/files/',
      'desks/Personal/files/a.txt',
      'desks/Personal/files/é/b.txt',
    ]);
    for (const e of entries.filter((x) => x.bytes)) {
      expect(z.entries.find((x) => x.name === `desks/Personal/${e.part}/${e.path}`)?.sha256).toBe(sha256Hex(e.bytes!));
    }
    expect(result.files.map((f) => f.sha256)).toEqual(entries.filter((x) => x.bytes).map((x) => sha256Hex(x.bytes!)));
    expect(result.links).toEqual([{ path: 'desks/Personal/files/latest', target: 'a.txt' }]);
    expect(result.parts).toEqual([
      { part: 'browser', label: 'Browser', files: 2, bytes: 40_000 + 2 * MiB + 17 },
      { part: 'files', label: 'Files', files: 2, bytes: 10 },
    ]);
    expect(result.notCopied).toEqual([]);
  });

  it(`reads up to ${MAX_IN_FLIGHT} files at once, and many small files all arrive`, async () => {
    const entries = Array.from({ length: 60 }, (_, i) => file('files', `f${String(i).padStart(2, '0')}.bin`, 30_000 + i, 10 + i));
    const desk = new FakeDesk(entries);
    const { z } = await copy(desk, 'many.zip');
    expect(z.bad).toBeNull();
    expect(z.entries.filter((e) => !e.dir)).toHaveLength(60);
    expect(desk.maxActive).toBeGreaterThan(1);
    expect(desk.maxActive).toBeLessThanOrEqual(MAX_IN_FLIGHT);
  });

  it('grants credit only after writing, in steps of at least 256 KiB, and never lets the desk run more than a MiB ahead', async () => {
    const big = file('files', 'big.bin', 5 * MiB + 3, 99);
    const desk = new FakeDesk([big]);
    const { z } = await copy(desk, 'credit.zip');
    expect(z.entries.find((e) => e.name.endsWith('big.bin'))?.sha256).toBe(sha256Hex(big.bytes!));
    expect(desk.credits.length).toBeGreaterThan(0);
    for (const c of desk.credits) expect(c.bytes).toBeGreaterThanOrEqual(256 * 1024);
    // The first MiB comes with data.read; everything after it was asked for.
    expect(1024 * 1024 + desk.credits.reduce((s, c) => s + c.bytes, 0)).toBeGreaterThanOrEqual(big.bytes!.length);
    expect(desk.credits.reduce((s, c) => s + c.bytes, 0)).toBeLessThan(big.bytes!.length);
  });

  it('carries on after a dropped session from the byte it reached, with the hash it had, and the desk checks the whole file', async () => {
    const big = file('files', 'big.bin', 3 * MiB + 5, 7);
    const small = file('files', 'small.bin', 50_000, 8);
    const desk = new FakeDesk([big, small]);
    desk.dropAfter = { path: 'big.bin', bytes: 1536 * 1024 };
    const { z, progress } = await copy(desk, 'resume.zip');
    expect(z.bad).toBeNull();
    expect(z.entries.find((e) => e.name.endsWith('big.bin'))?.sha256).toBe(sha256Hex(big.bytes!));
    expect(z.entries.find((e) => e.name.endsWith('small.bin'))?.sha256).toBe(sha256Hex(small.bytes!));
    const reads = desk.reads.filter((r) => r.path === 'big.bin');
    expect(reads).toHaveLength(2);
    expect(reads[0]?.offset).toBe(0);
    expect(reads[1]?.offset).toBeGreaterThanOrEqual(1536 * 1024); // not from the start
    expect(progress.some((p) => p.phase === 'reconnecting')).toBe(true);
  });

  it('reads a file again from 0 when its trailer disagrees, and gives up on one that keeps changing', async () => {
    const a = file('files', 'changes-once.bin', 200_000, 5);
    const b = file('files', 'keeps-changing.bin', 1000, 6);
    const desk = new FakeDesk([a, b]);
    desk.changeNext.add('changes-once.bin');
    desk.changeAlways.add('keeps-changing.bin');
    const { result, z } = await copy(desk, 'mismatch.zip');
    expect(z.bad).toBeNull();
    expect(z.entries.find((e) => e.name.endsWith('changes-once.bin'))?.sha256).toBe(sha256Hex(a.bytes!));
    expect(desk.reads.filter((r) => r.path === 'changes-once.bin').map((r) => r.offset)).toEqual([0, 0]);
    expect(desk.reads.filter((r) => r.path === 'keeps-changing.bin')).toHaveLength(3);
    expect(z.entries.some((e) => e.name.endsWith('keeps-changing.bin'))).toBe(false);
    expect(result.notCopied).toEqual([{ path: 'desks/Personal/files/keeps-changing.bin', reason: 'It kept changing while it was being copied.' }]);
  });

  it('reads a file that came up short of its size again, and lists one that always does', async () => {
    const e: FakeEntry = { ...file('files', 'log.txt', 100_000, 3), shrinkTo: 60_000 };
    const desk = new FakeDesk([e]);
    const { result, z } = await copy(desk, 'shrank.zip');
    expect(z.entries.some((x) => x.name.endsWith('log.txt'))).toBe(false);
    expect(desk.reads.filter((r) => r.path === 'log.txt').map((r) => r.offset)).toEqual([0, 0, 0]);
    expect(result.notCopied).toEqual([{ path: 'desks/Personal/files/log.txt', reason: 'It kept changing while it was being copied.' }]);
  });

  it('a lost CHUNK goes on from what arrived; a CHUNK before its data.read answer is kept for it', async () => {
    const a = file('files', 'a.bin', 400_000, 1);
    const b = file('files', 'b.bin', 30_000, 2);
    const desk = new FakeDesk([a, b]);
    desk.loseOne = 'a.bin';
    desk.chunkFirst = true;
    const { z } = await copy(desk, 'lost.zip');
    expect(z.bad).toBeNull();
    expect(z.entries.find((e) => e.name.endsWith('a.bin'))?.sha256).toBe(sha256Hex(a.bytes!));
    expect(z.entries.find((e) => e.name.endsWith('b.bin'))?.sha256).toBe(sha256Hex(b.bytes!));
    const again = desk.reads.filter((r) => r.path === 'a.bin');
    expect(again.length).toBe(2);
    expect(again[1]!.offset).toBeGreaterThan(0);
  });

  it('leaves out what it cannot read or name safely, and says why', async () => {
    const desk = new FakeDesk([file('files', 'gone.txt', 10, 1), file('files', '../escape.txt', 10, 2), file('files', 'ok.txt', 10, 3)]);
    desk.refuseRead.set('gone.txt', 'not_found');
    const { result, z } = await copy(desk, 'skips.zip');
    expect(z.entries.filter((e) => !e.dir).map((e) => e.name)).toEqual(['desks/Personal/files/ok.txt']);
    expect(result.notCopied).toEqual([
      { path: 'desks/Personal/files/../escape.txt', reason: "Its name can't be stored safely in an archive." },
      { path: 'desks/Personal/files/gone.txt', reason: 'It was removed while the download ran.' },
    ]);
  });

  it('says a desk without the helper has no export yet', async () => {
    const desk = new FakeDesk([file('files', 'a.txt', 1, 1)]);
    desk.noHelper = true;
    await expect(copy(desk, 'nohelper.zip')).rejects.toBeInstanceOf(DeskUnavailable);
  });

  it('gives up on a desk whose link stays down, and stops at once when cancelled', async () => {
    const desk = new FakeDesk([file('files', 'a.bin', 2 * MiB, 1)]);
    desk.setState('idle');
    const fast = { now: () => Date.now() * 1000, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms / 1000) as unknown as number, clearTimeout: (id: number) => clearTimeout(id) };
    const zip = new ZipWriter(new MemorySink());
    await expect(new DeskCopy(desk.link(), zip, 'desks/P/', () => {}, new AbortController().signal, fast).run()).rejects.toMatchObject({ reason: 'gone' });

    const live = new FakeDesk([file('files', 'a.bin', 4 * MiB, 1)]);
    const ac = new AbortController();
    const run = new DeskCopy(live.link(), new ZipWriter(new MemorySink()), 'desks/P/', (p) => p.bytesDone > MiB && ac.abort(), ac.signal).run();
    await expect(run).rejects.toMatchObject({ name: 'Cancelled' });
    expect(live.stops.length).toBeGreaterThan(0); // its transfer was stopped
  });
});
