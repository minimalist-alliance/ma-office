// The whole download into one archive: the account's files, two desks (one without the helper), README.txt and
// manifest.json, opened by a real unzip and checked against the manifest's own SHA-256s. Then a download cut off
// partway, as by a reload, carrying on from its journal into the same file: still a good archive, nothing read twice
// that was finished, the file it was in carried on from its byte, or read again whole if it changed meanwhile.
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../desk/deskLink', () => ({ DeskNotConnected: class DeskNotConnected extends Error {} }));

const { CantCarryOn, runExport } = await import('./run');
const { freshMeta, MemoryJournal, MemoryKv, SealedJournal } = await import('./journal');
const { newKey, Nonces, RECORD, SealedSink, SLOT, unseal } = await import('./seal');
const { bytesOf, contains, FakeDesk, FileSink, MemoryBlocks, MemorySink, pythonUnzip, realUnzipTest, scratchDir, sha256Hex } = await import('./testkit');
type FakeEntry = import('./testkit').FakeEntry;
type JournalMeta = import('./journal').JournalMeta;
type JournalEntry = import('./journal').JournalEntry;
type RunHooks = import('./run').RunHooks;
type RunControl = import('./run').RunControl;
type RunState = import('./run').RunState;
type Secret = import('./journal').Secret;

const dir = scratchDir();
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => vi.stubGlobal('window', globalThis));

const ACCOUNT = {
  formatVersion: 1,
  account: { userId: 'u-1', email: 'member@example.org' },
  membership: { tier: 'officer', status: 'active' },
  billingHistory: { charges: [], refunds: [], invoices: [] },
  maiaMemories: { available: false, note: 'Not on yet.' },
  desks: [{ deskId: 'd-1', name: 'Personal', hosting: 'cloud' }],
  generatedAt: '2026-11-06T10:00:00Z',
};

const meta = (desks: { deskId: string; name: string; folder: string }[]): JournalMeta =>
  freshMeta({ id: 'x-1', madeAt: new Date(2026, 10, 6, 10, 0).toISOString(), fileName: 'minimalist-alliance-export-2026-11-06.zip', target: 'browser', ended: false, desks });

const hooks = (desks: Record<string, InstanceType<typeof FakeDesk>>, extra: Partial<RunHooks> = {}): RunHooks => ({
  account: async () => ACCOUNT,
  open: async (id: string) => ({ link: desks[id]!.link(), waking: false, done: () => {} }),
  onState: () => {},
  version: 'test',
  everyMs: 1,
  ...extra,
});

const read = (path: string, name: string): string =>
  execFileSync('python3', ['-I', '-c', 'import sys,zipfile; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode())', path, name], { encoding: 'utf8' });

/** Every file in the manifest is in the archive with that size and SHA-256, and the archive has no file it doesn't list. */
function checkAgainstManifest(path: string): { names: string[]; sha: Record<string, string> } {
  realUnzipTest(path);
  const z = pythonUnzip(path);
  expect(z.bad).toBeNull();
  const manifest = JSON.parse(read(path, 'manifest.json')) as { files: { path: string; size: number; sha256: string }[] };
  const files = z.entries.filter((e) => !e.dir && e.name !== 'manifest.json');
  expect(manifest.files.map((f) => f.path).sort()).toEqual(files.map((e) => e.name).sort());
  for (const f of manifest.files) expect(files.find((e) => e.name === f.path)).toMatchObject({ size: f.size, sha256: f.sha256 });
  expect(new Set(z.entries.map((e) => e.name)).size).toBe(z.entries.length); // no entry twice
  return { names: z.entries.map((e) => e.name), sha: Object.fromEntries(files.map((e) => [e.name, e.sha256 ?? ''])) };
}

