// `api()` and the shared sign-in (ma-platform contract auth.md §2.8): step 1 once a page load, after the first good call and
// with that call's token, and a `session_revoked` that outlasts the refresh revoking its refresh token (`endRevoked`). Both
// only where client-config's `auth.sso` is an object with an https origin (`ssoOrigin`); without it `api()` is as it was.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sso: undefined as unknown,
  /** Each access token `getAccessToken` gives, in turn; `force` marks a refresh. */
  tokens: [] as string[],
  forced: [] as boolean[],
  revokedWith: [] as string[],
  kept: [] as [string, string][],
}));

vi.mock('./clientConfig', () => ({
  getClientConfig: async () => ({ api: 'https://api.minimalistalliance.com', auth: { domain: 'https://auth.test', clientId: 'c', ...(h.sso === undefined ? {} : { sso: h.sso }) } }),
}));
vi.mock('./auth', () => ({
  SignInRequired: class SignInRequired extends Error {},
  getAccessToken: async (force = false) => {
    h.forced.push(force);
    return h.tokens.shift() ?? 'access-last';
  },
  endRevoked: async (sent: string) => void h.revokedWith.push(sent),
}));
vi.mock('./sso', () => ({ keepSharedSignIn: async (origin: string, token: string) => void h.kept.push([origin, token]) }));

type Api = typeof import('./api');
let api: Api;
let replies: Response[];

const ON = { origin: 'https://id.minimalistalliance.com' };
const revokedReply = () => Response.json({ error: { code: 'session_revoked', message: 'Signed out.', requestId: 'r', retryable: false } }, { status: 401 });

beforeEach(async () => {
  Object.assign(h, { sso: undefined, tokens: ['access-1', 'access-2', 'access-3'], forced: [], revokedWith: [], kept: [] });
  replies = [];
  vi.stubGlobal('location', { hostname: 'office.minimalistalliance.com' });
  vi.stubGlobal('fetch', async () => replies.shift() ?? Response.json({}));
  vi.resetModules();
  api = await import('./api');
});

const settle = () => new Promise((done) => setTimeout(done, 0));

describe('a lasting session_revoked', () => {
  it('revokes the refresh token behind the token refused the second time, then says sign in', async () => {
    h.sso = ON;
    replies = [revokedReply(), revokedReply()];
    await expect(api.getMe()).rejects.toThrow();
    expect(h.forced).toEqual([false, true]);
    expect(h.revokedWith).toEqual(['access-2']);
  });

  it('a 401 the refresh mends is no sign-out', async () => {
    h.sso = ON;
    replies = [revokedReply(), Response.json({ userId: 'u' })];
    await expect(api.getMe()).resolves.toMatchObject({ data: { userId: 'u' } });
    expect(h.revokedWith).toEqual([]);
  });

  it.each<[string, () => Response]>([
    ["API Gateway's own 401", () => Response.json({ message: 'Unauthorized' }, { status: 401 })],
    ['another code', () => Response.json({ error: { code: 'unauthorized' } }, { status: 401 })],
  ])('%s is a sign-in as before, with nothing revoked', async (_, r) => {
    h.sso = ON;
    replies = [r(), r()];
    await expect(api.getMe()).rejects.toThrow();
    expect(h.revokedWith).toEqual([]);
  });

  it('without the shared sign-in, a session_revoked is a sign-in as before, with nothing revoked', async () => {
    replies = [revokedReply(), revokedReply()];
    await expect(api.getMe()).rejects.toThrow();
    expect(h.revokedWith).toEqual([]);
  });
});

describe('step 1, once a page load', () => {
  it("after the first good call, with that call's token, not waited for, and never again", async () => {
    h.sso = ON;
    replies = [Response.json({ userId: 'u' }), Response.json({ desks: [] })];
    await api.getMe();
    await api.getDesks();
    await settle();
    expect(h.kept).toEqual([[ON.origin, 'access-1']]);
  });

  it('a 304 is a good call; a refused one is not', async () => {
    h.sso = ON;
    replies = [Response.json({ error: { code: 'unavailable' } }, { status: 503 }), new Response(null, { status: 304 })];
    await expect(api.getDesks()).rejects.toThrow();
    await settle();
    expect(h.kept).toEqual([]);
    await api.getDesks('"1"');
    await settle();
    expect(h.kept).toEqual([[ON.origin, 'access-2']]);
  });

  it("a sign-in's own token first (keepShared from /auth/callback): the first good call sends nothing more", async () => {
    h.sso = ON;
    const cfg = { api: 'https://api.minimalistalliance.com', auth: { sso: ON } } as unknown as import('./clientConfig').ClientConfig;
    await api.keepShared(cfg, 'access-from-sign-in');
    replies = [Response.json({ userId: 'u' })];
    await api.getMe();
    await settle();
    expect(h.kept).toEqual([[ON.origin, 'access-from-sign-in']]);
  });

  it.each<[string, unknown]>([['absent', undefined], ['true, a boolean', true], ['another site', { origin: 'https://id.evil.example' }]])('with auth.sso %s: nothing goes to id.', async (_, sso) => {
    h.sso = sso;
    replies = [Response.json({ userId: 'u' })];
    await api.getMe();
    await settle();
    expect(h.kept).toEqual([]);
  });
});
