// The desk list from Platform (GET /v1/desks), plus a mirror of ids and names so the canvas can paint before the
// network answers (design 3.8, budget B15). No desk content here. The mirror is kept beside the refresh token
// (`tokenStore.ts`: this tab's sessionStorage under "Stay signed in" `browser`, gone with the token) and drawn only
// while the member's last-known record is from this sign-in (`platform/lastKnown.ts`), so it's per account.
import { create } from 'zustand';
import type { VmState } from '../desk/agentStatus';
import type { GuildRole } from '../guild/api';
import { isGuildPanel } from '../guild/panel';
import type { PlatformDesk } from '../platform/api';
import { trafficStopOf, type TrafficStop } from '../desk/trafficStop';
import { lastKnownFitsSession } from '../platform/lastKnown';
import { DESK_MIRROR_KEY, hasStoredToken, readBeside, writeBeside } from '../platform/tokenStore';
import { layoutMirrorWritable } from './layoutStore';

export type DeskKind = 'personal' | 'work' | 'guild' | 'custom';

export interface DeskInfo {
  id: string;
  name: string;
  kind: DeskKind;
  vm: VmState;
  phase: string | null;
  queuePosition: number | null;
  stopAt: string | null;
  /** Why the stop is announced (`data_guard`, ma-platform ADR 0110). Unknown values are safe: only known ones change the words. */
  stopReason?: string | null;
  /** Why the cost guard stopped the desk, and when it clears (TD-162). Only for a traffic stop. */
  stopDetail?: TrafficStop;
  givebackUntil: string | null;
  badges: Record<string, number>;
  /** The Alliance Member's hosted small desk (ma-platform ADR 0097): the office wakes it as it opens, and keeps its last screen. */
  startsWithOffice?: boolean;
  /**
   * On the member's own computer (`hosting: "self"`, contract desks.md 0.3.13): its traffic isn't the cloud's, so the
   * member's bandwidth limit never pauses its Browser (contract bandwidth.md, "What counts").
   */
  selfHosted?: boolean;
  /** Its `allowedActions` has `rename` (contract tiers.md section 8): its owner may rename it now. */
  canRename?: boolean;
  /** A guild's shared Guild Desk (task 48): which guild, and the member's place in it as identity last said. */
  guild?: { guildId: string; role: GuildRole; grants: string[] };
  /** The member is no longer in this guild. Its panel says so, calmly, until they put it away (`guild/guildStore.ts`). */
  removed?: boolean;
  /** A desk on the member's own computer: its boots (`platform/bootNotice.ts` says so when one is new or a second copy was refused). */
  boot?: DeskBoot;
  /** A desk a step down ends at renewal (not built by Platform yet): its menu says "Stops on {date}". */
  endsAt?: string;
  /**
   * A Work desk a step down stopped (contract `notInPlan`, or the spec's `retained` with `export` only): its tiles dim and
   * opening it says so (`chrome/EndedDeskPanel.tsx`). `stoppedAt` is when it stopped, `retainedUntil` when its snapshot goes
   * (null where the desk is kept until the member moves back up).
   */
  ended?: { stoppedAt: string | null; retainedUntil: string | null };
}

export interface DeskBoot {
  /** When the platform first saw the current boot (ISO). */
  firstSeenAt: string;
  /** The boot before it, or null for the first. */
  previousAt: string | null;
  /** The last time a second copy of this desk was refused, or null. */
  refusedAt: string | null;
}

export type DeskListStatus = 'loading' | 'ready' | 'empty' | 'error';

interface DeskState {
  status: DeskListStatus;
  desks: DeskInfo[];
  unpaid: { billingUrl: string | null } | null;
}

const MIRROR_KEY = DESK_MIRROR_KEY;
type Mirror = { id: string; name: string; kind: DeskKind }[];

/**
 * One list for the canvas, in two parts that never touch: the member's own desks from `GET /v1/desks` (`setDeskList`), then
 * the Guild Desks of their guilds (`setGuildDesks`), whose ids are the office's own `guild-…` (`guild/panel.ts`). Each setter
 * replaces only its part. The mirror keeps both, so a reload paints a guild's panel before the guild list answers.
 */
