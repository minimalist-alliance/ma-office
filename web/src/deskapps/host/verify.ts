// The window's checks before anything is built (contract 3.2, the Desk Engineer review's C3, ADR 0054): `apps.view.get` gives
// the manifest and `ma-app.sig` exactly as signed, and the view's three files. The review signature over the manifest's exact
// bytes must check with one of MA's public review keys, and each file's SHA-256 and size must be the manifest's. A bundled
// first-party app (deskd's own image: `signatures: null, bundled: true`) is taken on its file hashes alone, since deskd is what
// the Desk app already trusts for everything on the desk. Anything off, and nothing is built.
// WebCrypto only: Ed25519, and ECDSA P-256 over SHA-256 with the key service's DER signatures.

export type Tier = 'first-party' | 'community';

/** One of MA's public review keys, as the Desk app ships it: base64 SubjectPublicKeyInfo (DER). */
export interface ReviewKey {
  tier: Tier;
  spki: string;
}

/** What a verified view gives the frame and the bridge. */
export interface VerifiedView {
  id: string;
  version: string;
  html: string;
  script: string;
  style: string;
  /** Base64 SHA-256 of the script's and the style's bytes, for the frame's policy and the script's integrity. */
  scriptHash: string;
  styleHash: string;
  /** Declared methods, `true` for a mutation, and declared topics: the bridge refuses anything else. */
  methods: ReadonlyMap<string, boolean>;
  topics: ReadonlySet<string>;
  /** The review signature's tier, or `bundled`. */
  trust: Tier | 'bundled';
  /** The manifest's SHA-256, hex. */
  manifestSha256: string;
}

export type Verdict = { ok: true; view: VerifiedView } | { ok: false; why: string };

/** Checking options: the app the window is for, and what the catalog says is revoked. */
export interface VerifyOptions {
  appId: string;
  revokedKeys?: ReadonlySet<string>;
  revokedManifests?: ReadonlySet<string>;
}

/** The view's files may total at most this (contract 3.2). */
export const MAX_VIEW_BYTES = 512 * 1024;
/** Only MA's own apps come bundled in deskd's image. */
const FIRST_PARTY_PREFIX = 'com.minimalistalliance.';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const enc = new TextEncoder();

const hex = (b: ArrayBuffer | Uint8Array): string => Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

export function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

const digest = async (bytes: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));

/** A key's id (C3): the first 8 bytes of SHA-256 over its SubjectPublicKeyInfo, as 16 hex digits, for both key types. */
export async function keyIdOf(spki: Uint8Array): Promise<string> {
  return hex((await digest(spki)).subarray(0, 8));
}

/** A DER ECDSA signature (SEQUENCE of two INTEGERs) as the 64 raw bytes WebCrypto checks. Null if it isn't one. */
export function derToRaw(der: Uint8Array): Uint8Array | null {
  let i = 0;
  if (der[i++] !== 0x30) return null;
  let len = der[i++]!;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n !== 1) return null;
    len = der[i++]!;
  }
  if (i + len !== der.length) return null;
  const out = new Uint8Array(64);
  for (let k = 0; k < 2; k += 1) {
    if (der[i++] !== 0x02) return null;
    const n = der[i++]!;
    if (n < 1 || n > 33 || i + n > der.length) return null;
    let int = der.subarray(i, i + n);
    i += n;
    while (int.length > 32 && int[0] === 0) int = int.subarray(1);
    if (int.length > 32) return null;
    out.set(int, k * 32 + (32 - int.length));
  }
  return i === der.length ? out : null;
}

interface LoadedKey {
  keyId: string;
  tier: Tier;
  key: CryptoKey;
  ec: boolean;
}

/** The trusted keys, imported once per list. A key that isn't Ed25519 or P-256 is left out, as deskd leaves it. */
const loaded = new WeakMap<readonly ReviewKey[], Promise<LoadedKey[]>>();
export function loadKeys(keys: readonly ReviewKey[]): Promise<LoadedKey[]> {
  let p = loaded.get(keys);
  if (!p) {
    p = Promise.all(
      keys.map(async (k): Promise<LoadedKey | null> => {
        try {
          const der = fromBase64(k.spki);
          const keyId = await keyIdOf(der);
          try {
            return { keyId, tier: k.tier, ec: false, key: await crypto.subtle.importKey('spki', der as BufferSource, { name: 'Ed25519' }, false, ['verify']) };
          } catch {
            return { keyId, tier: k.tier, ec: true, key: await crypto.subtle.importKey('spki', der as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']) };
          }
        } catch {
          return null;
        }
      }),
    ).then((list) => list.filter((k): k is LoadedKey => k !== null));
    loaded.set(keys, p);
  }
  return p;
}

async function checks(k: LoadedKey, data: Uint8Array, sig: Uint8Array): Promise<boolean> {
  try {
    if (!k.ec) return sig.length === 64 && (await crypto.subtle.verify({ name: 'Ed25519' }, k.key, sig as BufferSource, data as BufferSource));
    const raw = derToRaw(sig);
    return !!raw && (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k.key, raw as BufferSource, data as BufferSource));
  } catch {
    return false;
  }
}

/** `ma-app.sig`'s review signatures, `{signatures: [{role, keyId, sig}]}` (deskd `AppKeys.parseSignatures`). */
function reviewSignatures(text: string): { keyId: string; sig: Uint8Array }[] | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(json) || !Array.isArray(json['signatures'])) return null;
  const out: { keyId: string; sig: Uint8Array }[] = [];
  for (const s of json['signatures'].slice(0, 8)) {
    if (!isObj(s) || s['role'] !== 'review' || typeof s['keyId'] !== 'string' || !/^[0-9a-f]{16}$/.test(s['keyId']) || typeof s['sig'] !== 'string' || s['sig'].length > 512) continue;
    try {
      out.push({ keyId: s['keyId'], sig: fromBase64(s['sig']) });
    } catch {
      // not base64: not a signature
    }
  }
  return out;
}

