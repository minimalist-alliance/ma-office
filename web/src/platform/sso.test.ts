// The office's calls to the shared sign-in at `id.` (ma-platform contract auth.md §2.8, `sso.ts`): exactly what goes there,
// that nothing it answers changes the office, and the signed-out page's one more try. tests/e2e/sso.shell.spec.ts runs them
// in the office against a stand-in `id.`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { END_WAIT_MS, endSharedSignIn, keepSharedSignIn, OTHER_APPS_LINE, SIGN_OUT_NOTE_KEY, SIGNED_OUT_KEY, signedOutLine, SSO_WAIT_MS } from './sso';

const ID = 'https://id.minimalistalliance.com';

let tab: Map<string, string>;
let calls: { url: string; init: RequestInit }[];
let reply: () => Promise<Response>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(Date.parse('2026-11-12T12:00:00Z'));
  tab = new Map();
  calls = [];
  reply = () => Promise.resolve(new Response(null, { status: 204 }));
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => tab.get(k) ?? null, setItem: (k: string, v: string) => void tab.set(k, v), removeItem: (k: string) => void tab.delete(k) });
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return reply();
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('step 1: keepSharedSignIn', () => {
  it('POSTs {} to /v1/sso/session with the access token and the cookie, and nothing in the URL', async () => {
    reply = () => Promise.resolve(Response.json({ shared: true }));
    await keepSharedSignIn(ID, 'access-1');
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [{ url: string; init: RequestInit }];
    expect(url).toBe(`${ID}/v1/sso/session`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', cache: 'no-store', body: '{}', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-1' } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.keepalive).toBeUndefined();
  });

  it.each<[string, () => Promise<Response>]>([
    ['{"shared": false}', () => Promise.resolve(Response.json({ shared: false }))],
    ['401 session_revoked', () => Promise.resolve(Response.json({ error: { code: 'session_revoked' } }, { status: 401 }))],
    ['403 forbidden', () => Promise.resolve(Response.json({ error: { code: 'forbidden' } }, { status: 403 }))],
    ['429', () => Promise.resolve(new Response(null, { status: 429 }))],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['the wait running out', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
  ])('%s changes nothing and never throws', async (_, r) => {
    reply = r;
    await expect(keepSharedSignIn(ID, 'access-1')).resolves.toBeUndefined();
    expect(tab.size).toBe(0);
  });

  it('gives the shared sign-in 4 s', () => {
    expect(SSO_WAIT_MS).toBe(4_000);
  });
});

describe('step 3: endSharedSignIn', () => {
  it("marks this tab signed out first, then POSTs {} to /v1/sso/end with the cookie, keepalive, no Authorization; 'ended' on its 204", async () => {
    let markedFirst = false;
    reply = () => {
      markedFirst = tab.get(SIGNED_OUT_KEY) === String(Date.now());
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    await expect(endSharedSignIn(ID)).resolves.toBe('ended');
    expect(markedFirst).toBe(true);
    const [{ url, init }] = calls as [{ url: string; init: RequestInit }];
    expect(url).toBe(`${ID}/v1/sso/end`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', keepalive: true, body: '{}', headers: { 'Content-Type': 'application/json' } });
    expect(Object.keys(init.headers as object)).toEqual(['Content-Type']);
    expect(tab.has(SIGN_OUT_NOTE_KEY)).toBe(false);
  });

  it.each<[string, () => Promise<Response>]>([
    ['503 unavailable', () => Promise.resolve(Response.json({ error: { code: 'unavailable' } }, { status: 503 }))],
    ['429 rate_limited', () => Promise.resolve(Response.json({ error: { code: 'rate_limited' } }, { status: 429 }))],
    ['a 200 that is not its 204', () => Promise.resolve(new Response('{}', { status: 200 }))],
  ])("%s: 'refused', noted so the signed-out page says so at once, with no second try", async (_, r) => {
    reply = r;
    await expect(endSharedSignIn(ID)).resolves.toBe('refused');
    expect(tab.get(SIGN_OUT_NOTE_KEY)).toBe('end-refused');
  });

  it("a network failure: 'unanswered', noted for one more try", async () => {
    reply = () => Promise.reject(new TypeError('Failed to fetch'));
    await expect(endSharedSignIn(ID)).resolves.toBe('unanswered');
    expect(tab.get(SIGN_OUT_NOTE_KEY)).toBe('end');
  });

  it("no answer: goes on after END_WAIT_MS, 'unanswered', noted for one more try", async () => {
    reply = () => new Promise(() => {});
    const done = endSharedSignIn(ID);
    await vi.advanceTimersByTimeAsync(END_WAIT_MS - 1);
    expect(tab.has(SIGN_OUT_NOTE_KEY)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toBe('unanswered');
    expect(tab.get(SIGN_OUT_NOTE_KEY)).toBe('end');
  });

  it('storage that refuses still sends it', async () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } });
    reply = () => Promise.resolve(new Response(null, { status: 503 }));
    await expect(endSharedSignIn(ID)).resolves.toBe('refused');
    expect(calls).toHaveLength(1);
  });
});

