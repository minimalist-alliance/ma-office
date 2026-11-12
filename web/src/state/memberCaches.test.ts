// The member's other caches in this browser (ISS-89), beside the saved layout's mirror (ISS-67): every key, held to each
// module's own constant; wiped with the mirror, this tab's sessionStorage keys included, while the device keeps its own;
// never written once this page has signed out, or while no refresh token is kept here (a stale tab after another tab's
// sign-out); and kept per account, so a sign-in as anyone else finds none of the last account's, in storage or in the
// tab. `platform/session.signedOut.test.ts` drives every signed-out state through the session with these seeded, and
// `quality/store.test.ts` and `browser/lastScreen.store.test.ts` have the stream quality's and the pictures' own.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ memberChange: [] as ((sub: string, before: string | null) => void)[] }));
vi.mock('../platform/auth', async (orig) => ({
  ...(await orig<typeof import('../platform/auth')>()),
  onMemberChange: (fn: (sub: string, before: string | null) => void) => {
    h.memberChange.push(fn);
    return () => {};
  },
}));
vi.mock('../desk/liveStore', () => ({ getLive: () => ({ refusal: null }) }));
vi.mock('../state/viewStore', () => ({ getView: () => ({ mode: 'office', activeDesk: null }) }));

type Store = typeof import('./layoutStore');

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

const REFRESH_KEY = 'ma-desk-web-refresh';
/** Written out, so a key dropped from a list fails here rather than staying behind for the next person. */
const CACHES = ['ma.streamQuality.v1', 'ma.streamQuality.desks.v1', 'ma.boots.seen.v1', 'ma.bandwidth.notice.v1', 'ma.guild.privacy.v1', 'ma.browser.touchHint.v1', 'ma.rttCapped.v1', 'ma.menu.about.v1'];
const TAB = ['ma.maia.conversation.v1', 'ma.maia.open.v1'];
/** This device's own, which stay: the theme, the view, Maia's motion, a Notebook's zone sent, the phone's carousel. */
const DEVICE = ['ma.prefs.theme', 'ma.view.v1', 'ma.maia.motion.v1', 'ma.notebook.tz.d-personal'];

let local: Storage;
let tab: Storage;
let store: Store;

/** What member A's visits left: each cache with A's id or desks in it, and this tab's Maia conversation. */
function seed(owner: string | null = 'u-a', tabOwner: string | null = owner): void {
  local.setItem('ma.streamQuality.v1', JSON.stringify({ sub: 'u-a', doc: { default: 'low', apps: {}, desks: { 'd-personal': { level: 'high' } }, updatedAt: null } }));
  local.setItem('ma.streamQuality.desks.v1', JSON.stringify({ sub: 'u-a', desks: { 'd-work': { browser: 'low' } } }));
  local.setItem('ma.boots.seen.v1', JSON.stringify({ 'd-home': '2026-11-11T20:00:00Z' }));
  local.setItem('ma.bandwidth.notice.v1', 'warn:2026-11-09T00:00:00Z');
  local.setItem('ma.guild.privacy.v1', '1');
  local.setItem('ma.browser.touchHint.v1', JSON.stringify(['u-a']));
  local.setItem('ma.rttCapped.v1', JSON.stringify({ sub: 'u-a', until: Date.now() + 3_600_000 }));
  local.setItem('ma.menu.about.v1', 'true');
  if (owner) local.setItem('ma.layout.owner.v1', owner);
  tab.setItem('ma.maia.conversation.v1', 'c-of-a');
  tab.setItem('ma.maia.open.v1', '1');
  if (tabOwner) tab.setItem('ma.layout.owner.v1', tabOwner);
  local.setItem('ma.prefs.theme', 'dark');
  local.setItem('ma.view.v1', JSON.stringify({ scope: 'work', activeDesk: 'd-work', mode: 'desk' }));
  local.setItem('ma.maia.motion.v1', 'paused');
  local.setItem('ma.notebook.tz.d-personal', 'America/Denver');
  tab.setItem('ma.phoneCarousel.v1', JSON.stringify({ 'd-work': 'browser' }));
}

