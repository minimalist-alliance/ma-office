// The member's stream quality against a stand-in for `api()`: the mirror per member, when it reads, what a save
// sends, what a failed save leaves, and that saves go one at a time with the newest winning. The Playwright spec
// `quality.shell.spec.ts` runs the same code against the harness and a real browser.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Level, StreamQuality } from './levels';

const { flags, calls } = vi.hoisted(() => ({
  flags: { platform: true, token: '' },
  calls: [] as { path: string; method: string; body: unknown; resolve: (data: unknown) => void; reject: (err: unknown) => void }[],
}));

vi.mock('../state/layoutStore', () => ({ isSavingLayout: () => flags.platform }));
vi.mock('../platform/api', () => ({
  // As the real one: the token is checked as it's about to go, after client-config, then the request.
  api: async (path: string, init: { method?: string; body?: string; onToken?: (t: string) => void } = {}) => {
    await Promise.resolve();
    init.onToken?.(flags.token);
    return new Promise((resolve, reject) => {
      calls.push({
        path,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(init.body) : undefined,
        resolve: (data) => resolve({ status: 200, data, etag: null, retryAfter: null }),
        reject,
      });
    });
  },
}));

type Store = typeof import('./store');

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const tokenFor = (sub: string): string => `${b64({ alg: 'none' })}.${b64({ sub })}.sig`;
const doc = (d: Level | null, apps: Record<string, Level> = {}, updatedAt: string | null = '2026-11-06T10:00:00.000Z'): StreamQuality => ({ default: d, apps, desks: {}, updatedAt });
/** What a Platform from before contract 0.3.70 answers: no `desks`. */
const before = (d: Level, apps: Record<string, Level> = {}, updatedAt: string | null = '2026-11-06T10:00:00.000Z') => ({ default: d, apps, updatedAt });

const stored = new Map<string, string>();
const docEvents = new Map<string, () => void>();
const winEvents = new Map<string, (e: unknown) => void>();
let hidden = false;
let store: Store;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
  flags.platform = true;
  flags.token = tokenFor('u-a');
  calls.length = 0;
  stored.clear();
  docEvents.clear();
  winEvents.clear();
  hidden = false;
  vi.stubGlobal('window', {
    localStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v) },
    addEventListener: (type: string, fn: (e: unknown) => void) => winEvents.set(type, fn),
    matchMedia: () => ({ matches: false }), // lib/util asks once, as it loads
  });
  vi.stubGlobal('document', {
    get hidden() {
      return hidden;
    },
    addEventListener: (type: string, fn: () => void) => docEvents.set(type, fn),
  });
  vi.resetModules();
  store = await import('./store');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = (ms = 0): Promise<void> => vi.advanceTimersByTimeAsync(ms).then(() => undefined);
const mirror = (sub: string, d: StreamQuality): void => {
  stored.set('ma.streamQuality.v1', JSON.stringify({ sub, doc: d }));
};
const mirrored = (): { sub: string; doc: StreamQuality; layered?: boolean } | null => JSON.parse(stored.get('ma.streamQuality.v1') ?? 'null');
const gets = () => calls.filter((c) => c.path === '/v1/me');
const puts = () => calls.filter((c) => c.method === 'PUT');
const lastPut = () => puts()[puts().length - 1]!;
const shown = (): string => store.levelFor('browser');

/** Started, with the first read answered by Platform. Null: a Platform from before the contract, with no `streamQuality`. */
async function ready(platform: StreamQuality | ReturnType<typeof before> | null = doc(null, {}, null)): Promise<void> {
  store.subscribe(() => {});
  await settle();
  gets()[0]!.resolve(platform === null ? { userId: 'u-a' } : { userId: 'u-a', streamQuality: platform });
  await settle();
}

