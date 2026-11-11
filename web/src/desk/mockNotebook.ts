// Dev and test only: never in a production bundle (scripts/build-release.mjs checks). A desk's Notebook for `MockDeskLink`, as the
// contract has it (API.md section 13): `notebook.*` on the editor's own `LocalBackend`, in this browser's IndexedDB under a
// mock name, and `collab` as a small server of Hocuspocus's protocol on the same pages. So the app's real `DeskBackend` and the
// real provider run against it: `rtc` and the real desk prove the rest.
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { LocalBackend } from '../../notebook/src/local/localBackend.ts';
import type { PageSession } from '../../notebook/src/model/backend.ts';
import type { PaletteId } from '../../notebook/src/model/colors.ts';
import type { ImportedPage } from '../../notebook/src/model/notebookFile.ts';
import type { TabColor } from '../../notebook/src/model/types.ts';

const MESSAGE = { Sync: 0, Awareness: 1, Auth: 2, Close: 7, SyncStatus: 8, Ping: 9, Pong: 10 } as const;
const SYNC = { Step1: 0, Step2: 1, Update: 2 } as const;
const AUTHENTICATED = 2;
const PING_EVERY_MS = 10_000;
const PART_BYTES = 512 * 1024;
const TREE_PAGE = 1000;
/** `Y.encodeStateAsUpdate` with nothing to say. */
const NOTHING = 2;

/** What a dev or a `shell` test can steer and read, as `window.__maDeskMock.notebook`. */
export interface MockNotebookControl {
  /** Pages per `notebook.tree` reply, and characters per `part`. */
  treePage: number;
  partChars: number;
  /** Every time zone asked for. */
  zones: string[];
  /** The size of every message `collab` carried to the desk, in order. */
  sizes: number[];
  /** How many messages over 4 MiB reached the desk. A real one would close the whole session with 4001. */
  oversize: number;
  /** The server takes messages and confirms none, as a sync service that's stalled. */
  silent: boolean;
  /** Pages the desk refuses to grow, with the provider's close reason `page_full`. */
  fullPages: string[];
  /** Pages whose changes the desk refuses as from an older app (ADR 0091's guard), with the close reason `reload`. */
  outdatedPages: string[];
  /** Each provider's Auth token, in order: the app says its page schema there. */
  tokens: string[];
  /** The next call of each applies, then answers `unavailable` with `mayHaveApplied`, as a restart can, and so does a retry on its key. */
  cutOff: Record<string, boolean>;
  /** Mutations by method, as they ran rather than as they were asked. */
  applied: string[];
  /** The desk's store runs now, as it does 2 s after typing stops. */
  flush(deskId: string): Promise<void>;
  /** What the desk holds of a page right now, as text. */
  pageText(deskId: string, pageId: string): Promise<string>;
  /**
   * A Guild Desk's others on its pages (task 48), by desk: names sent as Hocuspocus awareness to whoever opens a page, again
   * every few seconds, as their browsers would. Members' own awareness passes between sessions on a page, as the real one's does.
   */
  presence: Record<string, string[]>;
}

export const mockNotebookControl: MockNotebookControl = {
  treePage: TREE_PAGE,
  partChars: PART_BYTES,
  zones: [],
  sizes: [],
  oversize: 0,
  silent: false,
  fullPages: [],
  outdatedPages: [],
  tokens: [],
  cutOff: {},
  applied: [],
  presence: {},
  flush: async (deskId) => desks.get(deskId)?.flush(),
  pageText: async (deskId, pageId) => (await mockDesk(deskId).page(pageId)).doc.getXmlFragment('default').toString().replace(/<[^>]*>/g, ''),
};

const refusal = (code: string, details: Record<string, unknown> = {}): Error => Object.assign(new Error(`mock notebook: ${code}`), { code, details });

/** One message on the wire: a page's name, a type, and what follows. */
function message(name: string, type: number, write: (e: encoding.Encoder) => void): Uint8Array<ArrayBuffer> {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, name);
  encoding.writeVarUint(e, type);
  write(e);
  return encoding.toUint8Array(e) as Uint8Array<ArrayBuffer>;
}

interface Peer {
  send(bytes: Uint8Array<ArrayBuffer>): void;
}

