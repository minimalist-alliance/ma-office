import { describe, expect, it } from 'vitest';
import { ourLink } from './links';

describe('ourLink: links in her text go only to our own hosts', () => {
  it('takes https on minimalistalliance.com and its subdomains', () => {
    expect(ourLink('https://minimalistalliance.com/privacy')).toBe('https://minimalistalliance.com/privacy');
    expect(ourLink('https://platform.minimalistalliance.com/account')).toBe('https://platform.minimalistalliance.com/account');
    expect(ourLink('https://platform.staging.minimalistalliance.com/x?y=1#z')).toBe('https://platform.staging.minimalistalliance.com/x?y=1#z');
    expect(ourLink('HTTPS://MinimalistAlliance.com/')).toBe('https://minimalistalliance.com/');
  });

  it('refuses everything else', () => {
    for (const raw of [
      'http://minimalistalliance.com/',
      'https://minimalistalliance.com.evil.example/',
      'https://evilminimalistalliance.com/',
      'https://minimalistalliance.com@evil.example/',
      'https://user:pw@minimalistalliance.com/',
      'https://minimalistalliance.com:8443/',
      'https://minimalistalliance.com./',
      'https:\\\\evil.example',
      '//minimalistalliance.com/',
      '/privacy',
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'mailto:support@minimalistalliance.com',
      'ftp://minimalistalliance.com/',
      'https://xn--minimalistallince-gtb.com/',
      '',
    ]) {
      expect(ourLink(raw), raw).toBeNull();
    }
  });
});
