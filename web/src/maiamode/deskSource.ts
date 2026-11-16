// Desk Maia on the member's home desk, over that desk's own data channel (CONCEPT.md §1; deskd `API.md` §23, the runtime's
// contract, `sub/mm-maia-runtime`): her thread is the agent thread `maia` (`agent.thread.get`, topic `agent.conversation:maia`,
// `agent.message.send`), the room's state is topic `agent.maia` (the list, its urgency and its words are the desk's code), and
// the office tells her what it sees on the member's desks with `agent.maia.observe`. Since the focus shield (Nov 15) that observer
// and her topic's subscription are the page's one sender, `focusSource.ts`, which runs in every view while Desk Maia is on; the
// room holds it and reads her topic through it. The room talks only to the home desk: nothing here goes to the platform, and no
// model is reached from here.
//
// Her model calls are the home desk's own, and always go through Minimalist Alliance's AI service, metered against the member's
// Maia allowance (the owner, Nov 14): the room never asks for a key for her. A reply that stopped at the allowance says when it
// resets, in the member's own time (`allowanceLine`); a desk that holds only an older disclosure asks for the current one.
//
// Every reply is read leniently and everything a desk wrote is plain text (`model.ts` `plain`); the viewport takes only the
// closed enum (`viewApp`). The pure readers are exported for `deskSource.test.ts`.
import { newIdem } from '../../agent/src/client/agentClient';
import { RpcAgentClient } from '../../agent/src/client/rpcAgentClient';
import type { Message } from '../../agent/src/client/types';
import type { DeskLink } from '../desk/deskLink';
import { linkOf, useLiveStore, wakeDesk } from '../desk/liveStore';
import { noteFocusEvent } from '../state/focusItems';
import { useDeskStore } from '../state/deskStore';
import { pickHome, retainFocus } from './focusSource';
import { dayOf, plain } from './model';
import { currentPrefs, savePrefs } from './prefs';
import { ALLOWANCE, DISCLOSURE, picksUpWords, renewsWords, resetsWords, UNAVAILABLE } from './words';
import { EMPTY_ROOM, viewApp, type AttentionItem, type BriefSpend, type ChoiceSet, type DocPointer, type DrawingFrom, type Go, type MaiaAllowance, type NoteChip, type RoomMessage, type RoomSource, type RoomState, type ShowRequest, type ViewApp } from './source';

/** The accepted disclosure's version, as the desk names it (§23 `agent.maia.set`), from the sheet's own (Security's MR-I3). */
export const DISCLOSURE_ID = `maia-mode-v${DISCLOSURE.version}`;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ----- reading the desk

/** The desk's own switch doesn't list it yet (§23, `not_listed`): in Phase 1 a desk release lists the owner's desk alone. */
const NOT_LISTED = 'Maia isn’t on your home desk yet.';

const FAILED: Record<string, string> = {
  limit_reached: 'You’ve used your Maia allowance for now.',
};

/**
 * When it resets, in the member's own zone and locale: "at 5:00 PM" later today, "tomorrow at 5:00 PM", "on Tuesday at 5:00 PM"
 * within six days, else "on December 1". Null for a reset it can't read or one that's past. The time's own spaces are a no-break
 * space, so "5:00 PM" never breaks across lines.
 */
export function resetWhen(resetsAt: unknown, now: number, locale?: string, timeZone?: string): string | null {
  const at = typeof resetsAt === 'string' && resetsAt.length <= 40 ? Date.parse(resetsAt) : Number.NaN;
  if (!Number.isFinite(at) || at <= now) return null;
  try {
    const days = dayOf(at, timeZone) - dayOf(now, timeZone);
    const time = (): string => new Intl.DateTimeFormat(locale, { timeZone, hour: 'numeric', minute: '2-digit' }).format(at).replace(/\s+/g, '\u00a0');
    if (days <= 0) return `at ${time()}`;
    if (days === 1) return `tomorrow at ${time()}`;
    if (days <= 6) return `on ${new Intl.DateTimeFormat(locale, { timeZone, weekday: 'long' }).format(at)} at ${time()}`;
    return `on ${new Intl.DateTimeFormat(locale, { timeZone, month: 'long', day: 'numeric' }).format(at)}`;
  } catch {
    // A zone or locale this browser doesn't know: the line without its reset.
    return null;
  }
}

