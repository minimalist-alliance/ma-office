// The wake rule: `start: true` only for a member's request, only on a desk `connect` says is stopped,
// and only once per request. Everything around the link is faked; the Playwright specs run it for real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { api, ApiError } = vi.hoisted(() => {
  class FakeApiError extends Error {
    constructor(readonly status: number) {
      super(`HTTP ${status}`);
    }
  }
  return { api: vi.fn(), ApiError: FakeApiError };
});

vi.mock('../../platform/api', () => ({ api, ApiError }));
vi.mock('../../platform/auth', () => ({ SignInRequired: class extends Error {} }));
vi.mock('./identity', () => ({ tabIdentity: () => Promise.resolve({ fingerprint: 'sha-256 AA', certificate: {} }) }));
vi.mock('./peer', () => ({ PeerSession: class {} }));
type Listener = { onMessage(m: Record<string, unknown>): void };
const gw = vi.hoisted(() => ({ sent: [] as Record<string, unknown>[], listeners: new Set<Listener>(), up: true }));
vi.mock('./gateway', () => ({
  GatewayError: class extends Error {},
  gateway: {
    add: (l: Listener) => gw.listeners.add(l),
    remove: (l: Listener) => gw.listeners.delete(l),
    fallbackUrl() {},
    kick() {},
    isUp: () => gw.up,
    ready: () => Promise.resolve(),
    send: (m: Record<string, unknown>) => {
      gw.sent.push(m);
      return gw.up;
    },
    request: () => new Promise(() => {}), // `session.open` never answers here
    serial: 0,
  },
}));
const push = (m: Record<string, unknown>): void => {
  for (const l of gw.listeners) l.onMessage(m);
};

const { RtcDeskLink } = await import('./rtcDeskLink');

type Answer = { state: string; phase?: string; retryAfterSeconds?: number; pollAfterSeconds?: number; retryAfter?: string } | Error;

/** Answers `connect` from a list, and the last one for ever after. Records each `start`. */
function answers(...list: Answer[]): boolean[] {
  const starts: boolean[] = [];
  api.mockImplementation((_path: string, init: { body: string }) => {
    starts.push((JSON.parse(init.body) as { start: boolean }).start);
    const next = list.length > 1 ? list.shift() : list[0];
    if (next instanceof Error) return Promise.reject(next);
    const { retryAfter = null, ...data } = next as Exclude<Answer, Error>;
    return Promise.resolve({ status: 200, etag: null, retryAfter, data: { phase: null, deskToken: 't', ...data } });
  });
  return starts;
}

const STOPPED: Answer = { state: 'stopped', phase: 'stopped' };
const READY = { state: 'running', phase: 'ready', deskIdentity: { fingerprintsSha256: ['aa'] } } as Answer;
const WAKING: Answer = { state: 'starting', phase: 'starting', retryAfterSeconds: 3 };
const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

