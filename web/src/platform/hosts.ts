// Where the API lives, from the page's own hostname. Used only to fetch client-config; after
// that every URL comes from the config, which follows the calling origin. Nothing else is
// hard-coded. The app is at `office.`, with `test.office.staging.` as staging's test host, and
// every member uses the same address: there are no per-member hosts. The old `desk.` hosts only
// redirect here (Platform ADR 0078), so the app never runs on them.
const PROD_HOST = /^office\.minimalistalliance\.com$/;
const STAGING_HOST = /^(?:test\.)?office\.staging\.minimalistalliance\.com$/;
const LOCAL = /^(localhost|127\.0\.0\.1)$/;

/** @param localOverride only honored on localhost: the test harness's fake API. */
export function apiBaseFor(hostname: string, localOverride?: string | null): string | null {
  if (PROD_HOST.test(hostname)) return 'https://api.minimalistalliance.com';
  if (STAGING_HOST.test(hostname)) return 'https://api.staging.minimalistalliance.com';
  // Local development runs against staging (hostnames.md, "Local development").
  if (LOCAL.test(hostname)) return localOverride || 'https://api.staging.minimalistalliance.com';
  return null;
}

/** The domain this app's hosts sit under, which other hosts of the same site share. */
function siteOf(hostname: string): string | null {
  if (PROD_HOST.test(hostname)) return 'minimalistalliance.com';
  if (STAGING_HOST.test(hostname)) return 'staging.minimalistalliance.com';
  return hostname === 'localhost' ? 'localhost' : null; // the harness, whose siblings are *.localhost
}

/**
 * `raw` as a URL, if it's over https on another host of this site: exactly one label in front of the site's
 * domain, with no port or credentials. This app's own hosts don't count, the old `desk.` included, since it
 * only redirects here: going to one of those could never end.
 */
export function siblingUrl(raw: unknown, hostname: string): URL | null {
  const site = siteOf(hostname);
  if (!site || typeof raw !== 'string') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (!url.hostname.endsWith(`.${site}`)) return null;
  const label = url.hostname.slice(0, -site.length - 1);
  if (!label || label.includes('.') || label === 'office' || label === 'desk') return null;
  return url;
}

export function currentApiBase(): string | null {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="ma-api-base"]');
  return apiBaseFor(window.location.hostname, meta?.content);
}