describe('runExport', () => {
  it('writes the layout of decision 2, totals each desk as it answers, and manifest.json checks every file in it', async () => {
    const personal = new FakeDesk([
      { part: 'browser', path: 'profile/Default/History', bytes: bytesOf(1_500_000, 1) },
      { part: 'browser-readable', path: 'Default/bookmarks.html', bytes: new TextEncoder().encode('<DL></DL>') },
      { part: 'files', path: 'notes.txt', bytes: bytesOf(10, 2) },
    ]);
    const work = new FakeDesk([{ part: 'files', path: 'x', bytes: bytesOf(5, 3) }]);
    work.noHelper = true;
    const closed: string[] = [];
    const totals: number[] = [];
    const sink = new MemorySink();
    const journal = new MemoryJournal();
    const state = await runExport(
      { sink, journal, meta: meta([{ deskId: 'd-1', name: 'Personal', folder: 'Personal' }, { deskId: 'd-2', name: 'Work', folder: 'Work' }]) },
      hooks({ 'd-1': personal, 'd-2': work }, {
        open: async (id) => ({ link: ({ 'd-1': personal, 'd-2': work } as Record<string, InstanceType<typeof FakeDesk>>)[id]!.link(), waking: false, done: () => closed.push(id) }),
        onState: (s) => void (s.desks[0]?.phase === 'copying' && totals.push(s.total)),
      }),
      new AbortController().signal,
    );
    expect(state.phase).toBe('done');
    expect(state.desks.map((d) => d.phase)).toEqual(['done', 'unavailable']);
    expect(closed.sort()).toEqual(['d-1', 'd-2']);
    // The total was known before the first byte of a desk was copied: its estimate, and the account.
    expect(totals[0]).toBeGreaterThanOrEqual(1_500_000 + 9 + 10);
    expect(state.done).toBe(state.total);

    const path = join(dir, 'whole.zip');
    writeFileSync(path, sink.bytes());
    expect(state.size).toBe(sink.length);
    const { names } = checkAgainstManifest(path);
    expect(names.slice(0, 7)).toEqual(['README.txt', 'manifest.json', 'account/account.json', 'account/membership.json', 'account/billing-history.json', 'account/maia-memories.json', 'account/desks.json']);
    expect(names).toContain('desks/Personal/browser/profile/Default/History');
    expect(names).toContain('desks/Personal/browser-readable/Default/bookmarks.html');
    expect(names.filter((n) => n.startsWith('desks/Work'))).toEqual([]);
    const manifest = JSON.parse(read(path, 'manifest.json')) as { format: number; desks: { name: string; complete: boolean; note?: string }[] };
    expect(manifest.format).toBe(1);
    expect(manifest.desks.map((d) => [d.name, d.complete])).toEqual([
      ['Personal', true],
      ['Work', false],
    ]);
    expect(manifest.desks[1]?.note).toMatch(/isn't available on this desk yet/);
    expect(JSON.parse(read(path, 'account/account.json'))).toEqual(ACCOUNT.account);
    expect(read(path, 'README.txt')).toContain('Work: the download');
    // The journal ends describing the whole archive but its last three: README, manifest and the directory.
    expect(journal.meta?.desks.every((d) => d.done)).toBe(true);
  });
});

describe('carrying on after a reload', () => {
  const BIG = 3 * 1024 * 1024 + 77;
  const entries = (bigSeed: number): FakeEntry[] => [
    { part: 'files', path: 'a.txt', bytes: bytesOf(20_000, 1) },
    { part: 'files', path: 'b.txt', bytes: bytesOf(30_000, 2) },
    { part: 'files', path: 'big.bin', bytes: bytesOf(BIG, bigSeed) },
    { part: 'files', path: 'z.txt', bytes: bytesOf(10_000, 4) },
  ];
  const plan = [{ deskId: 'd-1', name: 'Personal', folder: 'Personal' }];

  /** A journal that cuts the download off once it has saved part of big.bin, as a reload would. */
  class CutJournal extends MemoryJournal {
    constructor(private readonly ac: AbortController) {
      super();
    }
    override async save(m: JournalMeta, e: readonly JournalEntry[]): Promise<void> {
      await super.save(m, e);
      if ((m.open?.size ?? 0) > 1024 * 1024) this.ac.abort();
    }
  }

  async function cutOff(path: string): Promise<CutJournal> {
    const ac = new AbortController();
    const journal = new CutJournal(ac);
    const first = new FakeDesk(entries(3));
    first.perTick = 1;
    const sink = new FileSink(path);
    await expect(runExport({ sink, journal, meta: meta(plan) }, hooks({ 'd-1': first }, { checkpointMs: 5 }), ac.signal)).rejects.toMatchObject({ name: 'Cancelled' });
    sink.close();
    expect(journal.meta?.open?.name).toBe('desks/Personal/files/big.bin');
    return journal;
  }

  it('cuts the archive back to the journal, carries the open file on from its byte, and reads nothing finished again', async () => {
    const path = join(dir, 'resumed.zip');
    const journal = await cutOff(path);
    const at = journal.meta!.open!.size;
    const loaded = (await journal.load())!;
    expect(loaded.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['account/account.json', 'desks/Personal/files/a.txt', 'desks/Personal/files/b.txt']));

    const again = new FakeDesk(entries(3));
    const sink = new FileSink(path, undefined, true);
    const state = await runExport({ sink, journal, meta: loaded.meta, entries: loaded.entries }, hooks({ 'd-1': again }), new AbortController().signal);
    sink.close();
    expect(state.phase).toBe('done');
    expect(again.reads).toEqual([
      { path: 'big.bin', offset: at },
      { path: 'z.txt', offset: 0 },
    ]);
    const { sha } = checkAgainstManifest(path);
    for (const e of entries(3)) expect(sha[`desks/Personal/files/${e.path}`]).toBe(sha256Hex(e.bytes!));
  });

  it('reads the open file again from 0 when it changed while the page was away: the trailer tells', async () => {
    const path = join(dir, 'changed.zip');
    const journal = await cutOff(path);
    const at = journal.meta!.open!.size;
    const loaded = (await journal.load())!;
    const changed = entries(99); // big.bin is different now, all through
    const again = new FakeDesk(changed);
    const sink = new FileSink(path, undefined, true);
    await runExport({ sink, journal, meta: loaded.meta, entries: loaded.entries }, hooks({ 'd-1': again }), new AbortController().signal);
    sink.close();
    expect(again.reads.filter((r) => r.path === 'big.bin').map((r) => r.offset)).toEqual([at, 0]);
    const { sha } = checkAgainstManifest(path);
    expect(sha['desks/Personal/files/big.bin']).toBe(sha256Hex(changed[2]!.bytes!));
    expect(sha['desks/Personal/files/a.txt']).toBe(sha256Hex(changed[0]!.bytes!));
  });

  it('lets go of the open file when the desk no longer has it', async () => {
    const path = join(dir, 'gone.zip');
    const journal = await cutOff(path);
    const loaded = (await journal.load())!;
    const again = new FakeDesk(entries(3).filter((e) => e.path !== 'big.bin'));
    const sink = new FileSink(path, undefined, true);
    await runExport({ sink, journal, meta: loaded.meta, entries: loaded.entries }, hooks({ 'd-1': again }), new AbortController().signal);
    sink.close();
    const { names } = checkAgainstManifest(path);
    expect(names).not.toContain('desks/Personal/files/big.bin');
    expect(names).toContain('desks/Personal/files/z.txt');
  });
});

