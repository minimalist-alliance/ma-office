// `desk.attention.set` across sessions (task 46), with the real session setup and a fake peer: said on each new session,
// and at once on a change, never with a session closed, and never by an export link.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeEvents {
  onEvent(subId: number, seq: number, body: unknown): void;
  onCloseFrame(code: number, reason: string): void;
}

const { api, gateway, peers, hello } = vi.hoisted(() => ({
  api: vi.fn(),
  peers: [] as { events: FakeEvents; calls: { m: string; p: unknown; deadlineMs?: number }[]; refuse: string | null }[],
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
    calls: { m: string; p: unknown; deadlineMs?: number }[] = [];
    refuse: string | null = null;
    constructor(_desk: string, _cert: unknown, _ice: unknown, readonly events: FakeEvents) {
      peers.push(this);
    }
    call(m: string, p: unknown, options?: { deadlineMs?: number }): Promise<unknown> {
      this.calls.push({ m, p, deadlineMs: options?.deadlineMs });
      return this.refuse ? Promise.reject(Object.assign(new Error(this.refuse), { code: this.refuse })) : Promise.resolve({});
    }
    sub(): Promise<{ subId: number }> {
      return Promise.resolve({ subId: 9 });
    }
    unsub(): Promise<unknown> {
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

async function openLink(before?: (link: InstanceType<typeof RtcDeskLink>) => void, purpose?: 'export'): Promise<InstanceType<typeof RtcDeskLink>> {
  const link = new RtcDeskLink('d-1', purpose);
  before?.(link);
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

const said = (peer = lastPeer()): unknown[] => peer.calls.filter((c) => c.m === 'desk.attention.set').map((c) => c.p);

describe('RtcDeskLink attention', () => {
  it('says the wish as the session opens, with a deadline and no idem', async () => {
    const link = await openLink((l) => l.setSeen(false));
    expect(lastPeer().calls.find((c) => c.m === 'desk.attention.set')).toEqual({ m: 'desk.attention.set', p: { seen: false }, deadlineMs: 5_000 });
    link.close();
  });

  it('says nothing before the office has a wish, then at once on each change', async () => {
    const link = await openLink();
    expect(said()).toEqual([]);
    link.setSeen(true);
    expect(said()).toEqual([{ seen: true }]);
    await settle();
    link.setSeen(false);
    expect(said()).toEqual([{ seen: true }, { seen: false }]);
    link.close();
  });

  it('says it again on a new session, resumed or not', async () => {
    const link = await openLink((l) => l.setSeen(false));
    await settle();
    const first = lastPeer();
    first.events.onCloseFrame(4003, 'internal');
    await settle(5_000);
    expect(lastPeer()).not.toBe(first);
    expect(said()).toEqual([{ seen: false }]);
    hello.resumed = true;
    lastPeer().events.onCloseFrame(4003, 'internal');
    await settle(5_000);
    expect(said()).toEqual([{ seen: false }]);
    link.close();
  });

  it('a change while no session is open waits for the next one, which says only the newest', async () => {
    const link = await openLink((l) => l.setSeen(true));
    await settle();
    lastPeer().events.onCloseFrame(4003, 'internal');
    link.setSeen(false);
    link.setSeen(true);
    link.setSeen(false);
    await settle(5_000);
    expect(said()).toEqual([{ seen: false }]);
    link.close();
  });

  it('a deskd that doesn\'t know it gets nothing more on that session', async () => {
    const link = await openLink((l) => {
      l.setSeen(false);
    });
    await settle();
    expect(link.attention.answer).toBe('ok');
    lastPeer().refuse = 'not_found';
    link.setSeen(true);
    await settle();
    expect(link.attention.answer).toBe('not_found');
    link.setSeen(false);
    link.setSeen(true);
    await settle(60_000);
    expect(said()).toEqual([{ seen: false }, { seen: true }]);
    link.close();
  });

  it('an export session never says', async () => {
    const link = await openLink((l) => l.setSeen(false), 'export');
    link.setSeen(true);
    await settle();
    expect(said()).toEqual([]);
    link.close();
  });
});
