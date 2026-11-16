// The office tour's setting (ADR 0056 decision 9): a first visit is nothing recorded anywhere; Platform's
// `preferences.officeTour` once it's sent, else the layout document's `prefs.tourOff`, else this browser's record for this
// member; writes go to this browser first, the document once read, and Platform only while it sends the field; the
// catch-up of a choice the document never heard; the kill switch.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  stored: new Map<string, string>(),
  sets: [] as Record<string, unknown>[],
  puts: [] as { path: string; body: unknown }[],
  putFails: false,
  writable: true,
  read: true,
  memberChange: null as null | ((sub: string, before: string | null) => void),
}));
vi.stubGlobal('window', {
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  localStorage: { getItem: (k: string) => h.stored.get(k) ?? null, setItem: (k: string, v: string) => h.stored.set(k, v), removeItem: (k: string) => h.stored.delete(k) },
});
vi.mock('../platform/session', async () => {
  const { create: make } = await import('zustand');
  return { useSession: make(() => ({ me: { userId: 'u-1' } as Record<string, unknown> | null, config: null })) };
});
vi.mock('../platform/api', () => ({
  api: async (path: string, init: { body: string }) => {
    h.puts.push({ path, body: JSON.parse(init.body) });
    if (h.putFails) throw new Error('503');
    return { status: 200, data: {}, etag: null, retryAfter: null };
  },
}));
vi.mock('../state/deskStore', async () => {
  const { create: make } = await import('zustand');
  return { useDeskStore: make(() => ({ desks: [], status: 'ready' })) };
});
vi.mock('../state/layoutStore', () => ({ layoutMirrorWritable: () => h.writable }));
vi.mock('../platform/auth', () => ({
  onMemberChange: (fn: (sub: string, before: string | null) => void) => {
    h.memberChange = fn;
    return () => undefined;
  },
}));
vi.mock('../shell/layoutSync', async () => {
  const { useLayoutPrefs } = await import('../shell/layoutPrefs');
  return {
    layoutDocRead: () => h.read,
    layoutDocMember: () => undefined,
    readLayoutNow: () => undefined,
    onLayoutDocRead: () => () => true,
    setLayoutPref: (p: Record<string, unknown>) => {
      h.sets.push(p);
      useLayoutPrefs.setState(p);
    },
  };
});

const { adoptLayoutPrefs, resetLayoutPrefs } = await import('../shell/layoutPrefs');
const { useSession } = await import('../platform/session');
const d = await import('./door');
const { setTourOff } = await import('./prefs');

const me = (extra: Record<string, unknown> = {}): void => useSession.setState({ me: { userId: 'u-1', ...extra } });
const mirror = (): unknown => JSON.parse(h.stored.get(d.TOUR_MIRROR) ?? 'null');
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.stored.clear();
  h.sets = [];
  h.puts = [];
  h.putFails = false;
  h.writable = true;
  h.read = true;
  resetLayoutPrefs();
  d.useTour.setState({ tick: 0, sent: undefined, run: null });
  me();
});

describe('a first visit', () => {
  it('is nothing recorded on Platform, in the document or here: the tour is on', () => {
    expect(d.tourOff()).toBe(false);
  });
  it('a member who finished it on another device: the document says so, and this browser has nothing', () => {
    adoptLayoutPrefs({ tourOff: true });
    expect(d.tourOff()).toBe(true);
  });
  it('a member who finished it here, before the document heard: this browser says so', () => {
    h.stored.set(d.TOUR_MIRROR, JSON.stringify({ who: 'u-1', off: true }));
    expect(d.tourOff()).toBe(true);
  });
  it("another member's record here is never read", () => {
    h.stored.set(d.TOUR_MIRROR, JSON.stringify({ who: 'u-2', off: true }));
    expect(d.tourOff()).toBe(false);
  });
  it("the document wins over this browser's record (turned back on elsewhere)", () => {
    h.stored.set(d.TOUR_MIRROR, JSON.stringify({ who: 'u-1', off: true }));
    adoptLayoutPrefs({ tourOff: false });
    expect(d.tourOff()).toBe(false);
  });
  it('reads leniently: an odd value in the document or here is no value', () => {
    adoptLayoutPrefs({ tourOff: 'yes' });
    h.stored.set(d.TOUR_MIRROR, JSON.stringify({ who: 'u-1', off: 1 }));
    expect(d.tourOff()).toBe(false);
  });
});

