import { describe, expect, it, vi } from 'vitest';
import { CAP_KEY, FIRST_SAMPLE_MS, isCapped, markCapped, nextMidnightUtc, MIN_SAMPLES, SAMPLE_EVERY_MS, SAMPLES, measureAndSend, median, newKey, sampleOf, summarize, watchConnectRtt, type RttDeps, type RttReport, type StatsLike } from './connectRtt';

/** A getStats() report: a transport naming its pair, the pair, and its two candidates. */
function report(o: { rtt?: number; local?: string; remote?: string; state?: string; firefox?: boolean } = {}): StatsLike {
  const pair = { type: 'candidate-pair', id: 'P1', state: o.state ?? 'succeeded', localCandidateId: 'L1', remoteCandidateId: 'R1', ...(o.firefox ? { selected: true } : {}), ...('rtt' in o ? { currentRoundTripTime: o.rtt } : { currentRoundTripTime: 0.042 }) };
  const all = [
    ...(o.firefox ? [] : [{ type: 'transport', id: 'T1', selectedCandidatePairId: 'P1' }]),
    { type: 'candidate-pair', id: 'P0', state: 'failed', currentRoundTripTime: 0.9 },
    pair,
    { type: 'local-candidate', id: 'L1', candidateType: o.local ?? 'host' },
    { type: 'remote-candidate', id: 'R1', candidateType: o.remote ?? 'srflx' },
  ];
  const byId = new Map(all.map((r) => [r.id, r]));
  return { forEach: (cb) => all.forEach(cb), get: (id) => byId.get(id) };
}

describe('connect-time RTT: reading the stats', () => {
  it('reads the selected pair\'s currentRoundTripTime in ms, direct', () => {
    expect(sampleOf(report())).toEqual({ rttMs: 42, relayed: false });
  });

  it('is relayed when either candidate is relay (TURN)', () => {
    expect(sampleOf(report({ local: 'relay' }))?.relayed).toBe(true);
    expect(sampleOf(report({ remote: 'relay' }))?.relayed).toBe(true);
    expect(sampleOf(report({ local: 'prflx', remote: 'host' }))?.relayed).toBe(false);
  });

  it('finds Firefox\'s selected pair with no transport stats', () => {
    expect(sampleOf(report({ firefox: true, rtt: 0.0315 }))).toEqual({ rttMs: 31.5, relayed: false });
  });

  it('has nothing until the pair has succeeded with a round trip', () => {
    expect(sampleOf(report({ state: 'in-progress' }))).toBeNull();
    expect(sampleOf(report({ rtt: undefined }))).toBeNull();
    expect(sampleOf(report({ rtt: Number.NaN }))).toBeNull();
    expect(sampleOf(report({ rtt: -1 }))).toBeNull();
    expect(sampleOf({ forEach: () => {}, get: () => undefined })).toBeNull();
  });

  it('takes the median', () => {
    expect(median([30, 10, 20])).toBe(20);
    expect(median([40, 10, 30, 20])).toBe(25);
    expect(median([7])).toBe(7);
  });

  it(`sends the median of the latest path's samples, with at least ${MIN_SAMPLES} of them`, () => {
    const d = (rttMs: number): RttReport => ({ rttMs, relayed: false });
    const r = (rttMs: number): RttReport => ({ rttMs, relayed: true });
    expect(summarize([d(40), d(44.44), d(41), d(90), d(42)])).toEqual({ rttMs: 42, relayed: false });
    expect(summarize([d(40), null, d(44.44), null, d(41.26)])).toEqual({ rttMs: 41.3, relayed: false });
    // A pair that moved to the relay counts as relayed, with its own samples only.
    expect(summarize([d(20), d(21), r(80), r(82), r(81)])).toEqual({ rttMs: 81, relayed: true });
    expect(summarize([r(80), r(81), d(20), d(21)])).toBeNull();
    expect(summarize([null, null, d(30), d(31)])).toBeNull();
    expect(summarize([])).toBeNull();
  });

  it('makes an Idempotency-Key the Platform takes', () => {
    const a = newKey();
    expect(a).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(newKey()).not.toBe(a);
  });
});

