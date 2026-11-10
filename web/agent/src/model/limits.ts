// Usage limits as the member sees and edits them (design 9.9, ADR 0020). The desk enforces them; this only
// shows them and checks what's typed before it goes.
import type { Limit, LimitLayer, LimitPolicy, LimitScope, LimitsChange, LimitsView, PolicyChange, ScopeUsage } from '../client/types';
import { parseUsd, usdField, usdLimit, usd, compactCount } from './format';

export const SCOPE_LABEL: Record<LimitScope, string> = {
  agent_day: 'Today',
  agent_week: 'This week',
  agent_month: 'This month',
  desk_day: 'Whole desk, today',
  desk_month: 'Whole desk, this month',
  key_month: 'This key, this month',
  run: 'Each run',
  run_steps: 'Steps in a run',
};

/** What a refusal says, in a sentence. */
export const SCOPE_REACHED: Record<LimitScope, string> = {
  agent_day: 'Today’s limit is reached',
  agent_week: 'This week’s limit is reached',
  agent_month: 'This month’s limit is reached',
  desk_day: 'The desk’s limit for today is reached',
  desk_month: 'The desk’s limit for this month is reached',
  key_month: 'This key’s limit for this month is reached',
  run: 'One run would pass its limit',
  run_steps: 'The run reached its step limit',
};

/** When the meter warns. */
export const NEAR = 0.8;

export type Level = 'ok' | 'near' | 'reached';

export interface LimitRow {
  scope: LimitScope;
  label: string;
  /** `$1.24 of $5`, or `12.4k of 50k tokens`. */
  text: string;
  /** 0 to 1, for the meter. Null for a scope with nothing to measure (per run). */
  fraction: number | null;
  level: Level;
  /** When its period starts again, epoch ms, from the desk. */
  resetsAt: number | null;
}

const POLICY_KEY: Record<Exclude<LimitScope, 'run_steps'>, keyof Omit<LimitPolicy, 'runMaxSteps'>> = {
  agent_day: 'agentDay',
  agent_week: 'agentWeek',
  agent_month: 'agentMonth',
  desk_day: 'deskDay',
  desk_month: 'deskMonth',
  key_month: 'keyMonth',
  run: 'run',
};

const PERIOD_SCOPES = ['agent_day', 'agent_week', 'agent_month', 'desk_day', 'desk_month', 'key_month'] as const;

export function levelOf(fraction: number): Level {
  return fraction >= 1 ? 'reached' : fraction >= NEAR ? 'near' : 'ok';
}

function row(scope: LimitScope, limit: Limit, used: ScopeUsage | undefined): LimitRow[] {
  const out: LimitRow[] = [];
  const label = SCOPE_LABEL[scope];
  const resetsAt = used?.resetsAt ?? null;
  if (limit.maxMicroUsd != null) {
    const spent = used?.spentMicroUsd ?? 0;
    const fraction = limit.maxMicroUsd === 0 ? 1 : Math.min(1, spent / limit.maxMicroUsd);
    out.push({ scope, label, text: `${usd(spent)} of ${usdLimit(limit.maxMicroUsd)}`, fraction, level: levelOf(fraction), resetsAt });
  }
  if (limit.maxTokens != null) {
    const spent = used?.spentTokens ?? 0;
    const fraction = limit.maxTokens === 0 ? 1 : Math.min(1, spent / limit.maxTokens);
    out.push({ scope, label, text: `${compactCount(spent)} of ${compactCount(limit.maxTokens)} tokens`, fraction, level: levelOf(fraction), resetsAt });
  }
  return out;
}

/** Every set limit with a period, tightest-first within the agent's own, then the desk's and the key's. */
export function limitRows(view: LimitsView): LimitRow[] {
  const used = new Map(view.usage.map((u) => [u.scope, u]));
  return PERIOD_SCOPES.flatMap((s) => {
    const limit = view.policy[POLICY_KEY[s]];
    return limit ? row(s, limit, used.get(s)) : []; // a desk before ADR 0043 has no `deskDay`
  });
}

