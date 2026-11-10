// The three memberships and what a person reads for each (ma-platform contract tiers.md, 0.3.25, ADR 0100). Pure.
// Ids never change when a name does: code reads `alliance`, `officer` and `lead`, and every word a member reads comes
// from client-config's `tierNames`, the owner's one setting, with the contract's defaults where it's missing. Nothing
// here or anywhere else in the app hard-codes a tier's name. Sentences put a name on its own: no article, plural or
// possessive in front of it, never lower-cased, so any name the owner picks reads right.

export type TierId = 'alliance' | 'officer' | 'lead';
export type TierNames = Readonly<Record<TierId, string>>;
/** The tier whose badge shows on a member's avatar: `alliance` has none. */
export type BadgeId = 'officer' | 'lead';

export const TIER_IDS: readonly TierId[] = ['alliance', 'officer', 'lead'];

/** The contract's defaults (section 2): what every reader shows while the setting is missing or unreadable. */
export const DEFAULT_TIER_NAMES: TierNames = { alliance: 'Alliance Member', officer: 'Officer', lead: 'Founder' };

/** The setting's own rule for a name (section 2), read leniently: what Platform wrote is shown, only nonsense isn't. */
const MAX_NAME = 24;
// Control characters, which no name may hold. Built from code points so the source holds none.
const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`);
function usable(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.trim();
  const length = Array.from(name).length;
  return length >= 1 && length <= MAX_NAME && !CONTROL.test(name) ? name : null;
}

/** `tierNames` from client-config. Each name that's missing or can't be used falls back to its default; no reader ever fails over names. */
export function tierNamesFrom(raw: unknown): TierNames {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    alliance: usable(r['alliance']) ?? DEFAULT_TIER_NAMES.alliance,
    officer: usable(r['officer']) ?? DEFAULT_TIER_NAMES.officer,
    lead: usable(r['lead']) ?? DEFAULT_TIER_NAMES.lead,
  };
}

/**
 * `membership.tier` as the contract reads it, before and after the migration ("Until the migration has run"): `member`,
 * or none at all, is `officer`; `alliance`, `officer` and `lead` are themselves. No row holds the old `officer` (the
 * guild leader) today, since approvals were never open, so `officer` needs no second meaning. Anything else is unknown:
 * null, so nothing is said rather than something wrong.
 */
export function readTier(raw: unknown): TierId | null {
  if (raw === undefined || raw === null || raw === 'member') return 'officer';
  return raw === 'alliance' || raw === 'officer' || raw === 'lead' ? raw : null;
}

/** `membership.badge` (section 5): `officer`, `lead` or nothing. Only Platform decides it, so a missing field is no badge. */
export function readBadge(raw: unknown): BadgeId | null {
  return raw === 'officer' || raw === 'lead' ? raw : null;
}

export interface MembershipLike {
  status?: string;
  tier?: string;
  badge?: string | null;
  comped?: boolean;
}

/** A membership that holds a tier right now: active, past due or canceling, or comped. Unpaid, ended and held don't. */
export function membershipLive(m: MembershipLike | null | undefined): boolean {
  if (!m) return false;
  return m.comped === true || m.status === 'active' || m.status === 'past_due' || m.status === 'canceling';
}

/** The tier a member holds now, or null: none while it isn't live, since an unpaid sign-up also reads as `officer`. */
export function liveTier(m: MembershipLike | null | undefined): TierId | null {
  return m && membershipLive(m) ? readTier(m.tier) : null;
}

/** Renaming their own desks comes with `officer` and `lead` (section 8). */
export const RENAMING_TIERS: readonly TierId[] = ['officer', 'lead'];
export const tierRenames = (tier: TierId | null): boolean => tier !== null && RENAMING_TIERS.includes(tier);

/**
 * Names joined for a sentence, as words.md's "for {officer} and {lead}" does, in the contract's order: "Officer or Founder".
 * Unknown ids are dropped, and nothing usable is the given fallback ids.
 */
export function namesList(ids: readonly unknown[], names: TierNames, fallback: readonly TierId[], joiner = 'or'): string {
  const known = TIER_IDS.filter((id) => ids.includes(id));
  const list = (known.length ? known : TIER_IDS.filter((id) => fallback.includes(id))).map((id) => names[id]);
  return list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} ${joiner} ${list[list.length - 1] ?? ''}`;
}
