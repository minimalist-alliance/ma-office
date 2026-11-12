// The catalog as `apps.catalog.get` gives it (deskd API.md section 19; deskd checks it, never the Desk app, and the Desk app
// never fetches it), read leniently: unknown fields are ignored, and what's shown is untrusted text, cut to length.
// `bundled`, `line`, `about` and `credits` are read where present: `bundled` is deskd's for a first-party app in its own image
// (the Bible); the other three aren't in the index yet (ADR 0054 lists them for the Desk Engineer and Platform), so a row falls
// back to `description` for its line and its detail.
import { hidesSamples, isSampleApp } from './ids';

export interface NetHost {
  host: string;
  why: string;
}

export interface CatalogVersion {
  version: string;
  packageSha256: string;
  bytes: number;
  permissions: string[];
  net: NetHost[];
  installable: boolean;
  reason: string | null;
}

export interface CatalogApp {
  id: string;
  name: string;
  publisher: string;
  /** The one line under the name: `line` where the index has it, else `description`. */
  line: string;
  /** The detail's words: `about` where the index has it, else `description`. */
  about: string;
  credits: string[];
  bundled: boolean;
  /** The version a tap adds: the newest that can be added, else the newest, which says why it can't. */
  version: CatalogVersion | null;
}

export interface Catalog {
  available: boolean;
  reason: string | null;
  /** Null: deskd has no catalog to give (API.md section 19), which reads as "No apps to add right now". */
  apps: CatalogApp[] | null;
  revokedKeys: Set<string>;
  revokedManifests: Set<string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const strings = (v: unknown, max: number, each: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max).map((x) => x.slice(0, each)) : []);
const SEMVER = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;

/** Ordering by MAJOR.MINOR.PATCH; anything else sorts first. */
export function compareVersions(a: string, b: string): number {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return d;
  }
  return 0;
}

function versionOf(v: unknown): CatalogVersion | null {
  if (!isObj(v) || typeof v['version'] !== 'string' || typeof v['packageSha256'] !== 'string') return null;
  return {
    version: v['version'].slice(0, 32),
    packageSha256: v['packageSha256'].slice(0, 64),
    bytes: typeof v['bytes'] === 'number' && Number.isFinite(v['bytes']) ? v['bytes'] : 0,
    permissions: strings(v['permissions'], 16, 32),
    net: (Array.isArray(v['net']) ? v['net'] : []).flatMap((n: unknown) => (isObj(n) && typeof n['host'] === 'string' ? [{ host: str(n['host'], 253), why: str(n['why'], 140) }] : [])),
    installable: v['installable'] !== false,
    reason: typeof v['reason'] === 'string' ? v['reason'].slice(0, 32) : null,
  };
}

/** The newest version that can be added, else the newest. */
export function pickVersion(versions: readonly CatalogVersion[]): CatalogVersion | null {
  const newest = (list: readonly CatalogVersion[]): CatalogVersion | null => list.reduce<CatalogVersion | null>((best, v) => (!best || compareVersions(v.version, best.version) > 0 ? v : best), null);
  return newest(versions.filter((v) => v.installable)) ?? newest(versions);
}

function appOf(v: unknown): CatalogApp | null {
  if (!isObj(v) || typeof v['id'] !== 'string' || (hidesSamples() && isSampleApp(v['id']))) return null;
  const versions = (Array.isArray(v['versions']) ? v['versions'] : []).flatMap((x: unknown) => {
    const r = versionOf(x);
    return r ? [r] : [];
  });
  const description = str(v['description'], 140);
  return {
    id: v['id'].slice(0, 64),
    name: str(v['name'], 32) || 'App',
    publisher: str(v['publisher'], 64),
    line: str(v['line'], 80) || description,
    about: str(v['about'], 1200) || description,
    credits: strings(v['credits'], 8, 200),
    bundled: v['bundled'] === true,
    version: pickVersion(versions),
  };
}

/** `apps.catalog.get`'s result. */
export function parseCatalog(res: unknown): Catalog {
  const r = isObj(res) ? res : {};
  const cat = isObj(r['catalog']) ? r['catalog'] : null;
  const revoked = cat && isObj(cat['revoked']) ? cat['revoked'] : {};
  return {
    available: r['available'] === true,
    reason: typeof r['reason'] === 'string' ? r['reason'] : null,
    apps: cat ? (Array.isArray(cat['apps']) ? cat['apps'] : []).flatMap((a: unknown) => {
      const app = appOf(a);
      return app ? [app] : [];
    }) : null,
    revokedKeys: new Set(strings(revoked['keys'], 256, 16)),
    revokedManifests: new Set(strings(revoked['packages'], 4096, 64)),
  };
}

/** An error's code and `details.reason`, as deskd gives them. */
export function codeOf(err: unknown): { code: string; reason: string | null } {
  const e = err as { code?: unknown; details?: { reason?: unknown } } | null;
  return { code: typeof e?.code === 'string' ? e.code : '', reason: typeof e?.details?.reason === 'string' ? e.details.reason : null };
}
