// The office's carrier for messages between the member's own desks (W6; deskd API.md section 18, "Messages between the
// member's desks", and ma-platform `docs/maia.md` section 9, the switchboard). Desks never connect to each other, and nothing goes
// through the Platform: while the office holds open links to two of the member's desks, this takes envelopes from one desk's
// outbox and hands each to the other, then tells the first how each went. It reads nothing: an envelope is opaque, and only the
// desks open, check and apply it.
//
// For each ordered pair X → Y (never a Guild Desk: `carrierDoor.ts` decides which links come here), one loop at a time:
//   take from X (`toDeskId: Y`) → deliver each envelope to Y in the order taken, waiting for each answer → `done` on X with
//   every outcome, and again while `more` or X's `agent.desks.outbox` still lists Y.
// A desk's refusal (`bad_request`, `forbidden`, `conflict` or `too_large`, with its reason) is outcome `refused`. Anything else (a
// timeout, `unavailable`, a link that closed) stops the pair where it is, with no `done` for that envelope, and it starts again
// from a fresh take: after 1 s, doubling to 30 s, or at once when a link opens. Retrying is always safe: a desk drops an envelope
// it has by id (`duplicate`) and refuses one older than the last it took from that grant (`stale`), so order holds per pair
// whatever happens here. It calls nothing but over a link that's open, so it never wakes a desk.
//
// Dev, harness and production alike: `MockDeskLink`'s desks serve the same methods (`mockDeskAgent.ts`).
import type { DeskLink, LinkState } from './deskLink';
import { uuidv7 } from './idem';

/** What the carrier needs of a desk's link. */
export type CarrierLink = Pick<DeskLink, 'deskId' | 'status' | 'onStatus' | 'call' | 'subscribe'>;

export const BACKOFF_FIRST_MS = 1_000;
export const BACKOFF_MOST_MS = 30_000;
/** A take asks for this many at most (the contract's default). */
const TAKE_LIMIT = 50;
/** The desk gives up at this point, and the link a little after (API.md section 4). */
const DEADLINE_MS = 15_000;
/** The codes a desk refuses an envelope with: final, reported in `done`. */
const REFUSALS = new Set(['bad_request', 'forbidden', 'conflict', 'too_large']);
/**
 * Reasons that say this session can't, not that the envelope was refused (an owner token without input, an export session): the
 * envelope stays for a session that can, rather than being reported refused and lost.
 */
const SESSION_REASONS = new Set(['permission', 'scope', 'step_up']);