/**
 * Her service refused her, or the member's own day cap on her is reached (her reply's `limit {reason, window, resetsAt}`, deskd §23,
 * read leniently): one plain line, its reset in the member's own time as a date or a time of day (never a countdown), and no
 * button. A reason or window it doesn't know is "your Maia allowance for now".
 */
export function allowanceLine(raw: unknown, now = Date.now(), locale?: string, timeZone?: string): string {
  const limit = obj(raw);
  const reason = limit['reason'];
  const period = limit['window'];
  const first =
    reason === 'limit_cap'
      ? ALLOWANCE.cap
      : reason === 'credits_used'
        ? ALLOWANCE.creditsUsed
        : reason === 'limit_lighter'
          ? ALLOWANCE.lighterDay
          : reason === 'limit_pool'
            ? ALLOWANCE.pool
            : reason === 'limit_trial' || period === 'memberTrial'
              ? ALLOWANCE.trial
              : reason === 'limit_personal' && (period === 'day' || period === 'week' || period === 'month')
                ? ALLOWANCE[period]
                : ALLOWANCE.other;
  const when = resetWhen(limit['resetsAt'], now, locale, timeZone);
  if (!when) return first;
  const tail = reason === 'limit_cap' ? picksUpWords(when) : period === 'month' ? renewsWords(when) : resetsWords(when);
  return `${first} ${tail}`;
}

/** Why her reply didn't finish, in code's words: her allowance, her AI service down, or a moment's trouble. */
function failedLine(m: Obj): string {
  if (m['errorDetail'] === 'limit') return allowanceLine(m['limit']);
  if (m['errorDetail'] === 'unavailable') return UNAVAILABLE;
  return FAILED[str(m['error'], 40) ?? ''] ?? 'That reply didn’t finish. Try again in a moment.';
}

/** Her choices (§23, "A chat turn, with choices"): 2 to 4, her recommendation first, and how they were answered. */
export function readChoices(raw: unknown): ChoiceSet | null {
  const c = obj(raw);
  const opts = arr(c['options']).flatMap((o) => {
    const id = str(obj(o)['id'], 40);
    const label = plain(obj(o)['label'], 40);
    return id && label ? [{ id, label }] : [];
  });
  const rec = str(c['recommended'], 40);
  const first = opts.findIndex((o) => o.id === rec);
  const pick = first >= 0;
  if (first > 0) opts.unshift(...opts.splice(first, 1));
  if (opts.length < 2) return null;
  const state = c['state'];
  const answer = str(c['answer'], 40);
  const answered = state === 'answered' ? (answer === 'other' ? ({ kind: 'other', text: '' } as const) : answer ? ({ kind: 'option', id: answer } as const) : null) : state === 'passed' ? ({ kind: 'ignored' } as const) : null;
  return { id: `ch:${str(c['question'], 400) ?? ''}`, options: opts.slice(0, 4), answered: state === 'open' ? null : (answered ?? { kind: 'ignored' }), other: c['other'] !== false, pick };
}

function readNotes(raw: unknown): NoteChip[] {
  return arr(raw).flatMap((n) => {
    const o = obj(n);
    const id = str(o['noteId'], 80);
    if (!id) return [];
    const state = o['state'];
    const s: NoteChip['state'] = state === 'filed' || state === 'pending' || state === 'held' || state === 'failed' || state === 'undone' ? state : 'pending';
    return [{ id, line: plain(o['line'], 60) || 'Noted', state: s, undo: s === 'filed' ? str(o['approvalId'], 80) : null }];
  });
}

