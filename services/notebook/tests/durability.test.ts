// "Nothing lost across a restart", against the real bundle in a real process and a real database on disk.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Client, DeskdSession, sleep, synced, until } from './helpers/deskd.ts';
import { doc, fakeState, h1, p, setBody, textOf, typeInto } from './helpers/docs.ts';
import { child, harness, makeNotebook, tempDir, type Child, type Harness } from './helpers/service.ts';

let dir = '';
let running: Child | null = null;
const clients: Client[] = [];
const client = (socket: string): Client => {
  const c = new Client(socket);
  clients.push(c);
  return c;
};

async function start(env: Record<string, string> = {}): Promise<Child> {
  running = child(dir, env);
  await running.ready;
  return running;
}

beforeEach(() => {
  dir = tempDir();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  if (running && running.proc.exitCode === null && running.proc.signalCode === null) await running.kill('SIGKILL');
  running = null;
  rmSync(dir, { recursive: true, force: true });
});

function logged(dbDir: string, pageId: string): number {
  const raw = new DatabaseSync(join(dbDir, 'notebook.db'), { readOnly: true });
  try {
    return (raw.prepare('SELECT count(*) AS n FROM page_updates WHERE page_id = ?').get(pageId) as { n: number }).n;
  } finally {
    raw.close();
  }
}

describe('SIGKILL mid-typing', () => {
  it('what was committed comes back, with no client to give it back', async () => {
    // A store that won't run in this test's time, so only the log can bring these back.
    const first = await start({ DESK_NOTEBOOK_STORE_DEBOUNCE_MS: '60000', DESK_NOTEBOOK_STORE_MAX_MS: '60000' });
    const s = new DeskdSession(first.socket);
    const { pageId } = await makeNotebook(s);
    const c = client(first.socket);
    const provider = c.open(pageId);
    await synced(provider);

    const typed: { word: string; at: number }[] = [];
    for (let i = 0; i < 40; i += 1) {
      const word = `word${i} `;
      typeInto(provider.document, word);
      typed.push({ word, at: Date.now() });
      await sleep(10);
    }
    await until('every ack', () => !provider.hasUnsyncedChanges);
    await sleep(250); // Past the 150 ms commit of the last one.
    const commitsAt = Date.now();
    for (let i = 40; i < 60; i += 1) {
      const word = `word${i} `;
      typeInto(provider.document, word);
      typed.push({ word, at: Date.now() });
    }
    await sleep(350);
    for (let i = 60; i < 70; i += 1) {
      const word = `word${i} `;
      typeInto(provider.document, word);
      typed.push({ word, at: Date.now() });
    }
    // Stop the client first, so it can't give anything back, and kill with no warning.
    c.destroy();
    const killedAt = Date.now();
    const gone = await first.kill('SIGKILL');
    expect(gone.signal).toBe('SIGKILL');
    expect(logged(first.dataDir, pageId)).toBeGreaterThan(0);
    expect(commitsAt).toBeLessThan(killedAt);

    // Nothing was stored in pages.ydoc, and the log holds it.
    const again = await start();
    expect(again.logs.join('\n')).toContain('recovered pages=1');
    const s2 = new DeskdSession(again.socket);
    const content = (await s2.rpc('notebook.page.content', { pageId })) as { part: string };
    const fresh = client(again.socket).open(pageId);
    await synced(fresh);
    const text = textOf(fresh.document);
    // All of what was more than 400 ms old at the kill is there: the rule is about 150 ms.
    for (const t of typed.filter((x) => killedAt - x.at > 400)) expect(text).toContain(t.word);
    expect(text).toContain('word59 ');
    expect(content.part).toContain('word59 ');
    expect(logged(again.dataDir, pageId)).toBe(0);
    s.close();
    s2.close();

    // Recovery kept it as a session, so History has it, and search and readable caught up.
    const s3 = new DeskdSession(again.socket);
    const versions = (await s3.rpc('notebook.version.list', { pageId })).versions;
    expect(versions.map((v: { reason: string }) => v.reason)).toEqual(['session']);
    const hits = (await s3.rpc('notebook.search', { query: 'word39' })).hits;
    expect(hits.map((h: { pageId: string }) => h.pageId)).toEqual([pageId]);
    await until('the activity', async () => (await s3.rpc('notebook.activity.days')).days.length === 1);
    s3.close();
  });

  it('offline edits on two open clients all merge after a SIGKILL', async () => {
    const first = await start({ DESK_NOTEBOOK_STORE_DEBOUNCE_MS: '60000', DESK_NOTEBOOK_STORE_MAX_MS: '60000' });
    const s = new DeskdSession(first.socket);
    const { pageId } = await makeNotebook(s);
    const a = client(first.socket).open(pageId);
    const b = client(first.socket).open(pageId);
    await Promise.all([synced(a), synced(b)]);
    typeInto(a.document, 'before ');
    await until('b to have it', () => textOf(b.document).includes('before'));

    await first.kill('SIGKILL');
    // Both keep typing while the desk is down, and the providers keep trying.
    for (let i = 0; i < 30; i += 1) {
      typeInto(a.document, `offA${i} `);
      typeInto(b.document, `offB${i} `);
    }
    await sleep(200);
    const again = await start({ DESK_NOTEBOOK_STORE_DEBOUNCE_MS: '60000', DESK_NOTEBOOK_STORE_MAX_MS: '60000' });
    await until('both to reconnect and converge', () => textOf(a.document).includes('offB29') && textOf(b.document).includes('offA29'), 30_000);
    await until('both acknowledged', () => !a.hasUnsyncedChanges && !b.hasUnsyncedChanges, 15_000);
    expect(textOf(a.document).length).toBe(textOf(b.document).length);

    // And it's on disk, not just in memory: a second SIGKILL, with nobody left to give it back.
    await sleep(300);
    for (const c of clients.splice(0)) c.destroy();
    await again.kill('SIGKILL');
    const third = await start();
    const fresh = client(third.socket).open(pageId);
    await synced(fresh);
    for (let i = 0; i < 30; i += 1) {
      expect(textOf(fresh.document)).toContain(`offA${i} `);
      expect(textOf(fresh.document)).toContain(`offB${i} `);
    }
    expect(textOf(fresh.document)).toContain('before ');
    s.close();
  });
});

