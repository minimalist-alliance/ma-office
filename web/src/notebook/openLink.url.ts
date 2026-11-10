/** Only http and https go to the desk's Browser (web/CLAUDE.md, "Titles and URLs from the desk are untrusted"). */
export function browserUrl(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