export interface CarrierOptions {
  /** A fresh `idem` for each mutation (deskd API.md section 4). */
  idem?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

interface Desk {
  link: CarrierLink;
  /** This session's outbox has said what waits: until it has, nothing is carried from or to the desk. */
  heard: boolean;
  /** The desks X's outbox lists, by id. */
  lists: Set<string>;
  off: (() => void)[];
}

interface Pair {
  from: string;
  to: string;
  running: boolean;
  /** The outbox listed the other desk while a loop ran: look again when it ends. */
  again: boolean;
  /** The next wait after a failure; 0 after a loop that went through. */
  delay: number;
  timer: unknown;
}

type Outcome = { id: string; outcome: 'delivered' | 'duplicate' } | { id: string; outcome: 'refused'; reason: string };

/** A desk's refusal of an envelope, with its reason, or null for anything that should stop the pair instead. */
export function refusalOf(err: unknown): string | null {
  const e = err as { code?: unknown; details?: unknown } | null;
  if (!e || typeof e.code !== 'string' || !REFUSALS.has(e.code)) return null;
  const details = (e.details && typeof e.details === 'object' ? e.details : {}) as { reason?: unknown };
  const reason = typeof details.reason === 'string' && details.reason ? details.reason : e.code === 'too_large' ? 'too_large' : null;
  if (!reason || SESSION_REASONS.has(reason)) return null;
  return reason;
}

export class DeskCarrier {
  private readonly desks = new Map<string, Desk>();
  private readonly pairs = new Map<string, Pair>();
  private gone = false;
  private readonly idem: () => string;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  constructor(opts: CarrierOptions = {}) {
    this.idem = opts.idem ?? (() => uuidv7());
    this.setTimer = opts.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => globalThis.clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** The member's own desks' links, never a Guild Desk's. A desk no longer named stops at once; a new one is watched. */
  setLinks(links: readonly CarrierLink[]): void {
    if (this.gone) return;
    for (const [id, desk] of this.desks) {
      const now = links.find((l) => l.deskId === id);
      if (now !== desk.link) this.dropDesk(id);
    }
    for (const link of links) if (!this.desks.has(link.deskId)) this.addDesk(link);
  }

  /** The office is done with this member: nothing more is called, and an answer still on its way is dropped. */
  destroy(): void {
    this.gone = true;
    for (const id of [...this.desks.keys()]) this.dropDesk(id);
    for (const p of this.pairs.values()) this.stopTimer(p);
    this.pairs.clear();
  }

  private addDesk(link: CarrierLink): void {
    const desk: Desk = { link, heard: false, lists: new Set(), off: [] };
    this.desks.set(link.deskId, desk);
    desk.off.push(link.onStatus((s) => this.onStatus(link.deskId, s)));
    // Every new session asks again and starts with a snapshot; a desk that refuses it (an older deskd's `not_found`, a Guild
    // Desk's `forbidden`) is never heard, so nothing is carried from or to it.
    desk.off.push(
      link.subscribe(
        'agent.desks.outbox',
        (msg) => this.onOutbox(link.deskId, msg.pending),
        () => {
          desk.heard = false;
          desk.lists.clear();
        },
      ),
    );
  }

  private dropDesk(id: string): void {
    const desk = this.desks.get(id);
    if (!desk) return;
    for (const off of desk.off) off();
    this.desks.delete(id);
    for (const [key, p] of this.pairs) {
      if (p.from !== id && p.to !== id) continue;
      this.stopTimer(p);
      this.pairs.delete(key);
    }
  }

  private onStatus(id: string, state: LinkState): void {
    const desk = this.desks.get(id);
    if (!desk) return;
    if (state !== 'open') {
      // A loop with this desk stops at its next step; the next session's snapshot starts it again.
      desk.heard = false;
      desk.lists.clear();
      return;
    }
    // A link that opens: every pair with it goes again at once, its wait forgotten, once the desks have said what waits.
    for (const p of this.pairs.values()) {
      if (p.from !== id && p.to !== id) continue;
      this.stopTimer(p);
      p.delay = 0;
      p.again = true;
    }
    this.kickAll();
  }

  private onOutbox(id: string, pending: unknown): void {
    const desk = this.desks.get(id);
    if (!desk || desk.link.status() !== 'open') return;
    desk.heard = true;
    desk.lists = new Set(
      (Array.isArray(pending) ? pending : []).flatMap((row: { toDeskId?: unknown; count?: unknown }) =>
        typeof row?.toDeskId === 'string' && row.toDeskId !== id && (typeof row.count !== 'number' || row.count > 0) ? [row.toDeskId] : [],
      ),
    );
    for (const to of desk.lists) {
      const p = this.pair(id, to);
      if (p.running) p.again = true;
    }
    // A desk heard for the first time can also be the other end of a pair that was waiting for it.
    this.kickAll();
  }

  private kickAll(): void {
    for (const [from, desk] of this.desks) for (const to of desk.lists) this.kick(from, to);
    for (const p of this.pairs.values()) if (p.again) this.kick(p.from, p.to);
  }

  private pair(from: string, to: string): Pair {
    const key = `${from}\n${to}`;
    let p = this.pairs.get(key);
    if (!p) this.pairs.set(key, (p = { from, to, running: false, again: false, delay: 0, timer: null }));
    return p;
  }

  /** Both desks are here, open, and have said what waits in this session. */
  private ready(from: string, to: string): boolean {
    const x = this.desks.get(from);
    const y = this.desks.get(to);
    return !this.gone && !!x && !!y && x.heard && y.heard && x.link.status() === 'open' && y.link.status() === 'open';
  }

  private kick(from: string, to: string): void {
    if (this.gone || from === to) return;
    const p = this.pair(from, to);
    if (p.running || p.timer !== null || !this.ready(from, to)) return;
    if (!this.desks.get(from)?.lists.has(to) && !p.again) return;
    p.running = true;
    void this.carry(p).finally(() => {
      p.running = false;
      if (p.again && p.timer === null) this.kick(from, to);
    });
  }

  /** One loop of a pair: take, deliver each in order, `done`, and again while there's more. */
  private async carry(p: Pair): Promise<void> {
    const x = this.desks.get(p.from)?.link;
    const y = this.desks.get(p.to)?.link;
    if (!x || !y) return;
    try {
      for (;;) {
        if (!this.ready(p.from, p.to)) return; // a closed link: its next session's snapshot starts this again
        p.again = false;
        const taken = await x.call('agent.desks.take', { toDeskId: p.to, limit: TAKE_LIMIT }, { deadlineMs: DEADLINE_MS });
        if (this.gone) return;
        const envelopes = (Array.isArray(taken?.envelopes) ? taken.envelopes : []).filter((e): e is { id: string; envelope: unknown } => typeof e?.id === 'string' && e.envelope !== undefined);
        const results: Outcome[] = [];
        let stopped: unknown = null;
        for (const env of envelopes) {
          if (!this.ready(p.from, p.to)) {
            stopped = new Error('closed');
            break;
          }
          try {
            const r = await y.call('agent.desks.deliver', { envelope: env.envelope }, { idem: this.idem(), deadlineMs: DEADLINE_MS });
            results.push({ id: env.id, outcome: r?.outcome === 'duplicate' ? 'duplicate' : 'delivered' });
          } catch (err) {
            const reason = refusalOf(err);
            if (reason === null) {
              stopped = err;
              break;
            }
            results.push({ id: env.id, outcome: 'refused', reason });
          }
          if (this.gone) return; // a closing tab tells nothing more: the next office delivers them again, as duplicates
        }
        // What went through is confirmed even when the pair stops, so it isn't carried again; the envelope that stopped it isn't.
        if (results.length) {
          if (x.status() !== 'open') throw stopped ?? new Error('closed');
          await x.call('agent.desks.done', { results }, { idem: this.idem(), deadlineMs: DEADLINE_MS });
          if (this.gone) return;
        }
        if (stopped) throw stopped;
        p.delay = 0;
        if (!envelopes.length) return;
        if (taken?.more !== true && !this.desks.get(p.from)?.lists.has(p.to) && !p.again) return;
      }
    } catch {
      this.backOff(p);
    }
  }

  private backOff(p: Pair): void {
    if (this.gone || !this.pairs.has(`${p.from}\n${p.to}`)) return;
    p.delay = p.delay ? Math.min(p.delay * 2, BACKOFF_MOST_MS) : BACKOFF_FIRST_MS;
    this.stopTimer(p);
    p.timer = this.setTimer(() => {
      p.timer = null;
      p.again = true;
      this.kick(p.from, p.to);
    }, p.delay);
  }

  private stopTimer(p: Pair): void {
    if (p.timer !== null) this.clearTimer(p.timer);
    p.timer = null;
  }
}
