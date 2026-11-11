import { describe, expect, it } from 'vitest';
import { addressShown, addressToUrl, displayText, SEARCH_URL } from './address';

const search = (q: string): string => SEARCH_URL + encodeURIComponent(q);

describe('addressToUrl', () => {
  it('nothing typed is nothing', () => {
    expect(addressToUrl('')).toBeNull();
    expect(addressToUrl('   ')).toBeNull();
  });

  it.each([
    ['https://example.org', 'https://example.org/'],
    ['http://example.org/a?b=1#c', 'http://example.org/a?b=1#c'],
    ['HTTPS://Example.ORG', 'https://example.org/'],
    ['  https://example.org  ', 'https://example.org/'],
  ])('%s is already a URL', (typed, url) => {
    expect(addressToUrl(typed)).toBe(url);
  });

  it.each([
    ['example.org', 'https://example.org/'],
    ['www.example.co.uk/path?q=1', 'https://www.example.co.uk/path?q=1'],
    ['example.org:8443/a', 'https://example.org:8443/a'],
    ['xn--bcher-kva.example', 'https://xn--bcher-kva.example/'],
  ])('%s looks like a site, and asks for TLS', (typed, url) => {
    expect(addressToUrl(typed)).toBe(url);
  });

  it.each([
    ['localhost', 'http://localhost/'],
    ['localhost:3000/x', 'http://localhost:3000/x'],
    ['127.0.0.1:8000', 'http://127.0.0.1:8000/'],
    ['192.168.1.5', 'http://192.168.1.5/'],
    ['[::1]:8080', 'http://[::1]:8080/'],
  ])('%s is a machine, and stays plain http', (typed, url) => {
    expect(addressToUrl(typed)).toBe(url);
  });

  it.each(['cats', 'how tall is a giraffe', 'example.org is down', '1.5', 'a.b.1', 'foo.', '.foo', 'C++', 'what?', 'me@example.org', 'example.org@evil.example/x', 'example.org:abc'])('%s is a search', (typed) => {
    expect(addressToUrl(typed)).toBe(search(typed));
  });

  it('encodes a search', () => {
    expect(addressToUrl('a&b=c d')).toBe(`${SEARCH_URL}a%26b%3Dc%20d`);
  });

  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'chrome://settings',
    'about:blank',
    'view-source:https://example.org',
    'mailto:a@example.org',
    'ftp://example.org',
    'ws://example.org',
    'blob:https://example.org/x',
    'filesystem:https://example.org/x',
  ])('%s never goes out as itself', (typed) => {
    const url = addressToUrl(typed) as string;
    expect(url.startsWith(SEARCH_URL)).toBe(true);
  });

  it('everything it returns is http(s)', () => {
    const typed = ['example.org', 'javascript:1', 'localhost', 'x y', 'http://a.b', 'tel:123', 'a:b', '//example.org', '\\\\host\\share'];
    for (const t of typed) {
      expect(new URL(addressToUrl(t) as string).protocol).toMatch(/^https?:$/);
    }
  });

  it('a title deskd has HTML-escaped is shown as it came, never decoded', () => {
    expect(displayText('Tom &amp; Jerry &lt;b&gt;')).toBe('Tom &amp; Jerry &lt;b&gt;');
  });

  it('half a surrogate pair neither throws nor goes out', () => {
    const lone = String.fromCharCode(0xd83d);
    expect(addressToUrl(`cats${lone}`)).toBe(search('cats'));
    expect(addressToUrl(lone)).toBeNull();
  });

  it('a default search provider is one constant, on https', () => {
    expect(new URL(SEARCH_URL).protocol).toBe('https:');
  });
});

describe('displayText', () => {
  it('passes ordinary text through, in any script', () => {
    expect(displayText('Example — 例え')).toBe('Example — 例え');
    expect(displayText('😀 title')).toBe('😀 title');
  });

  it('takes out controls and the bidi overrides that can disguise a URL', () => {
    expect(displayText('good\u202egro.live\u202c.example')).toBe('goodgro.live.example');
    expect(displayText('a\u0000b\nc\td\u200fe\u2066f')).toBe('abcdef');
  });

  it('leaves markup as the text it is, for React to render as text', () => {
    expect(displayText('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });

  it('caps a long one', () => {
    expect(displayText('x'.repeat(5000))).toHaveLength(512);
  });

  it('anything that is not a string is empty', () => {
    expect(displayText(undefined)).toBe('');
    expect(displayText(null)).toBe('');
    expect(displayText(7)).toBe('');
  });
});

describe('addressShown', () => {
  it('a blank page shows an empty bar', () => {
    expect(addressShown('about:blank')).toBe('');
    expect(addressShown('chrome://newtab/')).toBe('');
    expect(addressShown('chrome://new-tab-page/')).toBe('');
    expect(addressShown(undefined)).toBe('');
  });

  it("the desk's start page shows an empty bar (as an older deskd reports it), any other file:// URL as it is", () => {
    expect(addressShown('file:///usr/local/share/ma/home.html')).toBe('');
    expect(addressShown('file:///usr/local/share/ma/home.html#x')).toBe('');
    expect(addressShown('file:///usr/local/share/ma/home.html?q=1')).toBe('');
    expect(addressShown('file:///usr/local/share/ma/home.htmlx')).toBe('file:///usr/local/share/ma/home.htmlx');
    expect(addressShown('file:///etc/hostname')).toBe('file:///etc/hostname');
  });

  it('anything else shows as it is', () => {
    expect(addressShown('https://example.org/a')).toBe('https://example.org/a');
  });
});
