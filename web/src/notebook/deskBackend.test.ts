// `DeskBackend` over a fake link. The RPC half has scripted answers, so each retry and each key can be seen. The text half runs the
// real provider against the mock desk's server of Hocuspocus's protocol, over a loopback of the channel.
import 'fake-indexeddb/auto';
import { setMaxListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { DeskNotConnected, MAX_COLLAB_MESSAGE, type CollabChannel, type CollabEnd, type DeskLink, type LinkState, type LinkTopics, type RpcOptions } from '../desk/deskLink';
import { backendFor, DeskBackend, type DeskBackendOptions } from './deskBackend';

const windowEvents = new EventTarget();
setMaxListeners(0, windowEvents); // one `pagehide` per provider, as in a browser
vi.stubGlobal('window', Object.assign(windowEvents, { setTimeout, clearTimeout, setInterval, clearInterval }));

// After the stub: the mock's module reads `window` as it loads.
const { MockCollabServer, mockDesk, mockNotebookControl } = await import('../desk/mockNotebook');

interface Call {
  method: string;
  params: Record<string, unknown>;
  options?: RpcOptions;
}

type Answer = (method: string, params: Record<string, unknown>, options?: RpcOptions) => unknown;

const refused = (code: string, details: Record<string, unknown> = {}): Error => Object.assign(new Error(code), { code, details });
const flushed = (): Promise<void> => new Promise((done) => setTimeout(done, 0));
const until = async (check: () => boolean, ms = 4_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((done) => setTimeout(done, 10));
  }
};

const notebookRec = (id: string) => ({ id, title: id, sortKey: 0, createdAt: 1, updatedAt: 1, rowVersion: 1 });
const tabRec = (id: string, notebookId: string) => ({ id, notebookId, title: id, color: 'blue' as const, sortKey: 0, createdAt: 1, updatedAt: 1, rowVersion: 1 });
const pageRec = (id: string, tabId: string, sortKey = 0) => ({ id, tabId, sortKey, title: id, snippet: '', wordCount: 0, hasChecklist: false, createdAt: 1, updatedAt: 1, deletedAt: null, rowVersion: 1 });
const emptyTree = (rev = 1) => ({ notebooks: [], tabs: [], pages: [], rev, next: null });

class FakeChannel implements CollabChannel {
  open = true;
  onOpen: (() => void) | null = null;
  onMessage: ((bytes: Uint8Array<ArrayBuffer>) => void) | null = null;
  onEnd: ((why: CollabEnd) => void) | null = null;
  readonly sizes: number[] = [];
  server: InstanceType<typeof MockCollabServer> | null = null;
  /** Every message is lost on the way: the link is up and the desk hears nothing. */
  deaf = false;

  constructor(private readonly deskId: string | null) {}

  private ensureServer(): InstanceType<typeof MockCollabServer> | null {
    if (!this.deskId) return null;
    this.server ??= new MockCollabServer(mockDesk(this.deskId), (bytes) => setTimeout(() => this.onMessage?.(bytes), 0));
    return this.server;
  }

  send(bytes: Uint8Array): boolean {
    if (bytes.length > MAX_COLLAB_MESSAGE) throw new Error('a real desk would close the whole session with 4001');
    if (!this.open) return false;
    this.sizes.push(bytes.length);
    if (!this.deaf) this.ensureServer()?.receive(bytes.slice());
    return true;
  }

  reset(): void {
    this.server?.drop();
    this.server = null;
    this.onEnd?.('reset');
  }

  end(): void {
    this.open = false;
    this.server?.drop();
    this.server = null;
    this.onEnd?.('ended');
  }
}

class FakeLink {
  state: LinkState = 'open';
  readonly calls: Call[] = [];
  readonly subs = new Map<keyof LinkTopics, ((m: never) => void)[]>();
  readonly fns = new Set<(s: LinkState) => void>();
  channel: FakeChannel;
  answer: Answer = () => emptyTree();

  constructor(
    readonly deskId: string,
    private readonly loopback = false,
  ) {
    this.channel = new FakeChannel(loopback ? deskId : null);
  }

  status = (): LinkState => this.state;
  collab = (): CollabChannel | null => (this.state === 'open' ? this.channel : null);
  onStatus = (fn: (s: LinkState) => void): (() => void) => {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  };

  onMedia = (): (() => void) => () => {};

  call = async (method: string, params: Record<string, unknown> = {}, options?: RpcOptions): Promise<unknown> => {
    this.calls.push({ method, params, ...(options ? { options } : {}) });
    if (this.state !== 'open') throw new DeskNotConnected(this.deskId);
    if (this.loopback) return mockDesk(this.deskId).answer(method, params, options?.idem);
    const a = this.answer(method, params, options);
    if (a instanceof Error) throw a;
    return a;
  };

  subscribe = <T extends keyof LinkTopics>(topic: T, fn: (m: LinkTopics[T]) => void): (() => void) => {
    const list = this.subs.get(topic) ?? [];
    list.push(fn as (m: never) => void);
    this.subs.set(topic, list);
    return () => list.splice(list.indexOf(fn as (m: never) => void), 1);
  };

  rev(rev: number): void {
    for (const fn of this.subs.get('notebook.tree') ?? []) (fn as (m: LinkTopics['notebook.tree']) => void)({ seq: 1, rev });
  }

  go(state: LinkState): void {
    this.state = state;
    for (const fn of [...this.fns]) fn(state);
  }

  /** The session goes: the channel with it. */
  drop(): void {
    this.channel.end();
    this.go('retrying');
  }

  back(): void {
    this.channel = new FakeChannel(this.loopback ? this.deskId : null);
    this.go('open');
  }

  methods = (): string[] => this.calls.map((c) => c.method);
  of = (m: string): Call[] => this.calls.filter((c) => c.method === m);
}

