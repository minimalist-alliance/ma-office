// Every way the office ends up signed out wipes the saved layout's mirror (ISS-67) and the member's other caches beside
// it, this tab's sessionStorage keys included (ISS-89), and a sign-in as anyone else never reads the last account's: Sign out, Sign out everywhere, `/signed-out`, a start with nobody signed in, a failed
// `/auth/callback`, a dead session (a refused refresh, the member's own "Stay signed in" running out) that goes to sign
// in or ends on the card, a 401 that a refresh can't mend, a refused account (a closed one included), another tab's
// sign-out, and a change of account. A refresh that fails for now is no sign-out, and keeps it. The session and the
// layout store are the real code; Platform, auth and the rest of the office are faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** A refresh token is kept in this browser (`tokenStore.hasStoredToken`). */
  token: true,
  /** `auth.hasStoredSession` at boot. */
  session: true,
  /** `auth.sessionWasRefused`: this tab's own refresh was refused. */
  refusedHere: false,
  managedLogin: false,
  memberChange: null as null | ((sub: string, before: string | null) => void),
  tokenGone: null as null | ((wasThis?: boolean) => void),
  getDesks: null as null | (() => Promise<unknown>),
  /** What the session put in the desk store (`setDeskList`, each list's ids) and how often it dropped it (`dropDeskList`). */
  listed: [] as string[][],
  listDropped: 0,
  finishSignIn: null as null | (() => Promise<void>),
  postSignOut: null as null | (() => Promise<void>),
  startSignIn: 0,
  endSession: 0,
}));
const { SignInRequired, CONFIG, LISTED } = vi.hoisted(() => ({
  SignInRequired: class SignInRequired extends Error {},
  CONFIG: { auth: { signInPath: null, domain: 'https://auth.example', clientId: 'c' }, api: 'https://api.example' },
  /** A's list: a Personal desk, a Work desk and a guild's panel. */
  LISTED: { data: { desks: ['d-personal', 'd-work', 'guild-g1'].map((deskId) => ({ deskId, name: deskId, kind: 'personal', state: 'running' })), pollAfterSeconds: 60 }, etag: '"1"' },
}));
vi.mock('./auth', () => ({
  SignInRequired,
  EVERYWHERE_WAIT_MS: 15_000,
  answeredWithin: (p: Promise<unknown>) => p.then(() => true, () => false),
  endSession: async () => {
    h.endSession += 1;
  },
  finishSignIn: () => h.finishSignIn?.() ?? Promise.resolve(),
  forAtMost: async (p: Promise<unknown>) => {
    await p.catch(() => undefined);
  },
  hasStoredSession: async () => h.session,
  onMemberChange: (fn: (sub: string, before: string | null) => void) => {
    h.memberChange = fn;
    return () => {};
  },
  ownSignInPath: () => null,
  retryRefreshNow: () => {},
  sessionWasRefused: () => h.refusedHere,
  startSignIn: async () => {
    h.startSignIn += 1;
  },
  takeEndedChoice: () => null,
  usesManagedLogin: () => h.managedLogin,
}));
vi.mock('./api', () => ({
  ApiError: class ApiError extends Error {
    constructor(readonly status: number) {
      super(`HTTP ${status}`);
    }
  },
  getDesks: () => h.getDesks?.() ?? Promise.resolve(LISTED),
  getMe: async () => ({ data: null }),
  postSignOut: () => h.postSignOut?.() ?? Promise.resolve(),
}));
vi.mock('./tokenStore', () => ({
  hasStoredToken: () => h.token,
  onTokenGoneElsewhere: (fn: (wasThis?: boolean) => void) => {
    h.tokenGone = fn;
    return () => {};
  },
  placeTokenFor: () => {},
}));
vi.mock('./clientConfig', () => ({ accountUrl: () => null, getClientConfig: async () => CONFIG, loadedConfig: () => CONFIG }));
vi.mock('./lastKnown', () => ({
  checkedConfig: () => null,
  checkedLastMe: () => null,
  forgetLastKnown: () => {},
  lastKnownFor: () => true,
  lastMeOf: () => null,
  readLastKnown: () => null,
  rememberLastKnown: () => {},
}));
vi.mock('./signInAddress', () => ({ signInAddress: () => null }));
vi.mock('./exportSweep', () => ({ dropExportSoon: async () => {}, keepExportFor: async () => {} }));
vi.mock('../open/intent', () => ({ linkFromAddress: () => null, linksOn: () => false }));
vi.mock('../browser/lastScreen', () => ({ clearLastScreens: async () => {}, keepLastScreens: () => {} }));
vi.mock('../bandwidth/store', () => ({ dropLastMeter: () => {}, showLastMeter: () => {} }));
vi.mock('../chrome/avatar', () => ({ initialsOf: () => 'A' }));
vi.mock('../desk/liveStore', () => ({ closeAllLinks: () => {}, dropAdultOnlySummaries: () => {}, syncLinks: async () => {} }));
vi.mock('../desk/fixtures', () => ({ makeFixture: () => null }));
vi.mock('../state/windowStore', () => ({ closeAdultOnlyWindows: () => {} }));
vi.mock('../state/deskStore', async () => {
  const { create } = await import('zustand');
  return {
    clearDeskMirror: () => {},
    dropDeskList: () => {
      h.listDropped += 1;
    },
    dropMirroredDesks: () => {},
    guildDeskIds: () => [],
    renameDeskInStore: () => {},
    setDeskList: (desks: { deskId: string }[]) => {
      h.listed.push(desks.map((d) => d.deskId));
    },
    setDeskListDirect: () => {},
    setDeskListError: () => {},
    setUnpaid: () => {},
    useDeskStore: create(() => ({ status: 'loading', desks: [], unpaid: null })),
  };
});