const cachesLeft = (): string[] => CACHES.filter((k) => local.getItem(k) !== null);
const tabLeft = (): string[] => TAB.filter((k) => tab.getItem(k) !== null);
const signedIn = (on: boolean): void => (on ? local.setItem(REFRESH_KEY, 'refresh-1') : local.removeItem(REFRESH_KEY));

async function load(owner: string | null = 'u-a', tabOwner: string | null = owner): Promise<void> {
  seed(owner, tabOwner);
  vi.resetModules();
  h.memberChange = [];
  store = await import('./layoutStore');
  // As `platform/session.ts` does as it loads.
  store.mirrorFollowsToken((await import('../platform/tokenStore')).hasStoredToken);
}

beforeEach(() => {
  vi.useFakeTimers();
  local = memoryStorage();
  tab = memoryStorage();
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', tab);
  vi.stubGlobal('window', {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    localStorage: local,
    sessionStorage: tab,
  });
  signedIn(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the keys', () => {
  it("are every per-member key outside the layout's mirror, each module's own constant", async () => {
    await load();
    const quality = await import('../quality/store');
    const boots = await import('../platform/bootNotice');
    const bandwidth = await import('../bandwidth/seen');
    const touch = await import('../browser/touchInput');
    const rtt = await import('../desk/rtc/connectRtt');
    const about = await import('./../chrome/aboutOpen');
    const maia = await import('../maia/chat');
    // The guild's file is the Guild Engineer's, and its chunk's; its constant is read as written.
    const guild = /PRIVACY_KEY = '([^']+)'/.exec(readFileSync(new URL('../guild/GuildLayer.tsx', import.meta.url), 'utf8'))?.[1];
    expect([...store.MEMBER_CACHE_KEYS].sort()).toEqual([...CACHES].sort());
    for (const key of [quality.MIRROR_KEY, quality.DESK_MIRROR_KEY, boots.SEEN_KEY, bandwidth.SEEN_KEY, guild, touch.HINT_KEY, rtt.CAP_KEY, about.ABOUT_KEY]) expect(store.MEMBER_CACHE_KEYS).toContain(key);
    expect([...store.MEMBER_TAB_KEYS].sort()).toEqual([...TAB, 'ma.layout.owner.v1'].sort());
    for (const key of [maia.CONVERSATION_KEY, maia.OPEN_KEY]) expect(store.MEMBER_TAB_KEYS).toContain(key);
    // None is the layout's own: those are ISS-67's list, held in `layoutMirror.test.ts`.
    for (const key of store.MEMBER_CACHE_KEYS) expect(store.LAYOUT_MIRROR_KEYS).not.toContain(key);
  });
});

describe('a wipe (every signed-out state)', () => {
  it("takes every cache and this tab's Maia keys with the mirror, and leaves the device its own", async () => {
    await load();
    expect(cachesLeft()).toEqual(CACHES);
    expect(tabLeft()).toEqual(TAB);
    store.forgetLayoutMirror();
    expect(cachesLeft()).toEqual([]);
    expect(tabLeft()).toEqual([]);
    expect(tab.getItem('ma.layout.owner.v1')).toBeNull();
    for (const key of DEVICE) expect(local.getItem(key)).not.toBeNull();
    expect(tab.getItem('ma.phoneCarousel.v1')).not.toBeNull();
  });

  it("from another tab's sign-out, the same, in this tab's own sessionStorage too", async () => {
    await load();
    signedIn(false);
    store.forgetLayoutMirror(false);
    expect(cachesLeft()).toEqual([]);
    expect(tabLeft()).toEqual([]);
  });
});

