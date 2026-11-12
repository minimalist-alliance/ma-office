// What each answer from /oauth2/token does to the stored refresh token (contract auth.md section 2.1):
// only `invalid_grant` clears it, and only if it's still what was refused. The Playwright release project
// runs the same code against real IndexedDB and Web Locks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { stored, config } = vi.hoisted(() => ({ stored: { value: null as string | null, onWrite: null as (() => void) | null, outlived: null as string | null, choice: null as string | null, signedInAt: null as number | null }, config: { reachable: true } }));

vi.mock('./clientConfig', () => ({
  loadedConfig: () => null,
  getClientConfig: () => (config.reachable
    ? Promise.resolve({ api: 'https://api.test', auth: { domain: 'https://auth.test', clientId: 'c', redirectUri: '', logoutUri: '', scopes: [] } })
    : Promise.reject(new TypeError('Failed to fetch'))),
}));
vi.mock('./tokenStore', () => ({
  HOLD_MS: { '7d': 1, '1d': 1, browser: 1 },
  outlivedChoice: () => stored.outlived,
  readChoice: () => ({ staySignedIn: stored.choice, staySignedInSince: null }),
  readSignedInAt: () => stored.signedInAt,
  writeSignedInAt: (at: unknown) => {
    if (typeof at === 'number') stored.signedInAt = at;
  },
  readRefreshToken: () => Promise.resolve(stored.value),
  writeRefreshToken: (token: string) => {
    stored.onWrite?.();
    stored.value = token;
    return Promise.resolve();
  },
  clearRefreshToken: () => {
    stored.value = null;
    return Promise.resolve();
  },
  clearRefreshTokenIf: (refused: string) => {
    if (stored.value !== refused) return Promise.resolve(false);
    stored.value = null;
    return Promise.resolve(true);
  },
}));

type Auth = typeof import('./auth');
type ClientConfig = import('./clientConfig').ClientConfig;
type Reply = () => Promise<Response> | Response;

const json = (status: number, body: unknown): Reply => () => new Response(JSON.stringify(body), { status });
const text = (status: number, body: string): Reply => () => new Response(body, { status });
const tokens = (refreshToken: string | null, expiresIn = 3600): Reply => json(200, { access_token: `access-for-${refreshToken}`, expires_in: expiresIn, ...(refreshToken ? { refresh_token: refreshToken } : {}) });
const networkError: Reply = () => Promise.reject(new TypeError('Failed to fetch'));

const INVALID_GRANT = json(400, { error: 'invalid_grant' });
const TRIGGER_FAILED = json(400, { error: 'PreTokenGenerationV2_0 failed with error Internal. Error Code: UserLambdaValidationException; Request ID: 1234' });

let auth: Auth;
let replies: Reply[];
/** The refresh token each POST carried. */
let sent: (string | null)[];
let lockNames: string[];
/** The refresh tokens sent to /oauth2/revoke. */
let revoked: string[];