/** One page on the desk's side. */
class ServerPage {
  private readonly peers = new Set<Peer>();

  constructor(
    readonly name: string,
    private readonly session: PageSession,
    private readonly others: BroadcastChannel | null,
  ) {
    session.doc.on('update', (update: Uint8Array, origin: unknown) => {
      for (const peer of this.peers) {
        if (peer !== origin) peer.send(message(name, MESSAGE.Sync, (e) => {
          encoding.writeVarUint(e, SYNC.Update);
          encoding.writeVarUint8Array(e, update);
        }));
      }
      if (origin !== this.others) this.others?.postMessage({ page: name, update });
    });
  }

  get doc(): Y.Doc {
    return this.session.doc;
  }

  /** Another session's awareness, to the rest of this page's sessions. */
  relay(from: Peer | null, bytes: Uint8Array): void {
    for (const peer of this.peers) if (peer !== from) peer.send(bytes.slice() as Uint8Array<ArrayBuffer>);
    // And to the same desk's sessions in other tabs, which is what a second member's browser is in a test.
    if (from) this.others?.postMessage({ page: this.name, awareness: bytes });
  }

  join(peer: Peer): void {
    this.peers.add(peer);
    // Another tab's copy of this page says what this one lacks.
    this.others?.postMessage({ page: this.name, ask: Y.encodeStateVector(this.doc) });
  }

  leave(peer: Peer): void {
    this.peers.delete(peer);
  }

  fromOtherTab(data: { update?: Uint8Array; ask?: Uint8Array; awareness?: Uint8Array }): void {
    if (data.awareness) this.relay(null, data.awareness);
    else if (data.update) Y.applyUpdate(this.doc, data.update, this.others);
    else if (data.ask) this.others?.postMessage({ page: this.name, update: Y.encodeStateAsUpdate(this.doc, data.ask) });
  }
}

export class MockNotebookDesk {
  readonly local: LocalBackend;
  private rev = 1;
  private readonly revListeners = new Set<(rev: number) => void>();
  private revTimer = 0;
  private readonly results = new Map<string, Promise<unknown>>();
  private readonly pages = new Map<string, Promise<ServerPage>>();
  private readonly tabs: BroadcastChannel | null;
  private readonly ready: Promise<void>;

  constructor(readonly deskId: string) {
    this.local = new LocalBackend({ dbName: `ma-mock-notebook:${deskId}`, storeDebounceMs: 300, storeMaxWaitMs: 1500 });
    this.ready = this.local.ready();
    this.tabs = typeof BroadcastChannel === 'function' ? new BroadcastChannel(`ma-mock-notebook:${deskId}`) : null;
    (this.tabs as unknown as { unref?: () => void } | null)?.unref?.(); // in Node, for the tests that run this there
    if (this.tabs) {
      this.tabs.onmessage = (e: MessageEvent<{ page: string; update?: Uint8Array; ask?: Uint8Array; awareness?: Uint8Array }>) => void this.pages.get(e.data.page)?.then((p) => p.fromOtherTab(e.data));
    }
    this.local.subscribe(() => this.changed());
    window.addEventListener('pagehide', () => void this.local.flush());
  }

  flush(): Promise<void> {
    return this.local.flush();
  }

  /** Whether it holds a notebook yet, for a seed that only fills an empty desk. */
  async hasNotes(): Promise<boolean> {
    await this.ready;
    return (await this.read('notebook.tree', {}) as { notebooks?: unknown[] }).notebooks?.length !== 0;
  }

  /** At most 4 a second, as the contract says. */
  private changed(): void {
    if (this.revTimer) return;
    this.revTimer = window.setTimeout(() => {
      this.revTimer = 0;
      this.rev += 1;
      for (const fn of this.revListeners) fn(this.rev);
    }, 250);
  }

  onRev(fn: (rev: number) => void): () => void {
    this.revListeners.add(fn);
    window.setTimeout(() => {
      if (this.revListeners.has(fn)) fn(this.rev);
    }, 10);
    return () => this.revListeners.delete(fn);
  }

  // ---------------------------------------------------------------- `rpc`

