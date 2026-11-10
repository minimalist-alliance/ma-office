// Links in Maia's text go only to our own hosts (contract maia.md, docs/maia.md section 8): https on
// minimalistalliance.com or a subdomain, with no credentials and no port. Anything else shows as plain text.
const SITE = 'minimalistalliance.com';

/** The link as it will be opened, or null if it isn't ours. */
export function ourLink(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null; // relative links included: there's no page of hers to be relative to
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (host !== SITE && !host.endsWith(`.${SITE}`)) return null;
  return url.href;
}
