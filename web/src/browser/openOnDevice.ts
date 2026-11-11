// "Open on this device": a page's address opened in a new tab of the member's own browser, with no link back to the app.
// Small and shared on purpose: the Browser's protected-video note uses it now, and the "open on this device" feature (#9)
// starts from it. Only http and https addresses open; anything else (file:, javascript:, data:) is refused, so a page's
// address can never run in the app's own origin.
export function deviceUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** True when it opened. */
export function openOnDevice(url: unknown): boolean {
  const href = deviceUrl(url);
  if (!href) return false;
  window.open(href, '_blank', 'noopener');
  return true;
}

/**
 * The schemes a desk may hand over (#9's hand-off, the spec's list): a link a page on the desk tried to open, which only
 * the member's own device can. deskd checks its own list; this one is checked again here, and nothing else is ever shown
 * or opened. `facetime`, which deskd also passes, isn't on it.
 */
export const HANDOFF_SCHEMES = ['mailto', 'tel', 'sms', 'zoommtg', 'zoomus', 'msteams', 'webcal'] as const;
export type HandoffScheme = (typeof HANDOFF_SCHEMES)[number];

/** The link's scheme when it's on the list and has something after it, else null. */
export function handoffScheme(url: unknown): HandoffScheme | null {
  if (typeof url !== 'string' || url.length > 8192) return null;
  const m = /^([a-z][a-z0-9+.-]*):(.+)$/is.exec(url);
  const scheme = m?.[1]?.toLowerCase();
  // Printable ASCII only, as deskd sends it: no control, bidi or lookalike character can ride along.
  if (!scheme || !/^[\x21-\x7e]+$/.test(url)) return null;
  return (HANDOFF_SCHEMES as readonly string[]).includes(scheme) ? (scheme as HandoffScheme) : null;
}

/**
 * Hands a listed link to this device, inside the member's own press: a one-off `<a href>` click, which the device gives to
 * its mail, phone or meeting app (`window.open` is only for http and https). True when it went.
 */
export function openSchemeOnDevice(url: unknown): boolean {
  if (!handoffScheme(url)) return false;
  const a = document.createElement('a');
  a.href = url as string;
  a.rel = 'noopener noreferrer';
  a.click();
  return true;
}

/** The layout pref that says the member has seen what Open on this device does (the first-use card), once per account. */
export const SEEN_PREF = 'openOnDeviceSeen';