  async answer(method: string, p: Record<string, unknown>, idem: string | undefined): Promise<unknown> {
    await this.ready;
    const mutation = MUTATIONS.has(method);
    if (!mutation) return this.read(method, p);
    if (!idem) throw refusal('bad_request');
    let result = this.results.get(idem);
    if (!result) {
      mockNotebookControl.applied.push(method);
      result = this.write(method, p);
      if (mockNotebookControl.cutOff[method]) {
        delete mockNotebookControl.cutOff[method];
        // It happened, and no answer came. deskd replays that on the same key (API.md section 13), and never runs it again.
        result = result.then(() => Promise.reject(refusal('unavailable', { reason: 'notebook', mayHaveApplied: true })));
        result.catch(() => {});
      }
      this.results.set(idem, result);
    }
    return result;
  }

  private parts(text: string, cursor: unknown): { part: string; next: string | null } {
    const at = Number(cursor ?? 0);
    const end = at + mockNotebookControl.partChars;
    return { part: text.slice(at, end), next: end < text.length ? String(end) : null };
  }

  private async read(method: string, p: Record<string, unknown>): Promise<unknown> {
    const { local } = this;
    switch (method) {
      case 'notebook.tree': {
        const tree = local.tree();
        const pages = Object.values(tree.byId);
        const at = Number(p['cursor'] ?? 0);
        const end = at + mockNotebookControl.treePage;
        return {
          notebooks: tree.notebooks,
          tabs: Object.values(tree.tabs).flat(),
          pages: pages.slice(at, end),
          rev: this.rev,
          next: end < pages.length ? String(end) : null,
        };
      }
      case 'notebook.page.content':
        return this.parts(JSON.stringify(await local.pageContent(p['pageId'] as string)), p['cursor']);
      case 'notebook.version.list':
        return { versions: await local.versions(p['pageId'] as string) };
      case 'notebook.version.get': {
        const v = await local.version(p['versionId'] as string);
        if (!v) return { meta: null, part: '', next: null };
        const { doc, ...meta } = v;
        return { meta, ...this.parts(JSON.stringify(doc), p['cursor']) };
      }
      case 'notebook.version.asOf':
        return { versionId: (await local.versionAsOf(p['pageId'] as string, p['day'] as string))?.id ?? null };
      case 'notebook.activity':
        return { rows: await local.activity(p['fromDay'] as string, p['toDay'] as string) };
      case 'notebook.activity.days':
        return { days: await local.activeDays() };
      case 'notebook.search': {
        const { query, ...opts } = p;
        return { hits: await local.search(query as string, opts) };
      }
      default:
        throw refusal('not_found');
    }
  }

  private async write(method: string, p: Record<string, unknown>): Promise<unknown> {
    const { local } = this;
    const id = p['id'] as string;
    const pageId = p['pageId'] as string;
    switch (method) {
      case 'notebook.notebook.create':
        return local.createNotebook(p['title'] as string | undefined);
      case 'notebook.notebook.rename':
        await local.renameNotebook(id, p['title'] as string);
        return {};
      case 'notebook.tab.create':
        return local.createTab(p['notebookId'] as string, { title: p['title'] as string | undefined, color: p['color'] as TabColor | undefined });
      case 'notebook.tab.rename':
        await local.renameTab(id, p['title'] as string);
        return {};
      case 'notebook.tab.recolor':
        await local.recolorTab(id, p['color'] as TabColor);
        return {};
      case 'notebook.tab.addAtPage':
        return { tab: await local.addTabAtPage(pageId, p['title'] as string | undefined) };
      case 'notebook.page.create':
        return { page: await local.createPage(p['tabId'] as string, { after: p['after'] as string | undefined }) };
      case 'notebook.page.move':
        await local.movePage(pageId, p['tabId'] as string, p['index'] as number | undefined);
        return {};
      case 'notebook.page.trash':
        await local.trashPage(pageId);
        return {};
      case 'notebook.page.restore':
        await local.restorePage(pageId);
        return {};
      case 'notebook.page.label':
        await local.setPageLabel(pageId, (p['label'] ?? null) as PaletteId | null).catch(() => Promise.reject(refusal('bad_request', { reason: 'label' })));
        return {};
      case 'notebook.page.duplicate':
        return { page: await local.duplicatePage(pageId).catch(() => Promise.reject(refusal('not_found'))) };
      case 'notebook.page.import':
        return {
          page: await local
            .importPage(p['tabId'] as string, { doc: p['doc'], label: p['label'] ?? null, title: '' } as ImportedPage, { after: p['after'] as string | undefined })
            .catch(() => Promise.reject(refusal('bad_request', { reason: 'doc' }))),
        };
      case 'notebook.version.save':
        return { version: await local.saveVersion(pageId, (p['reason'] as 'manual' | undefined) ?? 'manual') };
      case 'notebook.version.restore':
        await local.restoreVersion(pageId, p['versionId'] as string);
        return {};
      case 'notebook.settings.set':
        if (typeof p['timeZone'] !== 'string' || !p['timeZone']) throw refusal('bad_request', { reason: 'time_zone' });
        mockNotebookControl.zones.push(p['timeZone']);
        return {};
      default:
        throw refusal('not_found');
    }
  }

