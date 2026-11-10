// How a fresh token reaches the desk. Both ways on every refresh, and a `session.resume` the gateway can't
// relay doesn't cost the session. The gateway and the peer are faked; the link between them is the real code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { api, gateway, peers } = vi.hoisted(() => ({
  api: vi.fn(),
  peers: [] as { sendAuth: ReturnType<typeof vi.fn>; closed: boolean }[],
  gateway: {
    request: vi.fn(),
    answer: (() => {}) as (sessionId: string | undefined) => void,
    sent: [] as { type: string; deskToken?: string }[],
    add() {},
    remove() {},
    fallbackUrl() {},
    kick() {},
    serial: 1,
    send(m: { type: string; sessionId?: string }): boolean {
      gateway.sent.push(m);
      if (m.type === 'signal') gateway.answer(m.sessionId);
      return true;
    },
  },
}));

vi.mock('../../platform/api', () => ({ api, ApiError: class extends Error {} }));
vi.mock('../../platform/auth', () => ({ SignInRequired: class extends Error {} }));
vi.mock('./identity', () => ({ tabIdentity: () => Promise.resolve({ fingerprint: 'sha-256 AA', certificate: {} }) }));
vi.mock('./sdp', () => ({ answerMatchesIdentity: () => true }));
vi.mock('./gateway', () => ({
  GatewayError: class extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly retryable = false,
    ) {
      super(message);
    }
  },
  gateway,
}));
vi.mock('./peer', () => ({
  PeerSession: class {
    channelsOpen = Promise.resolve();
    sendAuth = vi.fn();
    closed = false;
    constructor() {
      peers.push(this);
    }
    createOffer = () => Promise.resolve('offer');
    applyAnswer = () => Promise.resolve();
    media = () => ({ stream: {}, canPlayVideo: true });
    hello = () => Promise.resolve({ deskApi: '1.0', resumeToken: 'r' });
    startPings() {}
    resetPings() {}
    recheck() {}
    close() {
      this.closed = true;
    }
    path = () => Promise.resolve('udp');
  },
}));

const { RtcDeskLink } = await import('./rtcDeskLink');
const { GatewayError } = await import('./gateway');

const REFRESH_MS = 60_000;
let tokens = 0;

const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};
const requests = (type: string): { type: string; deskToken?: string }[] => gateway.request.mock.calls.map(([m]) => m as { type: string; deskToken?: string }).filter((m) => m.type === type);
const lastPeer = (): (typeof peers)[number] => peers[peers.length - 1] as (typeof peers)[number];

async function openLink(): Promise<InstanceType<typeof RtcDeskLink>> {
  const link = new RtcDeskLink('d-1');
  gateway.answer = (sessionId) => link.onMessage({ type: 'signal', sessionId, data: { type: 'answer', sdp: 'answer' } });
  link.connect();
  await settle();
  expect(link.status()).toBe('open');
  return link;
}

beforeEach(() => {
  vi.useFakeTimers();
  tokens = 0;
  peers.length = 0;
  gateway.sent.length = 0;
  gateway.request.mockReset();
  gateway.request.mockImplementation((m: { type: string }) => Promise.resolve({ type: m.type === 'session.refresh' ? 'session.refreshed' : 'session.opened', sessionId: 'cs-1', iceServers: [] }));
  api.mockReset();
  api.mockImplementation(() =>
    Promise.resolve({
      status: 200,
      etag: null,
      retryAfter: null,
      data: { state: 'running', phase: 'ready', deskToken: `t${++tokens}`, refreshAfter: new Date(Date.now() + REFRESH_MS / 0.9).toISOString(), deskIdentity: { fingerprintsSha256: ['aa'] } },
    }),
  );
  const target = { addEventListener() {}, removeEventListener() {} };
  vi.stubGlobal('window', { ...target, setTimeout, clearTimeout });
  vi.stubGlobal('document', { ...target, hidden: false });
  vi.stubGlobal('__MA_VERSION__', 'test');
  vi.stubGlobal('performance', { now: () => Date.now(), measure() {}, mark() {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a refresh', () => {
  it('sends the same token on ctl and through the gateway', async () => {
    const link = await openLink();
    expect(lastPeer().sendAuth).not.toHaveBeenCalled();
    await settle(REFRESH_MS + 100);
    expect(lastPeer().sendAuth).toHaveBeenCalledTimes(1);
    expect(lastPeer().sendAuth).toHaveBeenCalledWith('t2');
    expect(requests('session.refresh').map((m) => m.deskToken)).toEqual(['t2']);
    await settle(REFRESH_MS);
    expect(lastPeer().sendAuth).toHaveBeenLastCalledWith('t3');
    expect(requests('session.refresh').map((m) => m.deskToken)).toEqual(['t2', 't3']);
    expect(link.status()).toBe('open');
    link.close();
  });

  it.each([
    ['the gateway being out of reach', new GatewayError('gateway_down', 'closed', true)],
    ['desk_not_ready', new GatewayError('desk_not_ready', 'link down', true)],
    ['the second copy being refused', new GatewayError('invalid_token', 'seen it', false)],
  ])('shrugs at %s: nothing logged, the session goes on', async (_name, failure) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const link = await openLink();
    gateway.request.mockImplementation(() => Promise.reject(failure));
    await settle(REFRESH_MS + 100);
    expect(lastPeer().sendAuth).toHaveBeenCalledWith('t2');
    expect(link.status()).toBe('open');
    expect(peers).toHaveLength(1);
    expect(lastPeer().closed).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    link.close();
  });
});

describe('session.resume after the gateway comes back', () => {
  it.each([
    ['desk_not_ready', new GatewayError('desk_not_ready', 'link down', true)],
    ['a passing failure', new GatewayError('timeout', 'no reply', true)],
  ])('%s sends the token on ctl, and keeps the session', async (_name, failure) => {
    const link = await openLink();
    gateway.request.mockImplementation(() => Promise.reject(failure));
    link.onUp();
    await settle();
    expect(requests('session.resume')).toHaveLength(1);
    expect(lastPeer().sendAuth).toHaveBeenCalledWith('t1');
    expect(link.status()).toBe('open');
    expect(peers).toHaveLength(1);
    expect(lastPeer().closed).toBe(false);
    expect(requests('session.open')).toHaveLength(1); // only the first
    await settle(30_000);
    expect(peers).toHaveLength(1);
    link.close();
  });

  it('also gets the watch back, which a failed resume would otherwise leave out until the next refresh', async () => {
    const link = await openLink();
    gateway.request.mockImplementation(() => Promise.reject(new GatewayError('desk_not_ready', 'link down', true)));
    gateway.serial += 1; // a new WebSocket
    gateway.sent.length = 0;
    link.onUp();
    await settle();
    expect(gateway.sent.filter((m) => m.type === 'watch')).toHaveLength(1);
    link.close();
  });

  it('session_not_found still opens a new one', async () => {
    const link = await openLink();
    gateway.request.mockImplementationOnce(() => Promise.reject(new GatewayError('session_not_found', 'gone', false)));
    link.onUp();
    await settle(2_000);
    expect(requests('session.open')).toHaveLength(2);
    expect(peers).toHaveLength(2);
    expect(peers[0]?.closed).toBe(true);
    expect(peers[0]?.sendAuth).not.toHaveBeenCalled();
    expect(link.status()).toBe('open');
    link.close();
  });

  it('a resume that works sends nothing on ctl', async () => {
    const link = await openLink();
    link.onUp();
    await settle();
    expect(requests('session.resume')).toHaveLength(1);
    expect(lastPeer().sendAuth).not.toHaveBeenCalled();
    link.close();
  });
});