beforeEach(async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter
  stored.value = 'r1';
  stored.onWrite = null;
  stored.outlived = null;
  stored.choice = null;
  stored.signedInAt = null;
  revoked = [];
  config.reachable = true;
  replies = [];
  sent = [];
  lockNames = [];
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('fetch', (url: string, init: { body: URLSearchParams }) => {
    if (url.endsWith('/oauth2/revoke')) {
      revoked.push(init.body.get('token') ?? '');
      return Promise.resolve(new Response('', { status: 200 }));
    }
    sent.push(init.body.get('refresh_token'));
    const next = replies.shift();
    if (!next) throw new Error('a POST nobody expected');
    return next();
  });
  vi.resetModules();
  auth = await import('./auth');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe('a refresh that fails', () => {
  it.each<[string, Reply]>([
    ['a failed pre-token trigger: 400 with free text in error', TRIGGER_FAILED],
    ['a 5xx', json(503, { message: 'Service Unavailable' })],
    ['401 invalid_client', json(401, { error: 'invalid_client' })],
    ['another 4xx error', json(400, { error: 'invalid_request' })],
    ['a non-JSON 400', text(400, '<html>Bad Request</html>')],
    ['an empty 400', text(400, '')],
    ['JSON that is not an object', json(400, ['invalid_grant'])],
    ['invalid_grant only in the text of another field', json(400, { error: 'server_error', error_description: 'invalid_grant' })],
    ['invalid_grant inside a longer error', json(400, { error: 'PreTokenGenerationV2_0 failed: invalid_grant' })],
    ['a network error', networkError],
    ['a 200 with no tokens', json(200, {})],
    ['a 200 that is not JSON', text(200, 'ok')],
  ])('keeps the token and stays signed in on %s', async (_name, reply) => {
    replies = [reply];
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.RefreshUnavailable);
    expect(stored.value).toBe('r1');
    expect(await auth.hasStoredSession()).toBe(true);
  });

  it('keeps the token on a timeout, and lets go of the lock', async () => {
    let aborted = false;
    vi.stubGlobal('fetch', (_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('Aborted', 'AbortError'));
      });
    }));
    const result = auth.getAccessToken().catch((err: unknown) => err);
    await settle(14_999);
    expect(aborted).toBe(false);
    await settle(1);
    expect(await result).toBeInstanceOf(auth.RefreshUnavailable);
    expect(stored.value).toBe('r1');
  });

  it('counts a body that never finishes toward the timeout', async () => {
    vi.stubGlobal('fetch', (_url: string, init: { signal: AbortSignal }) => Promise.resolve({
      ok: true,
      status: 200,
      text: () => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))),
    }));
    const result = auth.getAccessToken().catch((err: unknown) => err);
    await settle(15_000);
    expect(await result).toBeInstanceOf(auth.RefreshUnavailable);
    expect(stored.value).toBe('r1');
  });

  it("keeps the token when client-config can't be reached", async () => {
    config.reachable = false;
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.RefreshUnavailable);
    expect(stored.value).toBe('r1');
    expect(sent).toEqual([]);
  });

  it('never gives out an expired access token, and asks no more until the backoff is up', async () => {
    replies = [tokens('r2', 301)];
    await auth.getAccessToken();
    await settle(301_000);
    replies = [TRIGGER_FAILED];
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.RefreshUnavailable);
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.RefreshUnavailable);
    await expect(auth.getAccessToken(true)).rejects.toBeInstanceOf(auth.RefreshUnavailable);
    expect(sent).toEqual(['r1', 'r2']);
  });

  it('backs off 2, 4, 8, 16, then 30 s for good, and a good answer starts over', async () => {
    const waited: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const before = sent.length;
      let ms = 0;
      replies = [TRIGGER_FAILED];
      await auth.getAccessToken().catch(() => undefined);
      while (sent.length === before) {
        ms += 1000;
        await settle(1000);
        replies = [TRIGGER_FAILED];
        await auth.getAccessToken().catch(() => undefined);
      }
      waited.push(ms);
    }
    expect(waited).toEqual([0, 2000, 4000, 8000, 16_000, 30_000, 30_000]);

    await settle(30_000);
    replies = [tokens('r2', 1)];
    await auth.getAccessToken();
    await settle(1000);
    replies = [TRIGGER_FAILED];
    await auth.getAccessToken().catch(() => undefined);
    await settle(2000);
    replies = [tokens('r3')];
    await expect(auth.getAccessToken()).resolves.toBe('access-for-r3');
  });

  it('shares one request among everyone asking', async () => {
    replies = [TRIGGER_FAILED];
    const all = await Promise.allSettled([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
    expect(all.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(sent).toEqual(['r1']);
  });

  it('recovers with the token it kept, and stores the new one', async () => {
    replies = [TRIGGER_FAILED];
    await auth.getAccessToken().catch(() => undefined);
    await settle(2000);
    replies = [tokens('r2')];
    await expect(auth.getAccessToken()).resolves.toBe('access-for-r2');
    expect(sent).toEqual(['r1', 'r1']);
    expect(stored.value).toBe('r2');
  });

  it('tries straight away once told the network is back, without resetting the backoff', async () => {
    replies = [TRIGGER_FAILED];
    await auth.getAccessToken().catch(() => undefined);
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.RefreshUnavailable);
    expect(sent).toHaveLength(1);
    auth.retryRefreshNow();
    replies = [TRIGGER_FAILED];
    await auth.getAccessToken().catch(() => undefined);
    expect(sent).toHaveLength(2);
    await settle(3000); // the second failure waits 4 s, not 2
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.RefreshUnavailable);
    expect(sent).toHaveLength(2);
  });

  it('uses the access token it holds while that still works, but not after a 401', async () => {
    replies = [tokens('r2', 200)]; // inside the 5 minute margin, so every call tries to refresh
    await expect(auth.getAccessToken()).resolves.toBe('access-for-r2');
    replies = [TRIGGER_FAILED];
    await expect(auth.getAccessToken()).resolves.toBe('access-for-r2');
    expect(sent).toEqual(['r1', 'r2']);
    await expect(auth.getAccessToken()).resolves.toBe('access-for-r2'); // in the backoff: no request, no wait
    expect(sent).toHaveLength(2);
    await expect(auth.getAccessToken(true)).rejects.toBeInstanceOf(auth.RefreshUnavailable);
    await settle(200_000);
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.RefreshUnavailable);
  });
});

