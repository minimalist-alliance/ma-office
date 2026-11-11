// What a session closing from the desk's side does next. The link retries until `connect` or the gateway
// says the desk is stopping or stopped, and only then rests. Nothing here may send `start: true` unless a
// member asked. The gateway and the peer are faked, and the session setup between them is the real code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface PeerEvents {
  onCloseFrame(code: number, reason: string): void;
}

const { api, ApiError, peers, gateway } = vi.hoisted(() => {
  class FakeApiError extends Error {
    constructor(readonly status: number) {
      super(`HTTP ${status}`);
    }
  }
  const sent: { type: string; sessionId?: string; reason?: string }[] = [];
  return {
    api: vi.fn(),
    ApiError: FakeApiError,
    peers: [] as { events: PeerEvents }[],
    gateway: {
      sent,
      request: vi.fn(),
      answer: (() => {}) as (sessionId: string | undefined) => void,
      add() {},
      remove() {},
      fallbackUrl() {},
      kick() {},
      isUp: () => true,
      ready: () => Promise.resolve(),
      serial: 1,
      send(m: { type: string; sessionId?: string; reason?: string }): boolean {
        sent.push(m);
        if (m.type === 'signal') gateway.answer(m.sessionId);
        return true;
      },
    },
  };
});

vi.mock('../../platform/api', () => ({ api, ApiError }));
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
    constructor(_desk: string, _cert: unknown, _ice: unknown, readonly events: PeerEvents) {
      peers.push(this);
    }
    createOffer = () => Promise.resolve('offer');
    applyAnswer = () => Promise.resolve();
    media = () => ({ stream: {}, canPlayVideo: true });
    hello = () => Promise.resolve({ deskApi: '1.0', resumeToken: 'r' });
    startPings() {}
    resetPings() {}
    recheck() {}
    sendAuth() {}
    close() {}
    path = () => Promise.resolve('udp');
  },
}));

const { RtcDeskLink } = await import('./rtcDeskLink');
const { GatewayError } = await import('./gateway');

type Link = InstanceType<typeof RtcDeskLink>;
type Answer = { state: string; phase: string; identity?: boolean; retryAfterSeconds?: number };

const READY: Answer = { state: 'running', phase: 'ready', identity: true };
const CONNECTING: Answer = { state: 'running', phase: 'connecting' };
const STOPPING: Answer = { state: 'stopping', phase: 'stopped' };
const STOPPED: Answer = { state: 'stopped', phase: 'stopped' };
const WAKING: Answer = { state: 'starting', phase: 'starting', retryAfterSeconds: 3 };

let answer: Answer | Error | ((start: boolean) => Answer) = READY;
let starts: boolean[] = [];
/** When each `connect` went out. */
let asks: number[] = [];
const gaps = (): number[] => asks.slice(1).map((at, i) => at - (asks[i] as number));

const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

/** A link with a session open. `starts` then counts only what comes after. */
async function openLink(): Promise<Link> {
  answer = READY;
  const link = new RtcDeskLink('d-1');
  gateway.answer = (sessionId) => link.onMessage({ type: 'signal', sessionId, data: { type: 'answer', sdp: 'answer' } });
  link.connect();
  await settle();
  expect(link.status()).toBe('open');
  starts = [];
  asks = [];
  return link;
}

const lastPeer = (): { events: PeerEvents } => peers[peers.length - 1] as { events: PeerEvents };
const sessionsOpened = (): number => gateway.request.mock.calls.filter(([m]) => (m as { type: string }).type === 'session.open').length;