const DOC_REF = /^d_[0-9A-HJKMNP-TV-Z]{26}(?:#p[1-9][0-9]{0,2})?$/;

/** Her handover card's pointer (§24): a desk and a document id, or null for anything else. */
export function readDoc(raw: unknown): DocPointer | null {
  const o = obj(raw);
  const deskId = str(o['deskId'], 80);
  const docId = str(o['docId'], 40);
  return deskId && docId && /^d_[0-9A-HJKMNP-TV-Z]{26}$/.test(docId) ? { deskId, docId } : null;
}

/** `(deskId, app, ref)`, the closed enum only: her `approvals` is the Agent app's cards, `courier` isn't here yet. */
export function readShow(raw: unknown): ShowRequest | null {
  const o = obj(raw);
  const deskId = str(o['deskId'], 80);
  const app = o['app'] === 'approvals' ? 'agent' : viewApp(o['app']);
  if (!deskId || !app) return null;
  const ref = o['ref'];
  // Documents takes a document's id only, with a page if she names one (`d_…`, `d_…#p3`, §24's `office_show`).
  if (app === 'documents') return { deskId, app, ref: typeof ref === 'string' && DOC_REF.test(ref) ? ref : null };
  return { deskId, app, ref: typeof ref === 'string' && ref.length <= 200 && !/^[a-z][a-z0-9+.-]*:/i.test(ref) ? ref : Array.isArray(ref) ? (str(ref[0], 80) ?? null) : null };
}

/** One message of her thread as the room shows it. A message the member didn't write (another agent's, a timer's) isn't shown. */
export function readMessage(m: Message & Obj): RoomMessage | null {
  const id = str(m.id, 80);
  if (!id) return null;
  if (m.role === 'user') return m.origin ? null : { id, from: 'member', text: typeof m.text === 'string' ? m.text : '', at: num(m.at) ?? 0 };
  const out: RoomMessage = { id, from: 'maia', text: typeof m.text === 'string' ? m.text : '', at: num(m.at) ?? 0 };
  const choices = m['choices'] ? readChoices(m['choices']) : null;
  if (choices) out.choices = { ...choices, id: `${id}:choices` };
  const notes = readNotes(m['notes']);
  if (notes.length) out.notes = notes;
  const show = m['show'] ? readShow(m['show']) : null;
  if (show) out.show = show;
  const doc = m['doc'] ? readDoc(m['doc']) : null;
  if (doc) out.doc = doc;
  if (m.state === 'failed') out.failed = failedLine(m);
  const cost = plain(obj(m['cost'])['line'], 80);
  if (cost && out.choices) out.cost = cost;
  return out;
}

/** Her briefs' cost (§23 `briefs`), read leniently: dollars of the member's own keys, in all and per desk. */
export function readBriefs(raw: unknown): BriefSpend | null {
  const b = obj(raw);
  const usd = (v: unknown): number | null => (num(v) === null || (num(v) as number) < 0 ? null : (num(v) as number) / 1e6);
  const today = usd(b['todayMicroUsd']);
  const budget = usd(b['budgetMicroUsd']);
  if (today === null || budget === null) return null;
  return {
    todayUsd: today,
    monthUsd: usd(b['monthMicroUsd']) ?? today,
    budgetUsd: budget,
    desks: arr(b['desks'])
      .slice(0, 20)
      .flatMap((d) => {
        const o = obj(d);
        const deskId = str(o['deskId'], 80);
        const t = usd(o['todayMicroUsd']);
        return deskId && t !== null ? [{ deskId, name: plain(o['deskName'], 60) || 'Your desk', todayUsd: t, monthUsd: usd(o['monthMicroUsd']) ?? t }] : [];
      }),
  };
}

function goOf(raw: unknown): Go {
  const a = obj(raw);
  switch (a['kind']) {
    case 'approvals':
      return { kind: 'view', app: 'agent', ref: str(arr(a['approvalIds'])[0], 80) };
    case 'show': {
      const s = readShow(a);
      return s ? { kind: 'view', app: s.app, ref: s.ref } : { kind: 'none' };
    }
    case 'result': {
      const messageId = str(a['messageId'], 80);
      return messageId ? { kind: 'chat', messageId } : { kind: 'none' };
    }
    case 'notes':
      return { kind: 'view', app: 'notebook', ref: null };
    case 'wake':
      return { kind: 'wake' };
    default:
      return { kind: 'none' };
  }
}

const KINDS = new Set(['approval', 'result', 'todos', 'notes', 'notes_unsure', 'limit', 'desk_failed', 'desk_asleep', 'cap', 'account']);

/** "Expires in 40 min" under six hours (CONCEPT.md §3). */
function expiresWords(at: number | null, now: number): string | null {
  if (at === null) return null;
  const min = Math.round((at - now) / 60_000);
  if (min <= 0 || min >= 360) return null;
  return min < 60 ? `Expires in ${min} min` : `Expires in ${Math.round(min / 60)} h`;
}

/** The room's state stream (§23 topic `agent.maia`), as the room reads it. */
const DRAWING = new Set(['day', 'week', 'month', 'starting', 'topUp', 'lighter', 'none']);
const count = (v: unknown): number | null => (num(v) !== null && (v as number) >= 0 ? Math.floor(v as number) : null);

/**
 * Her allowance (§23 topic `agent.maia` `allowance`), read leniently: the credits only when the month's amount and what's left are
 * counts. Nothing here is money, and no dollar field is read. Null when the desk sends none (an older desk-agent).
 */
export function readAllowance(raw: unknown): MaiaAllowance | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const a = raw as Obj;
  const c = obj(a['credits']);
  const month = count(c['month']);
  const monthLeft = count(c['monthLeft']);
  const from = c['drawingFrom'];
  const left = count(c['left']);
  const credits =
    month !== null && monthLeft !== null
      ? {
          month,
          monthLeft: Math.min(monthLeft, month),
          topUpLeft: count(c['topUpLeft']) ?? 0,
          drawingFrom: typeof from === 'string' && DRAWING.has(from) ? (from as DrawingFrom) : null,
          // The one wallet (0.4.10): everything usable, the starting credits, today's lighter share.
          ...(left !== null ? { left, starting: count(c['starting']) ?? 0, lighterLeft: count(c['lighterLeft']) } : {}),
        }
      : null;
  const fraction = num(a['fraction']);
  const cap = count(a['cap']);
  return {
    fraction: fraction !== null && fraction >= 0 && fraction <= 1 ? fraction : null,
    resetsAt: str(a['resetsAt'], 40),
    usedUp: a['usedUp'] === true,
    // `none` (0.4.10): used up with no lighter share for the tier, never the lighter model.
    lighter: credits?.drawingFrom !== 'none' && (a['lighter'] === true || credits?.drawingFrom === 'lighter'),
    credits,
    today: Math.max(0, num(a['today']) ?? 0),
    cap,
  };
}

