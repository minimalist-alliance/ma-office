// readable/: plain Markdown of every live page, kept beside the database.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, sleep, synced, until, type DeskdSession } from './helpers/deskd.ts';
import { doc, h1, p, setBody, task } from './helpers/docs.ts';
import { harness, makeNotebook, type Harness } from './helpers/service.ts';
import { safeName } from '../src/readable.ts';
import { type PMNode } from '../src/model.ts';

let h: Harness;
let s: DeskdSession;
const clients: Client[] = [];
let readable = '';

function files(dir = readable): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(child));
    else out.push(relative(readable, child));
  }
  return out.sort();
}

async function write(pageId: string, body: PMNode): Promise<void> {
  const c = new Client(h.socket);
  clients.push(c);
  const provider = c.open(pageId);
  await synced(provider);
  const title = (body.content?.[0]?.content?.[0]?.text ?? '') as string;
  setBody(provider.document, body);
  await until('the store', () => h.service.notebook.page(pageId)?.title === title, 5000);
}

beforeEach(async () => {
  h = await harness({ storeDebounceMs: 5, storeMaxWaitMs: 20 });
  s = h.session();
  readable = join(h.dir, 'data/readable');
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  await h.clean();
});

describe('readable/', () => {
  it('writes each live page as Markdown, and moves it with its names', async () => {
    const { notebookId, tabId, pageId } = await makeNotebook(s);
    await write(pageId, doc(h1('Plan'), p('Some **text**'), task('a box', true)));
    await until('the file', () => files().includes('Work/General/Plan.md'));
    const text = readFileSync(join(readable, 'Work/General/Plan.md'), 'utf8');
    expect(text).toContain('# Plan');
    expect(text).toContain('- [x] a box');
    await s.rpc('notebook.tab.rename', { id: tabId, title: 'Renamed tab' });
    await until('the move', () => files().includes('Work/Renamed tab/Plan.md'));
    expect(files()).toEqual(['Work/Renamed tab/Plan.md']);
    await s.rpc('notebook.notebook.rename', { id: notebookId, title: 'Home' });
    await until('the move', () => files().includes('Home/Renamed tab/Plan.md'));
    expect(files()).toEqual(['Home/Renamed tab/Plan.md']);
    expect(readdirSync(readable)).toEqual(['Home']);
  });

  it('a retitled page moves, and a blank one is a Note', async () => {
    const { pageId } = await makeNotebook(s);
    await until('the blank page', () => files().includes('Work/General/Note.md'));
    await write(pageId, doc(h1('Titled now'), p('x')));
    await until('the rename', () => files().includes('Work/General/Titled now.md'));
    expect(files()).toEqual(['Work/General/Titled now.md']);
  });

  it('names are sanitised, and a collision gets the page id', async () => {
    const { tabId, pageId } = await makeNotebook(s);
    const twin = (await s.rpc('notebook.page.create', { tabId })).page.id;
    const nasty = (await s.rpc('notebook.page.create', { tabId })).page.id;
    await write(pageId, doc(h1('Same'), p('old')));
    await write(twin, doc(h1('same'), p('young')));
    await write(nasty, doc(h1('../../etc/passwd\u0000:*?'), p('x')));
    await until('all three', () => files().some((n) => n.includes('passwd')) && files().length === 3);
    const names = files();
    expect(names).toContain('Work/General/Same.md');
    expect(names).toContain(`Work/General/same (${twin}).md`);
    expect(names.find((n) => n.includes('passwd'))).toBe('Work/General/etc passwd.md');
    for (const n of names) expect(n.split('/').length).toBe(3);
    expect(existsSync(join(h.dir, 'etc'))).toBe(false);
  });

  it('safeName keeps names safe on any disk', () => {
    expect(safeName('', 'Note')).toBe('Note');
    expect(safeName('...', 'Note')).toBe('Note');
    expect(safeName('.hidden', 'Note')).toBe('hidden');
    expect(safeName('CON', 'Note')).toBe('_CON');
    expect(safeName('nul.txt', 'Note')).toBe('_nul.txt');
    expect(safeName('a/b\\c', 'Note')).toBe('a b c');
    expect(Buffer.byteLength(safeName('日本語'.repeat(100), 'Note'))).toBeLessThanOrEqual(180);
    expect(Buffer.byteLength(safeName('😀'.repeat(100), 'Note'))).toBeLessThanOrEqual(180);
  });

  it('trashed pages leave it and come back; purged pages stay gone', async () => {
    const { pageId } = await makeNotebook(s);
    await write(pageId, doc(h1('Going'), p('x')));
    await until('the file', () => files().includes('Work/General/Going.md'));
    await s.rpc('notebook.page.trash', { pageId });
    await until('it to leave', () => files().length === 0);
    await s.rpc('notebook.page.restore', { pageId });
    await until('it to return', () => files().includes('Work/General/Going.md'));
  });

  it('rebuilds at start when behind, or when missing, and removes what should not be there', async () => {
    const { pageId } = await makeNotebook(s);
    await write(pageId, doc(h1('Kept'), p('text')));
    await until('the file', () => files().includes('Work/General/Kept.md'));
    await h.stop();
    // Behind: an edit the readable copy didn't see, and a stray file and a leftover temporary.
    writeFileSync(join(readable, 'Work/General/Kept.md'), 'stale');
    mkdirSync(join(readable, 'Stray'), { recursive: true });
    writeFileSync(join(readable, 'Stray/old.md'), 'old');
    writeFileSync(join(readable, 'Work/General/.tmp-1.md'), 'half');
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(join(h.dir, 'data/notebook.db'));
    raw.exec(`UPDATE settings SET value = '-1' WHERE key = 'readable_rev'`);
    raw.close();
    await h.restart();
    await h.service.readable.settled();
    expect(files()).toEqual(['Work/General/Kept.md']);
    expect(readFileSync(join(readable, 'Work/General/Kept.md'), 'utf8')).toContain('# Kept');
    expect(existsSync(join(readable, 'Stray'))).toBe(false);

    await h.stop();
    rmSync(readable, { recursive: true });
    await h.restart();
    await h.service.readable.settled();
    expect(files()).toEqual(['Work/General/Kept.md']);
  });

  it('a mass move yields to the event loop, and ends with every file in place', async () => {
    const { notebookId, tabId } = await makeNotebook(s);
    const N = 4000;
    const pm = JSON.stringify(doc(h1('T'), p('some text in a page')));
    h.service.db.raw.exec('BEGIN');
    const ins = h.service.db.raw.prepare(
      `INSERT INTO pages (id, tab_id, sort_key, title, snippet, word_count, has_checklist, created_at, created_by, updated_at, updated_by, row_version, ydoc, pm_json, plain_text)
       VALUES (?, ?, ?, ?, '', 4, 0, ?, 'u', ?, 'u', 1, x'00', ?, '')`,
    );
    for (let i = 0; i < N; i++) ins.run(`bulk${i}`, tabId, i, `Page ${i}`, 1000 + i, 1000 + i, pm);
    h.service.db.raw.exec('COMMIT');
    h.service.readable.treeChanged();
    await until('the first copy', () => files().length >= N, 60000);
    await h.service.readable.settled();
    const before = files().length;

    let worst = 0;
    let last = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last - 5);
      last = now;
    }, 5);
    await s.rpc('notebook.notebook.rename', { id: notebookId, title: 'Moved' });
    await until('every move', () => files().filter((f) => f.startsWith('Moved/')).length >= N, 60000);
    await h.service.readable.settled();
    clearInterval(probe);
    expect(worst).toBeLessThan(100);
    const all = files();
    expect(all.every((f) => f.startsWith('Moved/General/'))).toBe(true);
    expect(all.length).toBe(before);
    expect(readFileSync(join(readable, 'Moved/General/Page 1234.md'), 'utf8')).toContain('some text in a page');
    expect(existsSync(join(readable, 'Work'))).toBe(false);
  }, 120000);

  it('a start that is not behind writes nothing', async () => {
    const { pageId } = await makeNotebook(s);
    await write(pageId, doc(h1('Stable'), p('text')));
    await until('the file', () => files().includes('Work/General/Stable.md'));
    await h.stop();
    writeFileSync(join(readable, 'Work/General/Stable.md'), 'left alone');
    await h.restart();
    await sleep(50);
    expect(readFileSync(join(readable, 'Work/General/Stable.md'), 'utf8')).toBe('left alone');
  });

  it('a failure logs and never affects notes', async () => {
    const { pageId } = await makeNotebook(s);
    await write(pageId, doc(h1('Before'), p('text')));
    await until('the file', () => files().includes('Work/General/Before.md'));
    chmodSync(join(readable, 'Work/General'), 0o500);
    try {
      await write(pageId, doc(h1('During'), p('more text')));
      await sleep(60);
      expect(h.service.notebook.page(pageId)?.title).toBe('During');
      const c = (await s.rpc('notebook.page.content', { pageId })) as { part: string };
      expect(c.part).toContain('During');
    } finally {
      chmodSync(join(readable, 'Work/General'), 0o750);
    }
    await until('the export to catch up', () => files().includes('Work/General/During.md'));
    expect(files()).toEqual(['Work/General/During.md']);
  });

  it('is written at stop', async () => {
    await h.restart({ readableDebounceMs: 60_000 });
    s = h.session();
    const { pageId } = await makeNotebook(s);
    await write(pageId, doc(h1('At the end'), p('text')));
    expect(files()).toEqual([]);
    await h.stop();
    expect(files()).toEqual(['Work/General/At the end.md']);
    await h.restart();
  });
});
