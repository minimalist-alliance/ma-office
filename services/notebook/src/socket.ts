// /run/desk-notebook/notebook.sock: one connection per deskd session, carrying RPC, topics and collab bytes.
import { lstatSync, unlinkSync, chmodSync } from 'node:fs';
import net from 'node:net';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import type { Hocuspocus } from '@hocuspocus/server';
import { OWNER_CALLER, parseCaller, sameIdentity, type Caller } from './caller.ts';
import { RpcError } from './errors.ts';
import { encodeFrame, FRAME_COLLAB, FRAME_JSON, FrameDecoder, MAX_COLLAB_MESSAGE } from './frames.ts';
import { errName, log } from './log.ts';
import { FORBIDDEN, PAGE_FULL, RESET, STORAGE_FULL, Who, renameAwareness, type CollabContext } from './collab.ts';
import { type Members } from './members.ts';
import { NOTEBOOK_SCHEMA, RELOAD_REASON, schemaOfToken, tokenSaysSchema, updateChanges } from './model.ts';
import { Parts, type RpcHandler } from './rpc.ts';
import { parseSettings, type EditBudget } from './settings.ts';

const WS_OPEN = 1;
const WS_CLOSED = 3;
/** Hocuspocus's message types, as far as the adapter has to read them. */
const MSG_SYNC = 0;
const MSG_AUTH = 2;
const MSG_CLOSE = 7;
/** y-protocols' sync messages: step 1 asks, step 2 and update carry changes. */
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;
const AUTH_TOKEN = 0;
const AUTH_PERMISSION_DENIED = 1;
const AUTH_AUTHENTICATED = 2;
const COLLAB_REQUEST = new Request('http://desk-notebook.invalid/collab');
/** A peer that stops reading isn't kept: past this it's dropped, and it comes back through deskd's reset. */
const MAX_WRITE_BACKLOG = 32 * 1024 * 1024;
/** What may wait, in all, for pages to finish closing: a new provider's Auth and state vector, and room for a paste. */
const MAX_HELD_BYTES = MAX_COLLAB_MESSAGE + 1024 * 1024;
const MAX_RPC_REPLY = 1024 * 1024;
const HELLO_TIMEOUT_MS = 10_000;
const MIN_EVENT_INTERVAL_MS = 250;

function header(data: Uint8Array): { address: string; type: number; decoder: decoding.Decoder } | null {
  try {
    const decoder = decoding.createDecoder(data);
    const address = decoding.readVarString(decoder);
    return { address, type: decoding.readVarUint(decoder), decoder };
  } catch {
    return null;
  }
}

/** What a provider sends when it lets a page go. */
function providerClose(address: string): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, address);
  encoding.writeVarUint(e, MSG_CLOSE);
  return encoding.toUint8Array(e);
}

function closeMessage(address: string, reason: string): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, address);
  encoding.writeVarUint(e, MSG_CLOSE);
  encoding.writeVarString(e, reason);
  return encoding.toUint8Array(e);
}

export interface SocketDeps {
  path: string;
  methods: Map<string, RpcHandler>;
  collab: Hocuspocus;
  rev: () => number;
  health: () => Record<string, unknown>;
  members: Members;
  /**
   * ADR 0091, the guard: whether this page holds anything an editor of `schema` would drop when it edits (a block's color
   * for schema 1). Asked only of an editor older than this build's schema, and only for a change.
   */
  outdated?: (pageId: string, schema: number) => boolean;
}

class Session {
  private readonly decoder = new FrameDecoder();
  private readonly parts = new Parts();
  private readonly cancelled = new Set<unknown>();
  private readonly inflight = new Set<unknown>();
  private readonly subs = new Map<unknown, number>();
  private client: ReturnType<Hocuspocus['handleConnection']> | null = null;
  /** Pages on this connection the desk has closed, until the client asks again with Auth. */
  private readonly closedPages = new Set<string>();
  /** The page schema each provider on this connection said in its Auth token (ADR 0091), and whether it said one. None is 1. */
  private readonly schemas = new Map<string, { schema: number; said: boolean }>();
  /** Pages Hocuspocus has authenticated on this connection and not closed since, as its own replies say. */
  private readonly openPages = new Set<string>();
  /** Pages whose provider has gone and that Hocuspocus is still closing, each with what has come for it since. */
  private readonly closing = new Map<string, Uint8Array[]>();
  private heldBytes = 0;
  /** Who this is, from deskd: the hello's caller, then each `caller` frame. The owner if the hello has none. */
  private readonly who = new Who(OWNER_CALLER);
  private greeted = false;
  private gone = false;
  private helloTimer: ReturnType<typeof setTimeout> | null;
  /** The small WebSocket shape Hocuspocus's handleConnection takes. */
  private readonly webSocket = {
    readyState: WS_OPEN,
    send: (data: string | ArrayBufferLike | Blob | ArrayBufferView) => this.collabSend(data as Uint8Array),
    close: () => this.drop('collab closed'),
  };

