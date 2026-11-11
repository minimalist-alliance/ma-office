// GET /v1/client-config?app=desk-web. Auth and asset URLs follow the calling origin, so they
// are read from here and never hard-coded (contract hostnames.md, auth.md section 2).
import { currentApiBase, siblingUrl } from './hosts';

export interface ClientConfig {
  env?: string;
  version?: string;
  assetBase?: string;
  api: string;
  gateway?: string;
  auth: {
    domain: string;
    clientId: string;
    redirectUri: string;
    logoutUri: string;
    scopes: string[];
    identityProviders?: string[];
    googleSignIn?: boolean;
    /** Our own sign-in pages on this host, such as "/_signin/" (ma-platform web/signin). Absent: managed login, which is also the rollback. */
    signInPath?: string;
  };
  links?: Record<string, string>;
  /** Support Maia's member routes (ma-platform contract maia.md). Absent, as in prod today: no widget and no Maia request at all (`maia/gate.ts`). */
  maia?: { url: string };
  /** The Files app's kill switch (draft ADR "Files app", decision 11). Absent or `enabled: true` is on; `false` hides the tile. */
  files?: { enabled?: boolean };
  /** The export page and the move (ma-platform draft ADR "data export and transfer", section 7). Absent is off. */
  export?: { enabled?: boolean; moves?: boolean };
  /**
   * The tiers' display names, the owner's one setting (contract tiers.md section 3): `{ alliance, officer, lead }`. Read
   * only through `tierNamesFrom`, which keeps the contract's defaults for anything missing, as in prod until it ships.
   */
  tierNames?: unknown;
  /** Teens in the Alliance tier (ma-platform contract age.md, section 3). Absent is off, as in prod until that tier opens. */
  ageRules?: { enabled?: boolean; minimumAge?: number; adultAge?: number };
  /**
   * The Browser's simple view (task 47, ADR 0030): pages rendered here from their structure. A kill switch: absent is on,
   * `{ enabled: false }` is off (`simple/decide.ts`).
   */
  simpleView?: { enabled?: boolean };
  /**
   * Links in and out (#9, S-141): the desk's hand-off card, `/open` and a pasted link (Send to my desk), and a download's
   * "Get it on this device". A kill switch: absent is on, `{ enabled: false }` is off (`open/intent.ts` `linksOn`). Open on
   * this device (the address's button) stays: it needs nothing from anyone.
   */
  browserLinks?: { enabled?: boolean };
  /** Open tiles (ADR 0053): an app enlarged on its desk is the live app there. A kill switch: absent is on (`opentile/door.ts`). */
  openTiles?: { enabled?: boolean };
}

/** The member's account page on the Platform app, if client-config gives a good one. */
export function accountUrl(cfg: ClientConfig, hostname: string = window.location.hostname): string | null {
  return siblingUrl(cfg.links?.['account'], hostname)?.href ?? null;
}

/**
 * The billing page, where a failed payment is paid (card C's "Update payment"): client-config's `links.billing`, else
 * `/v1/me`'s `membership.billingUrl`, whichever is a good one first.
 */
export function billingUrl(cfg: ClientConfig | null, fromMe?: string | null, hostname: string = window.location.hostname): string | null {
  return (siblingUrl(cfg?.links?.['billing'], hostname) ?? siblingUrl(fromMe, hostname))?.href ?? null;
}

/** The office's own export page, where client-config turns it on (`App.tsx`); null where it's off or unknown. */
export function exportPageUrl(cfg: ClientConfig | null): string | null {
  return cfg?.export?.enabled === true ? '/export' : null;
}

/**
 * The Platform app's page for reporting a safety concern (contract age.md, section 10), only where the age rules are
 * on. Client-config has no link of its own for it, so it's found beside the account page, on the same sibling host.
 */
export function reportUrl(cfg: ClientConfig, hostname: string = window.location.hostname): string | null {
  if (cfg.ageRules?.enabled !== true) return null;
  const account = siblingUrl(cfg.links?.['account'], hostname);
  return account ? new URL('/report', account).href : null;
}

/** The one support mailbox, when client-config has no address of its own. */
export const SUPPORT_ADDRESS = 'support@minimalistalliance.com';

/**
 * The support address a desk that can't be opened shows. Contract desks.md has no field for an address: `links.support`
 * is a page, so only a `mailto:` there counts. Anything else is the one mailbox.
 */
export function supportAddress(cfg: ClientConfig | null): string {
  const raw = cfg?.links?.['support'];
  if (typeof raw !== 'string' || !raw.startsWith('mailto:')) return SUPPORT_ADDRESS;
  let address: string;
  try {
    address = decodeURIComponent(raw.slice(7).split('?')[0] ?? '');
  } catch {
    return SUPPORT_ADDRESS; // a malformed escape
  }
  return /^[^\s@<>"(),;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(address) ? address : SUPPORT_ADDRESS;
}

/** Client-config, checked enough to use: it must say where the API and sign-in are. Null for anything else. */
export function usableConfig(v: unknown): ClientConfig | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Partial<ClientConfig> & { app?: unknown };
  if (c.app !== undefined && c.app !== 'desk-web') return null;
  return typeof c.api === 'string' && c.auth && typeof c.auth === 'object' && typeof c.auth.domain === 'string' && typeof c.auth.clientId === 'string'
    ? (v as ClientConfig)
    : null;
}

/**
 * The loader's own answer from this page load, if it handed one over (`window.__maClientConfig`, ma-platform
 * `sites/desk-loader/loader.js`): it asked the same question a moment ago to pick this bundle, so the first ask here
 * needn't go out again, and the token refresh, `/v1/me` and the desk list don't wait for it. Taken once.
 */
function fromLoader(): ClientConfig | null {
  try {
    const w = window as unknown as { __maClientConfig?: unknown };
    const handed = w.__maClientConfig;
    delete w.__maClientConfig;
    return usableConfig(handed);
  } catch {
    return null;
  }
}

let loaded: ClientConfig | null = null;
/** The config once it has loaded, for what can't wait for a promise. */
export const loadedConfig = (): ClientConfig | null => loaded;

let cached: Promise<ClientConfig> | null = null;

/** A fresh copy, every time: what a reload would get. The loader asks the same question to pick the bundle. */
export async function fetchClientConfig(signal?: AbortSignal): Promise<ClientConfig> {
  const base = currentApiBase();
  if (!base) throw new Error('This host is not a Desk host');
  const res = await fetch(`${base}/v1/client-config?app=desk-web`, { cache: 'no-store', ...(signal ? { signal } : {}) });
  if (!res.ok) throw new Error(`client-config -> ${res.status}`);
  return (await res.json()) as ClientConfig;
}

export function getClientConfig(): Promise<ClientConfig> {
  const handed = cached ? null : fromLoader();
  cached ??= (handed ? Promise.resolve(handed) : fetchClientConfig())
    .then((cfg) => {
      loaded = cfg;
      return cfg;
    })
    .catch((err: unknown) => {
      cached = null; // the next attempt starts over
      throw err;
    });
  return cached;
}
