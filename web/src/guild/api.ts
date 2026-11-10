// The guild routes the office calls, typed from the Guild Engineer's contracts (`~/ma-coord/guild-eng.md` section 3, task 48):
// the member's guilds from identity (`GET /v1/guilds`, 3.1), and each guild's one shared Guild Desk from Platform's desks
// service (3.2). The desk-side shapes (`guild.hello`, `guild.settings.*`, `guild.usage.get`) are deskd's (3.3), over the
// Guild Desk's own link. Unknown fields are ignored everywhere, and a value this app doesn't know reads as the safe one.
import { api } from '../platform/api';

export type GuildRole = 'lead' | 'officer' | 'member';
export type GuildGrant = 'moderate' | 'invite' | 'remove_member' | 'manage_spaces' | 'manage_agents';

/** `GuildMine`: a guild the member is in. Only the fields the office reads are typed. */
export interface GuildMine {
  guildId: string;
  name: string;
  adultsOnly?: boolean;
  role: GuildRole;
  grants?: string[];
  myMemberId?: string;
  members?: number;
  /** Today's identity lists every guild with `joined`; the contract lists only the member's. */
  joined?: boolean;
}

export interface GuildsResponse {
  guilds: GuildMine[];
  limits?: { maxGuildsPerMember?: number; maxGuildMembers?: number; inGuilds?: number };
}

/** The Guild Desk's lifecycle, from `GET /v1/guilds/{id}/desk`. `none`: never opened, so the first open provisions it. */
export type GuildDeskState = 'none' | 'provisioning' | 'stopped' | 'starting' | 'running' | 'stopping';

export interface GuildDesk {
  deskId: string | null;
  state: GuildDeskState | string;
  /** The wake phase, as on a desk (`queued`, `starting`, `booting`, `connecting`, `ready`). */
  phase?: string | null;
  size?: string | null;
  members?: number;
  /** Running and connected to the gateway: sessions can open. */
  connected?: boolean;
  pollAfterSeconds?: number;
}

/** `GET /v1/guilds/{id}/people`: who's in the guild, by name. Never email, age or band. */
export interface GuildPerson {
  memberId: string;
  name: string;
  role: GuildRole;
}

/** `POST /v1/guilds/{id}/desk/token`: the same shape as a desk's `connect`, with a `ma-guild+jwt` for `deskToken`. */
export interface GuildToken {
  state?: string;
  phase?: string | null;
  deskId?: string;
  deskToken: string;
  refreshAfter?: string;
  gateway?: string;
  deskIdentity?: { fingerprintsSha256?: string[] } | null;
  retryAfterSeconds?: number;
  pollAfterSeconds?: number;
}

const TIMEOUT_MS = 15_000;
const path = (guildId: string, rest = ''): string => `/v1/guilds/${encodeURIComponent(guildId)}${rest}`;

export const getGuilds = (etag?: string | null) => api<GuildsResponse>('/v1/guilds', { etag: etag ?? null, signal: AbortSignal.timeout(TIMEOUT_MS) });
export const getGuildPeople = (guildId: string) => api<{ people: GuildPerson[] }>(path(guildId, '/people'), { signal: AbortSignal.timeout(TIMEOUT_MS) });
export const getGuildDesk = (guildId: string) => api<GuildDesk>(path(guildId, '/desk'), { signal: AbortSignal.timeout(TIMEOUT_MS) });
export const wakeGuildDesk = (guildId: string) =>
  api<unknown>(path(guildId, '/desk/wake'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(TIMEOUT_MS) });
export const guildDeskToken = (guildId: string, fingerprint: string) =>
  api<GuildToken>(path(guildId, '/desk/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fingerprint }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

// ----- deskd, on the Guild Desk's own link (contract 3.3)

/** `guild.hello`: who this session is, as deskd verified it from the token. Never shown: a teen marker isn't here at all. */
export interface GuildHello {
  guildId: string;
  memberId: string;
  role: GuildRole;
  grants: string[];
  name: string;
  apps?: string[];
}

/** Null: no cap. `runsAtOnce` always has one. deskd takes a whole object on a set, every field present. */
export interface GuildAgentLimits {
  perMember: { runsPerDay: number | null; usdPerDay: number | null; usdPerMonth: number | null };
  perGuild: { usdPerMonth: number | null; runsAtOnce: number };
  tools: { read: boolean; search: boolean; edit: boolean; post: boolean; boards: boolean };
  ownKeys: boolean;
}

/** `guild.settings.get` and `.set`: the Founder's limits for members' agents. Founder, or an Officer with `manage_agents`. */
export interface GuildSettings {
  agents: GuildAgentLimits;
  updatedAt?: string | null;
  updatedBy?: string | null;
}

/** deskd's rows carry no name: the office joins them with `GET /v1/guilds/{id}/people`. A `name` here wins if a later deskd sends one. */
export interface GuildUsageRow {
  memberId: string;
  name?: string;
  today: { runs: number; usd: number; microUsd?: number };
  month: { runs: number; usd: number; microUsd?: number };
}

/** `guild.usage.get`: runs and dollars per member, today and this month. Founder and Officers. Never content. */
export interface GuildUsage {
  members: GuildUsageRow[];
  guild?: { today?: { runs: number; usd: number }; month?: { runs: number; usd: number } };
  /** The zone "today" and "this month" are counted in, when the desk says. */
  timeZone?: string;
}
