// `DeskBackend` against the real `desk-notebook`, on this machine, with nothing deployed. Skipped unless
// `NOTEBOOK_SERVICE_BUNDLE` names a built `dist/desk-notebook.mjs` (`services/notebook`, `npm run build`).
//
// The service runs as its own process, with `docker/run`'s heap flag (192 MiB), on a socket in a temp directory. Between it and the
// client is a small stand-in for deskd's relay (API.md section 13): channel 3's real DATA frames from the client's own
// `CollabWire`, reassembled and passed on whole, the service's messages back as DATA with BIN and `id` 0, `{"t":"reset"}`
// when its connection goes, `notebook.*` on `req`/`res`/`err`, and the topic as `{"type": "snapshot", "data": {rev}}`. It
// also does what deskd would do with a DATA message over 4 MiB: count it as the 4001 that closes the whole session.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fragment } from '@tiptap/pm/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DOC_FIELD, notebookSchema } from '../../notebook/src/model/schema.ts';
import { splitBlocks } from '../../notebook/src/ui/pasteSplit.ts';
import { DeskNotConnected, MAX_COLLAB_MESSAGE, type CollabChannel, type DeskLink, type LinkState, type RpcOptions } from '../desk/deskLink';
import { CollabWire, type CollabDataChannel } from '../desk/rtc/collab';
import { decodeFrame, encodeMessage, FLAG_BIN, Kind, Reassembler } from '../desk/rtc/frames';
import { DeskBackend } from './deskBackend';

const BUNDLE = process.env['NOTEBOOK_SERVICE_BUNDLE'] ?? '';
const FRAME_JSON = 1;
const FRAME_COLLAB = 2;
const MUTATIONS = /^notebook\.(notebook|tab|page)\.(create|rename|recolor|addAtPage|move|trash|restore)$|^notebook\.version\.(save|restore)$|^notebook\.settings\.set$/;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
async function until(what: string, check: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

class Refused extends Error {
  constructor(
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

// ---------------------------------------------------------------- the service

class Service {
  proc: ChildProcess | null = null;
  readonly logs: string[] = [];
  readonly socket: string;
  constructor(
    readonly dir: string,
    private readonly env: Record<string, string> = {},
  ) {
    this.socket = join(dir, 'n.sock');
  }

  start(): Promise<void> {
    const proc = spawn(process.execPath, ['--max-old-space-size=192', '--disable-warning=ExperimentalWarning', BUNDLE], {
      env: { PATH: process.env['PATH'] ?? '', DESK_NOTEBOOK_DATA_DIR: join(this.dir, 'data'), DESK_NOTEBOOK_SOCKET: this.socket, DESK_NOTEBOOK_VERSION: 'local', ...this.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    return new Promise((ready, failed) => {
      const onLine = (chunk: Buffer): void => {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (!line) continue;
          this.logs.push(line);
          if (line.includes(' ready in ')) ready();
        }
      };
      proc.stdout?.on('data', onLine);
      proc.stderr?.on('data', onLine);
      proc.once('exit', (code, signal) => failed(new Error(`desk-notebook exited (${code ?? signal}): ${this.logs.slice(-5).join(' | ')}`)));
    });
  }

  stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.exitCode !== null) return Promise.resolve();
    return new Promise((done) => {
      proc.once('exit', () => done());
      proc.kill(signal);
    });
  }
}

// ---------------------------------------------------------------- deskd's relay, for one session

/** deskd's connection to desk-notebook for one session: framing, hello, req/res, sub/evt and collab bytes. */
class ServiceConn {
  private readonly sock: net.Socket;
  private buf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Refused) => void; mutation: boolean }>();
  gone = false;
  onCollab: ((bytes: Uint8Array) => void) | null = null;
  onEvent: ((sid: number, data: unknown) => void) | null = null;
  onGone: (() => void) | null = null;
  readonly opened: Promise<void>;

  constructor(path: string) {
    this.sock = net.createConnection(path);
    this.opened = new Promise((done, failed) => {
      this.sock.once('connect', () => done());
      this.sock.once('error', failed);
    });
    this.opened.catch(() => {});
    this.sock.on('error', () => {});
    this.sock.on('data', (chunk) => this.read(chunk));
    this.sock.on('close', () => {
      this.gone = true;
      for (const c of this.calls.values()) c.reject(new Refused('unavailable', c.mutation ? { reason: 'notebook', mayHaveApplied: true } : { reason: 'notebook' }));
      this.calls.clear();
      this.onGone?.();
    });
    this.json({ t: 'hello', sessionId: 'local', sub: 'owner' });
  }

  private write(type: number, body: Uint8Array): void {
    if (this.sock.destroyed) return;
    const out = Buffer.allocUnsafe(5 + body.length);
    out.writeUInt32BE(body.length + 1, 0);
    out[4] = type;
    out.set(body, 5);
    this.sock.write(out);
  }

  json(value: unknown): void {
    this.write(FRAME_JSON, Buffer.from(JSON.stringify(value)));
  }

  collab(bytes: Uint8Array): void {
    this.write(FRAME_COLLAB, bytes);
  }

  private read(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) return;
      const type = this.buf[4] as number;
      const body = this.buf.subarray(5, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      if (type === FRAME_COLLAB) {
        this.onCollab?.(new Uint8Array(body));
        continue;
      }
      const m = JSON.parse(body.toString('utf8')) as { t: string; id: number; r?: unknown; code?: string; details?: Record<string, unknown>; sid?: number; data?: unknown };
      if (m.t === 'res' || m.t === 'err') {
        const c = this.calls.get(m.id);
        this.calls.delete(m.id);
        if (m.t === 'res') c?.resolve(m.r);
        else c?.reject(new Refused(m.code ?? 'internal', m.details ?? {}));
      } else if (m.t === 'evt') {
        this.onEvent?.(m.sid ?? 0, m.data);
      }
    }
  }

  call(m: string, p: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject, mutation: MUTATIONS.test(m) });
      this.json({ t: 'req', id, m, p });
    });
  }

  close(): void {
    this.sock.destroy();
  }
}