  // ---------------------------------------------------------------- `collab`

  page(name: string): Promise<ServerPage> {
    let page = this.pages.get(name);
    if (!page) {
      page = this.ready.then(async () => {
        const session = this.local.openPage(name);
        await session.ready;
        return new ServerPage(name, session, this.tabs);
      });
      this.pages.set(name, page);
    }
    return page;
  }
}

const MUTATIONS = new Set([
  'notebook.notebook.create',
  'notebook.notebook.rename',
  'notebook.tab.create',
  'notebook.tab.rename',
  'notebook.tab.recolor',
  'notebook.tab.addAtPage',
  'notebook.page.create',
  'notebook.page.move',
  'notebook.page.trash',
  'notebook.page.restore',
  'notebook.page.label',
  'notebook.page.duplicate',
  'notebook.page.import',
  'notebook.version.save',
  'notebook.version.restore',
  'notebook.settings.set',
]);

const desks = new Map<string, MockNotebookDesk>();

/** One per desk, so what's on one is never on another. */
export function mockDesk(deskId: string): MockNotebookDesk {
  let desk = desks.get(deskId);
  if (!desk) {
    desk = new MockNotebookDesk(deskId);
    desks.set(deskId, desk);
  }
  return desk;
}

/** A Guild Desk's pretend others on its pages, by desk and name (`sendPresence`). */
const fakeOthers = new Map<string, Awareness>();

/** One session's virtual WebSocket, on the desk's side. Messages are handled strictly in order, as a real socket's are. */
export class MockCollabServer implements Peer {
  private queue: Promise<void> = Promise.resolve();
  private readonly joined = new Map<string, ServerPage>();
  private readonly ping: number;
  private presenceTimer = 0;

  constructor(
    private readonly desk: MockNotebookDesk,
    readonly send: (bytes: Uint8Array<ArrayBuffer>) => void,
    /** A Guild Desk's verified caller, as deskd's token says, or null on a member's own desk. */
    private readonly caller: () => { memberId: string; name: string } | null = () => null,
  ) {
    this.ping = window.setInterval(() => this.send(new Uint8Array([MESSAGE.Ping])), PING_EVERY_MS);
  }

  receive(bytes: Uint8Array): void {
    this.queue = this.queue.then(() => this.handle(bytes)).catch(() => {});
  }

  /** The desk's sync service restarted, or the session's gone: everything it held for this session is dropped. */
  drop(): void {
    window.clearInterval(this.ping);
    window.clearInterval(this.presenceTimer);
    for (const page of this.joined.values()) page.leave(this);
    this.joined.clear();
  }

  /** A Guild Desk's others, on every page this session has open, now and every 10 s, inside the provider's 30 s timeout. */
  private sendPresence(): void {
    const names = mockNotebookControl.presence[this.desk.deskId];
    if (!names?.length) return;
    const send = (): void => {
      for (const page of this.joined.keys()) {
        for (const who of names) {
          // One "browser" per name, kept, so each renewal's clock is newer and replaces the last rather than being ignored.
          const key = `${this.desk.deskId}|${who}`;
          let aw = fakeOthers.get(key);
          if (!aw) fakeOthers.set(key, (aw = new Awareness(new Y.Doc())));
          aw.setLocalState({ user: { name: who } });
          const update = encodeAwarenessUpdate(aw, [aw.clientID]);
          this.send(message(page, MESSAGE.Awareness, (e) => encoding.writeVarUint8Array(e, update)));
        }
      }
    };
    send();
    if (!this.presenceTimer) this.presenceTimer = window.setInterval(send, 10_000);
  }