describe('invalid_grant', () => {
  it('clears the token and ends the session', async () => {
    replies = [INVALID_GRANT];
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.SignInRequired);
    expect(stored.value).toBeNull();
    expect(await auth.hasStoredSession()).toBe(false);
  });

  it('works whatever the status, since the body decides', async () => {
    replies = [json(401, { error: 'invalid_grant' })];
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.SignInRequired);
    expect(stored.value).toBeNull();
  });

  it('ends a session whose access token was still valid when the API said 401', async () => {
    replies = [tokens('r2')];
    await auth.getAccessToken();
    replies = [INVALID_GRANT];
    await expect(auth.getAccessToken(true)).rejects.toBeInstanceOf(auth.SignInRequired);
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.SignInRequired);
    expect(await auth.hasStoredSession()).toBe(false);
  });

  it('still ends the session after a run of passing failures', async () => {
    replies = [TRIGGER_FAILED];
    await auth.getAccessToken().catch(() => undefined);
    await settle(2000);
    replies = [INVALID_GRANT];
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.SignInRequired);
    expect(stored.value).toBeNull();
  });

  it('with nothing stored, there is no session and no request', async () => {
    stored.value = null;
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.SignInRequired);
    expect(sent).toEqual([]);
  });
});

describe('ma_session_ended: a refresh past the member\'s "Stay signed in" (contract auth.md section 3.3)', () => {
  const ENDED = json(400, { error: 'PreTokenGenerationV2_0 failed with error ma_session_ended. Error Code: UserLambdaValidationException; Request ID: 1234' });

  it('revokes the token, clears it and ends the session, as invalid_grant does, with no retry', async () => {
    replies = [ENDED];
    stored.choice = '7d';
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.SignInRequired);
    expect(revoked).toEqual(['r1']);
    expect(auth.takeEndedChoice()).toBe('ended-7d');
    expect(auth.takeEndedChoice()).toBeNull();
    expect(stored.value).toBeNull();
    expect(auth.sessionWasRefused()).toBe(true);
    expect(await auth.hasStoredSession()).toBe(false);
    await settle(60_000);
    expect(sent).toEqual(['r1']);
  });

  it('matches the word, whatever Cognito says around it', async () => {
    replies = [json(400, { error: 'Something else entirely: ma_session_ended' })];
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.SignInRequired);
    expect(stored.value).toBeNull();
  });

  it('invalid_grant clears without a revoke or a reason', async () => {
    replies = [INVALID_GRANT];
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.SignInRequired);
    expect([revoked, auth.takeEndedChoice()]).toEqual([[], null]);
  });

  it('any other failed trigger still keeps the token', async () => {
    replies = [TRIGGER_FAILED];
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.RefreshUnavailable);
    expect(stored.value).toBe('r1');
  });
});

