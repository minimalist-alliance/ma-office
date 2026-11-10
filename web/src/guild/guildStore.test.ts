// The guild store: the list becomes panels in the office, a guild that goes is said rather than vanishing, a refusal reads
// the list again, `?guild=` opens that Guild Desk, and the session's end forgets it all. Platform's API, the links, the layout
// and the camera are faked; the guild store and the desk store are the real code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const listeners: Record<string, (() => void)[]> = {};
  const target = {
    addEventListener: (type: string, fn: () => void) => (listeners[type] ??= []).push(fn),
    removeEventListener() {},
  };
  const replaced: string[] = [];
  const win = {
    ...target,
    setTimeout,
    clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    location: { search: '?fixture=one&guild=gu-two', href: 'https://office.example/?fixture=one&guild=gu-two' },
    history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  return { listeners, win, replaced, doc: { ...target, hidden: false } };
});
vi.stubGlobal('window', h.win);
vi.stubGlobal('document', h.doc);

const m = vi.hoisted(() => ({
  getGuilds: vi.fn(),
  getGuildDesk: vi.fn(),
  syncLinks: vi.fn(),
  reconcileLayout: vi.fn(),
  focusDesk: vi.fn(),
  setView: vi.fn(),
  layout: {} as Record<string, unknown>,
  links: new Map<string, { status: () => string; call: ReturnType<typeof vi.fn> }>(),
}));

vi.mock('./api', () => ({ getGuilds: m.getGuilds, getGuildDesk: m.getGuildDesk }));
vi.mock('../platform/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(readonly status: number) {
      super(`HTTP ${status}`);
    }
  },
}));
vi.mock('../platform/auth', () => ({ SignInRequired: class extends Error {} }));
vi.mock('../platform/clientConfig', () => ({ loadedConfig: () => null }));
vi.mock('../platform/session', async () => {
  const { create: make } = await import('zustand');
  return { useSession: make(() => ({ status: 'booting', me: null as { userId: string } | null })) };
});
vi.mock('../desk/liveStore', async () => {
  const { create: make } = await import('zustand');
  return { syncLinks: m.syncLinks, linkOf: (id: string) => m.links.get(id) ?? null, useLiveStore: make(() => ({ desks: {} as Record<string, { link: string }> })) };
});
vi.mock('../shell/actions', () => ({ focusDesk: m.focusDesk }));
vi.mock('../state/viewStore', () => ({ setView: m.setView }));
vi.mock('../state/layoutStore', () => ({ reconcileLayout: m.reconcileLayout, useLayoutStore: { getState: () => ({ desks: m.layout }) } }));

const { useGuildStore, dismissRemoved, resetGuildsForTest, startGuilds } = await import('./guildStore');
const { useDeskStore } = await import('../state/deskStore');
const { useSession } = await import('../platform/session');
const { useLiveStore } = await import('../desk/liveStore');
const { ApiError: RealApiError } = await import('../platform/api');
/** The mocked ApiError takes only a status. */
const ApiError = RealApiError as unknown as new (status: number) => Error;
const live = (desks: Record<string, { link: string }>): void => useLiveStore.setState({ desks } as never);

const ONE = { guildId: 'gu-one', name: 'Platform team', role: 'lead', grants: ['moderate'] };
const TWO = { guildId: 'gu-two', name: 'Design review', role: 'member', grants: [] };
const listed = (...guilds: unknown[]) => Promise.resolve({ status: 200, data: { guilds }, etag: null, retryAfter: null });
const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};
const guildDesks = () => useDeskStore.getState().desks.filter((d) => d.kind === 'guild');