type Session = typeof import('./session');
type Layout = typeof import('../state/layoutStore');

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

const LAYOUT_KEYS = ['ma.layout.v2', 'ma.layout.v1', 'ma.layout.sync.v1', 'ma.free.prefs.v1', 'ma.setup.prefs.v1', 'ma.prefs.background', 'ma.layout.owner.v1'];
/** The member's other caches (ISS-89, `MEMBER_CACHE_KEYS`), and this tab's own (`MEMBER_TAB_KEYS`), read as `tab:<key>`. */
const CACHE_KEYS = ['ma.streamQuality.v1', 'ma.streamQuality.desks.v1', 'ma.boots.seen.v1', 'ma.bandwidth.notice.v1', 'ma.guild.privacy.v1', 'ma.browser.touchHint.v1', 'ma.rttCapped.v1', 'ma.menu.about.v1'];
const TAB_KEYS = ['ma.maia.conversation.v1', 'ma.maia.open.v1', 'ma.layout.owner.v1'];
const EVERY_KEY = [...LAYOUT_KEYS, ...CACHE_KEYS, ...TAB_KEYS.map((k) => `tab:${k}`)];
const app = (id: string, kind: string) => ({ id: `${id}:${kind}`, app: kind, x: 24, y: 24, w: 76, h: 76 });
const desk = (id: string, x: number) => ({ id, x, y: 36, w: 584, h: 236, items: [app(id, 'chat'), app(id, 'browser')] });
const DESKS = { 'd-personal': desk('d-personal', 0), 'd-work': desk('d-work', 700), 'guild-g1': desk('guild-g1', 1400) };
const SCOPES = ['personal', 'work', 'guild', 'all'] as const;

let local: Storage;
let tab: Storage;
let session: Session;
let layout: Layout;
const location = { pathname: '/', search: '', replace: (url: string) => void url, assign: (url: string) => void url };

/** What member A's visits left in this browser, the view on `scope`. */
function seed(owner = 'u-a', scope: (typeof SCOPES)[number] = 'all'): void {
  local.setItem('ma.layout.v2', JSON.stringify({ desks: DESKS, z: Object.keys(DESKS) }));
  local.setItem('ma.layout.v1', JSON.stringify({ desks: { 'd-personal': { x: 0, y: 0, cols: 6, rows: 1, items: [] } } }));
  local.setItem('ma.layout.sync.v1', JSON.stringify({ version: 3, etag: '"3"', dirty: ['d-work'], member: owner }));
  local.setItem('ma.free.prefs.v1', JSON.stringify({ who: owner, prefs: { freeSaidOn: '2026-11-10' } }));
  local.setItem('ma.setup.prefs.v1', JSON.stringify({ who: owner, prefs: { circleHidden: true } }));
  local.setItem('ma.prefs.background', JSON.stringify({ id: 'misty-forest', theme: 'light' }));
  local.setItem('ma.layout.owner.v1', owner);
  local.setItem('ma.view.v1', JSON.stringify({ scope, activeDesk: 'd-work', mode: 'overview' }));
  local.setItem('ma.streamQuality.v1', JSON.stringify({ sub: owner, doc: { default: 'low', apps: {}, desks: { 'd-work': { level: 'max' } }, updatedAt: null } }));
  local.setItem('ma.streamQuality.desks.v1', JSON.stringify({ sub: owner, desks: { 'd-personal': { browser: 'low' } } }));
  local.setItem('ma.boots.seen.v1', JSON.stringify({ 'd-personal': '2026-11-11T20:00:00Z' }));
  local.setItem('ma.bandwidth.notice.v1', 'paused:2026-11-16T07:00:00Z');
  local.setItem('ma.guild.privacy.v1', '1');
  local.setItem('ma.browser.touchHint.v1', JSON.stringify([owner]));
  local.setItem('ma.rttCapped.v1', JSON.stringify({ sub: owner, until: Date.parse('2026-11-12T00:00:00Z') }));
  local.setItem('ma.menu.about.v1', 'true');
  tab.setItem('ma.maia.conversation.v1', `c-${owner}`);
  tab.setItem('ma.maia.open.v1', '1');
  tab.setItem('ma.layout.owner.v1', owner);
}

