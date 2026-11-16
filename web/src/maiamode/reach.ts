// What reaches the member, as the office reads it (the focus shield; deskd API.md §23 "What reaches the member", topic
// `agent.maia`'s `reach` and the `agent.maia.reach.*` methods): the pure readers, the welcome's helper and the settings' shapes,
// tested in `reach.test.ts`. Everything a desk sends is read leniently and treated as plain text cut to its limit (`plain`); a
// field out of shape is dropped, never an error. Code on the home desk decides what reaches the member, never a model.
import type { FocusRef } from './focus';
import { plain } from './model';
import { readTray, type Tray } from './tray';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const id = (v: unknown, max = 80): string | null => (typeof v === 'string' && /^[A-Za-z0-9_:.-]+$/.test(v) && v.length <= max ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const word = <T extends string>(v: unknown, set: readonly T[], fallback: T): T => ((set as readonly unknown[]).includes(v) ? (v as T) : fallback);

// ----- shapes

export interface Who {
  deskId: string;
  contactId: string;
}
export interface Choice {
  id: string;
  label: string;
}

/** A card's or a line's one thing, the list's `action` shape (§23) plus `doc` and `back`. */
export type ReachGo =
  | { kind: 'approvals'; deskId: string; approvalIds: string[] }
  | { kind: 'show'; deskId: string; app: string; ref: string | null }
  | { kind: 'doc'; deskId: string; docId: string }
  | { kind: 'result'; messageId: string }
  | { kind: 'notes'; deskId: string | null }
  | { kind: 'wake'; deskId: string | null }
  | { kind: 'back'; cardId: string; deskId: string | null; app: string | null; item: FocusRef | null }
  | { kind: 'paper'; paperId: string }
  | { kind: 'none' };

export type LineKind = 'clear' | 'held' | 'catchup' | 'hold' | 'heads_up' | 'back' | 'pickup';
export type LineAction = { kind: 'back'; cardId: string } | { kind: 'pickup'; itemId: string; cardId: string | null } | { kind: 'catchup'; catchupId: string } | { kind: 'heads_up'; cardId: string } | null;
export interface ReachLine {
  kind: LineKind;
  text: string;
  held: number;
  dot: 'accent' | 'none';
  action: LineAction;
}
export interface Rider {
  itemId: string;
  kind: string;
  source: string;
  what: string;
  why: string | null;
  go: ReachGo;
  goLabel: string;
}
export interface ReachCard extends Rider {
  cardId: string;
  level: 'interrupt' | 'offer';
  deskId: string | null;
  whyMore: string | null;
  choices: Choice[];
  quote: { deskId: string; channelId: string } | null;
  who: Who | null;
  first: { text: string; choices: Choice[] } | null;
  after: { text: string; choices: Choice[]; until: number | null } | null;
  more: Rider[];
  at: number;
  tuckAt: number | null;
}
export interface CatchUpItem {
  itemId: string;
  line: string;
  go: ReachGo;
  goLabel: string;
  choices: Choice[];
}
export interface CatchUpGroup {
  id: 'needs_you' | 'working_on' | 'read_later' | 'records' | 'done_for_you';
  label: string;
  items: CatchUpItem[];
  summary: string | null;
}
export interface CatchUpQuestion {
  questionId: string;
  text: string;
  choices: Choice[];
  who: Who | null;
}
export interface CatchUp {
  catchupId: string;
  kind: 'brief' | 'catchup' | 'return' | 'evening';
  head: string;
  groups: CatchUpGroup[];
  lines: string[];
  question: CatchUpQuestion | null;
  end: string;
  at: number;
  waiting: boolean;
}
export interface ReachBack {
  cardId: string;
  label: string;
  resume: string;
  deskId: string | null;
  app: string | null;
  item: FocusRef | null;
  surface: string | null;
  until: number | null;
}
export interface Reach {
  on: boolean;
  device: string | null;
  line: ReachLine;
  card: ReachCard | null;
  catchup: CatchUp | null;
  back: ReachBack | null;
  working: { label: string } | null;
  hold: { until: number } | null;
  held: { count: number; now: number };
  /** The tiles that keep the accent under the shield (an interrupt-level item waits there): ids only. */
  accent: { deskId: string; app: string; agentId: string | null }[];
  /** The decision tray: what needs the member's decision, one paper each (`tray.ts`); null from a desk without it. */
  tray: Tray | null;
}

// ----- readers

const GROUP_IDS = ['needs_you', 'working_on', 'read_later', 'records', 'done_for_you'] as const;
const LINE_KINDS = ['clear', 'held', 'catchup', 'hold', 'heads_up', 'back', 'pickup'] as const;
const ITEM_KINDS = new Set(['page', 'thread', 'channel', 'todo', 'folder', 'run']);

const who = (v: unknown): Who | null => {
  const o = obj(v);
  const deskId = id(o['deskId']);
  const contactId = id(o['contactId'], 40);
  return deskId && contactId ? { deskId, contactId } : null;
};

/** 1 to `max` choices, each a short id and its label (§23: the card's 1 to 3; a question's 2 to 4). */
export function readChoiceList(v: unknown, max = 4): Choice[] {
  return arr(v)
    .flatMap((c) => {
      const o = obj(c);
      const cid = id(o['id'], 40);
      const label = plain(o['label'], 40);
      return cid && label ? [{ id: cid, label }] : [];
    })
    .slice(0, max);
}

const ref = (v: unknown): FocusRef | null => {
  const o = obj(v);
  const kind = o['kind'];
  const rid = typeof o['id'] === 'string' && /^[A-Za-z0-9_:-]{1,80}$/.test(o['id']) ? o['id'] : null;
  return typeof kind === 'string' && ITEM_KINDS.has(kind) && rid ? { kind: kind as FocusRef['kind'], id: rid } : null;
};

/** The one thing, read leniently: anything it doesn't know is nothing to do (no button). */
export function readGo(v: unknown): ReachGo {
  const a = obj(v);
  const deskId = id(a['deskId']);
  switch (a['kind']) {
    case 'approvals': {
      const approvalIds = arr(a['approvalIds']).map((x) => id(x)).filter((x): x is string => !!x).slice(0, 20);
      return deskId ? { kind: 'approvals', deskId, approvalIds } : { kind: 'none' };
    }
    case 'show': {
      const app = typeof a['app'] === 'string' && /^[a-z][a-z0-9:._-]{0,120}$/.test(a['app']) ? a['app'] : null;
      const r = a['ref'];
      // Never a URL as a ref (`readShow`'s rule).
      const refId = typeof r === 'string' && r.length <= 200 && !/^[a-z][a-z0-9+.-]*:/i.test(r) ? r : null;
      return deskId && app ? { kind: 'show', deskId, app: app === 'approvals' ? 'agent' : app, ref: refId } : { kind: 'none' };
    }
    case 'doc': {
      const docId = id(a['docId']);
      return deskId && docId ? { kind: 'doc', deskId, docId } : { kind: 'none' };
    }
    case 'result': {
      const messageId = id(a['messageId']);
      return messageId ? { kind: 'result', messageId } : { kind: 'none' };
    }
    case 'notes':
      return { kind: 'notes', deskId };
    case 'wake':
      return { kind: 'wake', deskId };
    case 'paper': {
      const paperId = typeof a['paperId'] === 'string' && /^pp-[a-z2-7]{20}$/.test(a['paperId']) ? a['paperId'] : null;
      return paperId ? { kind: 'paper', paperId } : { kind: 'none' };
    }
    case 'back': {
      const cardId = id(a['cardId']);
      const app = typeof a['app'] === 'string' && /^[a-z][a-z0-9:_-]{0,80}$/.test(a['app']) ? a['app'] : null;
      return cardId ? { kind: 'back', cardId, deskId, app, item: ref(a['item']) } : { kind: 'none' };
    }
    default:
      return { kind: 'none' };
  }
}

function readRider(v: unknown): Rider | null {
  const o = obj(v);
  const itemId = id(o['itemId']);
  const what = plain(o['what'], 200);
  if (!itemId || !what) return null;
  return { itemId, kind: plain(o['kind'], 24) || 'item', source: plain(o['source'], 121), what, why: plain(o['why'], 80) || null, go: readGo(o['go']), goLabel: plain(o['goLabel'], 24) || 'Open' };
}

function readCard(v: unknown): ReachCard | null {
  const o = obj(v);
  const base = readRider(o);
  const cardId = id(o['cardId']);
  if (!base || !cardId) return null;
  const q = obj(o['quote']);
  const quoteDesk = id(q['deskId']);
  const channelId = id(q['channelId']);
  const first = obj(o['first']);
  const after = obj(o['after']);
  return {
    ...base,
    cardId,
    level: o['level'] === 'interrupt' ? 'interrupt' : 'offer',
    deskId: id(o['deskId']),
    whyMore: plain(o['whyMore'], 120) || null,
    choices: readChoiceList(o['choices'], 3),
    quote: quoteDesk && channelId ? { deskId: quoteDesk, channelId } : null,
    who: who(o['who']),
    first: plain(first['text'], 160) ? { text: plain(first['text'], 160), choices: readChoiceList(first['choices'], 2) } : null,
    after: plain(after['text'], 80) ? { text: plain(after['text'], 80), choices: readChoiceList(after['choices'], 2), until: num(after['until']) } : null,
    more: arr(o['more'])
      .map(readRider)
      .filter((r): r is Rider => !!r)
      .slice(0, 2),
    at: num(o['at']) ?? 0,
    tuckAt: num(o['tuckAt']),
  };
}

function readCatchUp(v: unknown): CatchUp | null {
  const o = obj(v);
  const catchupId = id(o['catchupId']);
  if (!catchupId) return null;
  const q = obj(o['question']);
  const questionId = id(q['questionId'], 40);
  const groups = arr(o['groups']).flatMap((g): CatchUpGroup[] => {
    const go = obj(g);
    const gid = go['id'];
    if (!(GROUP_IDS as readonly unknown[]).includes(gid)) return [];
    const items = arr(go['items'])
      .flatMap((i): CatchUpItem[] => {
        const io = obj(i);
        const itemId = id(io['itemId']);
        const line = plain(io['line'], 200);
        return itemId && line ? [{ itemId, line, go: readGo(io['go']), goLabel: plain(io['goLabel'], 24) || 'Open', choices: readChoiceList(io['choices'], 3) }] : [];
      })
      .slice(0, 7);
    const summary = plain(go['summary'], 120) || null;
    return items.length || summary ? [{ id: gid as CatchUpGroup['id'], label: plain(go['label'], 40) || String(gid), items, summary }] : [];
  });
  // Code's order, whatever order they came in.
  groups.sort((a, b) => GROUP_IDS.indexOf(a.id) - GROUP_IDS.indexOf(b.id));
  return {
    catchupId,
    kind: word(o['kind'], ['brief', 'catchup', 'return', 'evening'] as const, 'catchup'),
    head: plain(o['head'], 120),
    groups,
    lines: arr(o['lines'])
      .map((l) => plain(l, 120))
      .filter(Boolean)
      .slice(0, 7),
    question: questionId && plain(q['text'], 160) ? { questionId, text: plain(q['text'], 160), choices: readChoiceList(q['choices'], 4), who: who(q['who']) } : null,
    end: plain(o['end'], 60) || 'That’s all for now.',
    at: num(o['at']) ?? 0,
    waiting: o['waiting'] === true,
  };
}

function readBack(v: unknown): ReachBack | null {
  const o = obj(v);
  const cardId = id(o['cardId']);
  const label = plain(o['label'], 80);
  if (!cardId || !label) return null;
  const app = typeof o['app'] === 'string' && /^[a-z][a-z0-9:_-]{0,80}$/.test(o['app']) ? o['app'] : null;
  return { cardId, label, resume: plain(o['resume'], 160), deskId: id(o['deskId']), app, item: ref(o['item']), surface: plain(o['surface'], 16) || null, until: num(o['until']) };
}

function readLine(v: unknown, held: number): ReachLine {
  const o = obj(v);
  const kind = word(o['kind'], LINE_KINDS, held > 0 ? 'held' : 'clear');
  const a = obj(o['action']);
  const action: LineAction =
    a['kind'] === 'back' && id(a['cardId'])
      ? { kind: 'back', cardId: id(a['cardId'])! }
      : a['kind'] === 'pickup' && id(a['itemId'])
        ? { kind: 'pickup', itemId: id(a['itemId'])!, cardId: id(a['cardId']) }
        : a['kind'] === 'catchup' && id(a['catchupId'])
          ? { kind: 'catchup', catchupId: id(a['catchupId'])! }
          : a['kind'] === 'heads_up' && id(a['cardId'])
            ? { kind: 'heads_up', cardId: id(a['cardId'])! }
            : null;
  return {
    kind,
    text: plain(o['text'], 80) || (kind === 'clear' ? 'All clear' : ''),
    held: Math.max(0, Math.round(num(o['held']) ?? held)),
    // The accent dot only for a heads-up or an interrupt waiting out a call: never a warning colour, never motion.
    dot: o['dot'] === 'accent' ? 'accent' : 'none',
    action,
  };
}

/**
 * The room's snapshot's `reach` (§23 topic `agent.maia`), null while Desk Maia is off or the desk doesn't send it. With `on`
 * false ("Show everything as it comes") nothing of it shows: the list is as it was.
 */
export function readReach(raw: unknown): Reach | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Obj;
  const h = obj(r['held']);
  const count = Math.max(0, Math.round(num(h['count']) ?? 0));
  const device = typeof r['device'] === 'string' && /^dv-[a-z0-9]{8,32}$/.test(r['device']) ? r['device'] : null;
  const working = plain(obj(r['working'])['label'], 40);
  const until = num(obj(r['hold'])['until']);
  return {
    on: r['on'] === true,
    device,
    line: readLine(r['line'], count),
    card: readCard(r['card']),
    catchup: readCatchUp(r['catchup']),
    back: readBack(r['back']),
    working: working ? { label: working } : null,
    hold: until !== null ? { until } : null,
    held: { count, now: Math.max(0, Math.round(num(h['now']) ?? 0)) },
    accent: readAccent(r['accent']),
    tray: readTray(r['tray']),
  };
}

