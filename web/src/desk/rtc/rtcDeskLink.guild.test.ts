// A Guild Desk through the desk's own link (task 48): its state, a wake only when the member asked, a guild token, then a
// data-only session to the Guild Desk's own id, refreshes on the token route, and a fresh token on a deny. The platform API,
// the gateway and the peer are faked; `RtcDeskLink` and `guild/access.ts` are the real code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { api, gateway, peers, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string | null,
      readonly details: Record<string, unknown> | null = null,
    ) {
      super(`HTTP ${status}`);
    }
    retryAfterSec = null;
  }
  return {
    ApiError,
    api: vi.fn(),
    peers: [] as { sendAuth: ReturnType<typeof vi.fn>; closed: boolean; guild: boolean; deskId: string; onCloseFrame: (code: number, reason: string) => void }[],
    gateway: {
      request: vi.fn(),
      answer: (() => {}) as (sessionId: string | undefined) => void,
      sent: [] as { type: string; deskId?: string; deskToken?: string }[],
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
  };
});

vi.mock('../../platform/api', () => ({ api, ApiError }));
vi.mock('../../platform/auth', () => ({ SignInRequired: class extends Error {} }));
vi.mock('./identity', () => ({ tabIdentity: () => Promise.resolve({ fingerprint: 'sha-256 AA:BB', certificate: {} }) }));
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
    guild: boolean;
    deskId: string;
    onCloseFrame: (code: number, reason: string) => void;
    constructor(deskId: string, _cert: unknown, _ice: unknown, events: { onCloseFrame: (code: number, reason: string) => void }, guild = false) {
      this.deskId = deskId;
      this.guild = guild;
      this.onCloseFrame = events.onCloseFrame;
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
const { GuildAccess, setGuildAccessHooks } = await import('../../guild/access');

const PANEL = 'guild-gu-abcdefghijkl';
const REMOTE = 'd-gremote000001';
const REFRESH_MS = 60_000;

let desk: { deskId: string; state: string };
let tokens = 0;
let refuse: number | null = null;
const calls: { path: string; method: string; body: unknown }[] = [];
const heard = { desk: [] as string[], refused: 0 };

const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};
const routes = (): string[] => calls.map((c) => `${c.method} ${c.path.replace('/v1/guilds/gu-abcdefghijkl', '')}`);
const lastPeer = (): (typeof peers)[number] => peers[peers.length - 1] as (typeof peers)[number];

function newLink(): InstanceType<typeof RtcDeskLink> {
  const link = new RtcDeskLink(PANEL, undefined, new GuildAccess('gu-abcdefghijkl'));
  gateway.answer = (sessionId) => link.onMessage({ type: 'signal', sessionId, data: { type: 'answer', sdp: 'answer' } });
  return link;
}

