// A desk's Courier address (the launch plan's Wave 2.7; the Designer's flows 1 and 2; ma-platform contract relay.md 0.4.0 §4):
// the member picks each desk's name on the platform's registry, and shares it with an invite link that carries this desk's
// fingerprint. In Courier's lazy chunk only.
//
// - The registry is Platform's, behind the member's own token: `GET /v1/me/courier`, a name's check, the `PUT` that takes it.
//   A name is never reused or given to anyone else, so there is no "Change address" (the help line says so).
// - The name field checks the shape here as the member types, then asks the registry 300 ms after the last key. The
//   shared-stem note is the office's own, against the member's other addresses; the registry has the last word.
// - The invite link: `https://<account site>/c/<name>#k=<fingerprint>&n=<display name>`. Everything after `#` stays in the
//   browser (a fragment is never sent), so the platform never learns which fingerprint a member shares or with whom. The
//   fingerprint is the contract's (relay.md §2.1, from `courier.keys`); the receiving desk checks the whole of it. The code
//   shown is exactly that fingerprint, its 8 groups of 4, the same on the account site's invite page (the Designer's call).
import { api, ApiError } from '../../platform/api';
import { accountUrl, loadedConfig } from '../../platform/clientConfig';

export interface DeskAddress {
  address: string;
  name: string;
}

export interface CourierDesk {
  deskId: string;
  /** The desk's own name ("Personal", "Work", a custom one), for "{Desk} desk". */
  name: string;
  kind: string;
  address: DeskAddress | null;
  /** Sealed messages waiting on the platform for this desk while it sleeps (up to 1,000). */
  pending: number;
}

export interface Registry {
  /** False while Courier is paused (the kill switch) or for a teen's account: no address setup then. */
  enabled: boolean;
  domain: string;
  desks: CourierDesk[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** A desk's name or the domain, as plain words: no hidden or reordering characters, never markup. */
const plainLine = (v: unknown, max: number): string => str(v).replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, max);
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const NAME = /^[a-z0-9](?:[a-z0-9.-]{1,30}[a-z0-9])$/;

function readAddress(v: unknown, domain: string): DeskAddress | null {
  const o = obj(v);
  const name = str(o?.['name']).toLowerCase();
  if (!NAME.test(name)) return null;
  return { name, address: `${name}@${domain}` };
}

/** `GET /v1/me/courier`, read field by field. Null when the registry isn't there (an older platform) or can't be read. */
export function readRegistry(v: unknown): Registry | null {
  const o = obj(v);
  const domain = str(o?.['domain']).toLowerCase();
  if (!o || !DOMAIN.test(domain)) return null;
  const desks: CourierDesk[] = [];
  for (const d of Array.isArray(o['desks']) ? o['desks'] : []) {
    const x = obj(d);
    const deskId = str(x?.['deskId']);
    if (!x || !/^[A-Za-z0-9_-]{1,64}$/.test(deskId)) continue;
    const pending = typeof x['pending'] === 'number' && Number.isFinite(x['pending']) ? Math.max(0, Math.min(1000, Math.floor(x['pending']))) : 0;
    desks.push({ deskId, name: plainLine(x['name'], 40), kind: plainLine(x['kind'], 20), address: readAddress(x['address'], domain), pending });
  }
  return { enabled: o['enabled'] === true, domain, desks };
}

export async function loadRegistry(): Promise<Registry | null> {
  try {
    return readRegistry((await api<unknown>('/v1/me/courier', { signal: AbortSignal.timeout(15_000) })).data);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the name's rules

export const NAME_MIN = 3;
export const NAME_MAX = 30;

/** Names kept for the service (the spec's list and the contract's §1), refused before the registry is asked. */
const RESERVED = new Set([
  'postmaster', 'abuse', 'hostmaster', 'webmaster', 'noc', 'security', 'info', 'support', 'marketing', 'sales', 'admin', 'administrator',
  'root', 'mailer-daemon', 'no-reply', 'noreply', 'courier', 'ma', 'minimalist', 'alliance', 'owner', 'staff', 'team', 'official', 'help',
  'billing', 'legal', 'privacy', 'system', 'maia', 'office', 'desk', 'guild', 'forums', 'member', 'officer', 'founder', 'lead', 'pro',
]);
/** Parts that read as MA's staff, and words no name may hold (the contract's skeleton rules, §1). */
const STAFF_PARTS = new Set(['admin', 'support', 'security', 'billing', 'help', 'helpdesk', 'staff', 'official', 'legal', 'privacy', 'abuse', 'postmaster', 'noreply', 'owner', 'maia', 'root', 'sysadmin', 'webmaster', 'hostmaster', 'verify', 'verification']);
const STARTS = ['minimalist', 'alliance', 'courier', 'support', 'security', 'official', 'postmaster', 'hostmaster', 'webmaster', 'mailerdaemon', 'noreply'];

/** The contract's skeleton: lower case, no dots or hyphens, `0` as `o`, `1` as `l`, `rn` as `m`, `vv` as `w`. */
export const skeleton = (name: string): string => name.toLowerCase().replace(/[.-]/g, '').replace(/0/g, 'o').replace(/1/g, 'l').replace(/rn/g, 'm').replace(/vv/g, 'w');

export type NameCheck = 'ok' | 'chars' | 'length' | 'reserved';

/** What the field says before asking anyone: its characters first, then its length, then a reserved name. */
export function checkShape(raw: string): NameCheck {
  const n = raw.toLowerCase();
  if (!/^[a-z0-9.-]*$/.test(n) || (n.length > 0 && !/^[a-z]/.test(n)) || /[.-]{2}/.test(n) || /[.-]$/.test(n)) return 'chars';
  if (n.length < NAME_MIN || n.length > NAME_MAX) return 'length';
  const sk = skeleton(n);
  if (RESERVED.has(n) || [...RESERVED].some((r) => skeleton(r) === sk)) return 'reserved';
  if (STARTS.some((w) => sk.startsWith(w)) || /minimalist|alliance|courier/.test(sk) || n.split(/[.-]/).some((p) => STAFF_PARTS.has(p))) return 'reserved';
  return 'ok';
}

/**
 * The shared-stem note (the spec's flow 1, still 02): the new name's first part (up to the first dot or hyphen, 4 letters or
 * more) is another of the member's desk names' first part, or the name starts with the whole of one. Returns that desk's name.
 */
export function sharedStem(raw: string, others: readonly Pick<CourierDesk, 'name' | 'address'>[]): string | null {
  const n = raw.toLowerCase();
  const first = (s: string): string => s.split(/[.-]/)[0] ?? '';
  for (const o of others) {
    const other = o.address?.name;
    if (!other) continue;
    const a = first(n);
    if ((a.length >= 4 && a === first(other)) || (n.length > other.length && n.startsWith(other))) return o.name;
  }
  return null;
}

export type Verdict = 'free' | 'taken' | 'reserved' | 'chars' | 'length' | 'shares_stem' | 'failed';

/** The registry's word on a name: 30 a minute per member, so the field asks 300 ms after the last key only. */
export async function askName(name: string, signal?: AbortSignal): Promise<Verdict> {
  try {
    const r = await api<unknown>(`/v1/me/courier/names/${encodeURIComponent(name.toLowerCase())}`, { signal: signal ?? AbortSignal.timeout(15_000) });
    const o = obj(r.data);
    if (o?.['available'] === true) return 'free';
    const why = str(o?.['reason']);
    return why === 'taken' ? 'taken' : why === 'reserved' ? 'reserved' : why === 'shares_stem' ? 'shares_stem' : why === 'invalid' ? 'chars' : 'failed';
  } catch {
    return 'failed';
  }
}

/** Takes the name for this desk. It can't be undone: the name is this desk's for good. */
export async function takeName(deskId: string, name: string): Promise<{ address: DeskAddress } | { verdict: Verdict }> {
  try {
    const r = await api<unknown>(`/v1/me/courier/desks/${encodeURIComponent(deskId)}/address`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.toLowerCase() }),
      signal: AbortSignal.timeout(15_000),
    });
    const o = obj(r.data);
    const address = str(obj(o?.['address'])?.['address']).toLowerCase();
    const at = address.lastIndexOf('@');
    const taken = at > 0 ? readAddress(obj(o?.['address']), address.slice(at + 1)) : null;
    return taken && DOMAIN.test(address.slice(at + 1)) ? { address: taken } : { verdict: 'failed' };
  } catch (e) {
    const code = e instanceof ApiError ? e.code : null;
    const verdict: Verdict = code === 'name_taken' || code === 'address_exists' ? 'taken' : code === 'name_reserved' ? 'reserved' : code === 'name_shares_stem' ? 'shares_stem' : code === 'invalid_name' ? 'chars' : 'failed';
    return { verdict };
  }
}

