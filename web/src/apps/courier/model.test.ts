// Courier's pure rules: the link allow-list (Security's condition for Wave 1.6), links read from the sandbox's `data-ma-*`, the
// sender check's line, times, highlights, the list's keys, the reply's medium and a to-do's words.
import { describe, expect, it } from 'vitest';
import { ago, decodeEntities, domainOf, hasRemoteImages, highlight, linksOf, replyMedium, replySubject, rowLine, rowTitle, safeTarget, senderAddress, senderName, sizeWords, step, unconfirmed, whenLong, whenShort, wordsHost } from './model';
import type { Contact, Message, Row } from './types';

const contact = (name: string, value: string, known = true): Contact => ({ contactId: 'c', name, endpoint: { kind: 'email', value }, known });

describe('safeTarget: only http, https, mailto and tel, parsed again', () => {
  it('keeps web links, with the host as the URL parser reads it', () => {
    expect(safeTarget('https://nursery.example/spring?x=1')).toEqual({ href: 'https://nursery.example/spring?x=1', host: 'nursery.example', scheme: 'https' });
    expect(safeTarget('http://203.0.113.9/verify')?.host).toBe('203.0.113.9');
  });
  it('shows a look-alike host as it really is (punycode)', () => {
    expect(safeTarget('https://pаypal.example/')?.host).toBe('xn--pypal-4ve.example');
  });
  it('drops a sign-in name the sandbox should have taken out', () => {
    const t = safeTarget('https://user:pw@bank.example/login');
    expect(t?.href).toBe('https://bank.example/login');
    expect(t?.href).not.toContain('user');
  });
  it('refuses every other scheme, and anything malformed', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', 'file:///etc/passwd', 'ftp://x.example/', 'blob:https://office/x', 'about:blank', 'chrome://settings', '//evil.example/', '/relative', 'https://', 'https://ex ample.example/', 'https://a.example/\nb', '']) {
      expect(safeTarget(bad), bad).toBeNull();
    }
  });
  it('keeps one address of a mailto, and a number of a tel', () => {
    expect(safeTarget('mailto:dana@ortiz.example?subject=hi')).toEqual({ href: 'mailto:dana@ortiz.example', host: 'dana@ortiz.example', scheme: 'mailto' });
    expect(safeTarget('mailto:a@b.example,c@d.example')?.host).toBe('a@b.example');
    expect(safeTarget('mailto:not-an-address')).toBeNull();
    // An address that would show as another (Security's CA-L1): a reordering or hidden character, escaped or not.
    expect(safeTarget('mailto:support%E2%80%AEmoc.lapyap@evil.example')).toBeNull();
    expect(safeTarget('mailto:pay%E2%80%8Bpal@evil.example')).toBeNull();
    expect(safeTarget('tel:+1-555-0142')).toEqual({ href: 'tel:+15550142', host: '+15550142', scheme: 'tel' });
    expect(safeTarget('tel:call-me')).toBeNull();
  });
});