function fakeDeps(o: Partial<RttDeps> & { states?: string[]; rtts?: (number | null)[] } = {}) {
  const waits: number[] = [];
  const sent: Array<{ report: RttReport; key: string }> = [];
  let statsCalls = 0;
  let stateCalls = 0;
  const deps: RttDeps = {
    enabled: async () => true,
    stats: async () => {
      const rtt = o.rtts && statsCalls < o.rtts.length ? o.rtts[statsCalls] : 0.04;
      statsCalls++;
      return rtt === null ? report({ state: 'in-progress' }) : report({ rtt });
    },
    state: () => o.states?.[stateCalls++] ?? 'connected',
    wait: async (ms) => {
      waits.push(ms);
    },
    send: async (report, key) => {
      sent.push({ report, key });
    },
    key: () => 'k-0123456789abcdef',
    ...o,
  };
  return { deps, waits, sent, stats: () => statsCalls };
}

describe('connect-time RTT: measuring and sending once', () => {
  it(`waits ${FIRST_SAMPLE_MS} ms, samples ${SAMPLES} times ${SAMPLE_EVERY_MS} ms apart, and sends {rttMs, relayed} once`, async () => {
    const f = fakeDeps({ rtts: [0.05, 0.041, 0.043, 0.2, 0.042] });
    await expect(measureAndSend(f.deps)).resolves.toBe('sent');
    expect(f.waits).toEqual([FIRST_SAMPLE_MS, SAMPLE_EVERY_MS, SAMPLE_EVERY_MS, SAMPLE_EVERY_MS, SAMPLE_EVERY_MS]);
    expect(f.stats()).toBe(SAMPLES);
    expect(f.sent).toEqual([{ report: { rttMs: 43, relayed: false }, key: 'k-0123456789abcdef' }]);
  });

  it('measures and sends nothing where client-config doesn\'t say so', async () => {
    const f = fakeDeps({ enabled: async () => false });
    await expect(measureAndSend(f.deps)).resolves.toBe('off');
    expect(f.stats()).toBe(0);
    expect(f.waits).toEqual([]);
    expect(f.sent).toEqual([]);
  });

  it('stops quietly when the session closes or fails, and skips a moment it is disconnected', async () => {
    const closed = fakeDeps({ states: ['connected', 'connected', 'closed'] });
    await expect(measureAndSend(closed.deps)).resolves.toBe('closed');
    expect(closed.sent).toEqual([]);
    const failed = fakeDeps({ states: ['failed'] });
    await expect(measureAndSend(failed.deps)).resolves.toBe('closed');
    const blip = fakeDeps({ states: ['connected', 'disconnected', 'connected', 'connected', 'connected'], rtts: [0.03, 0.031, 0.032, 0.033] });
    await expect(measureAndSend(blip.deps)).resolves.toBe('sent');
    expect(blip.stats()).toBe(4);
    expect(blip.sent[0]!.report.rttMs).toBe(31.5);
  });

  it('sends nothing with too few samples', async () => {
    const f = fakeDeps({ rtts: [null, null, null, 0.04, 0.04] });
    await expect(measureAndSend(f.deps)).resolves.toBe('too_few');
    expect(f.sent).toEqual([]);
  });

  it('a failure anywhere stays silent: it resolves, never throws, never retries, never logs', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const broken of [
        { enabled: async () => Promise.reject(new Error('no config')) },
        { stats: async () => Promise.reject(new Error('closed pc')) },
        { state: () => { throw new Error('gone'); } },
        { send: async () => Promise.reject(new Error('404')) },
        { key: () => { throw new Error('no crypto'); } },
      ] as Partial<RttDeps>[]) {
        const f = fakeDeps(broken);
        await expect(measureAndSend(f.deps)).resolves.toBe('failed');
        expect(f.sent).toEqual([]);
      }
      const once = vi.fn(async () => Promise.reject(new Error('503')));
      await measureAndSend(fakeDeps({ send: once }).deps);
      expect(once).toHaveBeenCalledTimes(1);
      expect(spy).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });
});

