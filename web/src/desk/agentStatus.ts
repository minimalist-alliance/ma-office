// What a desk is doing (design 3.5, ADR 0062): Platform's VM state merged with the link and the
// agent's own state. `label` always names the state, so color is never the only signal, and the
// proxy layer's accessible name carries it for every state. `dot` says whether the desk's surface
// shows it: a desk shows nothing unless there's a problem or the member is waiting on it.
import { SUPPORT_ADDRESS } from '../platform/clientConfig';
import { DATA_GUARD_STOP_REASON, DATA_GUARD_STOPPING } from './dataGuardWords';
import { TRAFFIC_STOP_REASON, TRAFFIC_STRIP } from './trafficStop';
import type { AgentActivity, AgentStateMessage, DeskRefusal, DeskStatus, LinkState } from './deskLink';

export type StatusDot = 'pulse' | 'warn' | 'error';

export interface StatusLine {
  /** Null: nothing on the desk. The label still goes in its accessible name. */
  dot: StatusDot | null;
  label: string;
  /** Show on the desk only once the state has lasted this long. */
  showAfterMs?: number;
  /** An agent's own state, so its provider mark goes beside it (ADR 0062, follow-up 8). */
  fromAgent?: boolean;
}

/**
 * `setting-up`: `requested` or `provisioning`, which start on their own. `held`: `allowedActions: []`. `removed`: a Guild
 * Desk of a guild the member is no longer in (task 48), which asks nothing and opens nothing.
 */
export type VmState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'unknown' | 'setting-up' | 'held' | 'removed';

export interface StatusInput {
  vm: VmState;
  /** Platform wake phase: queued, starting, booting, connecting, ready, failed, stopped. */
  phase?: string | null;
  queuePosition?: number | null;
  /** Seconds left while a stop is announced. */
  stopInSec?: number | null;
  /** Why it is announced (`data_guard`); anything else keeps the usual words. */
  stopReason?: string | null;
  /** A traffic stop that still holds: the strip says so in place of "asleep" (TD-162). */
  trafficStop?: boolean;
  givebackUntil?: string | null;
  link: LinkState;
  /** False until this desk's link exists. */
  linkAvailable: boolean;
  /** Seconds the session has been lost, for reconnecting vs can't reach. */
  lostForSec?: number;
  agent: AgentActivity;
  /** The desk's own status in words, for when no agent has anything to say. */
  summary?: string | null;
  /** `connect` refused this desk. */
  refusal?: DeskRefusal | null;
  /** What a desk that can't be opened says, and all it says. */
  support?: string;
}

/** A normal open takes under 1.5 s (budget B14) and shows nothing. One that drags on says so. */
export const SLOW_OPEN_MS = 2000;

/** For the accessible name only, never drawn. Coarse, because a new value costs the desk a render. */
export function deskSummary(s: Pick<DeskStatus, 'instanceType' | 'uptimeSec'>): string {
  const min = Math.floor(s.uptimeSec / 60);
  const up = min < 1 ? '<1 min' : min < 60 ? `${min} min` : min < 2880 ? `${Math.floor(min / 60)} h` : `${Math.floor(min / 1440)} d`;
  return s.instanceType ? `online · ${s.instanceType} · up ${up}` : `online · up ${up}`;
}

/**
 * The panel's word for a desk's agents, from `agent.state`, whose spellings differ (`no_key`, `limit_reached`). What the member
 * should hear about comes first, whichever agent says it.
 */
export function activityOfAgents(agents: Pick<AgentStateMessage['agents'][number], 'status' | 'approvalsPending'>[]): AgentActivity {
  if (!agents.length) return { state: 'none' };
  const has = (status: string): boolean => agents.some((a) => a.status === status);
  // A desk says a waiting run as `working` with `approvalsPending` (API.md section 18): the member is waited on.
  if (has('needs_you') || agents.some((a) => (a.approvalsPending ?? 0) > 0)) return { state: 'needs-you' };
  if (has('limit_reached')) return { state: 'paused-limit' };
  if (has('error')) return { state: 'error' };
  const count = agents.length;
  if (has('working')) return { state: 'working', count };
  if (has('online')) return { state: 'idle', count };
  return { state: 'no-key' };
}

