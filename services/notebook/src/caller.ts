// Who is on a connection, as deskd verified it from the session's token: the hello's `caller`, and any `caller` frame
// after it. Nothing a client sends can set or change it. A hello without one is an older deskd: the desk's owner.
import { OWNER_ACTOR } from './notebook.ts';

export type CallerKind = 'owner' | 'guild_member';
export type Role = 'lead' | 'officer' | 'member';

export interface Caller {
  kind: CallerKind;
  /** `gm-…`, guild-scoped. Null for the owner. Never changes on a connection. */
  memberId: string | null;
  role: Role | null;
  /** Effective grants, as deskd computed them: a lead has all of them. Empty for the owner, who may do anything. */
  grants: readonly string[];
  /** For display and attribution, never identity. Null for the owner. */
  name: string | null;
  /** The member's checked profile picture: Platform's public avatar route over https, or null (initials). Display only. */
  avatarUrl?: string | null;
}

export const OWNER_CALLER: Caller = Object.freeze({ kind: 'owner', memberId: null, role: null, grants: Object.freeze([]), name: null });

const ROLES = new Set(['lead', 'officer', 'member']);
const MAX_ID = 128;
const MAX_NAME = 128;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const AVATAR = /^https:\/\/[a-z0-9.-]{1,253}\/v1\/public\/avatars\/im_[a-z2-7]{26}$/;
/** Platform's checked-avatar address exactly, else null: nothing else is ever put into presence. */
export const cleanAvatar = (v: unknown): string | null => (typeof v === 'string' && AVATAR.test(v) ? v : null);

const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !CONTROL.test(v);

/** The caller in a hello or a `caller` frame, or null if it isn't one. `undefined` (no caller at all) is the owner. */
export function parseCaller(v: unknown): Caller | null {
  if (v === undefined) return OWNER_CALLER;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  if (c['kind'] === 'owner') {
    if (c['memberId'] !== null && c['memberId'] !== undefined) return null;
    return OWNER_CALLER;
  }
  if (c['kind'] !== 'guild_member') return null;
  const memberId = c['memberId'];
  const role = c['role'];
  const grants = c['grants'];
  const name = c['name'];
  if (!text(memberId, MAX_ID)) return null;
  if (typeof role !== 'string' || !ROLES.has(role)) return null;
  if (!Array.isArray(grants) || grants.length > 32 || !grants.every((g) => text(g, 64))) return null;
  if (name !== null && name !== undefined && !text(name, MAX_NAME)) return null;
  return Object.freeze({ kind: 'guild_member', memberId, role: role as Role, grants: Object.freeze([...(grants as string[])]), name: (name as string | null | undefined) ?? null, avatarUrl: cleanAvatar(c['avatarUrl']) });
}

export const isGuild = (c: Caller): boolean => c.kind === 'guild_member';

/** May delete what other members wrote: the owner on their own desk, a lead, or anyone deskd says holds `moderate`. */
export const mayModerate = (c: Caller): boolean => c.kind === 'owner' || c.role === 'lead' || c.grants.includes('moderate');

/** What goes in `actor` columns: `user` for the owner, as before, and the member's id on a guild desk. */
export const actorOf = (c: Caller): string => (c.kind === 'guild_member' && c.memberId ? c.memberId : OWNER_ACTOR);

/** Whether a later `caller` frame keeps who this is. Role, grants and name may change; kind and memberId never do. */
export const sameIdentity = (a: Caller, b: Caller): boolean => a.kind === b.kind && a.memberId === b.memberId;