describe("Platform's preferences.officeTour, once it's sent", () => {
  it('wins over the document and this browser', () => {
    adoptLayoutPrefs({ tourOff: true });
    me({ preferences: { staySignedIn: '30d', officeTour: { off: false } } });
    expect(d.tourOff()).toBe(false);
    me({ preferences: { officeTour: { off: true } } });
    adoptLayoutPrefs({ tourOff: false });
    expect(d.tourOff()).toBe(true);
  });
  it('null (sent, never set) or an odd shape falls through to the document', () => {
    adoptLayoutPrefs({ tourOff: true });
    me({ preferences: { officeTour: null } });
    expect(d.tourOff()).toBe(true);
    me({ preferences: { officeTour: { off: 'no' } } });
    expect(d.tourOff()).toBe(true);
  });
  it('absent (today): never asked for, never written', () => {
    me({ preferences: { staySignedIn: '7d' } });
    expect(d.serverTour(useSession.getState().me as never)).toBeUndefined();
    setTourOff(true);
    expect(h.puts).toEqual([]);
  });
  it('sent: each change goes to PUT /v1/me/preferences, and this page reads what it sent', async () => {
    me({ preferences: { officeTour: null } });
    setTourOff(true);
    await settle();
    expect(h.puts).toEqual([{ path: '/v1/me/preferences', body: { officeTour: { off: true } } }]);
    expect(d.tourOff()).toBe(true);
    setTourOff(false);
    await settle();
    expect(h.puts[1]?.body).toEqual({ officeTour: { off: false } });
    expect(d.tourOff()).toBe(false);
  });
  it('a failed PUT says nothing, and this browser and the document still hold the choice', async () => {
    me({ preferences: { officeTour: null } });
    h.putFails = true;
    setTourOff(true);
    await settle();
    expect(mirror()).toEqual({ who: 'u-1', off: true });
    expect(h.sets).toEqual([{ tourOff: true }]);
    expect(d.tourOff()).toBe(true);
  });
});

describe('writing the setting', () => {
  it("goes to this browser at once and to the document's prefs, for this member", () => {
    setTourOff(true);
    expect(mirror()).toEqual({ who: 'u-1', off: true });
    expect(h.sets).toEqual([{ tourOff: true }]);
    expect(d.tourOff()).toBe(true);
  });
  it('turned back on: false everywhere, so it starts the next time the office opens', () => {
    setTourOff(true);
    setTourOff(false);
    expect(mirror()).toEqual({ who: 'u-1', off: false });
    expect(h.sets.at(-1)).toEqual({ tourOff: false });
    expect(d.tourOff()).toBe(false);
  });
  it("before the document has been read, only this browser's record (so it can't write over another device's)", () => {
    h.read = false;
    setTourOff(true);
    expect(h.sets).toEqual([]);
    expect(mirror()).toEqual({ who: 'u-1', off: true });
  });
  it('after a sign-out has held the mirror, nothing is written here', () => {
    h.writable = false;
    setTourOff(true);
    expect(h.stored.has(d.TOUR_MIRROR)).toBe(false);
    expect(h.sets).toEqual([{ tourOff: true }]);
  });
  it("each write is a tick, so the account menu's switch shows a change only this browser has", () => {
    const before = d.useTour.getState().tick;
    setTourOff(true);
    expect(d.useTour.getState().tick).toBe(before + 1);
  });
});

describe('the catch-up once the document is read', () => {
  it("this browser's choice goes up when the document has none", () => {
    h.stored.set(d.TOUR_MIRROR, JSON.stringify({ who: 'u-1', off: true }));
    expect(d.catchUp(useSession.getState().me as never, {})).toEqual({ tourOff: true });
  });
  it("nothing when the document has one, when this browser has none, or when it's another member's", () => {
    h.stored.set(d.TOUR_MIRROR, JSON.stringify({ who: 'u-1', off: true }));
    expect(d.catchUp(useSession.getState().me as never, { tourOff: false })).toBeNull();
    h.stored.clear();
    expect(d.catchUp(useSession.getState().me as never, {})).toBeNull();
    h.stored.set(d.TOUR_MIRROR, JSON.stringify({ who: 'u-2', off: true }));
    expect(d.catchUp(useSession.getState().me as never, {})).toBeNull();
  });
});

describe('the kill switch and who it is for', () => {
  it('walkthrough: {enabled: false} is off; absent is on; no config yet is off', () => {
    expect(d.tourOn({ walkthrough: { enabled: false } } as never)).toBe(false);
    expect(d.tourOn({ walkthrough: { enabled: true } } as never)).toBe(true);
    expect(d.tourOn({} as never)).toBe(true);
    expect(d.tourOn(null)).toBe(false);
  });
  it('a Personal or Work desk is the member\'s own; a Guild Desk alone is not', () => {
    expect(['personal', 'work', 'guild'].map((kind) => d.ownDesk({ kind } as never))).toEqual([true, true, false]);
  });
});

describe('a change of member in this tab (ISS-67, ISS-89)', () => {
  it("the last member's open tour closes, and what this page sent Platform for them is forgotten", async () => {
    me({ preferences: { officeTour: null } });
    setTourOff(true);
    await settle();
    expect(d.useTour.getState().sent).toBe(true);
    d.useTour.setState({ run: { n: 1, auto: false, from: null } });
    const era = d.useTour.getState().era;
    h.memberChange?.('u-2', 'u-1');
    expect(d.useTour.getState()).toMatchObject({ run: null, sent: undefined, era: era + 1 });
    // The new member's own: Platform's null, nothing in their document (the sync starts over), nothing of theirs here: a first visit.
    resetLayoutPrefs();
    useSession.setState({ me: { userId: 'u-2', preferences: { officeTour: null } } });
    expect(d.tourOff()).toBe(false);
  });
  it('the first token of a page is nobody\'s change: nothing is reset', () => {
    d.useTour.setState({ run: { n: 1, auto: true, from: null } });
    const era = d.useTour.getState().era;
    h.memberChange?.('u-1', null);
    expect(d.useTour.getState().run).not.toBeNull();
    expect(d.useTour.getState().era).toBe(era);
  });
});
