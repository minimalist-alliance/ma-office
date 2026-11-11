// What the office last drew for a member (`lastKnown.ts`): kept per account, in the token's store (sessionStorage under
// "Stay signed in" `browser`), cleared with the token, drawn at once on a returning visit and replaced by each fresh
// answer (stale-while-revalidate), and never a reason to throw. `fastStart.shell.spec.ts` runs it in a real browser.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Tokens = typeof import('./tokenStore');
type Last = typeof import('./lastKnown');
type Desks = typeof import('../state/deskStore');
type Meter = typeof import('../bandwidth/store');

const TOKEN = 'ma-desk-web-refresh';
const KEY = 'ma-desk-web-last-known';
const MIRROR = 'ma.desks.v1';
const AT = 'ma-desk-web-signed-in-at';

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

const ME = {
  userId: 'sub-a',
  email: 'dana@example.org',
  displayName: 'Dana Example',
  roles: ['owner'],
  membership: { status: 'active', tier: 'officer', badge: 'officer', ageBand: 'teen', billingUrl: 'https://x' },
  preferences: { staySignedIn: '30d' },
};
const CONFIG = { api: 'https://api.example', auth: { domain: 'https://auth.example', clientId: 'c', redirectUri: '', logoutUri: '', scopes: [] }, tierNames: { officer: 'Officer' } };
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const past = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const meter = (resetsAt = future(3)) => ({
  week: { usedBytes: 2e9, limitGb: 25, startsAt: past(4), resetsAt },
  month: { usedBytes: 5e9, limitGb: 100, startsAt: past(9), resetsAt: future(20) },
  state: 'ok',
});

let local: Storage;
let session: Storage;
let tokens: Tokens;
let last: Last;

async function load(): Promise<void> {
  vi.resetModules();
  tokens = await import('./tokenStore');
  last = await import('./lastKnown');
}

beforeEach(async () => {
  local = memoryStorage();
  session = memoryStorage();
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('indexedDB', undefined);
  vi.stubGlobal('BroadcastChannel', class { onmessage: unknown = null; postMessage() {} });
  local.setItem(TOKEN, 'refresh-a');
  local.setItem(AT, '1000');
  await load();
});

const stored = (s: Storage) => JSON.parse(s.getItem(KEY) ?? 'null') as Record<string, unknown> | null;

describe('what is kept', () => {
  it('only what the chrome draws: no email, status, age band, roles or preferences', () => {
    const me = last.lastMeOf(ME, 'DE');
    expect(me).toEqual({ userId: 'sub-a', displayName: 'Dana Example', initials: 'DE', badge: 'officer' });
    last.lastKnownFor('sub-a');
    last.rememberLastKnown('me', me);
    const raw = local.getItem(KEY)!;
    for (const word of ['dana@example.org', 'teen', 'owner', 'active', 'billingUrl', 'staySignedIn', 'refresh-a']) expect(raw).not.toContain(word);
  });

  it("the picture's address only over https, and a built avatar only while it's small", () => {
    expect(last.lastMeOf({ ...ME, avatarUrl: 'https://media.example/a.webp' }, 'DE')?.avatarUrl).toBe('https://media.example/a.webp');
    expect(last.lastMeOf({ ...ME, avatarUrl: 'javascript:alert(1)' }, 'DE')?.avatarUrl).toBeUndefined();
    expect(last.lastMeOf({ ...ME, avatar: { kind: 'built', config: { hair: 3 } } }, 'DE')?.avatar).toEqual({ kind: 'built', config: { hair: 3 } });
    expect(last.lastMeOf({ ...ME, avatar: { kind: 'built', config: 'x'.repeat(5000) } }, 'DE')?.avatar).toBeUndefined();
    expect(last.lastMeOf({ displayName: 'No id' }, '')).toBeNull();
  });

  it('nothing at all without a token: there is no session to keep it beside', () => {
    local.removeItem(TOKEN);
    last.lastKnownFor('sub-a');
    last.rememberLastKnown('me', last.lastMeOf(ME, 'DE'));
    expect(local.getItem(KEY)).toBeNull();
    expect(session.getItem(KEY)).toBeNull();
  });
});

