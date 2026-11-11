// What the Browser window shows instead of, or over, the picture (design 3.14, 6). Pure, so every state has a test.
import type { VmState } from '../desk/agentStatus';
import type { DeskRefusal, LinkState } from '../desk/deskLink';
import { OLDER_THAN_PROFILE } from './streamControl';

export type WakeStep = 1 | 2 | 3;

export type BrowserPanel =
  | { kind: 'playing' }
  | { kind: 'settingUp' }
  | { kind: 'support' }
  | { kind: 'membership'; billingUrl: string | null }
  /** The data guard stopped the member's desks (ma-platform ADR 0110): the platform's words, and the next billing day. */
  | { kind: 'dataGuard'; message: string | null; resumesAt: string | null }
  | { kind: 'asleep' }
  | { kind: 'failed' }
  | { kind: 'queued'; position: number | null }
  /** A free desk is waiting for room (`free_capacity_wait`). */
  | { kind: 'busy' }
  | { kind: 'waking'; step: WakeStep }
  | { kind: 'opening' }
  | { kind: 'stopping' }
  | { kind: 'reconnecting' }
  | { kind: 'unreachable' }
  | { kind: 'denied' }
  | { kind: 'resting' }
  | { kind: 'unplayable' }
  | { kind: 'unsupported' }
  | { kind: 'forbidden' }
  /** The desk won't start an older Chromium on the member's profile (ADR 0035). `trying`: the member's press is out. */
  | { kind: 'outdated'; trying: boolean }
  /** Looked at again, and the desk is thawing its Chromium (deskd API.md section 10, "Nobody looking"). */
  | { kind: 'resuming' }
  | { kind: 'starting' };

export interface PanelInput {
  vm: VmState;
  phase: string | null;
  queuePosition: number | null;
  link: LinkState;
  /** The session has been lost for 30 s or more. */
  unreachable: boolean;
  /** False once the desk has answered `m=video 0`. */
  canPlayVideo: boolean;
  /** The desk's final no to `browser.stream.set`. */
  refused: string | null;
  /** The member's try after `chromium_older_than_profile` is on its way. */
  trying?: boolean;
  /** A frame of this session has been shown. */
  hasFrame: boolean;
  /** `connect` refused this desk. */
  refusal?: DeskRefusal | null;
  /** The simple view covers the window (task 47): it needs no picture, so there's nothing to wait for. */
  simple?: boolean;
  /** On screen, and the desk says someone looks while its Chromium is still frozen. */
  resuming?: boolean;
  /** `connect` said a free desk must wait for room. */
  busy?: boolean;
}

export function browserPanel(i: PanelInput): BrowserPanel {
  // Nothing asks a desk in these, so nothing here waits on an answer or offers a button.
  if (i.vm === 'setting-up') return { kind: 'settingUp' };
  if (i.vm === 'held' || i.refusal?.kind === 'unavailable') return { kind: 'support' };
  if (i.vm === 'removed') return { kind: 'denied' }; // a Guild Desk's own window says it in its words first (`guild/GuildWindow.tsx`)
  if (i.refusal?.kind === 'data_guard') return { kind: 'dataGuard', message: i.refusal.message ?? null, resumesAt: i.refusal.resumesAt ?? null };
  if (i.refusal) return { kind: 'membership', billingUrl: i.refusal.billingUrl };
  if (i.vm === 'error' || i.phase === 'failed') return { kind: 'failed' };
  if (i.busy) return { kind: 'busy' };
  if (i.vm === 'stopped') return { kind: 'asleep' };
  if (i.vm === 'stopping') return { kind: 'stopping' };
  if (i.vm === 'starting') {
    if (i.phase === 'queued') return { kind: 'queued', position: i.queuePosition };
    return { kind: 'waking', step: i.phase === 'booting' ? 2 : i.phase === 'connecting' ? 3 : 1 };
  }
  if (i.link === 'denied') return { kind: 'denied' };
  if (i.link === 'resting') return { kind: 'resting' };
  if (i.link === 'resuming' || i.link === 'retrying') return { kind: i.unreachable ? 'unreachable' : 'reconnecting' };
  if (i.link !== 'open') return { kind: 'opening' };
  if (!i.canPlayVideo) return { kind: 'unplayable' };
  if (i.refused === 'forbidden') return { kind: 'forbidden' };
  if (i.refused === OLDER_THAN_PROFILE) return { kind: 'outdated', trying: i.trying === true };
  if (i.refused) return { kind: 'unsupported' };
  // Under the simple view there's no picture to resume: its own `get` thaws the desk's Chromium (section 14).
  if (i.resuming && i.simple !== true) return { kind: 'resuming' };
  return i.hasFrame || i.simple === true ? { kind: 'playing' } : { kind: 'starting' };
}