/** The per-run caps, which have no meter. */
export function runRows(policy: LimitPolicy): string[] {
  const out: string[] = [];
  if (policy.run.maxMicroUsd != null) out.push(`${usdLimit(policy.run.maxMicroUsd)} a run`);
  if (policy.run.maxTokens != null) out.push(`${compactCount(policy.run.maxTokens)} tokens a run`);
  out.push(`${policy.runMaxSteps} ${policy.runMaxSteps === 1 ? 'step' : 'steps'} a run`);
  return out;
}

/** The one meter the rail shows: the fullest set limit, or null if none is set. */
export function headlineRow(view: LimitsView): LimitRow | null {
  let best: LimitRow | null = null;
  for (const r of limitRows(view)) if (r.fraction != null && (!best || r.fraction > (best.fraction ?? 0))) best = r;
  return best;
}

/** A Guild Desk's caps on one member's agent, in dollars (`guild.settings`' `perMember`); null is no cap. */
export interface GuildCaps {
  usdPerDay: number | null;
  usdPerMonth: number | null;
}

/**
 * The sidebar's meter on a Guild Desk: what this member's agent spent today and this month, against the guild's caps on each
 * member, not the desk's own agent limits. The tighter of the two, or today's while both are as far.
 */
export function guildHeadline(view: LimitsView | null, caps: GuildCaps): LimitRow | null {
  const used = (scope: LimitScope): ScopeUsage | undefined => view?.usage.find((u) => u.scope === scope);
  const cap = (usdCap: number | null): Limit => ({ maxMicroUsd: usdCap === null ? null : Math.round(usdCap * 1_000_000), maxTokens: null });
  let best: LimitRow | null = null;
  for (const r of [...row('agent_day', cap(caps.usdPerDay), used('agent_day')), ...row('agent_month', cap(caps.usdPerMonth), used('agent_month'))]) {
    if (r.fraction != null && (!best || r.fraction > (best.fraction ?? 0))) best = r;
  }
  return best;
}

// ------------------------------------------------------------ the form

/** The values that layer desk, then account, then default (ADR 0043). */
export type LayeredField = 'deskDay' | 'deskMonth' | 'timeZone';

/** The fields the member edits. Dollars only; token caps the desk holds are kept as they are. */
export interface PolicyDraft {
  deskDay: string;
  deskMonth: string;
  timeZone: string;
  agentDay: string;
  agentWeek: string;
  agentMonth: string;
  keyMonth: string;
  run: string;
  runMaxSteps: string;
  /** The member pressed "Use my account’s" there. Typing in that field again takes it back. */
  follow: Partial<Record<LayeredField, true>>;
}

export type DraftField = Exclude<keyof PolicyDraft, 'follow'>;
type MoneyField = Exclude<DraftField, 'runMaxSteps' | 'timeZone'>;

/** The whole desk's, which lead the form. `deskDay` shows only where the desk has it. */
export const DESK_FIELDS: { field: 'deskDay' | 'deskMonth'; label: string }[] = [
  { field: 'deskDay', label: 'Each day' },
  { field: 'deskMonth', label: 'Each month' },
];

/** This agent's, below. */
export const DRAFT_FIELDS: { field: Exclude<DraftField, 'deskDay' | 'deskMonth' | 'timeZone'>; label: string; hint?: string }[] = [
  { field: 'agentDay', label: 'Each day' },
  { field: 'agentWeek', label: 'Each week' },
  { field: 'agentMonth', label: 'Each month' },
  { field: 'keyMonth', label: 'This key on this desk, each month' },
  { field: 'run', label: 'Each run', hint: 'Stops a runaway task' },
  { field: 'runMaxSteps', label: 'Steps in a run' },
];

export const MAX_USD = 10_000;
export const MAX_STEPS = 500;

