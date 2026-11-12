// The landing's signed-in cookie (signedInCookie.ts): ma-platform packages/signed-in-kit's exact strings, nothing without the key,
// and only with the client-config this page has loaded, never a request for it. tests/e2e/signedInCookie.shell.spec.ts runs it in
// a real browser.
import { afterEach, describe, expect, it, vi } from 'vitest';

const PROD = { signedInCookie: { name: 'ma_signed_in', domain: 'minimalistalliance.com' } };
const SET = (age: number | null): string => `ma_signed_in=1; Domain=minimalistalliance.com; Path=/; ${age === null ? '' : `Max-Age=${age}; `}Secure; SameSite=Lax`;
const CLEAR = 'ma_signed_in=; Domain=minimalistalliance.com; Path=/; Max-Age=0; Secure; SameSite=Lax';

function recorder(): { writes: string[]; doc: { cookie: string } } {
  const writes: string[] = [];
  return { writes, doc: { set cookie(v: string) { writes.push(v); }, get cookie() { return ''; } } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('./clientConfig');
  vi.resetModules();
});

describe('the strings', () => {
  it('set: value 1, the domain from client-config, Path, Secure, SameSite=Lax, never HttpOnly, Max-Age per choice', async () => {
    const { signedInCookie } = await import('./signedInCookie');
    expect(signedInCookie(PROD, '30d')).toBe(SET(2_592_000));
    expect(signedInCookie(PROD, '7d')).toBe(SET(604_800));
    expect(signedInCookie(PROD, '1d')).toBe(SET(86_400));
    expect(signedInCookie(PROD, 'browser')).toBe(SET(null));
    for (const unknown of [null, undefined, '', '90d', 'toString', '__proto__', 30]) expect(signedInCookie(PROD, unknown)).toBe(SET(2_592_000));
  });

  it('clear: the same name, domain, path and flags, Max-Age=0', async () => {
    const { signedOutCookie } = await import('./signedInCookie');
    expect(signedOutCookie(PROD)).toBe(CLEAR);
  });

  it('the key absent, or not a plain name and host name: nothing written', async () => {
    const { clearSignedIn, setSignedIn } = await import('./signedInCookie');
    const { writes, doc } = recorder();
    const bad = [
      undefined,
      {},
      { signedInCookie: null },
      { signedInCookie: { name: 'ma_signed_in', domain: 'minimalistalliance.com; Max-Age=999999999' } },
      { signedInCookie: { name: 'ma_signed_in; Domain=evil.example', domain: 'minimalistalliance.com' } },
      { signedInCookie: { name: 'ma_signed_in', domain: '.minimalistalliance.com' } },
      { signedInCookie: { name: 'ma_signed_in' } },
    ];
    for (const config of bad) {
      expect(setSignedIn(config, '30d', doc)).toBe(false);
      expect(clearSignedIn(config, doc)).toBe(false);
    }
    expect(writes).toEqual([]);
  });

  it('cookies blocked: never throws', async () => {
    const { clearSignedIn, setSignedIn } = await import('./signedInCookie');
    const blocked = { set cookie(_v: string) { throw new Error('SecurityError'); }, get cookie() { return ''; } };
    expect(setSignedIn(PROD, '30d', blocked)).toBe(false);
    expect(clearSignedIn(PROD, blocked)).toBe(false);
  });
});

describe('keepSignedIn and endSignedIn', () => {
  let asked = 0;

  async function load(loaded: unknown) {
    const { writes, doc } = recorder();
    asked = 0;
    vi.stubGlobal('document', doc);
    vi.doMock('./clientConfig', () => ({
      loadedConfig: () => loaded,
      getClientConfig: () => {
        asked += 1;
        return Promise.resolve(loaded);
      },
    }));
    return { writes, ...(await import('./signedInCookie')) };
  }

  it('sets for the choice and clears, with the client-config this page loaded', async () => {
    const { writes, keepSignedIn, endSignedIn } = await load(PROD);
    keepSignedIn('7d');
    endSignedIn();
    expect(writes).toEqual([SET(604_800), CLEAR]);
  });

  it('a client-config handed in is used as it is', async () => {
    const { writes, keepSignedIn, endSignedIn } = await load(null);
    keepSignedIn('1d', PROD as never);
    endSignedIn(PROD as never);
    expect(writes).toEqual([SET(86_400), CLEAR]);
  });

  it('no client-config loaded: nothing written, and it is never asked for', async () => {
    const { writes, keepSignedIn, endSignedIn } = await load(null);
    keepSignedIn('7d');
    endSignedIn();
    await new Promise((r) => setTimeout(r, 10));
    expect(writes).toEqual([]);
    expect(asked).toBe(0);
  });

  it('client-config without the key: nothing at all', async () => {
    const { writes, keepSignedIn, endSignedIn } = await load({ auth: {} });
    keepSignedIn('30d');
    endSignedIn();
    expect(writes).toEqual([]);
  });
});