  constructor(
    readonly id: number,
    private readonly socket: net.Socket,
    private readonly deps: SocketDeps,
    private readonly onGone: (s: Session) => void,
  ) {
    this.helloTimer = setTimeout(() => this.drop('no hello'), HELLO_TIMEOUT_MS);
    this.helloTimer.unref();
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => this.onClose());
  }

  private onData(chunk: Buffer): void {
    try {
      this.decoder.push(chunk, (type, body) => this.onFrame(type, body));
    } catch (e) {
      this.drop(`bad stream ${errName(e)}`);
    }
  }

  private onFrame(type: number, body: Uint8Array): void {
    if (this.gone) return;
    if (type === FRAME_JSON) this.onJson(body);
    else if (type === FRAME_COLLAB) this.onCollab(body);
    else this.drop(`bad frame type ${type}`);
  }

  private onJson(body: Uint8Array): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(Buffer.from(body.buffer, body.byteOffset, body.length).toString('utf8')) as Record<string, unknown>;
      if (!m || typeof m !== 'object') throw new SyntaxError('not an object');
    } catch {
      this.drop('bad json');
      return;
    }
    if (m['t'] === 'health') {
      this.sendJson({ t: 'health', ...this.deps.health() });
      return;
    }
    if (!this.greeted) {
      if (m['t'] !== 'hello') {
        this.drop('no hello');
        return;
      }
      const caller = parseCaller(m['caller']);
      if (!caller) {
        this.drop('bad caller');
        return;
      }
      this.greeted = true;
      if (this.helloTimer) clearTimeout(this.helloTimer);
      this.helloTimer = null;
      this.setCaller(caller);
      // The hello's settings, if it has usable ones; else the default stands. A guild desk's deskd is the only sender.
      this.setBudget(parseSettings(m['settings']));
      return;
    }
    switch (m['t']) {
      case 'req':
        // The caller as of this frame: a `caller` frame after it doesn't change who asked.
        void this.onRequest(m['id'], m['m'], m['p'], this.who.caller, this.who.budget);
        break;
      case 'caller': {
        // deskd's refresh: role, grants and name may change. Kind and memberId never do, so a frame that changes them
        // is deskd's bug, and nothing more from this connection is trusted.
        const next = m['caller'] === undefined ? null : parseCaller(m['caller']);
        if (!next || !sameIdentity(this.who.caller, next)) {
          this.drop('caller changed');
          return;
        }
        this.setCaller(next);
        break;
      }
      case 'settings':
        // deskd's change to the effective settings: what this connection checks from now on. One that isn't usable is
        // ignored, and the connection keeps what it has.
        this.setBudget(parseSettings(m['settings']));
        break;
      case 'cancel':
        if (this.inflight.has(m['id'])) this.cancelled.add(m['id']);
        break;
      case 'sub':
        this.onSubscribe(m['sid'], m['topic']);
        break;
      case 'unsub':
        this.subs.delete(m['sid']);
        break;
      default:
        this.drop('unknown message');
    }
  }

  private setBudget(budget: EditBudget | null): void {
    if (budget) this.who.budget = budget;
  }

  private setCaller(caller: Caller): void {
    const renamed = this.client !== null && this.who.caller.name !== caller.name;
    this.who.caller = caller;
    if (renamed) {
      try {
        renameAwareness(this.deps.collab, this.who);
      } catch (e) {
        log('WARN', `renaming presence failed ${errName(e)}`);
      }
    }
    try {
      this.deps.members.remember(caller);
    } catch (e) {
      // A name not kept costs only how a name shows; the session carries on.
      log('WARN', `keeping a name failed ${errName(e)}`);
    }
  }

  private async onRequest(id: unknown, method: unknown, params: unknown, caller: Caller, budget: EditBudget): Promise<void> {
    const handler = typeof method === 'string' ? this.deps.methods.get(method) : undefined;
    if (!handler) {
      this.sendJson({ t: 'err', id, code: 'not_found', details: { reason: 'method' } });
      return;
    }
    const p = params === undefined || params === null ? {} : params;
    if (typeof p !== 'object' || Array.isArray(p)) {
      this.sendJson({ t: 'err', id, code: 'bad_request', details: { reason: 'params' } });
      return;
    }
    this.inflight.add(id);
    try {
      // Most methods are synchronous, so their reply goes out in this tick and nothing can interleave.
      const result = handler(p as Record<string, unknown>, this.parts, caller, budget);
      const value = result instanceof Promise ? await result : result;
      this.reply(id, value);
    } catch (e) {
      if (e instanceof RpcError) {
        this.replyError(id, e.code, e.details);
      } else {
        log('ERROR', `rpc failed method=${method as string} ${errName(e)}`);
        this.replyError(id, 'internal', {});
      }
    } finally {
      this.inflight.delete(id);
      this.cancelled.delete(id);
    }
  }

  private reply(id: unknown, value: unknown): void {
    if (this.cancelled.has(id) || this.gone) return;
    const json = JSON.stringify(value ?? {});
    if (Buffer.byteLength(json) > MAX_RPC_REPLY) {
      this.replyError(id, 'too_large', {});
      return;
    }
    this.sendRaw(FRAME_JSON, Buffer.from(`{"t":"res","id":${JSON.stringify(id ?? null)},"r":${json}}`));
  }

  private replyError(id: unknown, code: string, details: Record<string, unknown>): void {
    if (this.cancelled.has(id) || this.gone) return;
    this.sendJson({ t: 'err', id, code, details });
  }

  private onSubscribe(sid: unknown, topic: unknown): void {
    if (topic !== 'notebook.tree') {
      this.sendJson({ t: 'err', id: sid, code: 'not_found', details: { reason: 'topic' } });
      return;
    }
    const rev = this.deps.rev();
    this.subs.set(sid, rev);
    this.sendJson({ t: 'evt', sid, data: { rev } });
  }

  /** The tree moved on: every subscription that hasn't seen this rev. Throttled by the caller. */
  publish(rev: number): void {
    for (const [sid, seen] of this.subs) {
      if (seen >= rev) continue;
      this.subs.set(sid, rev);
      this.sendJson({ t: 'evt', sid, data: { rev } });
    }
  }

  private onCollab(data: Uint8Array): void {
    this.who.stamp(data);
    const h = header(data);
    if (h) {
      const held = this.closing.get(h.address);
      if (held) {
        // Hocuspocus picks a message's page as it arrives, but closes a page a few ticks later, as it works through
        // that page's queue. Until then anything for the page would reach the one that's closing: a new provider's
        // Auth would be lost there, and its page would never sync on this connection. So it waits.
        this.heldBytes += data.length;
        if (this.heldBytes > MAX_HELD_BYTES) {
          this.drop('too much waiting for a page to close');
          return;
        }
        held.push(data);
        return;
      }
      if (this.closedPages.has(h.address)) {
        // A provider stays attached after a close, and keeps sending as its editor changes. Without this those
        // messages would queue as if for a page opening, and past the queue's limit the whole session would go.
        if (h.type !== MSG_AUTH) return;
        this.closedPages.delete(h.address);
      }
      if (h.type === MSG_AUTH) this.schemas.set(h.address, this.tokenSchema(h.decoder));
      else if (h.type === MSG_SYNC && this.fromOlderEditor(h.address, h.decoder)) {
        this.refuseOlder(h.address);
        return;
      }
      if (h.type === MSG_CLOSE) {
        // A provider has gone. For a page with nothing open here, Hocuspocus would keep the CLOSE until the next
        // provider's Auth, and then close that one with it: a CLOSE from a socket deskd has since reset, say.
        if (!this.openPages.has(h.address)) return;
        this.closing.set(h.address, []);
      }
    }
    if (!this.client) {
      const context: CollabContext = { actor: 'user', who: this.who };
      this.client = this.deps.collab.handleConnection(this.webSocket, COLLAB_REQUEST, context);
    }
    this.client.handleMessage(data);
  }

  /** Hocuspocus to the client. It tells closes and denials only inside its messages, so they're read here. */
  private collabSend(data: Uint8Array): void {
    if (this.gone) return;
    const h = header(data);
    if (h?.type === MSG_CLOSE) {
      let reason = '';
      try {
        reason = decoding.readVarString(h.decoder);
      } catch {
        // Hocuspocus wrote it, so this can't happen; an empty reason is handled below as any other.
      }
      if (reason === RESET) {
        // It threw on something this client sent: a damaged update, as a rule. This client's state can't be trusted
        // on any page, so the whole connection goes, and deskd's reset brings it back to sync from the top.
        this.drop('collab message refused');
        return;
      }
      this.openPages.delete(h.address);
      if (this.closing.has(h.address)) {
        // The close a provider asked for, done. This answers that provider, which has gone: a new one on the page
        // would take it as its own and stop.
        this.release(h.address);
        return;
      }
      // Refused for size, or on a guild desk for deleting another member's text: the provider stays attached and keeps
      // sending, and that's dropped until it asks again with Auth, as a fresh provider does.
      if (reason === PAGE_FULL || reason === FORBIDDEN || reason === STORAGE_FULL) this.closedPages.add(h.address);
    } else if (h?.type === MSG_AUTH) {
      const kind = this.authType(h.decoder);
      if (kind === AUTH_AUTHENTICATED) {
        this.openPages.add(h.address);
      } else if (kind === AUTH_PERMISSION_DENIED) {
        this.openPages.delete(h.address);
        if (this.closing.has(h.address)) {
          this.release(h.address);
          return;
        }
        this.closedPages.add(h.address);
      }
    }
    // Anything else for a page that's closing is for the provider that has gone.
    if (h && this.closing.has(h.address)) return;
    if (data.length > MAX_COLLAB_MESSAGE) {
      // Over DATA's 4 MiB deskd would close the whole session, Browser included. Only a page too big to sync gets here.
      log('WARN', `message too big for a page, closing it bytes=${data.length}`);
      if (h) {
        this.closedPages.add(h.address);
        this.sendRaw(FRAME_COLLAB, closeMessage(h.address, PAGE_FULL));
      }
      return;
    }
    if (h && this.closedPages.has(h.address) && h.type !== MSG_CLOSE && h.type !== MSG_AUTH) return;
    this.sendRaw(FRAME_COLLAB, data);
  }

  /** The schema an Auth message's token says (ADR 0091). Anything unreadable is 1, the strictest, said by nobody. */
  private tokenSchema(decoder: decoding.Decoder): { schema: number; said: boolean } {
    try {
      if (decoding.readVarUint(decoder) !== AUTH_TOKEN) return { schema: 1, said: false };
      const token = decoding.readVarString(decoder);
      return { schema: schemaOfToken(token), said: tokenSaysSchema(token) };
    } catch {
      return { schema: 1, said: false };
    }
  }

  /**
   * The guard (ADR 0091): a change from an editor older than this build's schema, to a page holding something that editor
   * would drop, such as a block's color. Its empty SyncStep2 as it opens isn't a change, so it can still read the page.
   */
  private fromOlderEditor(address: string, decoder: decoding.Decoder): boolean {
    const schema = this.schemas.get(address)?.schema ?? 1;
    if (schema >= NOTEBOOK_SCHEMA || !this.deps.outdated) return false;
    let update: Uint8Array;
    try {
      const kind = decoding.readVarUint(decoder);
      if (kind !== SYNC_STEP2 && kind !== SYNC_UPDATE) return false;
      update = decoding.readVarUint8Array(decoder);
    } catch {
      return false; // damaged: Hocuspocus's own path refuses it, and the connection resets
    }
    return updateChanges(update) && this.deps.outdated(address, schema);
  }

  /**
   * Refuses an older editor's change whole, before Hocuspocus sees it, and closes the page for that provider as a refused
   * update is closed: it stays attached, and what it sends is dropped until it asks again with Auth. Hocuspocus is told the
   * provider let the page go, so that Auth opens it afresh. A provider that said a schema gets `reload`; one from before
   * the guard said none and knows only `page_full`, which at least stops its editor taking text it can't keep.
   */
  private refuseOlder(address: string): void {
    const { schema, said } = this.schemas.get(address) ?? { schema: 1, said: false };
    log('INFO', `older editor refused page=${address} schema=${said ? schema : 'none'}`);
    if (this.openPages.has(address)) this.onCollab(providerClose(address));
    this.closedPages.add(address);
    this.sendRaw(FRAME_COLLAB, closeMessage(address, said ? RELOAD_REASON : PAGE_FULL));
  }

  private authType(decoder: decoding.Decoder): number | null {
    try {
      return decoding.readVarUint(decoder);
    } catch {
      return null;
    }
  }

  /**
   * Hocuspocus has closed the page, and forgotten it on this connection: what waited goes to it now, in order. Not from
   * inside its send, as it's in the middle of the close, and nothing can come from the socket before a microtask runs.
   */
  private release(address: string): void {
    const held = this.closing.get(address) ?? [];
    this.closing.delete(address);
    if (!held.length) return;
    for (const m of held) this.heldBytes -= m.length;
    queueMicrotask(() => {
      for (const m of held) {
        if (this.gone) return;
        this.onCollab(m);
      }
    });
  }

  private sendJson(value: unknown): void {
    this.sendRaw(FRAME_JSON, Buffer.from(JSON.stringify(value)));
  }

  private sendRaw(type: number, body: Uint8Array): void {
    if (this.gone || this.socket.destroyed) return;
    this.socket.write(encodeFrame(type, body));
    if (this.socket.writableLength > MAX_WRITE_BACKLOG) this.drop('peer not reading');
  }

  /** One line in the log, and the connection closes. Every other session goes on. */
  drop(why: string): void {
    if (this.gone) return;
    log('WARN', `connection ${this.id} dropped: ${why}`);
    this.socket.destroy();
    this.onClose();
  }

  private onClose(): void {
    if (this.gone) return;
    this.gone = true;
    this.webSocket.readyState = WS_CLOSED;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.parts.clear();
    this.subs.clear();
    try {
      this.client?.handleClose({ code: 1000, reason: 'session ended' });
    } catch (e) {
      log('ERROR', `closing collab failed ${errName(e)}`);
    }
    this.onGone(this);
  }
}