/**
 * What a desk counts where neither it nor the account sets a value (deskd API.md section 11): no cap on the day, $20 a month, and
 * UTC. Shown only after "Use my account’s" on a desk whose account sets nothing; the desk's own answer replaces it on save.
 */
export const DESK_DEFAULTS: { deskDay: number | null; deskMonth: number | null } = { deskDay: null, deskMonth: 20_000_000 };

/** A desk from ADR 0043, which layers `deskDay`, `deskMonth` and the zone, and says what each layer sets. */
export function layers(view: LimitsView): { desk: LimitLayer; account: LimitLayer } | null {
  return view.desk && view.account ? { desk: view.desk, account: view.account } : null;
}

/** The zone the form shows, where the desk has none: UTC, which is what null means. */
const zoneShown = (view: LimitsView): string => view.timeZone ?? 'UTC';

export function draftFromView(view: LimitsView): PolicyDraft {
  const p = view.policy;
  return {
    deskDay: usdField(p.deskDay?.maxMicroUsd ?? null),
    deskMonth: usdField(p.deskMonth.maxMicroUsd),
    timeZone: zoneShown(view),
    agentDay: usdField(p.agentDay.maxMicroUsd),
    agentWeek: usdField(p.agentWeek.maxMicroUsd),
    agentMonth: usdField(p.agentMonth.maxMicroUsd),
    keyMonth: usdField(p.keyMonth.maxMicroUsd),
    run: usdField(p.run.maxMicroUsd),
    runMaxSteps: String(p.runMaxSteps),
    follow: {},
  };
}

/** The member typed in a field. In a layered one, that's the desk's own again. */
export function editDraft(draft: PolicyDraft, field: DraftField, text: string): PolicyDraft {
  const follow = { ...draft.follow };
  if (field === 'deskDay' || field === 'deskMonth' || field === 'timeZone') delete follow[field];
  return { ...draft, [field]: text, follow };
}

/** "Use my account’s": the field shows what the account sets, or the default where it sets nothing, and follows it on save. */
export function followAccount(draft: PolicyDraft, view: LimitsView, field: LayeredField): PolicyDraft {
  const account = view.account ?? null;
  let text: string;
  if (field === 'timeZone') text = account?.timeZone ?? 'UTC';
  else {
    const set = account ? account[field] : null;
    text = usdField(set ? set.maxMicroUsd : DESK_DEFAULTS[field]);
  }
  return { ...draft, [field]: text, follow: { ...draft.follow, [field]: true } };
}

/**
 * Where a layered field's value comes from, as the form now stands: `own` (this desk's), `account` or `default`. Null on a desk
 * without layers. A field the member hasn't changed says what the desk said; one changed is this desk's own.
 */
export function sourceOf(draft: PolicyDraft, view: LimitsView, field: LayeredField): 'own' | 'account' | 'default' | null {
  const l = layers(view);
  if (!l) return null;
  const inAccount = l.account[field] != null ? 'account' : 'default';
  if (draft.follow[field]) return inAccount;
  if (!changed(draft, view, field)) return l.desk[field] != null ? 'own' : inAccount;
  return 'own';
}

/** Whether a layered field differs from what the desk said. A field that doesn't read as anything counts as changed. */
function changed(draft: PolicyDraft, view: LimitsView, field: LayeredField): boolean {
  if (field === 'timeZone') return canonicalZone(draft.timeZone) !== zoneShown(view);
  const micro = draft[field].trim() ? parseUsd(draft[field]) : null;
  if (draft[field].trim() && micro == null) return true;
  return micro !== (view.policy[field]?.maxMicroUsd ?? null);
}

export type ParsedDraft = { ok: true; change: LimitsChange | null } | { ok: false; errors: Partial<Record<DraftField, string>> };

const sameLimit = (a: Limit | undefined, b: Limit | undefined): boolean => a?.maxMicroUsd === b?.maxMicroUsd && a?.maxTokens === b?.maxTokens;

