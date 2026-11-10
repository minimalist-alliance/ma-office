// How a Guild Desk is opened (task 48, contract 3.2): its state, a wake if the member asked and it sleeps, then a guild
// token. What comes back is shaped as a desk's `connect` answers, so the desk's own link (`desk/rtc/rtcDeskLink.ts`) runs
// the session as it does for any desk: the gateway, one WebRTC connection straight to the Guild Desk, refreshes and retries.
// The mock link (`desk/mockDeskLink.ts`) calls this too, so a shell test sees every request against the harness.
//
// Nothing here knows the stores: the guild store hears through `setGuildAccessHooks`, so the link can't make a cycle.
import { ApiError } from '../platform/api';
import { getGuildDesk, guildDeskToken, wakeGuildDesk, type GuildDesk, type GuildToken } from './api';
import { guildIdOfPanel } from './panel';

/** What a desk's `connect` says, which the link reads. `remoteDeskId`: the Guild Desk's own id, for the gateway. */
export interface GuildConnect extends GuildToken {
  remoteDeskId?: string;
}

interface Hooks {
  /** The latest word on a Guild Desk, from any of these calls. */
  desk(guildId: string, desk: GuildDesk): void;
  /** A guild route said 403 or 404: the member may no longer be in it. The store checks the list before it says so. */
  refused(guildId: string): void;
}

let hooks: Hooks = { desk: () => {}, refused: () => {} };
export function setGuildAccessHooks(h: Hooks): void {
  hooks = h;
}

/** While it starts, the link asks again at this pace, so the waking screen moves on within a few seconds of ready. */
const POLL_S = 3;

/** A guild route that says the member isn't let in: no longer in the guild, or the guild is gone. */
// `data_guard` is a 403 too, but the member is still in the guild: the link shows its words (ma-platform ADR 0110).
export const isRefusal = (err: unknown): boolean => err instanceof ApiError && err.code !== 'data_guard' && (err.status === 403 || err.status === 404);

export class GuildAccess {
  readonly guildId: string;

  constructor(guildId: string) {
    this.guildId = guildId;
  }

  /**
   * `start` only after the member asked and the desk said it sleeps (`RtcDeskLink.establish`), as for any desk: nothing
   * else wakes a Guild Desk. `none` is a desk never opened, and its first wake provisions it.
   */
  async connect(start: boolean, fingerprint: string): Promise<GuildConnect> {
    try {
      const desk = (await getGuildDesk(this.guildId)).data ?? { deskId: null, state: 'none' };
      hooks.desk(this.guildId, desk);
      if (desk.state === 'none' || desk.state === 'stopped') {
        if (!start) return { state: 'stopped', phase: null, deskToken: '' };
        await wakeGuildDesk(this.guildId);
        hooks.desk(this.guildId, { ...desk, state: 'starting' });
        return { state: 'starting', phase: 'starting', deskToken: '', pollAfterSeconds: POLL_S };
      }
      // Provisioning and starting are both "waking" to a member, and so is a running desk not yet on the gateway; stopping
      // waits for the desk, as any desk's does.
      if (desk.state === 'stopping') return { state: 'stopping', phase: null, deskToken: '', pollAfterSeconds: POLL_S };
      if (desk.state !== 'running' || desk.connected === false) {
        const phase = desk.state === 'running' ? 'connecting' : desk.phase && desk.phase !== 'ready' ? desk.phase : 'starting';
        return { state: 'starting', phase, deskToken: '', pollAfterSeconds: POLL_S };
      }
      const token = (await guildDeskToken(this.guildId, fingerprint)).data;
      if (!token?.deskToken) throw new Error('the guild token route returned no token');
      const remote = token.deskId ?? desk.deskId ?? undefined;
      return { ...token, state: token.state ?? 'running', phase: token.phase ?? 'ready', ...(remote ? { remoteDeskId: remote } : {}) };
    } catch (err) {
      if (isRefusal(err)) hooks.refused(this.guildId);
      throw err;
    }
  }
}

/** The access for a guild's panel, or null for any other desk. One per link. */
export function guildAccess(panelId: string): GuildAccess | null {
  const guildId = guildIdOfPanel(panelId);
  return guildId ? new GuildAccess(guildId) : null;
}
