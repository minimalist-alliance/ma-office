// The lead's proposals (multi-agent.md section 3): what a card shows, and the check that what it shows is what the
// member's yes applies. The desk applies the payload it stored, and only if the `sha256` sent back is that payload's; the
// card checks the payload it was given hashes to the same `sha256` before it offers Confirm, so a card can't show one
// change and confirm another. Canonical JSON here: object keys sorted by UTF-16 code unit (JavaScript's default sort,
// Java's String.compareTo), no whitespace, strings and numbers as JSON.stringify writes them, absent members dropped
// (RFC 8785 for every value a payload can hold: strings, integers, booleans, null, arrays, objects).
import type { Agent, AgentLook, Proposal, ProposalState, TimerInput } from '../client/types';
import { bytesText, MB } from './workspace';
import { durationText, scheduleText } from './timers';

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    const s = JSON.stringify(v);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * What a card shows is what its `sha256` names: the canonical JSON of `value` hashes to it. Proposals hash their payload;
 * approvals hash `{v: 1, agentId, runId, tool, context, payload}` (deskd API.md section 18). Either way the card hashes what it
 * shows, never a copy of the field, and offers its yes only on a match.
 */
export async function payloadChecks(value: unknown, sha256: string): Promise<boolean> {
  try {
    return typeof sha256 === 'string' && (await sha256Hex(canonicalJson(value))) === sha256.toLowerCase();
  } catch {
    return false;
  }
}

/** The payload this card shows is the one its `sha256` names. */
export function proposalChecks(p: Pick<Proposal, 'payload' | 'sha256'>): Promise<boolean> {
  return payloadChecks(p.payload, p.sha256);
}

/** Waiting for the member, and not past its 24 hours. */
export const proposalOpen = (p: Pick<Proposal, 'state' | 'expiresAt'>, now: number): boolean => p.state === 'pending' && p.expiresAt > now;

export const STATE_TEXT: Record<ProposalState, string> = {
  pending: 'Waiting for you',
  applied: 'Done',
  applied_partly: 'Partly done',
  declined: 'Declined',
  failed: 'Not done:',
  expired: 'Expired',
};

/** Why an applied yes failed or expired, in words. */
export function failedText(detail: string | null): string {
  switch (detail) {
    case 'agent_cap':
      return 'This desk already has as many agents as it can hold.';
    case 'timer_cap':
      return 'That agent already has as many timers as it can have.';
    case 'workspace_full':
      return 'That workspace holds more than the new size.';
    case 'not_found':
      return 'That agent isn’t on this desk any more.';
    case 'links':
      return 'One of these agents isn’t on this desk any more.';
    case 'name_taken':
      return 'This desk already has an agent with that name. Ask the lead for another.';
    case 'disk_budget':
      return 'The desk has no room left to give workspaces that much.';
    case 'stopped':
      return 'You stopped the run that made this.';
    case null:
    default:
      return 'The desk couldn’t make this change.';
  }
}

/** One line of what a card will change. Values are untrusted text and render as text. */
export interface ChangeRow {
  label: string;
  value: string;
  /** What it is now, when the change replaces it: shown as "old → new". */
  before?: string;
  /** A warning under the row (a size below what's used). */
  warn?: string;
  /** Long text (a purpose, rules, a prompt): shown collapsed. */
  long?: boolean;
}

/** An agent on a card: its name, its look, and an id suffix when another agent's name is close to it. */
export interface AgentTag {
  id: string;
  name: string;
  look: { icon: string; tone: string } | null;
  /** Set when two names are close: the end of the id. */
  hint: string | null;
}

export interface ChangeLink {
  to: string;
  tag: AgentTag;
  /** The agent is no longer on the desk. */
  gone: boolean;
  rules: string;
}

export interface ChangeTimer {
  label: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  /** The timer this one replaces (a timer change), in the same words. */
  was?: ChangeTimer;
  /** The change switches a timer back on. */
  turnsOn?: boolean;
  /** The timer a removal takes away. */
  removed?: boolean;
}

/** A purpose change, in full: the old and new text, for a diff. */
export interface PurposeChange {
  before: string;
  after: string;
  /** The lead's own purpose. */
  lead: boolean;
}