const left = (): string[] => EVERY_KEY.filter((k) => (k.startsWith('tab:') ? tab.getItem(k.slice(4)) : local.getItem(k)) !== null);
const status = (): string => session.useSession.getState().status;
/** Lets every promise and timer due now run, as many rounds as the session's chains take. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(0);
}
/** A change the member made, then past the mirror's debounce. */
async function change(): Promise<void> {
  layout.moveDesk('d-personal', 40, 36);
  await vi.advanceTimersByTimeAsync(1000);
}

async function boot(path = '/'): Promise<void> {
  location.pathname = path;
  await session.bootSession();
  await settle();
}

/** Signed in as A, in the office, the first token said. */
async function signedIn(): Promise<void> {
  await boot('/');
  h.memberChange?.('u-a', null);
  expect(status()).toBe('signedIn');
  expect(left()).toEqual(EVERY_KEY);
}

beforeEach(async () => {
  vi.useFakeTimers();
  Object.assign(h, { token: true, session: true, refusedHere: false, managedLogin: false, getDesks: null, finishSignIn: null, postSignOut: null, startSignIn: 0, endSession: 0, listed: [], listDropped: 0 });
  local = memoryStorage();
  tab = memoryStorage();
  const listeners: Record<string, (() => void)[]> = {};
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', tab);
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: () => void) => (listeners[type] ??= []).push(fn),
    removeEventListener: () => {},
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    location,
    history: { replaceState: () => {} },
    localStorage: local,
  });
  vi.stubGlobal('document', { hidden: false, addEventListener: () => {}, head: { append: () => {} }, createElement: () => ({}) });
  seed();
  vi.resetModules();
  layout = await import('../state/layoutStore');
  session = await import('./session');
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('each signed-out state wipes the mirror', () => {
  it.each(SCOPES)('a start with nobody signed in, whichever scope the view was on (%s)', async (scope) => {
    seed('u-a', scope);
    h.session = false;
    h.token = false;
    await boot('/');
    expect(status()).toBe('signedOut');
    expect(left()).toEqual([]);
    expect(local.getItem('ma.view.v1')).toContain(scope); // the device's own view state isn't the account's layout
  });

  it('a start with nobody signed in that goes straight to sign-in wipes it first', async () => {
    h.session = false;
    h.token = false;
    h.managedLogin = true;
    await boot('/');
    expect(h.startSignIn).toBe(1);
    expect(left()).toEqual([]);
  });

  it('/signed-out, where every sign-out lands', async () => {
    await boot('/signed-out');
    expect(session.useSession.getState()).toMatchObject({ status: 'signedOut', notice: "You're signed out." });
    expect(left()).toEqual([]);
  });

  it("a failed /auth/callback, which ends on the card", async () => {
    h.finishSignIn = () => Promise.reject(new SignInRequired("That sign-in couldn't be verified. Please try again."));
    await boot('/auth/callback');
    expect(status()).toBe('signedOut');
    expect(left()).toEqual([]);
  });

  it('Sign out: after its last words, which see the layout still there, and nothing writes it again as the page goes', async () => {
    await signedIn();
    let atLastWords: string[] = [];
    session.onBeforeSignOut(async () => {
      atLastWords = left();
    });
    await session.signOut();
    expect(atLastWords).toEqual(EVERY_KEY);
    expect(h.endSession).toBe(1);
    expect(left()).toEqual([]);
    // The token is still here until the logout, and the page hasn't gone yet: a change, its debounce and the flush on the way out write nothing.
    expect(h.token).toBe(true);
    await change();
    layout.flushLayoutMirror();
    expect(left()).toEqual([]);
  });

  it('Sign out everywhere, once Platform says yes', async () => {
    await signedIn();
    await session.signOut({ everywhere: true });
    expect(h.endSession).toBe(1);
    expect(left()).toEqual([]);
  });

  it("Sign out everywhere that Platform doesn't confirm ends nothing, and keeps it", async () => {
    await signedIn();
    h.postSignOut = () => Promise.reject(new Error('offline'));
    await expect(session.signOut({ everywhere: true })).rejects.toBeInstanceOf(session.SignOutEverywhereFailed);
    expect(status()).toBe('signedIn');
    expect(left()).toEqual(EVERY_KEY);
    await change();
    expect(local.getItem('ma.layout.v2')).toContain('"x":40');
  });

  it('a dead session (a refused refresh, or "Stay signed in" run out) that goes off to sign in wipes it before it leaves', async () => {
    await signedIn();
    h.refusedHere = true;
    h.managedLogin = true;
    h.token = false; // the refused token is cleared before the list hears
    h.getDesks = () => Promise.reject(new SignInRequired());
    session.retryDesks();
    await settle();
    expect(h.startSignIn).toBe(1);
    expect(left()).toEqual([]);
  });

  it('a dead session that ends on the card', async () => {
    await signedIn();
    h.refusedHere = true;
    h.token = false;
    h.getDesks = () => Promise.reject(new SignInRequired());
    session.retryDesks();
    await settle();
    expect(session.useSession.getState()).toMatchObject({ status: 'signedOut', notice: 'Please sign in again.' });
    expect(left()).toEqual([]);
  });

  it("a 401 that a refresh can't mend, with a good token still kept", async () => {
    await signedIn();
    h.getDesks = () => Promise.reject(new SignInRequired());
    session.retryDesks();
    await settle();
    expect(status()).toBe('signedOut');
    expect(left()).toEqual([]);
    await change();
    expect(left()).toEqual([]);
  });

  it('a refused account, a closed one included (403)', async () => {
    await signedIn();
    const { ApiError } = await import('./api');
    h.getDesks = () => Promise.reject(new (ApiError as unknown as new (s: number) => Error)(403));
    session.retryDesks();
    await settle();
    expect(status()).toBe('refused');
    expect(left()).toEqual([]);
    await change();
    expect(left()).toEqual([]);
  });

  it("another tab's sign-out, with no token left here: it goes now, and this tab can't write it back", async () => {
    await signedIn();
    h.token = false;
    h.tokenGone?.();
    expect(left()).toEqual([]);
    await change();
    layout.flushLayoutMirror();
    expect(left()).toEqual([]);
  });

  it("another tab's sign-out that reaches this tab before its localStorage does: the token gone was this tab's, so it all goes, this tab's own keys too (ISS-89)", async () => {
    await signedIn();
    h.tokenGone?.(true); // `hasStoredToken` still says yes here
    expect(left()).toEqual([]);
  });
});