const ownOf = (desks: readonly DeskInfo[]): DeskInfo[] => desks.filter((d) => !isGuildPanel(d.id));
const guildsOf = (desks: readonly DeskInfo[]): DeskInfo[] => desks.filter((d) => isGuildPanel(d.id));

function writeMirror(desks: readonly DeskInfo[]): void {
  // Beside the token, so never without one, and only while the layout's mirror may be written (ISS-89): a tab that
  // another tab's sign-out left behind, still listing on the access token it holds, writes no names for whoever's next.
  if (!hasStoredToken() || !layoutMirrorWritable()) return;
  writeBeside(MIRROR_KEY, JSON.stringify(desks.filter((d) => !d.removed).map(({ id, name, kind }) => ({ id, name, kind }))));
}

function loadMirror(): DeskInfo[] {
  if (!lastKnownFitsSession()) return [];
  let m: Mirror | null = null;
  try {
    m = JSON.parse(readBeside(MIRROR_KEY) ?? 'null') as Mirror | null;
  } catch {
    /* not ours to draw */
  }
  if (!Array.isArray(m)) return [];
  return m
    .filter((d) => d && typeof d.id === 'string' && typeof d.name === 'string')
    .map((d) => ({ ...d, vm: 'unknown', phase: null, queuePosition: null, stopAt: null, givebackUntil: null, badges: {} }));
}

export const useDeskStore = create<DeskState>(() => ({ status: 'loading', desks: loadMirror(), unpaid: null }));

const KINDS: readonly string[] = ['personal', 'work', 'guild'];

/** Contract states to the store's. An unknown state is treated as transitional, per the contract. */
export function vmFromPlatform(state: string): VmState {
  switch (state) {
    case 'requested':
    case 'provisioning':
      return 'setting-up';
    case 'stopped':
    case 'retained':
      return 'stopped';
    case 'running':
      return 'running';
    case 'stopping':
      return 'stopping';
    case 'error':
    case 'failed':
      return 'error';
    default:
      return 'starting';
  }
}

/**
 * `allowedActions: []` is a held desk (contract 0.3.11): it offers nothing and is never asked anything. A missing list
 * is an older answer, so it holds nothing back. A new desk's state wins, since it sends nothing either way.
 */
function vmOf(d: PlatformDesk): VmState {
  const vm = vmFromPlatform(d.state);
  return vm !== 'setting-up' && Array.isArray(d.allowedActions) && d.allowedActions.length === 0 ? 'held' : vm;
}

const validTime = (v: unknown): string | null => (typeof v === 'string' && v && !Number.isNaN(Date.parse(v)) ? v : null);

/** A Work desk the plan no longer holds: `notInPlan`, or a retained one that offers `export` alone. Never a guild's or a free desk's. */
function endedOf(d: PlatformDesk): DeskInfo['ended'] | null {
  if (d.kind !== 'work') return null;
  const exportOnly = d.state === 'retained' && Array.isArray(d.allowedActions) && d.allowedActions.length === 1 && d.allowedActions[0] === 'export';
  if (d.notInPlan !== true && !exportOnly) return null;
  return { stoppedAt: validTime(d.endsAt) ?? validTime(d.stateChangedAt), retainedUntil: validTime(d.retainedUntil) };
}

