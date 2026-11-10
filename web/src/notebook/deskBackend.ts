// `NotebookBackend` on one desk, over that desk's link (API.md section 13). The notes live on the desk: nothing here writes note
// text to browser storage, and page text stays only in the open tab's memory until the desk has it. One of these per link, so
// nothing crosses between desks.
//
// Structure is RPC, last writer wins. The `notebook.tree` topic only says a `rev`, and a newer one means read the tree again.
// Page text is one `HocuspocusProvider` per open page on one virtual WebSocket (`collabSocket.ts`).
//
// A page closed with text the desk hasn't confirmed stays held here, provider and all, until it has. So leaving a page, or
// closing the window, while the link is down loses nothing, and opening that page again finds what was typed.
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { NotebookBackend, PageSession } from '../../notebook/src/model/backend.ts';
import { DOC_FIELD, type PMNode } from '../../notebook/src/model/schema.ts';
import { buildTree } from '../../notebook/src/model/tree.ts';
import type { ActivityRow, NotebookRec, PageRec, SearchHit, SearchOptions, TabColor, TabRec, Tree, Version, VersionMeta } from '../../notebook/src/model/types.ts';
import { DeskNotConnected, type DeskLink, type DeskRpc } from '../desk/deskLink';
import { uuidv7 } from '../desk/idem';
import { backoffMs } from '../desk/rtc/backoff';
import { collabSocketClass } from './collabSocket';

export type NotebookLoad = 'loading' | 'ready' | 'missing' | 'unavailable';

/** What the window says. A new object only when something it shows changes, so typing renders nothing. */
export interface NotebookStatus {
  load: NotebookLoad;
  /** Text has waited over `UNSAVED_AFTER_MS` for the desk to confirm it. */
  unsaved: boolean;
  /** An open page is full: the desk keeps what it has, and takes no more of it. */
  full: boolean;
  /** An open page holds more than can go at once, so it isn't saved yet. */
  tooLarge: boolean;
  /** A change or a read came back with no answer worth trusting. */
  problem: boolean;
}

export interface DeskBackendOptions {
  /** The member's time zone, for the desk's days. */
  timeZone?: () => string;
  /** Per-desk settings that aren't note text. */
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null;
  /** How long a change waits for a desk that's away before it's said to have failed. */
  giveUpMs?: number;
  unsavedAfterMs?: number;
  retryMs?: readonly number[];
  socketIdleMs?: number;
  tooLargeRetryMs?: number;
  /** The provider's own backoff starts here. It doubles to 30 s, with jitter. */
  reconnectMs?: number;
  /**
   * A Guild Desk's shared Notebook (task 48): this member's name, sent as Hocuspocus awareness on each open page, and others'
   * names heard back, for "Here now". Left out on a member's own desk, where nobody else is, so no awareness goes at all.
   */
  presenceName?: string;
}

/** At most this many characters of a name another member's browser says, which is only their say. */
const PRESENCE_NAME_MAX = 40;

const UNSAVED_AFTER_MS = 2_000;
/** A change waits this long through a restart or a dropped link, with the same `idem`. */
const GIVE_UP_MS = 30_000;
const RETRY_MAX_MS = 5_000;
const LOST_REPLY_RETRIES = 2;
/** `unavailable` on the first read of the tree: calm, and never a storm. */
const LOAD_RETRY_MS = [2_000, 5_000, 10_000, 20_000, 30_000] as const;
/** The one thing that could hold up opening: at most this, and it never fails anything. */
const TIME_ZONE_WAIT_MS = 1_500;
const SOCKET_IDLE_MS = 60_000;
const TOO_LARGE_RETRY_MS = 30_000;
const RECONNECT_MS = 1_000;
/**
 * The provider closes a socket it's heard nothing on for this long. The desk sends no pings and, with no carets here, nothing
 * while a page is quiet, so at its 30 s default an open page would reconnect and sync again every half minute. Liveness is the
 * link's: a session that ends, or `{"t":"reset"}`, closes the socket at once (API.md section 13).
 */