export interface ChangeView {
  title: string;
  /** The agent the change is about, when it's already on the desk. */
  agentId: string | null;
  /** The same agent as it shows on the card. */
  subject: AgentTag | null;
  rows: ChangeRow[];
  /** Links in the payload, `null` where it doesn't touch them. */
  links: ChangeLink[] | null;
  timers: ChangeTimer[];
  /** The look the change gives the agent, for a preview: icon and tone ids. */
  look: { icon: string; tone: string } | null;
  /** A muted line above the buttons: what it costs, or how to undo it. */
  note: string | null;
  /** A removal: the danger button's words, and what goes with it. */
  remove: { button: string; goesWith: string } | null;
  /** The agent or a link target it needs is gone: it can't be confirmed. */
  gone: boolean;
  /** A new name another agent here already has. */
  nameTaken: string | null;
  /** The icon and tone pair another agent here already has. */
  lookTaken: boolean;
  /** "Suggested while answering Writer", when the member didn't start the run. */
  stamp: string | null;
  /** A purpose change, which has to be opened before Confirm works. */
  purpose: PurposeChange | null;
}

/** About how many runs a month a timer makes: days x 4.3, or 43,200 / every N minutes, or 1 for a one-shot. */
export function runsPerMonth(t: Partial<Pick<TimerInput, 'kind' | 'days' | 'everyMinutes'>>): number {
  if (t.kind === 'once') return 1;
  if (t.everyMinutes != null && t.everyMinutes > 0) return Math.max(1, Math.round(43_200 / t.everyMinutes));
  return Math.max(1, Math.round(new Set(t.days ?? []).size * 4.3));
}

/** What a removal takes with it, and what it leaves (the message log keeps its rows 100 days). */
export const GOES_WITH = 'Its thread, memories, workspace, timers, links and icon. Its messages stay in the Agent messages log for 100 days.';

const RETIRED_ICON: Record<string, string> = { globe: 'plane', chat: 'person', heart: 'wallet', star: 'bulb', puzzle: 'terminal', briefcase: 'document' };
const RETIRED_TONE: Record<string, string> = { moss: 'green', sky: 'blue' };
const CONFUSABLE: Record<string, string> = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ѕ: 's', ј: 'j', ο: 'o', ν: 'v', α: 'a', ε: 'e', ι: 'i', κ: 'k', ρ: 'p', τ: 't', υ: 'u', χ: 'x' };

/** A name as the desk compares it: NFKC, folded, trimmed, no format characters, look-alikes as Latin. */
export function nameKey(name: string): string {
  return [...name.normalize('NFKC').toLowerCase().trim().replace(/\p{Cf}/gu, '')].map((c) => CONFUSABLE[c] ?? c).join('');
}

const wordsOnly = (name: string): string => nameKey(name).replace(/[^\p{L}\p{N}]/gu, '');

function editWithinOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}

/** Two names close enough to mistake for one another. */
export const namesClose = (a: string, b: string): boolean => {
  const x = wordsOnly(a);
  const y = wordsOnly(b);
  return x.length > 0 && (x === y || (Math.min(x.length, y.length) >= 4 && editWithinOne(x, y)));
};

const lookKey = (icon: string, tone: string): string => `${RETIRED_ICON[icon] ?? icon}/${RETIRED_TONE[tone] ?? tone}`;

/** An agent as a card needs it. */
export type CardAgent = Pick<Agent, 'id' | 'name'> & Partial<Pick<Agent, 'lead' | 'role' | 'purpose' | 'solo' | 'workspace'>> & { look?: Pick<AgentLook, 'icon' | 'tone'> | null; binding?: { keyId: string; model: string } | null };

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * What a proposal will change, every field of its payload, in words. A field the card doesn't know still shows, by its own
 * name, so nothing in the payload is ever left off the card the member confirms.
 */
