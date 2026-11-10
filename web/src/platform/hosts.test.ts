import { describe, expect, it } from 'vitest';
import { apiBaseFor, siblingUrl } from './hosts';

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