const QUIET_SOCKET_MS = 24 * 60 * 60 * 1000;
/** `deskd` has already authenticated the session: the contract's "any non-empty string". */
const TOKEN = 'desk';
/** Never dialled: `collabSocketClass` is what connects, and it goes over the link. */
const NO_URL = 'wss://desk.invalid/collab';

const codeOf = (err: unknown): string => (err as { code?: string } | null)?.code ?? '';
const detailsOf = (err: unknown): Record<string, unknown> => (err as { details?: Record<string, unknown> } | null)?.details ?? {};
/** A mutation went to the desk and no answer came. The same key only replays this (API.md section 13), so it isn't sent again. */
const mayHaveApplied = (err: unknown): boolean => codeOf(err) === 'unavailable' && detailsOf(err)['mayHaveApplied'] === true;
/** A long read's snapshot on the desk lasts 60 s, four to a session. One that's gone means start that read again. */
const cursorGone = (err: unknown): boolean => codeOf(err) === 'bad_request' && detailsOf(err)['reason'] === 'cursor';
const CURSOR_RESTARTS = 2;
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const emptyTree = (): Tree => buildTree([], [], []);

interface OpenPage {
  pageId: string;
  doc: Y.Doc;
  provider: HocuspocusProvider;
  ready: Promise<void>;
  /** How many sessions hold it. At 0 it's kept only while `dirty`. */
  refs: number;
  /** Something typed here that the desk hasn't confirmed. */
  dirty: boolean;
  full: boolean;
  tooLarge: boolean;
  /** The stored content has been applied, so this doc is the page, whether or not the link is up right now. */
  loaded: boolean;
  /** `forceSync` has gone out after a message too large to send, and its answer decides. */
  verifying: boolean;
  tooLargeTimer: ReturnType<typeof setTimeout> | null;
  unsavedTimer: ReturnType<typeof setTimeout> | null;
  unsavedLong: boolean;
  readOnlyListeners: Set<(readOnly: boolean) => void>;
  /** Who else has this page open, on a Guild Desk's Notebook. Null on a member's own desk. */
  awareness: Awareness | null;
}

/** A `beforeunload` guard shared by every desk: the browser's own prompt, only while text isn't on its desk. */
const dirtyDesks = new Set<DeskBackend>();
function onBeforeUnload(e: BeforeUnloadEvent): void {
  for (const backend of dirtyDesks) {
    if (backend.hasUnsavedText()) {
      e.preventDefault();
      e.returnValue = ''; // what older browsers need
      return;
    }
  }
}
function setGuard(backend: DeskBackend, on: boolean): void {
  if (typeof window === 'undefined') return;
  const before = dirtyDesks.size;
  if (on) dirtyDesks.add(backend);
  else dirtyDesks.delete(backend);
  if (!before && dirtyDesks.size) window.addEventListener('beforeunload', onBeforeUnload);
  else if (before && !dirtyDesks.size) window.removeEventListener('beforeunload', onBeforeUnload);
}

