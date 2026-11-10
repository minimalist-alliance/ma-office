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
const doc = (d: Level, apps: Record<string, Level> = {}, updatedAt: string | null = '2026-11-06T10:00:00.000Z'): StreamQuality => ({ default: d, apps, updatedAt });

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
const mirrored = (): { sub: string; doc: StreamQuality } | null => JSON.parse(stored.get('ma.streamQuality.v1') ?? 'null');
const gets = () => calls.filter((c) => c.path === '/v1/me');
const puts = () => calls.filter((c) => c.method === 'PUT');
const lastPut = () => puts()[puts().length - 1]!;
const shown = (): string => store.levelFor('browser');

/** Started, with the first read answered by Platform. Null: a Platform from before the contract, with no `streamQuality`. */
async function ready(platform: StreamQuality | null = doc('high', {}, null)): Promise<void> {
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
    expect(mirrored()).toEqual({ sub: 'u-a', doc: doc('max', {}, '2026-11-06T09:00:00.000Z') });
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
    expect(mirrored()).toEqual({ sub: 'u-a', doc: doc('high', { browser: 'low' }, '2026-11-06T12:00:00.000Z') });
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

describe("each desk's own level (finding 5: the account sets a default, a desk overrides it)", () => {
  const deskMirror = (): { sub: string; desks: Record<string, Record<string, Level>> } | null => JSON.parse(stored.get('ma.streamQuality.desks.v1') ?? 'null');

  it('a level chosen on one desk is that desk\'s alone: the others follow the account, and Platform never hears of it', async () => {
    await ready(doc('medium', {}, '2026-11-06T10:00:00.000Z'));
    store.setDeskLevel('d-personal', 'browser', 'low');
    expect(store.levelFor('browser', 'd-personal')).toBe('low');
    expect(store.levelFor('browser', 'd-work')).toBe('medium');
    expect(store.getSnapshot().desks).toEqual({ 'd-personal': { browser: 'low' } });
    await settle(1_000);
    expect(puts()).toEqual([]);
    expect(deskMirror()).toEqual({ sub: 'u-a', desks: { 'd-personal': { browser: 'low' } } });
    // The account's level moves the desks that follow it, and not the one with its own.
    store.setOverride('browser', 'max');
    expect(store.levelFor('browser', 'd-work')).toBe('max');
    expect(store.levelFor('browser', 'd-personal')).toBe('low');
    // Null follows the account again, and leaves nothing behind.
    store.setDeskLevel('d-personal', 'browser', null);
    expect(store.levelFor('browser', 'd-personal')).toBe('max');
    expect(deskMirror()).toEqual({ sub: 'u-a', desks: {} });
  });

  it("this member's desk levels come back on the next load, and another member's are never used", async () => {
    stored.set('ma.streamQuality.desks.v1', JSON.stringify({ sub: 'u-a', desks: { 'd-work': { browser: 'max' }, __proto__x: { browser: 'low' }, 'd-bad': { browser: 'ultra' } } }));
    await ready();
    expect(store.levelFor('browser', 'd-work')).toBe('max');
    expect(store.getSnapshot().desks).toEqual({ 'd-work': { browser: 'max' } });

    vi.resetModules();
    store = await import('./store');
    stored.set('ma.streamQuality.desks.v1', JSON.stringify({ sub: 'u-b', desks: { 'd-work': { browser: 'low' } } }));
    await ready();
    expect(store.levelFor('browser', 'd-work')).toBe('high');
  });

  it('a choice before the first token is kept, over what this browser had for other desks', async () => {
    stored.set('ma.streamQuality.desks.v1', JSON.stringify({ sub: 'u-a', desks: { 'd-work': { browser: 'max' } } }));
    store.setDeskLevel('d-personal', 'browser', 'low');
    expect(store.levelFor('browser', 'd-personal')).toBe('low');
    await ready();
    expect(store.getSnapshot().desks).toEqual({ 'd-work': { browser: 'max' }, 'd-personal': { browser: 'low' } });
    expect(deskMirror()).toEqual({ sub: 'u-a', desks: { 'd-work': { browser: 'max' }, 'd-personal': { browser: 'low' } } });
  });

  it("another tab's choice for another desk isn't lost, and arrives through storage", async () => {
    await ready();
    store.setDeskLevel('d-personal', 'browser', 'low');
    // Another tab chose for Work meanwhile.
    stored.set('ma.streamQuality.desks.v1', JSON.stringify({ sub: 'u-a', desks: { 'd-personal': { browser: 'low' }, 'd-work': { browser: 'medium' } } }));
    winEvents.get('storage')!({ key: 'ma.streamQuality.desks.v1', newValue: stored.get('ma.streamQuality.desks.v1') });
    expect(store.levelFor('browser', 'd-work')).toBe('medium');
    store.setDeskLevel('d-personal', 'browser', 'max');
    expect(deskMirror()?.desks).toEqual({ 'd-personal': { browser: 'max' }, 'd-work': { browser: 'medium' } });
  });

  it("another member's token drops this member's desk levels", async () => {
    await ready();
    store.setDeskLevel('d-personal', 'browser', 'low');
    flags.token = tokenFor('u-b');
    store.setOverride('browser', 'max');
    await settle();
    expect(store.levelFor('browser', 'd-personal')).toBe('high');
    gets()[1]!.resolve({ streamQuality: doc('high', {}, null) });
    await settle();
    expect(store.levelFor('browser', 'd-personal')).toBe('high');
    expect(deskMirror()?.sub).toBe('u-a'); // left as it was, for u-a's next sign-in here
  });

  it('the fixtures keep a desk level in memory only', async () => {
    flags.platform = false;
    store.subscribe(() => {});
    store.setDeskLevel('d-personal', 'browser', 'low');
    await settle(1_000);
    expect(store.levelFor('browser', 'd-personal')).toBe('low');
    expect(stored.has('ma.streamQuality.desks.v1')).toBe(false);
    expect(calls).toEqual([]);
  });
});