describe('the mirror in localStorage', () => {
  it("paints from this member's copy before Platform answers", async () => {
    mirror('u-a', doc('medium', { browser: 'low' }));
    expect(shown()).toBe('high'); // nobody has said whose this is yet
    await settle();
    expect(gets()).toHaveLength(1);
    expect(shown()).toBe('low');
    expect(store.levelFor('claude')).toBe('medium');
  });

  it("never uses another member's", async () => {
    mirror('u-b', doc('low', { browser: 'low' }));
    store.subscribe(() => {});
    await settle();
    expect(shown()).toBe('high');
    gets()[0]!.resolve({ streamQuality: doc('max', {}, '2026-11-06T09:00:00.000Z') });
    await settle();
    expect(shown()).toBe('max');
    // And replaces it with this member's.
    expect(mirrored()).toEqual({ sub: 'u-a', doc: doc('max', {}, '2026-11-06T09:00:00.000Z'), layered: true });
  });

  it("Platform's answer is its word, even when older than the mirror", async () => {
    mirror('u-a', doc('low', { browser: 'low' }, '2026-11-06T11:00:00.000Z'));
    await ready(doc('high', {}, null));
    expect(shown()).toBe('high');
    expect(mirrored()?.doc).toEqual(doc('high', {}, null));
  });

  it('a Platform from before the contract says nothing, and the mirror stands', async () => {
    mirror('u-a', doc('low'));
    await ready(null);
    expect(shown()).toBe('low');
  });

  it("another tab's save arrives through storage, if it's this member's and newer", async () => {
    await ready(doc('high', {}, '2026-11-06T10:00:00.000Z'));
    const event = (sub: string, d: StreamQuality) => winEvents.get('storage')!({ key: 'ma.streamQuality.v1', newValue: JSON.stringify({ sub, doc: d }) });
    event('u-b', doc('low', {}, '2026-11-06T11:00:00.000Z'));
    expect(shown()).toBe('high');
    event('u-a', doc('low', {}, '2026-11-06T09:00:00.000Z'));
    expect(shown()).toBe('high');
    event('u-a', doc('low', {}, '2026-11-06T11:00:00.000Z'));
    expect(shown()).toBe('low');
  });
});

describe('reading Platform', () => {
  it('reads on first use, then on coming back to the tab at most once a minute', async () => {
    await ready();
    expect(gets()).toHaveLength(1);
    const visible = async (): Promise<void> => {
      hidden = false;
      docEvents.get('visibilitychange')!();
      await settle();
    };
    await settle(30_000);
    await visible();
    expect(gets()).toHaveLength(1);
    hidden = true;
    await settle(30_000);
    docEvents.get('visibilitychange')!(); // going away reads nothing
    await settle();
    expect(gets()).toHaveLength(1);
    await visible();
    expect(gets()).toHaveLength(2);
    gets()[1]!.resolve({ streamQuality: doc('low', {}, '2026-11-06T12:01:00.000Z') });
    await settle();
    expect(shown()).toBe('low');
    await visible();
    expect(gets()).toHaveLength(2);
  });

  it('one read at a time', async () => {
    store.subscribe(() => {});
    store.subscribe(() => {});
    store.levelFor('browser');
    await settle(61_000);
    docEvents.get('visibilitychange')!();
    await settle();
    expect(gets()).toHaveLength(1);
  });

  it('a failed read leaves what shows', async () => {
    mirror('u-a', doc('low'));
    store.subscribe(() => {});
    await settle();
    gets()[0]!.reject(new Error('Failed to fetch'));
    await settle();
    expect(shown()).toBe('low');
    expect(store.getSnapshot().notice).toBeNull();
  });
});