/** The listening socket, and what fans out to its sessions. */
export class SocketServer {
  private readonly sessions = new Set<Session>();
  private server: net.Server | null = null;
  private seq = 0;
  private lastPublish = 0;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: SocketDeps) {}

  /** A leftover socket from a dead process is removed. Anything else at that path is a mistake, and stops the start. */
  private clearStale(): void {
    let isSocket: boolean;
    try {
      isSocket = lstatSync(this.deps.path).isSocket();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    if (!isSocket) throw Object.assign(new Error('not a socket'), { name: 'SocketPathHoldsAFile' });
    unlinkSync(this.deps.path);
  }

  async listen(): Promise<void> {
    this.clearStale();
    const server = net.createServer((socket) => {
      this.seq += 1;
      this.sessions.add(new Session(this.seq, socket, this.deps, (s) => this.sessions.delete(s)));
    });
    this.server = server;
    // Node binds inside listen(), so this umask covers the moment the socket appears. Never wider than 0660.
    const before = process.umask(0o117);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.deps.path, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } finally {
      process.umask(before);
    }
    chmodSync(this.deps.path, 0o660);
  }

  /** At most 4 a second, as the contract has it, and always the newest rev. */
  treeChanged(): void {
    if (this.publishTimer) return;
    const wait = Math.max(0, this.lastPublish + MIN_EVENT_INTERVAL_MS - Date.now());
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.lastPublish = Date.now();
      const rev = this.deps.rev();
      for (const s of this.sessions) s.publish(rev);
    }, wait);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** No new connections, and every session ends, so carets go and deskd sees the reset. */
  close(): void {
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.server?.close();
    this.server = null;
    for (const s of [...this.sessions]) s.drop('stopping');
    try {
      unlinkSync(this.deps.path);
    } catch {
      // Already gone.
    }
  }
}
