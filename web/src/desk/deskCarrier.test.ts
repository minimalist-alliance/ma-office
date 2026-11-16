// The office's carrier (W6) against desks in memory that keep the contract (deskd API.md section 18, "Messages between the
// member's desks"): an outbox with ids, a `seq` per grant, `duplicate` by id, `stale` for a seq at or below the last taken from
// that grant, `expired` past 7 days, `revoked` and `no_grant`, and `done` marking rows. The property test carries 10,000
// envelopes between three desks, across several grants both ways, through links dropping and reopening, the carrier destroyed and
// made again mid-flight, desks restarting with calls in flight, and calls that time out after the desk applied them.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { carriedDeskIds } from './carrierRules';
import { BACKOFF_FIRST_MS, BACKOFF_MOST_MS, DeskCarrier, refusalOf, type CarrierLink } from './deskCarrier';
import type { LinkState } from './deskLink';

const DAY = 86_400_000;

type Rng = () => number;
/** A small seeded generator, so a failing run can be run again. */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const refusal = (code: string, reason: string): Error => Object.assign(new Error(`${code} ${reason}`), { code, details: { reason } });
const wire = (code: string): Error => Object.assign(new Error(code), { code, details: {} });
const notConnected = (inFlight: boolean): Error => Object.assign(new Error('not connected'), { name: 'DeskNotConnected', inFlight });

interface Row {
  id: string;
  toDeskId: string;
  grantId: string;
  seq: number;
  envelope: string;
  done: boolean;
  outcome: string | null;
  reason: string | null;
}

/** One desk's side of the contract, kept across restarts: its outbox, what it took, and the halves it revoked. */
class FakeDesk {
  readonly outbox: Row[] = [];
  readonly inbox: { id: string; grantId: string; from: string; seq: number }[] = [];
  private readonly delivered = new Set<string>();
  private readonly lastSeq = new Map<string, number>();
  private readonly seqOut = new Map<string, number>();
  readonly revoked = new Set<string>();
  /** Grants this desk holds an answer half or a send half of; anything else is `no_grant`. */
  readonly grants = new Set<string>();
  private readonly changed = new Set<() => void>();
  private next = 0;