const clockMinSec = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

export function statusLine(i: StatusInput): StatusLine {
  // Like `connecting…`, a wait with no estimate: a new desk takes as long as it takes, and nothing here can hurry it.
  if (i.vm === 'setting-up') return { dot: 'pulse', label: 'setting up…' };
  if (i.vm === 'removed') return { dot: null, label: 'no longer in this guild' };
  // No reason, and no word that hints at one.
  if (i.vm === 'held' || i.refusal?.kind === 'unavailable') return { dot: 'warn', label: i.support ?? SUPPORT_ADDRESS };
  if (i.refusal?.kind === 'data_guard') return { dot: 'warn', label: 'stopped · data use past your plan' };
  if (i.refusal) return { dot: 'warn', label: 'membership not active' };
  if (i.vm === 'error' || i.phase === 'failed') return { dot: 'error', label: "couldn't wake · Retry" };
  if (i.vm === 'stopping') {
    if (i.stopReason === TRAFFIC_STOP_REASON) return { dot: 'warn', label: i.stopInSec != null ? `${TRAFFIC_STRIP} · ${clockMinSec(i.stopInSec)}` : TRAFFIC_STRIP };
    if (i.stopReason === DATA_GUARD_STOP_REASON) return { dot: 'warn', label: i.stopInSec != null ? `${DATA_GUARD_STOPPING} ${clockMinSec(i.stopInSec)}` : DATA_GUARD_STOPPING };
    return { dot: 'warn', label: i.stopInSec != null ? `going to sleep · ${clockMinSec(i.stopInSec)}` : 'going to sleep' };
  }
  if (i.vm === 'stopped') {
    if (i.trafficStop) return { dot: null, label: TRAFFIC_STRIP };
    return { dot: null, label: i.givebackUntil ? `asleep · Give Back until ${i.givebackUntil}` : 'asleep' };
  }
  if (i.vm === 'starting') {
    if (i.phase === 'queued') {
      return { dot: 'pulse', label: i.queuePosition ? `waiting for capacity · #${i.queuePosition}` : 'waiting for capacity' };
    }
    const step = i.phase === 'booting' ? 2 : i.phase === 'connecting' ? 3 : 1;
    return { dot: 'pulse', label: `waking · ${step} of 4` };
  }
  if (i.vm === 'unknown') return { dot: null, label: 'checking…' };

  // Running. What's left depends on the link.
  if (!i.linkAvailable) return { dot: null, label: 'not connected yet' };
  if (i.link === 'denied') return { dot: 'error', label: 'access denied' };
  if (i.link === 'resting') return { dot: null, label: 'paused, no recent input' }; // nothing's wrong, and a click reopens it
  if (i.link === 'idle' || i.link === 'signaling' || i.link === 'connecting') {
    return { dot: 'pulse', label: 'connecting…', showAfterMs: SLOW_OPEN_MS };
  }
  if (i.link === 'resuming' || i.link === 'retrying') {
    return { dot: 'warn', label: (i.lostForSec ?? 0) >= 30 ? "can't reach desk" : 'reconnecting…' };
  }

  switch (i.agent.state) {
    case 'no-key':
      return { dot: null, label: 'no key' };
    case 'idle':
      return { dot: null, label: i.agent.count && i.agent.count > 1 ? `${i.agent.count} agents online` : 'agent online' };
    case 'working':
      if (i.agent.count && i.agent.count > 1) return { dot: null, label: `${i.agent.count} agents · 1 working` };
      return { dot: null, label: i.agent.task ? `working · ${i.agent.task}` : 'working' };
    case 'needs-you':
      return { dot: 'warn', label: 'needs you', fromAgent: true };
    case 'paused-limit':
      return { dot: 'warn', label: 'paused · limit reached', fromAgent: true };
    case 'error':
      return { dot: 'error', label: 'agent error', fromAgent: true };
    default:
      return { dot: null, label: i.summary ?? 'connected' };
  }
}