describe('linksOf: the links the sandbox wrote, as text, never through a document', () => {
  it('reads data-ma-href, its warnings and its words; never an href', () => {
    const html =
      '<p><a data-ma-href="https://paypa1-secure.example/login" data-ma-host="paypa1-secure.example" title="https://paypa1-secure.example/login" data-ma-warn="mismatch">Sign in at <b>paypal.com</b></a></p>' +
      '<a href="https://evil.example/" data-ma-href="https://nursery.example/a?x=1&amp;y=2" data-ma-warn="tracker bogus">Guide</a>';
    expect(linksOf(html)).toEqual([
      { href: 'https://paypa1-secure.example/login', host: 'paypa1-secure.example', scheme: 'https', warn: ['mismatch'], text: 'Sign in at paypal.com' },
      { href: 'https://nursery.example/a?x=1&y=2', host: 'nursery.example', scheme: 'https', warn: ['tracker'], text: 'Guide' },
    ]);
  });
  it('leaves out a link with no data-ma-href, or one that is not allowed', () => {
    expect(linksOf('<a href="https://evil.example/">x</a><a data-ma-href="javascript:alert(1)">y</a><a data-ma-href="data:text/html,x">z</a>')).toEqual([]);
  });
  it('one row a destination, the first words', () => {
    const html = '<a data-ma-href="https://a.example/">One</a><a data-ma-href="https://a.example/">Two</a>';
    expect(linksOf(html).map((l) => l.text)).toEqual(['One']);
  });
  it('cleans hidden characters out of the words', () => {
    expect(linksOf('<a data-ma-href="https://a.example/">pay‮lapyap​</a>')[0]?.text).toBe('paylapyap');
  });
  it('knows pictures from the web the sandbox left unloaded', () => {
    expect(hasRemoteImages('<img data-ma-src="https://i.example/x.png">')).toBe(true);
    expect(hasRemoteImages('<img src="data:image/png;base64,AA">')).toBe(false);
  });
  it('decodes character references and keeps unknown ones as they came', () => {
    expect(decodeEntities('a&amp;b&lt;c&#x41;&#66;&bogus;&#0;')).toBe('a&b<cAB&bogus;');
  });
  it('finds the host a link names in its words', () => {
    expect(wordsHost('Sign in at PayPal.com today')).toBe('paypal.com');
    expect(wordsHost('Help centre')).toBe('');
  });
});

describe('senders', () => {
  it('names a contact, or its address, and the member as You', () => {
    expect(senderName({ me: true })).toBe('You');
    expect(senderName({ me: false, ...contact('Dana Ortiz', 'dana@ortiz.example') })).toBe('Dana Ortiz');
    expect(senderName({ me: false, ...contact('', 'dana@ortiz.example') })).toBe('dana@ortiz.example');
    expect(senderName(null)).toBe('Unknown sender');
    expect(senderAddress({ me: false, ...contact('Dana Ortiz', 'dana@ortiz.example') })).toBe('dana@ortiz.example');
    expect(senderAddress({ me: false, ...contact('', 'dana@ortiz.example') })).toBe('');
  });
  it('says "Couldn\'t confirm" for an email whose DMARC did not pass, or has no result', () => {
    const m = (auth: Message['auth'], over: Partial<Message> = {}): Pick<Message, 'medium' | 'direction' | 'auth' | 'from'> => ({ medium: 'email', direction: 'in', auth, from: { me: false, ...contact('A', 'a@b.example') }, ...over });
    expect(unconfirmed(m({ spf: 'pass', dkim: 'pass', dmarc: 'pass', senderConfirmed: true }))).toBe(false);
    expect(unconfirmed(m({ spf: 'fail', dkim: 'fail', dmarc: 'fail', senderConfirmed: false }))).toBe(true);
    expect(unconfirmed(m({ spf: '', dkim: '', dmarc: '', senderConfirmed: null }))).toBe(true);
    expect(unconfirmed(m(null))).toBe(true);
    expect(unconfirmed(m(null, { direction: 'out' }))).toBe(false);
    expect(unconfirmed(m(null, { medium: 'ma' }))).toBe(false);
    expect(domainOf('Alerts@Secure-Login.example')).toBe('secure-login.example');
  });
  it("titles a row by its list's name, its people, or two names and a count", () => {
    const r = (contacts: Contact[], title = ''): Pick<Row, 'title' | 'contacts' | 'kind'> => ({ title, contacts, kind: contacts.length > 1 ? 'group' : 'direct' });
    expect(rowTitle(r([contact('Dana', 'd@x.example')]))).toBe('Dana');
    expect(rowTitle(r([contact('A', 'a@x.example'), contact('B', 'b@x.example'), contact('C', 'c@x.example'), contact('D', 'd@x.example')]))).toBe('A, B and 2 others');
    expect(rowTitle(r([contact('A', 'a@x.example')], 'Book club'))).toBe('Book club');
    // One person with two ways to reach them (flow 11) is one name.
    expect(rowTitle({ title: '', kind: 'direct', contacts: [{ ...contact('Dana', 'd@x.example'), contactId: 'p1' }, { ...contact('Dana', '+15550142'), contactId: 'p1' }] })).toBe('Dana');
  });
  it("gives a row's line: an email's subject and words, the member's own as You", () => {
    const row = { last: { messageId: 'x', medium: 'email', direction: 'out', from: { me: true }, subject: 'Plans', snippet: 'See you', at: 0, read: true, accountId: null } } as unknown as Row;
    expect(rowLine(row)).toBe('You: Plans · See you');
  });
});