  constructor(
    readonly id: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** An agent here sends on a grant: one envelope in the outbox. */
  send(toDeskId: string, grantId: string, sentAt = this.now()): string {
    const seq = (this.seqOut.get(grantId) ?? 0) + 1;
    this.seqOut.set(grantId, seq);
    this.next += 1;
    const id = `${this.id}-${grantId}-${this.next}`;
    this.outbox.push({ id, toDeskId, grantId, seq, envelope: JSON.stringify({ id, grantId, from: this.id, to: toDeskId, seq, sentAt }), done: false, outcome: null, reason: null });
    this.tell();
    return id;
  }

  onChange(fn: () => void): () => void {
    this.changed.add(fn);
    return () => this.changed.delete(fn);
  }

  private tell(): void {
    for (const fn of this.changed) fn();
  }

  pending(): { toDeskId: string; count: number; oldestAt: number }[] {
    const by = new Map<string, { toDeskId: string; count: number; oldestAt: number }>();
    for (const r of this.outbox) {
      if (r.done) continue;
      const p = by.get(r.toDeskId);
      if (p) p.count += 1;
      else by.set(r.toDeskId, { toDeskId: r.toDeskId, count: 1, oldestAt: 0 });
    }
    return [...by.values()];
  }

  handle(method: string, params: Record<string, unknown>): unknown {
    if (method === 'agent.desks.take') {
      const limit = Math.max(1, Math.min(100, Number(params['limit'] ?? 50)));
      const rows = this.outbox.filter((r) => !r.done && r.toDeskId === params['toDeskId']);
      return { envelopes: rows.slice(0, limit).map((r) => ({ id: r.id, toDeskId: r.toDeskId, envelope: r.envelope })), more: rows.length > limit };
    }
    if (method === 'agent.desks.deliver') {
      const env = JSON.parse(String(params['envelope'])) as { id: string; grantId: string; from: string; to: string; seq: number; sentAt: number };
      if (env.to !== this.id) throw refusal('forbidden', 'not_for_me');
      if (this.delivered.has(env.id)) return { id: env.id, outcome: 'duplicate' };
      const key = `${env.grantId}\n${env.from}`;
      if (env.seq <= (this.lastSeq.get(key) ?? 0)) throw refusal('conflict', 'stale');
      if (this.now() - env.sentAt > 7 * DAY) throw refusal('conflict', 'expired');
      if (this.revoked.has(env.grantId)) throw refusal('forbidden', 'revoked');
      if (!this.grants.has(env.grantId)) throw refusal('forbidden', 'no_grant');
      this.delivered.add(env.id);
      this.lastSeq.set(key, env.seq);
      this.inbox.push({ id: env.id, grantId: env.grantId, from: env.from, seq: env.seq });
      return { id: env.id, outcome: 'delivered' };
    }
    if (method === 'agent.desks.done') {
      let n = 0;
      for (const r of params['results'] as { id: string; outcome: string; reason?: string }[]) {
        const row = this.outbox.find((x) => x.id === r.id);
        if (!row || row.done) continue;
        row.done = true;
        row.outcome = r.outcome;
        row.reason = r.reason ?? null;
        n += 1;
      }
      if (n) this.tell();
      return { done: n };
    }
    throw wire('not_found');
  }
}

const MUTATIONS = new Set(['agent.desks.deliver', 'agent.desks.done']);

interface LinkOpts {
  rng?: Rng;
  /** ms, or 0 for an answer on the next microtask. */
  latency?: () => number;
  /** A call that times out after the desk applied it. */
  pTimeout?: number;
  /** The desk refuses the outbox topic with this code (an older deskd, a Guild Desk). */
  refuseOutbox?: string;
  /** Times each call is made and answered, for the per-hop overhead. */
  clock?: () => number;
}

/** The office's link to one desk, as the carrier sees it: open or not, the outbox topic, and calls that can be lost. */
class FakeLink {
  state: LinkState = 'open';
  private readonly statusFns = new Set<(s: LinkState) => void>();
  private readonly subs = new Set<{ fn: (m: { seq: number; pending: unknown }) => void; refused?: (code: string) => void }>();
  private readonly inflight = new Set<{ drop: (apply: boolean) => void }>();
  private seq = 0;
  private epoch = 0;
  /** The session a snapshot is on its way for: a new session always gets its own, as a real SUB's first event. */
  private snapshotFor = -1;
  readonly log: { m: string; at: number; open: boolean }[] = [];
  readonly answered: { m: string; at: number }[] = [];
  whileClosed = 0;
  wakes = 0;

  constructor(
    readonly desk: FakeDesk,
    private readonly opts: LinkOpts = {},
  ) {
    desk.onChange(() => this.snapshotSoon());
  }

  get deskId(): string {
    return this.desk.id;
  }

  status(): LinkState {
    return this.state;
  }

  onStatus(fn: (s: LinkState) => void): () => void {
    this.statusFns.add(fn);
    return () => this.statusFns.delete(fn);
  }

  /** Never part of what the carrier may call: it's here only to count that nothing does. */
  wake(): void {
    this.wakes += 1;
  }

  subscribe(topic: string, fn: (m: { seq: number; pending: unknown }) => void, refused?: (code: string) => void): () => void {
    expect(topic).toBe('agent.desks.outbox');
    const sub = { fn, ...(refused ? { refused } : {}) };
    this.subs.add(sub);
    if (this.opts.refuseOutbox) setTimeout(() => refused?.(this.opts.refuseOutbox!), 0);
    else this.snapshotSoon();
    return () => this.subs.delete(sub);
  }

  private snapshotSoon(): void {
    if (this.snapshotFor === this.epoch || this.state !== 'open' || this.opts.refuseOutbox) return;
    const at = this.epoch;
    this.snapshotFor = at;
    setTimeout(() => {
      if (this.snapshotFor === at) this.snapshotFor = -1;
      if (at !== this.epoch || this.state !== 'open') return;
      this.seq += 1;
      const pending = this.desk.pending();
      for (const s of this.subs) s.fn({ seq: this.seq, pending });
    }, 0);
  }

  private delay(): number {
    return this.opts.latency ? this.opts.latency() : 0;
  }