beforeEach(() => {
  vi.useFakeTimers();
  // The store calls `window.setTimeout`: the faked one, from now.
  h.win.setTimeout = setTimeout;
  h.win.clearTimeout = clearTimeout;
  resetGuildsForTest('');
  useDeskStore.setState({ desks: [{ id: 'd-1', name: 'Personal', kind: 'personal', vm: 'running', phase: 'ready', queuePosition: null, stopAt: null, givebackUntil: null, badges: {} }], status: 'ready', unpaid: null });
  m.getGuilds.mockReset();
  m.getGuildDesk.mockReset();
  m.getGuildDesk.mockImplementation(() => Promise.resolve({ status: 200, data: { deskId: 'd-g1', state: 'stopped' } }));
  m.syncLinks.mockReset();
  m.reconcileLayout.mockReset();
  m.focusDesk.mockReset();
  m.setView.mockReset();
  m.links.clear();
  for (const k of Object.keys(m.layout)) delete m.layout[k];
  h.replaced.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the list becomes panels', () => {
  it('each guild a Guild Desk named for it, after the member’s own, with its links and layout', async () => {
    m.getGuilds.mockImplementation(() => listed(ONE, TWO));
    startGuilds();
    await settle();
    expect(guildDesks().map((d) => [d.id, d.name, d.kind, d.guild?.role])).toEqual([
      ['guild-gu-one', 'Platform team', 'guild', 'lead'],
      ['guild-gu-two', 'Design review', 'guild', 'member'],
    ]);
    expect(useDeskStore.getState().desks[0]?.id).toBe('d-1');
    expect(m.reconcileLayout).toHaveBeenLastCalledWith(['d-1', 'guild-gu-one', 'guild-gu-two']);
    expect(m.syncLinks).toHaveBeenLastCalledWith(['d-1', 'guild-gu-one', 'guild-gu-two']);
  });

  it('at most three', async () => {
    m.getGuilds.mockImplementation(() => listed(ONE, TWO, { ...TWO, guildId: 'gu-3' }, { ...TWO, guildId: 'gu-4' }));
    startGuilds();
    await settle();
    expect(guildDesks()).toHaveLength(3);
  });

  it('learns each sleeping Guild Desk’s state with the list', async () => {
    m.getGuilds.mockImplementation(() => listed(ONE));
    startGuilds();
    await settle();
    expect(m.getGuildDesk).toHaveBeenCalledWith('gu-one');
    expect(guildDesks()[0]?.vm).toBe('stopped');
  });

  it('waits for the member’s own list before it lays anything out', async () => {
    useDeskStore.setState({ status: 'loading' });
    m.getGuilds.mockImplementation(() => listed(ONE));
    startGuilds();
    await settle();
    expect(guildDesks()).toHaveLength(1);
    expect(m.reconcileLayout).not.toHaveBeenCalled();
  });

  it('a Platform with no guild routes shows none, and stops asking', async () => {
    m.getGuilds.mockImplementation(() => Promise.reject(new ApiError(404)));
    startGuilds();
    await settle();
    expect(useGuildStore.getState().status).toBe('off');
    await settle(10 * 60_000);
    expect(m.getGuilds).toHaveBeenCalledTimes(1);
  });

  it('a passing failure keeps what’s shown and asks again later', async () => {
    m.getGuilds.mockImplementationOnce(() => listed(ONE)).mockImplementation(() => Promise.reject(new ApiError(503)));
    startGuilds();
    await settle();
    await settle(60_000);
    expect(guildDesks()).toHaveLength(1);
    expect(useGuildStore.getState().status).toBe('ready');
    await settle(15_000);
    expect(m.getGuilds.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe('a guild the member is no longer in', () => {
  it('stays as a calm panel until they put it away', async () => {
    m.getGuilds.mockImplementationOnce(() => listed(ONE, TWO)).mockImplementation(() => listed(ONE));
    startGuilds();
    await settle();
    await settle(60_000);
    const two = guildDesks().find((d) => d.id === 'guild-gu-two');
    expect(two).toMatchObject({ removed: true, vm: 'removed', name: 'Design review' });
    expect(useGuildStore.getState().removed).toEqual({ 'gu-two': 'Design review' });
    dismissRemoved('gu-two');
    expect(guildDesks().map((d) => d.id)).toEqual(['guild-gu-one']);
  });

  it('a refused guild route reads the list again at once, not a minute later', async () => {
    m.getGuilds.mockImplementationOnce(() => listed(ONE, TWO)).mockImplementation(() => listed(ONE));
    startGuilds();
    await settle();
    const calls = m.getGuilds.mock.calls.length;
    m.getGuildDesk.mockImplementation(() => Promise.reject(new ApiError(403)));
    const { GuildAccess } = await import('./access');
    await new GuildAccess('gu-two').connect(false, 'sha-256 AA').catch(() => {});
    await settle(1_000);
    expect(m.getGuilds.mock.calls.length).toBe(calls + 1);
    expect(useGuildStore.getState().removed).toEqual({ 'gu-two': 'Design review' });
  });

  it('a guild route that keeps refusing a guild still listed costs a read a minute at most', async () => {
    m.getGuilds.mockImplementation(() => listed(ONE));
    startGuilds();
    await settle();
    m.getGuildDesk.mockImplementation(() => Promise.reject(new ApiError(403)));
    const { GuildAccess } = await import('./access');
    const calls = m.getGuilds.mock.calls.length;
    for (let i = 0; i < 10; i += 1) {
      await new GuildAccess('gu-one').connect(false, 'sha-256 AA').catch(() => {});
      await settle(3_000);
    }
    expect(m.getGuilds.mock.calls.length - calls).toBeLessThanOrEqual(2);
    expect(useGuildStore.getState().removed).toEqual({});
  });

  it('coming back to the guild makes it a Guild Desk again', async () => {
    m.getGuilds.mockImplementationOnce(() => listed(ONE, TWO)).mockImplementationOnce(() => listed(ONE)).mockImplementation(() => listed(ONE, TWO));
    startGuilds();
    await settle();
    await settle(60_000);
    expect(useGuildStore.getState().removed).toHaveProperty('gu-two');
    await settle(60_000);
    expect(useGuildStore.getState().removed).toEqual({});
    expect(guildDesks().find((d) => d.id === 'guild-gu-two')?.removed).toBeUndefined();
  });
});

describe('?guild= from the guild app', () => {
  it('selects the Guild scope and focuses that Guild Desk, which is a wake, once its panel is laid out', async () => {
    resetGuildsForTest('?guild=gu-two');
    m.layout['guild-gu-two'] = { id: 'guild-gu-two' };
    m.getGuilds.mockImplementation(() => listed(ONE, TWO));
    startGuilds();
    await settle();
    expect(m.setView).toHaveBeenCalledWith({ scope: 'guild' });
    expect(m.focusDesk).toHaveBeenCalledWith('guild-gu-two');
    expect(h.replaced[0]).toBe('/?fixture=one');
    await settle(60_000);
    expect(m.focusDesk).toHaveBeenCalledTimes(1);
  });

  it('waits for the member’s own list, then opens it as that list lands', async () => {
    resetGuildsForTest('?guild=gu-two');
    useDeskStore.setState({ status: 'loading' });
    m.getGuilds.mockImplementation(() => listed(ONE, TWO));
    startGuilds();
    await settle();
    expect(m.focusDesk).not.toHaveBeenCalled();
    m.layout['guild-gu-two'] = { id: 'guild-gu-two' }; // the session lays out both parts, then sets its list
    useDeskStore.setState({ status: 'ready' });
    expect(m.focusDesk).toHaveBeenCalledWith('guild-gu-two');
  });

  it('a guild that isn’t theirs opens nothing, and the address loses it', async () => {
    resetGuildsForTest('?guild=gu-nope');
    m.getGuilds.mockImplementation(() => listed(ONE));
    startGuilds();
    await settle();
    expect(m.focusDesk).not.toHaveBeenCalled();
    expect(h.replaced).toHaveLength(1);
  });
});

describe('who deskd says this member is', () => {
  it('asks guild.hello once per session, and it wins over the list', async () => {
    m.getGuilds.mockImplementation(() => listed(TWO));
    startGuilds();
    await settle();
    const call = vi.fn(() => Promise.resolve({ guildId: 'gu-two', memberId: 'gm-1', role: 'officer', grants: ['manage_agents'], name: 'Dana' }));
    m.links.set('guild-gu-two', { status: () => 'open', call });
    live({ 'guild-gu-two': { link: 'open' } });
    await settle();
    live({ 'guild-gu-two': { link: 'open' }, 'd-1': { link: 'open' } });
    await settle();
    expect(call).toHaveBeenCalledTimes(1);
    expect(useGuildStore.getState().hello['gu-two']).toMatchObject({ role: 'officer', name: 'Dana' });
    live({ 'guild-gu-two': { link: 'retrying' } });
    live({ 'guild-gu-two': { link: 'open' } });
    await settle();
    expect(call).toHaveBeenCalledTimes(2);
  });
});

describe('with the session', () => {
  it('starts once /v1/me says who, and forgets everything when the session ends', async () => {
    m.getGuilds.mockImplementation(() => listed(ONE));
    useSession.setState({ status: 'signedIn', me: { userId: 'u-1' } });
    await settle();
    expect(m.getGuilds).toHaveBeenCalledTimes(1);
    expect(useGuildStore.getState().guilds).toHaveLength(1);
    useSession.setState({ status: 'signedOut', me: null });
    expect(useGuildStore.getState().guilds).toEqual([]);
    await settle(10 * 60_000);
    expect(m.getGuilds).toHaveBeenCalledTimes(1);
  });
});
