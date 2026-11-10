// A page past about 3.5 MiB of Yjs state takes no more: its provider hears `page_full`, other pages carry on, and what
// the page holds stays.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Client, sleep, synced, until, type DeskdSession } from './helpers/deskd.ts';
import { fakeState, textOf, typeInto } from './helpers/docs.ts';
import { harness, makeNotebook, type Harness } from './helpers/service.ts';
import { DOC_FIELD } from '../src/model.ts';

let h: Harness;
let s: DeskdSession;
const clients: Client[] = [];
const client = (): Client => {
  const c = new Client(h.socket);
  clients.push(c);
  return c;
};
const LIMIT = 200_000; // A low ceiling for most of these, so they run fast. One test uses the real number.

function closes(provider: ReturnType<Client['open']>): string[] {
  const out: string[] = [];
  provider.on('close', ({ event }: { event: { reason: string } }) => out.push(event.reason));
  return out;
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  await h.clean();
});

describe('page_full with a low ceiling', () => {
  beforeEach(async () => {
    h = await harness({ storeDebounceMs: 20, storeMaxWaitMs: 100, pageFullBytes: LIMIT });
    s = h.session();
  });

  it('refuses the update that passes it, on that page only', async () => {
    const { tabId, pageId } = await makeNotebook(s);
    const otherPage = (await s.rpc('notebook.page.create', { tabId })).page.id;
    const c = client();
    const full = c.open(pageId);
    const other = c.open(otherPage);
    const seen = closes(full);
    const seenOther = closes(other);
    await Promise.all([synced(full), synced(other)]);

    typeInto(full.document, 'kept before the ceiling');
    await until('ack', () => !full.hasUnsyncedChanges);
    await until('the commit', () => (h.service.db.get<{ n: number }>('SELECT count(*) AS n FROM page_updates')?.n ?? 0) >= 0, 500);

    // A paste past the ceiling, as one update.
    Y.applyUpdate(full.document, fakeState(60));
    await until('the close', () => seen.includes('page_full'));
    expect(seenOther).toEqual([]);

    // Other pages on the same socket carry on.
    typeInto(other.document, 'the neighbour still syncs');
    await until('neighbour ack', () => !other.hasUnsyncedChanges);

    // The desk kept what it had and took none of the paste.
    const content: any = await s.rpc('notebook.page.content', { pageId });
    expect(content.part).toContain('kept before the ceiling');
    expect(content.part).not.toContain('Page 1"');

    // A new client gets the page as the desk has it.
    const fresh = client().open(pageId);
    await synced(fresh);
    expect(textOf(fresh.document)).toContain('kept before the ceiling');
    expect(textOf(fresh.document)).not.toContain('Page 1');
  });

  it('the provider stays attached and quiet: no resend loop, and the session lives', async () => {
    const { pageId } = await makeNotebook(s);
    const c = client();
    const full = c.open(pageId);
    const seen = closes(full);
    await synced(full);
    const session = c.session;
    Y.applyUpdate(full.document, fakeState(60));
    await until('the close', () => seen.includes('page_full'));
    // A provider keeps sending as its editor changes. 1,500 more messages would pass Hocuspocus's queue limit of 1,000
    // if they got to it, and then the whole session would go.
    for (let i = 0; i < 1_500; i += 1) typeInto(full.document, 'x');
    await sleep(300);
    expect(c.session).toBe(session);
    expect(session?.closed).toBe(false);
    expect(seen).toEqual(['page_full']);
    expect(full.hasUnsyncedChanges).toBe(true);
    expect((await session?.rpc('notebook.tree'))?.next).toBeNull();
  });

  it('asks again with a reconnect: refused once per connection, not in a loop', async () => {
    const { pageId } = await makeNotebook(s);
    const c = client();
    const full = c.open(pageId);
    const seen = closes(full);
    await synced(full);
    Y.applyUpdate(full.document, fakeState(60));
    await until('the close', () => seen.includes('page_full'));
    const before = h.service.db.get<{ n: number }>('SELECT count(*) AS n FROM page_updates')?.n;
    c.session?.close();
    const refusals = (): string[] => seen.filter((r) => r === 'page_full');
    await until('the next refusal', () => refusals().length === 2, 5000);
    await sleep(400);
    expect(refusals()).toEqual(['page_full', 'page_full']);
    expect(h.service.db.get<{ n: number }>('SELECT count(*) AS n FROM page_updates')?.n).toBe(before);
  });

  it('a full page can still be read, and deleting from it is taken', async () => {
    const { pageId } = await makeNotebook(s);
    const c = client();
    const a = c.open(pageId);
    await synced(a);
    Y.applyUpdate(a.document, fakeState(25));
    await until('the store', () => (h.service.notebook.page(pageId)?.word_count ?? 0) > 5000, 15_000);
    await h.service.pages.commit();
    const size = Y.encodeStateAsUpdate(a.document).length;
    expect(size).toBeLessThan(LIMIT);
    expect(size).toBeGreaterThan(LIMIT / 2);
    h.service.pages.store(pageId);
    a.destroy();
    c.destroy();
    await until('the unload', () => h.service.pages.open.size === 0);
    await h.restart({ pageFullBytes: size + 10 });
    s = h.session();

    const d = client();
    const reader = d.open(pageId);
    const seen = closes(reader);
    await synced(reader);
    await until('the content', () => textOf(reader.document).includes('end-25'));
    typeInto(reader.document, 'y'.repeat(2000));
    await until('the refusal', () => seen.includes('page_full'));

    const e = client();
    const fixer = e.open(pageId);
    const seen2 = closes(fixer);
    await synced(fixer);
    await until('its content', () => textOf(fixer.document).includes('end-25'));
    expect(textOf(fixer.document)).not.toContain('yyy');
    const words = h.service.notebook.page(pageId)?.word_count ?? 0;
    fixer.document.transact(() => fixer.document.getXmlFragment(DOC_FIELD).delete(0, 8));
    await until('the delete to be acknowledged', () => !fixer.hasUnsyncedChanges);
    expect(seen2).toEqual([]);
    await until('the store', () => (h.service.notebook.page(pageId)?.word_count ?? 1e9) < words, 5000);
  });

  it('a restore that would pass it is refused and changes nothing', async () => {
    const { pageId } = await makeNotebook(s);
    const c = client();
    const a = c.open(pageId);
    await synced(a);
    Y.applyUpdate(a.document, fakeState(25));
    expect(textOf(a.document)).toContain('Page 1');
    await until('ack', () => !a.hasUnsyncedChanges, 15_000);
    await sleep(40);
    const size = Y.encodeStateAsUpdate(a.document).length;
    const { version }: any = await s.rpc('notebook.version.save', { pageId });
    a.document.transact(() => a.document.getXmlFragment(DOC_FIELD).delete(0, 100));
    await until('ack', () => !a.hasUnsyncedChanges);
    c.destroy();
    await until('the unload', () => h.service.pages.open.size === 0);
    // What's left fits this lower ceiling, and all of the old text won't.
    await h.restart({ pageFullBytes: Math.floor(size * 0.8) });
    s = h.session();
    const before = ((await s.rpc('notebook.version.list', { pageId })) as { versions: unknown[] }).versions.length;
    const e = await s.rpc('notebook.version.restore', { pageId, versionId: version.id }).catch((x) => x);
    expect(e).toMatchObject({ code: 'bad_request', details: { reason: 'page_full' } });
    const fresh = client().open(pageId);
    await synced(fresh);
    expect(textOf(fresh.document)).not.toMatch(/Page 1(?!\d)/);
    expect(textOf(fresh.document)).toContain('end-25');
    const after = ((await s.rpc('notebook.version.list', { pageId })) as { versions: unknown[] }).versions.length;
    expect(after).toBeLessThanOrEqual(before + 1); // At most the version of what was there first, kept before it tried.
  });
});