// Each test an hour on from the last, so the tab's `connect` budget starts empty.
let epoch = Date.UTC(2030, 0, 1);
beforeEach(() => {
  vi.useFakeTimers({ now: (epoch += 3_600_000) });
  api.mockReset();
  gw.sent.length = 0;
  gw.listeners.clear();
  gw.up = true;
  const target = { addEventListener() {}, removeEventListener() {} };
  vi.stubGlobal('window', { ...target, setTimeout, clearTimeout });
  vi.stubGlobal('document', { ...target, hidden: false });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('RtcDeskLink', () => {
  it('opens with start: false, and a stopped desk gets no more connects', async () => {
    const starts = answers(STOPPED);
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle(10 * 60 * 1000);
    expect(starts).toEqual([false]);
    expect(link.status()).toBe('idle');
    expect(link.details().desk?.state).toBe('stopped');
  });

  it('wakes a stopped desk once, then polls with start: false once a second while the member waits (TD-227 part 3)', async () => {
    const starts = answers(STOPPED, STOPPED, WAKING);
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle();
    link.wake();
    await settle();
    expect(starts).toEqual([false, false, true]);
    await settle(900);
    expect(starts).toHaveLength(3);
    await settle(200);
    expect(starts).toEqual([false, false, true, false]);
    await settle(1_000);
    expect(starts).toEqual([false, false, true, false, false]);
    link.close();
  });

  it("the fast poll keeps inside the tab's connect budget: never more than 24 in any minute", async () => {
    const starts = answers(STOPPED, STOPPED, WAKING);
    const at: number[] = [];
    api.mockImplementation((_path: string, init: { body: string }) => {
      at.push(Date.now());
      starts.push((JSON.parse(init.body) as { start: boolean }).start);
      const data = starts.length === 1 || starts.length === 2 ? STOPPED : WAKING;
      return Promise.resolve({ status: 200, etag: null, retryAfter: null, data: { deskToken: 't', ...data } });
    });
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle();
    link.wake();
    await settle(85_000); // inside the 90 s of fast polling
    for (const start of at) expect(at.filter((x) => x >= start && x < start + 60_000).length).toBeLessThanOrEqual(24);
    expect(at.filter((x) => x < at[0]! + 20_000).length).toBeGreaterThanOrEqual(19); // once a second until the budget bites
    link.close();
  });

  it("a wake nobody here asked for keeps connect's 3 s; one the member asked for keeps a pace above it", async () => {
    const other = answers(WAKING);
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle(2_900);
    expect(other).toHaveLength(1);
    await settle(200);
    expect(other).toHaveLength(2);
    link.close();

    const slow = answers(STOPPED, STOPPED, { state: 'starting', phase: 'starting', retryAfterSeconds: 7 });
    const mine = new RtcDeskLink('d-2');
    mine.connect();
    await settle();
    mine.wake();
    await settle(6_900);
    expect(slow).toEqual([false, false, true]);
    await settle(200);
    expect(slow).toEqual([false, false, true, false]);
    mine.close();
  });

  it("the member's press of a waking desk (another tab's wake) makes it poll fast from then on", async () => {
    const starts = answers(WAKING);
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle();
    link.wake();
    await settle(3_100); // the 3 s already set
    expect(starts).toEqual([false, false]);
    await settle(1_000);
    expect(starts).toEqual([false, false, false]);
    link.close();
  });

  it('shows the desk waking from the press, never stopped between it and the wake (no asleep flash)', async () => {
    const starts = answers(STOPPED, STOPPED, WAKING);
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle();
    expect(link.details().desk?.state).toBe('stopped');
    const seen: (string | null | undefined)[] = [];
    link.onDetails(() => seen.push(link.details().desk?.state));
    link.wake();
    expect(link.details().desk).toMatchObject({ state: 'starting', phase: 'starting' }); // before any answer
    await settle();
    expect(starts).toEqual([false, false, true]);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen).not.toContain('stopped');
    expect(link.details().desk?.heardAt).toBe(Date.now());
    link.close();
  });

  it('a wake while the first answer is on its way shows waking from that answer, not stopped', async () => {
    answers(STOPPED, WAKING);
    const link = new RtcDeskLink('d-1');
    const seen: (string | null | undefined)[] = [];
    link.onDetails(() => seen.push(link.details().desk?.state));
    link.connect();
    link.wake();
    await settle();
    expect(seen).toEqual(['starting', 'starting']);
    link.close();
  });

  it('shows nothing early for a desk last heard running or stopping, or never heard', async () => {
    for (const answer of [{ state: 'running', phase: 'connecting' }, { state: 'stopping', phase: 'ready' }] as Answer[]) {
      answers(answer);
      const link = new RtcDeskLink('d-1');
      link.connect();
      await settle();
      const seen: (string | null | undefined)[] = [];
      link.onDetails(() => seen.push(link.details().desk?.state));
      link.wake();
      expect(seen).toEqual([]);
      link.close();
    }
  });

  it('a wake that never got out shows asleep again once the request runs out', async () => {
    answers(STOPPED, new Error('offline'));
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle();
    link.wake();
    await settle(30_000);
    expect(link.details().desk?.state).toBe('starting');
    await settle(120_000); // the first failure after the request's 60 s, on a backoff that tops out at 30 s +-20 %
    expect(link.details().desk?.state).toBe('stopped');
    link.close();
  });

  it("watches a waking desk on the gateway with the wake's own token, and a pushed ready asks connect at once", async () => {
    const starts = answers(STOPPED, STOPPED, WAKING, READY);
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle();
    expect(gw.sent.filter((m) => m['type'] === 'watch')).toEqual([]); // a stopped desk isn't watched
    link.wake();
    await settle();
    expect(gw.sent.filter((m) => m['type'] === 'watch')).toEqual([{ type: 'watch', id: 'watch:d-1', deskId: 'd-1', deskToken: 't' }]);
    expect(starts).toHaveLength(3);
    push({ type: 'desk.progress', deskId: 'd-1', phase: 'connecting' });
    await settle();
    expect(starts).toHaveLength(3);
    push({ type: 'desk.progress', deskId: 'd-1', phase: 'ready' });
    await settle();
    expect(starts).toEqual([false, false, true, false]); // no wait for the poll, and it opens on that answer
    await settle(1_100);
    expect(starts).toHaveLength(4);
    expect(gw.sent.filter((m) => m['type'] === 'watch')).toHaveLength(1); // once per socket
    link.close();
  });

  it("the watch's own answer saying ready asks connect at once too", async () => {
    const starts = answers(STOPPED, STOPPED, WAKING, READY);
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle();
    link.wake();
    await settle();
    push({ type: 'watching', id: 'watch:d-1', deskId: 'd-1', state: 'running', phase: 'ready' });
    await settle();
    expect(starts).toEqual([false, false, true, false]);
    push({ type: 'watching', id: 'watch:d-2', deskId: 'd-2', state: 'running', phase: 'ready' });
    await settle();
    expect(starts).toHaveLength(4); // another desk's
    link.close();
  });

  it('with the gateway down, opens it for the watch and sends it once it is up', async () => {
    gw.up = false;
    answers(STOPPED, STOPPED, WAKING);
    const link = new RtcDeskLink('d-1') as unknown as { connect(): void; wake(): void; close(): void; onUp(): void };
    link.connect();
    await settle();
    link.wake();
    await settle();
    expect(gw.sent.filter((m) => m['type'] === 'watch' && m['deskToken'])).toHaveLength(1); // tried, not sent
    gw.up = true;
    link.onUp();
    expect(gw.sent.filter((m) => m['type'] === 'watch')).toHaveLength(2);
    link.close();
  });

  it("a failure in the fast poll backs off, never sooner than the poll", async () => {
    const starts = answers(STOPPED, STOPPED, WAKING, new Error('offline'), new Error('offline'), WAKING);
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle();
    link.wake();
    await settle(1_000); // the poll: fails
    expect(starts).toHaveLength(4);
    await settle(950);
    expect(starts).toHaveLength(4); // backoff's first 0.5 s would have gone by now
    await settle(100);
    expect(starts).toHaveLength(5); // fails again; the next is 1 s at least (0.8 to 1.2 s with jitter)
    await settle(1_300);
    expect(starts).toHaveLength(6);
    link.close();
  });

  it("a 429 from connect holds every call for its Retry-After", async () => {
    const limited = Object.assign(new ApiError(429), { code: 'rate_limited', details: {}, retryAfterSec: 20 });
    const starts = answers(STOPPED, STOPPED, WAKING, limited, WAKING);
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle();
    link.wake();
    await settle(1_000);
    expect(starts).toHaveLength(4); // refused
    await settle(19_000);
    expect(starts).toHaveLength(4);
    await settle(1_100);
    expect(starts).toHaveLength(5);
    link.close();
  });

  it('a wake while the first answer is on its way waits for what it says', async () => {
    const starts = answers(STOPPED, WAKING);
    const link = new RtcDeskLink('d-1');
    link.connect();
    link.wake();
    await settle();
    expect(starts).toEqual([false, true]);
  });

  it.each([
    ['running', { state: 'running', phase: 'connecting' }],
    ['already waking', WAKING],
    ['stopping', { state: 'stopping', phase: 'stopped' }],
    ['retained', { state: 'retained', phase: 'stopped' }],
  ] as [string, Answer][])('never asks to wake a desk that is %s', async (_name, answer) => {
    const starts = answers(answer);
    const link = new RtcDeskLink('d-1');
    link.connect();
    link.wake();
    await settle(10_000);
    link.wake();
    await settle(10_000);
    expect(starts).not.toContain(true);
  });

  it('a refused wake asks once with start: false and rests, asleep', async () => {
    const starts = answers(STOPPED, new ApiError(409), STOPPED);
    const link = new RtcDeskLink('d-1');
    link.connect();
    link.wake();
    await settle(10 * 60 * 1000);
    expect(starts).toEqual([false, true, false]);
    expect(link.status()).toBe('idle');
    expect(link.details().desk?.state).toBe('stopped');
  });

  it('a wake that hits a passing failure asks again, with no second click', async () => {
    const starts = answers(STOPPED, new ApiError(503), STOPPED, WAKING);
    const link = new RtcDeskLink('d-1');
    link.connect();
    link.wake();
    await settle(5_000);
    expect(starts.slice(0, 4)).toEqual([false, true, false, true]);
    link.close();
  });

  it('a wake that keeps failing gives up when the request runs out, and the desk shows asleep', async () => {
    const failures: Answer[] = [];
    for (let i = 0; i < 40; i++) failures.push(STOPPED, new ApiError(503));
    const starts = answers(...failures);
    const link = new RtcDeskLink('d-1');
    link.connect();
    link.wake();
    await settle(10 * 60 * 1000);
    expect(link.status()).toBe('idle');
    // Backoff tops out at 30 s and the request lasts 60 s, so this stops after a handful, not 40.
    const asked = starts.filter(Boolean).length;
    expect(asked).toBeGreaterThan(1);
    expect(asked).toBeLessThan(12);
  });

  it('a lost answer keeps the request, but not for long', async () => {
    const soon = answers(new Error('offline'), STOPPED, WAKING);
    const link = new RtcDeskLink('d-1');
    link.connect();
    link.wake();
    await settle(1_000);
    expect(soon).toEqual([false, false, true]);
    link.close();

    const late = answers(new Error('offline'), new Error('offline'), new Error('offline'), new Error('offline'), new Error('offline'), new Error('offline'), new Error('offline'), new Error('offline'), STOPPED);
    const offline = new RtcDeskLink('d-2');
    offline.connect();
    offline.wake();
    await settle(10 * 60 * 1000);
    expect(late).not.toContain(true);
    expect(offline.status()).toBe('idle');
  });

  it.each([
    ['retryAfterSeconds', { retryAfterSeconds: 7 }],
    ['pollAfterSeconds', { pollAfterSeconds: 7 }],
    ['the Retry-After header', { retryAfter: '7' }],
  ] as [string, Partial<Exclude<Answer, Error>>][])('while waking, %s sets the pace', async (_name, pace) => {
    const starts = answers({ state: 'starting', phase: 'starting', ...pace });
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle(6_900);
    expect(starts).toHaveLength(1);
    await settle(200);
    expect(starts).toHaveLength(2);
  });

  it('without a pace from connect, waking keeps its 3 s poll', async () => {
    const starts = answers({ state: 'starting', phase: 'starting' });
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle(3_100);
    expect(starts).toHaveLength(2);
  });

  it("an export link asks connect with purpose export and start: true every time, as only the member's download makes one", async () => {
    const bodies: Record<string, unknown>[] = [];
    api.mockImplementation((_path: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return Promise.resolve({ status: 202, etag: null, retryAfter: null, data: { phase: 'starting', deskToken: 't', state: 'starting', retryAfterSeconds: 3 } });
    });
    const link = new RtcDeskLink('d-1', 'export');
    link.connect();
    await settle(3_100);
    expect(bodies).toHaveLength(2);
    for (const b of bodies) expect(b).toMatchObject({ scope: 'owner', purpose: 'export', start: true });
    link.close();

    bodies.length = 0;
    const owner = new RtcDeskLink('d-2');
    owner.connect();
    await settle(100);
    expect(bodies[0]).toMatchObject({ scope: 'owner', start: false });
    expect(bodies[0]).not.toHaveProperty('purpose');
    owner.close();
  });

  it("an export link waits out a desk that's stopping at the pace connect gives, still wanted, rather than going idle", async () => {
    // services/desks wake.ts: a stopping desk with start: true.
    const stopping = Object.assign(new ApiError(409), { code: 'invalid_state', details: { state: 'stopping', retryAfterSeconds: 30 }, retryAfterSec: null });
    const starts = answers(stopping, stopping, WAKING);
    const link = new RtcDeskLink('d-1', 'export');
    const seen: string[] = [];
    link.onStatus((st) => seen.push(st));
    link.connect();
    await settle(2_000);
    expect(starts).toEqual([true]);
    expect(link.status()).toBe('retrying');
    await settle(27_900);
    expect(starts).toHaveLength(1);
    await settle(200);
    expect(starts).toEqual([true, true]);
    await settle(30_100);
    expect(starts).toEqual([true, true, true]); // stopped by now, and woken
    expect(seen).not.toContain('idle');
    link.close();
  });

  it('bulk() is null until a session is open', () => {
    const link = new RtcDeskLink('d-1');
    expect(link.bulk()).toBeNull();
  });
});