const ACCENT_APPS = new Set(['courier', 'todo', 'agent', 'files', 'notebook', 'maia', 'browser']);

/** `reach.accent`: at most 20 `{deskId, app, agentId}`, each an id and a known app; anything else dropped. */
export function readAccent(raw: unknown): Reach['accent'] {
  const out: Reach['accent'] = [];
  for (const o of arr(raw)) {
    if (out.length >= 20) break;
    const a = obj(o);
    const deskId = id(a['deskId']);
    const app = typeof a['app'] === 'string' && ACCENT_APPS.has(a['app']) ? a['app'] : null;
    if (!deskId || !app) continue;
    out.push({ deskId, app, agentId: app === 'agent' ? id(a['agentId'], 64) : null });
  }
  return out;
}

/** Whether this browser shows the card, the catch-up and Back: only the device the desk names, any when it names none. */
export const shownHere = (reach: Reach | null, device: string): boolean => !!reach && reach.on && (reach.device === null || reach.device === device);

/** `{who}` filled with the sender's name from that desk's Courier, or "Someone" (never sent anywhere: drawn here). */
export function fillWho(text: string, name: string | null): string {
  if (!text.includes('{who}')) return text;
  const n = name ? plain(name, 40) : null;
  // "Someone" where a sentence or a part of the source line starts ("Personal · Someone"), else "someone".
  return text.replace(/\{who\}/g, (_m, at: number) => n ?? (at === 0 || /[·.]\s*$/.test(text.slice(0, at)) ? 'Someone' : 'someone'));
}

