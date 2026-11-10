// Two or more real providers over the real socket: merging, carets, storing and loading.
import * as encoding from 'lib0/encoding';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Client, synced, until } from './helpers/deskd.ts';
import { bodyOf, doc, fakeState, h1, p, setBody, textOf, typeInto } from './helpers/docs.ts';
import { harness, makeNotebook, type Harness } from './helpers/service.ts';

let h: Harness;

/** What a provider sends as it goes: the page's name and Hocuspocus's CLOSE. */
function closeMessage(pageId: string): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, pageId);
  encoding.writeVarUint(e, 7);
  return encoding.toUint8Array(e);
}
const clients: Client[] = [];
const client = (): Client => {
  const c = new Client(h.socket);
  clients.push(c);
  return c;
};

beforeEach(async () => {
  h = await harness({ storeDebounceMs: 20, storeMaxWaitMs: 100 });
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  await h.clean();
});

describe('collab', () => {
  it('two clients merge concurrent typing, and both end the same', async () => {
    const s = h.session();
    const { pageId } = await makeNotebook(s);
    const a = client().open(pageId);
    const b = client().open(pageId);
    await Promise.all([synced(a), synced(b)]);
    typeInto(a.document, 'alpha ');
    typeInto(b.document, 'bravo ');
    for (let i = 0; i < 50; i += 1) {
      typeInto(a.document, `a${i} `);
      typeInto(b.document, `b${i} `);
    }
    await until('both to converge', () => textOf(a.document) === textOf(b.document) && textOf(a.document).includes('b49') && textOf(a.document).includes('a49'));
    for (let i = 0; i < 50; i += 1) {
      expect(textOf(a.document)).toContain(`a${i} `);
      expect(textOf(a.document)).toContain(`b${i} `);
    }
    await until('both acknowledged', () => !a.hasUnsyncedChanges && !b.hasUnsyncedChanges);
  });

  it('three clients on two pages over one virtual socket keep them apart', async () => {
    const s = h.session();
    const { tabId, pageId } = await makeNotebook(s);
    const second = (await s.rpc('notebook.page.create', { tabId })).page.id;
    const c = client();
    const a1 = c.open(pageId);
    const a2 = c.open(second);
    const b = client().open(second);
    await Promise.all([synced(a1), synced(a2), synced(b)]);
    typeInto(a1.document, 'on the first');
    typeInto(a2.document, 'on the second');
    await until('the second page to reach the other client', () => textOf(b.document).includes('on the second'));
    expect(textOf(b.document)).not.toContain('on the first');
  });

  it('a client that leaves takes its caret with it at once', async () => {
    const s = h.session();
    const { pageId } = await makeNotebook(s);
    const a = client();
    const pa = a.open(pageId);
    const pb = client().open(pageId);
    await Promise.all([synced(pa), synced(pb)]);
    pa.setAwarenessField('user', { name: 'A' });
    await until('the caret to appear', () => [...(pb.awareness?.getStates().values() ?? [])].some((v) => v['user']?.name === 'A'));
    const t0 = Date.now();
    a.session?.close();
    await until('the caret to go', () => ![...(pb.awareness?.getStates().values() ?? [])].some((v) => v['user']?.name === 'A'));
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('a store writes what a load gives back, across a restart', async () => {
    const s = h.session();
    const { pageId } = await makeNotebook(s);
    const c = client();
    const provider = c.open(pageId);
    await synced(provider);
    setBody(provider.document, doc(h1('Stored title'), p('Stored body text')));
    await until('the store', () => h.service.notebook.page(pageId)?.title === 'Stored title', 5000);
    const page = h.service.notebook.page(pageId);
    expect(page?.snippet).toBe('Stored body text');
    expect(page?.word_count).toBe(5);
    await until('acks', () => !provider.hasUnsyncedChanges);
    c.destroy();
    await until('the page to unload', () => h.service.pages.open.size === 0);
    await h.restart();

    const fresh = client().open(pageId);
    await synced(fresh);
    await until('the text', () => textOf(fresh.document).includes('Stored body text'));
    expect(bodyOf(fresh.document)).toEqual(doc(h1('Stored title'), p('Stored body text')));
  });

  it('the 100-page page loads, and a new client gets all of it', async () => {
    const s = h.session();
    const { pageId } = await makeNotebook(s);
    const c = client();
    const a = c.open(pageId);
    await synced(a);
    Y.applyUpdate(a.document, fakeState(100));
    await until('the store', () => (h.service.notebook.page(pageId)?.word_count ?? 0) > 40_000, 20_000);
    const fresh = client().open(pageId);
    await synced(fresh, 30_000);
    await until('the end of the page', () => textOf(fresh.document).includes('end-100'), 30_000);
  });

  it('a page that does not exist is refused, and other pages carry on', async () => {
    const s = h.session();
    const { pageId } = await makeNotebook(s);
    const c = client();
    const denied: string[] = [];
    const bad = c.open('no-such-page', new Y.Doc(), { onAuthenticationFailed: ({ reason }: { reason: string }) => denied.push(reason) });
    const good = c.open(pageId);
    await synced(good);
    await until('the refusal', () => denied.includes('not_found'));
    expect(bad.isSynced).toBe(false);
    typeInto(good.document, 'still fine');
    await until('ack', () => !good.hasUnsyncedChanges);
    expect(h.service.db.get<{ n: number }>("SELECT count(*) AS n FROM page_updates WHERE page_id = 'no-such-page'")?.n).toBe(0);
  });

  it("a provider reconnecting on the same session, with no reset, syncs again", async () => {
    const s = h.session();
    const { pageId } = await makeNotebook(s);
    const c = client();
    const a = c.open(pageId);
    const b = client().open(pageId);
    await Promise.all([synced(a), synced(b)]);
    typeInto(a.document, 'first ');
    await until('b to have it', () => textOf(b.document).includes('first'));
    // The provider starts over on the virtual socket, as after its own 30 s timeout: Auth and step 1 again on a page
    // this connection already has. deskd sees nothing of it.
    a.onOpen({} as Event);
    typeInto(a.document, 'second ');
    typeInto(b.document, 'third ');
    await until('both to merge', () => textOf(a.document).includes('third') && textOf(b.document).includes('second'));
    await until('acks', () => !a.hasUnsyncedChanges && !b.hasUnsyncedChanges);
    expect(c.session?.closed).toBe(false);
  });

  it('a page closed and opened again in the same tick, on one session, syncs and is acknowledged', async () => {
    const s = h.session();
    const { pageId } = await makeNotebook(s);
    const c = client();
    let provider = c.open(pageId);
    await synced(provider);
    // The app drops a page once its edits are acknowledged, and opens it again when it's back on screen. The old
    // provider's CLOSE and the new one's Auth then reach desk-notebook in one read, as here, where both are written
    // before the service can read either. On Hocuspocus's own, the Auth went to the page that was closing and was
    // lost, and the page never synced again on that connection.
    for (let round = 0; round < 5; round += 1) {
      typeInto(provider.document, `round ${round} `);
      await until('the edit to be acknowledged', () => !provider.hasUnsyncedChanges);
      provider.destroy();
      const closes: (string | undefined)[] = [];
      provider = c.open(pageId, new Y.Doc(), { onClose: ({ event }: { event?: { reason?: string } }) => closes.push(event?.reason) });
      await synced(provider);
      expect(textOf(provider.document)).toContain(`round ${round} `);
      typeInto(provider.document, `after ${round} `);
      await until('the new provider to be acknowledged', () => !provider.hasUnsyncedChanges, 5000);
      // The old provider's close was answered, and that answer was for it: the new one never hears it.
      expect(closes).toEqual([]);
    }
    expect(c.session?.closed).toBe(false);
  });

  it("a CLOSE for a page this connection doesn't have open is dropped, not kept for the next provider's Auth", async () => {
    const s = h.session();
    const { tabId, pageId } = await makeNotebook(s);
    const other = (await s.rpc('notebook.page.create', { tabId })).page.id;
    const c = client();
    await synced(c.open(other));
    // As a CLOSE sent on a virtual socket deskd has since reset arrives on the new connection.
    c.session!.sendCollab(closeMessage(pageId));
    const provider = c.open(pageId);
    await synced(provider);
    typeInto(provider.document, 'kept open');
    await until('the edit to be acknowledged', () => !provider.hasUnsyncedChanges, 5000);
  });

  it('editing a trashed page keeps the edit', async () => {
    const s = h.session();
    const { pageId } = await makeNotebook(s);
    const provider = client().open(pageId);
    await synced(provider);
    await s.rpc('notebook.page.trash', { pageId });
    setBody(provider.document, doc(h1('Trashed but typed in'), p('kept')));
    await until('the store', () => h.service.notebook.page(pageId)?.title === 'Trashed but typed in', 5000);
    expect(h.service.notebook.page(pageId)?.deleted_at).not.toBeNull();
  });
});