/**
 * Checks the form and builds what to send: only what the member changed (deskd API.md section 11). On a layered desk, `deskDay`,
 * `deskMonth` and the zone go only when changed, as null where the member chose the account's, so the desk keeps following it
 * otherwise; the agent's own fields, which the desk requires with any policy, go as the form has them. On an older desk `deskMonth`
 * goes with every policy, as it always did. Blank means no limit. `change` is null when nothing changed at all.
 */
export function parseDraft(draft: PolicyDraft, view: LimitsView): ParsedDraft {
  const base = view.policy;
  const l = layers(view);
  const errors: Partial<Record<DraftField, string>> = {};
  const money = (field: MoneyField): Limit => {
    const text = draft[field].trim();
    const keep = base[field]?.maxTokens ?? null;
    if (!text) return { maxMicroUsd: null, maxTokens: keep };
    const micro = parseUsd(text);
    if (micro == null) errors[field] = 'An amount in dollars, like 5 or 2.50';
    else if (micro > MAX_USD * 1_000_000) errors[field] = `At most $${MAX_USD.toLocaleString('en-US')}`;
    return { maxMicroUsd: micro, maxTokens: keep };
  };
  const policy: PolicyChange = {
    agentDay: money('agentDay'),
    agentWeek: money('agentWeek'),
    agentMonth: money('agentMonth'),
    keyMonth: money('keyMonth'),
    run: money('run'),
    runMaxSteps: 0,
  };
  const steps = draft.runMaxSteps.trim();
  if (!/^\d+$/.test(steps) || Number(steps) < 1 || Number(steps) > MAX_STEPS) errors.runMaxSteps = `A whole number from 1 to ${MAX_STEPS}`;
  else policy.runMaxSteps = Number(steps);
  let agentChanged = (['agentDay', 'agentWeek', 'agentMonth', 'keyMonth', 'run'] as const).some((f) => !sameLimit(policy[f], base[f])) || policy.runMaxSteps !== base.runMaxSteps;

  let deskChanged = false;
  const change: LimitsChange = {};
  if (l) {
    for (const field of ['deskDay', 'deskMonth'] as const) {
      if (field === 'deskDay' && !base.deskDay) continue;
      if (draft.follow[field]) {
        if (l.desk[field] != null) {
          policy[field] = null; // this desk's own goes, and it follows the account
          deskChanged = true;
        }
      } else if (changed(draft, view, field)) {
        policy[field] = money(field); // blank: both caps null, which is no limit, set on this desk
        deskChanged = true;
      }
    }
    if (draft.follow.timeZone) {
      if (l.desk.timeZone != null) change.timeZone = null;
    } else if (changed(draft, view, 'timeZone')) {
      const zone = canonicalZone(draft.timeZone);
      if (!zone) errors.timeZone = ZONE_PICK;
      else if (!zonePlausible(zone)) errors.timeZone = ZONE_UNKNOWN;
      else change.timeZone = zone;
    }
  } else {
    // An older desk: `deskMonth` is required with a policy, and it has no `deskDay` or zone to set.
    policy.deskMonth = money('deskMonth');
    agentChanged ||= !sameLimit(policy.deskMonth, base.deskMonth);
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  if (agentChanged || deskChanged) change.policy = policy;
  return { ok: true, change: Object.keys(change).length ? change : null };
}

// ------------------------------------------------------------ time zones

/** When the desk refuses a zone (`bad_request`, `reason: time_zone`), or one plainly isn't. */
export const ZONE_UNKNOWN = 'That isn’t a time zone your desk knows. Pick one from the list, like Europe/Paris.';
const ZONE_PICK = 'Pick a time zone from the list, like Europe/Paris.';

/** Names that mean UTC. The desk takes only `UTC` itself for it, since the others are fixed offsets there. */
const UTC_NAMES = new Set(['utc', 'etc/utc', 'gmt', 'etc/gmt', 'gmt0', 'gmt+0', 'gmt-0', 'etc/gmt0', 'etc/gmt+0', 'etc/gmt-0', 'uct', 'etc/uct', 'universal', 'etc/universal', 'zulu', 'etc/zulu', 'greenwich', 'etc/greenwich']);

let zones: string[] | null = null;

/** Every zone this browser knows, UTC first: what the zone field offers. Read once. */
export function zoneList(): string[] {
  if (!zones) {
    const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    zones = ['UTC', ...all.filter((z) => !UTC_NAMES.has(z.toLowerCase()))];
  }
  return zones;
}

/** What the member typed, as the desk wants it: `UTC` for any of its names, and a zone's own spelling whatever the case. */
export function canonicalZone(text: string): string {
  const t = text.trim();
  if (UTC_NAMES.has(t.toLowerCase())) return 'UTC';
  return zoneList().find((z) => z.toLowerCase() === t.toLowerCase()) ?? t;
}

/** Whether a zone could be one the desk knows: not a fixed offset, and one this browser can show. The desk has the last word. */
function zonePlausible(zone: string): boolean {
  if (zone === 'UTC') return true;
  if (/^(etc\/|[+-]|gmt[+-])/i.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** This browser's zone, as the desk takes it, or null for one it wouldn't (a fixed offset). */
export function browserZone(): string | null {
  try {
    const zone = canonicalZone(Intl.DateTimeFormat().resolvedOptions().timeZone ?? '');
    return zone && zonePlausible(zone) ? zone : null;
  } catch {
    return null;
  }
}

/** Set the zone from this browser, once, with no question: a layered desk where nothing sets one, so its days run in UTC. */
export function needsZone(view: LimitsView): boolean {
  const l = layers(view);
  return Boolean(l) && view.timeZone == null && l?.desk.timeZone == null && l?.account.timeZone == null;
}

/** A zone as words: `America/New York`. */
export function zoneLabel(zone: string | null | undefined): string {
  return (zone ?? 'UTC').replace(/_/g, ' ');
}

/**
 * When a period starts again, in the desk's zone: `Resets at midnight`, `Resets Monday`, `Resets Dec 1`. With the zone named when
 * it isn't this browser's, since "midnight" would mean another one. Null for a scope with no period.
 */
export function resetText(scope: LimitScope, resetsAt: number | null, view: LimitsView, here: string | null = browserZone()): string | null {
  if (resetsAt == null) return null;
  const zone = view.timeZone ?? 'UTC';
  let when: string;
  if (scope === 'agent_day' || scope === 'desk_day') when = 'at midnight';
  else if (scope === 'agent_week') when = 'Monday';
  else if (scope === 'agent_month' || scope === 'desk_month' || scope === 'key_month') {
    try {
      when = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric' }).format(resetsAt);
    } catch {
      return null;
    }
  } else return null;
  return `Resets ${when}${zone === here ? '' : ` (${zoneLabel(zone)})`}`;
}

/** `pricesAsOf`'s `yyyy-MM-dd` as `Nov 6, 2026`; anything else as it came. */
export function pricesDate(asOf: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOf);
  if (!m) return asOf;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

/** A model's line where the price table doesn't list it. */
export const UNPRICED = 'No listed price, so it counts at this provider’s highest.';

/** What the thread says when a limit refused a message. */
export function refusalText(scope: LimitScope | null, view: LimitsView | null): string {
  // A scope this app doesn't know yet says the plain line, rather than nothing or a crash.
  const head = (scope && SCOPE_REACHED[scope]) || 'A usage limit is reached';
  const key = scope && scope !== 'run_steps' ? POLICY_KEY[scope] : undefined;
  const limit = key && view ? (view.policy[key]?.maxMicroUsd ?? null) : null;
  const amount = limit != null ? ` (${usdLimit(limit)})` : '';
  return `${head}${amount}. Nothing was sent. Raise the limit, or wait for it to reset.`;
}
