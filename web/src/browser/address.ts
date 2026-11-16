// How the desk's untrusted titles and URLs are shown. Pure. What the address bar does with what's typed is `typedAddress.ts`,
// the Browser's own chunk's since `sub/mm-js-budget`.

// Controls and the bidi overrides a page could use to make a URL read as something else.
const UNSAFE = /[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const MAX_DISPLAY = 512;

const BLANK = new Set(['about:blank', 'chrome://newtab/', 'chrome://new-tab-page/']);
/**
 * The desk's own start page (the image's Chromium homepage). deskd now reports it with no address (BrowserTabs.isHomePage:
 * the path alone, or followed by ? or #); this guard only covers a desk on an older deskd, and matches the same way.
 */
const HOME_PAGE = 'file:///usr/local/share/ma/home.html';
const isHomePage = (url: string): boolean => url.startsWith(HOME_PAGE) && (url.length === HOME_PAGE.length || url[HOME_PAGE.length] === '#' || url[HOME_PAGE.length] === '?');

/** The address bar's text for a tab: empty on a blank page, so the bar invites typing. */
export function addressShown(url: unknown): string {
  const text = displayText(url);
  return BLANK.has(text) || isHomePage(text) ? '' : text;
}

/** A desk's title or URL, fit to show. React renders it as text; this is about what it can look like. */
export function displayText(text: unknown): string {
  return cleanText(text, MAX_DISPLAY);
}

/** `displayText` at another length: a page's own words in the simple view (`simple/mdoc.ts`), which run longer. */
export function cleanText(text: unknown, max: number): string {
  return typeof text === 'string' ? text.replace(UNSAFE, '').slice(0, max) : '';
}