describe('saving', () => {
  it('shows the change at once, sends the merge body, and takes the document that comes back', async () => {
    await ready();
    const seen: string[] = [];
    store.subscribe(() => seen.push(shown()));
    store.setOverride('browser', 'low');
    expect(shown()).toBe('low');
    await settle();
    expect(lastPut()).toMatchObject({ path: '/v1/me/stream-quality', body: { apps: { browser: 'low' } } });
    lastPut().resolve(doc('high', { browser: 'low' }, '2026-11-06T12:00:00.000Z'));
    await settle();
    expect(shown()).toBe('low');
    expect(mirrored()).toEqual({ sub: 'u-a', doc: doc('high', { browser: 'low' }, '2026-11-06T12:00:00.000Z'), layered: true });
    expect([...new Set(seen)]).toEqual(['low']); // it never flickers back

    store.setOverride('browser', null);
    expect(shown()).toBe('high');
    await settle();
    expect(lastPut().body).toEqual({ apps: { browser: null } });

    lastPut().resolve(doc('high', {}, '2026-11-06T12:00:01.000Z'));
    await settle();
    store.setDefault('medium');
    await settle();
    expect(lastPut().body).toEqual({ default: 'medium' });
    expect(shown()).toBe('medium');
  });

  it.each([
    ['a refusal', { status: 400 }],
    ['a route not deployed yet', { status: 404 }],
    ['a network failure', new TypeError('Failed to fetch')],
  ])('%s puts the old value back and says so, for a few seconds', async (_, err) => {
    await ready(doc('medium', {}, '2026-11-06T10:00:00.000Z'));
    store.setOverride('browser', 'max');
    expect(shown()).toBe('max');
    await settle();
    lastPut().reject(err);
    await settle();
    expect(shown()).toBe('medium');
    expect(store.getSnapshot().notice).toBe("That didn't save. Try again in a moment.");
    expect(mirrored()?.doc.apps).toEqual({});
    await settle(6_000);
    expect(store.getSnapshot().notice).toBeNull();
    expect(puts()).toHaveLength(1); // nothing is retried by itself
  });

  it('a new choice clears the notice', async () => {
    await ready();
    store.setOverride('browser', 'max');
    await settle();
    lastPut().reject(new Error('no'));
    await settle();
    expect(store.getSnapshot().notice).not.toBeNull();
    store.setOverride('browser', 'low');
    expect(store.getSnapshot().notice).toBeNull();
  });

  it('one at a time, and what was chosen meanwhile goes next as one body, the newest winning', async () => {
    await ready();
    store.setOverride('browser', 'low');
    await settle();
    store.setOverride('browser', 'max');
    store.setDefault('medium');
    store.setOverride('browser', 'medium');
    store.setOverride('claude', 'low');
    await settle();
    expect(puts()).toHaveLength(1);
    expect(shown()).toBe('medium');
    puts()[0]!.resolve(doc('high', { browser: 'low' }, '2026-11-06T12:00:00.000Z'));
    await settle();
    expect(puts()).toHaveLength(2);
    expect(puts()[1]!.body).toEqual({ default: 'medium', apps: { browser: 'medium', claude: 'low' } });
    expect(shown()).toBe('medium'); // the first answer doesn't show for a moment under the newer choice
    puts()[1]!.resolve(doc('medium', { browser: 'medium', claude: 'low' }, '2026-11-06T12:00:01.000Z'));
    await settle();
    expect(store.getSnapshot().doc).toEqual(doc('medium', { browser: 'medium', claude: 'low' }, '2026-11-06T12:00:01.000Z'));
    expect(puts()).toHaveLength(2);
  });

  it('a failed save under a newer choice: the newer one still goes, and only what it does not cover comes off', async () => {
    await ready();
    store.setOverride('claude', 'max');
    await settle();
    // Two changes while that's on its way, which go as one body.
    store.setOverride('browser', 'low');
    store.setDefault('max');
    puts()[0]!.resolve(doc('high', { claude: 'max' }, '2026-11-06T12:00:00.000Z'));
    await settle();
    expect(puts()[1]!.body).toEqual({ apps: { browser: 'low' }, default: 'max' });
    store.setOverride('browser', 'medium');
    await settle();
    puts()[1]!.reject(new Error('no'));
    await settle();
    expect(store.getSnapshot().doc).toEqual(doc('high', { claude: 'max', browser: 'medium' }, '2026-11-06T12:00:00.000Z'));
    expect(puts()[2]!.body).toEqual({ apps: { browser: 'medium' } });
  });

  it('a read that crossed a save never takes the change away', async () => {
    await ready(doc('high', {}, '2026-11-06T10:00:00.000Z'));
    await settle(61_000);
    store.setOverride('browser', 'low');
    await settle();
    docEvents.get('visibilitychange')!(); // a read goes out while the save is on its way
    await settle();
    lastPut().resolve(doc('high', { browser: 'low' }, '2026-11-06T12:01:01.000Z'));
    await settle();
    gets()[1]!.resolve({ streamQuality: doc('high', {}, '2026-11-06T10:00:00.000Z') }); // read before the save landed
    await settle();
    expect(shown()).toBe('low');
  });

  it('a read that is newer than a save it crossed wins: it has the save in it, and another tab after', async () => {
    await ready(doc('high', {}, '2026-11-06T10:00:00.000Z'));
    await settle(61_000);
    store.setOverride('browser', 'low');
    await settle();
    docEvents.get('visibilitychange')!();
    await settle();
    gets()[1]!.resolve({ streamQuality: doc('medium', { browser: 'low' }, '2026-11-06T12:01:02.000Z') });
    await settle();
    lastPut().resolve(doc('high', { browser: 'low' }, '2026-11-06T12:01:01.000Z'));
    await settle();
    expect(store.getSnapshot().doc).toEqual(doc('medium', { browser: 'low' }, '2026-11-06T12:01:02.000Z'));
  });

  it("another member's token drops everything and starts over", async () => {
    mirror('u-a', doc('low'));
    await ready(doc('low', {}, '2026-11-06T10:00:00.000Z'));
    flags.token = tokenFor('u-b');
    store.setOverride('browser', 'max');
    await settle();
    expect(puts()).toHaveLength(0); // it never went
    expect(shown()).toBe('high');
    expect(gets()).toHaveLength(2);
    gets()[1]!.resolve({ streamQuality: doc('medium', {}, '2026-11-06T09:00:00.000Z') });
    await settle();
    expect(shown()).toBe('medium');
    expect(mirrored()?.sub).toBe('u-b');
  });
});

