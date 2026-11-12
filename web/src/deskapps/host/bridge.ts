// The view's one way out (contract 3.2, ADR 0054): a `MessagePort`, in the sample's protocol
// (`spikes/app-contract-sample/app/view/view.js`, written up in `docs/app-api/view-bridge.md`). The office posts
// `{t: "ma.bridge", appApi, tokens}` with the port; the view sends `{t: "call", m, p, idem, id}` and `{t: "sub", topic, id}`;
// the office answers `{t: "res", id, res}` or `{t: "err", id, err}`, sends a subscription's events as `{t: "evt", sub, evt}` and
// a theme switch as `{t: "theme", tokens}`. A call goes to `apps.call` or `apps.mutate` by the manifest's `mutation` flag for that
// method, a mutation keeping the view's own `idem`; a subscription is SUB `app:<id>:<topic>`. Undeclared names, a mutation
// without a key and anything malformed are refused here, before deskd. Nothing the view sends is logged or kept.
import { DeskNotConnected, type DeskRpc, type RawTopicEvent, type RpcOptions } from '../../desk/deskLink';

export interface BridgeApp {
  appId: string;
  methods: ReadonlyMap<string, boolean>;
  topics: ReadonlySet<string>;
}

/** The part of a desk's link the bridge uses. */
export interface BridgeLink {
  call<M extends keyof DeskRpc>(method: M, params?: Record<string, unknown>, options?: RpcOptions): Promise<DeskRpc[M]>;
  subscribeRaw(topic: string, fn: (e: RawTopicEvent) => void, onRefused?: (code: string) => void): () => void;
}

export interface BridgeError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type Route =
  | { kind: 'call'; id: number | string; method: 'apps.call' | 'apps.mutate'; params: { id: string; m: string; p: Record<string, unknown> }; idem?: string }
  | { kind: 'sub'; id: number | string; topic: string }
  | { kind: 'refuse'; id: number | string; err: BridgeError }
  | { kind: 'ignore' };

/** At most this many calls from one view at once, as deskd's limit per app (API.md section 19). */
export const MAX_IN_FLIGHT = 32;
/** And this many subscriptions. */
export const MAX_SUBS = 16;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const okId = (v: unknown): v is number | string => (typeof v === 'number' && Number.isSafeInteger(v)) || (typeof v === 'string' && v.length > 0 && v.length <= 64);
const IDEM = /^[A-Za-z0-9_-]{8,64}$/;
const refuse = (id: number | string, code: string, message: string, reason: string): Route => ({ kind: 'refuse', id, err: { code, message, details: { reason } } });

/** Where one message from the view goes. Pure. */
export function route(app: BridgeApp, msg: unknown): Route {
  if (!isObj(msg) || !okId(msg['id'])) return { kind: 'ignore' };
  const id = msg['id'];
  if (msg['t'] === 'call') {
    const m = msg['m'];
    if (typeof m !== 'string' || m.length > 128) return refuse(id, 'bad_request', 'A method name is needed', 'm');
    const mutation = app.methods.get(m);
    if (mutation === undefined) return refuse(id, 'not_found', 'No such method', 'method');
    const p = msg['p'] ?? {};
    if (!isObj(p)) return refuse(id, 'bad_request', 'Params must be an object', 'p');
    const params = { id: app.appId, m, p };
    if (!mutation) return { kind: 'call', id, method: 'apps.call', params };
    const idem = msg['idem'];
    if (typeof idem !== 'string' || !IDEM.test(idem)) return refuse(id, 'bad_request', 'A mutation needs an idem key', 'idem');
    return { kind: 'call', id, method: 'apps.mutate', params, idem };
  }
  if (msg['t'] === 'sub') {
    const topic = msg['topic'];
    if (typeof topic !== 'string' || !app.topics.has(topic)) return refuse(id, 'not_found', 'No such topic', 'topic');
    return { kind: 'sub', id, topic };
  }
  return { kind: 'ignore' };
}