describe('carrying on, sealed', () => {
  const MARKER = 'MA-PLAINTEXT-MARKER-5e07';
  const files: FakeEntry[] = [
    { part: 'files', path: `${MARKER}.txt`, bytes: new TextEncoder().encode(`${MARKER}\n`.repeat(4000)) },
    { part: 'files', path: 'big.bin', bytes: bytesOf(3 * 1024 * 1024 + 501, 7) },
    { part: 'files', path: 'z.txt', bytes: new TextEncoder().encode(`${MARKER} again\n`.repeat(100)) },
  ];
  const plan = [{ deskId: 'd-1', name: MARKER, folder: MARKER }];

  it('keeps nothing in the clear, carries on through the seal, and unseals to an archive unzip and zipfile pass', async () => {
    const blocks = new MemoryBlocks();
    const kv = new MemoryKv();
    const key = await newKey();
    const secret: Secret = { key, epoch: 1, at: 0 };
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });

    // First session, cut off partway through big.bin as a reload would.
    const ac = new AbortController();
    const n1 = new Nonces(1);
    const sink1 = new SealedSink(blocks, key, n1);
    const j1 = new SealedJournal(kv, secret, n1);
    const save = j1.save.bind(j1);
    j1.save = async (m, e) => {
      await save(m, e);
      if ((m.open?.size ?? 0) > 1024 * 1024 + 300_000) ac.abort();
    };
    const first = new FakeDesk(files);
    first.perTick = 1;
    await expect(runExport({ sink: sink1, journal: j1, meta: meta(plan) }, hooks({ 'd-1': first }, { checkpointMs: 5, sync: () => sink1.flush() }), ac.signal)).rejects.toMatchObject({ name: 'Cancelled' });

    // Second session: epoch 2, the journal read back through the key.
    const n2 = new Nonces(2);
    const loaded = (await new SealedJournal(kv, kv.secret!, null).load())!;
    expect(loaded.meta.open?.name).toBe(`desks/${MARKER}/files/big.bin`);
    expect(loaded.meta.pos % (1024 * 1024)).not.toBe(0); // a record cut in two
    const at = loaded.meta.open!.size;
    const sink2 = new SealedSink(blocks, key, n2);
    const j2 = new SealedJournal(kv, { ...kv.secret!, epoch: 2 }, n2);
    const again = new FakeDesk(files);
    const state = await runExport({ sink: sink2, journal: j2, meta: loaded.meta, entries: loaded.entries }, hooks({ 'd-1': again }, { sync: () => sink2.flush() }), new AbortController().signal);
    await sink2.flush();
    expect(state.phase).toBe('done');
    expect(again.reads[0]).toEqual({ path: 'big.bin', offset: at });

    for (const b of [blocks.buf, kv.meta!, ...kv.entries]) {
      expect(contains(b, MARKER)).toBe(false);
      expect(contains(b, 'desks/')).toBe(false);
    }

    const parts: Uint8Array[] = [];
    for await (const p of unseal(blocks, blocks.size(), key)) parts.push(p);
    const path = join(dir, 'sealed.zip');
    writeFileSync(path, Buffer.concat(parts));
    const { sha } = checkAgainstManifest(path); // unzip -t and python -m zipfile -t, and every SHA-256 in the manifest
    for (const e of files) expect(sha[`desks/${MARKER}/files/${e.path}`]).toBe(sha256Hex(e.bytes!));
  });
});

