// The saved layout's mirror in this browser (ISS-67): every key it has, wiped in one go; nothing written once this page
// has signed out, or while no refresh token is kept here (another tab's sign-out takes it); and kept per account, so a
// sign-in as anyone else never reads, draws or writes back the last account's copy. The layout store and the token
// store are the real ones, on a stand-in for the browser's storage; `platform/session.signedOut.test.ts` drives each
// signed-out state through the session.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../platform/session', async () => {
  const { create: make } = await import('zustand');
  return { useSession: make(() => ({ me: { userId: 'u-a' } })) };
});
vi.mock('../shell/layoutSync', () => ({ layoutDocRead: () => true, setLayoutPref: () => {} }));

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
/** Written out, so a key dropped from the list fails here rather than staying behind for the next person. */
const EVERY_KEY = ['ma.layout.v2', 'ma.layout.v1', 'ma.layout.sync.v1', 'ma.free.prefs.v1', 'ma.setup.prefs.v1', 'ma.prefs.background', 'ma.layout.owner.v1'];

const app = (id: string, kind: string) => ({ id: `${id}:${kind}`, app: kind, x: 24, y: 24, w: 76, h: 76 });
const desk = (id: string, x: number) => ({ id, x, y: 36, w: 584, h: 236, items: [app(id, 'chat'), app(id, 'browser')] });
/** One of every kind: a Personal desk, a Work desk and a guild's panel, all in the one document. */
const DESKS = { 'd-personal': desk('d-personal', 0), 'd-work': desk('d-work', 700), 'guild-g1': desk('guild-g1', 1400) };

let local: Storage;
let store: Store;

function seed(owner: string | null): void {
  local.setItem('ma.layout.v2', JSON.stringify({ desks: DESKS, z: Object.keys(DESKS) }));
  local.setItem('ma.layout.v1', JSON.stringify({ desks: { 'd-personal': { x: 0, y: 0, cols: 6, rows: 1, items: [{ id: 'd-personal:chat', app: 'chat' }] } } }));
  local.setItem('ma.layout.sync.v1', JSON.stringify({ version: 3, etag: '"3"', dirty: ['d-work'], member: owner }));
  local.setItem('ma.free.prefs.v1', JSON.stringify({ who: 'u-a', prefs: { freeSaidOn: '2026-11-10' } }));
  local.setItem('ma.setup.prefs.v1', JSON.stringify({ who: 'u-a', prefs: { circleHidden: true } }));
  local.setItem('ma.prefs.background', JSON.stringify({ id: 'misty-forest', theme: 'light' }));
  if (owner) local.setItem('ma.layout.owner.v1', owner);
  // This device's own: the view and the theme aren't the account's layout (ADR 0005), and stay.
  local.setItem('ma.view.v1', JSON.stringify({ scope: 'work', activeDesk: 'd-work', mode: 'desk' }));
  local.setItem('ma.prefs.theme', 'dark');
}

const left = (): string[] => EVERY_KEY.filter((k) => local.getItem(k) !== null);
const signedIn = (on: boolean): void => (on ? local.setItem(REFRESH_KEY, 'refresh-1') : local.removeItem(REFRESH_KEY));
/** A change the member made, and the mirror's debounce run out. */
function change(): void {
  store.moveDesk('d-personal', 40, 36);
  vi.advanceTimersByTime(1000);
}
const mirrored = (): { desks: Record<string, unknown> } | null => JSON.parse(local.getItem('ma.layout.v2') ?? 'null') as { desks: Record<string, unknown> } | null;

async function load(owner: string | null = 'u-a'): Promise<void> {
  seed(owner);
  vi.resetModules();
  store = await import('./layoutStore');
  // As `platform/session.ts` does as it loads.
  store.mirrorFollowsToken((await import('../platform/tokenStore')).hasStoredToken);
}

