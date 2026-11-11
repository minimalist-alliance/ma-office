// The tab's gateway socket, with a fake WebSocket: a reply answers its request, and a reply that carries new TURN
// servers (`session.opened` on an open or a resume, `session.refreshed`; ma-platform contract gateway.md 2.4) goes on to
// the links as well, whose session's connection takes them (`rtcDeskLink.turn.test.ts`).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../platform/clientConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform/clientConfig')>()),
  getClientConfig: () => Promise.resolve({ gateway: 'wss://gw.example.test/v1' }),
}));

class FakeWs {
  static readonly OPEN = 1;
  static last: FakeWs;
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
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
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  close(): void {}
  deliver(m: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

const SERVERS = [{ urls: ['turn:turn.example.test:443?transport=udp'], username: '1700000300:cs-1', credential: 'gw-credential-canary' }];

let gateway: (typeof import('./gateway'))['gateway'];
const listener = { onMessage: vi.fn(), onUp: vi.fn(), wantsGateway: () => true };

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeWs);
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval });
  vi.resetModules();
  ({ gateway } = await import('./gateway'));
  listener.onMessage.mockReset();
  gateway.add(listener);
});

afterEach(() => {
  gateway.remove(listener);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Sends `m` as a request and answers it with `reply`, which gets the request's id. */
async function ask(m: Record<string, unknown>, reply: Record<string, unknown>): Promise<unknown> {
  const answered = gateway.request(m as never, 5_000).catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(0);
  const sent = FakeWs.last.sent.find((s) => s['type'] === m['type']);
  FakeWs.last.deliver({ ...reply, id: sent?.['id'] });
  return answered;
}

describe('a reply with TURN servers', () => {
  it.each([
    ['session.refreshed', { type: 'session.refresh', sessionId: 'cs-1', deskToken: 't2' }],
    ['session.opened', { type: 'session.resume', sessionId: 'cs-1', deskId: 'd-1', deskToken: 't2' }],
  ])('%s answers its request, and goes on to the links once', async (type, request) => {
    const reply = { type, sessionId: 'cs-1', iceServers: SERVERS, iceServersExpireAt: '2026-11-10T23:05:30Z' };
    await expect(ask(request, reply)).resolves.toMatchObject(reply);
    expect(listener.onMessage).toHaveBeenCalledTimes(1);
    expect(listener.onMessage).toHaveBeenCalledWith(expect.objectContaining(reply));
  });

  it('none, where the env has no relay, answers only its request', async () => {
    await expect(ask({ type: 'session.refresh', sessionId: 'cs-1', deskToken: 't2' }, { type: 'session.refreshed', sessionId: 'cs-1' })).resolves.toMatchObject({ type: 'session.refreshed' });
    expect(listener.onMessage).not.toHaveBeenCalled();
  });

  it('an error answers only its request', async () => {
    const err = await ask({ type: 'session.refresh', sessionId: 'cs-1', deskToken: 't2' }, { type: 'error', code: 'desk_not_ready', retryable: true });
    expect(err).toMatchObject({ code: 'desk_not_ready', retryable: true });
    expect(listener.onMessage).not.toHaveBeenCalled();
  });

  it('a message that answers no request reaches the links, as ever', async () => {
    const up = gateway.ready();
    await vi.advanceTimersByTimeAsync(0);
    await up;
    FakeWs.last.deliver({ type: 'desk.state', deskId: 'd-1', state: 'running' });
    FakeWs.last.deliver({ type: 'pong' });
    expect(listener.onMessage).toHaveBeenCalledTimes(1);
    expect(listener.onMessage).toHaveBeenCalledWith({ type: 'desk.state', deskId: 'd-1', state: 'running' });
  });
});