describe('a token stored while a refresh was out', () => {
  it('is not overwritten by that answer: it reads again, and refreshes the newer one', async () => {
    replies = [() => {
      stored.value = 'from-a-sign-in';
      return tokens('old-session')();
    }, tokens('r3')];
    await expect(auth.getAccessToken()).resolves.toBe('access-for-r3');
    expect(sent).toEqual(['r1', 'from-a-sign-in']);
    expect(stored.value).toBe('r3');
  });

  it('a sign-out in another tab stays signed out, and that isn\'t a refused session', async () => {
    replies = [() => {
      stored.value = null;
      return tokens('old-session')();
    }];
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.SignInRequired);
    expect(stored.value).toBeNull();
    expect(auth.sessionWasRefused()).toBe(false);
  });

  it('a store that won\'t settle gives up for now, and keeps what\'s there', async () => {
    const changing = (next: string): Reply => () => {
      stored.value = next;
      return tokens('old-session')();
    };
    replies = [changing('a'), changing('b'), changing('c')];
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.RefreshUnavailable);
    expect(stored.value).toBe('c');
  });
});

describe('finishSignIn', () => {
  it('stores the new session under ma-refresh, so a refresh on its way in another tab can\'t land after it', async () => {
    const claims = btoa(JSON.stringify({ nonce: 'n' }));
    let held = false;
    const heldAtWrite: boolean[] = [];
    stored.onWrite = () => heldAtWrite.push(held);
    vi.stubGlobal('sessionStorage', { getItem: () => JSON.stringify({ state: 's', nonce: 'n', verifier: 'v' }), removeItem: () => undefined });
    vi.stubGlobal('navigator', {
      locks: {
        request: async (name: string, fn: () => Promise<unknown>) => {
          lockNames.push(name);
          held = true;
          try {
            return await fn();
          } finally {
            held = false;
          }
        },
      },
    });
    replies = [json(200, { access_token: 'access-for-sign-in', id_token: `x.${claims}.y`, refresh_token: 'from-a-sign-in', expires_in: 3600 })];
    await auth.finishSignIn('?code=c&state=s');
    expect(lockNames).toEqual(['ma-refresh']);
    expect(heldAtWrite).toEqual([true]);
    expect(held).toBe(false);
    expect(stored.value).toBe('from-a-sign-in');
    await expect(auth.getAccessToken()).resolves.toBe('access-for-sign-in');
    expect(lockNames).toEqual(['ma-refresh']); // that one needed no refresh
  });
});

/**
 * ISS-68 (as `ma-platform`'s Platform app): signing in again over a stored session revokes the refresh token it replaced
 * at Cognito, as sign-out does. Only once the new one is stored, never the new one, and nothing about the sign-in waits
 * on it or fails with it.
 */
