// The mock's usage ledger, after task 04's `LlmGateway` and `UsageLedger`: reserve a worst case before a call
// (input bytes / 3 at the input price, plus the output cap at the output price) and refuse if any limit would
// pass; settle afterwards from the usage reported. Mock only: the real one is on the desk.
import type { LimitPolicy, LimitScope, ScopeUsage, Usage } from '../client/types';

export interface Price {
  inputMicroUsdPerMTok: number;
  outputMicroUsdPerMTok: number;
}

export interface LedgerRow {
  agentId: string;
  keyId: string;
  at: number;
  /** Null for a model with no price. */
  microUsd: number | null;
  tokens: number;
}

export interface Estimate {
  tokens: number;
  microUsd: number | null;
}

export interface Refusal {
  scope: LimitScope;
  unit: 'usd' | 'tokens';
  limit: number;
  spent: number;
  needed: number;
}

export const BYTES_PER_TOKEN = 3;

export function estimate(price: Price | null, inputBytes: number, maxOutputTokens: number): Estimate {
  const input = Math.ceil(inputBytes / BYTES_PER_TOKEN);
  const microUsd = price
    ? Math.ceil((input * price.inputMicroUsdPerMTok + maxOutputTokens * price.outputMicroUsdPerMTok) / 1_000_000)
    : null;
  return { tokens: input + maxOutputTokens, microUsd };
}

/** Cache reads at a tenth of the input price and writes at 1.25 times, as Anthropic bills them. */
export function cost(price: Price | null, u: Usage): number | null {
  if (!price) return null;
  const inMicro = (u.inputTokens + u.cachedInputTokens * 0.1 + u.cacheWriteTokens * 1.25) * price.inputMicroUsdPerMTok;
  return Math.ceil((inMicro + u.outputTokens * price.outputMicroUsdPerMTok) / 1_000_000);
}

export function totalTokens(u: Usage): number {
  return u.inputTokens + u.cachedInputTokens + u.cacheWriteTokens + u.outputTokens;
}

/** A wall-clock date in `zone`: year, month from 0, day, and the weekday from Sunday as 0. */
function dateIn(ms: number, zone: string): { y: number; m: number; d: number; wd: number } {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' }).formatToParts(ms)) parts[p.type] = p.value;
  return { y: Number(parts['year']), m: Number(parts['month']) - 1, d: Number(parts['day']), wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts['weekday'] ?? '') };
}

/** How far `zone`'s wall clock is ahead of UTC at `ms`. */
function offsetIn(ms: number, zone: string): number {
  const parts: Record<string, string> = {};
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  for (const p of f.formatToParts(ms)) parts[p.type] = p.value;
  const wall = Date.UTC(Number(parts['year']), Number(parts['month']) - 1, Number(parts['day']), Number(parts['hour']) % 24, Number(parts['minute']), Number(parts['second']));
  return wall - Math.floor(ms / 1000) * 1000;
}

/** The instant `zone`'s clock reads 00:00 on that date. `Date.UTC` carries a day or month past its end. */
function midnightIn(y: number, m: number, d: number, zone: string): number {
  const wall = Date.UTC(y, m, d);
  const first = wall - offsetIn(wall, zone);
  return wall - offsetIn(first, zone);
}

/**
 * A scope's current period, `[start, end)`: from midnight, Monday or the 1st. Null for per-run scopes. With a `zone`, in that zone,
 * as a desk from ADR 0043 counts; without one, in this browser's own time, as the mock always has.
 */
export function period(scope: LimitScope, now: number, zone?: string): [number, number] | null {
  const kind = scope === 'agent_day' || scope === 'desk_day' ? 'day' : scope === 'agent_week' ? 'week' : scope === 'agent_month' || scope === 'desk_month' || scope === 'key_month' ? 'month' : null;
  if (!kind) return null;
  if (zone) {
    const t = dateIn(now, zone);
    if (kind === 'day') return [midnightIn(t.y, t.m, t.d, zone), midnightIn(t.y, t.m, t.d + 1, zone)];
    if (kind === 'week') {
      const back = (t.wd + 6) % 7; // Monday is 0
      return [midnightIn(t.y, t.m, t.d - back, zone), midnightIn(t.y, t.m, t.d - back + 7, zone)];
    }
    return [midnightIn(t.y, t.m, 1, zone), midnightIn(t.y, t.m + 1, 1, zone)];
  }
  const d = new Date(now);
  const y = d.getFullYear();
  const m = d.getMonth();
  if (kind === 'day') return [new Date(y, m, d.getDate()).getTime(), new Date(y, m, d.getDate() + 1).getTime()];
  if (kind === 'week') {
    const back = (d.getDay() + 6) % 7;
    return [new Date(y, m, d.getDate() - back).getTime(), new Date(y, m, d.getDate() - back + 7).getTime()];
  }
  return [new Date(y, m, 1).getTime(), new Date(y, m + 1, 1).getTime()];
}