describe('a disk that fails', () => {
  /** Room for `limit` bytes: a write past it fails as OPFS does, and none of it lands. */
  class FullDisk extends MemorySink {
    constructor(private readonly limit: number) {
      super();
    }
    override async write(b: Uint8Array): Promise<void> {
      if (this.length + b.length > this.limit) throw new DOMException('quota', 'QuotaExceededError');
      return super.write(b);
    }
  }
  const plan = [
    { deskId: 'd-1', name: 'One', folder: 'One' },
    { deskId: 'd-2', name: 'Two', folder: 'Two' },
  ];
  const desks = (): { one: InstanceType<typeof FakeDesk>; two: InstanceType<typeof FakeDesk> } => ({
    one: new FakeDesk([
      { part: 'files', path: 'a-small.bin', bytes: bytesOf(200 * 1024, 3) },
      { part: 'files', path: 'b-big.bin', bytes: bytesOf(8 * 1024 * 1024, 4) },
      { part: 'files', path: 'c-after.bin', bytes: bytesOf(200 * 1024, 5) },
    ]),
    two: new FakeDesk([{ part: 'files', path: 'other.bin', bytes: bytesOf(200 * 1024, 6) }]),
  });

  it("fails the whole download with the browser's own error when the disk fills, and never says it's done", async () => {
    const { one, two } = desks();
    const phases: string[] = [];
    const run = runExport({ sink: new FullDisk(4 * 1024 * 1024), journal: new MemoryJournal(), meta: meta(plan) }, hooks({ 'd-1': one, 'd-2': two }, { onState: (st) => phases.push(st.phase) }), new AbortController().signal);
    await expect(run).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(phases).not.toContain('done');
    expect(two.reads).toEqual([]);
  });

  it('a write that fails once fails the download, rather than going on into an archive with a hole in it', async () => {
    const { one, two } = desks();
    const sink = new MemorySink();
    const write = sink.write.bind(sink);
    let writes = 0;
    sink.write = async (b: Uint8Array) => {
      writes += 1;
      if (writes === 3) throw new DOMException('quota', 'QuotaExceededError');
      return write(b);
    };
    await expect(runExport({ sink, journal: new MemoryJournal(), meta: meta(plan) }, hooks({ 'd-1': one, 'd-2': two }), new AbortController().signal)).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(two.reads).toEqual([]);
  });

  it('a working copy that could not be made durable fails it too', async () => {
    const { one, two } = desks();
    const sync = (): Promise<void> => Promise.reject(new DOMException('quota', 'QuotaExceededError'));
    await expect(runExport({ sink: new MemorySink(), journal: new MemoryJournal(), meta: meta(plan) }, hooks({ 'd-1': one, 'd-2': two }, { sync }), new AbortController().signal)).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(two.reads).toEqual([]); // at the first checkpoint, not after copying everything
  });

  it("a working copy that doesn't hold what its journal says can't carry on, and says so rather than failing every time", async () => {
    const key = await newKey();
    const blocks = new MemoryBlocks();
    const first = new SealedSink(blocks, key, new Nonces(1));
    await first.write(bytesOf(RECORD + 200_000, 9));
    await first.flush();
    await blocks.truncate(SLOT + 100); // the second record torn short
    const m = { ...meta(plan.slice(0, 1)), pos: RECORD + 5_000 };
    await expect(runExport({ sink: new SealedSink(blocks, key, new Nonces(2)), journal: new MemoryJournal(), meta: m, entries: [] }, hooks({}), new AbortController().signal)).rejects.toBeInstanceOf(CantCarryOn);
  });
});

