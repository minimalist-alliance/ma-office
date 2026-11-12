// The guild store: the list becomes panels in the office, a guild that goes is said rather than vanishing, a refusal reads
// the list again, `?guild=` opens that Guild Desk, and the session's end forgets it all, as does a change of account in the
// tab, Guild Desk links and all. Platform's API, the links, the layout and the camera are faked; the guild store and the desk
// store are the real code.
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
  /** `onMemberChange`'s listeners other than the session's (`platform/auth.ts`). */
  memberChange: [] as ((sub: string, before: string | null) => void)[],
  forgetLinks: vi.fn(),
}));

vi.mock('./api', () => ({ getGuilds: m.getGuilds, getGuildDesk: m.getGuildDesk }));
vi.mock('../platform/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(readonly status: number) {
      super(`HTTP ${status}`);
    }
  },
}));
vi.mock('../platform/auth', () => ({
  SignInRequired: class extends Error {},
  onMemberChange: (fn: (sub: string, before: string | null) => void) => {
    m.memberChange.push(fn);
    return () => {};
  },
}));
vi.mock('../platform/clientConfig', () => ({ loadedConfig: () => null }));
vi.mock('../platform/session', async () => {
  const { create: make } = await import('zustand');
  return { useSession: make(() => ({ status: 'booting', me: null as { userId: string } | null })) };
});
vi.mock('../desk/liveStore', async () => {
  const { create: make } = await import('zustand');
  const useLiveStore = make(() => ({ desks: {} as Record<string, { link: string }> }));
  return {
    syncLinks: m.syncLinks,
    linkOf: (id: string) => m.links.get(id) ?? null,
    useLiveStore,
    // As the real one: those links closed and gone, and what their sessions said with them.
    forgetLinks: (which: (deskId: string) => boolean) => {
      m.forgetLinks(which);
      for (const id of [...m.links.keys()]) if (which(id)) m.links.delete(id);
      useLiveStore.setState((s) => ({ desks: Object.fromEntries(Object.entries(s.desks).filter(([id]) => !which(id))) }));
    },
  };
});
vi.mock('../shell/actions', () => ({ focusDesk: m.focusDesk }));
vi.mock('../state/viewStore', () => ({ setView: m.setView }));
vi.mock('../state/layoutStore', () => ({ reconcileLayout: m.reconcileLayout, useLayoutStore: { getState: () => ({ desks: m.layout }) } }));

const { useGuildStore, askGuildLimits, chooseLinkDesk, dismissRemoved, openGuildSheet, resetGuildsForTest, setGuildCaps, startGuilds } = await import('./guildStore');
const { dropDeskList, useDeskStore } = await import('../state/deskStore');
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
  m.forgetLinks.mockReset();
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