describe('what is not a sign-out keeps it', () => {
  it('a refresh that fails for now: the token is kept, and so is the mirror', async () => {
    await signedIn();
    h.getDesks = () => Promise.reject(new Error('RefreshUnavailable: token refresh -> 503'));
    session.retryDesks();
    await settle();
    expect(status()).toBe('signedIn');
    expect(left()).toEqual(EVERY_KEY);
    await change();
    expect(local.getItem('ma.layout.v2')).toContain('"x":40');
  });

  it("another tab's token going while this tab still has one of its own (its own sign-in, in its sessionStorage)", async () => {
    await signedIn();
    h.tokenGone?.();
    expect(left()).toEqual(EVERY_KEY);
  });
});

describe('a different account never reads the last one', () => {
  it("a sign-in over A's kept mirror, as B, at /auth/callback: A's goes before the office opens", async () => {
    h.session = false;
    let atSignIn: string[] = [];
    h.finishSignIn = async () => {
      h.memberChange?.('u-b', null);
      atSignIn = Object.keys(layout.useLayoutStore.getState().desks);
    };
    h.getDesks = async () => ({ data: { desks: [{ deskId: 'd-b', name: 'Bakery', kind: 'personal', state: 'running' }], pollAfterSeconds: 60 }, etag: '"9"' });
    await boot('/auth/callback');
    expect(status()).toBe('signedIn');
    expect(atSignIn).toEqual([]);
    expect(Object.keys(layout.useLayoutStore.getState().desks)).toEqual(['d-b']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(left()).toEqual(['ma.layout.v2', 'ma.layout.owner.v1', 'tab:ma.layout.owner.v1']);
    expect(Object.keys((JSON.parse(local.getItem('ma.layout.v2')!) as { desks: object }).desks)).toEqual(['d-b']);
    expect(local.getItem('ma.layout.owner.v1')).toBe('u-b');
    expect(tab.getItem('ma.layout.owner.v1')).toBe('u-b');
  });

  it("a tab whose tokens become B's (a sign-in in another tab): A's goes from storage and from this tab", async () => {
    await signedIn();
    layout.moveDesk('d-personal', 40, 36); // A's change, its mirror's write on its way
    // The change asks for B's own list at once (ISS-89), and B's desks are B's mirror.
    h.getDesks = async () => ({ data: { desks: [{ deskId: 'd-b', name: 'Bakery', kind: 'personal', state: 'running' }], pollAfterSeconds: 60 }, etag: '"9"' });
    h.memberChange?.('u-b', 'u-a');
    expect(layout.useLayoutStore.getState().desks).toEqual({});
    await vi.advanceTimersByTimeAsync(1000);
    expect(left()).toEqual(['ma.layout.v2', 'ma.layout.owner.v1', 'tab:ma.layout.owner.v1']);
    expect(Object.keys((JSON.parse(local.getItem('ma.layout.v2')!) as { desks: object }).desks)).toEqual(['d-b']);
    expect(local.getItem('ma.layout.owner.v1')).toBe('u-b');
    expect(tab.getItem('ma.layout.owner.v1')).toBe('u-b');
  });

  it("a tab whose tokens become B's: A's desk list goes from the tab at once, and a list asked for A lands nowhere (ISS-89)", async () => {
    await signedIn();
    expect(h.listed.at(-1)).toEqual(['d-personal', 'd-work', 'guild-g1']);
    // A poll on its way for A, which answers only after the change.
    let answerA: (v: unknown) => void = () => {};
    const B = { data: { desks: [{ deskId: 'd-b', name: 'Bakery', kind: 'personal', state: 'running' }], pollAfterSeconds: 60 }, etag: '"9"' };
    let calls = 0;
    h.getDesks = () => (calls++ === 0 ? new Promise((done) => (answerA = done)) : Promise.resolve(B));
    session.retryDesks();
    await settle();
    h.listed = [];
    const { announce, useAnnouncer } = await import('../shell/announce');
    announce('Home desk started at 5:00 AM.'); // the live region's last line, naming A's desk
    h.memberChange?.('u-b', 'u-a');
    expect(h.listDropped).toBe(1);
    expect(useAnnouncer.getState().text).toBe('');
    answerA(LISTED);
    await settle();
    expect(h.listed).toEqual([['d-b']]);
  });

  it("the first token, or a sign-in at /auth/callback, drops no list", async () => {
    await signedIn();
    expect(h.listDropped).toBe(0);
  });

  it("a tab whose tokens become B's while its list still shows desks: they keep a layout, at a new desk's places, never A's arrangement", async () => {
    await signedIn();
    layout.moveDesk('d-personal', 40, 36); // A's own arrangement
    const { useDeskStore } = await import('../state/deskStore');
    useDeskStore.setState({ status: 'ready', desks: ['d-personal', 'd-work', 'guild-g1'].map((id) => ({ id })) as never });
    h.memberChange?.('u-b', 'u-a');
    const { desks } = layout.useLayoutStore.getState();
    expect(Object.keys(desks).sort()).toEqual(['d-personal', 'd-work', 'guild-g1']);
    expect(desks['d-personal']).not.toMatchObject({ x: 40 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(left()).toEqual(['ma.layout.owner.v1', 'tab:ma.layout.owner.v1']); // nothing of A's in storage, and nothing written for B yet
  });

  it('the same account signing in again keeps its own', async () => {
    h.session = false;
    h.finishSignIn = async () => h.memberChange?.('u-a', null);
    await boot('/auth/callback');
    expect(left()).toEqual(EVERY_KEY);
    expect(Object.keys(layout.useLayoutStore.getState().desks)).toHaveLength(3);
  });
});
