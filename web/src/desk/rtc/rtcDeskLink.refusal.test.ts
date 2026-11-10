// Contract 0.3.11: what `connect` can refuse, and the states a new desk arrives in. None of it is retried, and a new
// desk is never asked to start. Everything around the link is faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { api, ApiError } = vi.hoisted(() => {
  class FakeApiError extends Error {
    constructor(readonly status: number, readonly code: string | null = null, readonly details: Record<string, unknown> | null = null) {
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

type Answer = Record<string, unknown> | Error;

function answers(...list: Answer[]): boolean[] {
  const starts: boolean[] = [];
  api.mockImplementation((_path: string, init: { body: string }) => {
    starts.push((JSON.parse(init.body) as { start: boolean }).start);
    const next = list.length > 1 ? list.shift() : list[0];
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve({ status: 200, etag: null, retryAfter: null, data: { phase: null, deskToken: 't', ...next } });
  });
  return starts;
}

const BILLING = 'https://platform.minimalistalliance.com/billing';
const suspended = (...billing: unknown[]) => new ApiError(403, 'account_suspended', billing.length ? { billingUrl: billing[0] } : { billingUrl: BILLING });
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const TEN_MIN = 10 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  api.mockReset();
  const target = { addEventListener() {}, removeEventListener() {} };
  vi.stubGlobal('window', { ...target, setTimeout, clearTimeout, location: { hostname: 'office.minimalistalliance.com' } });
  vi.stubGlobal('document', { ...target, hidden: false });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('refusals', () => {
  it.each([
    ['account_suspended', 'suspended', BILLING],
    ['account_inactive', 'inactive', BILLING],
    ['desk_unavailable', 'unavailable', null],
  ])('%s: the link rests and nothing asks again for ten minutes', async (code, kind, billingUrl) => {
    const starts = answers(new ApiError(403, code, { billingUrl: BILLING }));
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle(TEN_MIN);
    expect(starts).toEqual([false]);
    expect(link.status()).toBe('denied');
    expect(link.details().refusal).toEqual({ kind, billingUrl });
  });

  it.each([
    ['plain http', 'http://platform.minimalistalliance.com/billing'],
    ['another site', 'https://billing.example.com/'],
    ['this app', 'https://office.minimalistalliance.com/billing'],
    ['a port', 'https://platform.minimalistalliance.com:8443/billing'],
    ['not a string', 42],
    ['missing', undefined],
  ])('a billing link that is %s is dropped, and the refusal still stands', async (name, raw) => {
    answers(name === 'missing' ? new ApiError(403, 'account_suspended', {}) : suspended(raw));
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle();
    expect(link.details().refusal).toEqual({ kind: 'suspended', billingUrl: null });
  });

  it('a refused wake is not retried, with start: true or false', async () => {
    const starts = answers({ state: 'stopped', phase: 'stopped' }, { state: 'stopped', phase: 'stopped' }, suspended());
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle();
    link.wake(); // asks with start: false first, then wakes, and that's refused
    await settle(TEN_MIN);
    expect(starts).toEqual([false, false, true]);
    expect(link.details().refusal?.kind).toBe('suspended');
  });

  it("a desk that can't be opened is never asked again: not on a wake, not on a return", async () => {
    const starts = answers(new ApiError(403, 'desk_unavailable'));
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle(TEN_MIN);
    link.wake();
    link.recheck();
    await settle(TEN_MIN);
    expect(starts).toEqual([false]);
  });

  it('the membership: a wake asks nothing, and nothing asks on its own', async () => {
    const starts = answers(suspended());
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle();
    link.wake();
    await settle(TEN_MIN);
    link.wake();
    await settle(TEN_MIN);
    expect(starts).toEqual([false]);
    expect(link.status()).toBe('denied');
  });

  it('paid since: recheck asks once with start: false, finds the desk, and the refusal goes', async () => {
    const starts = answers(suspended(), { state: 'stopped', phase: 'stopped' });
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle();
    link.recheck();
    expect(link.details().refusal).toBeNull(); // at once: the membership is active, so nothing says otherwise
    link.recheck(); // already asking
    await settle(TEN_MIN);
    expect(starts).toEqual([false, false]);
    expect(link.details().refusal).toBeNull();
    expect(link.status()).toBe('idle');
  });

  it('refused again on recheck: the refusal is back, and nothing asks after it', async () => {
    const starts = answers(suspended(), suspended());
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle();
    link.recheck();
    await settle(TEN_MIN);
    expect(starts).toEqual([false, false]);
    expect(link.details().refusal?.kind).toBe('suspended');
    expect(link.status()).toBe('denied');
  });

  it('a recheck on a link that was never refused does nothing', async () => {
    const starts = answers({ state: 'stopped', phase: 'stopped' });
    const link = new RtcDeskLink('d-1');
    link.recheck();
    link.connect();
    await settle();
    link.recheck();
    await settle(TEN_MIN);
    expect(starts).toEqual([false]);
  });

  it('a wake after paying wakes, with one click', async () => {
    const stopped = { state: 'stopped', phase: 'stopped' };
    const starts = answers(suspended(), stopped, stopped, { state: 'starting', phase: 'starting', retryAfterSeconds: 3 });
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle();
    link.recheck();
    await settle();
    link.wake();
    await settle();
    expect(starts).toEqual([false, false, false, true]);
    link.close();
  });

  it('a refresh refused for the membership ends the link, with no refresh loop', async () => {
    const refreshAfter = new Date(Date.now() + 60_000).toISOString();
    const starts = answers({ state: 'running', phase: 'connecting', retryAfterSeconds: 3600, refreshAfter }, suspended());
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle(TEN_MIN);
    expect(starts).toEqual([false, false]);
    expect(link.status()).toBe('denied');
    expect(link.details().refusal?.kind).toBe('suspended');
  });

  it('close() forgets the refusal', async () => {
    answers(suspended());
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle();
    link.close();
    expect(link.details().refusal).toBeNull();
    expect(link.status()).toBe('idle');
  });

  it('anything else in the 403s is the old "access denied", with no refusal', async () => {
    answers(new ApiError(403, 'forbidden'));
    const link = new RtcDeskLink('d-1');
    link.connect();
    await settle();
    expect(link.status()).toBe('denied');
    expect(link.details().refusal).toBeNull();
  });
});

describe('a desk that is still being set up', () => {
  it.each(['requested', 'provisioning'])('%s: connect says so once, the link rests, and a wake never sends start: true', async (state) => {
    const starts = answers({ state, phase: 'starting' });
    const link = new RtcDeskLink('d-1');
    link.connect();
    link.wake();
    await settle(TEN_MIN);
    link.wake();
    await settle(TEN_MIN);
    expect(starts).not.toContain(true);
    expect(link.status()).toBe('idle');
    expect(link.details().desk?.state).toBe(state);
  });
});