export function describeProposal(
  p: Pick<Proposal, 'action' | 'payload'> & Partial<Pick<Proposal, 'before' | 'origin' | 'state'>>,
  ctx: {
    agents: readonly CardAgent[];
    keyName?: (keyId: string) => string | null;
    keyLabel?: (keyId: string) => string | null;
    /** A model's name ("Claude Sonnet 4.5") for its id, or null when unknown. */
    modelLabel?: (model: string) => string | null;
    zone: string | null;
    iconLabel: (id: string) => string;
    toneLabel: (id: string) => string;
  },
): ChangeView {
  const payload = p.payload ?? {};
  const before = p.before ? rec(p.before) : null;
  const pending = p.state === undefined || p.state === 'pending';
  const rows: ChangeRow[] = [];
  const seen = new Set<string>();
  const take = (key: string): unknown => {
    seen.add(key);
    return payload[key];
  };
  let links: ChangeLink[] | null = null;
  const timers: ChangeTimer[] = [];
  let look: ChangeView['look'] = null;
  let agentId: string | null = null;
  let gone = false;
  let purpose: PurposeChange | null = null;
  let nameTaken: string | null = null;
  let lookTaken = false;

  const find = (id: string | null): CardAgent | undefined => (id ? ctx.agents.find((a) => a.id === id) : undefined);
  const tagOf = (id: string, fallbackName: string | null): AgentTag => {
    const a = find(id);
    const name = a?.name ?? fallbackName ?? 'a deleted agent';
    const close = a ? ctx.agents.some((o) => o.id !== a.id && namesClose(o.name, a.name)) : false;
    return { id, name, look: a?.look ? { icon: a.look.icon, tone: a.look.tone } : null, hint: close ? `…${id.slice(-4)}` : null };
  };
  const goneName = (id: string | null): string | null => (id && id === agentId ? str(before?.['name']) : null);
  const nameOf = (id: unknown): string => {
    const s = str(id) ?? '';
    return find(s)?.name ?? goneName(s) ?? (s ? 'a deleted agent' : 'an unnamed agent');
  };
  /** Another agent here with this look, apart from the agent itself. */
  const others = (self: string | null): CardAgent[] => ctx.agents.filter((a) => a.id !== self);

  const modelText = (m: string): string => ctx.modelLabel?.(m) ?? m;
  const soloText = (solo: boolean): string => (solo ? 'No, solo' : 'Yes, as its links allow');

  const fields = (self: string | null): void => {
    const current = find(self);
    const was = (field: string): unknown => (before && field in before ? before[field] : undefined);
    const row = (label: string, value: string, old: string | undefined, extra: Partial<ChangeRow> = {}): void => {
      rows.push({ label, value, ...(old !== undefined && old !== value ? { before: old } : {}), ...extra });
    };
    const name = str(take('name'));
    if (name !== null) {
      row('Name', name, self ? (str(was('name')) ?? current?.name) : undefined);
      if (pending && others(self).some((a) => nameKey(a.name) === nameKey(name))) nameTaken = name;
    }
    const newPurpose = take('purpose');
    if (typeof newPurpose === 'string') {
      const old = self ? (str(was('purpose')) ?? current?.purpose ?? null) : null;
      if (self && old !== null) purpose = { before: old, after: newPurpose, lead: current?.lead === true || current?.role === 'manager' };
      else rows.push({ label: 'Purpose', value: newPurpose || 'The built-in default', long: newPurpose.length > 0 });
    }
    const icon = str(take('icon'));
    const tone = str(take('tone'));
    const oldIcon = self ? (str(was('icon')) ?? current?.look?.icon) : undefined;
    const oldTone = self ? (str(was('tone')) ?? current?.look?.tone) : undefined;
    if (icon !== null) row('Icon', ctx.iconLabel(icon), oldIcon != null ? ctx.iconLabel(oldIcon) : undefined);
    if (tone !== null) row('Color', ctx.toneLabel(tone), oldTone != null ? ctx.toneLabel(oldTone) : undefined);
    if (icon !== null || tone !== null) {
      look = { icon: icon ?? oldIcon ?? 'nodes', tone: tone ?? oldTone ?? 'graphite' };
      // Only a pair the member sees both halves of can clash: with no tone the desk picks a free one.
      const pair = icon !== null && tone !== null ? lookKey(icon, tone) : self && icon !== null && oldTone ? lookKey(icon, oldTone) : self && tone !== null && oldIcon ? lookKey(oldIcon, tone) : null;
      if (pending && pair && others(self).some((a) => a.look && lookKey(a.look.icon, a.look.tone) === pair)) lookTaken = true;
    }
    const keyId = str(take('keyId'));
    const oldKey = self ? (str(was('keyId')) ?? current?.binding?.keyId) : undefined;
    if (keyId !== null) row('Key', ctx.keyLabel?.(keyId) ?? 'a key on this desk', oldKey != null ? (ctx.keyLabel?.(oldKey) ?? 'a key on this desk') : undefined);
    const model = str(take('model'));
    const oldModel = self ? (str(was('model')) ?? current?.binding?.model) : undefined;
    if (model !== null) row('Model', modelText(model), oldModel != null ? modelText(oldModel) : undefined);
    const solo = take('solo');
    if (typeof solo === 'boolean') {
      const oldSolo = self ? (typeof was('solo') === 'boolean' ? (was('solo') as boolean) : current?.solo) : undefined;
      row('Messages other agents', soloText(solo), oldSolo != null ? soloText(oldSolo) : undefined);
    }
    const mb = num(take('workspaceMb'));
    if (mb !== null) {
      const oldMb = self ? (num(was('workspaceMb')) ?? (current?.workspace ? Math.round(current.workspace.quotaBytes / MB) : null)) : null;
      const used = self ? (num(was('usedBytes')) ?? current?.workspace?.usedBytes ?? null) : null;
      row('Workspace', `${mb} MB`, oldMb != null ? `${oldMb} MB` : undefined, used != null && used > mb * MB ? { warn: `${nameOf(self)} already uses ${bytesText(used)}; delete files first.` } : {});
    }
  };
  const readLinks = (v: unknown): ChangeLink[] =>
    (Array.isArray(v) ? v : []).map((l) => {
      const o = rec(l);
      const id = str(o['to']) ?? '';
      const tag = tagOf(id, null);
      if (!find(id) && id) gone = true;
      return { to: tag.name, tag, gone: !find(id), rules: str(o['rules']) ?? '' };
    });
  const timerOf = (v: unknown): ChangeTimer => {
    const t = rec(v) as Partial<TimerInput> & { enabled?: boolean };
    const schedule = t.kind === 'once' && t.inMinutes != null && t.at == null ? `Once, in ${durationText(t.inMinutes)}` : scheduleText({ kind: t.kind ?? 'once', days: t.days ?? null, time: t.time ?? null, everyMinutes: t.everyMinutes ?? null, at: t.at ?? null }, ctx.zone);
    return { label: str(t.label) ?? 'Timer', schedule: t.enabled === false ? `${schedule} (off)` : schedule, prompt: str(t.prompt) ?? '', enabled: t.enabled !== false };
  };

  let title: string;
  let subjectId: string | null = null;
  switch (p.action) {
    case 'agent.create': {
      title = `Add the agent “${str(payload['name']) ?? 'unnamed'}”`;
      fields(null);
      if ('links' in payload) links = readLinks(take('links'));
      if ('timers' in payload) for (const t of Array.isArray(take('timers')) ? (payload['timers'] as unknown[]) : []) timers.push(timerOf(t));
      break;
    }
    case 'agent.update': {
      agentId = str(take('agentId'));
      subjectId = agentId;
      title = `Change ${nameOf(agentId)}`;
      if (!find(agentId)) gone = true;
      fields(agentId);
      // A change to the icon alone (or the color alone) previews the result: the half it leaves is the agent's current one.
      const now = ctx.agents.find((a) => a.id === agentId)?.look;
      if (look && now) look = { icon: str(payload['icon']) ?? (now.icon === 'png' ? 'nodes' : now.icon), tone: str(payload['tone']) ?? now.tone };
      break;
    }
    case 'agent.delete': {
      agentId = str(take('agentId'));
      subjectId = agentId;
      title = `Remove ${nameOf(agentId)}`;
      if (!find(agentId)) gone = true;
      rows.push({ label: 'Goes with it', value: GOES_WITH });
      break;
    }
    case 'agent.links': {
      agentId = str(take('agentId'));
      subjectId = agentId;
      title = `Change whom ${nameOf(agentId)} may message`;
      if (!find(agentId)) gone = true;
      const solo = take('solo');
      if (typeof solo === 'boolean') {
        const oldSolo = typeof before?.['solo'] === 'boolean' ? (before['solo'] as boolean) : find(agentId)?.solo;
        rows.push({ label: 'Messages other agents', value: soloText(solo), ...(oldSolo != null && oldSolo !== solo ? { before: soloText(oldSolo) } : {}) });
      }
      links = readLinks(take('links'));
      break;
    }
    case 'timer.set': {
      agentId = str(take('agentId'));
      subjectId = agentId;
      if (!find(agentId)) gone = true;
      const timer = rec(take('timer'));
      title = `${str(timer['id']) ? 'Change a timer of' : 'Add a timer to'} ${nameOf(agentId)}`;
      const next = timerOf(timer);
      const old = before?.['timer'] ? timerOf(before['timer']) : null;
      if (old) {
        next.was = old;
        if (!old.enabled && next.enabled) next.turnsOn = true;
      }
      timers.push(next);
      break;
    }
    case 'timer.delete': {
      agentId = str(take('agentId'));
      subjectId = agentId;
      if (!find(agentId)) gone = true;
      take('timerId');
      const label = str(take('label'));
      title = `Remove a timer from ${nameOf(agentId)}`;
      const t = before?.['timer'] ? timerOf(before['timer']) : null;
      if (t) timers.push({ ...t, removed: true });
      else if (label) timers.push({ label, schedule: '', prompt: '', enabled: true, removed: true });
      break;
    }
    default:
      title = `A change the app doesn’t know (${String(p.action)})`;
  }

  const who = nameOf(agentId);
  let note: string | null = null;
  let remove: ChangeView['remove'] = null;
  switch (p.action) {
    case 'agent.create': {
      const keyId = str(payload['keyId']);
      const key = keyId ? ctx.keyName?.(keyId) : null;
      note = `Runs on your ${key ? `${key} ` : ''}key and counts toward its limits. Change or delete it any time in its settings.`;
      break;
    }
    case 'timer.set':
      note = `Each run counts toward ${who}’s limits, about ${runsPerMonth(rec(payload['timer']) as Partial<TimerInput>)} runs a month. It skips a run when a limit is reached.`;
      break;
    case 'agent.update':
    case 'agent.links':
    case 'timer.delete':
      note = `You can change this back in ${who}’s settings.`;
      break;
    case 'agent.delete':
      note = 'This can’t be undone.';
      remove = { button: `Remove ${who}`, goesWith: GOES_WITH };
      break;
    default:
  }
  // Anything left over still shows, as it came.
  for (const [k, v] of Object.entries(payload)) {
    if (seen.has(k) || v === undefined) continue;
    rows.push({ label: `Other change: ${k}`, value: typeof v === 'string' ? v : canonicalJson(v), long: true });
  }
  const o = p.origin;
  const stamp = o?.kind === 'agent' ? `Suggested while answering ${o.name}` : o?.kind === 'timer' ? `Suggested by the timer ${o.label}` : null;
  const subject = subjectId ? tagOf(subjectId, goneName(subjectId)) : null;
  if (subject && !subject.look && before?.['look']) {
    const l = rec(before['look']);
    if (str(l['icon']) && str(l['tone'])) subject.look = { icon: str(l['icon'])!, tone: str(l['tone'])! };
  }
  return { title, agentId, subject, rows, links, timers, look, note, remove, gone, nameTaken, lookTaken, stamp, purpose };
}

