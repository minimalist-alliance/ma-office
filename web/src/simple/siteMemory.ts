// The member's choice of view, per site, kept on the desk (design 7.4: "A per-site preference is stored on the desk").
//
// Security review T47-9: a list of sites is browsing history, so it lives in `deskd` only, beside Chromium's own, where
// its expiry and the member's "clear history" reach it. This office keeps none of it in the layout document,
// localStorage or IndexedDB. What it has asked is held here, in memory, for this window's life and no longer.
import type { SiteChoice } from './decide';

/**
 * The desk's side. `get` answers the member's choice, null for a site they never chose for, and the site as the desk
 * keys it: its registrable domain (`news.example.co.uk` is `example.co.uk`, section 14), or null if it didn't say.
 */
export interface SiteChoiceStore {
  get(site: string): Promise<{ choice: SiteChoice | null; domain: string | null }>;
  set(site: string, choice: SiteChoice | null): Promise<void>;
}

/** A registrable domain as the desk gave it: a host's shape and nothing else, since it's shown as the site's name. */
const DOMAIN = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)*$/;

/**
 * A page's site, for its memory: its host, lowercase and in its `xn--` form, as `deskd`'s `SiteMemory.hostOf` keys it
 * (`sub/minified-stage-a`). Null for anything but http(s), which has no site to remember. The Designer's spec says per
 * eTLD+1; which one wins is the Desk Engineer's call, and the client only ever passes the host.
 */
export function siteOf(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.hostname.toLowerCase() || null;
}

export class SiteMemory {
  /** Undefined: not asked yet. A pending ask is in `asking`. */
  private readonly known = new Map<string, SiteChoice | null>();
  private readonly asking = new Set<string>();
  private readonly listeners = new Set<() => void>();
  /** Bumped on each change the member makes, so an older answer from the desk never overwrites it. */
  private readonly version = new Map<string, number>();
  /** Each host's registrable domain, as the desk said it. */
  private readonly domains = new Map<string, string>();

  constructor(private readonly store: SiteChoiceStore) {}

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  /** What's known now. Undefined means the desk is being asked, and listeners hear when it answers. */
  choice(site: string | null): SiteChoice | null | undefined {
    if (!site) return null;
    if (this.known.has(site)) return this.known.get(site) ?? null;
    if (!this.asking.has(site)) this.ask(site);
    return undefined;
  }

  private ask(site: string): void {
    this.asking.add(site);
    const v = this.version.get(site) ?? 0;
    this.store.get(site).then(
      ({ choice, domain }) => {
        this.asking.delete(site);
        const d = typeof domain === 'string' ? domain.toLowerCase() : '';
        // Only a domain the host ends with: the desk names the site, it never renames it.
        if (DOMAIN.test(d) && (site === d || site.endsWith(`.${d}`))) this.domains.set(site, d);
        if ((this.version.get(site) ?? 0) !== v) return;
        this.known.set(site, choice === 'simple' || choice === 'full' ? choice : null);
        this.changed();
      },
      () => {
        // The desk couldn't say: no choice, for now. It's asked again next time this window looks.
        this.asking.delete(site);
        if ((this.version.get(site) ?? 0) !== v) return;
        this.known.set(site, null);
        this.changed();
        this.known.delete(site);
      },
    );
  }

  /** A host's registrable domain, once the desk has said it (security review T47O-3). Undefined until then. */
  domain(host: string | null): string | undefined {
    return host ? this.domains.get(host.toLowerCase()) : undefined;
  }

  /** The member chose. Shown at once; the desk keeps it. A failure to keep it is quiet: it still holds in this window. */
  remember(site: string | null, choice: SiteChoice | null): Promise<void> {
    if (!site) return Promise.resolve();
    this.version.set(site, (this.version.get(site) ?? 0) + 1);
    this.known.set(site, choice);
    this.changed();
    return this.store.set(site, choice).catch(() => undefined);
  }

  /** Forget what was asked, as on a new session, where the desk may have cleared its history. */
  reset(): void {
    this.known.clear();
    this.changed();
  }
}