/**
 * One desk's link, as `DeskBackend` and the collab socket see it, with deskd's relay behind it. `endSession` and `newSession`
 * are a dropped link and its return: a new session has a new `collab`.
 */
class RelayLink {
  readonly deskId: string;
  private state: LinkState = 'open';
  private readonly statusFns = new Set<(s: LinkState) => void>();
  private readonly mediaFns = new Set<() => void>();
  private conn: ServiceConn | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private wire: CollabWire | null = null;
  private dc: (CollabDataChannel & { readyState: string }) | null = null;
  private readonly reassembler = new Reassembler();
  /** DATA has gone to desk-notebook since the last reset, so a lost connection owes this session one. */
  private collabUsed = false;
  private readonly subs = new Map<number, { topic: string; fn: (m: never) => void; seq: number }>();
  private nextSid = 1;
  private readonly idem = new Map<string, Promise<unknown>>();
  closed = false;

  /** Every whole DATA message from the client, by size, and how many went over 4 MiB (each a 4001 on a real desk). */
  readonly sent: number[] = [];
  oversize = 0;
  resets = 0;
  /** Hocuspocus Auth messages the client sent, by page: each one is a provider (re)opening that page. */
  readonly auths: string[] = [];

  constructor(
    private readonly service: Service,
    deskId = 'd-local',
  ) {
    this.deskId = deskId;
    this.newSession();
    this.dial();
  }

  // ----- deskd's side

  private dial(): void {
    if (this.closed) return;
    const conn = new ServiceConn(this.service.socket);
    this.conn = conn;
    conn.onCollab = (bytes) => this.toClient(bytes);
    conn.onEvent = (sid, data) => {
      const sub = this.subs.get(sid);
      if (!sub) return;
      sub.seq += 1;
      // deskd's own shape (API.md section 13), as `RtcDeskLink.subscribe` hands it on.
      sub.fn({ ...(data as object), type: 'snapshot', seq: sub.seq } as never);
    };
    conn.onGone = () => {
      if (this.conn !== conn) return;
      this.conn = null;
      if (this.collabUsed) this.reset();
      if (!this.closed) this.reconnect = setTimeout(() => this.dial(), 100);
    };
    conn.opened.then(
      () => {
        for (const [sid, sub] of this.subs) conn.json({ t: 'sub', sid, topic: sub.topic });
      },
      () => {},
    );
  }

