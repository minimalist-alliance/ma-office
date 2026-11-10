// A link's subscriptions across sessions, with the real Subscriptions and session setup, and a fake peer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeEvents {
  onEvent(subId: number, seq: number, body: unknown): void;
  onCloseFrame(code: number, reason: string): void;
}

const { api, gateway, peers, hello } = vi.hoisted(() => ({
  api: vi.fn(),
  peers: [] as { events: FakeEvents; subs: { topic: string; since?: number }[]; unsubs: number[]; sub(body: unknown): Promise<{ subId: number }> }[],
  hello: { resumed: false },
  gateway: {
    request: vi.fn(),
    answer: (() => {}) as (sessionId: string | undefined) => void,
    add() {},
    remove() {},
    fallbackUrl() {},
    kick() {},
    serial: 1,
    send(m: { type: string; sessionId?: string }): boolean {
      if (m.type === 'signal') gateway.answer(m.sessionId);
      return true;
    },
  },
}));

vi.mock('../../platform/api', () => ({ api, ApiError: class extends Error {} }));
vi.mock('../../platform/auth', () => ({ SignInRequired: class extends Error {} }));
vi.mock('./identity', () => ({ tabIdentity: () => Promise.resolve({ fingerprint: 'sha-256 AA', certificate: {} }) }));
vi.mock('./sdp', () => ({ answerMatchesIdentity: () => true }));
vi.mock('./gateway', () => ({ GatewayError: class extends Error {}, gateway }));
vi.mock('./peer', () => ({
  PeerSession: class {
    channelsOpen = Promise.resolve();
    subs: { topic: string; since?: number }[] = [];
    unsubs: number[] = [];
    constructor(_desk: string, _cert: unknown, _ice: unknown, readonly events: FakeEvents) {
      peers.push(this);
    }
    sub(body: { topic: string; since?: number }): Promise<{ subId: number }> {
      this.subs.push(body);
      return Promise.resolve({ subId: 9 });
    }
    unsub(subId: number): Promise<unknown> {
      this.unsubs.push(subId);
      return Promise.resolve({});
    }
    sendAuth() {}
    createOffer = () => Promise.resolve('offer');
    applyAnswer = () => Promise.resolve();
    media = () => ({ stream: {}, canPlayVideo: true });
    hello = () => Promise.resolve({ deskApi: '1.0', resumeToken: 'r', resumed: hello.resumed });
    startPings() {}
    resetPings() {}
    recheck() {}
    close() {}
    path = () => Promise.resolve('udp');
  },
}));

const { RtcDeskLink } = await import('./rtcDeskLink');

const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};
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
  peers.length = 0;
  hello.resumed = false;
  let next = 1;
  gateway.request.mockReset();
  gateway.request.mockImplementation(() => Promise.resolve({ type: 'session.opened', sessionId: `cs-${next++}`, iceServers: [] }));
  api.mockReset();
  api.mockImplementation(() => Promise.resolve({ status: 200, etag: null, retryAfter: null, data: { state: 'running', phase: 'ready', deskToken: 't', deskIdentity: { fingerprintsSha256: ['aa'] } } }));
  const target = { addEventListener() {}, removeEventListener() {} };
  vi.stubGlobal('window', { ...target, setTimeout, clearTimeout });
  vi.stubGlobal('document', { ...target, hidden: false });
  vi.stubGlobal('__MA_VERSION__', 'test');
  vi.stubGlobal('performance', { now: () => Date.now(), measure() {}, mark() {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('RtcDeskLink subscriptions', () => {
  it('asks once the session is open, and passes on the event data with its seq and type', async () => {
    const got: unknown[] = [];
    const link = new RtcDeskLink('d-1');
    link.subscribe('summary', (m) => got.push(m));
    gateway.answer = (sessionId) => link.onMessage({ type: 'signal', sessionId, data: { type: 'answer', sdp: 'answer' } });
    link.connect();
    await settle();
    expect(lastPeer().subs).toEqual([{ topic: 'summary', params: {} }]);
    lastPeer().events.onEvent(9, 42, { type: 'snapshot', data: { agent: { state: 'idle' }, apps: {} } });
    expect(got).toEqual([{ type: 'snapshot', seq: 42, agent: { state: 'idle' }, apps: {} }]);
    link.close();
  });

  it('`changed` on browser.clipboard gets through with its empty data, and a `not_found` SUB is said once', async () => {
    const got: unknown[] = [];
    const refused: string[] = [];
    const link = await openLink();
    link.subscribe('browser.clipboard', (m) => got.push(m));
    await settle();
    expect(lastPeer().subs).toEqual([{ topic: 'browser.clipboard', params: {} }]);
    lastPeer().events.onEvent(9, 7, { type: 'changed', data: {} });
    expect(got).toEqual([{ type: 'changed', seq: 7 }]);
    lastPeer().sub = () => Promise.reject(Object.assign(new Error('no'), { code: 'not_found' }));
    link.subscribe('browser.tabs', () => {}, (code) => refused.push(code));
    await settle(60_000);
    expect(refused).toEqual(['not_found']);
    link.close();
  });

  it('a subscribe on an open link asks at once; the unsubscribe sends UNSUB', async () => {
    const link = await openLink();
    const off = link.subscribe('summary', () => {});
    expect(lastPeer().subs).toHaveLength(1);
    await settle();
    off();
    expect(lastPeer().unsubs).toEqual([9]);
    link.close();
  });

  it('re-subscribes on a new session: fresh when nothing carried over', async () => {
    const link = await openLink();
    link.subscribe('summary', () => {});
    await settle();
    lastPeer().events.onEvent(9, 41, { type: 'snapshot', data: {} });
    const first = lastPeer();
    first.events.onCloseFrame(4003, 'internal');
    await settle(5_000);
    expect(lastPeer()).not.toBe(first);
    expect(lastPeer().subs).toEqual([{ topic: 'summary', params: {} }]);
    link.close();
  });

  it('re-subscribes from the last seq when HELLO says the session resumed', async () => {
    const link = await openLink();
    link.subscribe('summary', () => {});
    await settle();
    lastPeer().events.onEvent(9, 41, { type: 'snapshot', data: {} });
    hello.resumed = true;
    lastPeer().events.onCloseFrame(4003, 'internal');
    await settle(5_000);
    expect(lastPeer().subs).toEqual([{ topic: 'summary', params: {}, since: 41 }]);
    link.close();
  });

  it("nothing is delivered from a peer that's gone", async () => {
    const got: unknown[] = [];
    const link = await openLink();
    link.subscribe('summary', (m) => got.push(m));
    await settle();
    const first = lastPeer();
    link.close();
    first.events.onEvent(9, 1, { type: 'snapshot', data: {} });
    expect(got).toEqual([]);
  });

  it('a final refusal reaches the caller', async () => {
    const refused: string[] = [];
    const link = await openLink();
    lastPeer().sub = () => Promise.reject(Object.assign(new Error('no'), { code: 'not_found' }));
    link.subscribe('summary', () => {}, (code) => refused.push(code));
    await settle();
    expect(refused).toEqual(['not_found']);
    link.close();
  });
});