/** A failure as the view hears it: deskd's code, message and details, or the link's absence as `unavailable`. */
export function asBridgeError(err: unknown): BridgeError {
  if (err instanceof DeskNotConnected) return { code: 'unavailable', message: 'The desk is not connected', details: { reason: 'link' } };
  const e = err as { code?: unknown; message?: unknown; details?: unknown } | null;
  const code = typeof e?.code === 'string' && e.code ? e.code : 'internal';
  const message = typeof e?.message === 'string' ? e.message.slice(0, 200) : '';
  return { code, message, ...(isObj(e?.details) ? { details: e.details } : {}) };
}

/**
 * One view's bridge over one port. `link()` is the desk's link now, or null when there's none (a call then fails as
 * `unavailable`, which the sample view retries with the same key). `close()` ends every subscription and the port.
 */
export class ViewBridge {
  private inFlight = 0;
  private subs = new Map<number, () => void>();
  private nextSub = 1;
  private closed = false;

  constructor(
    private readonly app: BridgeApp,
    private readonly link: () => BridgeLink | null,
    private readonly port: MessagePort,
  ) {
    port.onmessage = (e: MessageEvent) => this.onMessage(e.data);
    port.start();
  }

  theme(tokens: Record<string, string>): void {
    if (!this.closed) this.port.postMessage({ t: 'theme', tokens });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.subs.values()) off();
    this.subs.clear();
    this.port.onmessage = null;
    this.port.close();
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.closed) this.port.postMessage(msg);
  }

  private onMessage(data: unknown): void {
    if (this.closed) return;
    const r = route(this.app, data);
    if (r.kind === 'ignore') return;
    if (r.kind === 'refuse') {
      this.send({ t: 'err', id: r.id, err: r.err });
      return;
    }
    if (r.kind === 'sub') {
      this.subscribe(r.id, r.topic);
      return;
    }
    if (this.inFlight >= MAX_IN_FLIGHT) {
      this.send({ t: 'err', id: r.id, err: { code: 'rate_limited', message: 'Too many calls at once', details: { limit: 'appCalls' } } });
      return;
    }
    const link = this.link();
    if (!link) {
      this.send({ t: 'err', id: r.id, err: asBridgeError(new DeskNotConnected('')) });
      return;
    }
    this.inFlight += 1;
    const call = r.method === 'apps.mutate' ? link.call('apps.mutate', r.params, { idem: r.idem! }) : link.call('apps.call', r.params);
    call.then(
      (res) => this.send({ t: 'res', id: r.id, res }),
      (err: unknown) => this.send({ t: 'err', id: r.id, err: asBridgeError(err) }),
    ).finally(() => {
      this.inFlight -= 1;
    });
  }

  /** Answered with `{subId}` on its first event, so the view's listener is there before any event; refused before one, an `err`. */
  private subscribe(id: number | string, topic: string): void {
    if (this.subs.size >= MAX_SUBS) {
      this.send({ t: 'err', id, err: { code: 'rate_limited', message: 'Too many subscriptions', details: { limit: 'subs' } } });
      return;
    }
    const link = this.link();
    if (!link) {
      this.send({ t: 'err', id, err: asBridgeError(new DeskNotConnected('')) });
      return;
    }
    const subId = this.nextSub++;
    let answered = false;
    let ended = false;
    const off = link.subscribeRaw(
      `app:${this.app.appId}:${topic}`,
      (e) => {
        if (!answered) {
          answered = true;
          this.send({ t: 'res', id, res: { subId } });
        }
        this.send({ t: 'evt', sub: subId, evt: { type: e.type, data: e.data } });
      },
      (code) => {
        if (!answered) {
          answered = true;
          this.send({ t: 'err', id, err: { code, message: 'Subscription refused', details: { reason: 'topic' } } });
        }
        ended = true;
        this.subs.get(subId)?.();
        this.subs.delete(subId);
      },
    );
    if (ended) off();
    else this.subs.set(subId, off);
  }
}