describe('page_full at the real ceiling', () => {
  it('3.5 MiB: stops growth, and a new client still gets all of it inside one message', async () => {
    h = await harness({ storeDebounceMs: 200, storeMaxWaitMs: 1000 });
    s = h.session();
    const { pageId } = await makeNotebook(s);
    const c = client();
    const a = c.open(pageId);
    const seen = closes(a);
    await synced(a);
    // About 560 KB a chunk, as the editor splits a big paste. 6 fit and the 7th doesn't.
    let chunks = 0;
    while (!seen.includes('page_full') && chunks < 12) {
      const before = a.unsyncedChanges;
      Y.applyUpdate(a.document, fakeState(90, chunks + 1));
      chunks += 1;
      await until('a reply', () => a.unsyncedChanges <= before || seen.includes('page_full'), 60_000);
    }
    expect(seen).toEqual(['page_full']);
    expect(chunks).toBeGreaterThan(4);
    const stored = h.service.pages.open.get(pageId);
    expect(stored?.stateBytes).toBeLessThanOrEqual(3.5 * 1024 * 1024);

    const max = { size: 0 };
    const fresh = client();
    const provider = fresh.open(pageId);
    const wire = provider.configuration.websocketProvider as unknown as { on(e: string, f: (x: { data: ArrayBuffer }) => void): void };
    wire.on('message', ({ data }) => {
      max.size = Math.max(max.size, data.byteLength);
    });
    await synced(provider, 60_000);
    expect(max.size).toBeLessThan(4 * 1024 * 1024);
    await until('all of it', () => textOf(provider.document).includes('end-90'), 60_000);
  }, 180_000);
});
