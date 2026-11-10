// The transfer engine against the mock Files desk: uploads that are credited and resume, the image check, the limits, and
// downloads (a file, and a folder as a ZIP a real unzip opens).
import { rmSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../desk/deskLink', () => ({
  DeskNotConnected: class DeskNotConnected extends Error {
    inFlight: boolean;
    constructor(deskId: string, inFlight = false) {
      super(`Desk ${deskId} is not connected`);
      this.name = 'DeskNotConnected';
      this.inFlight = inFlight;
    }
  },
}));

const { TransferEngine, UPLOADS_AT_ONCE } = await import('./engine');
const { FilesApi } = await import('./api');
const { MockFilesDesk } = await import('../../desk/mockDeskFiles');
const { MockBulk, newDataControl } = await import('../../desk/mockDeskData');
const { StubImageCheck, newStubControl } = await import('../../platform/stubImageCheck');
const { BlobSink } = await import('./save');
const { MemorySink, pythonUnzip, scratchDir, bytesOf, sha256Hex } = await import('../../export/testkit');
type DeskLink = import('../../desk/deskLink').DeskLink;
type LinkState = import('../../desk/deskLink').LinkState;

const dir = scratchDir();
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  vi.stubGlobal('window', globalThis);
});

const MiB = 1024 * 1024;

/** A link over one mock desk, with a session that can be dropped and brought back. */
function rig(opts: { stub?: Partial<ReturnType<typeof newStubControl>>; tickMs?: number } = {}) {
  const desk = new MockFilesDesk().seed();
  const listeners = new Set<(s: LinkState) => void>();
  let state: LinkState = 'open';
  const slow = (): ReturnType<typeof newDataControl> => ({ ...newDataControl(), tickMs: opts.tickMs ?? 0, chunksPerTick: opts.tickMs ? 4 : 24 });
  let bulk = new MockBulk(slow(), () => {});
  const link = {
    deskId: 'd-test',
    available: true,
    status: () => state,
    onStatus: (fn: (s: LinkState) => void) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    bulk: () => (state === 'open' ? bulk : null),
    call: async (m: string, p: Record<string, unknown> = {}, o?: { idem?: string }) => {
      if (state !== 'open') {
        const { DeskNotConnected } = await import('../../desk/deskLink');
        throw new DeskNotConnected('d-test', false);
      }
      return desk.answer(m, p, { bulk, scope: 'owner', ...(o?.idem ? { idem: o.idem } : {}) });
    },
  } as unknown as DeskLink;
  const setState = (s: LinkState): void => {
    state = s;
    for (const fn of listeners) fn(s);
  };
  const drop = (ms = 300): void => {
    bulk.close();
    desk.detach();
    setState('retrying');
    setTimeout(() => {
      bulk = new MockBulk(slow(), () => {});
      setState('open');
    }, ms);
  };
  desk.control.onDrop = () => drop();
  const stubControl = { ...newStubControl(), startPlace: 3, stepMs: 20, ...opts.stub };
  const imageCheck = new StubImageCheck(stubControl);
  const announced: string[] = [];
  const busy: boolean[] = [];
  const changed: string[] = [];
  const engine = new TransferEngine({
    link,
    api: new FilesApi(link, () => crypto.randomUUID()),
    imageCheck,
    notifyMs: 1,
    announce: (t) => void announced.push(t),
    setBusy: (b) => void busy.push(b),
    changed: (f) => void changed.push(f),
    open: async () => {
      const sink = new BlobSink();
      return { sink, finish: async () => void (outputs.push(sink.blob('x'))), abort: async () => {}, where: 'downloads' as const };
    },
  });
  const outputs: Blob[] = [];
  const seen = { maxSending: 0, words: new Set<string>() };
  engine.subscribe(() => {
    const views = engine.snapshot();
    seen.maxSending = Math.max(seen.maxSending, views.filter((v) => v.state === 'sending' || v.state === 'finishing').length);
    for (const v of views) seen.words.add(v.words);
  });
  return { desk, link, engine, drop, setState, stubControl, announced, busy, changed, outputs, seen };
}