describe('a desk that never opens', () => {
  const plan = [
    { deskId: 'stuck', name: 'Work', folder: 'Work' },
    { deskId: 'fine', name: 'Personal', folder: 'Personal' },
  ];

  it('holds nobody up: the others are copied while it waits, and leaving it out finishes the download', async () => {
    const stuck = new FakeDesk([{ part: 'files', path: 'b.bin', bytes: bytesOf(1000, 2) }]);
    stuck.state = 'retrying'; // a link that never opens, as a desk that won't wake
    const fine = new FakeDesk([{ part: 'files', path: 'a.bin', bytes: bytesOf(1000, 1) }]);
    const sink = new MemorySink();
    let control = null as RunControl | null;
    let last = null as RunState | null;
    const run = runExport(
      { sink, journal: new MemoryJournal(), meta: meta(plan) },
      hooks({ stuck, fine }, { control: (c) => void (control = c), onState: (st) => void (last = st) }),
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(last?.desks[1]?.phase).toBe('done'), { timeout: 10_000 });
    expect(last!.desks[0]?.phase).toBe('connecting');
    control!.leaveOut('stuck');
    const state = await run;
    expect(state.phase).toBe('done');
    expect(state.desks.map((d) => d.phase)).toEqual(['left', 'done']);
    const path = join(dir, 'left-out.zip');
    writeFileSync(path, sink.bytes());
    const { names } = checkAgainstManifest(path);
    expect(names).toContain('desks/Personal/files/a.bin');
    expect(names.filter((n) => n.startsWith('desks/Work'))).toEqual([]);
    const manifest = JSON.parse(read(path, 'manifest.json')) as { desks: { name: string; complete: boolean; note?: string }[] };
    expect(manifest.desks.map((d) => [d.name, d.complete, d.note])).toEqual([
      ['Work', false, 'it was left out of this download.'],
      ['Personal', true, undefined],
    ]);
    expect(read(path, 'README.txt')).toContain('Work: it was left out of this download.');
  });

  it('a desk left out while it copies keeps the files it finished, and nothing half-written', async () => {
    const slow = new FakeDesk([
      { part: 'files', path: 'a.bin', bytes: bytesOf(50_000, 1) },
      { part: 'files', path: 'big.bin', bytes: bytesOf(3_000_000, 2) },
    ]);
    slow.perTick = 1;
    const other = new FakeDesk([{ part: 'files', path: 'z.bin', bytes: bytesOf(20_000, 3) }]);
    const sink = new MemorySink();
    let control = null as RunControl | null;
    let asked = false;
    const state = await runExport(
      { sink, journal: new MemoryJournal(), meta: meta([{ deskId: 'slow', name: 'Work', folder: 'Work' }, { deskId: 'other', name: 'Personal', folder: 'Personal' }]) },
      hooks(
        { slow, other },
        {
          control: (c) => void (control = c),
          onState: (st) => {
            if (!asked && (st.desks[0]?.bytesDone ?? 0) > 200_000) {
              asked = true;
              control!.leaveOut('slow');
            }
          },
        },
      ),
      new AbortController().signal,
    );
    expect(state.desks.map((d) => d.phase)).toEqual(['left', 'done']);
    const path = join(dir, 'left-mid.zip');
    writeFileSync(path, sink.bytes());
    const { names } = checkAgainstManifest(path);
    expect(names).toContain('desks/Work/files/a.bin');
    expect(names).not.toContain('desks/Work/files/big.bin');
    expect(names).toContain('desks/Personal/files/z.bin');
  });
});