describe('per account', () => {
  it("is written for the first token's sub, waiting until that's known", () => {
    last.rememberLastKnown('config', CONFIG);
    expect(local.getItem(KEY)).toBeNull();
    expect(last.lastKnownFor('sub-a')).toBe(true);
    expect(stored(local)).toMatchObject({ v: 1, sub: 'sub-a', signedInAt: 1000, config: CONFIG });
  });

  it("someone else's token: the record goes, and the caller takes down what it drew", () => {
    last.lastKnownFor('sub-a');
    last.rememberLastKnown('me', last.lastMeOf(ME, 'DE'));
    expect(last.lastKnownFor('sub-b')).toBe(false);
    expect(local.getItem(KEY)).toBeNull();
    last.rememberLastKnown('me', last.lastMeOf({ ...ME, userId: 'sub-b', displayName: 'Bo Other' }, 'BO'));
    expect(stored(local)).toMatchObject({ sub: 'sub-b', me: { displayName: 'Bo Other' } });
  });

  it('is drawn only under the sign-in it was written in: a new sign-in here, by anyone, draws none of it', () => {
    last.lastKnownFor('sub-a');
    last.rememberLastKnown('me', last.lastMeOf(ME, 'DE'));
    local.setItem(MIRROR, JSON.stringify([{ id: 'd-1', name: 'Diary', kind: 'personal' }]));
    expect(last.readLastKnown()?.me?.displayName).toBe('Dana Example');
    expect(last.lastKnownFitsSession()).toBe(true);
    local.setItem(AT, '2000'); // the sign-in pages' handoff of someone's new sign-in
    expect(last.readLastKnown()).toBeNull();
    expect(last.lastKnownFitsSession()).toBe(false);
  });

  it('a record that is not ours to read is nothing', () => {
    for (const bad of ['{', '[]', '{"v":2,"sub":"sub-a","signedInAt":1000}', '{"v":1,"signedInAt":1000}', 'x'.repeat(70_000)]) {
      local.setItem(KEY, bad);
      expect(last.readLastKnown()).toBeNull();
    }
    expect(last.checkedLastMe({ userId: 'sub-a' })).toBeNull();
    expect(last.checkedConfig({ api: 'https://api.example' })).toBeNull();
  });
});

describe('cleared with the session', () => {
  beforeEach(() => {
    last.lastKnownFor('sub-a');
    last.rememberLastKnown('me', last.lastMeOf(ME, 'DE'));
    local.setItem(MIRROR, '[]');
  });

  it('sign-out takes it, and the desk mirror, from both stores', async () => {
    session.setItem(KEY, 'stray');
    await tokens.clearRefreshToken();
    for (const s of [local, session]) {
      expect(s.getItem(KEY)).toBeNull();
      expect(s.getItem(MIRROR)).toBeNull();
    }
  });

  it('a refused refresh (invalid_grant, ma_session_ended) takes it with the token', async () => {
    expect(await tokens.clearRefreshTokenIf('refresh-a')).toBe(true);
    expect(local.getItem(KEY)).toBeNull();
    expect(local.getItem(MIRROR)).toBeNull();
  });

  it('a dead session (session_revoked) or a refusal forgets it, token or not', () => {
    last.forgetLastKnown();
    expect(local.getItem(KEY)).toBeNull();
    expect(local.getItem(TOKEN)).toBe('refresh-a');
  });
});

describe('"Stay signed in" until the browser closes', () => {
  it("moves into this tab's sessionStorage with the token, and later writes go there only", async () => {
    last.lastKnownFor('sub-a');
    last.rememberLastKnown('me', last.lastMeOf(ME, 'DE'));
    local.setItem(MIRROR, '[]');
    await tokens.placeRefreshToken('browser');
    expect(local.getItem(KEY)).toBeNull();
    expect(local.getItem(MIRROR)).toBeNull();
    expect(stored(session)).toMatchObject({ sub: 'sub-a' });
    expect(session.getItem(MIRROR)).toBe('[]');
    last.rememberLastKnown('config', CONFIG);
    expect(local.getItem(KEY)).toBeNull();
    expect(stored(session)).toMatchObject({ sub: 'sub-a', config: CONFIG });
    expect(last.readLastKnown()?.config).toEqual(CONFIG);
  });

  it('a tab with none of its own reads nothing from localStorage', () => {
    local.setItem(KEY, JSON.stringify({ v: 1, sub: 'sub-a', signedInAt: 1000 }));
    session.setItem(TOKEN, 'refresh-a');
    session.setItem(AT, '1000');
    expect(tokens.readBeside(KEY)).toBeNull();
  });
});