// ----- All held

export interface HeldItem {
  itemId: string;
  kind: string;
  deskId: string | null;
  deskName: string;
  title: string;
  level: string;
  reason: string | null;
  at: number;
  /** A person's message: who wrote and its thread, for the row's quick reply (ids only; the name is drawn here). */
  who?: Who | null;
  channelId?: string | null;
}

/** `agent.maia.reach.held`'s items, newest first whatever order they came in. */
export function readHeld(raw: unknown): HeldItem[] {
  return arr(obj(raw)['items'])
    .flatMap((v): HeldItem[] => {
      const o = obj(v);
      const itemId = id(o['itemId']);
      const title = plain(o['title'], 200);
      const go = readGo(o['go']);
      const channelId = go.kind === 'show' && go.app === 'courier' && go.ref && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(go.ref) ? go.ref : null;
      return itemId && title ? [{ itemId, kind: plain(o['kind'], 24) || 'item', deskId: id(o['deskId']), deskName: plain(o['deskName'], 60) || 'A desk', title, level: plain(o['level'], 16), reason: plain(o['reason'], 80) || null, at: num(o['at']) ?? 0, who: who(o['who']), channelId }] : [];
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, 200);
}

/** All held, grouped by desk in the order each desk's newest item came, each group newest first. */
export function heldByDesk(items: readonly HeldItem[]): { deskId: string | null; deskName: string; items: HeldItem[] }[] {
  const out: { deskId: string | null; deskName: string; items: HeldItem[] }[] = [];
  for (const i of items) {
    const g = out.find((x) => x.deskId === i.deskId);
    if (g) g.items.push(i);
    else out.push({ deskId: i.deskId, deskName: i.deskName, items: [i] });
  }
  return out;
}

// ----- the settings (What reaches you)

export type Group = 'family' | 'boss' | 'clients' | 'team' | 'boss_clients';
export type Match = 'due_today' | 'money' | 'waiting_reply';
export type Rule =
  | { ruleId?: string; kind: 'group'; group: Group; anyTime: boolean; source?: string }
  | { ruleId?: string; kind: 'match'; match: Match; anyTime: boolean; source?: string }
  | { ruleId?: string; kind: 'person'; person: Who | { pendingName: string }; anyTime: boolean; source?: string };
export interface Span {
  from: string;
  to: string;
}
export interface ReachSettings {
  letThrough: Rule[];
  holdAll: boolean;
  catchUps: string[];
  focusHours: Span[];
  quietHours: Span | null;
  evenings: 'hold' | 'let';
  detail: 'line' | 'paragraph' | 'full';
  showAll: boolean;
}
export interface Learned {
  ruleId: string;
  line: string;
  at: number;
  who: Who | null;
}
export interface ReachView extends ReachSettings {
  learned: Learned[];
  counts: { heldToday: number; deliveredToday: number; missedThisWeek: number };
}

/** The let-through list holds at most 5 (a desk or agent stuck is always on, and isn't one of them). */
export const LIST_MAX = 5;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const GROUPS: readonly Group[] = ['family', 'boss', 'clients', 'team', 'boss_clients'];
const MATCHES: readonly Match[] = ['due_today', 'money', 'waiting_reply'];

function readRule(v: unknown): Rule | null {
  const o = obj(v);
  const ruleId = id(o['ruleId'], 48) ?? undefined;
  const anyTime = o['anyTime'] === true;
  const source = typeof o['source'] === 'string' ? plain(o['source'], 16) : undefined;
  const base = { ...(ruleId ? { ruleId } : {}), anyTime, ...(source ? { source } : {}) };
  if (o['kind'] === 'group' && (GROUPS as readonly unknown[]).includes(o['group'])) return { ...base, kind: 'group', group: o['group'] as Group };
  if (o['kind'] === 'match' && (MATCHES as readonly unknown[]).includes(o['match'])) return { ...base, kind: 'match', match: o['match'] as Match };
  if (o['kind'] === 'person') {
    const p = obj(o['person']);
    const w = who(p);
    const pending = plain(p['pendingName'], 60);
    if (w) return { ...base, kind: 'person', person: w };
    if (pending) return { ...base, kind: 'person', person: { pendingName: pending } };
  }
  return null;
}

const span = (v: unknown): Span | null => {
  const o = obj(v);
  return typeof o['from'] === 'string' && typeof o['to'] === 'string' && HHMM.test(o['from']) && HHMM.test(o['to']) ? { from: o['from'], to: o['to'] } : null;
};

/** `agent.maia.reach.get`'s (and `.set`'s) `{reach}`, read leniently, each field its default when it's out of shape. */
export function readSettings(raw: unknown): ReachView {
  const r = obj(obj(raw)['reach']);
  const c = obj(r['counts']);
  const count = (k: string): number => Math.max(0, Math.round(num(c[k]) ?? 0));
  return {
    letThrough: arr(r['letThrough'])
      .map(readRule)
      .filter((x): x is Rule => !!x)
      .slice(0, LIST_MAX),
    holdAll: r['holdAll'] === true,
    catchUps: arr(r['catchUps'])
      .filter((t): t is string => typeof t === 'string' && HHMM.test(t))
      .slice(0, 8),
    focusHours: arr(r['focusHours'])
      .map(span)
      .filter((x): x is Span => !!x)
      .slice(0, 3),
    quietHours: span(r['quietHours']),
    evenings: r['evenings'] === 'let' ? 'let' : 'hold',
    detail: word(r['detail'], ['line', 'paragraph', 'full'] as const, 'paragraph'),
    showAll: r['showAll'] === true,
    learned: arr(r['learned'])
      .flatMap((v): Learned[] => {
        const o = obj(v);
        const ruleId = id(o['ruleId'], 48);
        const line = plain(o['line'], 160);
        return ruleId && line ? [{ ruleId, line, at: num(o['at']) ?? num(o['createdAt']) ?? 0, who: who(o['who']) }] : [];
      })
      .slice(0, 50),
    counts: { heldToday: count('heldToday'), deliveredToday: count('deliveredToday'), missedThisWeek: count('missedThisWeek') },
  };
}

// ----- the welcome's Q4 to Q7 (built in parallel in `welcome/`): its answers as `agent.maia.reach.set`'s params

/** The welcome's catalogue ids (welcome CONTRACT.md "Catalogue ids"): q4 multi, q5 single, q6 multi, q7 single. Null is Skip. */
export interface WelcomeReachAnswers {
  q4?: readonly string[] | null;
  /** The names typed under "Someone by name…": straight to the home desk, never to a model. */
  names?: readonly string[];
  q5?: string | null;
  q6?: readonly string[] | null;
  q7?: string | null;
}
export interface WelcomeReach {
  params: Pick<ReachSettings, 'letThrough' | 'holdAll' | 'catchUps' | 'focusHours' | 'detail'>;
  /** Entries past the 5 the list holds, in the order they'd have come (the welcome asks which to swap). */
  over: Rule[];
}

export const CATCH_UPS: Record<string, string[]> = {
  three: ['09:00', '13:00', '17:00'],
  two: ['09:00', '17:00'],
  often: ['09:00', '11:00', '13:00', '15:00', '17:00'],
  ask: [],
};
export const FOCUS_SPANS: Record<string, Span> = { mornings: { from: '09:00', to: '12:00' }, afternoons: { from: '14:00', to: '17:00' } };

/**
 * The welcome's answers to What should always reach you? (Q4), When would you like me to catch you up? (Q5), When do you do your
 * best focused work? (Q6) and how much (Q7), as `agent.maia.reach.set`'s params. Skip (null or absent) is the contract's
 * default: due today and money; 9:00, 1:00 and 5:00; no focus hours; a short paragraph. "My boss or clients" is one desk
 * entry (`boss_clients`: contacts tagged either); "Bills and things to sign" is `money`; "Nothing, hold it all" is `holdAll` with an empty list.
 */
export function reachFromWelcome(a: WelcomeReachAnswers): WelcomeReach {
  const q4 = a.q4 ?? null;
  let rules: Rule[] = [];
  let holdAll = false;
  if (q4 === null) {
    rules = [
      { kind: 'match', match: 'due_today', anyTime: false, source: 'welcome' },
      { kind: 'match', match: 'money', anyTime: false, source: 'welcome' },
    ];
  } else if (q4.includes('nothing')) {
    holdAll = true;
  } else {
    if (q4.includes('family')) rules.push({ kind: 'group', group: 'family', anyTime: true, source: 'welcome' });
    if (q4.includes('boss')) rules.push({ kind: 'group', group: 'boss_clients', anyTime: false, source: 'welcome' });
    if (q4.includes('due')) rules.push({ kind: 'match', match: 'due_today', anyTime: false, source: 'welcome' });
    if (q4.includes('bills')) rules.push({ kind: 'match', match: 'money', anyTime: false, source: 'welcome' });
    if (q4.includes('byName')) {
      const seen = new Set<string>();
      for (const n of a.names ?? []) {
        const name = plain(n, 60);
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        rules.push({ kind: 'person', person: { pendingName: name }, anyTime: false, source: 'welcome' });
      }
    }
  }
  const catchUps = CATCH_UPS[a.q5 ?? 'three'] ?? CATCH_UPS['three']!;
  const q6 = a.q6 ?? [];
  // "No set times" excludes the rest; "It varies" sets none of its own (it points to Hold everything).
  const focusHours = q6.includes('none') ? [] : (['mornings', 'afternoons'] as const).filter((k) => q6.includes(k)).map((k) => ({ ...FOCUS_SPANS[k]! }));
  const detail = a.q7 === 'line' || a.q7 === 'full' ? a.q7 : 'paragraph';
  return { params: { letThrough: rules.slice(0, LIST_MAX), holdAll, catchUps: [...catchUps], focusHours, detail }, over: rules.slice(LIST_MAX) };
}

// ----- times, in the member's own zone and locale

/** "9:00 AM" from "09:00" (a desk-zone wall time), in this browser's locale. */
export function clockWords(hhmm: string, locale?: string): string {
  const m = HHMM.exec(hhmm);
  if (!m) return hhmm;
  const [h, min] = hhmm.split(':').map(Number) as [number, number];
  try {
    return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(Date.UTC(2026, 0, 5, h, min)).replace(/\s+/g, ' ');
  } catch {
    return hhmm;
  }
}

/** "11:30 AM" from an instant, in the member's zone. */
export function instantWords(at: number, locale?: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone }).format(at).replace(/\s+/g, ' ');
  } catch {
    return new Date(at).toISOString().slice(11, 16);
  }
}