  private reset(): void {
    this.collabUsed = false;
    this.resets += 1;
    for (const frame of encodeMessage(Kind.DATA, 0, 0, 0, new TextEncoder().encode('{"t":"reset"}'))) this.dc?.onmessage?.({ data: frame.buffer });
  }

  private toClient(bytes: Uint8Array): void {
    for (const frame of encodeMessage(Kind.DATA, FLAG_BIN, 0, 0, bytes)) this.dc?.onmessage?.({ data: frame.buffer });
  }

  private fromClient(frame: Uint8Array<ArrayBuffer>): void {
    const f = decodeFrame(frame);
    if (f.kind !== Kind.DATA || !(f.flags & FLAG_BIN)) return; // DATA without BIN from a client is ignored
    let whole: Uint8Array | null;
    try {
      whole = this.reassembler.push(f);
    } catch {
      this.oversize += 1; // over 4 MiB: a real deskd closes the whole session with 4001
      return;
    }
    if (!whole) return;
    this.sent.push(whole.length);
    if (whole.length > MAX_COLLAB_MESSAGE) this.oversize += 1;
    const name = pageOfAuth(whole);
    if (name) this.auths.push(name);
    if (!this.conn || this.conn.gone) {
      // Not there when DATA comes: that DATA is dropped and the session gets a reset.
      this.reset();
      return;
    }
    this.collabUsed = true;
    this.conn.collab(whole);
  }

  // ----- what the client sees

  status = (): LinkState => this.state;
  onStatus = (fn: (s: LinkState) => void): (() => void) => {
    this.statusFns.add(fn);
    return () => this.statusFns.delete(fn);
  };
  onMedia = (fn: () => void): (() => void) => {
    this.mediaFns.add(fn);
    return () => this.mediaFns.delete(fn);
  };
  collab = (): CollabChannel | null => (this.state === 'open' ? this.wire : null);

  call = async (method: string, params: Record<string, unknown> = {}, options?: RpcOptions): Promise<unknown> => {
    if (this.state !== 'open') throw new DeskNotConnected(this.deskId);
    const mutation = MUTATIONS.test(method);
    if (mutation && !options?.idem) throw new Refused('bad_request', { reason: 'idem' });
    const run = async (): Promise<unknown> => {
      const conn = this.conn;
      if (!conn || conn.gone) throw new Refused('unavailable', { reason: 'notebook' });
      await conn.opened;
      return conn.call(method, params);
    };
    if (!mutation || !options?.idem) return run();
    // deskd's idem store (API.md section 4): the same key gets the same reply, and never runs it twice, except that
    // "unavailable" with nothing done runs it next time.
    const held = this.idem.get(options.idem);
    if (held) return held;
    const reply = run();
    this.idem.set(options.idem, reply);
    reply.catch((err: Refused) => {
      if (err.code === 'unavailable' && !err.details['mayHaveApplied']) this.idem.delete(options.idem as string);
    });
    return reply;
  };

  subscribe = (topic: string, fn: (m: never) => void): (() => void) => {
    const sid = this.nextSid++;
    this.subs.set(sid, { topic, fn, seq: 0 });
    void this.conn?.opened.then(() => this.conn?.json({ t: 'sub', sid, topic }), () => {});
    return () => {
      this.subs.delete(sid);
      this.conn?.json({ t: 'unsub', sid });
    };
  };

  /** The link drops: this session and its `collab` end. */
  endSession(): void {
    this.state = 'retrying';
    if (this.dc) this.dc.readyState = 'closed';
    this.wire?.end();
    for (const fn of [...this.statusFns]) fn(this.state);
  }

