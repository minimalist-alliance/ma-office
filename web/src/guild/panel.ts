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

/** Notebooks and tabs on a Guild Desk (the space structure): the Founder, or an Officer with `manage_spaces`. Pages stay open to every member. */
export const mayManageSpaces = (role: GuildRole | null | undefined, grants: readonly string[] | null | undefined): boolean =>
  role === 'lead' || !!grants?.includes('manage_spaces');

/** Usage per member, by name: the Founder and every Officer. */
export const maySeeUsage = (role: GuildRole | null | undefined): boolean => role === 'lead' || role === 'officer';

/** The draft ADR's defaults (section 7), for a guild whose desk hasn't said yet. */
export const DEFAULT_LIMITS: GuildAgentLimits = {
  perMember: { runsPerDay: 20, usdPerDay: 1, usdPerMonth: 10 },
  perGuild: { usdPerMonth: 50, runsAtOnce: 2 },
  tools: { read: true, search: true, edit: true, post: true, boards: true },
  ownKeys: false,
};

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

export const runs = (n: number): string => (n === 1 ? '1 run' : `${Number.isFinite(n) && n > 0 ? Math.round(n) : 0} runs`);