const made: DeskBackend[] = [];
function backend(link: FakeLink, options: DeskBackendOptions = {}): DeskBackend {
  const b = new DeskBackend(link as unknown as DeskLink, { storage: new Map<string, string>() as unknown as DeskBackendOptions['storage'], timeZone: () => 'America/Denver', giveUpMs: 400, retryMs: [20, 40], unsavedAfterMs: 40, reconnectMs: 10, tooLargeRetryMs: 30, socketIdleMs: 10, ...options });
  made.push(b);
  return b;
}

/** A `localStorage` that's easy to read. */
function memory(seed: Record<string, string> = {}): NonNullable<DeskBackendOptions['storage']> & { data: Record<string, string> } {
  const data = { ...seed };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
}

beforeEach(() => {
  mockNotebookControl.zones.length = 0;
  mockNotebookControl.fullPages = [];
  mockNotebookControl.outdatedPages = [];
  mockNotebookControl.tokens.length = 0;
  mockNotebookControl.silent = false;
  mockNotebookControl.cutOff = {};
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reading the tree', () => {
  it('reads every page of it, keeps the first rev, and builds the Tree', async () => {
    const link = new FakeLink('d-1');
    link.answer = (m, p) => {
      if (m === 'notebook.settings.set') return {};
      if (!p['cursor']) return { notebooks: [notebookRec('n')], tabs: [tabRec('t', 'n')], pages: [pageRec('p1', 't', 1)], rev: 7, next: 'blue' };
      if (p['cursor'] === 'blue') return { notebooks: [notebookRec('n')], tabs: [tabRec('t', 'n')], pages: [pageRec('p2', 't', 2)], rev: 8, next: 'green' };
      return { notebooks: [], tabs: [], pages: [pageRec('gone', 't', 3)], rev: 9, next: null };
    };
    const b = backend(link);
    await b.ready();
    const tree = b.tree();
    expect(tree.notebooks.map((n) => n.id)).toEqual(['n']);
    expect(tree.tabs['n']?.map((t) => t.id)).toEqual(['t']);
    expect(tree.pages['t']?.map((p) => p.id)).toEqual(['p1', 'p2', 'gone']);
    expect(link.of('notebook.tree').map((c) => c.params)).toEqual([{}, { cursor: 'blue' }, { cursor: 'green' }]);
    expect(b.status().load).toBe('ready');
    // The first page said 7: a change during the rest says a newer one, and that reads it all again.
    b.subscribe(() => {});
    b.setActive(true);
    link.calls.length = 0;
    link.rev(7);
    await flushed();
    expect(link.calls).toEqual([]);
    link.rev(8);
    await until(() => link.of('notebook.tree').length >= 3);
  });

  it('an empty desk is an empty tree, and asks to make nothing', async () => {
    const link = new FakeLink('d-1');
    const b = backend(link);
    await b.ready();
    expect(b.tree().notebooks).toEqual([]);
    expect(link.calls.filter((c) => c.method.includes('create'))).toEqual([]);
  });

  it('not_found means no Notebook on this desk: no retries, and the next session asks once more', async () => {
    vi.useFakeTimers();
    const link = new FakeLink('d-1');
    link.answer = () => refused('not_found');
    const b = backend(link);
    b.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(b.status().load).toBe('missing');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(link.of('notebook.tree')).toHaveLength(1);
    link.answer = () => emptyTree();
    link.go('open');
    await vi.advanceTimersByTimeAsync(0);
    expect(b.status().load).toBe('ready');
  });

  it("unavailable: calm, the wait grows, and it's gone from the window as soon as it answers", async () => {
    vi.useFakeTimers();
    const link = new FakeLink('d-1');
    link.answer = () => refused('unavailable', { reason: 'notebook' });
    const b = backend(link, { retryMs: [2_000, 5_000, 30_000] });
    b.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(b.status().load).toBe('unavailable');
    const asked = (): number => link.of('notebook.tree').length;
    expect(asked()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(asked()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(asked()).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(asked()).toBe(3);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(asked()).toBe(5); // never more than one a period, however long it lasts
    link.answer = () => emptyTree();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(b.status().load).toBe('ready');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(asked()).toBe(6);
  });

  it("a parked window doesn't ask, and asks once when it's back", async () => {
    vi.useFakeTimers();
    const link = new FakeLink('d-1');
    link.answer = () => refused('unavailable', { reason: 'notebook' });
    const b = backend(link, { retryMs: [1_000] });
    b.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    b.setActive(false);
    const before = link.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(link.calls.length).toBe(before);
    link.answer = () => emptyTree();
    b.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(b.status().load).toBe('ready');
  });

  it('with no session it waits for the link: no retries of its own', async () => {
    vi.useFakeTimers();
    const link = new FakeLink('d-1');
    link.state = 'retrying';
    const b = backend(link, { retryMs: [10] });
    b.setActive(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(b.status().load).toBe('loading');
    expect(link.of('notebook.tree')).toHaveLength(1);
    link.go('open');
    await vi.advanceTimersByTimeAsync(0);
    expect(b.status().load).toBe('ready');
  });
});

describe('the notebook.tree topic', () => {
  async function ready(): Promise<{ link: FakeLink; b: DeskBackend }> {
    const link = new FakeLink('d-1');
    link.answer = () => emptyTree(5);
    const b = backend(link);
    b.setActive(true);
    b.subscribe(() => {});
    await b.ready();
    link.calls.length = 0;
    return { link, b };
  }

  it('reads again only when rev is newer', async () => {
    const { link } = await ready();
    link.rev(5); // what the subscribing snapshot says
    link.rev(4);
    await flushed();
    expect(link.calls).toEqual([]);
    link.answer = () => emptyTree(6);
    link.rev(6);
    await until(() => link.calls.length === 1);
  });

  it('a burst is one read, and one after it', async () => {
    const { link } = await ready();
    let revNow = 6;
    link.answer = () => emptyTree(revNow);
    for (; revNow < 30; revNow += 1) link.rev(revNow);
    await flushed();
    await flushed();
    expect(link.of('notebook.tree').length).toBeLessThanOrEqual(2);
  });

  it('a window parked behind another desk reads nothing, and catches up once on its return', async () => {
    const { link, b } = await ready();
    b.setActive(false);
    link.answer = () => emptyTree(9);
    link.rev(7);
    link.rev(8);
    link.rev(9);
    await flushed();
    expect(link.calls).toEqual([]);
    b.setActive(true);
    await until(() => link.calls.length === 1);
  });

  it('a new session reads it again, whatever rev it last saw', async () => {
    const { link } = await ready();
    link.drop();
    link.back();
    await until(() => link.of('notebook.tree').length === 1);
  });

  it('stops listening once nobody draws the tree', async () => {
    const link = new FakeLink('d-1');
    const b = backend(link);
    const off = b.subscribe(() => {});
    const off2 = b.subscribe(() => {});
    expect(link.subs.get('notebook.tree')).toHaveLength(1);
    off();
    expect(link.subs.get('notebook.tree')).toHaveLength(1);
    off2();
    expect(link.subs.get('notebook.tree')).toHaveLength(0);
  });
});

describe('the time zone', () => {
  it('sends it once, in ready, with idem, and not again on this desk', async () => {
    const storage = memory();
    const link = new FakeLink('d-1');
    link.answer = (m) => (m === 'notebook.settings.set' ? {} : emptyTree());
    await backend(link, { storage }).ready();
    const sent = link.of('notebook.settings.set');
    expect(sent.map((c) => c.params)).toEqual([{ timeZone: 'America/Denver' }]);
    expect(sent[0]?.options?.idem).toBeTruthy();
    expect(storage.data['ma.notebook.tz.d-1']).toBe('America/Denver');

    const again = new FakeLink('d-1');
    again.answer = () => emptyTree();
    await backend(again, { storage }).ready();
    expect(again.of('notebook.settings.set')).toEqual([]);
  });

  it('a new zone goes, and another desk has its own', async () => {
    const storage = memory({ 'ma.notebook.tz.d-1': 'America/Denver' });
    const moved = new FakeLink('d-1');
    moved.answer = (m) => (m === 'notebook.settings.set' ? {} : emptyTree());
    await backend(moved, { storage, timeZone: () => 'Asia/Tokyo' }).ready();
    expect(moved.of('notebook.settings.set').map((c) => c.params)).toEqual([{ timeZone: 'Asia/Tokyo' }]);
    const other = new FakeLink('d-2');
    other.answer = (m) => (m === 'notebook.settings.set' ? {} : emptyTree());
    await backend(other, { storage, timeZone: () => 'Asia/Tokyo' }).ready();
    expect(other.of('notebook.settings.set')).toHaveLength(1);
  });

  it("an unknown zone isn't asked again, and a failure is, next time. Neither stops the Notebook or says anything", async () => {
    const storage = memory();
    const refusing = new FakeLink('d-1');
    refusing.answer = (m) => (m === 'notebook.settings.set' ? refused('bad_request', { reason: 'time_zone' }) : emptyTree());
    const b = backend(refusing, { storage, timeZone: () => 'Mars/Olympus' });
    await b.ready();
    expect(b.status()).toMatchObject({ load: 'ready', problem: false });
    expect(storage.data['ma.notebook.tz.d-1']).toBe('Mars/Olympus');

    const storage2 = memory();
    const failing = new FakeLink('d-1');
    failing.answer = (m) => (m === 'notebook.settings.set' ? refused('internal') : emptyTree());
    const c = backend(failing, { storage: storage2 });
    await c.ready();
    expect(c.status().problem).toBe(false);
    expect(storage2.data['ma.notebook.tz.d-1']).toBeUndefined();
  });

  it('a desk slow to answer holds opening by moments at most', async () => {
    vi.useFakeTimers();
    const link = new FakeLink('d-1');
    link.answer = (m) => (m === 'notebook.settings.set' ? new Promise(() => {}) : emptyTree());
    const b = backend(link);
    let opened = false;
    void b.ready().then(() => (opened = true));
    await vi.advanceTimersByTimeAsync(1_499);
    expect(opened).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(opened).toBe(true);
  });
});

describe('structure', () => {
  const ok = (m: string): unknown => {
    switch (m) {
      case 'notebook.notebook.create':
        return { notebook: notebookRec('n'), tab: tabRec('t', 'n'), page: pageRec('p', 't') };
      case 'notebook.tab.create':
        return { tab: tabRec('t2', 'n'), page: pageRec('p2', 't2') };
      case 'notebook.tab.addAtPage':
        return { tab: tabRec('t3', 'n') };
      case 'notebook.page.create':
        return { page: pageRec('p3', 't') };
      case 'notebook.page.duplicate':
        return { page: { ...pageRec('p4', 't'), label: 'blue' } };
      case 'notebook.page.import':
        return { page: pageRec('p5', 't') };
      case 'notebook.version.save':
        return { version: null };
      case 'notebook.tree':
        return emptyTree();
      default:
        return {};
    }
  };

  it.each([
    ['createNotebook', ['T'], 'notebook.notebook.create', { title: 'T' }],
    ['renameNotebook', ['n', 'T'], 'notebook.notebook.rename', { id: 'n', title: 'T' }],
    ['createTab', ['n', { title: 'T', color: 'rose' }], 'notebook.tab.create', { notebookId: 'n', title: 'T', color: 'rose' }],
    ['renameTab', ['t', 'T'], 'notebook.tab.rename', { id: 't', title: 'T' }],
    ['recolorTab', ['t', 'amber'], 'notebook.tab.recolor', { id: 't', color: 'amber' }],
    ['addTabAtPage', ['p', 'T'], 'notebook.tab.addAtPage', { pageId: 'p', title: 'T' }],
    ['createPage', ['t', { after: 'p' }], 'notebook.page.create', { tabId: 't', after: 'p' }],
    ['movePage', ['p', 't', 2], 'notebook.page.move', { pageId: 'p', tabId: 't', index: 2 }],
    ['movePage', ['p', 't'], 'notebook.page.move', { pageId: 'p', tabId: 't' }],
    ['trashPage', ['p'], 'notebook.page.trash', { pageId: 'p' }],
    ['restorePage', ['p'], 'notebook.page.restore', { pageId: 'p' }],
    ['saveVersion', ['p'], 'notebook.version.save', { pageId: 'p' }],
    ['saveVersion', ['p', 'manual'], 'notebook.version.save', { pageId: 'p', reason: 'manual' }],
    ['restoreVersion', ['p', 'v'], 'notebook.version.restore', { pageId: 'p', versionId: 'v' }],
    ['setPageLabel', ['p', 'green'], 'notebook.page.label', { pageId: 'p', label: 'green' }],
    ['setPageLabel', ['p', null], 'notebook.page.label', { pageId: 'p', label: null }],
    ['duplicatePage', ['p'], 'notebook.page.duplicate', { pageId: 'p' }],
    ['importPage', ['t', { doc: { type: 'doc', content: [] }, label: 'amber', title: 'x' }, { after: 'p' }], 'notebook.page.import', { tabId: 't', doc: { type: 'doc', content: [] }, label: 'amber', after: 'p' }],
  ] as [keyof DeskBackend, unknown[], string, Record<string, unknown>][])('%s goes out as %s, with idem and with no rowVersion', async (name, args, method, params) => {
    const link = new FakeLink('d-1');
    link.answer = ok;
    const b = backend(link);
    await (b[name] as (...a: unknown[]) => Promise<unknown>).apply(b, args);
    const call = link.of(method)[0] as Call;
    expect(call.params).toEqual(params);
    expect(JSON.stringify(link.calls)).not.toContain('rowVersion');
    expect(call.options?.idem).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a page a create returned is in the tree by the time the caller can select it', async () => {
    const link = new FakeLink('d-1');
    let treeHasPage = false;
    link.answer = (m) => {
      if (m === 'notebook.tree') return treeHasPage ? { notebooks: [notebookRec('n')], tabs: [tabRec('t', 'n')], pages: [pageRec('p3', 't')], rev: 2, next: null } : emptyTree();
      treeHasPage = true;
      return ok(m);
    };
    const b = backend(link);
    const page = await b.createPage('t');
    expect(b.tree().byId[page.id]?.id).toBe('p3');
  });

  it('a duplicate or an imported page is in the tree by the time the caller can select it, its label with it', async () => {
    const link = new FakeLink('d-1');
    link.answer = (m) => (m === 'notebook.tree' ? emptyTree() : ok(m));
    const b = backend(link);
    const copy = await b.duplicatePage('p');
    expect(b.tree().byId[copy.id]).toMatchObject({ id: 'p4', label: 'blue' });
    const made = await b.importPage('t', { doc: { type: 'doc', content: [] }, label: null, title: '' });
    expect(b.tree().byId[made.id]?.id).toBe('p5');
  });

  it('labels, a duplicate and an import on the mock desk, end to end through the contract', async () => {
    const link = new FakeLink('d-colors', true);
    const b = backend(link);
    await b.ready();
    const { tab, page } = await b.createNotebook('Colors');
    await b.setPageLabel(page.id, 'violet');
    await until(() => b.tree().byId[page.id]?.label === 'violet');
    const copy = await b.duplicatePage(page.id);
    expect(copy.label).toBe('violet');
    const body = { type: 'doc', content: [{ type: 'paragraph', attrs: { color: 'blue' }, content: [{ type: 'text', text: 'brought in', marks: [{ type: 'textColor', attrs: { color: 'blue' } }] }] }] };
    const made = await b.importPage(tab.id, { doc: body, label: 'green', title: '' }, { after: copy.id });
    await until(() => b.tree().pages[tab.id]?.length === 3);
    expect(b.tree().pages[tab.id]?.map((x) => x.id)).toEqual([page.id, copy.id, made.id]);
    expect(made).toMatchObject({ title: 'brought in', label: 'green' });
    expect(JSON.stringify(await b.pageContent(made.id))).toContain('"textColor","attrs":{"color":"blue"}');
    expect((await b.search('', { labels: ['green'] })).map((h) => h.pageId)).toEqual([made.id]);
    await b.setPageLabel(page.id, null);
    await until(() => b.tree().byId[page.id]?.label == null);
  });

  it("a read begun before a change can't take the change back", async () => {
    const link = new FakeLink('d-1');
    const reads: ((v: unknown) => void)[] = [];
    link.answer = (m) => {
      if (m === 'notebook.tree') return new Promise((done) => reads.push(done));
      return ok(m);
    };
    const b = backend(link);
    b.setActive(true);
    b.subscribe(() => {});
    (b as unknown as { rev: number }).rev = 1;
    link.rev(2); // a read goes out
    await flushed();
    const made = b.createPage('t');
    await flushed();
    (reads.shift() as (v: unknown) => void)(emptyTree(2)); // an answer from before the page existed
    await flushed();
    expect(b.tree().byId['p3']?.id).toBe('p3');
    (reads.shift() as (v: unknown) => void)({ notebooks: [], tabs: [], pages: [pageRec('p3', 't')], rev: 3, next: null });
    await made;
    expect(b.tree().byId['p3']?.id).toBe('p3');
  });

  it('the same idem through every retry: unavailable, a lost reply, and a dropped link', async () => {
    const link = new FakeLink('d-1');
    const script: unknown[] = [refused('unavailable', { reason: 'notebook' }), refused('unavailable', { reason: 'notebook' }), refused('deadline_exceeded'), refused('cancelled')];
    link.answer = (m) => {
      if (m === 'notebook.tree') return emptyTree();
      return script.length ? script.shift() : ok(m);
    };
    const b = backend(link, { giveUpMs: 10_000 });
    await b.renameTab('t', 'T');
    const keys = link.of('notebook.tab.rename').map((c) => c.options?.idem);
    expect(keys).toHaveLength(5);
    expect(new Set(keys).size).toBe(1);
  });

  it('mayHaveApplied goes no further: the same key only replays it, so it says so once and reads the tree', async () => {
    const link = new FakeLink('d-1');
    link.answer = (m) => (m === 'notebook.tree' ? emptyTree() : refused('unavailable', { reason: 'notebook', mayHaveApplied: true }));
    const b = backend(link, { giveUpMs: 10_000 });
    const trees = link.of('notebook.tree').length;
    await expect(b.createPage('t')).rejects.toMatchObject({ code: 'unavailable' });
    expect(link.of('notebook.page.create')).toHaveLength(1);
    expect(b.status().problem).toBe(true);
    await until(() => link.of('notebook.tree').length > trees);
  });

  it('a new action has a new key', async () => {
    const link = new FakeLink('d-1');
    link.answer = ok;
    const b = backend(link);
    await b.renameTab('t', 'A');
    await b.renameTab('t', 'B');
    const keys = link.of('notebook.tab.rename').map((c) => c.options?.idem);
    expect(new Set(keys).size).toBe(2);
  });

  it('a link that drops waits, and goes on the same key when it returns', async () => {
    const link = new FakeLink('d-1');
    link.answer = ok;
    link.state = 'retrying';
    const b = backend(link, { giveUpMs: 10_000 });
    const done = b.trashPage('p');
    await flushed();
    expect(link.of('notebook.page.trash')).toHaveLength(1);
    link.back();
    await done;
    const keys = link.of('notebook.page.trash').map((c) => c.options?.idem);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('gives up in the end: it rejects, says so once, reads the tree, and the next good change clears it', async () => {
    const link = new FakeLink('d-1');
    link.answer = (m) => (m === 'notebook.tree' ? emptyTree() : refused('unavailable', { reason: 'notebook' }));
    const b = backend(link, { giveUpMs: 50 });
    await expect(b.movePage('p', 't')).rejects.toMatchObject({ code: 'unavailable' });
    expect(b.status().problem).toBe(true);
    expect(link.of('notebook.tree').length).toBeGreaterThan(0);
    link.answer = ok;
    await b.movePage('p', 't');
    expect(b.status().problem).toBe(false);
  });

  it("a refusal isn't retried", async () => {
    const link = new FakeLink('d-1');
    link.answer = (m) => (m === 'notebook.tree' ? emptyTree() : refused('not_found'));
    const b = backend(link);
    await expect(b.trashPage('gone')).rejects.toMatchObject({ code: 'not_found' });
    expect(link.of('notebook.page.trash')).toHaveLength(1);
  });
});

describe('reads', () => {
  it('a page in parts: joined until next is null, then parsed', async () => {
    const link = new FakeLink('d-1');
    const text = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }] });
    link.answer = (_m, p) => {
      if (!p['cursor']) return { part: text.slice(0, 10), next: 'a' };
      if (p['cursor'] === 'a') return { part: text.slice(10, 20), next: 'b' };
      return { part: text.slice(20), next: null };
    };
    const doc = await backend(link).pageContent('p');
    expect(JSON.stringify(doc)).toBe(text);
    expect(link.of('notebook.page.content').map((c) => c.params)).toEqual([{ pageId: 'p' }, { pageId: 'p', cursor: 'a' }, { pageId: 'p', cursor: 'b' }]);
  });

  it("a read whose snapshot has gone starts again from the top, and parts from two snapshots never join", async () => {
    const link = new FakeLink('d-1');
    const older = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first draft' }] }] });
    const newer = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second draft, longer' }] }] });
    let reads = 0;
    link.answer = (_m, p) => {
      if (!p['cursor']) {
        reads += 1;
        const text = reads === 1 ? older : newer;
        return { part: text.slice(0, 12), next: `s${reads}:12` };
      }
      if (p['cursor'] === 's1:12') return refused('bad_request', { reason: 'cursor' });
      return { part: newer.slice(12), next: null };
    };
    const b = backend(link);
    expect(JSON.stringify(await b.pageContent('p'))).toBe(newer);
    expect(b.status().problem).toBe(false);
    link.answer = (_m, p) => (!p['cursor'] ? { part: '{"type"', next: 'x:7' } : refused('bad_request', { reason: 'cursor' }));
    await expect(b.pageContent('p')).rejects.toMatchObject({ code: 'bad_request' });
    expect(link.of('notebook.page.content').filter((c) => !c.params['cursor']).length).toBe(2 + 3);
    expect(b.status().problem).toBe(true);
  });

  it('a version in parts keeps its meta, and no such version is null', async () => {
    const link = new FakeLink('d-1');
    const meta = { id: 'v', pageId: 'p', createdAt: 1, reason: 'manual', actor: 'user', title: 'T', wordCount: 1 };
    const text = JSON.stringify({ type: 'doc' });
    link.answer = (_m, p) => (p['versionId'] === 'gone' ? refused('not_found') : !p['cursor'] ? { meta, part: text.slice(0, 3), next: 'x' } : { meta, part: text.slice(3), next: null });
    const b = backend(link);
    expect(await b.version('v')).toEqual({ ...meta, doc: { type: 'doc' } });
    expect(await b.version('gone')).toBeNull();
    expect(b.status().problem).toBe(false);
  });

  it('versionAsOf asks which, then reads it. None is null with no second call', async () => {
    const link = new FakeLink('d-1');
    const meta = { id: 'v', pageId: 'p', createdAt: 1, reason: 'day_end', actor: 'user', title: '', wordCount: 0 };
    link.answer = (m) => (m === 'notebook.version.asOf' ? { versionId: 'v' } : { meta, part: '{"type":"doc"}', next: null });
    const b = backend(link);
    expect((await b.versionAsOf('p', '2026-11-07'))?.id).toBe('v');
    expect(link.of('notebook.version.asOf')[0]?.params).toEqual({ pageId: 'p', day: '2026-11-07' });
    const none = new FakeLink('d-1');
    none.answer = () => ({ versionId: null });
    expect(await backend(none).versionAsOf('p', '2026-11-07')).toBeNull();
    expect(none.of('notebook.version.get')).toEqual([]);
  });

  it('the rest map as the contract says', async () => {
    const link = new FakeLink('d-1');
    link.answer = (m) => ({ 'notebook.version.list': { versions: ['v'] }, 'notebook.activity': { rows: ['r'] }, 'notebook.activity.days': { days: ['d'] }, 'notebook.search': { hits: ['h'] } })[m];
    const b = backend(link);
    expect(await b.versions('p')).toEqual(['v']);
    expect(await b.activity('a', 'b')).toEqual(['r']);
    expect(await b.activeDays()).toEqual(['d']);
    expect(await b.search('word', { notebookId: 'n', limit: 3 })).toEqual(['h']);
    expect(link.of('notebook.search')[0]?.params).toEqual({ query: 'word', notebookId: 'n', limit: 3 });
    expect(link.of('notebook.activity')[0]?.params).toEqual({ fromDay: 'a', toDay: 'b' });
    expect(await b.search('  ')).toEqual([]);
    expect(link.of('notebook.search')).toHaveLength(1);
    // Labels alone are a search: the desk lists those pages.
    await b.search('', { labels: ['green'] });
    expect(link.of('notebook.search')[1]?.params).toEqual({ query: '', labels: ['green'] });
  });

  it('a read that fails says so, unless the link already does', async () => {
    const link = new FakeLink('d-1');
    link.answer = () => refused('unavailable', { reason: 'notebook' });
    const b = backend(link);
    await expect(b.versions('p')).rejects.toBeTruthy();
    expect(b.status().problem).toBe(true);
    const down = new FakeLink('d-1');
    down.state = 'retrying';
    const c = backend(down);
    await expect(c.versions('p')).rejects.toBeInstanceOf(DeskNotConnected);
    expect(c.status().problem).toBe(false);
  });
});

let deskCount = 0;
const newDesk = (): string => `d-collab-${(deskCount += 1)}-${Date.now()}`;

/** A desk with one page in it, and text already stored. */
async function deskWithPage(id: string, text = ''): Promise<{ pageId: string; desk: ReturnType<typeof mockDesk> }> {
  const desk = mockDesk(id);
  await desk.local.ready();
  const { page } = await desk.local.createNotebook('N');
  if (text) {
    const session = desk.local.openPage(page.id);
    await session.ready;
    session.doc.getText('stored').insert(0, text);
  }
  return { pageId: page.id, desk };
}

const textOf = (doc: Y.Doc, field = 'typed'): string => doc.getText(field).toString();

// First of what opens pages: the guard is one for the whole tab, and a page refused below stays unsaved for good.
describe('the browser\'s prompt on leaving', () => {
  const leaving = (): { prevented: boolean } => {
    const e = new Event('beforeunload', { cancelable: true });
    windowEvents.dispatchEvent(e);
    return { prevented: e.defaultPrevented };
  };

  it('asks only while text is not on its desk, on every desk', async () => {
    const id = newDesk();
    const { pageId, desk } = await deskWithPage(id);
    const link = new FakeLink(id, true);
    const b = backend(link);
    expect(leaving().prevented).toBe(false);
    const session = b.openPage(pageId);
    await session.ready;
    expect(leaving().prevented).toBe(false); // opening a page is not typing, while the first sync is still counted as unsynced
    link.drop();
    session.doc.getText('typed').insert(0, 'unsaved');
    expect(leaving().prevented).toBe(true);
    session.close();
    expect(leaving().prevented).toBe(true); // closed, but still only here
    link.back();
    const server = await desk.page(pageId);
    await until(() => textOf(server.doc) === 'unsaved');
    await until(() => !leaving().prevented);
  });
});

describe('page text', () => {
  it('ready resolves only once the stored content is applied', async () => {
    const id = newDesk();
    const { pageId } = await deskWithPage(id, 'stored words');
    const link = new FakeLink(id, true);
    const session = backend(link).openPage(pageId);
    expect(textOf(session.doc, 'stored')).toBe(''); // and the editor isn't drawn yet
    await session.ready;
    expect(textOf(session.doc, 'stored')).toBe('stored words');
    session.close();
  });

  it("a Guild Desk's page has awareness for the editor's carets, and a member's own desk has none", async () => {
    const id = newDesk();
    const { pageId } = await deskWithPage(id);
    const guild = backend(new FakeLink(id, true), { presenceName: 'Ana' }).openPage(pageId);
    await guild.ready;
    expect(guild.awareness?.getLocalState()).toMatchObject({ user: { name: 'Ana' } });
    guild.close();
    const own = backend(new FakeLink(id, true)).openPage(pageId);
    await own.ready;
    expect(own.awareness).toBeUndefined();
    own.close();
  });

  it('opens with a token and the page id as the name: what the desk needs and nothing more', async () => {
    const id = newDesk();
    const { pageId } = await deskWithPage(id);
    const link = new FakeLink(id, true);
    const session = backend(link).openPage(pageId);
    await session.ready;
    expect(link.channel.sizes.length).toBeGreaterThan(0);
    // The token says this build's page schema, and nothing else (ADR 0091's guard).
    expect(mockNotebookControl.tokens).toEqual(['schema=2']);
    session.close();
  });

  it("an older app's change refused by the desk (reload): read-only, the line says reload, and the text stays to copy", async () => {
    const id = newDesk();
    const { pageId, desk } = await deskWithPage(id);
    const link = new FakeLink(id, true);
    const b = backend(link);
    const session = b.openPage(pageId);
    await session.ready;
    const readOnly: boolean[] = [];
    session.onReadOnly?.((r) => readOnly.push(r));
    mockNotebookControl.outdatedPages = [pageId];
    session.doc.getText('typed').insert(0, 'typed before the reload');
    await until(() => b.status().outdated);
    expect(readOnly).toEqual([false, true]);
    expect(b.status().full).toBe(false);
    expect(textOf(session.doc)).toBe('typed before the reload');
    expect(textOf((await desk.page(pageId)).doc)).toBe('');
    expect(b.hasUnsavedText()).toBe(true);
    const late: boolean[] = [];
    session.onReadOnly?.((r) => late.push(r));
    expect(late).toEqual([true]);
  });

  it("a quiet page keeps its socket: the desk sends no pings, so the provider's 30 s check for silence is pushed out of the way", async () => {
    const id = newDesk();
    const { pageId } = await deskWithPage(id);
    const link = new FakeLink(id, true);
    const b = backend(link);
    const session = b.openPage(pageId);
    await session.ready;
    // lib0 holds its own Date.now, so no fake clock reaches the check. What it's set to is what it does.
    const socket = (b as unknown as { socket: { configuration: { messageReconnectTimeout: number } } }).socket;
    expect(socket.configuration.messageReconnectTimeout).toBeGreaterThanOrEqual(60 * 60_000);
    // And its check runs every tenth of that, which a setInterval can still hold.
    expect(socket.configuration.messageReconnectTimeout / 10).toBeLessThan(2 ** 31);
    session.close();
  });

  it('typed text reaches the desk, and nothing is left unsaved', async () => {
    const id = newDesk();
    const { pageId, desk } = await deskWithPage(id);
    const link = new FakeLink(id, true);
    const b = backend(link);
    const session = b.openPage(pageId);
    await session.ready;
    session.doc.getText('typed').insert(0, 'hello');
    expect(b.hasUnsavedText()).toBe(true);
    const server = await desk.page(pageId);
    await until(() => textOf(server.doc) === 'hello');
    await until(() => !b.hasUnsavedText());
    expect(b.status().unsaved).toBe(false);
    session.close();
  });

  it('the link dropping while typing: the text stays, it says so, nothing is sent, and it all arrives when the link returns', async () => {
    const id = newDesk();
    const { pageId, desk } = await deskWithPage(id);
    const link = new FakeLink(id, true);
    const b = backend(link);
    const session = b.openPage(pageId);
    await session.ready;
    session.doc.getText('typed').insert(0, 'before ');
    const server = await desk.page(pageId);
    await until(() => textOf(server.doc) === 'before ');
    await until(() => !b.hasUnsavedText());

    link.drop();
    session.doc.getText('typed').insert(7, 'during');
    expect(textOf(session.doc)).toBe('before during');
    expect(b.hasUnsavedText()).toBe(true);
    await until(() => b.status().unsaved); // the quiet line, after a moment's silence
    await new Promise((done) => setTimeout(done, 60));
    expect(textOf(server.doc)).toBe('before '); // it hasn't gone anywhere, and it isn't pretended that it has

    link.back();
    await until(() => textOf(server.doc) === 'before during');
    await until(() => !b.hasUnsavedText());
    expect(b.status().unsaved).toBe(false);
    session.close();
  });

  it('{"t":"reset"}: the provider reconnects by its own backoff and resends what the desk lacks', async () => {
    const id = newDesk();
    const { pageId, desk } = await deskWithPage(id);
    const link = new FakeLink(id, true);
    const b = backend(link);
    const session = b.openPage(pageId);
    await session.ready;
    link.channel.deaf = true; // the service is gone and the message with it
    session.doc.getText('typed').insert(0, 'kept');
    await flushed();
    link.channel.deaf = false;
    link.channel.reset();
    const server = await desk.page(pageId);
    await until(() => textOf(server.doc) === 'kept');
    await until(() => !b.hasUnsavedText());
    session.close();
  });

  it('an open page exports what is on screen, with the link up or not: nothing is asked of the desk', async () => {
    const id = newDesk();
    const { pageId } = await deskWithPage(id);
    const link = new FakeLink(id, true);
    const b = backend(link);
    const session = b.openPage(pageId);
    await session.ready;
    const before = link.of('notebook.page.content').length;
    expect((await b.pageContent(pageId)).type).toBe('doc');
    link.drop();
    expect((await b.pageContent(pageId)).type).toBe('doc');
    expect(link.of('notebook.page.content')).toHaveLength(before);
    link.back();
    session.close();
  });

  it('a page closed with unsaved text is held: open again it has it, and once the desk does, it goes', async () => {
    const id = newDesk();
    const { pageId, desk } = await deskWithPage(id);
    const link = new FakeLink(id, true);
    const b = backend(link);
    const first = b.openPage(pageId);
    await first.ready;
    link.drop();
    first.doc.getText('typed').insert(0, 'unsaved');
    first.close();
    expect(b.hasUnsavedText()).toBe(true);

    const again = b.openPage(pageId);
    await again.ready;
    expect(again.doc).toBe(first.doc);
    expect(textOf(again.doc)).toBe('unsaved');
    again.close();

    link.back();
    const server = await desk.page(pageId);
    await until(() => textOf(server.doc) === 'unsaved');
    await until(() => !b.hasUnsavedText());
    const entries = (b as unknown as { entries: Map<string, unknown> }).entries;
    await until(() => entries.size === 0);
  });

  it('two sessions of one page share one doc and one provider, and it ends with the last', async () => {
    const id = newDesk();
    const { pageId } = await deskWithPage(id);
    const b = backend(new FakeLink(id, true));
    const one = b.openPage(pageId);
    const two = b.openPage(pageId);
    await one.ready;
    expect(two.doc).toBe(one.doc);
    const entries = (b as unknown as { entries: Map<string, unknown> }).entries;
    one.close();
    one.close(); // twice does nothing
    expect(entries.size).toBe(1);
    two.close();
    expect(entries.size).toBe(0);
  });

  it('two tabs of the same page converge, nothing lost', async () => {
    const id = newDesk();
    const { pageId } = await deskWithPage(id);
    const a = backend(new FakeLink(id, true)).openPage(pageId);
    const c = backend(new FakeLink(id, true)).openPage(pageId);
    await Promise.all([a.ready, c.ready]);
    a.doc.getText('typed').insert(0, 'from a. ');
    c.doc.getText('typed').insert(0, 'from c. ');
    await until(() => textOf(a.doc) === textOf(c.doc) && textOf(a.doc).length === 16);
    expect(textOf(a.doc)).toContain('from a.');
    expect(textOf(a.doc)).toContain('from c.');
    a.close();
    c.close();
  });

  it('page_full: said plainly, the editor stops taking text, the page keeps what it has, and other pages carry on', async () => {
    const id = newDesk();
    const { pageId, desk } = await deskWithPage(id);
    const other = (await desk.local.createPage(desk.local.tree().notebooks[0] ? (Object.keys(desk.local.tree().pages)[0] as string) : '')).id;
    const link = new FakeLink(id, true);
    const b = backend(link);
    const session = b.openPage(pageId);
    const second = b.openPage(other);
    await Promise.all([session.ready, second.ready]);
    const readOnly: boolean[] = [];
    session.onReadOnly?.((r) => readOnly.push(r));
    expect(readOnly).toEqual([false]);
    mockNotebookControl.fullPages = [pageId];
    session.doc.getText('typed').insert(0, 'one word too many');
    await until(() => b.status().full);
    expect(readOnly).toEqual([false, true]);
    expect(textOf(session.doc)).toBe('one word too many'); // still on screen to copy
    const server = await desk.page(pageId);
    expect(textOf(server.doc)).toBe('');
    expect(b.hasUnsavedText()).toBe(true); // leaving warns

    second.doc.getText('typed').insert(0, 'fine');
    const otherServer = await desk.page(other);
    await until(() => textOf(otherServer.doc) === 'fine');
    second.close();
    // Later arrivals are told straight away, too: `onReadOnly` calls back with where it stands.
    const late: boolean[] = [];
    session.onReadOnly?.((r) => late.push(r));
    expect(late).toEqual([true]);
  });

  it('never sends a message over 4 MiB: the session stays up, it says so, and a smaller sync later clears it', async () => {
    const id = newDesk();
    const { pageId, desk } = await deskWithPage(id);
    const link = new FakeLink(id, true);
    const b = backend(link);
    const session = b.openPage(pageId);
    await session.ready;
    const send = vi.spyOn(link.channel, 'send');
    session.doc.getText('typed').insert(0, 'x'.repeat(MAX_COLLAB_MESSAGE + 1024));
    await until(() => b.status().tooLarge);
    expect(send.mock.calls.every(([bytes]) => bytes.length <= MAX_COLLAB_MESSAGE)).toBe(true);
    expect(link.state).toBe('open');
    expect(b.hasUnsavedText()).toBe(true);
    const server = await desk.page(pageId);
    expect(textOf(server.doc)).toBe('');

    // It stays held for as long as it can't go: every retry is refused the same way, and the session stays up.
    await new Promise((done) => setTimeout(done, 120));
    expect(b.status().tooLarge).toBe(true);
    expect(link.state).toBe('open');
    expect(send.mock.calls.every(([bytes]) => bytes.length <= MAX_COLLAB_MESSAGE)).toBe(true);

    // What's left to send has come within the limit, as if the desk took the rest some other way: the next try goes.
    Y.applyUpdate(server.doc, Y.encodeStateAsUpdate(session.doc));
    await until(() => !b.status().tooLarge);
    await until(() => !b.hasUnsavedText());
    session.close();
  });
});

describe('one backend per desk', () => {
  it('one per link, and a desk has only its own', async () => {
    const one = new FakeLink(newDesk(), true);
    const two = new FakeLink(newDesk(), true);
    expect(backendFor(one as unknown as DeskLink)).toBe(backendFor(one as unknown as DeskLink));
    expect(backendFor(two as unknown as DeskLink)).not.toBe(backendFor(one as unknown as DeskLink));

    const a = await deskWithPage(one.deskId);
    const b = await deskWithPage(two.deskId);
    const onOne = backend(one).openPage(a.pageId);
    const onTwo = backend(two).openPage(b.pageId);
    await Promise.all([onOne.ready, onTwo.ready]);
    onOne.doc.getText('typed').insert(0, 'only here');
    const server = await a.desk.page(a.pageId);
    await until(() => textOf(server.doc) === 'only here');
    const serverTwo = await b.desk.page(b.pageId);
    expect(textOf(serverTwo.doc)).toBe('');
    expect(a.pageId).not.toBe(b.pageId);
    onOne.close();
    onTwo.close();
  });
});