describe('the signed-out page: signedOutLine', () => {
  it('with nothing noted, asks nothing and says nothing more', async () => {
    await expect(signedOutLine(ID)).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it("a refused step 3 (a 503): the line at once, nothing sent again (id. cleared its cookie, so a retry would say 204 with nothing ended)", async () => {
    tab.set(SIGN_OUT_NOTE_KEY, 'end-refused');
    await expect(signedOutLine(ID)).resolves.toBe(OTHER_APPS_LINE);
    expect(calls).toEqual([]);
    expect(tab.has(SIGN_OUT_NOTE_KEY)).toBe(false);
    await expect(signedOutLine(ID)).resolves.toBeNull(); // once
  });

  it('an unanswered step 3: one more try; its 204 says nothing more, and the note goes', async () => {
    tab.set(SIGN_OUT_NOTE_KEY, 'end');
    await expect(signedOutLine(ID)).resolves.toBeNull();
    expect(calls.map((c) => c.url)).toEqual([`${ID}/v1/sso/end`]);
    expect(tab.has(SIGN_OUT_NOTE_KEY)).toBe(false);
  });

  it.each<[string, () => Promise<Response>]>([
    ['a 503', () => Promise.resolve(new Response(null, { status: 503 }))],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('an unanswered step 3 whose one more try gets %s: the line, with the shared-computer sentence; once', async (_, r) => {
    tab.set(SIGN_OUT_NOTE_KEY, 'end');
    reply = r;
    await expect(signedOutLine(ID)).resolves.toBe(OTHER_APPS_LINE);
    expect(OTHER_APPS_LINE).toContain('On a shared computer, sign out of each of them too.');
    await expect(signedOutLine(ID)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('an unanswered step 3 whose one more try gets no answer either: the line after END_WAIT_MS', async () => {
    tab.set(SIGN_OUT_NOTE_KEY, 'end');
    reply = () => new Promise(() => {});
    const line = signedOutLine(ID);
    await vi.advanceTimersByTimeAsync(END_WAIT_MS);
    await expect(line).resolves.toBe(OTHER_APPS_LINE);
  });

  it('an unanswered step 3 with no client-config to try it at: the line, and nothing sent', async () => {
    tab.set(SIGN_OUT_NOTE_KEY, 'end');
    await expect(signedOutLine(null)).resolves.toBe(OTHER_APPS_LINE);
    expect(calls).toEqual([]);
  });

  it("a note from 6.10's Sign out everywhere (gone from the office in 6.11) says nothing more and goes", async () => {
    tab.set(SIGN_OUT_NOTE_KEY, 'everywhere');
    await expect(signedOutLine(ID)).resolves.toBeNull();
    expect(calls).toEqual([]);
    expect(tab.has(SIGN_OUT_NOTE_KEY)).toBe(false);
  });
});