export function readRoom(raw: unknown, now = Date.now()): Pick<RoomState, 'status' | 'foot' | 'allowance' | 'attention' | 'later' | 'noticeAt'> & { show: (ShowRequest & { open: boolean; at: number }) | null; connecting: boolean; on: boolean; killed: boolean; listed: boolean } {
  const r = obj(raw);
  const st = obj(r['status']);
  const todo = obj(r['todo']);
  const items: AttentionItem[] = arr(todo['items']).flatMap((x) => {
    const i = obj(x);
    const id = str(i['id'], 80);
    const deskId = str(i['deskId'], 80);
    const kind = String(i['kind']);
    const urgency = i['urgency'] === 'now' ? 'now' : i['urgency'] === 'next' ? 'next' : null;
    if (!id || !deskId || !urgency || !KINDS.has(kind)) return [];
    return [{ id, kind: kind as AttentionItem['kind'], deskId, urgency, title: plain(i['title']), meta: expiresWords(num(i['expiresAt']), now), go: goOf(i['action']), at: num(i['createdAt']) ?? now }];
  });
  const later = obj(todo['later']);
  const foot = obj(r['foot']);
  const show = r['show'] ? readShow(r['show']) : null;
  return {
    on: r['on'] === true,
    killed: r['killed'] === true,
    listed: r['listed'] !== false,
    connecting: r['connecting'] === true,
    status: Object.keys(st).length ? { desks: num(st['desks']) ?? 0, agents: num(st['agents']), working: num(st['working']) } : null,
    attention: items,
    later: { count: Math.max(0, num(later['count']) ?? 0), lines: arr(later['lines']).map((l) => plain(l, 60)).filter(Boolean).slice(0, 5) },
    // Her briefs (the member's own keys, so dollars); an older desk's `spend` (her own cost in dollars) is never read (the owner,
    // Nov 15).
    foot: Object.keys(foot).length ? { onIt: num(foot['onIt']) ?? 0, doneToday: num(foot['doneToday']) ?? 0, briefs: readBriefs(r['briefs']) } : null,
    allowance: readAllowance(r['allowance']),
    noticeAt: num(obj(r['notice'])['at']),
    show: show ? { ...show, open: obj(r['show'])['open'] === true, at: num(obj(r['show'])['at']) ?? now } : null,
  };
}