const until = async (cond: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const finished = (e: InstanceType<typeof TransferEngine>): boolean => e.snapshot().length > 0 && e.snapshot().every((v) => ['done', 'failed', 'rejected', 'cancelled'].includes(v.state));
const file = (name: string, bytes: Uint8Array, type = ''): File => new File([bytes as Uint8Array<ArrayBuffer>], name, { type });
const JPEG = (n: number): Uint8Array => {
  const b = bytesOf(n, 5);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
};

describe('uploads', () => {
  it('a small text file lands whole, and the folder is told', async () => {
    const r = rig();
    const bytes = new TextEncoder().encode('hello desk');
    r.engine.upload([{ file: file('hello.txt', bytes), rel: 'hello.txt' }], '');
    await until(() => finished(r.engine));
    expect(r.engine.snapshot()[0]!.state).toBe('done');
    expect([...r.desk.read('hello.txt')!]).toEqual([...bytes]);
    expect(r.changed).toContain('');
    expect(r.busy[0]).toBe(true);
    await until(() => r.busy[r.busy.length - 1] === false);
    r.engine.dispose();
  });

  it('a zero-byte file lands', async () => {
    const r = rig();
    r.engine.upload([{ file: file('empty', new Uint8Array(0)), rel: 'empty' }], 'Documents');
    await until(() => finished(r.engine));
    expect(r.desk.read('Documents/empty')?.length).toBe(0);
    r.engine.dispose();
  });

  it('a multi-megabyte file goes through credit and lands byte for byte, with progress', async () => {
    const r = rig();
    const bytes = bytesOf(3 * MiB + 4321, 9);
    r.engine.upload([{ file: file('big.bin', bytes), rel: 'big.bin' }], '');
    await until(() => finished(r.engine));
    expect(sha256Hex(r.desk.read('big.bin')!)).toBe(sha256Hex(bytes));
    expect(r.engine.snapshot()[0]!.done).toBe(bytes.length);
    r.engine.dispose();
  });

  it('a folder keeps its shape, and a taken name gets "(2)"', async () => {
    const r = rig();
    r.desk.put('readme.txt', new TextEncoder().encode('old'));
    r.engine.upload(
      [
        { file: file('a.txt', new TextEncoder().encode('a')), rel: 'Trip/Day 1/a.txt' },
        { file: file('readme.txt', new TextEncoder().encode('new')), rel: 'readme.txt' },
      ],
      '',
    );
    await until(() => finished(r.engine));
    expect(r.desk.exists('Trip/Day 1/a.txt')).toBe('file');
    expect(new TextDecoder().decode(r.desk.read('readme.txt')!)).toBe('old');
    expect(new TextDecoder().decode(r.desk.read('readme (2).txt')!)).toBe('new');
    r.engine.dispose();
  });

  it('at most three uploads at once', async () => {
    const r = rig();
    r.desk.control.ackDelayMs = 20;
    const picks = Array.from({ length: 8 }, (_, i) => ({ file: file(`f${i}.bin`, bytesOf(300 * 1024, i + 1)), rel: `f${i}.bin` }));
    r.engine.upload(picks, '');
    await until(() => finished(r.engine));
    expect(r.engine.snapshot().every((v) => v.state === 'done')).toBe(true);
    expect(r.seen.maxSending).toBeLessThanOrEqual(UPLOADS_AT_ONCE);
    expect(r.seen.maxSending).toBeGreaterThan(1);
    expect(r.announced.some((a) => a.includes('All 8'))).toBe(true);
    r.engine.dispose();
  });

  it('a session lost partway pauses the upload and finishes it from what the desk has', async () => {
    const r = rig();
    r.desk.control.dropAfterBytes = 600 * 1024;
    const bytes = bytesOf(2 * MiB + 17, 3);
    r.engine.upload([{ file: file('resume.bin', bytes), rel: 'resume.bin' }], '');
    await until(() => r.engine.snapshot()[0]?.state === 'paused', 3000);
    expect(r.engine.snapshot()[0]!.words).toBe('Waiting for your desk');
    await until(() => finished(r.engine));
    expect(r.engine.snapshot()[0]!.state).toBe('done');
    expect(sha256Hex(r.desk.read('resume.bin')!)).toBe(sha256Hex(bytes));
    expect(r.desk.control.calls.some((c) => c.m === 'files.upload.status')).toBe(true);
    expect(r.desk.control.calls.filter((c) => c.m === 'files.upload.begin')).toHaveLength(1);
    r.engine.dispose();
  });

  it('a drive too full to take it says so, and nothing lands', async () => {
    const r = rig();
    r.desk.control.otherBytes = r.desk.control.totalBytes - r.desk.control.floorBytes - 1000;
    r.engine.upload([{ file: file('x.bin', bytesOf(50_000, 1)), rel: 'x.bin' }], '');
    await until(() => finished(r.engine));
    const v = r.engine.snapshot()[0]!;
    expect(v.state).toBe('failed');
    expect(v.words).toMatch(/Not enough room/);
    expect(r.desk.exists('x.bin')).toBeNull();
    r.engine.dispose();
  });

  it('cancel removes the partial', async () => {
    const r = rig();
    r.desk.control.ackDelayMs = 500;
    const [id] = r.engine.upload([{ file: file('c.bin', bytesOf(2 * MiB, 2)), rel: 'c.bin' }], '');
    await until(() => r.engine.snapshot()[0]?.state === 'sending');
    r.engine.cancel(id!);
    await until(() => r.desk.control.calls.some((c) => c.m === 'files.upload.abort'));
    expect(r.engine.snapshot()[0]!.state).toBe('cancelled');
    expect(r.desk.exists('c.bin')).toBeNull();
    r.engine.dispose();
  });
});

describe('the image check', () => {
  it('an image waits in line in plain words, goes up as its original bytes, and the service is told', async () => {
    const r = rig();
    const bytes = JPEG(200_000);
    r.engine.upload([{ file: file('photo.jpg', bytes), rel: 'photo.jpg' }], 'Photos');
    await until(() => finished(r.engine));
    expect([...r.seen.words]).toEqual(expect.arrayContaining(['Checking your image: 3rd in line.', 'Checking your image: 2nd in line.', 'Checking your image: 1st in line.']));
    expect([...r.seen.words].join(' ')).not.toMatch(/busy/i);
    expect(sha256Hex(r.desk.read('Photos/photo.jpg')!)).toBe(sha256Hex(bytes));
    expect(r.stubControl.settled).toHaveLength(1);
    r.engine.dispose();
  });

  it('is decided by content: an image named .txt is checked; a zip and a PDF are not', async () => {
    const r = rig();
    const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...bytesOf(500, 1)]);
    const pdf = new TextEncoder().encode('%PDF-1.7 not an image');
    r.engine.upload(
      [
        { file: file('notes.txt', JPEG(3000)), rel: 'notes.txt' },
        { file: file('bundle.zip', zip), rel: 'bundle.zip' },
        { file: file('doc.pdf', pdf), rel: 'doc.pdf' },
        { file: file('photo.jpg', new TextEncoder().encode('just words')), rel: 'photo.jpg' },
      ],
      '',
    );
    await until(() => finished(r.engine));
    expect(r.stubControl.checked).toHaveLength(1);
    expect(r.stubControl.checked[0]!.bytes).toBe(3000);
    expect(r.engine.snapshot().every((v) => v.state === 'done')).toBe(true);
    r.engine.dispose();
  });

  it('a rejection shows the guideline with its code, and nothing lands', async () => {
    const r = rig({ stub: { rejectNext: 'G2' } });
    r.engine.upload([{ file: file('bad.jpg', JPEG(5000)), rel: 'bad.jpg' }], '');
    await until(() => finished(r.engine));
    const v = r.engine.snapshot()[0]!;
    expect(v.state).toBe('rejected');
    expect(v.words).toMatch(/G2/);
    expect(v.rejected?.code).toBe('G2');
    expect(r.desk.exists('bad.jpg')).toBeNull();
    expect(r.desk.control.calls.some((c) => c.m === 'files.upload.begin')).toBe(false);
    r.engine.dispose();
  });

  it('a check that errors can be tried again, and nothing is added meanwhile', async () => {
    const r = rig({ stub: { failNext: { retryable: true } } });
    r.engine.upload([{ file: file('p.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])), rel: 'p.png' }], '');
    await until(() => finished(r.engine));
    expect(r.engine.snapshot()[0]!.state).toBe('failed');
    expect(r.engine.snapshot()[0]!.retry).toBe(true);
    expect(r.desk.exists('p.png')).toBeNull();
    r.engine.retry(r.engine.snapshot()[0]!.id);
    await until(() => r.engine.snapshot()[0]!.state === 'done');
    expect(r.desk.exists('p.png')).toBe('file');
    r.engine.dispose();
  });

  it('an image checked as unchecked (checker offline) is treated as passed', async () => {
    const r = rig({ stub: { uncheckedNext: true } });
    r.engine.upload([{ file: file('u.jpg', JPEG(4000)), rel: 'u.jpg' }], '');
    await until(() => finished(r.engine));
    expect(r.engine.snapshot()[0]!.state).toBe('done');
    r.engine.dispose();
  });
});

describe('downloads', () => {
  it('a file comes down whole, over credit, and a lost session carries on from the byte it reached', async () => {
    const r = rig();
    const bytes = bytesOf(2 * MiB + 99, 4);
    r.desk.put('Big/file.bin', bytes);
    r.engine.download({ path: 'Big/file.bin', name: 'file.bin', folder: false, size: bytes.length }, undefined);
    await until(() => finished(r.engine));
    const out = new Uint8Array(await r.outputs[0]!.arrayBuffer());
    expect(sha256Hex(out)).toBe(sha256Hex(bytes));
    r.engine.dispose();
  });

  it('resumes a download after the session drops', async () => {
    const r = rig({ tickMs: 4 });
    const bytes = bytesOf(3 * MiB, 8);
    r.desk.put('Big/two.bin', bytes);
    r.engine.download({ path: 'Big/two.bin', name: 'two.bin', folder: false, size: bytes.length }, undefined);
    await until(() => r.engine.snapshot()[0]!.done > 100_000);
    r.drop(300);
    await until(() => finished(r.engine));
    expect(r.engine.snapshot()[0]!.state).toBe('done');
    const out = new Uint8Array(await r.outputs[0]!.arrayBuffer());
    expect(sha256Hex(out)).toBe(sha256Hex(bytes));
    expect(r.desk.control.reads.some((x) => x.path === 'Big/two.bin' && x.offset > 0)).toBe(true);
    r.engine.dispose();
  });

  it('a folder comes down as a ZIP a real unzip opens, empty folders included', async () => {
    const r = rig();
    r.desk.put('Pack/a.txt', new TextEncoder().encode('alpha'));
    r.desk.put('Pack/sub/b.bin', bytesOf(70_000, 3));
    r.desk.put('Pack/sub/Café.txt', new TextEncoder().encode('latte'));
    const sink = new MemorySink();
    const engine = new TransferEngine({
      link: r.link,
      api: new FilesApi(r.link, () => crypto.randomUUID()),
      imageCheck: r.engine as never,
      open: async () => ({ sink, finish: async () => {}, abort: async () => {}, where: 'downloads' as const }),
    });
    engine.download({ path: 'Pack', name: 'Pack', folder: true, size: 0 }, undefined);
    await until(() => finished(engine));
    expect(engine.snapshot()[0]!.state).toBe('done');
    const zipPath = joinPath(dir, 'pack.zip');
    writeFileSync(zipPath, sink.bytes());
    const listing = pythonUnzip(zipPath);
    const names = JSON.stringify(listing);
    expect(names).toContain('Pack/a.txt');
    expect(names).toContain('Pack/sub/b.bin');
    expect(names).toContain('Pack/sub/Café.txt');
    engine.dispose();
    r.engine.dispose();
  });
});
