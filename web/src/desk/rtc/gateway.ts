// The tab's one WebSocket to the gateway (contract gateway.md, 0.3.3): control and signaling only.
// No credentials at upgrade; a desk token goes in each desk-scoped message. It reconnects while a
// link wants it, and each link then resumes its own session, so PeerConnections are untouched.
import { getClientConfig } from '../../platform/clientConfig';
import { backoffMs } from './backoff';

const SUBPROTOCOL = 'ma.gw.v1';
// At least every 45 s (ma-platform ADR 0108): behind gw.'s firewall a socket idle for about 100 s is closed.
// Chrome may stretch a hidden tab's timer to once a minute, which still beats 100 s.
const PING_EVERY_MS = 40_000;
const OPEN_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 32 * 1024;
const STABLE_MS = 10_000;

export interface GatewayMessage {
  type: string;
  id?: string;
  deskId?: string;
  sessionId?: string;
  code?: string;
  message?: string;
  reason?: string;
  retryable?: boolean;
  data?: unknown;
  iceServers?: RTCIceServer[];
  state?: string;
  phase?: string;
  stopAt?: string;
  queue?: { position?: number } | null;
}

export class GatewayError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface GatewayListener {
  /** Every message that isn't the reply to a `request`, and replies with `iceServers`. Filter on your own deskId and sessionId. */
  onMessage(m: GatewayMessage): void;
  /** The WebSocket is up, the first time or again. */
  onUp(): void;
  /** Keep reconnecting for this listener? */
  wantsGateway(): boolean;
}

interface Pending {
  resolve: (m: GatewayMessage) => void;
  reject: (e: Error) => void;
  timer: number;
}

class Gateway {
  private ws: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private url: string | null = null;
  private readonly listeners = new Set<GatewayListener>();
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private pingTimer = 0;
  private reconnectTimer = 0;
  private attempt = 0;
  private openedAt = 0;
  /** Bumps per WebSocket, so a link knows when its `watch` needs sending again. */
  serial = 0;

  add(l: GatewayListener): void {
    this.listeners.add(l);
  }

  remove(l: GatewayListener): void {
    this.listeners.delete(l);
  }

  /** The URL comes from client-config. `connect` also carries it; that's the fallback. */
  fallbackUrl(url: string | undefined): void {
    if (url) this.url ??= url;
  }

  /** Resolves when the WebSocket is open. */
  ready(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    this.opening ??= this.open().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  isUp(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** False when the WebSocket isn't open or the frame is too big. */
  send(m: GatewayMessage): boolean {
    if (!this.isUp()) return false;
    const text = JSON.stringify(m);
    if (new TextEncoder().encode(text).length > MAX_FRAME_BYTES) return false;
    this.ws?.send(text);
    return true;
  }

  /** Sends with a fresh `id` and resolves with the reply that echoes it; `error` rejects. */
  async request(m: GatewayMessage, timeoutMs: number): Promise<GatewayMessage> {
    await this.ready();
    const id = `r${this.nextId++}`;
    return new Promise<GatewayMessage>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayError('timeout', `no reply to ${m.type}`, true));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.send({ ...m, id })) {
        window.clearTimeout(timer);
        this.pending.delete(id);
        reject(new GatewayError('gateway_down', `couldn't send ${m.type}`, true));
      }
    });
  }

  /** An `online` event or tab focus: try now rather than at the next backoff step. */
  kick(): void {
    if (this.reconnectTimer && !this.isUp()) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = 0;
      void this.ready().catch(() => this.scheduleReconnect(false));
    }
  }

  private async open(): Promise<void> {
    const url = (await getClientConfig()).gateway ?? this.url;
    if (!url) throw new GatewayError('no_gateway', 'client-config has no gateway URL');
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, SUBPROTOCOL);
      const timer = window.setTimeout(() => {
        ws.onclose = null;
        ws.close();
        reject(new GatewayError('gateway_down', "couldn't reach the gateway", true));
      }, OPEN_TIMEOUT_MS);
      ws.onopen = () => {
        window.clearTimeout(timer);
        this.adopt(ws);
        resolve();
      };
      ws.onclose = () => {
        window.clearTimeout(timer);
        reject(new GatewayError('gateway_down', "couldn't reach the gateway", true));
      };
    }).catch((err: unknown) => {
      this.scheduleReconnect(false);
      throw err;
    });
  }

  private adopt(ws: WebSocket): void {
    this.ws = ws;
    this.serial += 1;
    this.openedAt = Date.now();
    ws.onmessage = (e) => this.onFrame(e.data);
    ws.onclose = (e) => this.onClosed(ws, e.code);
    window.clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => this.send({ type: 'ping' }), PING_EVERY_MS);
    for (const l of this.listeners) l.onUp();
  }

  private onFrame(data: unknown): void {
    if (typeof data !== 'string') return;
    let m: GatewayMessage;
    try {
      m = JSON.parse(data) as GatewayMessage;
    } catch {
      return;
    }
    const waiter = m.id ? this.pending.get(m.id) : undefined;
    if (waiter && m.id) {
      this.pending.delete(m.id);
      window.clearTimeout(waiter.timer);
      if (m.type === 'error') waiter.reject(new GatewayError(m.code ?? 'error', m.message ?? 'gateway error', m.retryable));
      else waiter.resolve(m);
      // New TURN servers (`session.opened`, `session.refreshed`; gateway.md 2.4) go on to the links too, for that session's connection.
      if (m.type === 'error' || !Array.isArray(m.iceServers)) return;
    }
    if (m.type === 'pong') return;
    for (const l of this.listeners) l.onMessage(m);
  }

  private onClosed(ws: WebSocket, code: number): void {
    if (this.ws !== ws) return;
    this.ws = null;
    window.clearInterval(this.pingTimer);
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      window.clearTimeout(p.timer);
      p.reject(new GatewayError('gateway_down', 'the gateway connection closed', true));
    }
    const stable = Date.now() - this.openedAt > STABLE_MS;
    if (stable) this.attempt = 0;
    // 1001 is the 2 h lifetime: nothing is wrong, so come straight back.
    this.scheduleReconnect(code === 1001 && stable);
  }

  private scheduleReconnect(now: boolean): void {
    if (this.reconnectTimer || this.isUp()) return;
    if (![...this.listeners].some((l) => l.wantsGateway())) return;
    // Gateway backoff starts at 1 s (gateway.md section 1): one step later than the link's.
    const delay = now ? 0 : backoffMs(this.attempt + 1);
    this.attempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = 0;
      void this.ready().catch(() => {
        /* open() already scheduled the next try */
      });
    }, delay);
  }
}

export const gateway = new Gateway();