describe('finishSignIn over a stored session', () => {
  const idWith = (nonce: string) => `x.${btoa(JSON.stringify({ nonce, sub: 'm' })).replace(/=+$/, '')}.y`;
  const exchange = (refreshToken: string | null, nonce = 'n'): Reply =>
    json(200, { access_token: 'access-for-sign-in', id_token: idWith(nonce), expires_in: 3600, ...(refreshToken ? { refresh_token: refreshToken } : {}) });
  /** Each revoke sent: its token, what was stored as it went out, and whether ma-refresh was held. */
  let atRevoke: { token: string; stored: string | null; locked: boolean }[];
  let locked: boolean;
  let revokeReply: Reply;

  beforeEach(() => {
    atRevoke = [];
    locked = false;
    revokeReply = text(200, '');
    vi.stubGlobal('sessionStorage', { getItem: () => JSON.stringify({ state: 's', nonce: 'n', verifier: 'v' }), removeItem: () => undefined });
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_name: string, fn: () => Promise<unknown>) => {
          locked = true;
          try {
            return await fn();
          } finally {
            locked = false;
          }
        },
      },
    });
    vi.stubGlobal('fetch', (url: string, init: { body: URLSearchParams }) => {
      if (url.endsWith('/oauth2/revoke')) {
        atRevoke.push({ token: init.body.get('token') ?? '', stored: stored.value, locked });
        return Promise.resolve().then(revokeReply);
      }
      sent.push(init.body.get('refresh_token'));
      const next = replies.shift();
      if (!next) throw new Error('a POST nobody expected');
      return next();
    });
  });
  const finish = () => auth.finishSignIn('?code=c&state=s');

  it('revokes the old refresh token once the new one is stored, outside the lock', async () => {
    replies = [exchange('r2')];
    await finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(stored.value).toBe('r2');
    expect(atRevoke).toEqual([{ token: 'r1', stored: 'r2', locked: false }]);
    expect(sent).toEqual([null]); // the code exchange alone: nothing refreshed with the old token
    await expect(auth.getAccessToken()).resolves.toBe('access-for-sign-in');
  });

  it.each<[string, Reply]>([
    ['a network error', networkError],
    ['a 400', json(400, { error: 'unsupported_token_type' })],
    ['a 503', text(503, '')],
  ])('a revoke that fails (%s) changes nothing about the sign-in, and is not tried again', async (_name, reply) => {
    revokeReply = reply;
    replies = [exchange('r2')];
    await expect(finish()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(atRevoke.map((r) => r.token)).toEqual(['r1']);
    expect(stored.value).toBe('r2');
    await expect(auth.getAccessToken()).resolves.toBe('access-for-sign-in');
    expect(sent).toEqual([null]);
  });

  it('a revoke that never answers holds nothing up', async () => {
    revokeReply = () => new Promise<Response>(() => undefined);
    replies = [exchange('r2')];
    // No timer moves: the sign-in finishes without waiting for the revoke's SIGN_OUT_WAIT_MS.
    await expect(finish()).resolves.toBeUndefined();
    expect(atRevoke.map((r) => r.token)).toEqual(['r1']);
    expect(stored.value).toBe('r2');
  });

  it('never revokes the token it was just given, when Cognito hands back the same one', async () => {
    replies = [exchange('r1')];
    await finish();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(atRevoke).toEqual([]);
    expect(stored.value).toBe('r1');
  });

  it('a first sign-in, with nothing stored, revokes nothing', async () => {
    stored.value = null;
    replies = [exchange('r2')];
    await finish();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(atRevoke).toEqual([]);
    expect(stored.value).toBe('r2');
  });

  it.each<[string, Reply]>([
    ['a refused code exchange', INVALID_GRANT],
    ["an ID token for another browser's sign-in", exchange('r2', 'other')],
  ])('a sign-in that fails (%s) revokes nothing and keeps the old session', async (_name, reply) => {
    replies = [reply];
    await expect(finish()).rejects.toBeInstanceOf(auth.SignInRequired);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(atRevoke).toEqual([]);
    expect(stored.value).toBe('r1');
  });

  it('a new token the browser refuses to store fails the sign-in as before, and the old one is kept, unrevoked', async () => {
    stored.onWrite = () => {
      throw new Error('localStorage refused the token');
    };
    replies = [exchange('r2')];
    await expect(finish()).rejects.toThrow('refused');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(atRevoke).toEqual([]);
    expect(stored.value).toBe('r1');
  });

  it('an exchange that brings no refresh token leaves the stored one in place, unrevoked', async () => {
    replies = [exchange(null)];
    await finish();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(atRevoke).toEqual([]);
    expect(stored.value).toBe('r1');
  });
});