describe('a change of account in this tab (a sign-in as someone else in another tab)', () => {
  /**
   * This tab's tokens become `to`'s. The session's own listener runs first, as it's registered first (`platform/session.ts`):
   * the last member's desk list goes, and `me` with it until `/v1/me` answers for the new one. Then the guild store's own.
   */
  function becomes(to: string, from: string): void {
    dropDeskList();
    useSession.setState({ me: null });
    for (const fn of m.memberChange) fn(to, from);
  }
  /** `/v1/me` answers for them, and the guild store starts for them. */
  const meIs = (userId: string): void => useSession.setState({ status: 'signedIn', me: { userId } });
  const hello = (name: string, role: string) => vi.fn(() => Promise.resolve({ guildId: 'gu-two', memberId: `gm-${name.toLowerCase()}`, role, grants: role === 'lead' ? ['manage_agents'] : [], name }));

  beforeEach(() => {
    live({});
  });
  afterEach(() => {
    useSession.setState({ status: 'booting', me: null });
    live({});
  });

  it('every Guild Desk’s link closes at once, so the new member’s opens on a guild token of their own: a guild’s panel is the same for every member in it', async () => {
    m.getGuilds.mockImplementation(() => listed(ONE, TWO));
    meIs('u-a');
    await settle();
    const call = vi.fn(() => new Promise(() => {}));
    for (const id of ['d-1', 'guild-gu-one', 'guild-gu-two']) m.links.set(id, { status: () => 'open', call });
    becomes('u-b', 'u-a');
    // The member's own desks' links are the session's: the new member's list closes them, as their ids are the last member's alone.
    expect([...m.links.keys()]).toEqual(['d-1']);
  });

  it('the first token, or a sign-in in this tab, closes nothing', async () => {
    m.getGuilds.mockImplementation(() => listed(TWO));
    meIs('u-a');
    await settle();
    m.links.set('guild-gu-two', { status: () => 'open', call: vi.fn(() => new Promise(() => {})) });
    for (const fn of m.memberChange) fn('u-a', null);
    expect([...m.links.keys()]).toEqual(['guild-gu-two']);
    expect(m.forgetLinks).not.toHaveBeenCalled();
    expect(guildDesks()).toHaveLength(1);
  });

  it('nothing the last member’s Guild Desk session says lands in the new member’s office, in a guild they’re both in', async () => {
    m.getGuilds.mockImplementation(() => listed(TWO));
    meIs('u-a');
    await settle();
    const a = hello('Dana', 'lead');
    m.links.set('guild-gu-two', { status: () => 'open', call: a });
    live({ 'guild-gu-two': { link: 'open' } });
    await settle();
    expect(useGuildStore.getState().hello['gu-two']).toMatchObject({ name: 'Dana', role: 'lead' });

    becomes('u-b', 'u-a');
    expect(useGuildStore.getState().hello).toEqual({});
    meIs('u-b'); // B's list: the same guild, as a plain member
    await settle();
    // The office goes on (B's own desk's link opens, say), which the store hears.
    live({ ...useLiveStore.getState().desks, 'd-b': { link: 'open' } });
    await settle();
    expect(a).toHaveBeenCalledTimes(1); // never asked again, on the last member's session
    expect(useGuildStore.getState().hello['gu-two']).toBeUndefined();

    // B's own session on it, opened with B's guild token, says who B is.
    const b = hello('Robin', 'member');
    m.links.set('guild-gu-two', { status: () => 'open', call: b });
    live({ ...useLiveStore.getState().desks, 'guild-gu-two': { link: 'connecting' } });
    live({ ...useLiveStore.getState().desks, 'guild-gu-two': { link: 'open' } });
    await settle();
    expect(b).toHaveBeenCalledTimes(1);
    expect(useGuildStore.getState().hello['gu-two']).toMatchObject({ name: 'Robin', role: 'member' });
  });

  it('none of the last member’s Guild Desks, nor a word that they left a guild, show for the new member, before or after the new member’s list', async () => {
    m.getGuilds.mockImplementation(() => listed(ONE, TWO));
    meIs('u-a');
    await settle();
    expect(guildDesks()).toHaveLength(2);
    // A's next read of the list is on its way at the change, and answers after it.
    let lateA: (v: unknown) => void = () => {};
    m.getGuilds.mockImplementationOnce(() => new Promise((done) => (lateA = done)));
    await settle(60_000);

    becomes('u-b', 'u-a');
    expect(guildDesks()).toEqual([]);
    expect(useGuildStore.getState()).toMatchObject({ status: 'idle', guilds: [], desks: {}, hello: {}, removed: {} });
    let listB: (v: unknown) => void = () => {};
    m.getGuilds.mockImplementationOnce(() => new Promise((done) => (listB = done)));
    meIs('u-b');
    await settle();
    lateA(await listed(ONE, TWO));
    await settle();
    expect(guildDesks()).toEqual([]);
    expect(useGuildStore.getState().guilds).toEqual([]);

    // B is in Design review alone: Platform team is A's, and B never left it.
    listB(await listed(TWO));
    await settle();
    expect(guildDesks().map((d) => [d.id, d.name, d.removed])).toEqual([['guild-gu-two', 'Design review', undefined]]);
    expect(useGuildStore.getState().removed).toEqual({});

    // A late word on A's Guild Desk, from a link that was on its way: not one of B's guilds, so nothing.
    m.getGuildDesk.mockImplementation(() => Promise.resolve({ status: 200, data: { deskId: 'd-g1', state: 'stopped' } }));
    const { GuildAccess } = await import('./access');
    await new GuildAccess('gu-one').connect(false, 'sha-256 AA');
    expect(useGuildStore.getState().desks).not.toHaveProperty('gu-one');
    expect(guildDesks().map((d) => d.id)).toEqual(['guild-gu-two']);
  });

  it('what the last member had open or asked for goes: the settings sheet, a link waiting for a desk, the caps and the Guild limits asks', async () => {
    m.getGuilds.mockImplementation(() => listed(ONE));
    meIs('u-a');
    await settle();
    openGuildSheet('gu-one', 'usage');
    chooseLinkDesk('https://example.org/from-a-guild-page');
    setGuildCaps('gu-one', { runsPerDay: 5, usdPerDay: 1, usdPerMonth: 10 });
    askGuildLimits('guild-gu-one');
    becomes('u-b', 'u-a');
    expect(useGuildStore.getState()).toMatchObject({ sheet: null, linkChoice: null, caps: {}, limitsAsk: {} });
    meIs('u-b');
    await settle();
    expect(useGuildStore.getState()).toMatchObject({ sheet: null, linkChoice: null, caps: {}, limitsAsk: {} });
  });

  it('a `?guild=` the last member’s list hadn’t reached yet isn’t opened for the new member, and the address loses it', async () => {
    resetGuildsForTest('?guild=gu-two');
    m.layout['guild-gu-two'] = { id: 'guild-gu-two' };
    m.getGuilds.mockImplementationOnce(() => new Promise(() => {})).mockImplementation(() => listed(ONE, TWO));
    meIs('u-a');
    await settle();
    becomes('u-b', 'u-a');
    meIs('u-b');
    await settle();
    useDeskStore.setState({ status: 'ready' }); // B's own list lands
    await settle();
    expect(m.focusDesk).not.toHaveBeenCalled();
    expect(m.setView).not.toHaveBeenCalled();
    expect(h.replaced).toEqual(['/?fixture=one']);
  });
});