export function toDeskInfo(d: PlatformDesk): DeskInfo {
  const ended = endedOf(d);
  const until = d.nextDowntime?.active && d.nextDowntime.endAt
    ? new Date(d.nextDowntime.endAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : null;
  return {
    id: d.deskId,
    name: d.name,
    kind: (KINDS.includes(d.kind) ? d.kind : 'custom') as DeskKind,
    vm: ended && d.state === 'retained' ? 'stopped' : vmOf(d),
    phase: d.phase ?? null,
    queuePosition: d.queue?.position ?? null,
    stopAt: d.stopAt ?? null,
    ...(d.stopReason ? { stopReason: d.stopReason } : {}),
    stopDetail: trafficStopOf(d.stopDetail) ?? undefined,
    givebackUntil: until,
    badges: d.badges?.apps ?? {},
    ...(d.startsWithOffice === true ? { startsWithOffice: true } : {}),
    ...(d.hosting === 'self' && (d.bootFirstSeenAt || d.bootRefusedAt)
      ? { boot: { firstSeenAt: d.bootFirstSeenAt ?? '', previousAt: d.previousBootFirstSeenAt ?? null, refusedAt: d.bootRefusedAt ?? null } }
      : {}),
    ...(d.hosting === 'self' ? { selfHosted: true } : {}),
    ...(Array.isArray(d.allowedActions) && d.allowedActions.includes('rename') ? { canRename: true } : {}),
    ...(typeof d.endsAt === 'string' && d.endsAt && !ended ? { endsAt: d.endsAt } : {}),
    ...(ended ? { ended } : {}),
  };
}

/** When each desk's link last heard where the desk is (`LinkDeskState.heardAt`, through `applyDeskProgress`). */
const linkSaidAt = new Map<string, number>();
/** The states a list and a link can both say. A hold, a new desk and a removal are the list's word alone. */
const LIFECYCLE: ReadonlySet<VmState> = new Set<VmState>(['stopped', 'starting', 'running', 'stopping', 'error']);

/**
 * What a list row says, unless this desk's link has spoken since the list was asked for (`askedAt`): then the link's
 * word is the newer one and stays until the next answer. A list on its way when a wake began otherwise put "asleep"
 * back for up to a poll, and a 304 says the last full answer again (TD-227 part 3). Only between lifecycle states.
 *
 * And a desk that starts with the office (`startsWithOffice`, woken as the office opens, in a tab that can be seen)
 * keeps the mirror's "checking…" on the load's first list rather than "asleep": the office wakes it as soon as its
 * link is made, and the link's first answer says where it is either way.
 */
function newerOf(listed: DeskInfo, cur: DeskInfo | undefined, askedAt: number | undefined): DeskInfo {
  if (!cur) return listed;
  if (listed.startsWithOffice && listed.vm === 'stopped' && cur.vm === 'unknown' && !linkSaidAt.has(listed.id) && typeof document !== 'undefined' && !document.hidden) {
    return { ...listed, vm: 'unknown' };
  }
  if (askedAt === undefined || (linkSaidAt.get(listed.id) ?? -Infinity) <= askedAt) return listed;
  if (!LIFECYCLE.has(listed.vm) || !LIFECYCLE.has(cur.vm)) return listed;
  return { ...listed, vm: cur.vm, phase: cur.phase, queuePosition: cur.queuePosition, stopAt: cur.stopAt, ...(cur.stopReason != null ? { stopReason: cur.stopReason } : {}) };
}

/** `askedAt`: when this answer was asked for (a 304 included), so a link's newer word can stand (`newerOf`). */
export function setDeskList(platform: PlatformDesk[], askedAt?: number): void {
  const cur = useDeskStore.getState();
  const before = new Map(cur.desks.map((d) => [d.id, d]));
  const desks = [...platform.map((p) => newerOf(toDeskInfo(p), before.get(p.deskId), askedAt)).filter((d) => !isGuildPanel(d.id)), ...guildsOf(cur.desks)];
  const status = desks.length ? 'ready' : 'empty';
  // Every poll lands here, 304s too, up to every 2 s. Nothing new means no write, so no render.
  if (cur.status === status && !cur.unpaid && JSON.stringify(cur.desks) === JSON.stringify(desks)) return;
  writeMirror(desks);
  useDeskStore.setState({ desks, status, unpaid: null });
}

/** Tests and dev: a list that doesn't come from Platform and doesn't touch the mirror. Guild Desks stay. */
export function setDeskListDirect(desks: DeskInfo[]): void {
  const all = [...desks.filter((d) => !isGuildPanel(d.id)), ...guildsOf(useDeskStore.getState().desks)];
  useDeskStore.setState({ desks: all, status: all.length ? 'ready' : 'empty', unpaid: null });
}

/**
 * The Guild Desks, from the guild store (task 48), after the member's own desks. A list still loading stays loading: the
 * canvas paints what it has, and the arrival waits for Platform's own list as before. True if anything changed.
 */
export function setGuildDesks(guilds: DeskInfo[]): boolean {
  const cur = useDeskStore.getState();
  if (cur.unpaid) return false; // the membership's card is the whole office until it's paid
  const desks = [...ownOf(cur.desks), ...guilds];
  if (JSON.stringify(cur.desks) === JSON.stringify(desks)) return false;
  const status = cur.status === 'loading' || cur.status === 'error' ? cur.status : desks.length ? 'ready' : 'empty';
  writeMirror(desks);
  useDeskStore.setState({ desks, status });
  return true;
}

/** Every desk the office shows: what the layout and the links follow. */
export const allDeskIds = (): string[] => useDeskStore.getState().desks.map((d) => d.id);
/** The Guild Desks' ids alone, for a list of the member's own that's about to land. */
export const guildDeskIds = (): string[] => guildsOf(useDeskStore.getState().desks).map((d) => d.id);

/** Newer word on one desk from its link (`connect` or the gateway), between list polls. */
export function applyDeskProgress(id: string, p: { state: string | null; phase: string | null; queuePosition: number | null; stopAt: string | null; stopReason?: string | null; stopDetail?: TrafficStop | null; heardAt?: number }): void {
  const { desks } = useDeskStore.getState();
  const cur = desks.find((d) => d.id === id);
  if (!cur) return;
  if (p.state && p.heardAt !== undefined) linkSaidAt.set(id, p.heardAt);
  const next: DeskInfo = {
    ...cur,
    vm: cur.vm === 'held' || cur.vm === 'removed' || !p.state ? cur.vm : vmFromPlatform(p.state), // only the list says a hold is over
    phase: p.phase ?? cur.phase,
    queuePosition: p.queuePosition,
    stopAt: p.stopAt ?? cur.stopAt,
    stopReason: p.stopReason ?? cur.stopReason ?? null,
    stopDetail: p.state === 'starting' || p.state === 'running' ? undefined : p.stopDetail ?? cur.stopDetail,
  };
  if (next.vm === cur.vm && next.phase === cur.phase && next.queuePosition === cur.queuePosition && next.stopAt === cur.stopAt && next.stopReason === (cur.stopReason ?? null) && next.stopDetail === cur.stopDetail) return;
  useDeskStore.setState({ desks: desks.map((d) => (d.id === id ? next : d)) });
}

/** A new name for one desk, where there's no list from Platform to say it again (fixtures). */
export function renameDeskInStore(id: string, name: string): void {
  const { desks } = useDeskStore.getState();
  if (!desks.some((d) => d.id === id && d.name !== name)) return;
  useDeskStore.setState({ desks: desks.map((d) => (d.id === id ? { ...d, name } : d)) });
}

export function setDeskListError(): void {
  useDeskStore.setState({ status: 'error' });
}

export function setUnpaid(billingUrl: string | null): void {
  useDeskStore.setState({ unpaid: { billingUrl }, desks: [], status: 'empty' });
}

/** Own desks only, for code that has always meant the member's own: "one desk" on arrival, say. */
export const ownDesks = (): DeskInfo[] => ownOf(useDeskStore.getState().desks);

export function clearDeskMirror(): void {
  writeBeside(MIRROR_KEY, null);
}

/**
 * This tab's tokens became another account's (a sign-in in another tab): the last member's list goes from the tab at
 * once, names and all, and the office shows the list loading until the new member's own answers (ISS-89).
 */
export function dropDeskList(): void {
  linkSaidAt.clear();
  useDeskStore.setState({ desks: [], status: 'loading', unpaid: null });
}

/**
 * The mirror turned out to be someone else's (the first token's `sub` isn't the record's): it goes, and so does what it
 * drew, while the list hasn't answered yet. The next answer is the member's own.
 */
export function dropMirroredDesks(): void {
  clearDeskMirror();
  const { status, desks } = useDeskStore.getState();
  if (status === 'loading' && desks.length) useDeskStore.setState({ desks: [] });
}