describe('the fixtures', () => {
  it('never touch the network or the mirror, and a choice is kept in memory', async () => {
    flags.platform = false;
    mirror('u-a', doc('low'));
    store.subscribe(() => {});
    store.setOverride('browser', 'max');
    await settle(120_000);
    docEvents.get('visibilitychange')?.();
    await settle();
    expect(calls).toEqual([]);
    expect(docEvents.size + winEvents.size).toBe(0);
    expect(shown()).toBe('max');
    expect(mirrored()?.doc).toEqual(doc('low'));
  });
});

describe('the React hook and the player', () => {
  it('subscribe hears each change once, and levelFor follows it', async () => {
    await ready();
    const fn = vi.fn();
    const off = store.subscribe(fn);
    store.setOverride('browser', 'low');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(store.levelFor('browser')).toBe('low');
    off();
    store.setOverride('browser', 'max');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('the snapshot is the same object until something changes', async () => {
    await ready();
    const a = store.getSnapshot();
    expect(store.getSnapshot()).toBe(a);
    store.setOverride('browser', 'low');
    expect(store.getSnapshot()).not.toBe(a);
  });
});

describe("each desk's own, on Platform (contract 0.3.70; the owner's rule: the account sets a default, a desk overrides it, an app on it overrides the desk)", () => {
  const layered = (d: Level | null, desks: StreamQuality['desks'], updatedAt = '2026-11-06T10:00:00.000Z'): StreamQuality => ({ default: d, apps: {}, desks, updatedAt });

  it("an app's level on one desk is that desk's alone, saved to Platform; the other desks follow the account", async () => {
    await ready(doc('medium', {}, '2026-11-06T10:00:00.000Z'));
    expect(store.getSnapshot().layered).toBe(true);
    store.setDeskLevel('d-personal', 'browser', 'low');
    expect(store.levelFor('browser', 'd-personal')).toBe('low');
    expect(store.levelFor('browser', 'd-work')).toBe('medium');
    await settle();
    expect(lastPut().body).toEqual({ desks: { 'd-personal': { apps: { browser: 'low' } } } });
    lastPut().resolve(layered('medium', { 'd-personal': { level: null, apps: { browser: 'low' } } }, '2026-11-06T12:00:00.000Z'));
    await settle();
    expect(store.levelFor('browser', 'd-personal')).toBe('low');
    expect(mirrored()?.doc.desks).toEqual({ 'd-personal': { level: null, apps: { browser: 'low' } } });
    expect(stored.has('ma.streamQuality.desks.v1')).toBe(false); // nothing kept in this browser alone
    // The account's level moves the desks that follow it, and not the one with its own.
    store.setDefault('max');
    expect(store.levelFor('browser', 'd-work')).toBe('max');
    expect(store.levelFor('browser', 'd-personal')).toBe('low');
    // Null follows the desk again, which follows the account.
    store.setDeskLevel('d-personal', 'browser', null);
    expect(store.levelFor('browser', 'd-personal')).toBe('max');
    await settle();
    expect(lastPut().body).toEqual({ default: 'max' });
    lastPut().resolve(layered('max', { 'd-personal': { level: null, apps: { browser: 'low' } } }, '2026-11-06T12:00:01.000Z'));
    await settle();
    expect(lastPut().body).toEqual({ desks: { 'd-personal': { apps: { browser: null } } } });
  });

  it("a desk's own level is for every app on it, under the app's own there, and null follows the account again", async () => {
    await ready(layered('medium', { 'd-work': { level: null, apps: { browser: 'max' } } }));
    store.setDeskOwnLevel('d-work', 'low');
    store.setDeskOwnLevel('d-personal', 'high');
    expect(store.levelFor('browser', 'd-work')).toBe('max'); // the Browser's own on Work comes first
    expect(store.levelFor('claude', 'd-work')).toBe('low');
    expect(store.levelFor('browser', 'd-personal')).toBe('high');
    expect(store.levelFor('browser', 'd-guild')).toBe('medium');
    await settle();
    expect(puts()[0]!.body).toEqual({ desks: { 'd-work': { level: 'low' } } });
    puts()[0]!.resolve(layered('medium', { 'd-work': { level: 'low', apps: { browser: 'max' } } }, '2026-11-06T12:00:00.000Z'));
    await settle();
    expect(puts()[1]!.body).toEqual({ desks: { 'd-personal': { level: 'high' } } });
    puts()[1]!.resolve(layered('medium', { 'd-work': { level: 'low', apps: { browser: 'max' } }, 'd-personal': { level: 'high', apps: {} } }, '2026-11-06T12:00:01.000Z'));
    await settle();
    store.setDeskLevel('d-work', 'browser', null);
    expect(store.levelFor('browser', 'd-work')).toBe('low'); // follows the desk
    store.setDeskOwnLevel('d-work', null);
    expect(store.levelFor('browser', 'd-work')).toBe('medium'); // and the desk the account
    await settle();
    expect(puts()[2]!.body).toEqual({ desks: { 'd-work': { apps: { browser: null } } } });
    puts()[2]!.resolve(layered('medium', { 'd-work': { level: 'low', apps: {} }, 'd-personal': { level: 'high', apps: {} } }, '2026-11-06T12:00:02.000Z'));
    await settle();
    expect(puts()[3]!.body).toEqual({ desks: { 'd-work': { level: null } } });
    expect(store.levelFor('browser', 'd-work')).toBe('medium');
  });

  it('a failed save of a desk\'s level puts it back and says so', async () => {
    await ready(doc('medium'));
    store.setDeskOwnLevel('d-work', 'low');
    expect(store.levelFor('browser', 'd-work')).toBe('low');
    await settle();
    lastPut().reject({ status: 503 });
    await settle();
    expect(store.levelFor('browser', 'd-work')).toBe('medium');
    expect(store.getSnapshot().notice).toBe("That didn't save. Try again in a moment.");
  });

  it('from the mirror, before Platform answers, a new session starts at the desk\'s level', async () => {
    stored.set('ma.streamQuality.v1', JSON.stringify({ sub: 'u-a', doc: layered('high', { 'd-work': { level: 'low', apps: {} } }), layered: true }));
    store.subscribe(() => {});
    await settle();
    expect(store.levelFor('browser', 'd-work')).toBe('low');
    expect(store.getSnapshot().layered).toBe(true);
  });

  it("another member's token drops this member's desk levels", async () => {
    await ready(layered('high', { 'd-personal': { level: 'low', apps: {} } }));
    expect(store.levelFor('browser', 'd-personal')).toBe('low');
    flags.token = tokenFor('u-b');
    store.setDeskLevel('d-personal', 'browser', 'max');
    await settle();
    expect(puts()).toHaveLength(0);
    expect(store.levelFor('browser', 'd-personal')).toBe('high');
    expect(store.getSnapshot().layered).toBeNull();
    gets()[1]!.resolve({ streamQuality: doc(null, {}, null) });
    await settle();
    expect(store.levelFor('browser', 'd-personal')).toBe('high');
  });

  it('the fixtures keep every layer in memory only', async () => {
    flags.platform = false;
    store.subscribe(() => {});
    expect(store.getSnapshot().layered).toBe(true);
    store.setDeskLevel('d-personal', 'browser', 'low');
    store.setDeskOwnLevel('d-work', 'max');
    await settle(1_000);
    expect(store.levelFor('browser', 'd-personal')).toBe('low');
    expect(store.levelFor('browser', 'd-work')).toBe('max');
    expect(stored.size).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe('against a Platform from before 0.3.70 (no desks): an app\'s level on a desk stays in this browser, as before', () => {
  const deskMirror = (): { sub: string; desks: Record<string, Record<string, Level>> } | null => JSON.parse(stored.get('ma.streamQuality.desks.v1') ?? 'null');

  it("is that desk's alone, kept here, never sent; a desk's own level for every app isn't offered", async () => {
    await ready(before('medium', {}, '2026-11-06T10:00:00.000Z'));
    expect(store.getSnapshot().layered).toBe(false);
    expect(mirrored()?.layered).toBe(false);
    store.setDeskLevel('d-personal', 'browser', 'low');
    expect(store.levelFor('browser', 'd-personal')).toBe('low');
    expect(store.levelFor('browser', 'd-work')).toBe('medium');
    expect(store.getSnapshot().doc.desks).toEqual({ 'd-personal': { level: null, apps: { browser: 'low' } } });
    store.setDeskOwnLevel('d-work', 'max');
    expect(store.levelFor('browser', 'd-work')).toBe('medium');
    await settle(1_000);
    expect(puts()).toEqual([]);
    expect(deskMirror()).toEqual({ sub: 'u-a', desks: { 'd-personal': { browser: 'low' } } });
    store.setDeskLevel('d-personal', 'browser', null);
    expect(store.levelFor('browser', 'd-personal')).toBe('medium');
    expect(deskMirror()).toEqual({ sub: 'u-a', desks: {} });
  });

  it("this member's come back on the next load, and another member's are never used", async () => {
    stored.set('ma.streamQuality.desks.v1', JSON.stringify({ sub: 'u-a', desks: { 'd-work': { browser: 'max' }, __proto__x: { browser: 'low' }, 'd-bad': { browser: 'ultra' } } }));
    await ready(before('high'));
    expect(store.levelFor('browser', 'd-work')).toBe('max');
    expect(store.getSnapshot().doc.desks).toEqual({ 'd-work': { level: null, apps: { browser: 'max' } } });

    vi.resetModules();
    store = await import('./store');
    stored.set('ma.streamQuality.desks.v1', JSON.stringify({ sub: 'u-b', desks: { 'd-work': { browser: 'low' } } }));
    await ready(before('high'));
    expect(store.levelFor('browser', 'd-work')).toBe('high');
  });

  it("another tab's choice for another desk isn't lost, and arrives through storage", async () => {
    await ready(before('high'));
    store.setDeskLevel('d-personal', 'browser', 'low');
    stored.set('ma.streamQuality.desks.v1', JSON.stringify({ sub: 'u-a', desks: { 'd-personal': { browser: 'low' }, 'd-work': { browser: 'medium' } } }));
    winEvents.get('storage')!({ key: 'ma.streamQuality.desks.v1', newValue: stored.get('ma.streamQuality.desks.v1') });
    expect(store.levelFor('browser', 'd-work')).toBe('medium');
    store.setDeskLevel('d-personal', 'browser', 'max');
    expect(deskMirror()?.desks).toEqual({ 'd-personal': { browser: 'max' }, 'd-work': { browser: 'medium' } });
  });
});

describe("moving this browser's desk levels to Platform, once it has the desk layer", () => {
  const deskMirror = (): { sub: string; desks: Record<string, Record<string, Level>> } | null => JSON.parse(stored.get('ma.streamQuality.desks.v1') ?? 'null');
  const keep = (desks: Record<string, Record<string, Level>>, sub = 'u-a'): void => void stored.set('ma.streamQuality.desks.v1', JSON.stringify({ sub, desks }));

  it('goes once, quietly, under anything Platform already has, and empties the browser\'s copy', async () => {
    keep({ 'd-personal': { browser: 'low' }, 'd-work': { browser: 'max' } });
    await ready({ default: 'high', apps: {}, desks: { 'd-work': { level: null, apps: { browser: 'medium' } } }, updatedAt: '2026-11-06T10:00:00.000Z' });
    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.body).toEqual({ desks: { 'd-personal': { apps: { browser: 'low' } } } }); // Work's on Platform wins
    // While it moves, this browser's level shows for the desk Platform has none for, and Platform's for the other.
    expect(store.levelFor('browser', 'd-personal')).toBe('low');
    expect(store.levelFor('browser', 'd-work')).toBe('medium');
    puts()[0]!.resolve({ default: 'high', apps: {}, desks: { 'd-personal': { level: null, apps: { browser: 'low' } }, 'd-work': { level: null, apps: { browser: 'medium' } } }, updatedAt: '2026-11-06T12:00:00.000Z' });
    await settle();
    expect(store.levelFor('browser', 'd-personal')).toBe('low');
    expect(deskMirror()).toEqual({ sub: 'u-a', desks: {} });
    expect(store.getSnapshot().notice).toBeNull();
    // A later read moves nothing again.
    await settle(61_000);
    docEvents.get('visibilitychange')!();
    await settle();
    gets()[1]!.resolve({ streamQuality: { default: 'high', apps: {}, desks: { 'd-personal': { level: null, apps: { browser: 'low' } } }, updatedAt: '2026-11-06T12:00:00.000Z' } });
    await settle();
    expect(puts()).toHaveLength(1);
  });

  it('with nothing Platform lacks, the copy is emptied with no save', async () => {
    keep({ 'd-work': { browser: 'max' } });
    await ready({ default: null, apps: {}, desks: { 'd-work': { level: 'low', apps: { browser: 'high' } } }, updatedAt: '2026-11-06T10:00:00.000Z' });
    expect(puts()).toEqual([]);
    expect(deskMirror()).toEqual({ sub: 'u-a', desks: {} });
  });

  it('a failed move says nothing, keeps the copy, and tries again at the next read', async () => {
    keep({ 'd-personal': { browser: 'low' } });
    await ready(doc(null, {}, '2026-11-06T10:00:00.000Z'));
    puts()[0]!.reject({ status: 503 });
    await settle();
    expect(store.getSnapshot().notice).toBeNull();
    expect(deskMirror()?.desks).toEqual({ 'd-personal': { browser: 'low' } });
    expect(store.levelFor('browser', 'd-personal')).toBe('low'); // still this browser's, until it moves
    await settle(61_000);
    docEvents.get('visibilitychange')!();
    await settle();
    gets()[1]!.resolve({ streamQuality: doc(null, {}, '2026-11-06T10:00:00.000Z') });
    await settle();
    expect(puts()).toHaveLength(2);
    expect(puts()[1]!.body).toEqual({ desks: { 'd-personal': { apps: { browser: 'low' } } } });
  });

  it("another member's copy is never moved", async () => {
    keep({ 'd-personal': { browser: 'low' } }, 'u-b');
    await ready(doc(null, {}, null));
    expect(puts()).toEqual([]);
    expect(deskMirror()?.sub).toBe('u-b');
  });

  it('a change the member makes while it moves goes next, after it', async () => {
    keep({ 'd-personal': { browser: 'low' } });
    await ready(doc(null, {}, '2026-11-06T10:00:00.000Z'));
    store.setDeskOwnLevel('d-work', 'max');
    await settle();
    expect(puts()).toHaveLength(1);
    puts()[0]!.resolve({ default: null, apps: {}, desks: { 'd-personal': { level: null, apps: { browser: 'low' } } }, updatedAt: '2026-11-06T12:00:00.000Z' });
    await settle();
    expect(puts()).toHaveLength(2);
    expect(puts()[1]!.body).toEqual({ desks: { 'd-work': { level: 'max' } } });
    expect(store.levelFor('browser', 'd-work')).toBe('max');
  });
});
