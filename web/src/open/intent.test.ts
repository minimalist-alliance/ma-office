import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstWebLink, keepPending, linksOn, parseOpenIntent, pastedLink, PENDING_KEY, PENDING_MS, takePending, webLink } from './intent';

const O = 'https://office.minimalistalliance.com';

describe('webLink', () => {
  it('takes absolute http and https with a host, and nothing else', () => {
    expect(webLink('https://news.example.com/a?b=1')).toBe('https://news.example.com/a?b=1');
    expect(webLink('http://example.org')).toBe('http://example.org/');
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'mailto:a@example.com', 'ftp://x.example/', 'https://', 'news.example.com', '', 'blob:https://x.example/1']) {
      expect(webLink(bad)).toBeNull();
    }
    expect(webLink(42)).toBeNull();
    expect(webLink(`https://x.example/${'a'.repeat(9000)}`)).toBeNull();
  });
  it('shows an IDN host as punycode', () => {
    expect(new URL(webLink('https://bücher.example/')!).hostname).toBe('xn--bcher-kva.example');
  });
});

describe('parseOpenIntent', () => {
  it('reads #u= first, as it came, with its own & and +', () => {
    expect(parseOpenIntent(`${O}/open#u=https://news.example.com/a?b=1&c=2+3`)).toEqual({ kind: 'link', url: 'https://news.example.com/a?b=1&c=2+3' });
    expect(parseOpenIntent(`${O}/open?u=https://other.example/#u=https://first.example/`)).toEqual({ kind: 'link', url: 'https://first.example/' });
  });
  it('decodes a #u= that came encoded whole', () => {
    expect(parseOpenIntent(`${O}/open#u=${encodeURIComponent('https://news.example.com/a?b=1&c=2')}`)).toEqual({ kind: 'link', url: 'https://news.example.com/a?b=1&c=2' });
  });
  it('then ?u=, then the first link in ?t=, then in ?n= (Android puts it in the text)', () => {
    expect(parseOpenIntent(`${O}/open?u=${encodeURIComponent('https://a.example/x')}`)).toEqual({ kind: 'link', url: 'https://a.example/x' });
    expect(parseOpenIntent(`${O}/open?t=${encodeURIComponent('Look at this https://b.example/y.')}&n=Title`)).toEqual({ kind: 'link', url: 'https://b.example/y' });
    expect(parseOpenIntent(`${O}/open?t=nothing&n=${encodeURIComponent('see (https://c.example/z)')}`)).toEqual({ kind: 'link', url: 'https://c.example/z' });
    expect(parseOpenIntent(`${O}/open/?u=${encodeURIComponent('https://a.example/')}`)).toEqual({ kind: 'link', url: 'https://a.example/' });
  });
  it('anything else that came is the no-link sheet, with its text', () => {
    expect(parseOpenIntent(`${O}/open#u=javascript:alert(1)`)).toEqual({ kind: 'none', text: 'javascript:alert(1)' });
    expect(parseOpenIntent(`${O}/open?t=${encodeURIComponent('just words')}`)).toEqual({ kind: 'none', text: 'just words' });
    expect(parseOpenIntent(`${O}/open?u=${encodeURIComponent('file:///etc/passwd')}`)).toEqual({ kind: 'none', text: 'file:///etc/passwd' });
  });
  it('is nothing off /open, or when nothing came', () => {
    expect(parseOpenIntent(`${O}/`)).toBeNull();
    expect(parseOpenIntent(`${O}/opener#u=https://a.example/`)).toBeNull();
    expect(parseOpenIntent(`${O}/open`)).toBeNull();
    expect(parseOpenIntent(`${O}/open?u=%20`)).toBeNull();
  });
});

describe('pastedLink and firstWebLink', () => {
  it('a paste counts only as one whole http(s) address', () => {
    expect(pastedLink('  https://news.example.com/a \n')).toBe('https://news.example.com/a');
    expect(pastedLink('https://a.example/ https://b.example/')).toBeNull();
    expect(pastedLink('read https://a.example/')).toBeNull();
    expect(pastedLink('javascript:alert(1)')).toBeNull();
    expect(pastedLink(null)).toBeNull();
  });
  it('finds the first web link in words, without the sentence round it', () => {
    expect(firstWebLink('x https://a.example/p, and https://b.example/')).toBe('https://a.example/p');
    expect(firstWebLink('no link here')).toBeNull();
  });
});

describe('the link that waits for a sign-in', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is kept in this tab with when it came, read once, and gone after', () => {
    keepPending('https://news.example.com/a', 1000);
    expect(JSON.parse(store.get(PENDING_KEY)!)).toEqual({ url: 'https://news.example.com/a', at: 1000 });
    expect(takePending(2000)).toBe('https://news.example.com/a');
    expect(store.has(PENDING_KEY)).toBe(false);
    expect(takePending(2000)).toBeNull();
  });
  it('is dropped after 10 minutes, and dropped if it is anything but a web link', () => {
    keepPending('https://news.example.com/a', 0);
    expect(takePending(PENDING_MS)).toBeNull();
    expect(store.has(PENDING_KEY)).toBe(false);
    store.set(PENDING_KEY, JSON.stringify({ url: 'javascript:alert(1)', at: 0 }));
    expect(takePending(1)).toBeNull();
    store.set(PENDING_KEY, '{nope');
    expect(takePending(1)).toBeNull();
    keepPending('https://a.example/', 5000);
    expect(takePending(4000)).toBeNull(); // from the future: not trusted
  });
  it('storage that refuses keeps nothing and breaks nothing', () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
        removeItem: () => {
          throw new Error('denied');
        },
      },
    });
    expect(() => keepPending('https://a.example/')).not.toThrow();
    expect(takePending()).toBeNull();
  });
});

describe('linksOn', () => {
  it('is on unless client-config says enabled: false', () => {
    expect(linksOn(null)).toBe(true);
    expect(linksOn({ api: '', auth: { domain: '', clientId: '', redirectUri: '', logoutUri: '', scopes: [] } })).toBe(true);
    expect(linksOn({ api: '', auth: { domain: '', clientId: '', redirectUri: '', logoutUri: '', scopes: [] }, browserLinks: { enabled: false } })).toBe(false);
    expect(linksOn({ api: '', auth: { domain: '', clientId: '', redirectUri: '', logoutUri: '', scopes: [] }, browserLinks: { enabled: true } })).toBe(true);
  });
});
