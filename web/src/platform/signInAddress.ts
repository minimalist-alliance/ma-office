// Every address of the sign-in pages is made here, from auth.signInPath in client-config. Today that's a path
// on this site. It may become an absolute https URL on a sibling host, if the pages move to a site of their
// own: then `return` has to say which site to come back to, and this app can never already be on them. A
// setting that's neither reads as no setting, which is managed login and also the rollback.
import { siblingUrl } from './hosts';

export interface SignInParts {
  /** A path and query on this site to come back to. */
  return?: string;
  /** Fixed keys only: the pages turn each into their own words, and nothing from the URL reaches the page. */
  error?: 'google';
  notice?: 'session' | 'ended-7d' | 'ended-1d' | 'ended-browser';
}

/** What the answer depends on about the current page. */
export type Here = Pick<Location, 'origin' | 'hostname' | 'pathname'>;

function formOf(setting: string, here: Here): 'path' | 'url' | null {
  let url: URL;
  try {
    url = new URL(setting, here.origin);
  } catch {
    return null;
  }
  if (url.hash) return null;
  // By the URL parser: "//evil.example", "/\evil.example" and "/.//evil.example" all start with a slash.
  if (setting.startsWith('/')) return url.origin === here.origin && !url.pathname.startsWith('//') ? 'path' : null;
  return siblingUrl(setting, here.hostname) ? 'url' : null;
}

/** Where to send a member, or null if the setting can't be used. */
export function signInAddress(setting: string | null | undefined, parts: SignInParts = {}, here: Here = window.location): string | null {
  const form = setting ? formOf(setting, here) : null;
  if (!setting || !form) return null;
  const query: string[] = [];
  if (parts.return !== undefined) query.push(`return=${encodeURIComponent(form === 'url' ? here.origin + parts.return : parts.return)}`);
  if (parts.error) query.push(`error=${parts.error}`);
  if (parts.notice) query.push(`notice=${parts.notice}`);
  if (!query.length) return setting;
  return `${setting}${setting.includes('?') ? '&' : '?'}${query.join('&')}`;
}

/**
 * Whether this page is at the setting's path. It can only be if the SPA fallback answered it, so the route isn't
 * there (ownSignInPath in auth.ts). An address on another site is never this page, whatever the paths say.
 */
export function onSignInPage(setting: string | null | undefined, here: Here = window.location): boolean {
  if (!setting || formOf(setting, here) !== 'path') return false;
  return here.pathname.startsWith(new URL(setting, here.origin).pathname);
}