const fail = (why: string): Verdict => ({ ok: false, why });

/** Check `apps.view.get`'s answer for this app. */
export async function verifyView(raw: unknown, keys: readonly ReviewKey[], opts: VerifyOptions): Promise<Verdict> {
  if (!isObj(raw) || raw['id'] !== opts.appId || typeof raw['manifest'] !== 'string' || !isObj(raw['files'])) return fail('shape');
  const manifestText = raw['manifest'];
  const manifestBytes = enc.encode(manifestText);
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return fail('manifest');
  }
  if (!isObj(manifest) || manifest['id'] !== opts.appId || (typeof raw['version'] === 'string' && manifest['version'] !== raw['version'])) return fail('manifest');
  const views = isObj(manifest['views']) ? manifest['views'] : null;
  const win = views && isObj(views['window']) ? views['window'] : null;
  const declared = isObj(manifest['files']) ? manifest['files'] : null;
  if (!win || !declared) return fail('manifest');
  const paths = { html: win['html'], script: win['script'], style: win['style'] };
  if (typeof paths.html !== 'string' || typeof paths.script !== 'string' || typeof paths.style !== 'string') return fail('manifest');
  const manifestSha256 = hex(await digest(manifestBytes));
  if (opts.revokedManifests?.has(manifestSha256)) return fail('revoked');

  // Trust: a bundled first-party app on its hashes alone, anything else by a review signature that checks.
  let trust: Tier | 'bundled';
  if (raw['bundled'] === true && raw['signatures'] === null) {
    if (!opts.appId.startsWith(FIRST_PARTY_PREFIX)) return fail('bundled');
    trust = 'bundled';
  } else {
    if (typeof raw['signatures'] !== 'string') return fail('signature');
    const sigs = reviewSignatures(raw['signatures']);
    if (!sigs) return fail('signature');
    const trusted = (await loadKeys(keys)).filter((k) => !opts.revokedKeys?.has(k.keyId));
    let tier: Tier | null = null;
    for (const s of sigs) {
      const k = trusted.find((t) => t.keyId === s.keyId);
      // Two review signatures of different tiers give the lower one (C3).
      if (k && (await checks(k, manifestBytes, s.sig))) tier = tier === 'community' || k.tier === 'community' ? 'community' : 'first-party';
    }
    if (!tier) return fail('signature');
    trust = tier;
  }

  // Every file given is one the manifest names for the window, with its exact hash and size, and nothing else.
  const given = raw['files'];
  const wanted = new Set([paths.html, paths.script, paths.style]);
  if (Object.keys(given).some((p) => !wanted.has(p))) return fail('files');
  const text: Record<string, string> = {};
  const hashes: Record<string, string> = {};
  let total = 0;
  for (const p of wanted) {
    const body = given[p];
    const entry = declared[p];
    if (typeof body !== 'string' || !isObj(entry) || typeof entry['sha256'] !== 'string') return fail('files');
    const bytes = enc.encode(body);
    total += bytes.length;
    const sum = await digest(bytes);
    if (hex(sum) !== entry['sha256'] || (typeof entry['size'] === 'number' && entry['size'] !== bytes.length)) return fail('hash');
    text[p] = body;
    hashes[p] = base64(sum);
  }
  if (total > MAX_VIEW_BYTES) return fail('size');

  const methods = new Map<string, boolean>();
  for (const m of Array.isArray(manifest['methods']) ? manifest['methods'] : []) {
    if (isObj(m) && typeof m['name'] === 'string') methods.set(m['name'], m['mutation'] === true);
  }
  const topics = new Set((Array.isArray(manifest['topics']) ? manifest['topics'] : []).filter((t): t is string => typeof t === 'string'));
  return {
    ok: true,
    view: {
      id: opts.appId,
      version: typeof manifest['version'] === 'string' ? manifest['version'] : '',
      html: text[paths.html]!,
      script: text[paths.script]!,
      style: text[paths.style]!,
      scriptHash: hashes[paths.script]!,
      styleHash: hashes[paths.style]!,
      methods,
      topics,
      trust,
      manifestSha256,
    },
  };
}