  call(method: string, params: Record<string, unknown> = {}, options?: { idem?: string }): Promise<unknown> {
    const clock = this.opts.clock ?? (() => Date.now());
    this.log.push({ m: method, at: clock(), open: this.state === 'open' });
    if (this.state !== 'open') {
      this.whileClosed += 1;
      return Promise.reject(notConnected(false));
    }
    if (MUTATIONS.has(method) && !options?.idem) return Promise.reject(wire('bad_request'));
    const rng = this.opts.rng ?? Math.random;
    return new Promise((resolve, reject) => {
      const at = this.epoch;
      const settle = (): void => {
        this.inflight.delete(entry);
        if (at !== this.epoch) return;
        let result: unknown;
        let error: unknown = null;
        try {
          result = this.desk.handle(method, params);
        } catch (e) {
          error = e;
        }
        this.answered.push({ m: method, at: clock() });
        if (rng() < (this.opts.pTimeout ?? 0)) reject(wire('deadline_exceeded'));
        else if (error) reject(error);
        else resolve(result);
      };
      const ms = this.delay();
      const timer = ms > 0 ? setTimeout(settle, ms) : null;
      const entry = {
        drop: (apply: boolean) => {
          if (timer) clearTimeout(timer);
          if (apply) {
            try {
              this.desk.handle(method, params);
            } catch {
              // a refusal applied nothing
            }
          }
          reject(notConnected(true));
        },
      };
      this.inflight.add(entry);
      if (!timer) queueMicrotask(settle);
    });
  }

  /** The session goes (a dropped network, or the desk restarting): each call in flight is lost, applied or not. */
  drop(reopenAfterMs: number | null): void {
    if (this.state !== 'open') return;
    const rng = this.opts.rng ?? Math.random;
    this.state = 'retrying';
    this.epoch += 1;
    const lost = [...this.inflight];
    this.inflight.clear();
    for (const e of lost) e.drop(rng() < 0.5);
    for (const fn of this.statusFns) fn(this.state);
    if (reopenAfterMs !== null) setTimeout(() => this.reopen(), reopenAfterMs);
  }

  reopen(): void {
    if (this.state === 'open') return;
    this.state = 'open';
    for (const fn of this.statusFns) fn('open');
    this.snapshotSoon();
  }

