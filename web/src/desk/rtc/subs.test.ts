import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFrame, decodeJson, encodeJson, Kind } from './frames';
import { Subscriptions, type SubEvent, type SubWire } from './subs';

class FakeWire implements SubWire {
  readonly subs: { body: { topic: string; params: Record<string, unknown>; since?: number }; resolve: (r: { subId: number }) => void; reject: (e: unknown) => void }[] = [];
  readonly unsubs: number[] = [];

  sub(body: { topic: string; params: Record<string, unknown>; since?: number }): Promise<{ subId: number }> {
    return new Promise((resolve, reject) => this.subs.push({ body, resolve, reject }));
  }

  unsub(subId: number): Promise<unknown> {
    this.unsubs.push(subId);
    return Promise.resolve({});
  }

  /** The newest SUB gets an answer. */
  answer(subId: number): Promise<void> {
    this.subs[this.subs.length - 1]?.resolve({ subId });
    return Promise.resolve();
  }

  refuse(code: string): Promise<void> {
    this.subs[this.subs.length - 1]?.reject({ code });
    return Promise.resolve();
  }
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

let subs: Subscriptions;
let wire: FakeWire;
let got: SubEvent[];
const listen = (topic = 'summary', params: Record<string, unknown> = {}): (() => void) => subs.subscribe(topic, params, { event: (e) => got.push(e) });
const snapshot = (n: number): { type: string; data: { n: number } } => ({ type: 'snapshot', data: { n } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  subs = new Subscriptions();
  wire = new FakeWire();
  got = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Subscriptions', () => {
  it('asks when attached, and hands on events by subId', async () => {
    listen();
    expect(wire.subs).toHaveLength(0); // no session yet
    subs.attach(wire, false);
    expect(wire.subs[0]?.body).toEqual({ topic: 'summary', params: {} });
    await wire.answer(9);
    await flush();
    subs.onEvent(9, 42, snapshot(1));
    subs.onEvent(9, 43, { type: 'patch', data: { n: 2 } });
    expect(got.map((e) => [e.type, e.seq])).toEqual([['snapshot', 42], ['patch', 43]]);
  });

  it('buffers an event that overtakes its SUB reply, in order, and only for that subId', async () => {
    listen();
    subs.attach(wire, false);
    subs.onEvent(9, 1, snapshot(1));
    subs.onEvent(9, 2, { type: 'patch', data: {} });
    subs.onEvent(77, 1, snapshot(7));
    expect(got).toEqual([]);
    await wire.answer(9);
    await flush();
    expect(got.map((e) => e.seq)).toEqual([1, 2]);
    subs.onEvent(9, 3, { type: 'patch', data: {} });
    expect(got.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('keeps only the newest early events for a subId it never hears about', async () => {
    listen();
    subs.attach(wire, false);
    for (let i = 1; i <= 100; i += 1) subs.onEvent(9, i, { type: 'patch', data: {} });
    await wire.answer(9);
    await flush();
    expect(got).toHaveLength(64);
    expect(got[0]?.seq).toBe(37);
    expect(got[63]?.seq).toBe(100);
  });

  it('one SUB per topic and params, with a listener for each caller; UNSUB when the last leaves', async () => {
    const seen: number[] = [];
    const a = listen();
    const b = subs.subscribe('summary', {}, { event: (e) => seen.push(e.seq) });
    const c = subs.subscribe('summary', { level: 'widgets' }, { event: () => {} });
    subs.attach(wire, false);
    expect(wire.subs.map((s) => s.body.params)).toEqual([{}, { level: 'widgets' }]);
    wire.subs[0]?.resolve({ subId: 9 });
    wire.subs[1]?.resolve({ subId: 10 });
    await flush();
    subs.onEvent(9, 1, snapshot(1));
    expect(got).toHaveLength(1);
    expect(seen).toEqual([1]);
    a();
    expect(wire.unsubs).toEqual([]);
    b();
    expect(wire.unsubs).toEqual([9]);
    c();
    expect(wire.unsubs).toEqual([9, 10]);
    subs.onEvent(9, 2, snapshot(2));
    expect(seen).toEqual([1]);
  });

  it('a new session asks again: fresh after resumed: false, from the last seq after resumed: true', async () => {
    listen();
    subs.attach(wire, false);
    await wire.answer(9);
    await flush();
    subs.onEvent(9, 41, snapshot(1));

    subs.detach();
    const resumed = new FakeWire();
    subs.attach(resumed, true);
    expect(resumed.subs[0]?.body).toEqual({ topic: 'summary', params: {}, since: 41 });
    await resumed.answer(3);
    await flush();
    subs.onEvent(9, 42, snapshot(2)); // the old id means nothing now
    expect(got.map((e) => e.seq)).toEqual([41]);
    subs.onEvent(3, 42, { type: 'patch', data: {} });
    expect(got.map((e) => e.seq)).toEqual([41, 42]);

    subs.detach();
    const fresh = new FakeWire();
    subs.attach(fresh, false);
    expect(fresh.subs[0]?.body).toEqual({ topic: 'summary', params: {} });
  });

  it("ignores a reply from a session that's gone", async () => {
    listen();
    subs.attach(wire, false);
    const next = new FakeWire();
    subs.detach();
    subs.attach(next, false);
    await wire.answer(9); // the old session
    await flush();
    subs.onEvent(9, 1, snapshot(1));
    expect(got).toEqual([]); // still buffered for an id nobody has claimed
    await next.answer(5);
    await flush();
    subs.onEvent(5, 2, snapshot(2));
    expect(got.map((e) => e.seq)).toEqual([2]);
  });

  it('resync asks again from the last seq it handed on, and is not itself handed on', async () => {
    listen();
    subs.attach(wire, false);
    await wire.answer(9);
    await flush();
    subs.onEvent(9, 41, snapshot(1));
    subs.onEvent(9, 41, { type: 'resync', data: {} });
    expect(got).toHaveLength(1);
    expect(wire.subs.at(-1)?.body.since).toBe(41);
    await wire.answer(9);
    await flush();
    subs.onEvent(9, 42, { type: 'patch', data: {} });
    expect(got.map((e) => e.seq)).toEqual([41, 42]);
  });

  it('an error event kills it, and it asks again later, on backoff', async () => {
    listen();
    subs.attach(wire, false);
    await wire.answer(9);
    await flush();
    subs.onEvent(9, 1, snapshot(1));
    subs.onEvent(9, 2, { type: 'error', data: { code: 'internal' } });
    expect(got).toHaveLength(1);
    expect(wire.subs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(700);
    expect(wire.subs).toHaveLength(2);
    expect(wire.subs[1]?.body.since).toBe(1);
  });

  it('an error event with forbidden is final: the caller hears, it does not ask again, and the next session does', async () => {
    const refused: string[] = [];
    subs.subscribe('browser.tabs', {}, { event: (e) => got.push(e), refused: (c) => refused.push(c) });
    subs.attach(wire, false);
    await wire.answer(9);
    await flush();
    subs.onEvent(9, 1, snapshot(1));
    subs.onEvent(9, 2, { type: 'error', data: { code: 'forbidden' } });
    expect(refused).toEqual(['forbidden']);
    expect(got).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(wire.subs).toHaveLength(1);
    subs.detach();
    const next = new FakeWire();
    subs.attach(next, false);
    expect(next.subs).toHaveLength(1);
  });

  it('a topic that ignores since: its snapshot still comes through, on a resumed session', async () => {
    listen('browser.tabs');
    subs.attach(wire, false);
    await wire.answer(9);
    await flush();
    subs.onEvent(9, 41, snapshot(1));
    subs.detach();
    const resumed = new FakeWire();
    subs.attach(resumed, true);
    await resumed.answer(3);
    await flush();
    subs.onEvent(3, 1, snapshot(2)); // a lower seq, and a whole list again
    expect(got.map((e) => [e.type, e.seq])).toEqual([['snapshot', 41], ['snapshot', 1]]);
  });

  it.each(['unavailable', 'rate_limited', 'deadline_exceeded', 'internal'])('%s from SUB retries on backoff', async (code) => {
    const refused: string[] = [];
    subs.subscribe('browser.tabs', {}, { event: () => {}, refused: (c) => refused.push(c) });
    subs.attach(wire, false);
    await wire.refuse(code);
    await flush();
    expect(wire.subs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(700);
    expect(wire.subs).toHaveLength(2);
    await wire.refuse(code);
    await vi.advanceTimersByTimeAsync(1_300);
    expect(wire.subs).toHaveLength(3);
    expect(refused).toEqual([]);
  });

  it('not_found is final for this session, and asks again on the next', async () => {
    const refused: string[] = [];
    subs.subscribe('summary', {}, { event: () => {}, refused: (c) => refused.push(c) });
    subs.attach(wire, false);
    await wire.refuse('not_found');
    await flush();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(wire.subs).toHaveLength(1);
    expect(refused).toEqual(['not_found']);
    subs.detach();
    const next = new FakeWire();
    subs.attach(next, false);
    expect(next.subs).toHaveLength(1);
  });

  it('unsubscribing while the SUB is on its way cleans up when the reply lands', async () => {
    const off = listen();
    subs.attach(wire, false);
    off();
    expect(wire.unsubs).toEqual([]);
    await wire.answer(9);
    await flush();
    expect(wire.unsubs).toEqual([9]);
    subs.onEvent(9, 1, snapshot(1));
    expect(got).toEqual([]);
  });

  it('a detach cancels a retry that was waiting', async () => {
    listen();
    subs.attach(wire, false);
    await wire.refuse('unavailable');
    await flush();
    subs.detach();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wire.subs).toHaveLength(1);
  });

  it('ignores an EVT that is not an event', () => {
    listen();
    subs.attach(wire, false);
    subs.onEvent(9, 1, null);
    subs.onEvent(9, 1, 'text');
    subs.onEvent(9, 1, { data: {} });
    expect(got).toEqual([]);
  });
});

describe("against deskd's golden vectors", () => {
  interface Vector {
    name: string;
    hex: string;
    id: number;
    seq: number;
    payloadText?: string;
  }
  const vectors = (JSON.parse(readFileSync(new URL('../../../../services/deskd/src/test/resources/frames/vectors.json', import.meta.url), 'utf8')) as { valid: Vector[] }).valid;
  const unhex = (h: string): Uint8Array<ArrayBuffer> => new Uint8Array((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));
  const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const vector = (name: string): Vector => vectors.find((v) => v.name === name) as Vector;

  it.each(['sub', 'sub-since'])('%s: what this asks for encodes byte for byte', (name) => {
    const v = vector(name);
    const body = JSON.parse(v.payloadText ?? '{}') as { topic: string; params: Record<string, unknown>; since?: number };
    const bodies: unknown[] = [];
    const recording: SubWire = {
      sub: (b) => {
        bodies.push(b);
        return new Promise(() => {});
      },
      unsub: () => Promise.resolve({}),
    };
    if (body.since !== undefined) {
      // Reaches `since` the way a session does: an event, then a resume.
      const first = new FakeWire();
      subs.subscribe(body.topic, body.params, { event: () => {} });
      subs.attach(first, false);
      first.subs[0]?.resolve({ subId: 1 });
      return flush().then(() => {
        subs.onEvent(1, body.since as number, { type: 'snapshot', data: {} });
        subs.detach();
        subs.attach(recording, true);
        expect(hex((encodeJson(Kind.SUB, v.id, bodies[0]) as Uint8Array[])[0] as Uint8Array)).toBe(v.hex);
      });
    }
    subs.subscribe(body.topic, body.params, { event: () => {} });
    subs.attach(recording, false);
    expect(hex((encodeJson(Kind.SUB, v.id, bodies[0]) as Uint8Array[])[0] as Uint8Array)).toBe(v.hex);
    return undefined;
  });

  it('evt-snapshot and evt-patch reach the listener with their seq and data', async () => {
    listen();
    subs.attach(wire, false);
    await wire.answer(9);
    await flush();
    for (const name of ['evt-snapshot', 'evt-patch']) {
      const f = decodeFrame(unhex(vector(name).hex));
      expect(f.kind).toBe(Kind.EVT);
      subs.onEvent(f.id, f.seq, decodeJson(f.payload));
    }
    expect(got).toEqual([
      { type: 'snapshot', seq: 1, data: { badges: 3 } },
      { type: 'patch', seq: 2, data: { badges: 4 } },
    ]);
  });
});
