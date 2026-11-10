// Pure rules for a Guild Desk in the office (task 48): its panel's id, its apps, who may see what, and the words for its
// limits and usage. No store, no network, so every rule has a test (`panel.test.ts`).
import type { AppId } from '../canvas/layout';
import type { VmState } from '../desk/agentStatus';
import type { GuildAgentLimits, GuildMine, GuildRole, GuildSettings } from './api';

/** A member is in at most this many guilds (`maxGuildsPerMember`), so the office holds at most this many Guild Desks. */
export const MAX_GUILDS = 3;

/** The office's own id for a guild's panel. The Guild Desk's real desk id comes later, from Platform, and may change. */
export const guildPanelId = (guildId: string): string => `guild-${guildId}`;
export const guildIdOfPanel = (panelId: string): string | null => (panelId.startsWith('guild-') && panelId.length > 6 ? panelId.slice(6) : null);
export const isGuildPanel = (panelId: string): boolean => guildIdOfPanel(panelId) !== null;

/** A Guild Desk's apps, in their tile order. No Browser, ever: a link offers the member's own desks instead. */
export const GUILD_APPS: readonly AppId[] = ['commons', 'notebook', 'agent'];

/** The guilds the member is in, as many as the office shows, in the order identity gave. */
export function myGuilds(list: readonly GuildMine[] | null | undefined): GuildMine[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((g) => g && typeof g.guildId === 'string' && g.guildId && typeof g.name === 'string' && g.joined !== false && isRole(g.role))
    .slice(0, MAX_GUILDS);
}

const isRole = (r: unknown): r is GuildRole => r === 'lead' || r === 'officer' || r === 'member';

/** The Guild Desk's state as the office's other desks have theirs. `none` provisions on the first open, which is a wake. */
export function guildVm(state: string | null | undefined): VmState {
  switch (state) {
    case 'none':
    case 'stopped':
      return 'stopped';
    case 'running':
      return 'running';
    case 'stopping':
      return 'stopping';
    case 'provisioning':
    case 'starting':
      return 'starting';
    case undefined:
    case null:
      return 'unknown';
    default:
      return 'starting';
  }
}

/** The agent limits: the Founder, or an Officer the Founder gave `manage_agents`. */
export const mayManageAgents = (role: GuildRole | null | undefined, grants: readonly string[] | null | undefined): boolean =>
  role === 'lead' || (role === 'officer' && !!grants?.includes('manage_agents'));

/** Usage per member, by name: the Founder and every Officer. */
export const maySeeUsage = (role: GuildRole | null | undefined): boolean => role === 'lead' || role === 'officer';

/** The draft ADR's defaults (section 7), for a guild whose desk hasn't said yet. */
export const DEFAULT_LIMITS: GuildAgentLimits = {
  perMember: { runsPerDay: 20, usdPerDay: 1, usdPerMonth: 10 },
  perGuild: { usdPerMonth: 50, runsAtOnce: 2 },
  tools: { read: true, search: true, edit: true, post: true, boards: true },
  ownKeys: false,
};

/**
 * What deskd keeps in the settings but doesn't act on yet (API.md, "A guild desk"): agents have no tools, and members can't add
 * keys of their own. Both stay in the object a save sends, as they were, and their switches show once the desk does them.
 */
export const AGENT_TOOLS_LIVE = false;
export const MEMBER_KEYS_LIVE = false;

/** `guild.settings.get`'s or `.set`'s answer, with the defaults for anything a desk left out. */
export function limitsOf(s: GuildSettings | null | undefined): GuildAgentLimits {
  const a = (s?.agents ?? {}) as Partial<GuildAgentLimits>;
  return {
    perMember: { ...DEFAULT_LIMITS.perMember, ...a.perMember },
    perGuild: { ...DEFAULT_LIMITS.perGuild, ...a.perGuild },
    tools: { ...DEFAULT_LIMITS.tools, ...a.tools },
    ownKeys: a.ownKeys === true,
  };
}

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

export const runs = (n: number): string => (n === 1 ? '1 run' : `${Number.isFinite(n) && n > 0 ? Math.round(n) : 0} runs`);

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