  /**
   * What the real service does before it relays a Guild Desk member's awareness (`services/notebook` `sanitizeAwareness`): `user.name` and
   * `user.memberId` are the verified caller's, and any other identity-looking field of `user` goes. The message is made again with them.
   */
  private named(page: string, update: Uint8Array, original: Uint8Array): Uint8Array {
    const caller = this.caller();
    if (!caller) return original;
    const scratch = new Awareness(new Y.Doc());
    try {
      applyAwarenessUpdate(scratch, update, 'mock');
      const ids = [...scratch.getStates().keys()];
      for (const state of scratch.getStates().values()) {
        const given = (state as { user?: Record<string, unknown> }).user;
        const user: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(given ?? {})) if (!/name|id$|^id|mail|member|user|avatar|role|label/i.test(k)) user[k] = v;
        (state as { user?: unknown }).user = { ...user, name: caller.name, memberId: caller.memberId };
      }
      const fresh = encodeAwarenessUpdate(scratch, ids);
      return message(page, MESSAGE.Awareness, (e) => encoding.writeVarUint8Array(e, fresh));
    } finally {
      scratch.destroy();
    }
  }

  private async handle(bytes: Uint8Array): Promise<void> {
    if (bytes.length === 1 && bytes[0] === MESSAGE.Pong) return;
    const d = decoding.createDecoder(bytes);
    const name = decoding.readVarString(d);
    const type = decoding.readVarUint(d);
    if (type === MESSAGE.Auth) {
      try {
        if (decoding.readVarUint(d) === 0) mockNotebookControl.tokens.push(decoding.readVarString(d));
      } catch {
        // Not a token: nothing to note.
      }
      this.send(message(name, MESSAGE.Auth, (e) => {
        encoding.writeVarUint(e, AUTHENTICATED);
        encoding.writeVarString(e, 'read-write');
      }));
      return;
    }
    if (type === MESSAGE.Close) {
      this.joined.get(name)?.leave(this);
      this.joined.delete(name);
      return;
    }
    if (type !== MESSAGE.Sync && type !== MESSAGE.Awareness) return;
    let page = this.joined.get(name);
    if (!page) {
      page = await this.desk.page(name);
      page.join(this);
      this.joined.set(name, page);
      this.sendPresence();
    }
    if (type === MESSAGE.Awareness) {
      page.relay(this, this.named(name, decoding.readVarUint8Array(d), bytes));
      return;
    }
    const step = decoding.readVarUint(d);
    if (step === SYNC.Step1) {
      const vector = decoding.readVarUint8Array(d);
      const doc = page.doc;
      this.send(message(name, MESSAGE.Sync, (e) => {
        encoding.writeVarUint(e, SYNC.Step2);
        encoding.writeVarUint8Array(e, Y.encodeStateAsUpdate(doc, vector));
      }));
      this.send(message(name, MESSAGE.Sync, (e) => {
        encoding.writeVarUint(e, SYNC.Step1);
        encoding.writeVarUint8Array(e, Y.encodeStateVector(doc));
      }));
      return;
    }
    const update = decoding.readVarUint8Array(d);
    if (mockNotebookControl.fullPages.includes(name) && update.length > NOTHING) {
      this.send(message(name, MESSAGE.Close, (e) => encoding.writeVarString(e, 'page_full')));
      return;
    }
    if (mockNotebookControl.outdatedPages.includes(name) && update.length > NOTHING) {
      this.send(message(name, MESSAGE.Close, (e) => encoding.writeVarString(e, 'reload')));
      return;
    }
    if (mockNotebookControl.silent) return;
    Y.applyUpdate(page.doc, update, this);
    this.send(message(name, MESSAGE.SyncStatus, (e) => encoding.writeVarUint(e, 1)));
  }
}