beforeEach(() => {
  vi.useFakeTimers();
  tokens = 0;
  refuse = null;
  calls.length = 0;
  peers.length = 0;
  heard.desk.length = 0;
  heard.refused = 0;
  gateway.sent.length = 0;
  desk = { deskId: REMOTE, state: 'running' };
  setGuildAccessHooks({ desk: (_g, d) => heard.desk.push(String(d.state)), refused: () => (heard.refused += 1) });
  gateway.request.mockReset();
  gateway.request.mockImplementation((m: { type: string }) => Promise.resolve({ type: m.type === 'session.refresh' ? 'session.refreshed' : 'session.opened', sessionId: 'cs-1', iceServers: [] }));
  api.mockReset();
  api.mockImplementation((path: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
    if (refuse) return Promise.reject(new ApiError(refuse, refuse === 403 ? 'forbidden' : 'not_found'));
    if (path.endsWith('/desk/wake')) {
      desk.state = 'starting';
      setTimeout(() => (desk.state = 'running'), 5_000);
      return Promise.resolve({ status: 202, data: { ...desk }, etag: null, retryAfter: null });
    }
    if (path.endsWith('/desk/token')) {
      return Promise.resolve({
        status: 200,
        etag: null,
        retryAfter: null,
        data: { deskId: REMOTE, state: 'running', phase: 'ready', deskToken: `g${++tokens}`, refreshAfter: new Date(Date.now() + REFRESH_MS / 0.9).toISOString(), deskIdentity: { fingerprintsSha256: ['aa'] } },
      });
    }
    return Promise.resolve({ status: 200, data: { ...desk }, etag: null, retryAfter: null });
  });
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

describe('a running Guild Desk', () => {
  it('reads its state, takes a guild token with this tab’s fingerprint, and opens a data-only session to the Guild Desk’s own id', async () => {
    const link = newLink();
    link.connect();
    await settle();
    expect(routes()).toEqual(['GET /desk', 'POST /desk/token']);
    expect(calls[1]?.body).toEqual({ fingerprint: 'sha-256 AA:BB' });
    expect(link.status()).toBe('open');
    const open = gateway.request.mock.calls.map(([m]) => m as { type: string; deskId?: string; deskToken?: string }).find((m) => m.type === 'session.open');
    expect(open).toMatchObject({ deskId: REMOTE, deskToken: 'g1' });
    expect(gateway.sent.find((m) => m.type === 'watch')).toMatchObject({ deskId: REMOTE });
    expect(lastPeer().guild).toBe(true);
    expect(link.media()).toBeNull();
    expect(heard.desk).toEqual(['running']);
    link.close();
  });

  it('refreshes on the token route, never the desk connect route, and sends the new token both ways', async () => {
    const link = newLink();
    link.connect();
    await settle();
    await settle(REFRESH_MS + 100);
    expect(routes().filter((r) => r.endsWith('/desk/token'))).toHaveLength(2);
    expect(calls.some((c) => c.path.includes('/v1/desks/'))).toBe(false);
    expect(lastPeer().sendAuth).toHaveBeenCalledWith('g2');
    link.close();
  });

  it('hears its own desk.state on the gateway by the Guild Desk’s id, not the panel’s', async () => {
    const link = newLink();
    link.connect();
    await settle();
    link.onMessage({ type: 'desk.state', deskId: PANEL, state: 'stopped' });
    expect(link.status()).toBe('open');
    link.onMessage({ type: 'desk.state', deskId: REMOTE, state: 'stopped' });
    expect(link.status()).toBe('idle');
  });
});

describe('a Guild Desk on its way', () => {
  it('running but not yet on the gateway: waits, says connecting, and takes no token until it is', async () => {
    (desk as { connected?: boolean }).connected = false;
    const link = newLink();
    link.connect();
    await settle();
    expect(routes()).toEqual(['GET /desk']);
    expect(link.details().desk).toMatchObject({ state: 'starting', phase: 'connecting' });
    (desk as { connected?: boolean }).connected = true;
    await settle(3_500);
    expect(routes()).toEqual(['GET /desk', 'GET /desk', 'POST /desk/token']);
    expect(link.status()).toBe('open');
    link.close();
  });

  it('provisioning shows its own phase on the waking screen', async () => {
    desk = { deskId: REMOTE, state: 'provisioning', phase: 'booting' } as typeof desk;
    const link = newLink();
    link.connect();
    await settle();
    expect(link.details().desk).toMatchObject({ state: 'starting', phase: 'booting' });
    link.close();
  });
});

describe('a sleeping Guild Desk', () => {
  it('rendering only reads its state: no wake, no token', async () => {
    desk.state = 'stopped';
    const link = newLink();
    link.connect();
    await settle(30_000);
    expect(routes()).toEqual(['GET /desk']);
    expect(link.status()).toBe('idle');
  });

  it('a desk never opened (`none`) is asleep too', async () => {
    desk.state = 'none';
    const link = newLink();
    link.connect();
    await settle();
    expect(routes()).toEqual(['GET /desk']);
    expect(link.details().desk?.state).toBe('stopped');
  });

  it('the member’s wake: wakes it once, waits while it starts, then the token and the session', async () => {
    desk.state = 'stopped';
    const link = newLink();
    link.connect();
    await settle();
    link.wake();
    await settle();
    // The member's press reads the state again, finds it asleep, and wakes it, once.
    expect(routes()).toEqual(['GET /desk', 'GET /desk', 'GET /desk', 'POST /desk/wake']);
    expect(link.details().desk?.state).toBe('starting');
    expect(link.status()).not.toBe('open');
    await settle(10_000);
    expect(routes().filter((r) => r === 'POST /desk/wake')).toHaveLength(1);
    expect(routes()[routes().length - 1]).toBe('POST /desk/token');
    expect(link.status()).toBe('open');
    link.close();
  });
});

describe('a member removed, or their role changed', () => {
  it('a deny from the Guild Desk asks for a fresh token rather than giving up', async () => {
    const link = newLink();
    link.connect();
    await settle();
    lastPeer().onCloseFrame(4403, 'roster_changed');
    await settle(5_000);
    expect(routes().filter((r) => r.endsWith('/desk/token'))).toHaveLength(2);
    expect(peers).toHaveLength(2);
    expect(link.status()).toBe('open');
    link.close();
  });

  it('a refused token ends it, and the guild store hears so', async () => {
    const link = newLink();
    link.connect();
    await settle();
    refuse = 403;
    lastPeer().onCloseFrame(4403, 'removed');
    await settle(5_000);
    expect(link.status()).toBe('denied');
    expect(heard.refused).toBeGreaterThanOrEqual(1);
    const before = calls.length;
    await settle(120_000);
    expect(calls.length).toBe(before); // nothing asks again by itself
  });

  it('a 404 for the whole guild ends it too', async () => {
    refuse = 404;
    const link = newLink();
    link.connect();
    await settle();
    expect(link.status()).toBe('idle');
    expect(heard.refused).toBe(1);
  });
});