describe('time', () => {
  const tz = 'America/Denver';
  const now = Date.UTC(2026, 10, 14, 19, 0); // Nov 14, 12:00 in Denver
  it('says a short time by how long ago', () => {
    expect(whenShort(Date.UTC(2026, 10, 14, 16, 5), now, tz)).toBe('9:05 am');
    expect(whenShort(Date.UTC(2026, 10, 13, 19, 0), now, tz)).toBe('Yesterday');
    expect(whenShort(Date.UTC(2026, 10, 11, 19, 0), now, tz)).toBe('Wed');
    expect(whenShort(Date.UTC(2026, 9, 3, 19, 0), now, tz)).toBe('Oct 3');
    expect(whenShort(Date.UTC(2025, 9, 3, 19, 0), now, tz)).toBe('Oct 3, 2025');
    expect(whenShort(0, now, tz)).toBe('');
  });
  it('says a message time in full', () => {
    expect(whenLong(Date.UTC(2026, 10, 14, 22, 30), now, tz)).toBe('Today, 3:30 pm');
    expect(whenLong(Date.UTC(2026, 9, 3, 19, 0), now, tz)).toBe('Oct 3, 1:00 pm');
  });
  it('says how long ago, for the reply\'s reason', () => {
    expect(ago(now - 10_000, now)).toBe('just now');
    expect(ago(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(ago(now - 2 * 3_600_000, now)).toBe('2 h ago');
    expect(ago(now - 3 * 86_400_000, now)).toBe('3 days ago');
  });
  it('says a size', () => {
    expect(sizeWords(512)).toBe('512 B');
    expect(sizeWords(482_000)).toBe('482 KB');
    expect(sizeWords(1_204_000)).toBe('1.2 MB');
  });
});

describe('search, keys and the reply', () => {
  it('cuts a snippet at its matches, merging overlaps and cutting past the end', () => {
    expect(highlight('the lease renewal', [[4, 9]])).toEqual([
      { text: 'the ', hit: false },
      { text: 'lease', hit: true },
      { text: ' renewal', hit: false },
    ]);
    expect(highlight('abcdef', [[0, 3], [2, 4], [5, 99]])).toEqual([
      { text: 'abc', hit: true },
      { text: 'd', hit: true },
      { text: 'e', hit: false },
      { text: 'f', hit: true },
    ]);
  });
  it('steps through a list, starting at an end', () => {
    expect(step(['a', 'b', 'c'], null, 1)).toBe('a');
    expect(step(['a', 'b', 'c'], null, -1)).toBe('c');
    expect(step(['a', 'b', 'c'], 'b', 1)).toBe('c');
    expect(step(['a', 'b', 'c'], 'c', 1)).toBe('c');
    expect(step([], 'x', 1)).toBeNull();
  });
  it('replies by the medium of the last message received', () => {
    expect(replyMedium([{ direction: 'in', medium: 'email', at: 1 }, { direction: 'in', medium: 'ma', at: 2 }, { direction: 'out', medium: 'email', at: 3 }])).toEqual({ medium: 'ma', at: 2 });
    expect(replyMedium([])).toBeNull();
    expect(replySubject('Garden plans')).toBe('Re: Garden plans');
    expect(replySubject('RE: Garden plans')).toBe('RE: Garden plans');
  });
});