/** A line diff, then words within a changed line, flattened to runs: `=` same, `-` removed, `+` added. */
export interface DiffRun {
  op: '=' | '-' | '+';
  text: string;
}

/** A word-level diff of two texts, whitespace kept. Past 4,000 words each it falls back to the old text struck and the new one added. */
export function diffText(a: string, b: string): DiffRun[] {
  const x = a.match(/\s+|\S+/g) ?? [];
  const y = b.match(/\s+|\S+/g) ?? [];
  if (x.length > 1500 || y.length > 1500) return [...(a ? [{ op: '-' as const, text: a }] : []), ...(b ? [{ op: '+' as const, text: b }] : [])];
  const w = y.length + 1;
  const t = new Uint16Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i * w + j] = x[i] === y[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
  const runs: DiffRun[] = [];
  const push = (op: DiffRun['op'], text: string): void => {
    const last = runs[runs.length - 1];
    if (last && last.op === op) last.text += text;
    else runs.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      push('=', x[i]!);
      i++;
      j++;
    } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) push('-', x[i++]!);
    else push('+', y[j++]!);
  }
  while (i < x.length) push('-', x[i++]!);
  while (j < y.length) push('+', y[j++]!);
  return runs;
}

/** Too little in common for the inline diff to read: show the old text and the new one apart. */
export function diffIsChoppy(runs: readonly DiffRun[], before: string, after: string): boolean {
  const same = runs.filter((r) => r.op === '=').reduce((n, r) => n + r.text.replace(/\s/g, '').length, 0);
  const longest = Math.max(before.replace(/\s/g, '').length, after.replace(/\s/g, '').length);
  return longest > 0 && same / longest < 0.5;
}
