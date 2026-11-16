// What the address bar does with what's typed: an http(s) URL, or a search (`SEARCH_URL`, DuckDuckGo). Pure. The Browser's
// own chunk's (`driver.ts`), out of the first load since `sub/mm-js-budget`; how the desk's untrusted titles and URLs are
// shown is `address.ts`.

/**
 * Where typed words go. DuckDuckGo, because this search runs from the desk's AWS address, where Google tends to
 * answer with a CAPTCHA (design 6.4), and it asks for no account. One constant, so changing it is one line.
 */
export const SEARCH_URL = 'https://duckduckgo.com/?q=';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const TLD = /^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/i;
/** `scheme:` with a body that can't be a port. `localhost:3000` and `example.org:8080/a` are hosts. */
const OTHER_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i;

function isHost(hostname: string): boolean {
  if (hostname === 'localhost' || IPV4.test(hostname) || hostname.startsWith('[')) return true;
  const labels = hostname.split('.');
  return labels.length >= 2 && labels.every(Boolean) && TLD.test(labels[labels.length - 1] as string);
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** The URL to open. Null for nothing typed. Never anything but http(s): any other scheme is a search. */
export function addressToUrl(typed: string): string | null {
  const text = typed.trim().replace(/\p{Cs}/gu, ''); // half a surrogate pair: encodeURIComponent throws, and deskd refuses it
  if (!text) return null;
  const search = SEARCH_URL + encodeURIComponent(text);
  if (/\s/.test(text)) return search;
  if (/^https?:\/\//i.test(text)) return parse(text)?.href ?? search;
  if (OTHER_SCHEME.test(text)) return search;
  // As typed, not as `URL` reads it: to `URL`, `1.5` is the address 1.0.0.5.
  const authority = text.split(/[/?#]/, 1)[0] as string;
  if (authority.includes('@')) return search;
  const hostname = (authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.replace(/:\d+$/, '')).toLowerCase();
  if (!isHost(hostname)) return search;
  // A bare name or an address is most likely a machine here; anything else asks for TLS.
  const plain = hostname === 'localhost' || IPV4.test(hostname) || hostname.startsWith('[');
  return parse(`${plain ? 'http' : 'https'}://${text}`)?.href ?? search;
}
