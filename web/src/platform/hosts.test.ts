import { describe, expect, it } from 'vitest';
import { apiBaseFor, siblingUrl, ssoOrigin } from './hosts';

describe('apiBaseFor', () => {
  it.each([
    ['office.minimalistalliance.com', 'https://api.minimalistalliance.com'],
    ['office.staging.minimalistalliance.com', 'https://api.staging.minimalistalliance.com'],
    ['test.office.staging.minimalistalliance.com', 'https://api.staging.minimalistalliance.com'],
  ])('%s', (host, api) => {
    expect(apiBaseFor(host)).toBe(api);
  });

  it('runs local development against staging', () => {
    expect(apiBaseFor('localhost')).toBe('https://api.staging.minimalistalliance.com');
    expect(apiBaseFor('127.0.0.1')).toBe('https://api.staging.minimalistalliance.com');
  });

  it('takes the harness override only on localhost', () => {
    expect(apiBaseFor('localhost', 'http://localhost:4173')).toBe('http://localhost:4173');
    expect(apiBaseFor('office.minimalistalliance.com', 'https://evil.example')).toBe('https://api.minimalistalliance.com');
  });

  it.each(['desk.minimalistalliance.com', 'desk.staging.minimalistalliance.com', 'test.desk.staging.minimalistalliance.com', 'someone.office.minimalistalliance.com', 'someone.desk.minimalistalliance.com', 'some-member.office.minimalistalliance.com', 'test.office.minimalistalliance.com', 'minimalistalliance.com', 'platform.minimalistalliance.com', 'desk.minimalistalliance.com.evil.example', 'evil-desk.minimalistalliance.com', 'a.b.desk.minimalistalliance.com'])(
    'refuses %s',
    (host) => {
      expect(apiBaseFor(host)).toBeNull();
    },
  );
});

describe('siblingUrl', () => {
  it.each([
    ['https://platform.minimalistalliance.com/account', 'office.minimalistalliance.com'],
    ['https://id.minimalistalliance.com/', 'office.minimalistalliance.com'],
    ['https://platform.staging.minimalistalliance.com/account', 'office.staging.minimalistalliance.com'],
    ['https://platform.staging.minimalistalliance.com/account', 'test.office.staging.minimalistalliance.com'],
    ['https://platform.localhost/account', 'localhost'],
  ])('%s is a sibling of %s', (raw, host) => {
    expect(siblingUrl(raw, host)?.href).toBe(raw);
  });

  it.each([
    [null], [undefined], [42], [''], ['/account'], ['not a url'], ['javascript:alert(1)'],
    ['http://platform.minimalistalliance.com/account'],
    ['https://evil.example/account'], ['https://platform.minimalistalliance.com.evil.example/account'], ['https://evil-minimalistalliance.com/account'],
    ['https://minimalistalliance.com/account'], ['https://a.platform.minimalistalliance.com/account'],
    ['https://platform.minimalistalliance.com:8443/account'], ['https://u:p@platform.minimalistalliance.com/account'],
    ['https://platform.staging.minimalistalliance.com/account'], // staging, from prod
    // This app, by any of its names: going there could never end.
    ['https://office.minimalistalliance.com/account'], ['https://desk.minimalistalliance.com/account'],
  ])('%s is not, from prod', (raw) => {
    expect(siblingUrl(raw, 'office.minimalistalliance.com')).toBeNull();
  });

  it('refuses prod hosts from staging, this app from its test host, and anything on a host that is not this app', () => {
    expect(siblingUrl('https://platform.minimalistalliance.com/account', 'office.staging.minimalistalliance.com')).toBeNull();
    expect(siblingUrl('https://office.staging.minimalistalliance.com/account', 'test.office.staging.minimalistalliance.com')).toBeNull();
    expect(siblingUrl('https://test.office.staging.minimalistalliance.com/account', 'office.staging.minimalistalliance.com')).toBeNull();
    expect(siblingUrl('https://platform.minimalistalliance.com/account', 'evil.example')).toBeNull();
    expect(siblingUrl('https://platform.minimalistalliance.com/account', '127.0.0.1')).toBeNull();
  });
});

