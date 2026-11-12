// Where the refresh token is kept ("Stay signed in"): one place at a time, a rotation where the last one was, a move
// on the member's choice, and what other tabs do with what they're told. tests/e2e/staySignedIn.shell.spec.ts runs the
// same code across real tabs, a real browser restart and the old IndexedDB store.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Moved } from './tokenStore';

type Store = typeof import('./tokenStore');
const KEY = 'ma-desk-web-refresh';

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

let store: Store;
let local: Storage;
let session: Storage;
let told: Moved[];

beforeEach(async () => {
  local = memoryStorage();
  session = memoryStorage();
  told = [];
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('indexedDB', undefined); // no old store here
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      onmessage: unknown = null;
      constructor(name: string) {
        expect(name).toBe(KEY);
      }
      postMessage(msg: Moved) {
        told.push(msg);
      }
    },
  );
  vi.resetModules();
  store = await import('./tokenStore');
});

describe('staySignedInOf', () => {
  it('reads the four choices and nothing else', () => {
    for (const choice of ['30d', '7d', '1d', 'browser']) expect(store.staySignedInOf(choice)).toBe(choice);
    for (const odd of [undefined, null, '', '90d', 'Browser', 30, {}]) expect(store.staySignedInOf(odd)).toBeNull();
  });
});

describe('follow', () => {
  it('a copy of the token follows its rotation, its move and its end', () => {
    expect(store.follow('a', { from: 'a', to: 'b', where: 'session' })).toBe('b');
    expect(store.follow('a', { from: 'a', to: 'a', where: 'local' })).toBeNull();
    expect(store.follow('a', { from: 'a', to: null, where: null })).toBeNull();
  });

  it('a tab with none takes up a move into sessionStorage, the token it was reading from localStorage', () => {
    expect(store.follow(null, { from: 'a', to: 'a', where: 'session' })).toBe('a');
  });

  it("anything else leaves this tab's copy as it is", () => {
    expect(store.follow('x', { from: 'a', to: 'b', where: 'session' })).toBeUndefined();
    expect(store.follow(null, { from: 'a', to: 'b', where: 'session' })).toBeUndefined();
    expect(store.follow(null, { from: 'a', to: null, where: null })).toBeUndefined();
    expect(store.follow(null, { from: 'a', to: 'a', where: 'local' })).toBeUndefined();
  });
});

describe('the store', () => {
  it('a first token goes to localStorage, and a rotation stays where the last one was', async () => {
    await store.writeRefreshToken('a');
    expect([local.getItem(KEY), session.getItem(KEY)]).toEqual(['a', null]);
    local.removeItem(KEY);
    session.setItem(KEY, 'c');
    await store.writeRefreshToken('d');
    expect([local.getItem(KEY), session.getItem(KEY)]).toEqual([null, 'd']);
    expect(told).toEqual([{ from: 'c', to: 'd', where: 'session' }]);
  });

  it('a write the browser refuses throws, so a sign-in says so', async () => {
    local.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    await expect(store.writeRefreshToken('a')).rejects.toThrow();
  });

  it('"browser" moves it into this tab, anything else moves it back, and a GET /v1/me without preferences moves nothing', async () => {
    local.setItem(KEY, 'a');
    await store.placeRefreshToken('browser');
    expect([local.getItem(KEY), session.getItem(KEY)]).toEqual([null, 'a']);
    store.placeTokenFor({});
    store.placeTokenFor({ preferences: null });
    await Promise.resolve();
    expect([local.getItem(KEY), session.getItem(KEY)]).toEqual([null, 'a']);
    await store.placeRefreshToken('7d');
    expect([local.getItem(KEY), session.getItem(KEY)]).toEqual(['a', null]);
    expect(told).toEqual([
      { from: 'a', to: 'a', where: 'session' },
      { from: 'a', to: 'a', where: 'local' },
    ]);
  });

  it('clears only the token refused, and anything clears both', async () => {
    session.setItem(KEY, 'new');
    expect(await store.clearRefreshTokenIf('old')).toBe(false);
    expect(session.getItem(KEY)).toBe('new');
    expect(await store.clearRefreshTokenIf('new')).toBe(true);
    expect([local.getItem(KEY), session.getItem(KEY)]).toEqual([null, null]);
    local.setItem(KEY, 'l');
    await store.clearRefreshToken();
    expect(local.getItem(KEY)).toBeNull();
    expect(told).toEqual([
      { from: 'new', to: null, where: null },
      { from: 'l', to: null, where: null },
    ]);
  });
});