/** Every writer of a cache, as the member's own use calls it. */
async function writeAll(): Promise<void> {
  (await import('../bandwidth/seen')).markHeadsUpSeen('warn:2026-11-16T00:00:00Z');
  (await import('../browser/touchInput')).touchHintShown('u-a');
  (await import('../desk/rtc/connectRtt')).markCapped('u-a', 60, Date.now());
  (await import('../chrome/aboutOpen')).keepAboutOpen(true);
  const maia = await import('../maia/chat');
  maia.writeSession(maia.CONVERSATION_KEY, 'c-2');
  maia.writeSession(maia.OPEN_KEY, '1');
  const { useDeskStore } = await import('./deskStore');
  const { watchBoots } = await import('../platform/bootNotice');
  const stop = watchBoots();
  const home = { id: 'd-home', name: 'Home desk', kind: 'personal', vm: 'running', phase: null, queuePosition: null, stopAt: null, givebackUntil: null, badges: {} };
  useDeskStore.setState({ desks: [{ ...home, boot: { firstSeenAt: '2026-11-12T01:00:00Z', previousAt: '2026-11-11T20:00:00Z', refusedAt: null } }] as never });
  stop();
  // The desk list's mirror, beside the token (`ma.desks.v1`, ISS-89's guard on a key `forgetMember` already took).
  (await import('./deskStore')).setDeskList([{ deskId: 'd-b', name: 'Bakery', kind: 'personal', state: 'running' }] as never);
}
const WRITTEN = ['ma.boots.seen.v1', 'ma.bandwidth.notice.v1', 'ma.browser.touchHint.v1', 'ma.rttCapped.v1', 'ma.menu.about.v1'];

describe('a write', () => {
  it('signed in: each cache is written', async () => {
    await load();
    store.forgetLayoutMirror(false); // a clean browser, the token still kept
    await writeAll();
    expect(cachesLeft()).toEqual(CACHES.filter((k) => WRITTEN.includes(k)));
    expect(tabLeft()).toEqual(TAB);
    expect(local.getItem('ma.desks.v1')).toContain('Bakery');
  });

  it("from a stale tab, after another tab's sign-out left no token here: none is written, the desk list's names included", async () => {
    await load();
    signedIn(false);
    store.forgetLayoutMirror(false); // what this tab does on hearing it
    await writeAll();
    expect(cachesLeft()).toEqual([]);
    expect(tabLeft()).toEqual([]);
    expect(local.getItem('ma.desks.v1')).toBeNull();
  });

  it('after this page signed out, with the token not gone yet: none is written', async () => {
    await load();
    store.forgetLayoutMirror();
    await writeAll();
    expect(cachesLeft()).toEqual([]);
    expect(tabLeft()).toEqual([]);
  });

  it('taking a Maia key out is always allowed, signed out or not', async () => {
    await load();
    signedIn(false);
    const maia = await import('../maia/chat');
    maia.writeSession(maia.OPEN_KEY, null);
    expect(tab.getItem('ma.maia.open.v1')).toBeNull();
  });
});

describe('per account', () => {
  it("the same account's are kept, in storage and in this tab", async () => {
    await load('u-a');
    expect(store.layoutMirrorFor('u-a')).toBe(true);
    expect(cachesLeft()).toEqual(CACHES);
    expect(tabLeft()).toEqual(TAB);
    expect(tab.getItem('ma.layout.owner.v1')).toBe('u-a');
  });

  it("a sign-in as B over A's: every cache and this tab's Maia keys go, and the tab is named for B", async () => {
    await load('u-a');
    expect(store.layoutMirrorFor('u-b')).toBe(false);
    expect(cachesLeft()).toEqual([]);
    expect(tabLeft()).toEqual([]);
    expect(tab.getItem('ma.layout.owner.v1')).toBe('u-b');
    expect(local.getItem('ma.layout.owner.v1')).toBe('u-b');
  });

  it("a tab of A's whose tokens become B's, after B's own tab took A's from storage: this tab's Maia keys go", async () => {
    await load('u-a');
    store.layoutMirrorFor('u-a');
    // B signed in in another tab: storage is B's already, and this tab's sessionStorage still holds A's conversation.
    local.setItem('ma.layout.owner.v1', 'u-b');
    store.layoutMirrorFor('u-b');
    expect(tabLeft()).toEqual([]);
    expect(tab.getItem('ma.layout.owner.v1')).toBe('u-b');
  });

  it("a reload of A's tab after B signed in elsewhere: storage says B, this tab's own keys say A, and they go", async () => {
    await load('u-b', 'u-a');
    expect(store.layoutMirrorFor('u-b')).toBe(true);
    expect(tabLeft()).toEqual([]);
    expect(tab.getItem('ma.layout.owner.v1')).toBe('u-b');
    expect(cachesLeft()).toEqual(CACHES); // B's own, by the owner key
  });

  it('tab keys nobody named, from a build before this one, are the first account’s, and are named for it', async () => {
    await load('u-a', null);
    store.layoutMirrorFor('u-a');
    expect(tabLeft()).toEqual(TAB);
    expect(tab.getItem('ma.layout.owner.v1')).toBe('u-a');
  });

  it("a page that has signed out names nobody's tab", async () => {
    await load('u-a', null);
    store.forgetLayoutMirror();
    store.layoutMirrorFor('u-a');
    expect(tab.getItem('ma.layout.owner.v1')).toBeNull();
  });
});