/** Just enough of an RTCPeerConnection: its state and its listeners. */
class FakePc {
  connectionState = 'new';
  readonly listeners = new Set<() => void>();
  addEventListener(_: string, fn: () => void): void {
    this.listeners.add(fn);
  }
  removeEventListener(_: string, fn: () => void): void {
    this.listeners.delete(fn);
  }
  go(state: string): void {
    this.connectionState = state;
    for (const fn of [...this.listeners]) fn();
  }
}

describe('connect-time RTT: once per peer connection', () => {
  it('starts on the first connected only: an ICE restart, or a second watch, starts nothing more', async () => {
    const pc = new FakePc();
    const runs: string[] = [];
    const make = (_pc: RTCPeerConnection, deskId: string) => {
      runs.push(deskId);
      return fakeDeps().deps;
    };
    watchConnectRtt(pc as unknown as RTCPeerConnection, 'd-testk3m7q2x', make);
    watchConnectRtt(pc as unknown as RTCPeerConnection, 'd-testk3m7q2x', make);
    expect(pc.listeners.size).toBe(1);
    pc.go('connecting');
    expect(runs).toEqual([]);
    pc.go('connected');
    expect(runs).toEqual(['d-testk3m7q2x']);
    expect(pc.listeners.size).toBe(0);
    pc.go('disconnected');
    pc.go('connected');
    expect(runs).toEqual(['d-testk3m7q2x']);
  });

  it('never throws into the session, whatever the connection does', () => {
    const broken = { addEventListener: () => { throw new Error('no events'); } } as unknown as RTCPeerConnection;
    expect(() => watchConnectRtt(broken, 'd-testk3m7q2x')).not.toThrow();
    expect(() => watchConnectRtt(null as unknown as RTCPeerConnection, 'd-testk3m7q2x')).not.toThrow();
  });

  it('a session that fails before connecting sends nothing', () => {
    const pc = new FakePc();
    const make = vi.fn(() => fakeDeps().deps);
    watchConnectRtt(pc as unknown as RTCPeerConnection, 'd-testk3m7q2x', make);
    pc.go('failed');
    pc.go('closed');
    expect(make).not.toHaveBeenCalled();
  });
});

describe('connect-time RTT: the daily cap (429)', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  const NOW = Date.UTC(2026, 10, 10, 15, 30, 0);

  it('a 429 stores the time Retry-After gives, and the member sends nothing until then', () => {
    const st = mem();
    markCapped('sub-a', 3600, NOW, st);
    expect(JSON.parse(st.getItem(CAP_KEY)!)).toEqual({ sub: 'sub-a', until: NOW + 3_600_000 });
    expect(isCapped('sub-a', NOW + 3_599_000, st)).toBe(true);
    expect(isCapped('sub-a', NOW + 3_600_000, st)).toBe(false);
  });

  it('a missing or bad Retry-After holds until the next 00:00 UTC', () => {
    const midnight = Date.UTC(2026, 10, 11);
    expect(nextMidnightUtc(NOW)).toBe(midnight);
    for (const bad of [null, 0, -5, Number.NaN]) {
      const st = mem();
      markCapped('sub-a', bad, NOW, st);
      expect(JSON.parse(st.getItem(CAP_KEY)!).until).toBe(midnight);
    }
  });

  it('another member\'s mark is ignored', () => {
    const st = mem();
    markCapped('sub-a', 3600, NOW, st);
    expect(isCapped('sub-b', NOW, st)).toBe(false);
  });

  it('storage that throws, or holds junk, still works', () => {
    const bad = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); } };
    expect(() => markCapped('sub-a', 60, NOW, bad)).not.toThrow();
    expect(isCapped('sub-a', NOW, bad)).toBe(false);
    expect(isCapped('sub-a', NOW, { getItem: () => '{nope' })).toBe(false);
  });

  it('measureAndSend does nothing while capped, and measures again once it has lifted', async () => {
    const held = fakeDeps({ capped: async () => true });
    await expect(measureAndSend(held.deps)).resolves.toBe('capped');
    expect(held.waits).toEqual([]);
    expect(held.stats()).toBe(0);
    expect(held.sent).toEqual([]);
    const lifted = fakeDeps({ capped: async () => false });
    await expect(measureAndSend(lifted.deps)).resolves.toBe('sent');
    expect(lifted.sent).toHaveLength(1);
  });
});