describe('the member\'s own session length (auth.md 3.3 item 2)', () => {
  const DAY = 86_400_000;
  const NOW = Date.parse('2026-12-01T12:00:00Z');
  const sec = (ms: number) => Math.floor(ms / 1000);
  function held(choice: string | null, signedInMsAgo: number | null, savedMsAgo: number | null = null, where: 'local' | 'session' = 'local'): void {
    (where === 'local' ? local : session).setItem(KEY, 'rt');
    if (signedInMsAgo !== null) store.writeSignedInAt(sec(NOW - signedInMsAgo));
    if (choice) store.rememberChoice({ staySignedIn: choice, staySignedInSince: savedMsAgo === null ? null : new Date(NOW - savedMsAgo).toISOString() });
  }

  it('ends 7 days, 1 day and 12 hours after the sign-in, and not before', () => {
    held('7d', 7 * DAY + 60_000);
    expect(store.outlivedChoice(NOW)).toBe('7d');
    held('7d', 6 * DAY);
    expect(store.outlivedChoice(NOW)).toBeNull();
    held('1d', DAY + 60_000);
    expect(store.outlivedChoice(NOW)).toBe('1d');
    held('browser', 12 * 3_600_000 + 60_000);
    expect(store.outlivedChoice(NOW)).toBe('browser');
    held('browser', 11 * 3_600_000);
    expect(store.outlivedChoice(NOW)).toBeNull();
  });

  it('counts from the later of the sign-in and the save: a shorter choice never signs anyone out on the spot', () => {
    held('7d', 20 * DAY, 60_000);
    expect(store.outlivedChoice(NOW)).toBeNull();
    held('7d', 20 * DAY, 8 * DAY);
    expect(store.outlivedChoice(NOW)).toBe('7d');
    held('1d', 1000, 5 * DAY);
    expect(store.outlivedChoice(NOW)).toBeNull();
  });

  it('never applies to 30 days, an unknown choice, or a token with no signedInAt yet', () => {
    held('30d', 90 * DAY);
    expect(store.outlivedChoice(NOW)).toBeNull();
    held('90d', 90 * DAY);
    expect(store.outlivedChoice(NOW)).toBeNull();
    local.clear();
    held('1d', null);
    expect(store.outlivedChoice(NOW)).toBeNull();
  });

  it('keeps both beside the token, moves with it between stores, and clears with it', async () => {
    held('browser', 1000);
    await store.placeRefreshToken('browser');
    expect(session.getItem('ma-desk-web-signed-in-at')).not.toBeNull();
    expect(session.getItem('ma-desk-web-session-choice')).not.toBeNull();
    expect(local.getItem('ma-desk-web-signed-in-at')).toBeNull();
    await store.placeRefreshToken('7d');
    expect(local.getItem('ma-desk-web-signed-in-at')).not.toBeNull();
    expect(session.getItem('ma-desk-web-signed-in-at')).toBeNull();
    await store.clearRefreshToken();
    expect([local, session].flatMap((x) => [x.getItem('ma-desk-web-signed-in-at'), x.getItem('ma-desk-web-session-choice')])).toEqual([null, null, null, null]);
  });
});

describe("another tab's token going (ISS-67)", () => {
  /** What arrives on this tab's channel from another tab. */
  let hear: (msg: Moved) => void;
  let gone: boolean[];

  beforeEach(async () => {
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        onmessage: ((e: { data: Moved }) => void) | null = null;
        constructor() {
          hear = (msg) => this.onmessage?.({ data: msg });
        }
        postMessage() {}
      },
    );
    vi.resetModules();
    store = await import('./tokenStore');
    gone = [];
    store.onTokenGoneElsewhere(() => gone.push(store.hasStoredToken()));
  });

  it("a sign-out or a refused refresh elsewhere: told once this tab's own copy has gone, with nothing left here", async () => {
    session.setItem(KEY, 'a');
    await store.readRefreshToken(); // a tab listens from its first read
    hear({ from: 'a', to: null, where: null });
    expect(session.getItem(KEY)).toBeNull();
    expect(gone).toEqual([false]);
  });

  it('a tab reading the token from localStorage, which the other tab cleared', async () => {
    local.setItem(KEY, 'a');
    await store.readRefreshToken();
    local.removeItem(KEY);
    hear({ from: 'a', to: null, where: null });
    expect(gone).toEqual([false]);
  });

  it('a tab with a token of its own is told too, and finds it still there', async () => {
    session.setItem(KEY, 'mine');
    await store.readRefreshToken();
    hear({ from: 'theirs', to: null, where: null });
    expect(session.getItem(KEY)).toBe('mine');
    expect(gone).toEqual([true]);
  });

  it("the token gone is this tab's own, as it read it, even before the other tab's removal from localStorage reaches it (ISS-89)", async () => {
    const was: boolean[] = [];
    store.onTokenGoneElsewhere((w) => was.push(w));
    local.setItem(KEY, 'a');
    await store.readRefreshToken();
    // The channel's message beat the storage: this tab still reads 'a' in localStorage.
    hear({ from: 'a', to: null, where: null });
    expect(was).toEqual([true]);
    expect(gone).toEqual([true]); // what `hasStoredToken` says for now, which alone would leave this tab's keys
  });

  it("another tab's token going, with this tab's own still here, isn't this tab's", async () => {
    const was: boolean[] = [];
    store.onTokenGoneElsewhere((w) => was.push(w));
    session.setItem(KEY, 'mine');
    await store.readRefreshToken();
    hear({ from: 'theirs', to: null, where: null });
    expect(was).toEqual([false]);
  });

  it('a rotation or a move between the stores says nothing', async () => {
    session.setItem(KEY, 'a');
    await store.readRefreshToken();
    hear({ from: 'a', to: 'b', where: 'session' });
    hear({ from: 'b', to: 'b', where: 'local' });
    hear({ from: 'b', to: 'b', where: 'session' });
    expect(gone).toEqual([]);
  });
});
