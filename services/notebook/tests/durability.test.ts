// "Nothing lost across a restart", against the real bundle in a real process and a real database on disk.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Client, DeskdSession, sleep, synced, until } from './helpers/deskd.ts';
import { doc, fakeState, h1, p, setBody, textOf, typeInto } from './helpers/docs.ts';
import { child, makeNotebook, tempDir, type Child } from './helpers/service.ts';

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
