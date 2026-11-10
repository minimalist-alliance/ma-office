import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientConfig } from '../platform/clientConfig';
import { maiaBase, readState } from './gate';

const auth = { domain: '', clientId: '', redirectUri: '', logoutUri: '', scopes: [] };
/** Prod's client-config today: no `maia` block. */
const PROD: ClientConfig = {
  api: 'https://api.minimalistalliance.com',
  auth,
  links: { account: 'https://platform.minimalistalliance.com/account', support: 'https://platform.minimalistalliance.com/support' },
};
const withMaia = (maia: unknown): ClientConfig => ({ ...PROD, maia } as ClientConfig);
const OFFICE = { origin: 'https://office.minimalistalliance.com', hostname: 'office.minimalistalliance.com' };
const HARNESS = { origin: 'http://localhost:4174', hostname: 'localhost' };

describe('maiaBase: whether Maia may load at all', () => {
  it("is null with prod's defaults, whatever the build", () => {
    for (const allowLocal of [false, true]) {
      expect(maiaBase(PROD, OFFICE, allowLocal)).toBeNull();
      expect(maiaBase(PROD, HARNESS, allowLocal)).toBeNull();
    }
    expect(maiaBase(null, OFFICE, false)).toBeNull();
    expect(maiaBase(undefined, OFFICE, false)).toBeNull();
  });

  it('is null for a block it cannot use', () => {
    for (const bad of [null, 'https://x.lambda-url.us-east-1.on.aws/', {}, { url: 42 }, { url: '' }, { url: 'not a url' }, [], true]) {
      expect(maiaBase(withMaia(bad), OFFICE, false)).toBeNull();
    }
  });

  it('takes only https, with no credentials, query or fragment', () => {
    expect(maiaBase(withMaia({ url: 'https://abc123.lambda-url.us-east-1.on.aws/' }), OFFICE, false)).toBe('https://abc123.lambda-url.us-east-1.on.aws');
    expect(maiaBase(withMaia({ url: 'https://abc123.lambda-url.us-east-1.on.aws' }), OFFICE, false)).toBe('https://abc123.lambda-url.us-east-1.on.aws');
    for (const url of [
      'http://abc123.lambda-url.us-east-1.on.aws/',
      'https://user:pw@abc123.lambda-url.us-east-1.on.aws/',
      'https://abc123.lambda-url.us-east-1.on.aws/?x=1',
      'https://abc123.lambda-url.us-east-1.on.aws/#x',
      'javascript:alert(1)',
      'data:text/plain,hi',
      `https://${'a'.repeat(2050)}.example`,
    ]) {
      expect(maiaBase(withMaia({ url }), OFFICE, true)).toBeNull();
    }
  });

  it("takes the harness's own origin only in a build that isn't production", () => {
    const local = withMaia({ url: 'http://localhost:4174' });
    expect(maiaBase(local, HARNESS, true)).toBe('http://localhost:4174');
    expect(maiaBase(local, HARNESS, false)).toBeNull();
    // Never another origin, and never off localhost.
    expect(maiaBase(withMaia({ url: 'http://localhost:9999' }), HARNESS, true)).toBeNull();
    expect(maiaBase(local, { origin: 'http://localhost:4174', hostname: 'office.minimalistalliance.com' }, true)).toBeNull();
  });
});

describe('readState', () => {
  it('reads enabled only as exactly true', () => {
    expect(readState({ enabled: true })?.enabled).toBe(true);
    for (const enabled of [false, 'true', 1, null, undefined]) expect(readState({ enabled })?.enabled).toBe(false);
    expect(readState(null)).toBeNull();
    expect(readState('x')).toBeNull();
  });

  it("takes sleepAfterSec in the setting's range, or the default", () => {
    expect(readState({ enabled: true, animation: { enabled: true, sleepAfterSec: 120 } })?.animation).toEqual({ enabled: true, sleepAfterSec: 120 });
    expect(readState({ enabled: true, animation: { sleepAfterSec: 5 } })?.animation.sleepAfterSec).toBe(300);
    expect(readState({ enabled: true, animation: { sleepAfterSec: 'x' } })?.animation.sleepAfterSec).toBe(300);
    expect(readState({ enabled: true })?.animation).toEqual({ enabled: false, sleepAfterSec: 300 });
  });

  it('reads memory, limits and retention', () => {
    const s = readState({ enabled: true, modelLabel: 'Claude Opus 5.5', limited: 'pool', retentionDays: 30, memory: { enabled: true, maxItems: 50 } });
    expect(s).toMatchObject({ modelLabel: 'Claude Opus 5.5', limited: 'pool', retentionDays: 30, memory: { enabled: true, maxItems: 50 } });
    expect(readState({ enabled: true, limited: 'everyone', memory: 'on' })).toMatchObject({ limited: null, memory: { enabled: false, maxItems: 0 } });
  });

  it('reads free Maia only when active, with a time that parses', () => {
    const until = '2026-11-09T00:00:00.000Z';
    expect(readState({ enabled: true, free: { enabled: true, active: true, until } })?.free).toEqual({ until });
    expect(readState({ enabled: true, free: { enabled: true, active: false, until: null } })?.free).toBeNull();
    expect(readState({ enabled: true, free: { enabled: true, active: true, until: null } })?.free).toBeNull();
    expect(readState({ enabled: true, free: { active: 'yes', until } })?.free).toBeNull();
    expect(readState({ enabled: true })?.free).toBeNull();
  });
});

describe('fetchMaiaState', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('reads any failure as no Maia', async () => {
    vi.doMock('../platform/auth', () => ({ getAccessToken: async () => 'token' }));
    const { fetchMaiaState } = await import('./gate');
    const answers: (() => Promise<Response>)[] = [
      async () => new Response('{"enabled":true}', { status: 500 }),
      async () => new Response('not json', { status: 200 }),
      async () => {
        throw new TypeError('network');
      },
    ];
    for (const answer of answers) {
      vi.stubGlobal('fetch', vi.fn(answer));
      expect(await fetchMaiaState('https://maia.example')).toBeNull();
    }
    const fetch = vi.fn(async () => new Response('{"enabled":true,"modelLabel":"M"}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect((await fetchMaiaState('https://maia.example'))?.enabled).toBe(true);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://maia.example/v1/maia/state');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer token');
    expect(init.credentials).toBe('omit');
  });

  it('refreshes once after a 401, as api does', async () => {
    const tokens: boolean[] = [];
    vi.doMock('../platform/auth', () => ({
      getAccessToken: async (force = false) => {
        tokens.push(force);
        return force ? 'fresh' : 'stale';
      },
    }));
    const { fetchMaiaState } = await import('./gate');
    const fetch = vi.fn(async (_url: string, init: RequestInit) =>
      new Headers(init.headers).get('Authorization') === 'Bearer fresh' ? new Response('{"enabled":true}') : new Response('', { status: 401 }),
    );
    vi.stubGlobal('fetch', fetch);
    expect((await fetchMaiaState('https://maia.example'))?.enabled).toBe(true);
    expect(tokens).toEqual([false, true]);
  });
});
