// The guild settings sheet's own rules (`GuildSheet.tsx`, task 48): the agent limits' fields, what a save sends, and how
// the usage reads. Pure. In the sheet's own chunk, out of the first load since `sub/mm-js-budget`; what the office needs of a
// guild's limits before the sheet (`limitsOf`, `DEFAULT_LIMITS`, who may manage them) stays in `panel.ts`.
import type { GuildAgentLimits } from './api';

/**
 * What deskd keeps in the settings but doesn't act on yet (API.md, "A guild desk"): agents have no tools, and members can't add
 * keys of their own. Both stay in the object a save sends, as they were, and their switches show once the desk does them.
 */
export const AGENT_TOOLS_LIVE = false;
export const MEMBER_KEYS_LIVE = false;

export const TOOL_LABELS: Record<keyof GuildAgentLimits['tools'], string> = {
  read: 'Read pages',
  search: 'Search the guild',
  edit: 'Edit pages',
  post: 'Post in Commons',
  boards: 'Read boards',
};

/** A number field's problem in words, or null. Dollars to the cent, counts whole. Empty is no cap, where one may be left out. */
export function limitProblem(value: string, kind: 'usd' | 'count', max: number, nullable = false): string | null {
  const t = value.trim();
  if (!t) return nullable ? null : 'Enter a number.';
  if (kind === 'count' ? !/^\d+$/.test(t) : !/^\d+(\.\d{1,2})?$/.test(t)) return kind === 'count' ? 'Use a whole number.' : 'Use dollars and cents, like 2.50.';
  const n = Number(t);
  if (n > max) return `At most ${kind === 'usd' ? usd(max) : max}.`;
  if (kind === 'count' && n < 1) return 'At least 1.';
  return null;
}

/** What changed, or null if nothing did: whether there's anything to save. deskd takes the whole object on a set. */
export function limitsPatch(was: GuildAgentLimits, now: GuildAgentLimits): Partial<GuildAgentLimits> | null {
  const out: Record<string, unknown> = {};
  for (const group of ['perMember', 'perGuild', 'tools'] as const) {
    const a = was[group] as Record<string, unknown>;
    const b = now[group] as Record<string, unknown>;
    const changed = Object.fromEntries(Object.entries(b).filter(([k, v]) => a[k] !== v));
    if (Object.keys(changed).length) out[group] = changed;
  }
  if (was.ownKeys !== now.ownKeys) out['ownKeys'] = now.ownKeys;
  return Object.keys(out).length ? (out as Partial<GuildAgentLimits>) : null;
}

/** `$1.20`, `$0.04`, `$12`: cents only where there are some. */
export function usd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  const cents = Math.round(n * 100);
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/** A share of a limit, 0 to 1, for a quiet bar. Nothing to show without a limit. */
export const share = (used: number, limit: number): number => (limit > 0 && used > 0 ? Math.min(1, used / limit) : 0);

/** A time zone as people say it, "Mountain Time" for `America/Denver`, or the zone's own id where the browser has no name. */
export function zoneName(zone: string): string {
  if (/^(Etc\/)?(UTC|GMT|Zulu)$/.test(zone)) return 'UTC';
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longGeneric' }).formatToParts(0).find((p) => p.type === 'timeZoneName')?.value;
    return name || zone;
  } catch {
    return zone;
  }
}