describe('sessionWasRefused: the session is really dead, not just asking for a sign-in', () => {
  it('is false until this tab has a token refused, and then true, even for a caller who only finds no token', async () => {
    expect(auth.sessionWasRefused()).toBe(false);
    replies = [INVALID_GRANT];
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.SignInRequired);
    expect(auth.sessionWasRefused()).toBe(true);
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.SignInRequired); // no request: what a link leaves for the poll
    expect(auth.sessionWasRefused()).toBe(true);
  });

  it('is false with no token to send, as after a sign-out in another tab', async () => {
    stored.value = null;
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.SignInRequired);
    expect(auth.sessionWasRefused()).toBe(false);
  });

  it('is false for anything that keeps the token', async () => {
    for (const reply of [TRIGGER_FAILED, json(503, {}), json(401, { error: 'invalid_client' }), text(400, '<html>'), networkError]) {
      auth.retryRefreshNow();
      replies = [reply];
      await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.RefreshUnavailable);
      expect(auth.sessionWasRefused()).toBe(false);
    }
    expect(stored.value).toBe('r1');
  });

  it('is false when what was refused had been rotated away, and the newer token works', async () => {
    replies = [() => {
      stored.value = 'newer';
      return INVALID_GRANT();
    }, tokens('r3')];
    await expect(auth.getAccessToken()).resolves.toBe('access-for-r3');
    expect(auth.sessionWasRefused()).toBe(false);
  });

  it('ends when a refresh works again, after a sign-in in another tab', async () => {
    replies = [INVALID_GRANT];
    await auth.getAccessToken().catch(() => undefined);
    expect(auth.sessionWasRefused()).toBe(true);
    stored.value = 'from-another-tab';
    replies = [tokens('r2')];
    await expect(auth.getAccessToken()).resolves.toBe('access-for-r2');
    expect(auth.sessionWasRefused()).toBe(false);
  });
});

describe('whose tokens these are', () => {
  /** A token reply whose access token says whose it is, as Cognito's does. */
  const tokensOf = (sub: string, refreshToken: string): Reply =>
    json(200, { access_token: `h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.s`, expires_in: 3600, refresh_token: refreshToken });

  it('says who, the first time and whenever a refresh brings someone else, as after a sign-in in another tab', async () => {
    const seen: [string, string | null][] = [];
    auth.onMemberChange((sub, before) => seen.push([sub, before]));
    replies = [tokensOf('u-member-A', 'r2')];
    await expect(auth.currentMember()).resolves.toBe('u-member-A');
    replies = [tokensOf('u-member-A', 'r3')];
    await auth.getAccessToken(true);
    expect(seen).toEqual([['u-member-A', null]]);
    stored.value = 'from-another-tab'; // B signed in there
    replies = [tokensOf('u-member-B', 'r4')];
    await auth.getAccessToken(true);
    expect(seen).toEqual([
      ['u-member-A', null],
      ['u-member-B', 'u-member-A'],
    ]);
    await expect(auth.currentMember()).resolves.toBe('u-member-B');
  });
});

describe('ownSignInPath', () => {
  const cfg = (signInPath?: string): ClientConfig => ({ api: '', auth: { domain: '', clientId: '', redirectUri: '', logoutUri: '', scopes: [], ...(signInPath ? { signInPath } : {}) } });
  const at = (pathname: string) => ({ origin: 'https://office.minimalistalliance.com', hostname: 'office.minimalistalliance.com', pathname });

  it('absent, or a setting that can\'t be used, means managed login', () => {
    expect(auth.ownSignInPath(cfg(), at('/'))).toBeNull();
    expect(auth.ownSignInPath(cfg('https://evil.example/'), at('/'))).toBeNull();
    expect(auth.ownSignInPath(cfg('//evil.example/'), at('/'))).toBeNull();
  });

  it('with a path, being there already means the route is missing, so managed login', () => {
    expect(auth.ownSignInPath(cfg('/_signin/'), at('/'))).toBe('/_signin/');
    expect(auth.ownSignInPath(cfg('/_signin/'), at('/_signin/'))).toBeNull();
  });

  it('with an address on another site, this app is never there, whatever its path is', () => {
    const id = 'https://id.minimalistalliance.com/_signin/';
    expect(auth.ownSignInPath(cfg(id), at('/'))).toBe(id);
    expect(auth.ownSignInPath(cfg(id), at('/_signin/'))).toBe(id);
    expect(auth.ownSignInPath(cfg('https://id.minimalistalliance.com/'), at('/anything'))).toBe('https://id.minimalistalliance.com/');
  });
});

