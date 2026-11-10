import { describe, expect, it } from 'vitest';
import { onSignInPage, signInAddress, type Here } from './signInAddress';

const at = (hostname: string, pathname = '/'): Here => ({ origin: `https://${hostname}`, hostname, pathname });
const OFFICE = at('office.minimalistalliance.com');
const STAGING = at('office.staging.minimalistalliance.com');
const TEST_STAGING = at('test.office.staging.minimalistalliance.com');
const ID = 'https://id.minimalistalliance.com/';

describe('signInAddress, with a path on this site', () => {
  it('makes the addresses the pages read today, byte for byte', () => {
    expect(signInAddress('/_signin/', { return: '/' }, OFFICE)).toBe('/_signin/?return=%2F');
    expect(signInAddress('/_signin/', { return: '/a?b=c d' }, OFFICE)).toBe('/_signin/?return=%2Fa%3Fb%3Dc%20d');
    expect(signInAddress('/_signin/', { error: 'google' }, OFFICE)).toBe('/_signin/?error=google');
    expect(signInAddress('/_signin/', { return: '/', notice: 'session' }, OFFICE)).toBe('/_signin/?return=%2F&notice=session');
  });

  it('answers with the setting when there is nothing to add, and adds to a query it already has', () => {
    expect(signInAddress('/_signin/', {}, OFFICE)).toBe('/_signin/');
    expect(signInAddress('/_signin/?app=desk', { error: 'google' }, OFFICE)).toBe('/_signin/?app=desk&error=google');
  });
});

describe('signInAddress, with an address on a sibling host', () => {
  it('makes `return` an absolute URL on the current site', () => {
    expect(signInAddress(ID, { return: '/a?b=c' }, OFFICE)).toBe(`${ID}?return=${encodeURIComponent('https://office.minimalistalliance.com/a?b=c')}`);
    expect(signInAddress('https://id.staging.minimalistalliance.com/in', { return: '/' }, TEST_STAGING)).toBe(`https://id.staging.minimalistalliance.com/in?return=${encodeURIComponent('https://test.office.staging.minimalistalliance.com/')}`);
  });

  it('carries the fixed keys as they are', () => {
    expect(signInAddress(ID, { error: 'google' }, OFFICE)).toBe(`${ID}?error=google`);
    expect(signInAddress(ID, { return: '/', notice: 'session' }, OFFICE)).toBe(`${ID}?return=${encodeURIComponent('https://office.minimalistalliance.com/')}&notice=session`);
  });
});

describe('a setting that can be neither', () => {
  it.each([
    [null], [undefined], [''], ['_signin/'],
    // Start with a slash, and aren't paths on this site.
    ['//evil.example/'], ['/\\evil.example/'], ['/.//evil.example/'],
    // Not https, not a sibling, or this app itself.
    ['http://id.minimalistalliance.com/'], ['https://evil.example/'], ['https://id.minimalistalliance.com.evil.example/'],
    ['https://minimalistalliance.com/'], ['https://a.id.minimalistalliance.com/'], ['https://id.staging.minimalistalliance.com/'],
    ['https://office.minimalistalliance.com/_signin/'], ['https://desk.minimalistalliance.com/_signin/'],
    ['https://id.minimalistalliance.com:8443/'], ['https://me:pw@id.minimalistalliance.com/'],
    ['javascript:alert(1)'], ['data:text/html,x'],
    ['/_signin/#there'], ['https://id.minimalistalliance.com/#there'],
  ])('%s reads as no setting', (setting) => {
    expect(signInAddress(setting, { return: '/' }, OFFICE)).toBeNull();
    expect(onSignInPage(setting, OFFICE)).toBe(false);
  });

  it('a staging page takes staging siblings only', () => {
    expect(signInAddress('https://id.staging.minimalistalliance.com/', {}, STAGING)).not.toBeNull();
    expect(signInAddress(ID, {}, STAGING)).toBeNull();
  });
});

describe('onSignInPage', () => {
  it('with a path, is whether this page is at that path', () => {
    expect(onSignInPage('/_signin/', at('office.minimalistalliance.com', '/_signin/'))).toBe(true);
    expect(onSignInPage('/_signin/', at('office.minimalistalliance.com', '/_signin/deep/link'))).toBe(true);
    expect(onSignInPage('/_signin/', OFFICE)).toBe(false);
    expect(onSignInPage('/_signin/?app=desk', at('office.minimalistalliance.com', '/_signin/'))).toBe(true);
  });

  it('with an address on another site, is never true, even if the paths agree', () => {
    expect(onSignInPage(ID, OFFICE)).toBe(false);
    expect(onSignInPage(ID, at('office.minimalistalliance.com', '/anything'))).toBe(false);
    expect(onSignInPage('https://id.minimalistalliance.com/_signin/', at('office.minimalistalliance.com', '/_signin/'))).toBe(false);
  });
});
