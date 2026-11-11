// New TURN servers reach the session's connection (ma-platform contract gateway.md 2.4, ADR 0120): every
// `session.refreshed`, and a resume's `session.opened`, carry credentials that expire with the new token, and the
// connection must have them before an ICE restart allocates on the relay. A new session uses only its own `session.opened`.
// The real gateway (on a fake WebSocket that answers as the gateway and desk do) and the real link; the PeerSession is a
// fake around a fake RTCPeerConnection, with the real `useIceServers`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Servers = { urls: string[]; username: string; credential: string }[];

const { api, peers, wire } = vi.hoisted(() => ({
  api: vi.fn(),
  peers: [] as {
    pc: { configured: RTCConfiguration[]; getConfiguration(): RTCConfiguration; refuse: Error | null };
    events: { onHealth(h: string): void };
    offers: { restart: boolean; iceServers: unknown }[];
    closed: boolean;
  }[],
  wire: { sessions: 0, refreshes: 0, resumes: 0 },
}));

vi.mock('../../platform/api', () => ({ api, ApiError: class extends Error {} }));
vi.mock('../../platform/auth', () => ({ SignInRequired: class extends Error {} }));
vi.mock('../../platform/clientConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform/clientConfig')>()),
  getClientConfig: () => Promise.resolve({ gateway: 'wss://gw.example.test/v1' }),
}));
vi.mock('./identity', () => ({ tabIdentity: () => Promise.resolve({ fingerprint: 'sha-256 AA', certificate: { canary: 'cert' } }) }));
vi.mock('./sdp', async (importOriginal) => ({ ...(await importOriginal<typeof import('./sdp')>()), answerMatchesIdentity: () => true }));
vi.mock('./peer', async (importOriginal) => {
  const real = await importOriginal<typeof import('./peer')>();
  class FakePc {
    readonly configured: RTCConfiguration[] = [];
    refuse: Error | null = null;
    constructor(private config: RTCConfiguration) {}
    getConfiguration(): RTCConfiguration {
      return { ...this.config };
    }
    setConfiguration(c: RTCConfiguration): void {
      if (this.refuse) throw this.refuse;
      this.configured.push(c);
      this.config = c;
    }
  }
  class PeerSession {
    readonly pc: FakePc;
    readonly offers: { restart: boolean; iceServers: unknown }[] = [];
    closed = false;
    channelsOpen = Promise.resolve();
    /** The real method, on this fake's `pc` and `closed`. */
    useIceServers = real.PeerSession.prototype.useIceServers;
    constructor(
      _deskId: string,
      certificate: RTCCertificate,
      iceServers: RTCIceServer[],
      readonly events: { onHealth(h: string): void },
    ) {
      this.pc = new FakePc({ iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require', certificates: [certificate] });
      peers.push(this as never);
    }
    createOffer(restart = false): Promise<string> {
      this.offers.push({ restart, iceServers: this.pc.getConfiguration().iceServers });
      return Promise.resolve('offer');
    }
    applyAnswer = (): Promise<void> => Promise.resolve();
    waitConnected = (): Promise<void> => Promise.resolve();
    media = (): unknown => ({ stream: {}, canPlayVideo: true });
    hello = (): Promise<unknown> => Promise.resolve({ deskApi: '1.0', resumeToken: 'r' });
    sendAuth(): void {}
    startPings(): void {}
    resetPings(): void {}
    recheck(): void {}
    path = (): Promise<string> => Promise.resolve('relay');
    close(): void {
      this.closed = true;
    }
  }
  return { PeerSession };
});

/** A session's servers, as the gateway makes them: the username names the session, the credential is the canary. */
const servers = (sessionId: string, label: string): Servers => [
  { urls: ['turn:turn.example.test:443?transport=udp', 'turns:turn.example.test:443?transport=tcp'], username: `17000${label.length}0000:${sessionId}`, credential: `${label}-credential-canary` },
];

/** The gateway and the desk behind it: opens, refreshes and resumes each get new servers, and an offer gets an answer. */
class FakeWs {
  static readonly OPEN = 1;
  static last: FakeWs;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor() {
    FakeWs.last = this;
    setTimeout(() => {
      this.readyState = FakeWs.OPEN;
      this.onopen?.();
    }, 0);
  }
  send(text: string): void {
    const m = JSON.parse(text) as { type: string; id?: string; sessionId?: string; deskId?: string };
    const reply = (r: Record<string, unknown>): void => void setTimeout(() => this.deliver({ ...r, id: m.id }), 0);
    if (m.type === 'session.open') {
      const sessionId = `cs-${++wire.sessions}`;
      reply({ type: 'session.opened', deskId: m.deskId, sessionId, iceServers: servers(sessionId, `open${wire.sessions}`), iceServersExpireAt: '2026-11-10T23:05:30Z' });
    } else if (m.type === 'session.refresh') {
      reply({ type: 'session.refreshed', sessionId: m.sessionId, iceServers: servers(m.sessionId ?? '', `refresh${++wire.refreshes}`), iceServersExpireAt: '2026-11-10T23:10:30Z' });
    } else if (m.type === 'session.resume') {
      reply({ type: 'session.opened', deskId: m.deskId, sessionId: m.sessionId, iceServers: servers(m.sessionId ?? '', `resume${++wire.resumes}`), iceServersExpireAt: '2026-11-10T23:10:30Z' });
    } else if (m.type === 'signal') {
      setTimeout(() => this.deliver({ type: 'signal', sessionId: m.sessionId, data: { type: 'answer', sdp: 'answer' } }), 0);
    }
  }
  close(): void {}
  deliver(m: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

const REFRESH_MS = 60_000;
const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};
const peer = (i: number): (typeof peers)[number] => peers[i] as (typeof peers)[number];
const iceOf = (p: (typeof peers)[number]): unknown => p.pc.getConfiguration().iceServers;

let RtcDeskLink: (typeof import('./rtcDeskLink'))['RtcDeskLink'];
const logged: unknown[][] = [];

async function openLink(): Promise<InstanceType<typeof RtcDeskLink>> {
  const link = new RtcDeskLink('d-1');
  link.connect();
  await settle(100);
  expect(link.status()).toBe('open');
  return link;
}

beforeEach(async () => {
  vi.useFakeTimers();
  peers.length = 0;
  Object.assign(wire, { sessions: 0, refreshes: 0, resumes: 0 });
  logged.length = 0;
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args));
  }
  let tokens = 0;
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
  vi.stubGlobal('WebSocket', FakeWs);
  const matchMedia = (): unknown => ({ matches: false, ...target });
  vi.stubGlobal('window', { ...target, setTimeout, clearTimeout, setInterval, clearInterval, matchMedia });
  vi.stubGlobal('document', { ...target, hidden: false });
  vi.stubGlobal('__MA_VERSION__', 'test');
  vi.stubGlobal('performance', { now: () => Date.now(), measure() {}, mark() {} });
  vi.resetModules();
  ({ RtcDeskLink } = await import('./rtcDeskLink'));
});