describe('a token another tab rotated away', () => {
  /** Answers invalid_grant, having let another tab store `newer` while the request was on its way. */
  const rotatedBy = (newer: string | null): Reply => () => {
    stored.value = newer;
    return INVALID_GRANT();
  };

  it('does not clear the newer token, and uses it', async () => {
    replies = [rotatedBy('r2'), tokens('r3')];
    await expect(auth.getAccessToken()).resolves.toBe('access-for-r3');
    expect(sent).toEqual(['r1', 'r2']);
    expect(stored.value).toBe('r3');
  });

  it('clears the newer token too if that is refused and nothing has changed since', async () => {
    replies = [rotatedBy('r2'), INVALID_GRANT];
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.SignInRequired);
    expect(sent).toEqual(['r1', 'r2']);
    expect(stored.value).toBeNull();
  });

  it('keeps the newer token if that fails for a passing reason', async () => {
    replies = [rotatedBy('r2'), TRIGGER_FAILED];
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.RefreshUnavailable);
    expect(stored.value).toBe('r2');
  });

  it('ends the session if the other tab signed out, with no more requests', async () => {
    replies = [rotatedBy(null)];
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.SignInRequired);
    expect(sent).toEqual(['r1']);
  });

  it('gives up for now, keeping what is stored, if the token never settles', async () => {
    replies = [rotatedBy('r2'), rotatedBy('r3'), rotatedBy('r4')];
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.RefreshUnavailable);
    expect(sent).toEqual(['r1', 'r2', 'r3']);
    expect(stored.value).toBe('r4');
  });
});

describe('the lock', () => {
  it('holds ma-refresh around the read and the request', async () => {
    let held = false;
    vi.stubGlobal('navigator', {
      locks: {
        request: async (name: string, fn: () => Promise<unknown>) => {
          lockNames.push(name);
          held = true;
          try {
            return await fn();
          } finally {
            held = false;
          }
        },
      },
    });
    replies = [() => {
      expect(held).toBe(true);
      return tokens('r2')();
    }];
    await auth.getAccessToken();
    expect(lockNames).toEqual(['ma-refresh']);
    expect(held).toBe(false);
  });
});