// ----- what the office sees, for her list (§23 `agent.maia.observe`): the one sender is `focusSource.ts`, in every view

export { observePayload, pickHome, readUsage, type DeskSeen } from './focusSource';
/** The room's `reach` (what reaches the member, the focus shield), read beside `readRoom`: `reach.ts`. */
export { readReach } from './reach';

// ----- the source

interface Wire {
  call(method: string, params?: Obj, idem?: string): Promise<unknown>;
  subscribe(topic: string, fn: (msg: Obj) => void, refused?: (code: string) => void): () => void;
}
const wireOf = (link: DeskLink): Wire => ({
  call: (m, p, idem) => link.call(m as never, p, idem ? { idem, deadlineMs: 15_000 } : { deadlineMs: 15_000 }),
  subscribe: (t, fn, r) => link.subscribe(t as never, fn as never, r),
});

/** A mutation keeps one key across a retry of a lost reply (deskd API.md §4). */
async function mutate(w: Wire, method: string, params: Obj): Promise<unknown> {
  const key = newIdem();
  let last: unknown;
  for (let n = 0; n < 3; n += 1) {
    try {
      return await w.call(method, params, key);
    } catch (e) {
      last = e;
      const code = (e as { code?: unknown } | null)?.code;
      // Her model not offered on this desk (`no_service`) is an answer, not a lost reply: asking again changes nothing.
      if (code === 'unavailable' && reasonOf(e) === 'no_service') break;
      if (code !== 'deadline_exceeded' && code !== 'cancelled' && !(code === 'unavailable' && !(e as { details?: { mayHaveApplied?: boolean } }).details?.mayHaveApplied)) break;
    }
  }
  throw last;
}
const reasonOf = (e: unknown): string | null => {
  const d = (e as { details?: unknown } | null)?.details;
  return d && typeof d === 'object' ? (str((d as Obj)['reason'], 40) ?? null) : null;
};