// Each test an hour on from the last, so the tab's `connect` budget starts empty.
let epoch = Date.UTC(2030, 0, 1);
beforeEach(() => {
  vi.useFakeTimers({ now: (epoch += 3_600_000) });
  starts = [];
  asks = [];
  peers.length = 0;
  gateway.sent.length = 0;
  let nextSession = 1;
  gateway.request.mockReset();
  gateway.request.mockImplementation(() => Promise.resolve({ type: 'session.opened', sessionId: `cs-${nextSession++}`, iceServers: [] }));
  api.mockReset();
  api.mockImplementation((_path: string, init: { body: string }) => {
    const { start } = JSON.parse(init.body) as { start: boolean };
    starts.push(start);
    asks.push(Date.now());
    if (answer instanceof Error) return Promise.reject(answer);
    const { identity, ...data } = typeof answer === 'function' ? answer(start) : answer;
    return Promise.resolve({ status: 200, etag: null, retryAfter: null, data: { deskToken: 't', ...data, deskIdentity: identity ? { fingerprintsSha256: ['aa'] } : null } });
  });
  const target = { addEventListener() {}, removeEventListener() {} };
  vi.stubGlobal('window', { ...target, setTimeout, clearTimeout });
  vi.stubGlobal('document', { ...target, hidden: false });
  vi.stubGlobal('__MA_VERSION__', 'test');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const session = (reason: string) => (link: Link): void => link.onMessage({ type: 'session.closed', sessionId: 'cs-1', reason });
const ctl = (code: number, reason: string) => (): void => lastPeer().events.onCloseFrame(code, reason);

const RECHECKS: [string, (link: Link) => void][] = [
  ['CLOSE 4503', ctl(4503, 'desk_stopping')],
  ['session.closed desk_stopping', session('desk_stopping')],
  ['CLOSE 4002', ctl(4002, 'deskd_restarting')],
  ['session.closed closed_by_desk', session('closed_by_desk')],
];

describe.each(RECHECKS)('deskd going away: %s', (_name, close) => {
  it('waits about 2 s, then a desk that came straight back opens a new session', async () => {
    const link = await openLink();
    close(link);
    expect(link.status()).not.toBe('idle');
    await settle(1_500);
    expect(starts).toEqual([]); // nothing goes to a deskd on its way out
    await settle(1_000);
    expect(starts).toEqual([false]);
    expect(link.status()).toBe('open');
    expect(sessionsOpened()).toBe(2);
  });

  it('connect keeps saying running: it keeps trying, says it cannot reach the desk, never that it is going to sleep, and is back when the desk is', async () => {
    const link = await openLink();
    answer = CONNECTING;
    close(link);
    await settle(29_000);
    expect(link.status()).toBe('retrying');
    expect(link.details().unreachable).toBe(false);
    await settle(2_000);
    expect(link.details().unreachable).toBe(true);

    await settle(5 * 60 * 1000);
    expect(link.status()).toBe('retrying');
    expect(link.details().desk?.state).toBe('running');
    expect(starts).not.toContain(true);
    expect(sessionsOpened()).toBe(1);
    // About 2 s, then 3, 4.5, 6.75 and each 10 s: a flat 3 s would be well over 100.
    expect(starts.length).toBeGreaterThan(30);
    expect(starts.length).toBeLessThan(40);

    answer = READY;
    await settle(10_100);
    expect(link.status()).toBe('open');
    expect(link.details().unreachable).toBe(false);
  });

  it('connect failing all along: it keeps trying on the backoff, and is back when connect is', async () => {
    const link = await openLink();
    answer = new ApiError(503);
    close(link);
    await settle(5 * 60 * 1000);
    expect(link.status()).toBe('retrying');
    expect(link.details().unreachable).toBe(true);
    expect(starts).not.toContain(true);
    expect(starts.length).toBeLessThan(30);

    answer = READY;
    await settle(36_100);
    expect(link.status()).toBe('open');
  });

  it('the gateway has already said stopping: it rests with no check', async () => {
    const link = await openLink();
    link.onMessage({ type: 'desk.stopping', deskId: 'd-1', stopAt: '2026-11-05T09:00:00Z' });
    close(link);
    await settle(5 * 60 * 1000);
    expect(starts).toEqual([]);
    expect(link.status()).toBe('idle');
  });

  it('an idle stop that was cancelled no longer counts as the gateway saying stopping', async () => {
    const link = await openLink();
    link.onMessage({ type: 'desk.state', deskId: 'd-1', state: 'stopping' });
    link.onMessage({ type: 'desk.state', deskId: 'd-1', state: 'running' });
    close(link);
    await settle(2_500);
    expect(starts).toEqual([false]);
    expect(link.status()).toBe('open');
  });

  it('a phase: ready from the watch ends the wait at once, however long it had grown', async () => {
    const link = await openLink();
    answer = CONNECTING;
    close(link);
    await settle(25_000);
    expect(gaps().at(-1)).toBeGreaterThanOrEqual(6_750);
    const asked = starts.length;
    answer = READY;
    link.onMessage({ type: 'desk.progress', deskId: 'd-1', phase: 'ready' });
    await settle();
    expect(starts).toHaveLength(asked + 1);
    expect(link.status()).toBe('open');
  });

  it('a phase: ready from the watch also ends a backoff after a refused session', async () => {
    const link = await openLink();
    close(link);
    // `connect` still said ready while the gateway already knew better: the next step is about 4 s off.
    gateway.request.mockImplementationOnce(() => Promise.reject(new GatewayError('desk_not_ready', 'not ready', true)));
    await settle(2_500);
    expect(starts).toEqual([false]);
    link.onMessage({ type: 'desk.progress', deskId: 'd-1', phase: 'ready' });
    await settle();
    expect(starts).toEqual([false, false]);
    expect(link.status()).toBe('open');
  });

  it('a wake asked for during the first setup has no effect on these checks', async () => {
    answer = READY;
    const link = new RtcDeskLink('d-1');
    gateway.answer = (sessionId) => link.onMessage({ type: 'signal', sessionId, data: { type: 'answer', sdp: 'answer' } });
    gateway.request.mockImplementationOnce(() => {
      link.wake(); // the first refit of a page load: `connect` has answered and setup is under way
      return Promise.resolve({ type: 'session.opened', sessionId: 'cs-1', iceServers: [] });
    });
    link.connect();
    await settle();
    expect(link.status()).toBe('open');
    starts = [];
    answer = STOPPED;
    close(link);
    await settle(5 * 60 * 1000);
    expect(starts).toEqual([false]);
    expect(link.status()).toBe('idle');
  });
});

describe.each([...RECHECKS, ['session.closed desk_disconnected', session('desk_disconnected')] as [string, (link: Link) => void]])('any close, then word that the desk is down: %s', (_name, close) => {
  it.each([
    ['stopping', STOPPING],
    ['stopped', STOPPED],
  ] as [string, Answer][])('connect says %s: one check, no session, it rests, and nothing asks to wake', async (state, down) => {
    const link = await openLink();
    answer = down;
    close(link);
    await settle(5 * 60 * 1000);
    expect(starts).toEqual([false]);
    expect(sessionsOpened()).toBe(1);
    expect(link.status()).toBe('idle');
    expect(link.details().desk?.state).toBe(state);
  });

  it('desk.state says stopped while it waits: it rests, and nothing asks to wake', async () => {
    const link = await openLink();
    answer = CONNECTING;
    close(link);
    await settle(3_000);
    link.onMessage({ type: 'desk.state', deskId: 'd-1', state: 'stopped' });
    const asked = starts.length;
    await settle(5 * 60 * 1000);
    expect(link.status()).toBe('idle');
    expect(starts).toHaveLength(asked);
    expect(starts).not.toContain(true);
  });
});

describe('session.closed desk_disconnected: the gateway already knows the link is gone', () => {
  it('retries straight away, on the normal backoff', async () => {
    const link = await openLink();
    session('desk_disconnected')(link);
    await settle(400);
    expect(starts).toEqual([]);
    await settle(200); // 0.5 s, +-20 %
    expect(starts).toEqual([false]);
    expect(link.status()).toBe('open');
    expect(sessionsOpened()).toBe(2);
  });
});

describe('waiting for a desk that is not ready', () => {
  it('grows from 3 s to 10 s, and starts over after an open', async () => {
    const link = await openLink();
    answer = CONNECTING;
    ctl(4503, 'desk_stopping')();
    await settle(50_000);
    expect(gaps().slice(0, 6)).toEqual([3_000, 4_500, 6_750, 10_000, 10_000, 10_000]);

    answer = READY;
    await settle(10_000);
    expect(link.status()).toBe('open');
    answer = CONNECTING;
    asks = [];
    ctl(4503, 'desk_stopping')();
    await settle(10_000);
    expect(gaps()[0]).toBe(3_000);
  });

  it('keeps to the pace connect sets', async () => {
    await openLink();
    answer = { ...CONNECTING, retryAfterSeconds: 7 };
    ctl(4503, 'desk_stopping')();
    await settle(40_000);
    expect(new Set(gaps())).toEqual(new Set([7_000]));
  });

  it('a phase: ready heard while connect was on its way beats that answer, which is older', async () => {
    const link = await openLink();
    let answerNow = (): void => {};
    api.mockImplementationOnce((_path: string, init: { body: string }) => {
      starts.push((JSON.parse(init.body) as { start: boolean }).start);
      return new Promise((resolve) => {
        answerNow = () => resolve({ status: 200, etag: null, retryAfter: null, data: { deskToken: 't', ...CONNECTING, deskIdentity: null } });
      });
    });
    ctl(4503, 'desk_stopping')();
    await settle(2_500);
    expect(starts).toEqual([false]);
    link.onMessage({ type: 'desk.progress', deskId: 'd-1', phase: 'ready' });
    answer = READY;
    answerNow();
    await settle();
    expect(starts).toEqual([false, false]);
    expect(link.status()).toBe('open');
  });

  it('that only buys one look: not ready again goes back to waiting', async () => {
    const link = await openLink();
    let answerNow = (): void => {};
    api.mockImplementationOnce((_path: string, init: { body: string }) => {
      starts.push((JSON.parse(init.body) as { start: boolean }).start);
      return new Promise((resolve) => {
        answerNow = () => resolve({ status: 200, etag: null, retryAfter: null, data: { deskToken: 't', ...CONNECTING, deskIdentity: null } });
      });
    });
    answer = CONNECTING;
    ctl(4503, 'desk_stopping')();
    await settle(2_500);
    link.onMessage({ type: 'desk.progress', deskId: 'd-1', phase: 'ready' });
    await settle(1);
    answerNow();
    await settle(1);
    expect(starts).toHaveLength(2);
    await settle(2_000);
    expect(starts).toHaveLength(2);
  });
});

describe('a wake', () => {
  const wakeFromRest = async (link: Link): Promise<void> => {
    answer = (start) => (start ? WAKING : STOPPED);
    link.wake();
    await settle();
    expect(starts).toContain(true);
    answer = WAKING;
    await settle(3_100);
    answer = CONNECTING; // the desk has said hello: the wake's last step
    await settle(3_000);
    asks = [];
  };

  it("on a link that has had no session: it watches with the wake's own token, and polls its last step once a second (TD-227 part 3)", async () => {
    answer = STOPPED;
    const link = new RtcDeskLink('d-1');
    gateway.answer = (sessionId) => link.onMessage({ type: 'signal', sessionId, data: { type: 'answer', sdp: 'answer' } });
    link.connect();
    await settle();
    await wakeFromRest(link);
    expect(gateway.sent.filter((m) => m.type === 'watch')).toEqual([{ type: 'watch', id: 'watch:d-1', deskId: 'd-1', deskToken: 't' }]);
    await settle(10_000);
    expect(new Set(gaps())).toEqual(new Set([1_000]));

    answer = READY;
    await settle(1_000);
    expect(link.status()).toBe('open');
    expect(gateway.sent.filter((m) => m.type === 'watch')).toHaveLength(2); // again, with the session's own token
  });

  it('with a push: phase: ready ends its last step at once', async () => {
    const link = await openLink();
    answer = STOPPED;
    ctl(4503, 'desk_stopping')();
    await settle(3_000);
    expect(link.status()).toBe('idle');
    await wakeFromRest(link);
    const asked = starts.length;
    answer = READY;
    link.onMessage({ type: 'desk.progress', deskId: 'd-1', phase: 'ready' });
    await settle();
    expect(starts).toHaveLength(asked + 1);
    expect(link.status()).toBe('open');
  });

  it('starts the growth over once it has opened', async () => {
    const link = await openLink();
    answer = STOPPED;
    ctl(4503, 'desk_stopping')();
    await settle(3_000);
    await wakeFromRest(link);
    answer = READY;
    await settle(3_000);
    expect(link.status()).toBe('open');
    answer = CONNECTING;
    asks = [];
    ctl(4002, 'deskd_restarting')();
    await settle(20_000);
    expect(gaps().slice(0, 2)).toEqual([3_000, 4_500]); // not a wake any more
  });
});

describe('closes that keep coming during setup', () => {
  it('back off, rather than start again at 2 s', async () => {
    const link = await openLink();
    ctl(4002, 'deskd_restarting')();
    gateway.answer = () => {}; // setups hang, each with a session open on the gateway
    for (let second = 0; second < 60; second += 1) {
      await settle(1_000);
      link.onMessage({ type: 'session.closed', sessionId: `cs-${sessionsOpened()}`, reason: 'closed_by_desk' });
    }
    expect(sessionsOpened()).toBeLessThanOrEqual(8); // starting again at 2 s would be over 20
  });
});

describe('session.closed, the session being gone already', () => {
  it.each(['desk_stopping', 'closed_by_desk', 'desk_disconnected'])('%s sends the gateway no session.close for it', async (reason) => {
    const link = await openLink();
    session(reason)(link);
    expect(gateway.sent.filter((m) => m.type === 'session.close')).toEqual([]);
  });
});

describe('both signs of one close, CLOSE and then session.closed', () => {
  it.each([
    [4503, 'desk_stopping', 'desk_stopping'],
    [4002, 'deskd_restarting', 'closed_by_desk'],
  ] as [number, string, string][])('%i and %s count as one', async (code, frameReason, gatewayReason) => {
    const link = await openLink();
    ctl(code, frameReason)();
    session(gatewayReason)(link);
    await settle(2_500);
    expect(starts).toEqual([false]);
    expect(sessionsOpened()).toBe(2);
    expect(link.status()).toBe('open');
  });
});

describe('the gateway refusing the new session because the desk is stopping', () => {
  it('rests: that is a report, not a guess', async () => {
    const link = await openLink();
    ctl(4503, 'desk_stopping')();
    gateway.request.mockImplementation(() => Promise.reject(new GatewayError('desk_stopping', 'The desk is stopping.')));
    await settle(5 * 60 * 1000);
    expect(starts).toEqual([false]);
    expect(link.status()).toBe('idle');
    expect(link.details().desk?.state).toBe('stopping');
  });
});

describe('connect() on a link already at work: what each poll of the desk list does to it', () => {
  it('leaves an open link alone', async () => {
    const link = await openLink();
    link.connect();
    await settle(60_000);
    expect(starts).toEqual([]);
    expect(sessionsOpened()).toBe(1);
    expect(link.status()).toBe('open');
  });

  it('leaves a setup alone', async () => {
    answer = READY;
    const link = new RtcDeskLink('d-1');
    gateway.answer = (sessionId) => link.onMessage({ type: 'signal', sessionId, data: { type: 'answer', sdp: 'answer' } });
    let answerOpen = (): void => {};
    gateway.request.mockImplementationOnce(() => new Promise((resolve) => {
      answerOpen = () => resolve({ type: 'session.opened', sessionId: 'cs-1', iceServers: [] });
    }));
    link.connect();
    await settle();
    link.connect();
    await settle();
    expect(starts).toEqual([false]);
    expect(sessionsOpened()).toBe(1);
    answerOpen();
    await settle();
    expect(link.status()).toBe('open');
  });

  it('leaves the checks after a close alone', async () => {
    const link = await openLink();
    lastPeer().events.onCloseFrame(4503, 'desk_stopping');
    link.connect();
    await settle(1_500);
    expect(starts).toEqual([]);
    await settle(1_000);
    expect(starts).toEqual([false]);
  });

  it('reopens a resting link, with start: false', async () => {
    const link = await openLink();
    answer = STOPPING;
    lastPeer().events.onCloseFrame(4503, 'desk_stopping');
    await settle(5_000);
    expect(link.status()).toBe('idle');
    starts = [];
    answer = READY;
    link.connect();
    await settle();
    expect(starts).toEqual([false]);
    expect(link.status()).toBe('open');
  });

  it('a stopped desk that a stale list reopens gets one look, and no wake', async () => {
    const link = await openLink();
    answer = STOPPED;
    lastPeer().events.onCloseFrame(4503, 'desk_stopping');
    await settle(5_000);
    expect(link.status()).toBe('idle');
    starts = [];
    link.connect();
    await settle(5 * 60 * 1000);
    expect(starts).toEqual([false]);
    expect(link.status()).toBe('idle');
  });
});

describe('while a token refresh keeps failing', () => {
  // What `connect` rejects with when auth.ts has no access token to give. Neither a sign-out nor an ApiError.
  const REFRESH_FAILING = new Error('Token refresh failed for now');
  const FALLBACK_REFRESH_MS = 3 * 60 * 1000;
  const requests = (type: string): { deskToken?: string }[] => gateway.request.mock.calls.map(([m]) => m as { type: string; deskToken?: string }).filter((m) => m.type === type);

  it('leaves an open session alone, retries every 15 s, and delivers the token when it works', async () => {
    const link = await openLink();
    answer = REFRESH_FAILING;
    await settle(FALLBACK_REFRESH_MS);
    await settle(45_000);
    expect(gaps()).toEqual([15_000, 15_000, 15_000]);
    expect(link.status()).toBe('open');
    expect(gateway.sent.filter((m) => m.type === 'session.close')).toEqual([]);
    expect(requests('session.refresh')).toEqual([]);

    answer = READY;
    await settle(15_000);
    expect(requests('session.refresh')).toHaveLength(1);
    expect(link.status()).toBe('open');
    expect(sessionsOpened()).toBe(1);
  });

  it('when the desk closes on the expired token, shows the link states and comes back by itself', async () => {
    const link = await openLink();
    answer = REFRESH_FAILING;
    ctl(4401, 'token_expired')();
    await settle(1_500);
    expect(link.status()).toBe('retrying');
    await settle(35_000);
    expect(link.status()).toBe('retrying');
    expect(link.details().unreachable).toBe(true);
    expect(starts.every((start) => start === false)).toBe(true);

    answer = READY;
    await settle(40_000); // the link's own backoff is at its 30 s cap by now, give or take its jitter
    expect(link.status()).toBe('open');
    expect(link.details().unreachable).toBe(false);
    expect(sessionsOpened()).toBe(2);
  });

  it('resumes on the gateway with the token it holds, when `connect` can\'t answer', async () => {
    const link = await openLink();
    answer = REFRESH_FAILING;
    await settle(FALLBACK_REFRESH_MS);
    link.onUp();
    await settle();
    expect(requests('session.resume').map((m) => m.deskToken)).toEqual(['t']);
    expect(link.status()).toBe('open');
  });

  it('stops only when the session is over', async () => {
    const { SignInRequired } = await import('../../platform/auth');
    const link = await openLink();
    answer = new SignInRequired();
    ctl(4401, 'token_expired')();
    await settle(30_000);
    expect(link.status()).toBe('idle');
  });
});