// ---------------------------------------------------------------- the fingerprint and the invite link

/** The contract's fingerprint (relay.md 0.4.0 §2.1): 8 groups of 4 lowercase hex digits, as `courier.keys` and `k=` carry it. */
const FINGERPRINT = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){7}$/;

/**
 * The fingerprint as members see it (the Designer's call, Nov 14): **exactly the code the invite link carries**, its 8 groups
 * of 4 in order, nothing derived or shortened, so "The code the link carries" is literally true and two people reading it
 * aloud compare what the desk checks. Null for anything that isn't the contract's fingerprint (then nothing is shown, and
 * no link is made either: `inviteLink` refuses the same shapes). A shown code that isn't the link's is a security bug;
 * `address.test.ts` holds the two together.
 */
export function shownFingerprint(fp: string | null): string[] | null {
  if (!fp || !FINGERPRINT.test(fp)) return null;
  return fp.split('-');
}

/** The `k=` an invite link carries, read back out of it: what the desk will check. Null for a link without one. */
export function linkFingerprint(link: string | null): string | null {
  if (!link) return null;
  const at = link.indexOf('#');
  if (at < 0) return null;
  const k = new URLSearchParams(link.slice(at + 1)).get('k');
  return k && FINGERPRINT.test(k) ? k : null;
}

/** The account site's origin, beside the account page client-config names. Null where it names none. */
export function siteOrigin(): string | null {
  const cfg = loadedConfig();
  const page = cfg ? accountUrl(cfg) : null;
  try {
    return page ? new URL(page).origin : null;
  } catch {
    return null;
  }
}

/**
 * The invite link, or null without a site, a name or a fingerprint. The name and fingerprint are the registry's and the
 * contract's own shapes; the display name goes encoded, cut to 40 characters. Nothing after `#` is ever sent to a server.
 */
export function inviteLink(origin: string | null, name: string, fp: string | null, displayName: string | null | undefined): string | null {
  if (!origin || !/^https?:\/\/[A-Za-z0-9.:[\]-]+$/.test(origin) || !NAME.test(name) || !fp || !FINGERPRINT.test(fp)) return null;
  const n = plainLine(displayName ?? '', 40).trim();
  return `${origin}/c/${name}#k=${fp}${n ? `&n=${encodeURIComponent(n)}` : ''}`;
}

/** The link as the box shows it: without `https://`. */
export const linkShown = (link: string): string => link.replace(/^https?:\/\//, '');
