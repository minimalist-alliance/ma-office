// `GET /v1/maia/state` as the office reads it (contract maia.md, "The widget"). A chunk of its own, out of the first load
// since `sub/mm-js-budget`: `gate.ts` fetches it beside the ask (`fetchMaiaState`), so reading the answer waits for nothing
// more, and the widget's chunk takes it from there.
import { readCaps, type AttachCaps } from './caps';

/** Free Maia (ma-platform ADR 0104): she answers on her free model until `until`, when the member's allowance resets. */
export interface Free {
  until: string;
}

/** An ISO time that parses, or null. */
export const when = (v: unknown): string | null => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null);

/** `{ until }`, or null for anything else. Here rather than in frames.ts, so the office's first load takes nothing more of hers. */
export function readFree(v: unknown): Free | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const until = when((v as Record<string, unknown>)['until']);
  return until ? { until } : null;
}

export interface MaiaState {
  enabled: boolean;
  modelLabel: string;
  limited: 'personal' | 'pool' | 'trial' | null;
  retentionDays: number | null;
  animation: { enabled: boolean; sleepAfterSec: number };
  memory: { enabled: boolean; maxItems: number };
  /** Free Maia (ma-platform ADR 0104): set while this member is past their allowance and on her free model. */
  free: Free | null;
  /** The person's own month, 0 to 1 (contract maia.md), or null when it isn't a number in that range. */
  usedFraction: number | null;
  /** When their allowance resets (their billing month), or null. */
  resetsAt: string | null;
  /** File attachments (contract maia.md `attachments`): null when absent or off, and then the feature isn't shown at all. */
  attachments: AttachCaps | null;
  /** A free member's trial (contract maia.md, "The free tier's trial"), as it came: `free/wire.ts` reads it. */
  trial?: unknown;
  /** Web search (ma-platform ADR 0137): on for this member, with their mode, or null. */
  webSearch?: { mode: 'ask' | 'auto' } | null;
}

const SLEEP_DEFAULT_SEC = 300;

/** `GET /v1/maia/state` as the widget uses it. Anything odd reads as off, and a bad number as its default. */
export function readState(body: unknown): MaiaState | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const anim = (b['animation'] && typeof b['animation'] === 'object' ? b['animation'] : {}) as Record<string, unknown>;
  const mem = (b['memory'] && typeof b['memory'] === 'object' ? b['memory'] : {}) as Record<string, unknown>;
  const sleep = Number(anim['sleepAfterSec']);
  const retention = Number(b['retentionDays']);
  const maxItems = Number(mem['maxItems']);
  return {
    enabled: b['enabled'] === true,
    modelLabel: typeof b['modelLabel'] === 'string' ? b['modelLabel'].slice(0, 60) : '',
    limited: b['limited'] === 'personal' || b['limited'] === 'pool' || b['limited'] === 'trial' ? b['limited'] : null,
    retentionDays: Number.isInteger(retention) && retention > 0 && retention <= 3650 ? retention : null,
    animation: {
      enabled: anim['enabled'] === true,
      sleepAfterSec: Number.isFinite(sleep) && sleep >= 30 && sleep <= 3600 ? sleep : SLEEP_DEFAULT_SEC,
    },
    memory: { enabled: mem['enabled'] === true, maxItems: Number.isInteger(maxItems) && maxItems > 0 ? maxItems : 0 },
    free: freeOf(b['free']),
    usedFraction: typeof b['usedFraction'] === 'number' && b['usedFraction'] >= 0 && b['usedFraction'] <= 1 ? b['usedFraction'] : null,
    resetsAt: when(b['resetsAt']),
    attachments: readCaps(b['attachments']),
    trial: b['trial'],
    webSearch: webOf(b['webSearch']),
  };
}

/** `webSearch: { enabled, mode }`: only on with a known mode counts. */
function webOf(v: unknown): { mode: 'ask' | 'auto' } | null {
  const w = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  return w && w['enabled'] === true && (w['mode'] === 'ask' || w['mode'] === 'auto') ? { mode: w['mode'] } : null;
}

/** `free: { enabled, active, until }`: only an active one with a good time counts. */
function freeOf(v: unknown): Free | null {
  if (!v || typeof v !== 'object' || Array.isArray(v) || (v as Record<string, unknown>)['active'] !== true) return null;
  return readFree(v);
}