beforeEach(() => {
  vi.useFakeTimers();
  local = memoryStorage();
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('window', {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    localStorage: local,
  });
  signedIn(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('its keys', () => {
  it("are every one the layout's mirror is kept under, each module's own constant", async () => {
    await load();
    const { LAYOUT_KEY, LAYOUT_KEY_V1 } = await import('../canvas/layoutDoc');
    const { MIRROR_KEY: background } = await import('../theme/backdropMirror');
    const { MIRROR: free } = await import('../free/prefs');
    const { MIRROR: setup } = await import('../setup/prefs');
    expect([...store.LAYOUT_MIRROR_KEYS].sort()).toEqual([...EVERY_KEY].sort());
    for (const key of [LAYOUT_KEY, LAYOUT_KEY_V1, store.LAYOUT_SYNC_KEY, free, setup, background, store.LAYOUT_OWNER_KEY]) expect(store.LAYOUT_MIRROR_KEYS).toContain(key);
  });
});

describe('a wipe', () => {
  it('takes every key, for every desk, Personal, Work and Guild alike, and leaves the device its own view and theme', async () => {
    await load();
    expect(Object.keys(store.useLayoutStore.getState().desks).sort()).toEqual(['d-personal', 'd-work', 'guild-g1']);
    expect(left()).toEqual(EVERY_KEY);
    store.forgetLayoutMirror();
    expect(left()).toEqual([]);
    expect(local.getItem('ma.view.v1')).not.toBeNull();
    expect(local.getItem('ma.prefs.theme')).toBe('dark');
  });

  it('on this page: nothing writes it again, not the debounce on its way, a change, or a flush as the page goes', async () => {
    await load();
    store.moveDesk('d-personal', 40, 36); // its debounce is running
    store.forgetLayoutMirror();
    vi.advanceTimersByTime(1000);
    expect(left()).toEqual([]);
    change();
    store.moveDesk('d-work', 760, 36);
    store.flushLayoutMirror();
    expect(left()).toEqual([]);
    expect(store.layoutMirrorHeld()).toBe(true);
    expect(store.layoutMirrorWritable()).toBe(false);
  });

  it("from another tab's sign-out: no token is left here, so nothing is written, and it's written again once one is", async () => {
    await load();
    signedIn(false);
    store.forgetLayoutMirror(false);
    change();
    store.flushLayoutMirror();
    expect(left()).toEqual([]);
    expect(store.layoutMirrorHeld()).toBe(false);
    signedIn(true);
    change();
    expect(mirrored()?.desks['d-personal']).toMatchObject({ x: 40 });
  });
});

describe('the mirror is written only while a refresh token is kept here', () => {
  it('none, and a change stays in memory', async () => {
    await load();
    local.removeItem('ma.layout.v2');
    signedIn(false);
    change();
    expect(local.getItem('ma.layout.v2')).toBeNull();
    expect(store.useLayoutStore.getState().desks['d-personal']).toMatchObject({ x: 40 });
  });

  it('one, and the change is mirrored, named for the account it belongs to', async () => {
    await load();
    store.layoutMirrorFor('u-a');
    change();
    expect(mirrored()?.desks['d-personal']).toMatchObject({ x: 40 });
    expect(local.getItem('ma.layout.owner.v1')).toBe('u-a');
  });
});

describe('per account', () => {
  it("the same account's mirror is kept, in storage and in memory", async () => {
    await load('u-a');
    expect(store.layoutMirrorFor('u-a')).toBe(true);
    expect(left()).toEqual(EVERY_KEY);
    expect(Object.keys(store.useLayoutStore.getState().desks)).toHaveLength(3);
  });

  it("a mirror nobody named, from a build before this one, is the first account's, and is named for it", async () => {
    await load(null);
    expect(store.layoutMirrorFor('u-a')).toBe(true);
    expect(local.getItem('ma.layout.owner.v1')).toBe('u-a');
    expect(Object.keys(store.useLayoutStore.getState().desks)).toHaveLength(3);
  });

  it("another account's mirror goes from storage and from memory, before anything of it can draw, save or be written back", async () => {
    await load('u-a');
    store.moveDesk('d-personal', 40, 36); // a write of the last account's layout on its way
    expect(store.layoutMirrorFor('u-b')).toBe(false);
    expect(store.useLayoutStore.getState()).toMatchObject({ desks: {}, z: [] });
    vi.advanceTimersByTime(1000);
    expect(local.getItem('ma.layout.v2')).toBeNull();
    expect(left()).toEqual(['ma.layout.owner.v1']);
    expect(local.getItem('ma.layout.owner.v1')).toBe('u-b');
    // B's own desks, from B's list, are B's mirror.
    store.reconcileLayout(['d-b']);
    store.moveDesk('d-b', 40, 36);
    vi.advanceTimersByTime(1000);
    expect(Object.keys(mirrored()?.desks ?? {})).toEqual(['d-b']);
  });

  it("a change of account while the list still shows desks: they keep a layout, at a new desk's places, so the office isn't left blank", async () => {
    // teens.shell.spec.ts, "a teen's sign-in in another tab…": the tab drew nothing until the list answered again.
    await load('u-a');
    store.moveDesk('d-personal', 40, 36); // the last account's own arrangement
    expect(store.layoutMirrorFor('u-b', ['d-personal', 'd-work', 'guild-g1'])).toBe(false);
    const { desks } = store.useLayoutStore.getState();
    expect(Object.keys(desks).sort()).toEqual(['d-personal', 'd-work', 'guild-g1']);
    expect(desks['d-personal']).not.toMatchObject({ x: 40 });
    expect(desks['d-personal']!.items.length).toBeGreaterThan(0);
    // Nothing of it is written for the new account until something is theirs to write.
    vi.advanceTimersByTime(1000);
    expect(local.getItem('ma.layout.v2')).toBeNull();
  });

  it("a tab that drew one account's layout and now has another's tokens takes up what that account's other tab stored, never its own copy", async () => {
    await load('u-a');
    // B signed in in another tab, which wrote B's mirror.
    local.setItem('ma.layout.owner.v1', 'u-b');
    local.setItem('ma.layout.v2', JSON.stringify({ desks: { 'd-b': desk('d-b', 0) }, z: ['d-b'] }));
    expect(store.layoutMirrorFor('u-b')).toBe(false);
    expect(Object.keys(store.useLayoutStore.getState().desks)).toEqual(['d-b']);
    vi.advanceTimersByTime(1000);
    expect(Object.keys(mirrored()?.desks ?? {})).toEqual(['d-b']);
  });

  it("another tab's write is this tab's to take only when it's the same account's", async () => {
    await load('u-a');
    store.layoutMirrorFor('u-a');
    expect(store.mirrorIsOurs()).toBe(true);
    local.setItem('ma.layout.owner.v1', 'u-b');
    expect(store.mirrorIsOurs()).toBe(false);
    local.removeItem('ma.layout.owner.v1');
    expect(store.mirrorIsOurs()).toBe(true);
    store.forgetLayoutMirror();
    expect(store.mirrorIsOurs()).toBe(false);
  });
});

describe("a stale tab's prefs mirrors (Security's ISS67-L1)", () => {
  async function prefs(): Promise<{ free: typeof import('../free/prefs'); setup: typeof import('../setup/prefs') }> {
    return { free: await import('../free/prefs'), setup: await import('../setup/prefs') };
  }
  const write = ({ free, setup }: Awaited<ReturnType<typeof prefs>>): void => {
    free.writePref(free.MAIA_NOT_NOW, '2026-11-12');
    setup.setCircleHidden(true);
    setup.offerNotNow(Date.parse('2026-12-12T00:00:00Z'));
  };
  const both = (): [string | null, string | null] => [local.getItem('ma.free.prefs.v1'), local.getItem('ma.setup.prefs.v1')];

  it('signed in, the free tier and the setup circle mirror what they write', async () => {
    await load();
    store.forgetLayoutMirror(false); // a clean mirror, the token still kept
    write(await prefs());
    const [free, setup] = both();
    expect(free).toContain('2026-11-12');
    expect(setup).toContain('circleHidden');
    expect(setup).toContain('offerNotNowUntil');
  });

  it("after another tab's sign-out, with no token left, a stale tab writes neither back", async () => {
    await load();
    signedIn(false);
    store.forgetLayoutMirror(false); // what this tab does on hearing it
    write(await prefs());
    expect(both()).toEqual([null, null]);
  });

  it('after this page signed out, with the token not gone yet, neither is written', async () => {
    await load();
    store.forgetLayoutMirror();
    write(await prefs());
    expect(both()).toEqual([null, null]);
  });
});
