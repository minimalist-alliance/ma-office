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
vi.mock('./gateway', () => ({
  GatewayError: class extends Error {},
  gateway: { add() {}, remove() {}, fallbackUrl() {}, kick() {}, send: () => true, serial: 0 },
}));

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
const WAKING: Answer = { state: 'starting', phase: 'starting', retryAfterSeconds: 3 };
const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
  api.mockReset();
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

  it('wakes a stopped desk once, then polls with start: false at the pace connect asks for', async () => {
    const starts = answers(STOPPED, STOPPED, WAKING);
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle();
    link.wake();
    await settle();
    expect(starts).toEqual([false, false, true]);
    await settle(2_900);
    expect(starts).toHaveLength(3);
    await settle(200);
    expect(starts).toEqual([false, false, true, false]);
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
