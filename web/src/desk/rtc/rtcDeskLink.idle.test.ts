// The link's side of the idle rule: `rest` closes the session and keeps the watch, and nothing on this path can
// send `start: true`. Only a member's `wake()` can. The gateway and peer are faked, the link is real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { api, gateway, peers } = vi.hoisted(() => ({
  api: vi.fn(),
  peers: [] as { closed: boolean; sendActivity: ReturnType<typeof vi.fn> }[],
  gateway: {
    request: vi.fn(),
    answer: (() => {}) as (sessionId: string | undefined) => void,
    sent: [] as { type: string; reason?: string; deskToken?: string }[],
    add: vi.fn(),
    remove: vi.fn(),
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
vi.mock('./gateway', () => ({ GatewayError: class extends Error {}, gateway }));
vi.mock('./peer', () => ({
  PeerSession: class {
    channelsOpen = Promise.resolve();
    closed = false;
    sendActivity = vi.fn();
    constructor() {
      peers.push(this);
    }
    createOffer = () => Promise.resolve('offer');
    applyAnswer = () => Promise.resolve();
    media = () => ({ stream: {}, canPlayVideo: true });
    hello = () => Promise.resolve({ deskApi: '1.0', resumeToken: 'r' });
    sendAuth() {}
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

const REFRESH_MS = 60_000;
let answer: { state: string; phase: string } = { state: 'running', phase: 'ready' };
let starts: boolean[] = [];

const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};
const lastPeer = (): (typeof peers)[number] => peers[peers.length - 1] as (typeof peers)[number];
const sent = (type: string): { type: string; reason?: string }[] => gateway.sent.filter((m) => m.type === type);

async function openLink(): Promise<InstanceType<typeof RtcDeskLink>> {
  const link = new RtcDeskLink('d-1');
  gateway.answer = (sessionId) => link.onMessage({ type: 'signal', sessionId, data: { type: 'answer', sdp: 'answer' } });
  link.connect();
  await settle();
  expect(link.status()).toBe('open');
  starts = [];
  gateway.sent.length = 0;
  return link;
}

beforeEach(() => {
  vi.useFakeTimers();
  answer = { state: 'running', phase: 'ready' };
  starts = [];
  peers.length = 0;
  gateway.sent.length = 0;
  gateway.remove.mockClear();
  let next = 1;
  gateway.request.mockReset();
  gateway.request.mockImplementation((m: { type: string }) => Promise.resolve({ type: m.type, sessionId: `cs-${next++}`, iceServers: [] }));
  api.mockReset();
  api.mockImplementation((_path: string, init: { body: string }) => {
    starts.push((JSON.parse(init.body) as { start: boolean }).start);
    return Promise.resolve({
      status: 200,
      etag: null,
      retryAfter: null,
      data: { ...answer, deskToken: 't', refreshAfter: new Date(Date.now() + REFRESH_MS / 0.9).toISOString(), deskIdentity: { fingerprintsSha256: ['aa'] } },
    });
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
});

describe('rest', () => {
  it('closes the session with closed_by_client, and says resting', async () => {
    const link = await openLink();
    const peer = lastPeer();
    link.rest();
    expect(peer.closed).toBe(true);
    expect(sent('session.close')[0]?.reason).toBe('closed_by_client');
    expect(link.status()).toBe('resting');
    expect(link.media()).toBeNull();
    expect(link.input()).toBeNull();
    link.close();
  });

  it('keeps only the watch: the token keeps being refreshed for it, with start: false, and no new session', async () => {
    const link = await openLink();
    link.rest();
    expect(gateway.remove).not.toHaveBeenCalled();
    await settle(REFRESH_MS * 5 + 100);
    expect(starts.length).toBeGreaterThanOrEqual(4);
    expect(starts).not.toContain(true);
    expect(sent('watch').length).toBeGreaterThanOrEqual(4);
    expect(peers).toHaveLength(1);
    expect(link.status()).toBe('resting');
    link.close();
  });

  it('a connect from the desk list does not undo it', async () => {
    const link = await openLink();
    link.rest();
    link.connect();
    await settle(30_000);
    expect(peers).toHaveLength(1);
    expect(link.status()).toBe('resting');
    link.close();
  });

  it('does nothing to a link that has already stopped, and twice is once', async () => {
    const link = await openLink();
    link.rest();
    const closes = sent('session.close').length;
    link.rest();
    expect(sent('session.close')).toHaveLength(closes);
    link.close();
    expect(link.status()).toBe('idle');
    link.rest();
    expect(link.status()).toBe('idle');
  });

  it('the desk stopping while it rests: idle, and nothing asks to wake it', async () => {
    const link = await openLink();
    link.rest();
    link.onMessage({ type: 'desk.state', deskId: 'd-1', state: 'stopped' });
    expect(link.status()).toBe('idle');
    expect(gateway.remove).toHaveBeenCalled();
    await settle(10 * 60 * 1000);
    expect(starts).not.toContain(true);
    expect(link.details().desk?.state).toBe('stopped');
  });

  it('a refresh finding the desk stopped: the same', async () => {
    const link = await openLink();
    link.rest();
    answer = { state: 'stopped', phase: 'stopped' };
    await settle(REFRESH_MS + 100);
    expect(link.status()).toBe('idle');
    expect(starts).not.toContain(true);
  });
});

describe('reopen', () => {
  it('opens a new session, with start: false', async () => {
    const link = await openLink();
    link.rest();
    starts = [];
    link.reopen();
    await settle();
    expect(link.status()).toBe('open');
    expect(starts).toEqual([false]);
    expect(peers).toHaveLength(2);
    link.close();
  });

  it('a desk that stopped meanwhile stays asleep: reopening never wakes one', async () => {
    const link = await openLink();
    link.rest();
    answer = { state: 'stopped', phase: 'stopped' };
    starts = [];
    link.reopen();
    await settle(10 * 60 * 1000);
    expect(starts).toEqual([false]);
    expect(link.status()).toBe('idle');
  });

  it('does nothing to a link that is not resting', async () => {
    const link = await openLink();
    link.reopen();
    await settle();
    expect(peers).toHaveLength(1);
    link.close();
  });
});

describe('wake', () => {
  it('a click on a resting desk that has since stopped does wake it, because the member asked', async () => {
    const link = await openLink();
    link.rest();
    answer = { state: 'stopped', phase: 'stopped' };
    starts = [];
    link.wake();
    await settle();
    expect(starts).toEqual([false, true]);
    link.close();
  });

  it('a click on a resting desk that is running just opens a session', async () => {
    const link = await openLink();
    link.rest();
    starts = [];
    link.wake();
    await settle();
    expect(starts).toEqual([false]);
    expect(link.status()).toBe('open');
    link.close();
  });
});

describe('ACTIVITY', () => {
  it('goes at most once a minute, and only with a session open', async () => {
    const link = await openLink();
    link.reportActivity();
    link.reportActivity();
    expect(lastPeer().sendActivity).toHaveBeenCalledTimes(1);
    await settle(59_000);
    link.reportActivity();
    expect(lastPeer().sendActivity).toHaveBeenCalledTimes(1);
    await settle(1_000);
    link.reportActivity();
    expect(lastPeer().sendActivity).toHaveBeenCalledTimes(2);
    expect(String(lastPeer().sendActivity.mock.calls[1]?.[0])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    link.rest();
    await settle(120_000);
    link.reportActivity();
    expect(peers[0]?.sendActivity).toHaveBeenCalledTimes(2);
    link.close();
  });
});