describe('ssoOrigin: the shared sign-in, on only for an object with an https origin at id. on this site (ma-platform contract auth.md §2.8)', () => {
  const cfg = (sso: unknown) => ({ auth: { sso } });

  it.each([
    ['https://id.minimalistalliance.com', 'office.minimalistalliance.com'],
    ['https://id.staging.minimalistalliance.com', 'office.staging.minimalistalliance.com'],
    ['https://id.staging.minimalistalliance.com', 'test.office.staging.minimalistalliance.com'],
    ['https://id.localhost', 'localhost'],
  ])('%s from %s', (origin, host) => {
    expect(ssoOrigin(cfg({ origin }), host)).toBe(origin);
  });

  it('takes the object as Platform sends it, with whatever else it may carry one day', () => {
    expect(ssoOrigin(cfg({ origin: 'https://id.minimalistalliance.com', more: 1 }), 'office.minimalistalliance.com')).toBe('https://id.minimalistalliance.com');
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['true, a boolean', true],
    ['a string', 'https://id.minimalistalliance.com'],
    ['an array', ['https://id.minimalistalliance.com']],
    ['an empty object', {}],
    ['an origin that is not a string', { origin: 42 }],
    ['an empty origin', { origin: '' }],
    ['a trailing slash', { origin: 'https://id.minimalistalliance.com/' }],
    ['a path', { origin: 'https://id.minimalistalliance.com/v1' }],
    ['a query', { origin: 'https://id.minimalistalliance.com?x=1' }],
    ['upper case, which is not what the URL says', { origin: 'https://ID.minimalistalliance.com' }],
    ['http', { origin: 'http://id.minimalistalliance.com' }],
    ['a port', { origin: 'https://id.minimalistalliance.com:8443' }],
    ['credentials', { origin: 'https://u:p@id.minimalistalliance.com' }],
    ['this app itself', { origin: 'https://office.minimalistalliance.com' }],
    ['the apex', { origin: 'https://minimalistalliance.com' }],
    ['a deeper host', { origin: 'https://id.evil.minimalistalliance.com' }],
    ['a look-alike', { origin: 'https://id.minimalistalliance.com.evil.example' }],
    ['another site', { origin: 'https://id.evil.example' }],
    ["staging's, from prod", { origin: 'https://id.staging.minimalistalliance.com' }],
  ])('is off for %s', (_, sso) => {
    expect(ssoOrigin(cfg(sso), 'office.minimalistalliance.com')).toBeNull();
  });

  // Security's SSO-L4: the first label is exactly `id`, so client-config can't point this browser's credentialed calls at any
  // other host of the site, however like it the name.
  it.each([
    'https://platform.minimalistalliance.com',
    'https://guild.minimalistalliance.com',
    'https://forums.minimalistalliance.com',
    'https://api.minimalistalliance.com',
    'https://auth.minimalistalliance.com',
    'https://signin.minimalistalliance.com',
    'https://ids.minimalistalliance.com',
    'https://xid.minimalistalliance.com',
    'https://id-staging.minimalistalliance.com',
    'https://i.minimalistalliance.com',
  ])('is off for %s, another host of the site', (origin) => {
    expect(ssoOrigin(cfg({ origin }), 'office.minimalistalliance.com')).toBeNull();
  });

  it('is off for any first label but id on staging and the harness too', () => {
    expect(ssoOrigin(cfg({ origin: 'https://platform.staging.minimalistalliance.com' }), 'test.office.staging.minimalistalliance.com')).toBeNull();
    expect(ssoOrigin(cfg({ origin: 'https://login.localhost' }), 'localhost')).toBeNull();
  });

  it("is off for prod's from staging, on a host that is not this app's, and with no config", () => {
    expect(ssoOrigin(cfg({ origin: 'https://id.minimalistalliance.com' }), 'office.staging.minimalistalliance.com')).toBeNull();
    expect(ssoOrigin(cfg({ origin: 'https://id.minimalistalliance.com' }), 'evil.example')).toBeNull();
    expect(ssoOrigin(null, 'office.minimalistalliance.com')).toBeNull();
    expect(ssoOrigin({}, 'office.minimalistalliance.com')).toBeNull();
  });
});