  /** A new session, with a new `collab`. */
  newSession(): void {
    const wire = new CollabWire();
    const dc = {
      readyState: 'open',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      onbufferedamountlow: null,
      onopen: null,
      onclose: null,
      onmessage: null,
      send: (frame: Uint8Array<ArrayBuffer>) => this.fromClient(frame),
    } as CollabDataChannel & { readyState: string };
    wire.attach(dc);
    this.wire = wire;
    this.dc = dc;
    this.reassembler.clear();
    if (this.state !== 'open') {
      this.state = 'open';
      for (const fn of [...this.statusFns]) fn(this.state);
      for (const fn of [...this.mediaFns]) fn();
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.endSession();
    this.conn?.close();
  }
}

/** The page an Auth message (type 2) is for, as the adapter on the desk reads it. */
function pageOfAuth(bytes: Uint8Array): string | null {
  try {
    let at = 0;
    const varUint = (): number => {
      let n = 0;
      let mult = 1;
      for (;;) {
        const b = bytes[at++] as number;
        n += (b & 0x7f) * mult;
        if (b < 0x80) return n;
        mult *= 128;
      }
    };
    const len = varUint();
    const name = new TextDecoder().decode(bytes.subarray(at, at + len));
    at += len;
    return varUint() === 2 ? name : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- what an editor does to a page

const fragmentOf = (doc: Y.Doc): Y.XmlFragment => doc.getXmlFragment(DOC_FIELD);

/** Every character of the page, in order. */
function textOf(doc: Y.Doc): string {
  const out: string[] = [];
  const walk = (node: Y.XmlElement | Y.XmlFragment | Y.XmlText): void => {
    if (node instanceof Y.XmlText) out.push(node.toString().replace(/<[^>]*>/g, ''));
    else node.toArray().forEach((c) => walk(c as Y.XmlElement));
  };
  walk(fragmentOf(doc));
  return out.join('');
}

/** Types into the page's first block, the Title the desk seeded, as one transaction. */
function typeTitle(doc: Y.Doc, text: string): void {
  doc.transact(() => {
    const heading = fragmentOf(doc).get(0) as Y.XmlElement;
    const first = heading.get(0);
    if (first instanceof Y.XmlText) first.insert(first.length, text);
    else heading.insert(0, [new Y.XmlText(text)]);
  });
}

function paragraph(text: string): Y.XmlElement {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  return p;
}

/** A line typed at the end, as one transaction. */
function typeLine(doc: Y.Doc, text: string): void {
  doc.transact(() => fragmentOf(doc).push([paragraph(text)]));
}

/** A paste, cut where the editor's `splitBlocks` cuts it, each piece one transaction as `handleLargePaste` makes them. */
function paste(doc: Y.Doc, lines: string[]): number {
  const schema = notebookSchema();
  const content = Fragment.fromArray(lines.map((l) => schema.node('paragraph', null, [schema.text(l)])));
  const pieces = splitBlocks(content);
  for (const piece of pieces) {
    const blocks: Y.XmlElement[] = [];
    piece.forEach((node) => void blocks.push(paragraph(node.textContent)));
    doc.transact(() => fragmentOf(doc).push(blocks));
  }
  return pieces.length;
}

function backendOn(link: RelayLink, zone = 'America/Denver'): DeskBackend {
  const b = new DeskBackend(link as unknown as DeskLink, { storage: null, timeZone: () => zone, unsavedAfterMs: 300 });
  b.setActive(true);
  return b;
}

const PASTE_LINE = 'The quick brown fox jumps over the lazy dog, and the ferry leaves at seven forty. ';

const settled = (b: DeskBackend): Promise<void> => until('the desk to confirm every page', () => !b.hasUnsavedText());

// ---------------------------------------------------------------- the runs

describe.skipIf(!BUNDLE)('DeskBackend on the real desk-notebook, through a stand-in for deskd', () => {
  let dir = '';
  let service: Service;
  const links: RelayLink[] = [];
  const link = (): RelayLink => {
    const l = new RelayLink(service);
    links.push(l);
    return l;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nbc-'));
    service = new Service(dir, { DESK_NOTEBOOK_STORE_DEBOUNCE_MS: '300', DESK_NOTEBOOK_STORE_MAX_MS: '1500' });
    await service.start();
  });

  afterAll(async () => {
    for (const l of links) l.close();
    await service?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  let pageId = '';
  let tabId = '';

  it('an empty desk: an empty tree, the zone sent once, then the first notebook, whose page the desk seeded with a Title', async () => {
    const l = link();
    const b = backendOn(l);
    await b.ready();
    expect(b.status().load).toBe('ready');
    expect(b.tree().notebooks).toEqual([]);
    const made = await b.createNotebook();
    pageId = made.page.id;
    tabId = made.tab.id;
    expect(b.tree().byId[pageId]).toBeTruthy();
    const content = await b.pageContent(pageId);
    expect(content).toEqual({ type: 'doc', content: [{ type: 'heading', attrs: { level: 1 } }] });
    expect(l.oversize).toBe(0);
  });

  it('an unknown zone is bad_request, time_zone, and opening goes on', async () => {
    const b = backendOn(link(), 'Mars/Olympus_Mons');
    await b.ready();
    expect(b.status().load).toBe('ready');
  });

  it('typed text reaches the desk; another client reads it; a reload opens on it, never empty', async () => {
    const l = link();
    const b = backendOn(l);
    await b.ready();
    const s = b.openPage(pageId);
    await s.ready;
    typeTitle(s.doc, 'Ferry times');
    typeLine(s.doc, 'The 7:40 leaves from pier 2.');
    expect(b.hasUnsavedText()).toBe(true);
    await settled(b);
    s.close();

    // A reload: a new link and a new backend. `ready` is the stored page, so the editor opens on it.
    const again = backendOn(link());
    await again.ready();
    const s2 = again.openPage(pageId);
    await s2.ready;
    expect(textOf(s2.doc)).toBe('Ferry timesThe 7:40 leaves from pier 2.');
    s2.close();

    // The desk's own copy, through RPC, and its derived title on the tree once it's stored.
    const reader = backendOn(link());
    await reader.ready();
    await until('the store and the tree', async () => {
      await (reader as unknown as { refetch(): Promise<void> }).refetch();
      return reader.tree().byId[pageId]?.title === 'Ferry times';
    });
    expect(JSON.stringify(await reader.pageContent(pageId))).toContain('pier 2');
  });

  it('the topic: a change from another client reaches this tree by rev alone', async () => {
    const watcher = backendOn(link());
    await watcher.ready();
    let heard = 0;
    const off = watcher.subscribe(() => (heard += 1));
    const other = backendOn(link());
    await other.ready();
    const page = await other.createPage(tabId);
    await until('the watcher to read the tree again', () => !!watcher.tree().byId[page.id]);
    expect(heard).toBeGreaterThan(0);
    off();
  });

  it('two clients of one page converge, nothing lost', async () => {
    const a = backendOn(link());
    const b = backendOn(link());
    await Promise.all([a.ready(), b.ready()]);
    const sa = a.openPage(pageId);
    const sb = b.openPage(pageId);
    await Promise.all([sa.ready, sb.ready]);
    for (let i = 0; i < 20; i += 1) {
      typeLine(sa.doc, `a${i}`);
      typeLine(sb.doc, `b${i}`);
    }
    await Promise.all([settled(a), settled(b)]);
    await until('both to hold the same page', () => textOf(sa.doc) === textOf(sb.doc));
    for (let i = 0; i < 20; i += 1) {
      expect(textOf(sa.doc)).toContain(`a${i}`);
      expect(textOf(sa.doc)).toContain(`b${i}`);
    }
    sa.close();
    sb.close();
  });

  it('a quiet open page keeps its socket: no pings come, and it opens the page once', async () => {
    const l = link();
    const b = backendOn(l);
    await b.ready();
    const s = b.openPage(pageId);
    await s.ready;
    const auths = l.auths.length;
    await sleep(36_000); // past the provider's own 30 s check, and its tenth
    expect(l.auths.length).toBe(auths);
    typeLine(s.doc, 'still here');
    await settled(b);
    s.close();
  }, 60_000);

  it('a restart: what is typed meanwhile waits in the tab, says so, and reaches the desk on {"t":"reset"} and the provider\'s own backoff', async () => {
    const l = link();
    const b = backendOn(l);
    await b.ready();
    const s = b.openPage(pageId);
    await s.ready;
    await service.stop('SIGTERM');
    typeLine(s.doc, 'typed while the service restarts');
    await until('the unsaved line', () => b.status().unsaved);
    expect(b.hasUnsavedText()).toBe(true);
    await service.start();
    await settled(b);
    expect(l.resets).toBeGreaterThan(0);
    s.close();
    const reader = backendOn(link());
    await reader.ready();
    const s2 = reader.openPage(pageId);
    await s2.ready;
    expect(textOf(s2.doc)).toContain('typed while the service restarts');
    s2.close();
  }, 60_000);

  it('SIGKILL just after the desk confirmed: the open tab gives it back when it reconnects', async () => {
    const l = link();
    const b = backendOn(l);
    await b.ready();
    const s = b.openPage(pageId);
    await s.ready;
    typeLine(s.doc, 'confirmed, then the power went');
    await settled(b);
    await service.stop('SIGKILL');
    await service.start();
    await until('a reset and a resync', () => l.resets > 0 && !b.hasUnsavedText());
    await sleep(1_000);
    const reader = backendOn(link());
    await reader.ready();
    const s2 = reader.openPage(pageId);
    await s2.ready;
    expect(textOf(s2.doc)).toContain('confirmed, then the power went');
    s2.close();
    s.close();
  }, 60_000);

  it('a dropped link while typing: the text stays in the tab and arrives with the next session', async () => {
    const l = link();
    const b = backendOn(l);
    await b.ready();
    const s = b.openPage(pageId);
    await s.ready;
    l.endSession();
    typeLine(s.doc, 'typed with the link down');
    await until('the unsaved line', () => b.status().unsaved);
    await sleep(500);
    l.newSession();
    await settled(b);
    s.close();
    const reader = backendOn(link());
    await reader.ready();
    expect(JSON.stringify(await reader.pageContent(pageId))).toContain('typed with the link down');
  }, 30_000);

  it('a large paste goes in pieces under 1 MiB, nothing over 4 MiB is ever sent, and a closed page reads back in parts', async () => {
    const l = link();
    const b = backendOn(l);
    await b.ready();
    const page = await b.createPage(tabId);
    const s = b.openPage(page.id);
    await s.ready;
    const lines = Array.from({ length: 20_000 }, (_, i) => `${i} ${PASTE_LINE}`);
    const pieces = paste(s.doc, lines);
    expect(pieces).toBeGreaterThan(3);
    expect(Y.encodeStateAsUpdate(s.doc).length).toBeGreaterThan(2 * 1024 * 1024);
    await settled(b);
    expect(b.status().full).toBe(false);
    expect(l.oversize).toBe(0);
    expect(Math.max(...l.sent)).toBeLessThan(1024 * 1024);
    s.close();
    const reader = backendOn(link());
    await reader.ready();
    const doc = await reader.pageContent(page.id);
    expect(JSON.stringify(doc).length).toBeGreaterThan(512 * 1024 * 2);
    expect(doc.content?.length).toBe(1 + lines.length);
    expect(JSON.stringify(doc.content?.[lines.length])).toContain(`${lines.length - 1} The quick`);
  }, 60_000);

  it('a paste past the real ceiling (3.5 MiB of Yjs state): page_full, read-only, and the desk keeps what fit', async () => {
    const l = link();
    const b = backendOn(l);
    await b.ready();
    const page = await b.createPage(tabId);
    const s = b.openPage(page.id);
    await s.ready;
    let readOnly = false;
    s.onReadOnly?.((ro) => (readOnly = ro));
    const lines = Array.from({ length: 30_000 }, (_, i) => `${i} ${PASTE_LINE}`);
    paste(s.doc, lines);
    await until('page_full', () => b.status().full);
    expect(readOnly).toBe(true);
    expect(b.hasUnsavedText()).toBe(true);
    expect(l.oversize).toBe(0);
    s.close();
    const reader = backendOn(link());
    await reader.ready();
    const kept = await reader.pageContent(page.id);
    expect(kept.content?.length).toBeGreaterThan(10_000);
    expect(kept.content?.length).toBeLessThan(1 + lines.length);
  }, 60_000);

  it('one transaction over 4 MiB is never sent: the session stays, the line says so, and the text stays in the tab', async () => {
    const l = link();
    const b = backendOn(l);
    await b.ready();
    const page = await b.createPage(tabId);
    const s = b.openPage(page.id);
    await s.ready;
    typeLine(s.doc, 'x'.repeat(4.5 * 1024 * 1024));
    await until('the too-large line', () => b.status().tooLarge);
    expect(l.oversize).toBe(0);
    expect(Math.max(...l.sent)).toBeLessThanOrEqual(MAX_COLLAB_MESSAGE);
    expect(b.hasUnsavedText()).toBe(true);
    // The session is still good for everything else.
    expect((await b.versions(pageId)).length).toBeGreaterThanOrEqual(0);
    s.close();
  }, 30_000);

  it('versions, activity, days and search answer as the contract says', async () => {
    const b = backendOn(link());
    await b.ready();
    const saved = await b.saveVersion(pageId);
    expect(saved?.pageId).toBe(pageId);
    const list = await b.versions(pageId);
    expect(list.some((v) => v.id === saved?.id)).toBe(true);
    const v = await b.version(saved?.id ?? '');
    expect(JSON.stringify(v?.doc)).toContain('Ferry times');
    expect(await b.version('no-such-version')).toBeNull();
    const days = await b.activeDays();
    expect(days.length).toBeGreaterThan(0);
    const rows = await b.activity(days[0] as string, days[days.length - 1] as string);
    expect(rows.length).toBeGreaterThan(0);
    await until('search to find the stored page', async () => (await b.search('pier')).some((h) => h.pageId === pageId));
    expect(b.status().problem).toBe(false);
  });

  it('trash and restore move the page, and its text is kept', async () => {
    const b = backendOn(link());
    await b.ready();
    await b.trashPage(pageId);
    expect(b.tree().byId[pageId]?.deletedAt).toBeTruthy();
    await b.restorePage(pageId);
    expect(b.tree().byId[pageId]?.deletedAt ?? null).toBeNull();
    expect(JSON.stringify(await b.pageContent(pageId))).toContain('pier 2');
  });
});

describe.skipIf(!BUNDLE)('a full page, on the real desk-notebook', () => {
  let dir = '';
  let service: Service;
  const links: RelayLink[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nbf-'));
    service = new Service(dir, { DESK_NOTEBOOK_PAGE_FULL_BYTES: String(64 * 1024), DESK_NOTEBOOK_STORE_DEBOUNCE_MS: '300' });
    await service.start();
  });

  afterAll(async () => {
    for (const l of links) l.close();
    await service?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('page_full: read-only, said plainly, the refused text stays in the tab, and other pages carry on', async () => {
    const l = new RelayLink(service);
    links.push(l);
    const b = backendOn(l);
    await b.ready();
    const { tab, page } = await b.createNotebook();
    const s = b.openPage(page.id);
    await s.ready;
    let readOnly = false;
    s.onReadOnly?.((ro) => (readOnly = ro));
    typeLine(s.doc, 'kept');
    await settled(b);
    typeLine(s.doc, 'y'.repeat(80 * 1024));
    await until('page_full', () => b.status().full);
    expect(readOnly).toBe(true);
    expect(b.hasUnsavedText()).toBe(true);
    expect(textOf(s.doc)).toContain('yyyy');

    const other = await b.createPage(tab.id);
    const s2 = b.openPage(other.id);
    await s2.ready;
    typeLine(s2.doc, 'another page');
    await until('the other page confirmed', () => !b.status().unsaved && b.status().full);
    const reader = backendOn(new RelayLink(service));
    await reader.ready();
    expect(JSON.stringify(await reader.pageContent(other.id))).toContain('another page');
    const full = JSON.stringify(await reader.pageContent(page.id));
    expect(full).toContain('kept');
    expect(full).not.toContain('yyyy');
    s2.close();
  }, 30_000);
});