/** Where a scope's current period began. Null for per-run scopes. */
export function periodStart(scope: LimitScope, now: number, zone?: string): number | null {
  return period(scope, now, zone)?.[0] ?? null;
}

export function periodEnd(scope: LimitScope, now: number, zone?: string): number | null {
  return period(scope, now, zone)?.[1] ?? null;
}

type PeriodKey = 'agentDay' | 'agentWeek' | 'agentMonth' | 'deskDay' | 'deskMonth' | 'keyMonth';
const PERIOD: { scope: LimitScope; key: PeriodKey; by: 'agent' | 'desk' | 'key' }[] = [
  { scope: 'agent_day', key: 'agentDay', by: 'agent' },
  { scope: 'agent_week', key: 'agentWeek', by: 'agent' },
  { scope: 'agent_month', key: 'agentMonth', by: 'agent' },
  { scope: 'desk_day', key: 'deskDay', by: 'desk' },
  { scope: 'desk_month', key: 'deskMonth', by: 'desk' },
  { scope: 'key_month', key: 'keyMonth', by: 'key' },
];

/** How a desk counts: in a zone (ADR 0043's), or not, and whether it has the whole desk's day. */
export interface Counting {
  zone?: string;
  deskDay?: boolean;
}

export function usageIn(rows: LedgerRow[], scope: LimitScope, who: { agentId: string; keyId: string | null }, now: number, zone?: string): ScopeUsage {
  const p = PERIOD.find((x) => x.scope === scope);
  const since = periodStart(scope, now, zone);
  let spentMicroUsd = 0;
  let spentTokens = 0;
  if (p && since != null) {
    for (const r of rows) {
      if (r.at < since) continue;
      if (p.by === 'agent' && r.agentId !== who.agentId) continue;
      if (p.by === 'key' && r.keyId !== who.keyId) continue;
      spentMicroUsd += r.microUsd ?? 0;
      spentTokens += r.tokens;
    }
  }
  return { scope, spentMicroUsd, spentTokens, resetsAt: periodEnd(scope, now, zone) };
}

export function usageView(rows: LedgerRow[], who: { agentId: string; keyId: string | null }, now: number, counting: Counting = {}): ScopeUsage[] {
  return PERIOD.filter((p) => counting.deskDay || p.scope !== 'desk_day').map((p) => usageIn(rows, p.scope, who, now, counting.zone));
}

/** The first limit this call's worst case would pass, or null. A dollar cap can't bind a model with no price. */
export function check(policy: LimitPolicy, rows: LedgerRow[], who: { agentId: string; keyId: string }, est: Estimate, now: number, zone?: string): Refusal | null {
  if (est.microUsd != null && policy.run.maxMicroUsd != null && est.microUsd > policy.run.maxMicroUsd) {
    return { scope: 'run', unit: 'usd', limit: policy.run.maxMicroUsd, spent: 0, needed: est.microUsd };
  }
  if (policy.run.maxTokens != null && est.tokens > policy.run.maxTokens) {
    return { scope: 'run', unit: 'tokens', limit: policy.run.maxTokens, spent: 0, needed: est.tokens };
  }
  for (const p of PERIOD) {
    const limit = policy[p.key];
    if (!limit) continue; // a desk before ADR 0043 has no `deskDay`
    const used = usageIn(rows, p.scope, who, now, zone);
    if (est.microUsd != null && limit.maxMicroUsd != null && used.spentMicroUsd + est.microUsd > limit.maxMicroUsd) {
      return { scope: p.scope, unit: 'usd', limit: limit.maxMicroUsd, spent: used.spentMicroUsd, needed: est.microUsd };
    }
    if (limit.maxTokens != null && used.spentTokens + est.tokens > limit.maxTokens) {
      return { scope: p.scope, unit: 'tokens', limit: limit.maxTokens, spent: used.spentTokens, needed: est.tokens };
    }
  }
  return null;
}