  close(): void {
    this.drop(null);
    this.state = 'idle';
    for (const fn of this.statusFns) fn('idle');
  }
}

const asLinks = (links: readonly FakeLink[]): CarrierLink[] => links as unknown as CarrierLink[];

/**
 * A link as one carrier sees it, which counts any call made after that carrier was destroyed, and the most deliveries one carrier
 * had in flight at once for one ordered pair (read from the test's own envelope, which the carrier never reads).
 */
function watched(link: FakeLink, gone: () => boolean, after: { n: number; flight: Map<string, number>; most: number }): CarrierLink {
  return {
    get deskId() {
      return link.deskId;
    },
    status: () => link.status(),
    onStatus: (fn: (s: LinkState) => void) => link.onStatus(fn),
    subscribe: ((topic: string, fn: never, refused?: (c: string) => void) => link.subscribe(topic, fn, refused)) as CarrierLink['subscribe'],
    call: ((m: string, p?: Record<string, unknown>, o?: { idem?: string }) => {
      if (gone()) after.n += 1;
      if (m !== 'agent.desks.deliver') return link.call(m, p, o);
      const env = JSON.parse(String(p?.['envelope'])) as { from: string; to: string };
      const key = `${env.from}>${env.to}`;
      const n = (after.flight.get(key) ?? 0) + 1;
      after.flight.set(key, n);
      after.most = Math.max(after.most, n);
      const done = (): void => void after.flight.set(key, (after.flight.get(key) ?? 1) - 1);
      return link.call(m, p, o).finally(done);
    }) as CarrierLink['call'],
  } as CarrierLink;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the carrier, property', () => {
  it('carries 10,000 envelopes through drops, restarts, a new tab and late timeouts: none lost, none doubled, each grant in order, nothing to a closed link', async () => {
    vi.useFakeTimers();
    // One generator plans the envelopes and the faults, another times the links, so the plan is the same whatever the carrier does.
    const plan = mulberry32(0x5eed_0006);
    const rng = mulberry32(0x0ff1ce);
    const desks = ['d-a', 'd-b', 'd-c'].map((id) => new FakeDesk(id));
    const [A, B, C] = desks as [FakeDesk, FakeDesk, FakeDesk];
    // Four grants, each used both ways (messages one way, answers the other), between all three desks.
    const grants: [string, FakeDesk, FakeDesk][] = [
      ['g1', A, B],
      ['g2', A, B],
      ['g3', A, C],
      ['g4', B, C],
    ];
    for (const [g, x, y] of grants) {
      x.grants.add(g);
      y.grants.add(g);
    }
    const streams = grants.flatMap(([g, x, y]) => [
      { g, from: x, to: y },
      { g, from: y, to: x },
    ]);
    const links = desks.map((d) => new FakeLink(d, { rng, latency: () => Math.floor(rng() * 6), pTimeout: 0.02 }));
    let made = 0;
    const counts: { n: number; flight: Map<string, number>; most: number }[] = [];
    const make = (): { carrier: DeskCarrier; gone: boolean } => {
      made += 1;
      const holder = { carrier: null as unknown as DeskCarrier, gone: false };
      const mine = { n: 0, flight: new Map<string, number>(), most: 0 };
      counts.push(mine);
      holder.carrier = new DeskCarrier();
      holder.carrier.setLinks(links.map((l) => watched(l, () => holder.gone, mine)));
      return holder;
    };
    let current = make();
    const sent: { id: string; g: string; from: string; to: string }[] = [];
    const TOTAL = 10_000;
    let drops = 0;
    let restarts = 0;
    let tabs = 0;
    while (sent.length < TOTAL) {
      const k = Math.min(TOTAL - sent.length, Math.floor(plan() * 24));
      for (let i = 0; i < k; i += 1) {
        const s = streams[Math.floor(plan() * streams.length)]!;
        sent.push({ id: s.from.send(s.to.id, s.g), g: s.g, from: s.from.id, to: s.to.id });
      }
      const r = plan();
      const link = links[Math.floor(plan() * links.length)]!;
      const reopenIn = plan();
      if (r < 0.02) {
        drops += 1; // the office reconnecting
        link.drop(5 + Math.floor(reopenIn * 1500));
      } else if (r < 0.03) {
        restarts += 1; // the desk restarting: its calls in flight lost, its outbox and what it took kept
        link.drop(500 + Math.floor(reopenIn * 4000));
      } else if (r < 0.038) {
        tabs += 1; // the tab closing and opening again, mid-flight
        current.carrier.destroy();
        current.gone = true;
        current = make();
      }
      await vi.advanceTimersByTimeAsync(10);
    }
    // Everything heals; the office stays open until every outbox is done.
    for (const l of links) if (l.state !== 'open') l.reopen();
    let waited = 0;
    while (desks.some((d) => d.outbox.some((r) => !r.done)) && waited < 10 * 60_000) {
      for (const l of links) if (l.state !== 'open') l.reopen();
      await vi.advanceTimersByTimeAsync(250);
      waited += 250;
    }
    current.carrier.destroy();

    // The faults bit: envelopes were carried again (`duplicate`) after a lost answer or a closed tab.
    const duplicates = desks.reduce((n, d) => n + d.outbox.filter((r) => r.outcome === 'duplicate').length, 0);
    const calls = links.reduce((n, l) => n + l.log.length, 0);
    console.info(`property: ${TOTAL} envelopes, ${calls} calls, ${drops} drops, ${restarts} restarts, ${tabs} new tabs, ${duplicates} carried again as duplicates, ${waited} ms to settle`);
    expect(duplicates).toBeGreaterThan(0);
    expect(drops).toBeGreaterThan(10);
    expect(restarts).toBeGreaterThan(3);
    expect(tabs).toBeGreaterThan(3);
    expect(made).toBe(tabs + 1);
    // 0 lost, 0 doubled: each envelope taken exactly once by the desk it was for.
    const byDesk = new Map(desks.map((d) => [d.id, d]));
    const seen = new Map<string, number>();
    for (const d of desks) for (const m of d.inbox) seen.set(m.id, (seen.get(m.id) ?? 0) + 1);
    const lost = sent.filter((s) => !seen.has(s.id));
    const doubled = [...seen.values()].filter((n) => n > 1);
    expect(lost).toEqual([]);
    expect(doubled).toEqual([]);
    expect([...seen.keys()].length).toBe(TOTAL);
    for (const s of sent.slice(0, 50)) expect(byDesk.get(s.to)!.inbox.some((m) => m.id === s.id)).toBe(true);
    // Order kept per grant and direction: 1, 2, 3 … with no gap.
    for (const d of desks) {
      const runs = new Map<string, number[]>();
      for (const m of d.inbox) runs.set(`${m.grantId}<${m.from}`, [...(runs.get(`${m.grantId}<${m.from}`) ?? []), m.seq]);
      for (const seqs of runs.values()) expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    }
    // Every row confirmed, and never refused: a stale or expired refusal would have been a loss.
    for (const d of desks) for (const r of d.outbox) expect([r.done, r.outcome === 'delivered' || r.outcome === 'duplicate']).toEqual([true, true]);
    // Nothing to a closed link, and nothing from a carrier once destroyed.
    expect(links.map((l) => l.whileClosed)).toEqual([0, 0, 0]);
    expect(counts.map((c) => c.n)).toEqual(counts.map(() => 0));
    // One loop at a time per ordered pair: never two deliveries of one carrier in flight for the same pair.
    expect(Math.max(...counts.map((c) => c.most))).toBe(1);
    expect(links.map((l) => l.wakes)).toEqual([0, 0, 0]);
    expect(new Set(links.flatMap((l) => l.log.map((c) => c.m)))).toEqual(new Set(['agent.desks.take', 'agent.desks.deliver', 'agent.desks.done']));
  }, 120_000);
});