afterEach(() => {
  // Credentials never reach a log line, whatever happened in the test.
  expect(JSON.stringify(logged)).not.toContain('credential-canary');
  expect(JSON.stringify(logged)).not.toMatch(/17000\d0000:cs-/);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('new TURN servers', () => {
  it("a session's connection starts with its session.opened servers, and each refresh's replace them, once", async () => {
    const link = await openLink();
    expect(peers).toHaveLength(1);
    expect(iceOf(peer(0))).toEqual(servers('cs-1', 'open1'));
    expect(peer(0).pc.configured).toHaveLength(0);

    await settle(REFRESH_MS + 100);
    expect(peer(0).pc.configured).toEqual([{ iceServers: servers('cs-1', 'refresh1'), bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require', certificates: [{ canary: 'cert' }] }]);

    await settle(REFRESH_MS);
    expect(peer(0).pc.configured).toHaveLength(2);
    expect(iceOf(peer(0))).toEqual(servers('cs-1', 'refresh2'));
    expect(peers).toHaveLength(1);
    expect(link.status()).toBe('open');
    link.close();
  });

  it('an ICE restart after a refresh offers with the refreshed servers, on the same connection', async () => {
    const link = await openLink();
    await settle(REFRESH_MS + 100);
    peer(0).events.onHealth('disconnected');
    await settle(100);
    expect(peer(0).offers).toEqual([
      { restart: false, iceServers: servers('cs-1', 'open1') },
      { restart: true, iceServers: servers('cs-1', 'refresh1') },
    ]);
    expect(peers).toHaveLength(1);
    expect(link.status()).toBe('open');
    link.close();
  });

  it("a reconnect after a refresh opens with its own session's servers, and the old session's late ones change nothing", async () => {
    const link = await openLink();
    await settle(REFRESH_MS + 100);
    peer(0).events.onHealth('failed'); // the restart is past saving: a new session, resuming by HELLO
    await settle(30_000);
    expect(link.status()).toBe('open');
    expect(peers).toHaveLength(2);
    expect(peer(0).closed).toBe(true);
    expect(iceOf(peer(1))).toEqual(servers('cs-2', 'open2'));
    expect(peer(1).offers[0]).toEqual({ restart: false, iceServers: servers('cs-2', 'open2') });

    // A refresh of the old session answered after the new one opened.
    FakeWs.last.deliver({ type: 'session.refreshed', id: 'r-late', sessionId: 'cs-1', iceServers: servers('cs-1', 'late'), iceServersExpireAt: '2026-11-10T23:15:30Z' });
    expect(peer(1).pc.configured).toHaveLength(0);
    expect(peer(0).pc.configured).toHaveLength(1);

    await settle(REFRESH_MS + 100);
    expect(iceOf(peer(1))).toEqual(servers('cs-2', `refresh${wire.refreshes}`));
    expect(peer(1).pc.configured).toHaveLength(1);
    link.close();
  });

  it("a resume after the gateway's 2 h close brings new servers too", async () => {
    const link = await openLink();
    await settle(11_000);
    FakeWs.last.onclose?.({ code: 1001 });
    await settle(100);
    expect(wire.resumes).toBe(1);
    expect(iceOf(peer(0))).toEqual(servers('cs-1', 'resume1'));
    expect(peer(0).pc.configured).toHaveLength(1);
    expect(peers).toHaveLength(1);
    expect(link.status()).toBe('open');
    link.close();
  });

  it("servers the browser won't take leave the old ones, and the session goes on with nothing logged", async () => {
    const link = await openLink();
    peer(0).pc.refuse = new Error(`Malformed ICE server ${JSON.stringify(servers('cs-1', 'refresh1'))}`);
    await settle(REFRESH_MS + 100);
    expect(wire.refreshes).toBe(1);
    expect(iceOf(peer(0))).toEqual(servers('cs-1', 'open1'));
    expect(link.status()).toBe('open');
    expect(peers).toHaveLength(1);
    expect(logged).toEqual([]);
    link.close();
  });
});
