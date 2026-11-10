// When versions are written (design 5.3) and when old things go, on a fake clock, with real SQLite and real providers.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Client, sleep, synced, until, type DeskdSession } from './helpers/deskd.ts';
import { doc, h1, p, setBody, typeInto } from './helpers/docs.ts';
import { harness, makeNotebook, type Harness } from './helpers/service.ts';

const DAY = 86_400_000;
const MIN = 60_000;
let h: Harness;
let s: DeskdSession;
let clock = 0;
const clients: Client[] = [];

const client = (): Client => {
  const c = new Client(h.socket);
  clients.push(c);
  return c;
};
const reasons = async (pageId: string): Promise<string[]> => (await s.rpc('notebook.version.list', { pageId })).versions.map((v: { reason: string }) => v.reason);

beforeEach(async () => {
  clock = Date.UTC(2026, 10, 6, 10, 0, 0);
  h = await harness({ storeDebounceMs: 5, storeMaxWaitMs: 20, sessionIdleMs: 80, now: () => clock });
  s = h.session();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  await h.clean();
});

/** Types, and waits for it to be stored. */
async function typeAndStore(provider: ReturnType<Client['open']>, pageId: string, text: string): Promise<void> {
  const before = h.service.notebook.page(pageId)?.row_version ?? 0;
  typeInto(provider.document, text);
  await until('the store', () => (h.service.notebook.page(pageId)?.row_version ?? 0) > before, 5000);
}

describe('versions, design 5.3', () => {
  it('session end: 5 minutes idle writes one, and an idle page writes no more', async () => {
    const { pageId } = await makeNotebook(s);
    const provider = client().open(pageId);
    await synced(provider);
    typeInto(provider.document, 'first burst');
    await until('the idle version', async () => (await reasons(pageId)).length === 1);
    expect(await reasons(pageId)).toEqual(['session']);
    await sleep(200);
    expect(await reasons(pageId)).toEqual(['session']);
  });

  it('session end: the last connection leaving writes one', async () => {
    const { pageId } = await makeNotebook(s);
    await h.restart({ sessionIdleMs: 60_000 });
    s = h.session();
    const c = client();
    const provider = c.open(pageId);
    await synced(provider);
    typeInto(provider.document, 'a page switch');
    await until('ack', () => !provider.hasUnsyncedChanges);
    expect(await reasons(pageId)).toEqual([]);
    c.destroy();
    await until('the version', async () => (await reasons(pageId)).length === 1);
    expect(await reasons(pageId)).toEqual(['session']);
    await until('the page to unload', () => h.service.pages.open.size === 0);
  });

  it('every 30 minutes of continuous editing', async () => {
    const { pageId } = await makeNotebook(s);
    await h.restart({ sessionIdleMs: 60_000 });
    s = h.session();
    const provider = client().open(pageId);
    await synced(provider);
    await typeAndStore(provider, pageId, 'at the start ');
    expect(await reasons(pageId)).toEqual([]);
    clock += 29 * MIN;
    await typeAndStore(provider, pageId, 'after 29 minutes ');
    expect(await reasons(pageId)).toEqual([]);
    clock += 2 * MIN;
    await typeAndStore(provider, pageId, 'after 31 minutes ');
    expect(await reasons(pageId)).toEqual(['interval']);
    clock += 10 * MIN;
    await typeAndStore(provider, pageId, 'ten more ');
    expect(await reasons(pageId)).toEqual(['interval']);
    clock += 25 * MIN;
    await typeAndStore(provider, pageId, 'thirty five after the first ');
    expect(await reasons(pageId)).toEqual(['interval', 'interval']);
  });

  it('local midnight: the first edit after it snapshots the page as the day left it', async () => {
    clock = Date.UTC(2026, 10, 6, 23, 55, 0);
    const { pageId } = await makeNotebook(s);
    await h.restart({ sessionIdleMs: 60_000 });
    s = h.session();
    const provider = client().open(pageId);
    await synced(provider);
    await typeAndStore(provider, pageId, 'late on the sixth');
    clock = Date.UTC(2026, 10, 7, 0, 5, 0);
    await typeAndStore(provider, pageId, ' early on the seventh');
    const versions = (await s.rpc('notebook.version.list', { pageId })).versions;
    expect(versions.map((v: { reason: string }) => v.reason)).toEqual(['day_end']);
    expect(versions[0].createdAt).toBe(Date.UTC(2026, 10, 6, 23, 55, 0));
    const asOf = await s.rpc('notebook.version.asOf', { pageId, day: '2026-11-06' });
    expect(asOf.versionId).toBe(versions[0].id);
    const body = JSON.parse((await s.rpc('notebook.version.get', { versionId: asOf.versionId })).part);
    const text = JSON.stringify(body);
    expect(text).toContain('late on the sixth');
    expect(text).not.toContain('early on the seventh');
    const days = (await s.rpc('notebook.activity.days')).days;
    expect(days).toEqual(['2026-11-07', '2026-11-06']);
  });

  it('midnight is the member\'s: the zone decides', async () => {
    clock = Date.UTC(2026, 10, 6, 14, 55, 0); // 23:55 in Tokyo
    await s.rpc('notebook.settings.set', { timeZone: 'Asia/Tokyo' });
    const { pageId } = await makeNotebook(s);
    await h.restart({ sessionIdleMs: 60_000 });
    s = h.session();
    const provider = client().open(pageId);
    await synced(provider);
    await typeAndStore(provider, pageId, 'before Tokyo midnight');
    clock = Date.UTC(2026, 10, 6, 15, 5, 0); // Still the 6th in UTC, the 7th in Tokyo.
    await typeAndStore(provider, pageId, ' after it');
    expect(await reasons(pageId)).toEqual(['day_end']);
  });

  it('manual, and restore, with a version of what was there first', async () => {
    const { pageId } = await makeNotebook(s);
    await h.restart({ sessionIdleMs: 60_000 });
    s = h.session();
    const provider = client().open(pageId);
    await synced(provider);
    setBody(provider.document, doc(h1('One'), p('first')));
    await until('ack', () => !provider.hasUnsyncedChanges);
    await sleep(20);
    const { version } = await s.rpc('notebook.version.save', { pageId, reason: 'manual' });
    expect(version.reason).toBe('manual');
    setBody(provider.document, doc(h1('Two'), p('second')));
    await until('ack', () => !provider.hasUnsyncedChanges);
    await sleep(20);
    await s.rpc('notebook.version.restore', { pageId, versionId: version.id });
    const versions = (await s.rpc('notebook.version.list', { pageId })).versions;
    expect(versions.map((v: { reason: string; title: string }) => [v.reason, v.title])).toEqual([
      ['restore', 'One'],
      ['session', 'Two'],
      ['manual', 'One'],
    ]);
    // In the same millisecond of the fake clock, they still sort in the order written.
    expect(new Set(versions.map((v: { createdAt: number }) => v.createdAt)).size).toBe(3);
  });

  it('saving a version of a page nobody has open', async () => {
    const { pageId } = await makeNotebook(s);
    const { version } = await s.rpc('notebook.version.save', { pageId, reason: 'pre_agent' });
    expect(version).toMatchObject({ reason: 'pre_agent', pageId });
    await until('the page to unload', () => h.service.pages.open.size === 0);
  });

  it('kept: all for 30 days, then the last of each day', async () => {
    const { pageId } = await makeNotebook(s);
    const make = async (at: number): Promise<string> => {
      clock = at;
      return (await s.rpc('notebook.version.save', { pageId })).version.id as string;
    };
    const start = Date.UTC(2026, 8, 1, 9, 0, 0); // More than 30 days before the clock's end.
    const firstOfDay = await make(start);
    const lastOfDay = await make(start + 2 * 3_600_000);
    clock = start + 40 * DAY;
    const recent1 = await make(clock);
    const recent2 = await make(clock + 3_600_000);
    clock += 2 * 3_600_000;
    h.service.pages.housekeeping();
    const left = (await s.rpc('notebook.version.list', { pageId })).versions.map((v: { id: string }) => v.id);
    expect(left).not.toContain(firstOfDay);
    expect(left).toContain(lastOfDay);
    expect(left).toContain(recent1);
    expect(left).toContain(recent2);
  });
});