describe('the carrier, case by case', () => {
  /** Two desks with grants g1 (A → B) and g2, and a carrier between them. */
  function pairUp(opts: LinkOpts = {}): { A: FakeDesk; B: FakeDesk; a: FakeLink; b: FakeLink; carrier: DeskCarrier } {
    const A = new FakeDesk('d-a');
    const B = new FakeDesk('d-b');
    for (const g of ['g1', 'g2']) {
      A.grants.add(g);
      B.grants.add(g);
    }
    const a = new FakeLink(A, opts);
    const b = new FakeLink(B, opts);
    const carrier = new DeskCarrier();
    carrier.setLinks(asLinks([a, b]));
    return { A, B, a, b, carrier };
  }

  it('carries in order, one at a time, and confirms each with its outcome', async () => {
    vi.useFakeTimers();
    const { A, B, a, b, carrier } = pairUp({ latency: () => 3 });
    const ids = [A.send('d-b', 'g1'), A.send('d-b', 'g1'), A.send('d-b', 'g2')];
    await vi.advanceTimersByTimeAsync(200);
    expect(B.inbox.map((m) => m.id)).toEqual(ids);
    expect(A.outbox.map((r) => r.outcome)).toEqual(['delivered', 'delivered', 'delivered']);
    // One delivery at a time: each answered before the next went.
    const delivers = b.log.filter((c) => c.m === 'agent.desks.deliver').map((c) => c.at);
    const answers = b.answered.filter((c) => c.m === 'agent.desks.deliver').map((c) => c.at);
    for (let i = 1; i < delivers.length; i += 1) expect(delivers[i]).toBeGreaterThanOrEqual(answers[i - 1]!);
    expect(a.log.filter((c) => c.m === 'agent.desks.done')).toHaveLength(1);
    carrier.destroy();
  });

  it('a refusal is final: `done` with `refused` and its reason, and the rest still go', async () => {
    vi.useFakeTimers();
    const { A, B, carrier } = pairUp();
    const old = A.send('d-b', 'g1', Date.now() - 8 * DAY); // sent more than 7 days ago
    const fresh = A.send('d-b', 'g2');
    await vi.advanceTimersByTimeAsync(100);
    const row = (id: string) => A.outbox.find((r) => r.id === id)!;
    expect([row(old).done, row(old).outcome, row(old).reason]).toEqual([true, 'refused', 'expired']);
    expect([row(fresh).outcome]).toEqual(['delivered']);
    expect(B.inbox.map((m) => m.id)).toEqual([fresh]);
    carrier.destroy();
  });

  it('a half revoked on the other desk refuses the very next message, `revoked`, and every one after it; other grants go on', async () => {
    vi.useFakeTimers();
    const { A, B, carrier } = pairUp();
    const first = A.send('d-b', 'g1');
    await vi.advanceTimersByTimeAsync(50);
    expect(B.inbox.map((m) => m.id)).toEqual([first]);
    B.revoked.add('g1'); // the member's Stop on B
    const next = [A.send('d-b', 'g1'), A.send('d-b', 'g2'), A.send('d-b', 'g1')];
    await vi.advanceTimersByTimeAsync(50);
    expect(next.map((id) => A.outbox.find((r) => r.id === id)!.reason ?? A.outbox.find((r) => r.id === id)!.outcome)).toEqual(['revoked', 'delivered', 'revoked']);
    expect(B.inbox.map((m) => m.id)).toEqual([first, next[1]]);
    carrier.destroy();
  });

  it('anything else stops the pair, with no `done` for that envelope, and backs off 1 s doubling to 30 s', async () => {
    vi.useFakeTimers();
    const { A, B, b, carrier } = pairUp();
    const handle = B.handle.bind(B);
    let down = true;
    B.handle = (m, p) => {
      if (down && m === 'agent.desks.deliver') throw wire('unavailable');
      return handle(m, p);
    };
    A.send('d-b', 'g1');
    const start = Date.now();
    await vi.advanceTimersByTimeAsync(120_000);
    const tries = b.log.filter((c) => c.m === 'agent.desks.deliver').map((c) => c.at - start);
    const gaps = tries.slice(1).map((t, i) => t - tries[i]!);
    expect(gaps.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    expect(gaps.slice(6).every((g) => g === BACKOFF_MOST_MS)).toBe(true);
    expect(A.outbox[0]!.done).toBe(false);
    down = false;
    await vi.advanceTimersByTimeAsync(BACKOFF_MOST_MS);
    expect(A.outbox[0]!.outcome).toBe('delivered');
    carrier.destroy();
  });

  it('a link that opens starts its pairs again at once, its wait forgotten', async () => {
    vi.useFakeTimers();
    const { A, B, b, carrier } = pairUp();
    const handle = B.handle.bind(B);
    let down = true;
    B.handle = (m, p) => {
      if (down && m === 'agent.desks.deliver') throw wire('unavailable');
      return handle(m, p);
    };
    A.send('d-b', 'g1');
    await vi.advanceTimersByTimeAsync(BACKOFF_FIRST_MS + 2000 + 4000 + 100); // tried 4 times: the next wait is 8 s
    expect(b.log.filter((c) => c.m === 'agent.desks.deliver')).toHaveLength(4);
    down = false;
    b.drop(null);
    await vi.advanceTimersByTimeAsync(500);
    b.reopen();
    await vi.advanceTimersByTimeAsync(20);
    expect(A.outbox[0]!.outcome).toBe('delivered');
    expect(b.whileClosed).toBe(0);
    carrier.destroy();
  });

  it('stops cleanly when links close, never calls a closed one or wakes one, and goes on from a fresh take when they open', async () => {
    vi.useFakeTimers();
    const { A, B, a, b, carrier } = pairUp({ latency: () => 5 });
    for (let i = 0; i < 30; i += 1) A.send('d-b', 'g1');
    await vi.advanceTimersByTimeAsync(22); // part way through
    b.close();
    const callsThen = a.log.length + b.log.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(a.log.length + b.log.length).toBeLessThanOrEqual(callsThen + 1); // at most the `done` for what went through
    expect([a.whileClosed, b.whileClosed, a.wakes, b.wakes]).toEqual([0, 0, 0, 0]);
    expect(B.inbox.length).toBeLessThan(30);
    b.reopen();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(B.inbox.map((m) => m.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(A.outbox.every((r) => r.done)).toBe(true);
    carrier.destroy();
    for (let i = 0; i < 3; i += 1) A.send('d-b', 'g1');
    const before = a.log.length + b.log.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(a.log.length + b.log.length).toBe(before);
  });

  it('a desk that refuses the outbox topic (an older deskd, a Guild Desk) is never taken from or delivered to', async () => {
    vi.useFakeTimers();
    const A = new FakeDesk('d-a');
    const G = new FakeDesk('d-guild');
    A.grants.add('g1');
    const a = new FakeLink(A);
    const g = new FakeLink(G, { refuseOutbox: 'forbidden' });
    const carrier = new DeskCarrier();
    carrier.setLinks(asLinks([a, g]));
    A.send('d-guild', 'g1');
    G.send('d-a', 'g1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect([a.log.length, g.log.length]).toEqual([0, 0]);
    carrier.destroy();
  });

  it('adds well under 100 ms a hop of its own: p95 of its time per envelope with links that answer at once', async () => {
    const clock = (): number => performance.now();
    const A = new FakeDesk('d-a');
    const B = new FakeDesk('d-b');
    A.grants.add('g1');
    B.grants.add('g1');
    const a = new FakeLink(A, { clock });
    const b = new FakeLink(B, { clock });
    const N = 2_000;
    for (let i = 0; i < N; i += 1) A.send('d-b', 'g1');
    const carrier = new DeskCarrier();
    carrier.setLinks(asLinks([a, b]));
    const deadline = performance.now() + 30_000;
    while (B.inbox.length < N && performance.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    carrier.destroy();
    expect(B.inbox.length).toBe(N);
    // Its own time for a hop: from the answer before (the take's, or the last delivery's) to the next delivery going out.
    const events = [...a.answered.filter((e) => e.m === 'agent.desks.take' || e.m === 'agent.desks.done'), ...b.log.filter((e) => e.m === 'agent.desks.deliver').map((e) => ({ m: 'call', at: e.at })), ...b.answered.filter((e) => e.m === 'agent.desks.deliver')].sort((x, y) => x.at - y.at || (x.m === 'call' ? 1 : 0) - (y.m === 'call' ? 1 : 0));
    const own: number[] = [];
    let last: number | null = null;
    for (const e of events) {
      if (e.m === 'call') {
        if (last !== null) own.push(e.at - last);
        last = null;
      } else {
        last = e.at;
      }
    }
    own.sort((x, y) => x - y);
    const p95 = own[Math.floor(own.length * 0.95)]!;
    expect(own.length).toBeGreaterThan(N * 0.9);
    console.info(`carrier's own time per hop: p50 ${own[Math.floor(own.length / 2)]!.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms over ${own.length} hops`);
    expect(p95).toBeLessThan(100);
  });
});

describe('refusals and the desks it carries between', () => {
  it('only the four refusal codes with a reason are final; a session that can’t is not the envelope’s refusal', () => {
    expect(refusalOf(refusal('forbidden', 'revoked'))).toBe('revoked');
    expect(refusalOf(refusal('conflict', 'stale'))).toBe('stale');
    expect(refusalOf(refusal('bad_request', 'envelope'))).toBe('envelope');
    expect(refusalOf(wire('too_large'))).toBe('too_large');
    expect(refusalOf(wire('bad_request'))).toBeNull();
    expect(refusalOf(refusal('forbidden', 'permission'))).toBeNull();
    expect(refusalOf(refusal('forbidden', 'scope'))).toBeNull();
    expect(refusalOf(wire('unavailable'))).toBeNull();
    expect(refusalOf(refusal('rate_limited', 'rate'))).toBeNull();
    expect(refusalOf(notConnected(true))).toBeNull();
  });

  it('never a Guild Desk, by its kind or as a guild’s panel, never a desk left, and nothing for a member with no Agent', () => {
    const desks = [
      { id: 'd-personal', kind: 'personal' },
      { id: 'd-work', kind: 'work' },
      { id: 'd-guild', kind: 'guild' },
      { id: 'guild-g1', kind: 'personal' },
      { id: 'd-left', kind: 'work', removed: true },
    ];
    const ids = ['d-personal', 'd-work', 'd-guild', 'guild-g1', 'd-left', 'd-unknown'];
    expect(carriedDeskIds(ids, desks, true)).toEqual(['d-personal', 'd-work']);
    expect(carriedDeskIds(ids, desks, false)).toEqual([]);
  });
});