export function deskSource(): RoomSource {
  // The one observer of the page (`focusSource.ts`): it sends what the office sees, in every view, and hands the room her topic.
  const focus = retainFocus();
  const fns = new Set<() => void>();
  let state: RoomState = { ...EMPTY_ROOM };
  let messages = new Map<string, RoomMessage>();
  let order: string[] = [];
  let room: ReturnType<typeof readRoom> | null = null;
  let home: string | null = null;
  let named: string | null = null;
  let w: Wire | null = null;
  let offs: (() => void)[] = [];
  let closed = false;
  /** This page's own on or off (the disclosure's accept, the switch), until a home desk has it. */
  let pendingOn: boolean | null = null;
  let onWaiters: ((ok: boolean) => void)[] = [];
  let retry = 0;
  /** The desk's `agent.maia.get` has answered on this link: only then does its "off" mean anything. */
  let known = false;
  let deskOff = false;
  let wireWaiters: ((wire: Wire) => void)[] = [];
  let showSeq = 0;
  let lastShowAt = 0;
  let problem: RoomState['problem'] = null;
  let fixer: (() => Promise<void>) | null = null;
  /** The home desk refused her for an older disclosure: the room asks for the current one until `setOn(true)` settles. */
  let wantDisclosure = false;

  const emit = (): void => {
    const list = order.map((id) => messages.get(id)).filter((m): m is RoomMessage => !!m);
    // An offer she couldn't open by herself is a "Show me" under her last reply.
    if (room?.show && !room.show.open) {
      const last = [...list].reverse().find((m) => m.from === 'maia');
      if (last && !last.show) list[list.lastIndexOf(last)] = { ...last, show: { deskId: room.show.deskId, app: room.show.app, ref: room.show.ref } };
    }
    if (room?.show?.open && room.show.at !== lastShowAt) {
      lastShowAt = room.show.at;
      showSeq += 1;
    }
    const tail = list[list.length - 1];
    const busy = !!tail && (tail.from === 'member' || streaming.has(tail.id));
    const link: RoomState['link'] = !w ? 'connecting' : room?.connecting ? 'connecting' : 'ready';
    state = {
      ...state,
      link,
      messages: list,
      busy: busy && link === 'ready',
      status: room?.status ?? null,
      foot: room?.foot ?? null,
      allowance: room?.allowance ?? null,
      attention: room?.attention ?? [],
      later: room?.later ?? { count: 0, lines: [] },
      noticeAt: room?.noticeAt ?? null,
      show: room?.show?.open ? { deskId: room.show.deskId, app: room.show.app as ViewApp, ref: room.show.ref, seq: showSeq } : state.show,
      problem: room?.killed ? { line: 'Maia is switched off on your home desk.', action: null } : room && !room.listed && !room.on ? { line: NOT_LISTED, action: null } : problem,
      // The desk says off and this page isn't turning it on: the room follows the desk, never the other way (MR-M1). A desk that
      // isn't listed or is killed isn't the member's off: the room stays and says so.
      deskOff: deskOff || (known && !!room && !room.on && !room.killed && room.listed && pendingOn !== true),
      disclosure: wantDisclosure,
    };
    for (const f of fns) f();
  };
  const say = (line: string | null, action: string | null = null, fix: (() => Promise<void>) | null = null): void => {
    problem = line ? { line, action } : null;
    fixer = fix;
    emit();
  };

  /** Her replies still being written. */
  const streaming = new Set<string>();
  const track = (m: Message): void => {
    if (m.role === 'assistant' && m.state === 'streaming') streaming.add(m.id);
    else streaming.delete(m.id);
  };
  const put = (m: RoomMessage): void => {
    if (!messages.has(m.id)) order.push(m.id);
    messages.set(m.id, m);
  };

  /** Her access, saved from the member's own session with the disclosure (§23, "Her access"): Notebook and To-do, adding to her tab. */
  const saveAccess = async (wire: Wire): Promise<void> => {
    const maia = obj(obj(await wire.call('agent.maia.get'))['maia']);
    const tabId = str(maia['notesTabId'], 80);
    await mutate(wire, 'agent.access.set', {
      agentId: 'maia',
      apps: { notebook: true, files: false, browser: false, courier: false, todos: true },
      auto: { notebook: tabId ? { tabId } : null, files: null, todos: true },
    });
  };

  /**
   * The home desk holds only an older disclosure (a send refused `disclosure`, deskd §23): the room shows the current one again,
   * and this browser's acceptance goes too, so the switch reads off until the member accepts it. What the member typed isn't kept
   * for later: they send it again once she's on.
   */
  const askDisclosure = (): void => {
    savePrefs({ disclosure: null });
    wantDisclosure = true;
    say(null);
  };

  // ----- the home desk
  const connect = (link: DeskLink): void => {
    const wire = wireOf(link);
    w = wire;
    messages = new Map();
    order = [];
    const client = new RpcAgentClient({ call: (m, p, o) => link.call(m as never, p, o), subscribe: (t, fn, r) => link.subscribe(t as never, fn as never, r) });
    offs.push(
      focus.onRoom((msg) => {
        room = readRoom(msg['room'] ?? msg);
        emit();
      }),
      client.watchConversation('maia', (e) => {
        if (e.type === 'snapshot') {
          // A line already shown keeps how it came; the thread the room opens on is just there, but a reply still being
          // written arrives live.
          const before = messages;
          messages = new Map();
          order = [];
          streaming.clear();
          for (const m of e.messages) {
            track(m);
            const r = readMessage(m as Message & Obj);
            if (r) put({ ...r, live: before.get(r.id)?.live ?? (m.role === 'assistant' && m.state === 'streaming') });
          }
        } else if (e.type === 'message') {
          track(e.message);
          const r = readMessage(e.message as Message & Obj);
          // New while the room is open: live. A line it already has (her reply republished with its choices) stays as it came.
          if (r) put({ ...r, live: messages.get(r.id)?.live ?? true });
        } else if (e.type === 'delta') {
          const m = messages.get(e.messageId);
          if (m) messages.set(e.messageId, { ...m, text: m.text + e.text });
          else put({ id: e.messageId, from: 'maia', text: e.text, at: Date.now(), live: true });
        }
        emit();
      }),
    );
    for (const f of wireWaiters) f(wire);
    wireWaiters = [];
    void wire.call('agent.maia.get').then(
      (r) => {
        const maia = obj(obj(r)['maia']);
        const there = str(obj(maia['home'])['deskId'], 80);
        // The desk names another home: that's where she lives.
        if (there && there !== home && useDeskStore.getState().desks.some((d) => d.id === there && d.kind !== 'guild')) {
          named = there;
          focus.setHome(there);
          restart();
          return;
        }
        known = true;
        // Only this page's own on or off goes to the desk; a copy of the prefs never turns her back on (Security's MR-M1).
        if (maia['listed'] === false && maia['on'] !== true) {
          // The desk's own switch doesn't list it (§23 "listed desks only"): not the member's off, so the room stays and says so.
          say(NOT_LISTED);
          if (pendingOn === false) apply(wire, false);
        } else if (pendingOn !== null) apply(wire, maia['on'] === true);
        else if (maia['on'] !== true && maia['killed'] !== true) deskOff = true;
        emit();
      },
      (e: unknown) => {
        const reason = reasonOf(e);
        if (reason === 'not_listed') say(NOT_LISTED);
        else if (reason === 'maia_off' || reason === 'tier' || reason === 'age_band') say('Maia isn’t available on your home desk.');
      },
    );
    focus.nudge();
    emit();
  };

  /** Sends this page's pending on or off; `already` is what the desk says now. A refusal for good ends it; anything else retries. */
  const apply = (wire: Wire, already: boolean | null = null): void => {
    const on = pendingOn;
    if (on === null) return;
    const settle = (ok: boolean): void => {
      if (pendingOn === on) pendingOn = null;
      const ws = onWaiters;
      onWaiters = [];
      for (const f of ws) f(ok);
      emit();
    };
    if (already === on && !on) return settle(true);
    void (async () => {
      try {
        await mutate(wire, 'agent.maia.set', on ? { on: true, disclosure: DISCLOSURE_ID, ...(home ? { homeDeskId: home } : {}) } : { on: false });
        if (on) {
          await saveAccess(wire);
          // Where she lives now, so an "off" from any device goes there (Security's MR-M2).
          const there = str(obj(obj(obj(await wire.call('agent.maia.get'))['maia'])['home'])['deskId'], 80) ?? home;
          if (there) savePrefs({ home: there });
        }
        deskOff = false;
        // The current disclosure is the desk's now: the room stops asking for it.
        if (on) wantDisclosure = false;
        settle(true);
      } catch (e) {
        const code = (e as { code?: string } | null)?.code;
        if (code === 'forbidden' || code === 'precondition_failed' || code === 'bad_request') {
          if (on) {
            // The member answered the ask: the desk's refusal is said instead, and a later refusal asks again.
            wantDisclosure = false;
            say(reasonOf(e) === 'not_listed' ? NOT_LISTED : 'Maia isn’t available on your home desk.');
          }
          return settle(false);
        }
        // A lost answer or a desk going away: again, while this lives (the "off" sender lives until it lands).
        if (on) say('Maia didn’t start on your home desk yet. Trying again.');
        window.clearTimeout(retry);
        retry = window.setTimeout(() => {
          if (!closed && w === wire) apply(wire);
        }, 20_000);
      }
    })();
  };

  const restart = (): void => {
    for (const off of offs) off();
    offs = [];
    w = null;
    room = null;
    known = false;
    // Nothing of the last desk's thread stays on screen (Security's MR-M3), nor its button, nor its ask for the disclosure.
    messages = new Map();
    order = [];
    wantDisclosure = false;
    problem = null;
    fixer = null;
    streaming.clear();
    start();
  };

  let offLive: (() => void) | null = null;
  let offList: (() => void) | null = null;
  function start(): void {
    const pick = (): void => {
      const desk = pickHome(useDeskStore.getState().desks, named ?? currentPrefs().home);
      if (!desk) return;
      home = desk.id;
      const live = useLiveStore.getState().desks[desk.id];
      const link = live?.link === 'open' ? linkOf(desk.id) : null;
      if (link && !w) connect(link);
      else if (!link && w) restart();
      else if (!link) {
        // Asleep: her chat waits, and the member can wake it (a wake is theirs to ask for, never the room's own).
        const vm = desk.vm;
        say(vm === 'stopped' || vm === 'stopping' ? 'Your home desk is asleep.' : null, vm === 'stopped' ? 'Wake it' : null, async () => wakeDesk(desk.id));
      }
    };
    offLive ??= useLiveStore.subscribe(() => pick());
    offList ??= useDeskStore.subscribe(() => pick());
    pick();
  }
  start();

  const withWire = (fn: (wire: Wire) => Promise<unknown>, failed = 'That didn’t reach Maia. Try again in a moment.'): void => {
    const wire = w;
    if (!wire) return;
    void fn(wire).catch((e: unknown) => {
      const reason = reasonOf(e);
      const code = (e as { code?: unknown } | null)?.code;
      // The desk holds an older disclosure than this page's: the current one, over the room (deskd §23 `disclosure`).
      if (code === 'precondition_failed' && reason === 'disclosure') askDisclosure();
      // Her model isn't offered on this desk yet, or her AI service is down: a plain line, no button.
      else if (code === 'unavailable' && reason === 'no_service') say(UNAVAILABLE);
      else if (reason === 'maia_off') say('Maia is switched off on your home desk.');
      else if (reason === 'not_listed') say(NOT_LISTED);
      // Her day's limit (§23, the tier's cap): not a moment's trouble, so not "try again" (release 4's B7).
      else if (reason === 'limit_reached') say(FAILED['limit_reached'] ?? failed);
      else say(failed);
    });
  };

  return {
    get: () => state,
    subscribe(fn) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    send(text, answering) {
      withWire(async (wire) => {
        const params: Obj = { agentId: 'maia', text };
        // "Other" answers her choices with the member's own words; a reply with no `choice` passes them by (§23).
        if (answering?.as === 'other') params['choice'] = { messageId: answering.choices.replace(/:choices$/, ''), other: true };
        // Any other refusal (`disclosure`, `no_service`) is said once in the room (`withWire`); the words aren't kept to send later.
        let r: unknown;
        try {
          r = await mutate(wire, 'agent.message.send', params);
        } catch (e) {
          if ((e as { code?: string }).code !== 'precondition_failed' || reasonOf(e) !== 'setup') throw e;
          await saveAccess(wire);
          r = await mutate(wire, 'agent.message.send', params);
        }
        const id = str(obj(r)['messageId'], 80);
        if (id && !messages.has(id)) put({ id, from: 'member', text, at: Date.now() });
        // A message sent in her chat: a completed action (the focus shield's fine break, after 5 s with no input).
        noteFocusEvent('sent');
        say(null);
      });
    },
    choose(messageId, optionId) {
      withWire((wire) => mutate(wire, 'agent.maia.choose', { messageId, choiceId: optionId }));
    },
    undoNote(approvalId) {
      withWire((wire) => mutate(wire, 'agent.approval.undo', { approvalId }), 'That note couldn’t be undone just now. Try again in a moment.');
    },
    snooze(itemId) {
      withWire((wire) => mutate(wire, 'agent.maia.item.snooze', { itemId }));
    },
    setOn(on) {
      pendingOn = on;
      deskOff = false;
      return new Promise<boolean>((resolve) => {
        onWaiters.push(resolve);
        if (w && known) apply(w);
      });
    },
    forget() {
      const ready = w ? Promise.resolve(w) : new Promise<Wire>((resolve, reject) => {
        wireWaiters.push(resolve);
        window.setTimeout(() => reject(new Error('no home desk')), 20_000);
      });
      return ready.then((wire) => mutate(wire, 'agent.maia.forget', {})).then(
        () => {
          messages = new Map();
          order = [];
          emit();
          return true;
        },
        () => false,
      );
    },
    typing(on) {
      focus.setChatTyping(on);
      if (w) void w.call('agent.maia.typing', { typing: on }).catch(() => undefined);
    },
    seen(back) {
      if (w) void w.call('agent.maia.seen', back ? { back: true } : {}).catch(() => undefined);
    },
    fix() {
      const f = fixer;
      if (f) void f().catch(() => say('That didn’t work just now. Try again in a moment.'));
    },
    close() {
      shut();
    },
  };

  function shut(): void {
    if (closed) return;
    closed = true;
    window.clearTimeout(retry);
    for (const off of offs) off();
    focus.release();
    offLive?.();
    offList?.();
    fns.clear();
  }
}
