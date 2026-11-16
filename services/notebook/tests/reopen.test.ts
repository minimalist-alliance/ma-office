// A page opened just as a direct connection left it (`notebook.version.save`, a restore, an agent's edit, on a page
// nobody had open): what the editor then types is stored.
//
// Hocuspocus 4.8 ends every store with `setTimeout(() => unloadDocument(document), 0)`. A direct connection stores and
// unloads at once, so that timer outlives its document, and if a new editor's page loads first, the stale timer used to
// unload the new page by its name: out of Hocuspocus's map and out of `Pages`, so its typing was acknowledged and never
// stored (found Nov 12, 8 of 16 runs). `held()` makes that order certain: it holds those timers until the editor's page
// has loaded, then lets them run.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, synced, until, type DeskdSession } from './helpers/deskd.ts';
import { doc, h1, p, setBody, textOf, typeInto } from './helpers/docs.ts';
import { harness, makeNotebook, type Harness } from './helpers/service.ts';

let h: Harness;
let s: DeskdSession;
const clients: Client[] = [];
const client = (): Client => {
  const c = new Client(h.socket);
  clients.push(c);
  return c;
};

beforeEach(async () => {
  h = await harness({ storeDebounceMs: 5, storeMaxWaitMs: 20 });
  s = h.session();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  await h.clean();
});

/** The timers Hocuspocus sets after a store to unload the page, held until `release`. Nothing else is held. */
function held(): { count: () => number; release: () => void } {
  const real = globalThis.setTimeout;
  const waiting: Array<() => void> = [];
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (typeof fn === 'function' && !ms && fn.toString().includes('unloadDocument(document)')) {
      waiting.push(() => fn(...args));
      return real(() => undefined, 0);
    }
    return real(fn, ms, ...args);
  }) as typeof setTimeout;
  return {
    count: () => waiting.length,
    release: () => {
      globalThis.setTimeout = real;
      for (const run of waiting.splice(0)) run();
    },
  };
}

/** What the desk has stored for the page: the `pages` row, not the live document. */
const storedText = (pageId: string): string => h.service.db.get<{ t: string }>('SELECT plain_text AS t FROM pages WHERE id = ?', pageId)?.t ?? '';

/** A page with some text, written by an editor that has since left, so nobody has it open. */
async function closedPage(): Promise<string> {
  const { pageId } = await makeNotebook(s);
  const c = client();
  const provider = c.open(pageId);
  await synced(provider);
  setBody(provider.document, doc(h1('Plan'), p('first line')));
  await until('ack', () => !provider.hasUnsyncedChanges);
  c.destroy();
  clients.splice(clients.indexOf(c), 1);
  await until('the page to unload', () => !h.service.pages.open.has(pageId));
  return pageId;
}

/** After `direct` (a call that opens the page directly and leaves it), an editor opens it, types and is acknowledged. */
async function typeAfter(pageId: string, direct: () => Promise<unknown>, typed: string, hold: boolean): Promise<void> {
  const timers = hold ? held() : null;
  try {
    await direct();
    if (timers) {
      // The call opened the page, stored and unloaded it, and left Hocuspocus's timer behind.
      expect(h.service.collab.documents.has(pageId)).toBe(false);
      expect(timers.count()).toBeGreaterThan(0);
    }
    const provider = client().open(pageId);
    await synced(provider);
    const live = h.service.collab.documents.get(pageId);
    expect(live).toBeDefined();
    // The stale timer runs now, with the editor's page loaded under the same name.
    timers?.release();
    await until('no unload under way', () => h.service.collab.unloadingDocuments.size === 0);
    typeInto(provider.document, typed);
    await until('ack', () => !provider.hasUnsyncedChanges);
    expect(textOf(provider.document)).toContain(typed);
    await until('the typing to be stored', () => storedText(pageId).includes(typed), 5000);
    // The page in memory is still the editor's, in Hocuspocus and in Pages.
    expect(h.service.collab.documents.get(pageId)).toBe(live);
    expect(h.service.pages.open.get(pageId)?.doc).toBe(live);
  } finally {
    timers?.release();
  }
}

describe('a page opened just after a direct connection left it', () => {
  it('after notebook.version.save: the typing is stored', async () => {
    const pageId = await closedPage();
    await typeAfter(pageId, () => s.rpc('notebook.version.save', { pageId }), ' typed after the save', true);
    // And a fresh editor reads it back.
    const again = client().open(pageId);
    await synced(again);
    expect(textOf(again.document)).toContain('first line typed after the save');
  });

  it('after notebook.version.restore: the typing is stored', async () => {
    const pageId = await closedPage();
    const saved = await s.rpc('notebook.version.save', { pageId });
    await until('no unload under way', () => h.service.collab.unloadingDocuments.size === 0 && !h.service.collab.documents.has(pageId));
    await typeAfter(pageId, () => s.rpc('notebook.version.restore', { pageId, versionId: saved.version.id }), ' typed after the restore', true);
  });

  it("after an agent's edit: the typing is stored", async () => {
    const pageId = await closedPage();
    await typeAfter(pageId, () => s.rpc('notebook.page.agentEdit', { agentName: 'ag-1', op: 'append', pageId, markdown: 'From the agent.' }), ' typed after the agent', true);
    expect(storedText(pageId)).toContain('From the agent.');
  });

  it('a stale unload never takes the page from a later editor: save, open, type, 16 times as it happens', async () => {
    // No timers held: the order is whatever the loop gives, as the Nov 12 runs had it (8 of 16 lost on main).
    const lost: number[] = [];
    for (let i = 0; i < 16; i += 1) {
      const pageId = await closedPage();
      await s.rpc('notebook.version.save', { pageId });
      const c = client();
      const provider = c.open(pageId);
      await synced(provider);
      typeInto(provider.document, ` run ${i}`);
      await until('ack', () => !provider.hasUnsyncedChanges);
      try {
        await until('the typing to be stored', () => storedText(pageId).includes(` run ${i}`), 2000);
      } catch {
        lost.push(i);
      }
      c.destroy();
      clients.splice(clients.indexOf(c), 1);
    }
    if (process.env['NB_REOPEN_STATS']) console.log(`NB_REOPEN_STATS lost=${lost.length} of 16`);
    expect(lost).toEqual([]);
  });
});
