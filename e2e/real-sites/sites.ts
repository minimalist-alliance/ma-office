// The 20 sites a general member would try first on a new desk, in the order they're visited. Public pages only: the check
// signs in to nothing, types nothing but these addresses, and clicks only a video's own player to start it.
//
// `use` is what "typical use" means on that page, and so what its GB/h covers:
// - read:  10 s still, then a 360 px wheel step every 5 s for 40 s, as a member reads down a page
// - video: start the player if it's paused, then 60 s of watching
// - maps:  10 s still, then a wheel zoom-in every 5 s for 30 s, which loads new tiles
// - login: 20 s still. A sign-in page is loaded and looked at, never filled in
export type Use = 'read' | 'video' | 'maps' | 'login';
export interface Site { id: number; name: string; category: string; url: string; use: Use; cookieDomain: string }

export const SITES: Site[] = [
  { id: 1, name: 'Gmail', category: 'mail', url: 'https://mail.google.com/', use: 'login', cookieDomain: 'google.com' },
  { id: 2, name: 'Outlook.com', category: 'mail', url: 'https://outlook.live.com/', use: 'login', cookieDomain: 'live.com' },
  { id: 3, name: 'Google Search', category: 'search', url: 'https://www.google.com/search?q=weather', use: 'read', cookieDomain: 'google.com' },
  { id: 4, name: 'Bing', category: 'search', url: 'https://www.bing.com/search?q=weather', use: 'read', cookieDomain: 'bing.com' },
  // Big Buck Bunny, the Blender Foundation's own upload: public, long-lived, 1080p60, and the film the benchmarks used.
  { id: 5, name: 'YouTube', category: 'video', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', use: 'video', cookieDomain: 'youtube.com' },
  { id: 6, name: 'Netflix', category: 'video', url: 'https://www.netflix.com/', use: 'read', cookieDomain: 'netflix.com' },
  { id: 7, name: 'AP News', category: 'news', url: 'https://apnews.com/', use: 'read', cookieDomain: 'apnews.com' },
  { id: 8, name: 'CNN', category: 'news', url: 'https://www.cnn.com/', use: 'read', cookieDomain: 'cnn.com' },
  { id: 9, name: 'The New York Times', category: 'news', url: 'https://www.nytimes.com/', use: 'read', cookieDomain: 'nytimes.com' },
  { id: 10, name: 'Amazon', category: 'shopping', url: 'https://www.amazon.com/', use: 'read', cookieDomain: 'amazon.com' },
  { id: 11, name: 'eBay', category: 'shopping', url: 'https://www.ebay.com/', use: 'read', cookieDomain: 'ebay.com' },
  { id: 12, name: 'Walmart', category: 'shopping', url: 'https://www.walmart.com/', use: 'read', cookieDomain: 'walmart.com' },
  { id: 13, name: 'Chase sign-in', category: 'banking', url: 'https://secure.chase.com/web/auth/dashboard', use: 'login', cookieDomain: 'chase.com' },
  { id: 14, name: 'Bank of America sign-in', category: 'banking', url: 'https://secure.bankofamerica.com/login/sign-in/signOnV2Screen.go', use: 'login', cookieDomain: 'bankofamerica.com' },
  { id: 15, name: 'PayPal sign-in', category: 'banking', url: 'https://www.paypal.com/signin', use: 'login', cookieDomain: 'paypal.com' },
  { id: 16, name: 'Google Maps', category: 'maps', url: 'https://www.google.com/maps', use: 'maps', cookieDomain: 'google.com' },
  { id: 17, name: 'Google Docs', category: 'docs', url: 'https://docs.google.com/', use: 'login', cookieDomain: 'google.com' },
  { id: 18, name: 'Wikipedia', category: 'reference', url: 'https://en.wikipedia.org/wiki/Main_Page', use: 'read', cookieDomain: 'wikipedia.org' },
  { id: 19, name: 'Facebook', category: 'social', url: 'https://www.facebook.com/', use: 'login', cookieDomain: 'facebook.com' },
  { id: 20, name: 'Reddit', category: 'social', url: 'https://www.reddit.com/', use: 'read', cookieDomain: 'reddit.com' },
];

/**
 * Not one of the 20: a video that plays, for TD-46's video GB/h, since YouTube asks a cloud address to sign in. The same film,
 * from Wikimedia Commons' own player, at the size the file page shows it. Run it with REAL_SITES_ONLY=21.
 */
export const EXTRA: Site[] = [
  { id: 21, name: 'Wikimedia Commons video (GB/h only)', category: 'video, extra', url: 'https://commons.wikimedia.org/wiki/File:Big_Buck_Bunny_4K.webm', use: 'video', cookieDomain: 'wikimedia.org' },
];

/** REAL_SITES_ONLY: ids and ranges, such as `1-10` or `5,7`. The extra (21) runs only when named. */
export function pick(only: string | undefined): Site[] {
  if (!only) return SITES;
  const all = [...SITES, ...EXTRA];
  const want = new Set<number>();
  for (const part of only.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`REAL_SITES_ONLY: ids and ranges, such as 1-10 or 5,7, not ${part}`);
    for (let i = Number(m[1]); i <= Number(m[2] ?? m[1]); i++) want.add(i);
  }
  return all.filter((s) => want.has(s.id));
}
