// A small stand-in for deskd's relay: it speaks the contract's framing on the real socket, and carries real
// @hocuspocus/provider clients through a WebSocketPolyfill, as the Notebook's client adapter will.
import net from 'node:net';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import * as Y from 'yjs';

export const FRAME_JSON = 1;
export const FRAME_COLLAB = 2;

export function frame(type: number, body: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(5 + body.length);
  out.writeUInt32BE(body.length + 1, 0);
  out[4] = type;
  out.set(body, 5);
  return out;
}

export interface RpcError {
  code: string;
  details: Record<string, unknown>;
}

/** One deskd session: one connection, RPC and collab on it. */
export class DeskdSession {
  readonly socket: net.Socket;
  private buf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private calls = new Map<unknown, { resolve: (v: any) => void; reject: (e: RpcError) => void }>();
  readonly events: { sid: unknown; data: any }[] = [];
  closed = false;
  onCollab: ((data: Uint8Array) => void) | null = null;
  onClose: (() => void) | null = null;
  readonly opened: Promise<void>;
  error: Error | null = null;

  /** `hello` false sends none; an object is sent as the hello instead of the owner's. */
  constructor(path: string, hello: boolean | Record<string, unknown> = true) {
    this.socket = net.createConnection(path);
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('connect', () => resolve());
      this.socket.once('error', reject);
    });
    this.socket.on('error', (e) => {
      this.error = e;
    });
    this.socket.on('data', (c) => this.onData(c));
    this.socket.on('close', () => {
      this.closed = true;
      for (const c of this.calls.values()) c.reject({ code: 'unavailable', details: { reason: 'notebook' } });
      this.calls.clear();
      this.onClose?.();
    });
    if (hello === true) this.sendJson({ t: 'hello', sessionId: 's', sub: 'owner' });
    else if (hello) this.sendJson(hello);
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) return;
      const type = this.buf[4] as number;
      const body = this.buf.subarray(5, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      if (type === FRAME_JSON) this.onJson(JSON.parse(body.toString('utf8')));
      else this.onCollab?.(new Uint8Array(body));
    }
  }

  private onJson(m: any): void {
    if (m.t === 'res' || m.t === 'err') {
      const c = this.calls.get(m.id);
      this.calls.delete(m.id);
      if (m.t === 'res') c?.resolve(m.r);
      else c?.reject({ code: m.code, details: m.details ?? {} });
    } else if (m.t === 'evt') {
      this.events.push({ sid: m.sid, data: m.data });
    } else if (m.t === 'health') {
      this.calls.get('health')?.resolve(m);
      this.calls.delete('health');
    }
  }

  sendJson(value: unknown): void {
    if (!this.socket.destroyed) this.socket.write(frame(FRAME_JSON, Buffer.from(JSON.stringify(value))));
  }

  sendCollab(data: Uint8Array): void {
    if (!this.socket.destroyed) this.socket.write(frame(FRAME_COLLAB, data));
  }

  rpc<T = any>(m: string, p: unknown = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.sendJson({ t: 'req', id, m, p });
    });
  }

  health(): Promise<any> {
    return new Promise((resolve, reject) => {
      this.calls.set('health', { resolve, reject });
      this.sendJson({ t: 'health' });
    });
  }

  close(): void {
    this.socket.destroy();
  }

  whenClosed(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((r) => this.socket.once('close', () => r()));
  }
}

/** The client's adapter over one session: the same shape the app's WebSocketPolyfill has. */
function polyfillFor(session: () => DeskdSession) {
  return class RelayWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    binaryType = 'arraybuffer';
    readyState = 0;
    identifier = 0;
    private listeners = new Map<string, Set<(e: any) => void>>();
    private s: DeskdSession;

    constructor(_url: string) {
      this.s = session();
      this.s.onCollab = (data) => {
        const copy = data.slice().buffer;
        this.fire('message', { data: copy });
      };
      this.s.onClose = () => {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.fire('close', { code: 1006, reason: 'reset' });
      };
      this.s.opened.then(
        () => {
          this.readyState = 1;
          this.fire('open', {});
        },
        () => {
          this.readyState = 3;
          this.fire('close', { code: 1006, reason: 'reset' });
        },
      );
    }

    addEventListener(name: string, fn: (e: any) => void): void {
      let set = this.listeners.get(name);
      if (!set) {
        set = new Set();
        this.listeners.set(name, set);
      }
      set.add(fn);
    }

    removeEventListener(name: string, fn: (e: any) => void): void {
      this.listeners.get(name)?.delete(fn);
    }

    private fire(name: string, e: any): void {
      for (const fn of [...(this.listeners.get(name) ?? [])]) fn(e);
    }

    send(data: Uint8Array | ArrayBuffer): void {
      this.s.sendCollab(data instanceof Uint8Array ? data : new Uint8Array(data));
    }

    close(): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.s.close();
      this.fire('close', { code: 1000, reason: '' });
    }
  };
}

/** A client: one virtual socket and any number of providers on it. It reconnects by itself, as the real one does. */
export class Client {
  readonly transport: HocuspocusProviderWebsocket;
  session: DeskdSession | null = null;
  private providers: HocuspocusProvider[] = [];

  constructor(
    private readonly path: string,
    hello: boolean | Record<string, unknown> = true,
  ) {
    const WebSocketPolyfill = polyfillFor(() => {
      this.session = new DeskdSession(this.path, hello);
      return this.session;
    });
    this.transport = new HocuspocusProviderWebsocket({ url: 'ws://desk-notebook.invalid', WebSocketPolyfill, delay: 100, factor: 1.5, maxDelay: 1000, maxAttempts: 0, minDelay: 50, jitter: false } as any);
  }

  open(name: string, doc = new Y.Doc(), extra: Record<string, unknown> = {}): HocuspocusProvider {
    const provider = new HocuspocusProvider({ websocketProvider: this.transport, name, document: doc, token: 'x', ...extra } as any);
    provider.attach();
    this.providers.push(provider);
    return provider;
  }

  destroy(): void {
    for (const p of this.providers.splice(0)) p.destroy();
    this.transport.destroy();
    this.session?.close();
  }
}

export function synced(provider: HocuspocusProvider, timeoutMs = 15_000): Promise<void> {
  if (provider.isSynced) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('never synced')), timeoutMs);
    provider.on('synced', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

export async function until(what: string, fn: () => boolean | Promise<boolean>, timeoutMs = 15_000, stepMs = 10): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