describe('SIGTERM', () => {
  it('stores every open page, checkpoints the WAL, and exits well inside 30 s', async () => {
    const first = await start({ DESK_NOTEBOOK_STORE_DEBOUNCE_MS: '60000', DESK_NOTEBOOK_STORE_MAX_MS: '60000', DESK_NOTEBOOK_READABLE_MS: '60000' });
    const s = new DeskdSession(first.socket);
    const { tabId, pageId } = await makeNotebook(s);
    const other = (await s.rpc('notebook.page.create', { tabId })).page.id;
    const a = client(first.socket).open(pageId);
    const b = client(first.socket).open(other);
    await Promise.all([synced(a), synced(b)]);
    setBody(a.document, doc(h1('Stored at the end'), p('first page')));
    setBody(b.document, doc(h1('Also stored'), p('second page')));
    await until('acks', () => !a.hasUnsyncedChanges && !b.hasUnsyncedChanges);
    for (const c of clients.splice(0)) c.destroy();

    const t0 = Date.now();
    const result = await first.kill('SIGTERM');
    const ms = Date.now() - t0;
    expect(result.code).toBe(0);
    expect(ms).toBeLessThan(5000);
    expect(first.logs.join('\n')).toContain('stopped on SIGTERM');

    // The WAL is empty, the log is empty, the socket is gone, and the database reads by itself.
    expect(statSync(join(first.dataDir, 'notebook.db-wal'), { throwIfNoEntry: false })?.size ?? 0).toBe(0);
    const raw = new DatabaseSync(join(first.dataDir, 'notebook.db'), { readOnly: true });
    expect(raw.prepare('SELECT count(*) AS n FROM page_updates').get()).toMatchObject({ n: 0 });
    const titles = raw.prepare('SELECT title FROM pages ORDER BY title').all() as { title: string }[];
    expect(titles.map((t) => t.title)).toEqual(['Also stored', 'Stored at the end']);
    raw.close();
    expect(statSync(first.socket, { throwIfNoEntry: false })).toBeUndefined();

    // readable/ was written on the way out.
    expect(readFileSync(join(first.dataDir, 'readable/Work/General/Also stored.md'), 'utf8')).toContain('second page');
    s.close();
  });

  it('offline edits across a SIGTERM merge too', async () => {
    const first = await start();
    const s = new DeskdSession(first.socket);
    const { pageId } = await makeNotebook(s);
    const a = client(first.socket).open(pageId);
    const b = client(first.socket).open(pageId);
    await Promise.all([synced(a), synced(b)]);
    typeInto(a.document, 'before ');
    await until('b has it', () => textOf(b.document).includes('before'));
    await first.kill('SIGTERM');
    typeInto(a.document, 'alpha ');
    typeInto(b.document, 'bravo ');
    await start();
    await until('the merge', () => textOf(a.document).includes('bravo') && textOf(b.document).includes('alpha'), 30_000);
    s.close();
  });

  it('a large page stores and comes back whole', async () => {
    const first = await start({ DESK_NOTEBOOK_STORE_DEBOUNCE_MS: '60000', DESK_NOTEBOOK_STORE_MAX_MS: '60000' });
    const s = new DeskdSession(first.socket);
    const { pageId } = await makeNotebook(s);
    const c = client(first.socket);
    const a = c.open(pageId);
    await synced(a);
    Y.applyUpdate(a.document, fakeState(100));
    await until('ack', () => !a.hasUnsyncedChanges, 30_000);
    c.destroy();
    await first.kill('SIGTERM');
    const again = await start();
    const fresh = client(again.socket).open(pageId);
    await synced(fresh, 30_000);
    await until('all of it', () => textOf(fresh.document).includes('end-100'), 30_000);
    s.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A full disk (reliability audit D6). SQLite's own limit stands in for it: with `max_page_count` at the file's size, every
// write that needs a new page fails with the binding's SQLITE_FULL (errcode 13), as it does on a full volume.

describe('the disk is full', () => {
  const MARK = 'SECRETMARKER';
  let h: Harness;
  let lines: string[] = [];
  let realWrite: typeof process.stdout.write;

  const pagesOfFile = (): number => (h.service.db.raw.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
  const fill = (): void => {
    // Checkpoint first, so the limit is the file's own size and not the WAL's.
    h.service.db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    h.service.db.raw.exec(`PRAGMA max_page_count = ${pagesOfFile()}`);
  };
  const free = (): void => void h.service.db.raw.exec('PRAGMA max_page_count = 1073741823');
  const noise = (n: number): string => Array.from({ length: n }, () => Math.random().toString(36).slice(2)).join('');
  const storage = async (s: DeskdSession): Promise<any> => (await s.health()).storage;
  const rows = (): number => h.service.db.get<{ n: number }>('SELECT count(*) AS n FROM page_updates')?.n ?? 0;

  beforeEach(() => {
    lines = [];
    realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      lines.push(String(chunk));
      return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
  });
  afterEach(async () => {
    process.stdout.write = realWrite;
    for (const c of clients.splice(0)) c.destroy();
    await h?.clean();
  });

  it('keeps the edits, says degraded, logs once with no text, and writes everything when there is room again', async () => {
    h = await harness({ commitMs: 20, storeDebounceMs: 30, storeMaxWaitMs: 60, readableDebounceMs: 60_000 });
    const s = h.session();
    const { pageId } = await makeNotebook(s);
    const c = new Client(h.socket);
    clients.push(c);
    const provider = c.open(pageId);
    await synced(provider);
    typeInto(provider.document, 'before the disk filled ');
    await until('saved', () => !provider.hasUnsyncedChanges && rows() === 0 && h.service.pages.storage().unsavedBytes === 0);
    expect((await storage(s)).state).toBe('ok');

    fill();
    for (let i = 0; i < 10; i += 1) typeInto(provider.document, `${MARK} ${noise(2000)} `);
    await until('degraded', async () => (await storage(s)).state === 'degraded');
    const st = await storage(s);
    expect(st.unsavedPages).toBe(1);
    expect(st.unsavedBytes).toBeGreaterThan(10_000);
    expect(st.refusing).toBe(false);
    // The service is still healthy, so the container isn't restarted and the edits aren't lost with it.
    expect((await s.health()).ok).toBe(true);
    // Edits are still applied in memory and acknowledged: below the caps nothing is refused.
    await until('acked', () => !provider.hasUnsyncedChanges);

    await sleep(300); // Several failed commits and stores.
    const failed = lines.filter((l) => l.includes('storage failing'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatch(/ERR_SQLITE_ERROR 13/);
    expect(lines.join('')).not.toContain(MARK);
    expect(lines.join('')).not.toContain('before the disk');

    free();
    await until('flushed and clear', async () => (await storage(s)).state === 'ok', 10_000);
    expect((await storage(s)).unsavedBytes).toBe(0);
    expect(lines.filter((l) => l.includes('storage works again'))).toHaveLength(1);
    expect(lines.join('')).not.toContain(MARK);

    // On disk, not in memory: a restart with nobody holding the document.
    c.destroy();
    await sleep(100);
    const again = await h.restart();
    expect(again.pages.open.size).toBe(0);
    const c2 = new Client(h.socket);
    clients.push(c2);
    const fresh = c2.open(pageId);
    await synced(fresh);
    expect(textOf(fresh.document)).toContain('before the disk filled');
    expect((textOf(fresh.document).match(new RegExp(MARK, 'g')) ?? []).length).toBe(10);
  });

  it('refuses new edits past the per-page cap with storage_full, and takes them again after recovery', async () => {
    h = await harness({ commitMs: 20, storeDebounceMs: 30, storeMaxWaitMs: 60, readableDebounceMs: 60_000, backlogPageBytes: 20_000, backlogTotalBytes: 1_000_000 });
    const s = h.session();
    const { pageId } = await makeNotebook(s);
    const c = new Client(h.socket);
    clients.push(c);
    const provider = c.open(pageId);
    const seen = closesOf(provider);
    await synced(provider);
    typeInto(provider.document, 'kept ');
    await until('saved', () => !provider.hasUnsyncedChanges);

    fill();
    typeInto(provider.document, noise(2000));
    await until('degraded', async () => (await storage(s)).state === 'degraded');
    expect(seen).toEqual([]);
    // Each paste adds ~10 KB of waiting edits; the cap is 20 KB, so the third is refused.
    for (let i = 0; i < 4 && !seen.includes('storage_full'); i += 1) {
      typeInto(provider.document, noise(1500));
      await sleep(100);
    }
    await until('the refusal', () => seen.includes('storage_full'));
    const st = await storage(s);
    expect(st.refusing).toBe(true);
    expect(st.unsavedBytes).toBeLessThan(40_000); // The backlog stopped growing at the cap.
    const bytes = st.unsavedBytes;
    typeInto(provider.document, noise(1500));
    await sleep(150);
    expect((await storage(s)).unsavedBytes).toBe(bytes);
    expect(lines.filter((l) => l.includes('refusing new edits'))).toHaveLength(1);

    free();
    await until('clear', async () => (await storage(s)).state === 'ok', 10_000);
    // The page opens again and takes edits; what was refused was never applied.
    const c2 = new Client(h.socket);
    clients.push(c2);
    const again = c2.open(pageId);
    await synced(again);
    expect(textOf(again.document)).toContain('kept');
    typeInto(again.document, ' after recovery');
    await until('acked', () => !again.hasUnsyncedChanges);
  });

  it('refuses new edits once storage has failed for the grace period, whatever the size', async () => {
    let skew = 0;
    h = await harness({ commitMs: 20, storeDebounceMs: 30, storeMaxWaitMs: 60, readableDebounceMs: 60_000, refuseAfterMs: 60_000, now: () => Date.now() + skew });
    const s = h.session();
    const { pageId } = await makeNotebook(s);
    const c = new Client(h.socket);
    clients.push(c);
    const provider = c.open(pageId);
    const seen = closesOf(provider);
    await synced(provider);
    typeInto(provider.document, 'kept ');
    await until('saved', () => !provider.hasUnsyncedChanges);

    fill();
    typeInto(provider.document, noise(2000));
    await until('degraded', async () => (await storage(s)).state === 'degraded');
    expect((await storage(s)).refusing).toBe(false);
    skew = 61_000;
    expect((await storage(s)).refusing).toBe(true);
    typeInto(provider.document, 'one more');
    await until('the refusal', () => seen.includes('storage_full'));
    free();
    await until('clear', async () => (await storage(s)).state === 'ok', 10_000);
  });

  it('a page that closes with edits unwritten keeps them and writes them later', async () => {
    h = await harness({ commitMs: 20, storeDebounceMs: 30, storeMaxWaitMs: 60, readableDebounceMs: 60_000 });
    const s = h.session();
    const { pageId } = await makeNotebook(s);
    const c = new Client(h.socket);
    clients.push(c);
    const provider = c.open(pageId);
    await synced(provider);
    typeInto(provider.document, 'kept ');
    await until('saved', () => !provider.hasUnsyncedChanges);

    fill();
    typeInto(provider.document, `${MARK} ${noise(500)}`);
    await until('acked', () => !provider.hasUnsyncedChanges);
    await until('degraded', async () => (await storage(s)).state === 'degraded');
    c.destroy(); // The last connection leaves; the document unloads with its edits unwritten.
    await until('unloaded', () => h.service.pages.open.size === 0, 5000);
    expect((await storage(s)).unsavedBytes).toBeGreaterThan(0);

    free();
    await until('clear', async () => (await storage(s)).state === 'ok', 10_000);
    const again = await h.restart(); // Recovery folds the log rows in.
    expect(again.db.get<{ n: number }>("SELECT count(*) AS n FROM pages WHERE plain_text LIKE ?", `%${MARK}%`)?.n).toBe(1);
  });
});

function closesOf(provider: ReturnType<Client['open']>): string[] {
  const out: string[] = [];
  provider.on('close', ({ event }: { event: { reason: string } }) => out.push(event.reason));
  return out;
}