describe('storage that refuses', () => {
  it('never throws, and gives no head start', () => {
    const angry = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('blocked'); } };
    vi.stubGlobal('localStorage', angry);
    vi.stubGlobal('sessionStorage', angry);
    expect(() => {
      last.lastKnownFor('sub-a');
      last.rememberLastKnown('me', last.lastMeOf(ME, 'DE'));
      last.forgetLastKnown();
    }).not.toThrow();
    expect(last.readLastKnown()).toBeNull();
    expect(last.lastKnownFitsSession()).toBe(true);
  });
});

describe('stale-while-revalidate', () => {
  it('the desk list paints from the mirror at once, then each answer replaces it', async () => {
    last.lastKnownFor('sub-a');
    last.rememberLastKnown('me', last.lastMeOf(ME, 'DE'));
    local.setItem(MIRROR, JSON.stringify([{ id: 'd-1', name: 'Diary', kind: 'personal' }]));
    vi.resetModules();
    const desks: Desks = await import('../state/deskStore');
    expect(desks.useDeskStore.getState()).toMatchObject({ status: 'loading', desks: [{ id: 'd-1', name: 'Diary', vm: 'unknown' }] });
    desks.setDeskList([{ deskId: 'd-2', kind: 'work', name: 'Work', state: 'stopped' }]);
    expect(desks.useDeskStore.getState().desks.map((d) => d.id)).toEqual(['d-2']);
    expect(JSON.parse(local.getItem(MIRROR)!)).toEqual([{ id: 'd-2', name: 'Work', kind: 'work' }]);
  });

  it("the mirror of a sign-in since isn't drawn, and someone else's goes while the list is out", async () => {
    last.lastKnownFor('sub-a');
    last.rememberLastKnown('me', last.lastMeOf(ME, 'DE'));
    local.setItem(MIRROR, JSON.stringify([{ id: 'd-1', name: 'Diary', kind: 'personal' }]));
    local.setItem(AT, '2000');
    vi.resetModules();
    let desks: Desks = await import('../state/deskStore');
    expect(desks.useDeskStore.getState().desks).toEqual([]);
    local.setItem(AT, '1000');
    vi.resetModules();
    desks = await import('../state/deskStore');
    expect(desks.useDeskStore.getState().desks).toHaveLength(1);
    desks.dropMirroredDesks();
    expect(desks.useDeskStore.getState().desks).toEqual([]);
    expect(local.getItem(MIRROR)).toBeNull();
  });

  it("the meter shows the last one at once, not one whose week is over, and Platform's answer wins", async () => {
    const bw: Meter = await import('../bandwidth/store');
    bw.showLastMeter(meter(past(1)));
    expect(bw.useBandwidth.getState().meter).toBeNull();
    bw.showLastMeter(meter());
    expect(bw.useBandwidth.getState().meter?.week.usedBytes).toBe(2e9);
    bw.dropLastMeter();
    expect(bw.useBandwidth.getState().meter).toBeNull();
    bw.showLastMeter({ week: 'nonsense' });
    expect(bw.useBandwidth.getState().meter).toBeNull();
  });

  it('client-config: the loader hands over its own answer once, so the first ask needs no second request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('window', { __maClientConfig: { app: 'desk-web', ...CONFIG }, location: { hostname: 'office.example' } });
    vi.resetModules();
    const cc = await import('./clientConfig');
    expect(await cc.getClientConfig()).toMatchObject({ api: 'https://api.example' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((window as unknown as Record<string, unknown>)['__maClientConfig']).toBeUndefined();
    expect(cc.usableConfig({ app: 'platform-web', ...CONFIG })).toBeNull();
  });
});