describe('endSession: the revoke is read to the end, then the logout (Platform\'s sign-out fix)', () => {
  const cfg = { api: 'https://api.test', auth: { domain: 'https://auth.test', clientId: 'c', redirectUri: '', logoutUri: 'https://app.test/signed-out', scopes: [] } } as unknown as ClientConfig;
  let left: string[];
  let revokes: { url: string; keepalive: boolean | undefined; token: string | null }[];

  beforeEach(() => {
    left = [];
    revokes = [];
    vi.stubGlobal('window', { location: { assign: (url: string) => left.push(url) } });
  });
  const revokeAnswers = (reply: () => Promise<Response>): void => {
    vi.stubGlobal('fetch', (url: string, init: { keepalive?: boolean; body: URLSearchParams }) => {
      revokes.push({ url, keepalive: init.keepalive, token: init.body.get('token') });
      return reply();
    });
  };

  it('waits for the whole answer, not just its headers, and sends it keepalive', async () => {
    let finish: () => void = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(' ')); // the headers and a first byte
        finish = () => {
          c.enqueue(new TextEncoder().encode('{}'));
          c.close();
        };
      },
    });
    revokeAnswers(() => Promise.resolve(new Response(body, { status: 200 })));
    const done = auth.endSession(cfg);
    await settle(1_000);
    expect(revokes).toEqual([{ url: 'https://auth.test/oauth2/revoke', keepalive: true, token: 'r1' }]);
    expect(stored.value).toBeNull();
    expect(left).toEqual([]); // leaving now is what cut the revoke off
    finish();
    await done;
    expect(left).toEqual(['https://auth.test/logout?client_id=c&logout_uri=https%3A%2F%2Fapp.test%2Fsigned-out']);
  });

  it('a revoke that never answers holds the sign-out for SIGN_OUT_WAIT_MS, and no longer', async () => {
    revokeAnswers(() => new Promise<Response>(() => {}));
    const done = auth.endSession(cfg);
    await settle(auth.SIGN_OUT_WAIT_MS - 1);
    expect(left).toEqual([]);
    await settle(1);
    await done;
    expect(left).toHaveLength(1);
  });

  it('a revoke that fails goes straight on to the logout', async () => {
    revokeAnswers(() => Promise.reject(new TypeError('Failed to fetch')));
    await auth.endSession(cfg);
    expect(left).toHaveLength(1);
    expect(stored.value).toBeNull();
  });

  it('with no token stored, nothing to revoke: straight to the logout', async () => {
    stored.value = null;
    revokeAnswers(() => Promise.reject(new Error('a revoke nobody expected')));
    await auth.endSession(cfg);
    expect(revokes).toEqual([]);
    expect(left).toHaveLength(1);
  });

  it('forAtMost never throws and never waits past SIGN_OUT_WAIT_MS', async () => {
    await expect(auth.forAtMost(Promise.reject(new Error('no')))).resolves.toBeUndefined();
    let over = false;
    void auth.forAtMost(new Promise(() => {})).then(() => {
      over = true;
    });
    await settle(auth.SIGN_OUT_WAIT_MS);
    expect(over).toBe(true);
  });

  // "Sign out everywhere" goes on only with a yes: a refusal and silence are both no, and it never throws.
  it('answeredWithin is true only for a call that settles well in time', async () => {
    await expect(auth.answeredWithin(Promise.resolve(), auth.EVERYWHERE_WAIT_MS)).resolves.toBe(true);
    await expect(auth.answeredWithin(Promise.reject(new Error('503')), auth.EVERYWHERE_WAIT_MS)).resolves.toBe(false);
    let answer: boolean | null = null;
    void auth.answeredWithin(new Promise(() => {}), auth.EVERYWHERE_WAIT_MS).then((ok) => {
      answer = ok;
    });
    await settle(auth.EVERYWHERE_WAIT_MS - 1_000);
    expect(answer).toBeNull();
    await settle(1_000);
    expect(answer).toBe(false);
  });
});

describe('the member\'s own session length, held in this browser (contract auth.md section 3.3, item 2)', () => {
  it('past the choice: no refresh is sent, the token is revoked and cleared, and the reason is kept for the sign-in screen', async () => {
    stored.outlived = '1d';
    replies = [];
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(auth.SignInRequired);
    expect(sent).toEqual([]);
    expect(revoked).toEqual(['r1']);
    expect(stored.value).toBeNull();
    expect(auth.takeEndedChoice()).toBe('ended-1d');
  });

  it('inside the choice, or with none to hold, refreshes as usual', async () => {
    replies = [tokens('r2')];
    await expect(auth.getAccessToken()).resolves.toBe('access-for-r2');
    expect(revoked).toEqual([]);
  });

  it('a refresh fills signedInAt in only when it was never kept', async () => {
    const idToken = (at: number) => `h.${btoa(JSON.stringify({ auth_time: at, sub: 's' }))}.s`;
    replies = [json(200, { access_token: 'a', expires_in: 3600, refresh_token: 'r2', id_token: idToken(1000) })];
    await auth.getAccessToken(true);
    expect(stored.signedInAt).toBe(1000);
    replies = [json(200, { access_token: 'b', expires_in: 3600, refresh_token: 'r3', id_token: idToken(2000) })];
    await auth.getAccessToken(true);
    expect(stored.signedInAt).toBe(1000);
  });
});