function browserStorage(): DeskBackendOptions['storage'] {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export class DeskBackend implements NotebookBackend {
  private readonly link: DeskLink;
  private readonly giveUpMs: number;
  private readonly unsavedAfterMs: number;
  private readonly retryMs: readonly number[];
  private readonly socketIdleMs: number;
  private readonly tooLargeRetryMs: number;
  private readonly reconnectMs: number;
  private readonly timeZone: () => string;
  private readonly storage: NonNullable<DeskBackendOptions['storage']> | null;

  private notebooks = new Map<string, NotebookRec>();
  private tabs = new Map<string, TabRec>();
  private pages = new Map<string, PageRec>();
  private current: Tree = emptyTree();
  private rev: number | null = null;
  /** Bumps on each change this tab makes, so a read begun before it can't overwrite it. */
  private gen = 0;
  private fetching: Promise<void> | null = null;
  private again = false;

  private statusNow: NotebookStatus = { load: 'loading', unsaved: false, full: false, tooLarge: false, problem: false };
  private readonly statusListeners = new Set<() => void>();
  private readonly treeListeners = new Set<() => void>();
  private offTopic: (() => void) | null = null;
  /** The window is open and can be seen. Nothing here polls or reads the tree otherwise. */
  private active = false;
  private staleWhileAway = false;
  private loading = false;
  private loadAttempt = 0;
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly readyPromise: Promise<void>;
  private resolveReady: () => void = () => {};

  private readonly entries = new Map<string, OpenPage>();
  private socket: HocuspocusProviderWebsocket | null = null;
  private socketTimer: ReturnType<typeof setTimeout> | null = null;

  private presenceName: string | null;
  private presenceNow: readonly string[] = [];
  private readonly presenceListeners = new Set<() => void>();

  constructor(link: DeskLink, options: DeskBackendOptions = {}) {
    this.link = link;
    this.presenceName = options.presenceName ?? null;
    this.giveUpMs = options.giveUpMs ?? GIVE_UP_MS;
    this.unsavedAfterMs = options.unsavedAfterMs ?? UNSAVED_AFTER_MS;
    this.retryMs = options.retryMs ?? LOAD_RETRY_MS;
    this.socketIdleMs = options.socketIdleMs ?? SOCKET_IDLE_MS;
    this.tooLargeRetryMs = options.tooLargeRetryMs ?? TOO_LARGE_RETRY_MS;
    this.reconnectMs = options.reconnectMs ?? RECONNECT_MS;
    this.timeZone = options.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    this.storage = (options.storage === undefined ? browserStorage() : options.storage) ?? null;
    this.readyPromise = new Promise((done) => (this.resolveReady = done));
    link.onStatus((state) => {
      if (state === 'open') this.linkOpened();
    });
  }

  // ---------------------------------------------------------------- what the window watches

  readonly status = (): NotebookStatus => this.statusNow;

  readonly onStatus = (fn: () => void): (() => void) => {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  };

  // ---------------------------------------------------------------- who else is here (a Guild Desk's only)

  /** Others' names on the pages open here, in order, each once. The same array until it changes, so nothing renders for nothing. */
  readonly presence = (): readonly string[] => this.presenceNow;

  readonly onPresence = (fn: () => void): (() => void) => {
    this.presenceListeners.add(fn);
    return () => this.presenceListeners.delete(fn);
  };

  /** deskd's word on this member's name came after the pages opened. */
  setPresenceName(name: string): void {
    if (this.presenceName === null || this.presenceName === name) return;
    this.presenceName = name;
    for (const e of this.entries.values()) e.awareness?.setLocalStateField('user', { name });
  }

  private presenceChanged(): void {
    const names = new Set<string>();
    for (const e of this.entries.values()) {
      if (!e.awareness || e.refs <= 0) continue;
      for (const [client, state] of e.awareness.getStates()) {
        if (client === e.awareness.clientID) continue;
        const name = (state as { user?: { name?: unknown } } | undefined)?.user?.name;
        if (typeof name === 'string' && name.trim()) names.add(Array.from(name.trim()).slice(0, PRESENCE_NAME_MAX).join(''));
      }
    }
    const next = [...names].sort((a, b) => a.localeCompare(b));
    if (next.length === this.presenceNow.length && next.every((n, i) => n === this.presenceNow[i])) return;
    this.presenceNow = next;
    for (const fn of this.presenceListeners) fn();
  }

  /** The window is open and on screen, or it isn't. A window parked behind another desk asks nothing. */
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (!active) {
      this.clearLoadTimer();
      return;
    }
    if (this.statusNow.load !== 'ready') void this.load();
    else if (this.staleWhileAway) void this.refetch().catch(() => {});
    this.staleWhileAway = false;
  }

  /** Whether leaving the page now would lose text. */
  hasUnsavedText(): boolean {
    for (const e of this.entries.values()) if (e.dirty) return true;
    return false;
  }

  private patchStatus(p: Partial<NotebookStatus>): void {
    const next = { ...this.statusNow, ...p };
    if ((Object.keys(next) as (keyof NotebookStatus)[]).every((k) => next[k] === this.statusNow[k])) return;
    this.statusNow = next;
    for (const fn of this.statusListeners) fn();
  }

  // ---------------------------------------------------------------- the tree

  ready(): Promise<void> {
    if (this.statusNow.load !== 'ready') void this.load();
    return this.readyPromise;
  }

  tree(): Tree {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.treeListeners.add(listener);
    this.offTopic ??= this.link.subscribe('notebook.tree', (m) => this.heardRev(m.rev));
    return () => {
      this.treeListeners.delete(listener);
      if (!this.treeListeners.size) {
        this.offTopic?.();
        this.offTopic = null;
      }
    };
  }

  private heardRev(rev: number): void {
    if (this.rev !== null && rev <= this.rev) return;
    if (!this.active) {
      this.staleWhileAway = true;
      return;
    }
    void this.refetch().catch(() => {}); // the next `rev` or the next session asks again
  }

  private linkOpened(): void {
    // A new session may be a new deskd, a new service, or a desk that's moved on while this one was away.
    this.rev = null;
    if (!this.active) {
      this.staleWhileAway = true;
      return;
    }
    if (this.statusNow.load !== 'ready') {
      this.loadAttempt = 0;
      void this.load();
    } else {
      void this.refetch().catch(() => {});
    }
  }

  private clearLoadTimer(): void {
    if (this.loadTimer) clearTimeout(this.loadTimer);
    this.loadTimer = null;
  }

  private async load(): Promise<void> {
    if (this.loading || this.statusNow.load === 'ready') return;
    this.loading = true;
    this.clearLoadTimer();
    try {
      await this.refetch();
      await Promise.race([this.sendTimeZone(), sleep(TIME_ZONE_WAIT_MS)]);
      this.patchStatus({ load: 'ready' });
      this.resolveReady();
    } catch (err) {
      if (codeOf(err) === 'not_found') {
        this.patchStatus({ load: 'missing' }); // final until the next session, which `linkOpened` asks on
      } else if (err instanceof DeskNotConnected) {
        this.patchStatus({ load: 'loading' }); // the link's own state says what's wrong, and its return asks again
      } else {
        this.patchStatus({ load: 'unavailable' });
        if (this.active) {
          const wait = this.retryMs[Math.min(this.loadAttempt, this.retryMs.length - 1)] ?? 30_000;
          this.loadAttempt += 1;
          this.loadTimer = setTimeout(() => void this.load(), wait);
        }
      }
    } finally {
      this.loading = false;
    }
  }

  /** The whole tree, in pages. Read again once if a change landed meanwhile. A failure leaves the last tree where it is. */
  private refetch(): Promise<void> {
    if (this.fetching) {
      this.again = true;
      return this.fetching;
    }
    this.fetching = (async () => {
      try {
        do {
          this.again = false;
          const gen = this.gen;
          const read = await this.readTree();
          if (gen !== this.gen) this.again = true; // something this tab did landed during the read
          else this.adopt(read);
        } while (this.again);
      } finally {
        this.fetching = null;
      }
    })();
    return this.fetching;
  }

  private async readTree(): Promise<{ notebooks: Map<string, NotebookRec>; tabs: Map<string, TabRec>; pages: Map<string, PageRec>; rev: number }> {
    const notebooks = new Map<string, NotebookRec>();
    const tabs = new Map<string, TabRec>();
    const pages = new Map<string, PageRec>();
    let cursor: string | null = null;
    let rev: number | null = null;
    do {
      const part: DeskRpc['notebook.tree'] = await this.link.call('notebook.tree', cursor ? { cursor } : {});
      // The first page's: a change during the rest will say a newer one, and that reads it all again.
      rev ??= part.rev;
      for (const n of part.notebooks) notebooks.set(n.id, n);
      for (const t of part.tabs) tabs.set(t.id, t);
      for (const p of part.pages) pages.set(p.id, p);
      cursor = part.next;
    } while (cursor);
    return { notebooks, tabs, pages, rev: rev ?? 0 };
  }

  private adopt(read: { notebooks: Map<string, NotebookRec>; tabs: Map<string, TabRec>; pages: Map<string, PageRec>; rev: number }): void {
    this.notebooks = read.notebooks;
    this.tabs = read.tabs;
    this.pages = read.pages;
    this.rev = read.rev;
    this.publishTree();
  }

  private publishTree(): void {
    this.current = buildTree([...this.notebooks.values()], [...this.tabs.values()], [...this.pages.values()]);
    for (const fn of this.treeListeners) fn();
  }

  /** What an answer already says, at once, so the page a create returned is there for the caller to select. */
  private merge(records: { notebook?: NotebookRec; tab?: TabRec; page?: PageRec }): void {
    this.gen += 1;
    if (records.notebook) this.notebooks.set(records.notebook.id, records.notebook);
    if (records.tab) this.tabs.set(records.tab.id, records.tab);
    if (records.page) this.pages.set(records.page.id, records.page);
    this.publishTree();
  }

  /**
   * Every mutation ends here: the desk's word on the whole tree, as the change can have moved other rows. A create doesn't wait
   * for it: its answer is already in the tree (`merge`), and the caller is about to put the member's focus on what it made, a
   * page's Title or a tab's name. Waiting would cost a second round trip in which the first keys typed go nowhere.
   */
  private async settle(): Promise<void> {
    this.gen += 1;
    await this.refetch().catch(() => {}); // the next `rev` or the next session asks again
  }

  private async sendTimeZone(): Promise<void> {
    const zone = this.timeZone();
    const key = `ma.notebook.tz.${this.link.deskId}`;
    if (!zone || this.remembered(key) === zone) return;
    try {
      await this.mutate('notebook.settings.set', { timeZone: zone }, true);
      this.remember(key, zone);
    } catch (err) {
      // An unknown zone stays unknown, so it isn't asked again. Anything else waits for the next load.
      if (codeOf(err) === 'bad_request') this.remember(key, zone);
    }
  }

  private remembered(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private remember(key: string, value: string): void {
    try {
      this.storage?.setItem(key, value);
    } catch {
      // Private mode or storage off: it's sent again next time, which does no harm.
    }
  }

  // ---------------------------------------------------------------- calls

  /**
   * One thing the member did keeps one `idem` across every retry, so it's never done twice (API.md section 4). `unavailable` with
   * `mayHaveApplied` isn't retried: the same key only replays it, and a new key could do it twice. The tree says what happened.
   */
  private async mutate<M extends keyof DeskRpc>(method: M, params: Record<string, unknown>, quiet = false): Promise<DeskRpc[M]> {
    const idem = uuidv7();
    const started = Date.now();
    let attempt = 0;
    let lost = 0;
    for (;;) {
      try {
        const reply = await this.link.call(method, params, { idem });
        if (!quiet) this.patchStatus({ problem: false });
        return reply;
      } catch (err) {
        const left = this.giveUpMs - (Date.now() - started);
        const code = codeOf(err);
        if (err instanceof DeskNotConnected && left > 0) {
          await this.linkBack(left);
        } else if (code === 'unavailable' && !mayHaveApplied(err) && left > 0) {
          // Nothing was done, and the same key runs it next time.
          await sleep(Math.min(backoffMs(attempt), RETRY_MAX_MS, left));
          attempt += 1;
        } else if ((code === 'deadline_exceeded' || code === 'cancelled') && lost < LOST_REPLY_RETRIES) {
          lost += 1;
        } else {
          if (!quiet) this.patchStatus({ problem: true });
          void this.refetch().catch(() => {}); // it may have happened: show what the desk says
          throw err;
        }
      }
    }
  }

  private linkBack(ms: number): Promise<void> {
    if (this.link.status() === 'open') return sleep(Math.min(backoffMs(0), ms));
    return new Promise((done) => {
      const finish = (): void => {
        clearTimeout(timer);
        off();
        done();
      };
      const timer = setTimeout(finish, ms);
      const off = this.link.onStatus((state) => {
        if (state === 'open') finish();
      });
    });
  }

  /** A read isn't worth waiting for: the view it's for says nothing rather than something stale. */
  private async read<M extends keyof DeskRpc>(method: M, params: Record<string, unknown>): Promise<DeskRpc[M]> {
    try {
      const reply = await this.link.call(method, params);
      this.patchStatus({ problem: false });
      return reply;
    } catch (err) {
      if (!(err instanceof DeskNotConnected) && !cursorGone(err)) this.patchStatus({ problem: true });
      throw err;
    }
  }

  /** A page or version's JSON can pass the 1 MiB of one reply, so it comes as text in parts, from one snapshot on the desk. */
  private async parts<M extends 'notebook.page.content' | 'notebook.version.get'>(method: M, params: Record<string, unknown>): Promise<{ first: DeskRpc[M]; doc: PMNode | null }> {
    for (let restarts = 0; ; restarts += 1) {
      let text = '';
      let cursor: string | null = null;
      let first: DeskRpc[M] | null = null;
      try {
        do {
          const part: DeskRpc[M] = await this.read(method, cursor ? { ...params, cursor } : params);
          first ??= part;
          text += part.part;
          cursor = part.next;
        } while (cursor);
      } catch (err) {
        // Parts from two snapshots could tear the page, so a read whose snapshot has gone starts again from the top.
        if (cursor && cursorGone(err) && restarts < CURSOR_RESTARTS) continue;
        if (cursorGone(err)) this.patchStatus({ problem: true });
        throw err;
      }
      return { first: first as DeskRpc[M], doc: text ? (JSON.parse(text) as PMNode) : null };
    }
  }

  // ---------------------------------------------------------------- structure

  async createNotebook(title?: string): Promise<{ notebook: NotebookRec; tab: TabRec; page: PageRec }> {
    const made = await this.mutate('notebook.notebook.create', title === undefined ? {} : { title });
    this.merge(made);
    void this.settle();
    return made;
  }

  async renameNotebook(id: string, title: string): Promise<void> {
    await this.mutate('notebook.notebook.rename', { id, title });
    await this.settle();
  }

  async createTab(notebookId: string, opts: { title?: string; color?: TabColor } = {}): Promise<{ tab: TabRec; page: PageRec }> {
    const made = await this.mutate('notebook.tab.create', { notebookId, ...opts });
    this.merge(made);
    void this.settle();
    return made;
  }

  async renameTab(id: string, title: string): Promise<void> {
    await this.mutate('notebook.tab.rename', { id, title });
    await this.settle();
  }

  async recolorTab(id: string, color: TabColor): Promise<void> {
    await this.mutate('notebook.tab.recolor', { id, color });
    await this.settle();
  }

  async addTabAtPage(pageId: string, title?: string): Promise<TabRec> {
    const { tab } = await this.mutate('notebook.tab.addAtPage', { pageId, ...(title === undefined ? {} : { title }) });
    this.merge({ tab });
    void this.settle();
    return tab;
  }

  async createPage(tabId: string, opts: { after?: string } = {}): Promise<PageRec> {
    const { page } = await this.mutate('notebook.page.create', { tabId, ...opts });
    this.merge({ page });
    void this.settle();
    return page;
  }

  async movePage(pageId: string, tabId: string, index?: number): Promise<void> {
    await this.mutate('notebook.page.move', { pageId, tabId, ...(index === undefined ? {} : { index }) });
    await this.settle();
  }

  async trashPage(pageId: string): Promise<void> {
    await this.mutate('notebook.page.trash', { pageId });
    await this.settle();
  }

  async restorePage(pageId: string): Promise<void> {
    await this.mutate('notebook.page.restore', { pageId });
    await this.settle();
  }

  // ---------------------------------------------------------------- text

  openPage(pageId: string): PageSession {
    const entry = this.entries.get(pageId) ?? this.attachPage(pageId);
    entry.refs += 1;
    this.statusOfPages();
    if (entry.awareness) this.presenceChanged();
    let closed = false;
    return {
      pageId,
      doc: entry.doc,
      ...(entry.awareness ? { awareness: entry.awareness } : {}),
      ready: entry.ready,
      onReadOnly: (fn) => {
        entry.readOnlyListeners.add(fn);
        fn(entry.full);
        return () => entry.readOnlyListeners.delete(fn);
      },
      close: () => {
        if (closed) return;
        closed = true;
        entry.refs -= 1;
        this.dropIfDone(entry);
        this.statusOfPages();
        if (entry.awareness) this.presenceChanged();
      },
    };
  }

  private ensureSocket(): HocuspocusProviderWebsocket {
    if (this.socketTimer) clearTimeout(this.socketTimer);
    this.socketTimer = null;
    this.socket ??= new HocuspocusProviderWebsocket({
      url: NO_URL,
      WebSocketPolyfill: collabSocketClass(this.link, { onTooLarge: (id) => this.tooLarge(id) }),
      maxAttempts: 0, // for as long as a page is open
      messageReconnectTimeout: QUIET_SOCKET_MS,
      delay: this.reconnectMs,
      minDelay: this.reconnectMs,
    });
    return this.socket;
  }

  private attachPage(pageId: string): OpenPage {
    const doc = new Y.Doc();
    let opened: () => void = () => {};
    const ready = new Promise<void>((done) => (opened = done));
    let entry: OpenPage | null = null;
    // A member's own desk sends no awareness at all, as nobody else is there. A Guild Desk's sends a name (for "Here now") and the
    // caret the editor publishes; the sync service replaces the name with the verified caller's before anyone else hears it.
    const awareness = this.presenceName !== null ? new Awareness(doc) : null;
    if (awareness) {
      awareness.setLocalStateField('user', { name: this.presenceName });
      awareness.on('change', () => this.presenceChanged());
    }
    const provider = new HocuspocusProvider({
      name: pageId,
      document: doc,
      token: TOKEN,
      websocketProvider: this.ensureSocket(),
      awareness,
      onSynced: () => {
        if (entry) entry.loaded = true;
        opened();
      },
    });
    const page: OpenPage = {
      pageId,
      doc,
      provider,
      ready,
      refs: 0,
      dirty: false,
      full: false,
      tooLarge: false,
      loaded: false,
      verifying: false,
      tooLargeTimer: null,
      unsavedTimer: null,
      unsavedLong: false,
      readOnlyListeners: new Set(),
      awareness,
    };
    entry = page;
    doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin === provider) return; // the desk's own news
      this.markDirty(page);
    });
    let last = 0;
    provider.on('unsyncedChanges', ({ number }: { number: number }) => {
      if (number === 0) this.confirmed(page);
      else if (number < last && page.dirty) this.waitForDesk(page); // moving: only silence counts as "not saved yet"
      last = number;
    });
    provider.on('close', ({ event }: { event?: { reason?: string } }) => {
      if (event?.reason !== 'page_full' || page.full) return;
      page.full = true;
      for (const fn of page.readOnlyListeners) fn(true);
      this.statusOfPages();
    });
    this.entries.set(pageId, page);
    setGuard(this, true);
    provider.attach();
    return page;
  }

  private markDirty(entry: OpenPage): void {
    if (!entry.dirty) entry.dirty = true;
    if (!entry.unsavedTimer) this.waitForDesk(entry);
  }

  /** Restarts the wait. Typing costs a timer and no render. */
  private waitForDesk(entry: OpenPage): void {
    if (entry.unsavedTimer) clearTimeout(entry.unsavedTimer);
    entry.unsavedTimer = setTimeout(() => {
      entry.unsavedTimer = null;
      if (!entry.dirty) return;
      entry.unsavedLong = true;
      this.statusOfPages();
    }, this.unsavedAfterMs);
  }

  private confirmed(entry: OpenPage): void {
    if (entry.tooLarge && !entry.verifying) return; // that answer was to something smaller: what didn't go is still here
    entry.verifying = false;
    entry.tooLarge = false;
    entry.dirty = false;
    entry.unsavedLong = false;
    if (entry.unsavedTimer) clearTimeout(entry.unsavedTimer);
    entry.unsavedTimer = null;
    // Not from inside the provider's own event: this can end it.
    queueMicrotask(() => {
      this.dropIfDone(entry);
      this.statusOfPages();
    });
  }

  /** The adapter wouldn't send it. The text is safe here while the tab is open: ask the desk what it lacks again, in a while. */
  private tooLarge(pageId: string): void {
    const entry = this.entries.get(pageId);
    if (!entry) return;
    entry.tooLarge = true;
    entry.verifying = false;
    entry.dirty = true;
    if (entry.tooLargeTimer) clearTimeout(entry.tooLargeTimer);
    entry.tooLargeTimer = setTimeout(() => {
      entry.tooLargeTimer = null;
      if (!entry.tooLarge) return;
      entry.verifying = true;
      entry.provider.forceSync();
    }, this.tooLargeRetryMs);
    this.statusOfPages();
  }

  private dropIfDone(entry: OpenPage): void {
    if (entry.refs > 0 || entry.dirty || this.entries.get(entry.pageId) !== entry) return;
    if (entry.tooLargeTimer) clearTimeout(entry.tooLargeTimer);
    if (entry.unsavedTimer) clearTimeout(entry.unsavedTimer);
    this.entries.delete(entry.pageId);
    entry.provider.destroy();
    entry.awareness?.destroy();
    entry.doc.destroy();
    if (entry.awareness) this.presenceChanged();
    if (this.entries.size) return;
    setGuard(this, false);
    // Paging between notes drops one and opens the next in a moment, so the socket waits to see.
    this.socketTimer = setTimeout(() => {
      this.socketTimer = null;
      if (this.entries.size) return;
      this.socket?.destroy();
      this.socket = null;
    }, this.socketIdleMs);
  }

  /** The window's line, from every page held. Only a page on screen can be full or too large in its words. */
  private statusOfPages(): void {
    let unsaved = false;
    let full = false;
    let tooLarge = false;
    for (const e of this.entries.values()) {
      if (e.unsavedLong) unsaved = true;
      if (e.refs > 0 && e.full) full = true;
      if (e.refs > 0 && e.tooLarge) tooLarge = true;
    }
    this.patchStatus({ unsaved, full, tooLarge });
  }

  async pageContent(pageId: string): Promise<PMNode> {
    // An open page is what the member is looking at, with the link up or not, and the desk stores 2 s behind it.
    const entry = this.entries.get(pageId);
    if (entry?.loaded) return yXmlFragmentToProsemirrorJSON(entry.doc.getXmlFragment(DOC_FIELD)) as PMNode;
    const { doc } = await this.parts('notebook.page.content', { pageId });
    return doc ?? { type: 'doc', content: [] };
  }

  // ---------------------------------------------------------------- history

  async versions(pageId: string): Promise<VersionMeta[]> {
    return (await this.read('notebook.version.list', { pageId })).versions;
  }

  async version(versionId: string): Promise<Version | null> {
    try {
      const { first, doc } = await this.parts('notebook.version.get', { versionId });
      return first.meta && doc ? { ...first.meta, doc } : null;
    } catch (err) {
      if (codeOf(err) === 'not_found') {
        this.patchStatus({ problem: false }); // an answer, and the view says so
        return null;
      }
      throw err;
    }
  }

  async saveVersion(pageId: string, reason?: 'manual' | 'pre_agent'): Promise<VersionMeta | null> {
    const { version } = await this.mutate('notebook.version.save', { pageId, ...(reason ? { reason } : {}) });
    return version;
  }

  async restoreVersion(pageId: string, versionId: string): Promise<void> {
    await this.mutate('notebook.version.restore', { pageId, versionId });
    await this.settle();
  }

  async versionAsOf(pageId: string, day: string): Promise<Version | null> {
    const { versionId } = await this.read('notebook.version.asOf', { pageId, day });
    return versionId ? this.version(versionId) : null;
  }

  // ---------------------------------------------------------------- Temporal view and search

  async activity(fromDay: string, toDay: string): Promise<ActivityRow[]> {
    return (await this.read('notebook.activity', { fromDay, toDay })).rows;
  }

  async activeDays(): Promise<string[]> {
    return (await this.read('notebook.activity.days', {})).days;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    if (!query.trim()) return [];
    return (await this.read('notebook.search', { query, ...opts })).hits;
  }
}

const backends = new WeakMap<DeskLink, DeskBackend>();

/** One per link. It outlives the window, as a page closed with unconfirmed text is still held in it. */
export function backendFor(link: DeskLink, options: Pick<DeskBackendOptions, 'presenceName'> = {}): DeskBackend {
  let backend = backends.get(link);
  if (!backend) {
    backend = new DeskBackend(link, options);
    backends.set(link, backend);
  } else if (options.presenceName) {
    backend.setPresenceName(options.presenceName);
  }
  return backend;
}