describe('Trash', () => {
  it('is purged after 30 days, at start, with everything about the page', async () => {
    const { tabId, pageId } = await makeNotebook(s);
    const keep = (await s.rpc('notebook.page.create', { tabId })).page.id;
    await s.rpc('notebook.version.save', { pageId });
    await s.rpc('notebook.page.trash', { pageId });
    clock += 29 * DAY;
    await h.restart();
    s = h.session();
    expect(h.service.notebook.page(pageId)).toBeDefined();
    clock += 2 * DAY;
    await h.restart();
    s = h.session();
    expect(h.service.notebook.page(pageId)).toBeUndefined();
    expect(h.service.notebook.page(keep)).toBeDefined();
    await h.stop();
    const raw = new DatabaseSync(join(h.dir, 'data/notebook.db'));
    for (const table of ['page_versions', 'page_activity', 'page_updates']) {
      expect(raw.prepare(`SELECT count(*) AS n FROM ${table} WHERE page_id = ?`).get(pageId)).toMatchObject({ n: 0 });
    }
    expect(raw.prepare(`SELECT count(*) AS n FROM pages_fts`).get()).toMatchObject({ n: 1 });
    raw.close();
    await h.restart();
    s = h.session();
  });

  it('a page still open is not purged', async () => {
    const { pageId } = await makeNotebook(s);
    const provider = client().open(pageId);
    await synced(provider);
    await s.rpc('notebook.page.trash', { pageId });
    clock += 31 * DAY;
    h.service.pages.housekeeping();
    expect(h.service.notebook.page(pageId)).toBeDefined();
  });
});
