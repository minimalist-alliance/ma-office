// SUB, UNSUB and EVT (services/deskd/docs/API.md section 5). It knows no topics and no WebRTC, and it
// outlives sessions: `attach` asks for everything again on each new one.
import { backoffMs } from './backoff';

export interface SubEvent {
  type: string;
  seq: number;
  data: unknown;
}

export interface SubHandlers {
  event(e: SubEvent): void;
  /** deskd said no and asking again won't help until the next session, such as `not_found` for a topic it doesn't serve yet. */
  refused?(code: string): void;
}

/** What a subscription needs from a session. */
export interface SubWire {
  sub(body: { topic: string; params: Record<string, unknown>; since?: number }): Promise<{ subId: number }>;
  unsub(subId: number): Promise<unknown>;
}

interface Entry {
  key: string;
  topic: string;
  params: Record<string, unknown>;
  handlers: Set<SubHandlers>;
  subId: number | null;
  /** The last seq handed on, which is what `since` means. */
  lastSeq: number | null;
  asking: boolean;
  /** Asked again while a SUB was on its way. */
  again: boolean;
  attempt: number;
  timer: number;
}

/** No point asking again in this session. Everything else (`unavailable`, a timeout) is worth another try. */
const FINAL = new Set(['not_found', 'bad_request', 'unauthorized', 'forbidden', 'step_up_required', 'too_large']);

// An event can overtake its SUB's reply, but only by moments. These bound what a confused desk can make us hold.
const EARLY_PER_SUB = 64;
const EARLY_SUBS = 16;

export class Subscriptions {
  private wire: SubWire | null = null;
  private readonly entries = new Map<string, Entry>();
  private readonly byId = new Map<number, Entry>();
  private readonly early = new Map<number, SubEvent[]>();
  /** Bumps per session, so a reply from an old one is ignored. */
  private epoch = 0;

  /** One SUB on the wire per topic and params, however many listeners. Returns the unsubscribe. */
  subscribe(topic: string, params: Record<string, unknown>, handlers: SubHandlers): () => void {
    const key = JSON.stringify([topic, params]);
    let entry = this.entries.get(key);
    if (entry) {
      entry.handlers.add(handlers);
    } else {
      entry = { key, topic, params, handlers: new Set([handlers]), subId: null, lastSeq: null, asking: false, again: false, attempt: 0, timer: 0 };
      this.entries.set(key, entry);
      this.ask(entry);
    }
    const held = entry;
    return () => {
      held.handlers.delete(handlers);
      if (!held.handlers.size && this.entries.get(key) === held) this.drop(held);
    };
  }

  /**
   * A session has said HELLO. `resumed` is its reply: only then does `since` mean anything, since a
   * desk that restarted has started its seq over.
   */
  attach(wire: SubWire, resumed: boolean): void {
    this.detach();
    this.wire = wire;
    for (const entry of this.entries.values()) {
      if (!resumed) entry.lastSeq = null;
      entry.attempt = 0;
      this.ask(entry);
    }
  }

  /** The session is gone. Everything waits for the next `attach`. */
  detach(): void {
    this.wire = null;
    this.epoch += 1;
    this.byId.clear();
    this.early.clear();
    for (const entry of this.entries.values()) {
      window.clearTimeout(entry.timer);
      entry.timer = 0;
      entry.subId = null;
      entry.asking = false;
      entry.again = false;
    }
  }

  /** An EVT frame. Its `id` is the subId. */
  onEvent(subId: number, seq: number, body: unknown): void {
    if (!body || typeof body !== 'object') return;
    const { type, data } = body as { type?: unknown; data?: unknown };
    if (typeof type !== 'string') return;
    const e: SubEvent = { type, seq, data };
    const entry = this.byId.get(subId);
    if (entry) {
      this.deliver(entry, e);
      return;
    }
    const held = this.early.get(subId);
    if (held) {
      held.push(e);
      if (held.length > EARLY_PER_SUB) held.shift();
    } else if (this.early.size < EARLY_SUBS) {
      this.early.set(subId, [e]);
    }
  }

  private deliver(entry: Entry, e: SubEvent): void {
    if (e.type === 'resync') {
      this.ask(entry); // from the last seq handed on: a replay or a snapshot follows
      return;
    }
    if (e.type === 'error') {
      if (entry.subId !== null) this.byId.delete(entry.subId);
      entry.subId = null;
      const code = (e.data as { code?: string } | null)?.code ?? '';
      // `forbidden`: a token refresh took away what this needs. Asking again won't help until the next session.
      if (FINAL.has(code)) for (const h of entry.handlers) h.refused?.(code);
      else this.later(entry);
      return;
    }
    entry.lastSeq = e.seq;
    for (const h of entry.handlers) h.event(e);
  }

  private ask(entry: Entry): void {
    const wire = this.wire;
    if (!wire) return;
    if (entry.asking) {
      entry.again = true;
      return;
    }
    entry.asking = true;
    const epoch = this.epoch;
    const { topic, params, lastSeq } = entry;
    wire.sub(lastSeq === null ? { topic, params } : { topic, params, since: lastSeq }).then(
      ({ subId }) => {
        if (epoch !== this.epoch) return;
        entry.asking = false;
        if (this.entries.get(entry.key) !== entry) {
          wire.unsub(subId).catch(() => {}); // unsubscribed while this was on its way
          return;
        }
        entry.attempt = 0;
        entry.subId = subId;
        this.byId.set(subId, entry);
        const held = this.early.get(subId);
        this.early.delete(subId);
        if (held) for (const e of held) this.deliver(entry, e);
        if (entry.again) {
          entry.again = false;
          this.ask(entry);
        }
      },
      (err: unknown) => {
        if (epoch !== this.epoch || this.entries.get(entry.key) !== entry) return;
        entry.asking = false;
        entry.again = false;
        const code = (err as { code?: string } | null)?.code ?? '';
        if (FINAL.has(code)) for (const h of entry.handlers) h.refused?.(code);
        else this.later(entry);
      },
    );
  }

  private later(entry: Entry): void {
    window.clearTimeout(entry.timer);
    entry.timer = window.setTimeout(() => {
      entry.timer = 0;
      this.ask(entry);
    }, backoffMs(entry.attempt));
    entry.attempt += 1;
  }

  private drop(entry: Entry): void {
    this.entries.delete(entry.key);
    window.clearTimeout(entry.timer);
    if (entry.subId === null) return; // a SUB still on its way cleans up after itself
    this.byId.delete(entry.subId);
    this.early.delete(entry.subId);
    this.wire?.unsub(entry.subId).catch(() => {});
  }
}