describe("a stale tab after another tab's sign-out and a sign-in there as someone else", () => {
  /** Tab X is A's; another tab signs A out (X wipes), then B signs in there: B's token is kept, and the mirror is B's. */
  async function bSignsInElsewhere(): Promise<void> {
    await load('u-a');
    store.layoutMirrorFor('u-a');
    signedIn(false);
    store.forgetLayoutMirror(false);
    local.setItem('ma.layout.owner.v1', 'u-b');
    signedIn(true);
  }

  it("X, still drawing A on the access token it holds, writes none of A's beside B's token: no cache, no Maia key, no layout, no desk names, no last-known", async () => {
    await bSignsInElsewhere();
    expect(store.layoutMirrorWritable()).toBe(false);
    await writeAll();
    store.moveDesk('d-personal', 40, 36);
    vi.advanceTimersByTime(1000);
    const known = await import('../platform/lastKnown');
    known.lastKnownFor('u-a');
    known.rememberLastKnown('me', { userId: 'u-a', displayName: 'A', initials: 'A', badge: null });
    expect(cachesLeft()).toEqual([]);
    expect(tabLeft()).toEqual([]);
    expect(local.getItem('ma.layout.v2')).toBeNull();
    expect(local.getItem('ma.desks.v1')).toBeNull();
    expect(local.getItem('ma-desk-web-last-known')).toBeNull();
    expect(local.getItem('ma.layout.owner.v1')).toBe('u-b');
  });

  it('A signing in again there: X writes again, as before', async () => {
    await bSignsInElsewhere();
    local.setItem('ma.layout.owner.v1', 'u-a');
    expect(store.layoutMirrorWritable()).toBe(true);
    await writeAll();
    expect(cachesLeft()).toEqual(CACHES.filter((k) => WRITTEN.includes(k)));
  });

  it("a sign-in names the mirror its account's as its first token comes, before its refresh token is stored", async () => {
    await load(null, null);
    signedIn(false);
    store.layoutMirrorFor('u-b');
    expect(local.getItem('ma.layout.owner.v1')).toBe('u-b');
  });
});

describe('in memory', () => {
  it("the desk list: dropped at once, names and all, and loading until the new member's own answers", async () => {
    await load();
    const desks = await import('./deskStore');
    desks.setDeskList([{ deskId: 'd-a', name: 'Atelier', kind: 'personal', state: 'running' }] as never);
    expect(desks.useDeskStore.getState()).toMatchObject({ status: 'ready', desks: [{ name: 'Atelier' }] });
    desks.dropDeskList();
    expect(desks.useDeskStore.getState()).toMatchObject({ status: 'loading', desks: [], unpaid: null });
  });

  it("the boots told are this tab's member's: another member's tokens take them from the tab, the first ones don't", async () => {
    await load();
    const { useDeskStore } = await import('./deskStore');
    const boots = await import('../platform/bootNotice');
    const stop = boots.watchBoots();
    const home = { id: 'd-home', name: 'Home desk', kind: 'personal', vm: 'running', phase: null, queuePosition: null, stopAt: null, givebackUntil: null, badges: {} };
    useDeskStore.setState({ desks: [{ ...home, boot: { firstSeenAt: new Date(Date.now() - 3_600_000).toISOString(), previousAt: '2026-11-01T20:00:00Z', refusedAt: null } }] as never });
    expect(boots.useBootNotices.getState().notices.map((n) => n.name)).toEqual(['Home desk']);
    for (const fn of h.memberChange) fn('u-a', null);
    expect(boots.useBootNotices.getState().notices).toHaveLength(1);
    for (const fn of h.memberChange) fn('u-b', 'u-a');
    expect(boots.useBootNotices.getState().notices).toEqual([]);
    stop();
  });
});
