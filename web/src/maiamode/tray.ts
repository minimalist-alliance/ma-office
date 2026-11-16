// The decision tray, as the office reads it (deskd API.md §23 "The tray"; `~/ma-coord/design-drafts/maia-tray/SPEC.md`): every
// held thing that needs the member's decision comes as a paper in the room's `reach.tray`, built by code on the home desk. Pure
// readers and words, tested in `tray.test.ts`. Everything a desk sends is read leniently and plain; a field out of shape is
// dropped. Members never see "paper", "tray" or "Maia Mode": papers live under the catch-up's Needs you.
import type { Who } from './reach';
import { plain } from './model';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const id = (v: unknown, max = 80): string | null => (typeof v === 'string' && /^[A-Za-z0-9_:.-]+$/.test(v) && v.length <= max ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export type PaperKind = 'approval' | 'report' | 'doc' | 'reply' | 'todo';
export type Does = 'approve' | 'decline' | 'revise' | 'done' | 'follow_up' | 'move' | 'reply' | 'custom' | 'open' | 'not_now';
export type Verb = 'send' | 'pay' | 'delete' | 'share' | 'approve';
export type ReplyKind = 'approval' | 'maia_brief' | 'doc' | 'courier' | 'todo';
export type MaterialKind = 'payload' | 'writeup' | 'doc' | 'thread' | 'todo';
export type PaperState = 'open' | 'answered' | 'sending' | 'sent' | 'queued' | 'failed' | 'expired' | 'withdrawn';

export interface PaperAnswer {
  id: string;
  label: string;
  does: Does;
  value: string | null;
  confirm: Verb | null;
}
export interface Material {
  materialId: string;
  kind: MaterialKind;
  deskId: string;
  ref: Record<string, string>;
  label: string;
}
export interface Paper {
  paperId: string;
  itemId: string | null;
  kind: PaperKind;
  asker: { kind: 'agent' | 'person' | 'desk'; deskId: string; agentId: string | null; who: Who | null; label: string; name: string };
  title: string;
  /** Her line, the agent's, or code's: `by` says whose; `from` is the material a tap on it opens. */
  line: { text: string; by: 'maia' | 'agent' | 'reader' | 'code'; from: string | null } | null;
  answers: PaperAnswer[];
  /** The first answer drawn as the primary, or null (send, spend, delete and egress never get one). */
  pick: number | null;
  /**
   * The box: who it's addressed to, its limit, what it sends as. `draft` is the seam for a suggested reply (the owner's open
   * question, default no: no desk sends one today); it would only fill the box, never send.
   */
  freeform: { to: string | null; max: number; as: 'note' | 'message' | 'reply' | 'none'; draft: string | null };
  later: { allowed: boolean; until: number | null; kind: 'catchup' | 'in_20' | null };
  dismissable: boolean;
  materials: Material[];
  reply: { kind: ReplyKind; deskId: string; approvalId?: string; agentId?: string; messageId?: string; docId?: string; channelId?: string; todoId?: string };
  dueAt: number | null;
  expiresAt: number | null;
  untrusted: boolean;
  risk: string | null;
  state: PaperState;
  laterCount: number;
  laterUntil: number | null;
  at: number;
}
export interface Filed {
  paperId: string;
  kind: string;
  label: string | null;
  to: string | null;
  who: Who | null;
  state: PaperState;
  at: number;
}
export interface Tray {
  count: number;
  now: number;
  later: number;
  papers: Paper[];
  filed: Filed[];
}
/** An answer waiting for its desk (`agent.maia.tray.get`'s `out`): the member's own words only until sent. */
export interface OutAnswer {
  outId: string;
  paperId: string;
  deskId: string;
  replyKind: ReplyKind;
  answerId: string;
  does: Does;
  value: string | null;
  text: string | null;
  at: number;
  expiresAt: number | null;
  /** The asking thing's ids as the paper had them when answered: carried from these, never a rebuilt paper. */
  reply: Paper['reply'];
  /** Approve: the payload hash the member saw; the desk approves only that. */
  sha256: string | null;
}

const KINDS = ['approval', 'report', 'doc', 'reply', 'todo'] as const;
const DOES = ['approve', 'decline', 'revise', 'done', 'follow_up', 'move', 'reply', 'custom', 'open', 'not_now'] as const;
const VERBS = ['send', 'pay', 'delete', 'share', 'approve'] as const;
const REPLIES = ['approval', 'maia_brief', 'doc', 'courier', 'todo'] as const;
const MATERIALS = ['payload', 'writeup', 'doc', 'thread', 'todo'] as const;
const STATES = ['open', 'answered', 'sending', 'sent', 'queued', 'failed', 'expired', 'withdrawn'] as const;
const has = <T extends string>(set: readonly T[], v: unknown): v is T => (set as readonly unknown[]).includes(v);

const who = (v: unknown): Who | null => {
  const o = obj(v);
  const deskId = id(o['deskId']);
  const contactId = id(o['contactId'], 40);
  return deskId && contactId ? { deskId, contactId } : null;
};

/** A label on a paper's answer: plain, at most 28 (the home desk's filter already dropped links, addresses and long numbers). */
const LABEL_MAX = 28;
function readAnswer(v: unknown): PaperAnswer | null {
  const o = obj(v);
  const aid = typeof o['id'] === 'string' && /^[a-z][a-z0-9_]{0,23}$/.test(o['id']) ? o['id'] : null;
  const label = plain(o['label'], LABEL_MAX + 4);
  if (!aid || !label || !has(DOES, o['does'])) return null;
  const verb = obj(o['confirm'])['verb'];
  return { id: aid, label, does: o['does'], value: typeof o['value'] === 'string' ? plain(o['value'], 200) : null, confirm: has(VERBS, verb) ? verb : null };
}

function readMaterial(v: unknown): Material | null {
  const o = obj(v);
  const mid = id(o['materialId'], 40);
  const deskId = id(o['deskId']);
  if (!mid || !deskId || !has(MATERIALS, o['kind'])) return null;
  const ref: Record<string, string> = {};
  for (const [k, x] of Object.entries(obj(o['ref']))) {
    const r = id(x, 120);
    if (r && /^[a-zA-Z]{1,20}$/.test(k)) ref[k] = r;
  }
  return { materialId: mid, kind: o['kind'], deskId, ref, label: plain(o['label'], 60) || 'Open' };
}

/** One paper from the snapshot or `agent.maia.tray.get`, or null when it's out of shape. */
export function readPaper(v: unknown): Paper | null {
  const o = obj(v);
  const paperId = typeof o['paperId'] === 'string' && /^pp-[a-z2-7]{20}$/.test(o['paperId']) ? o['paperId'] : null;
  const a = obj(o['asker']);
  const r = obj(o['reply']);
  const askerDesk = id(a['deskId']);
  const replyDesk = id(r['deskId']);
  if (!paperId || !has(KINDS, o['kind']) || !askerDesk || !replyDesk || !has(REPLIES, r['kind'])) return null;
  const answers = arr(o['answers'])
    .map(readAnswer)
    .filter((x): x is PaperAnswer => !!x)
    .slice(0, 6);
  if (!answers.length) return null;
  const l = obj(o['line']);
  const lineText = plain(l['text'], 140);
  const f = obj(o['freeform']);
  const lt = obj(o['later']);
  const reply = readReply(r, r['kind'], replyDesk);
  const pick = num(o['pick']);
  return {
    paperId,
    itemId: id(o['itemId']),
    kind: o['kind'],
    asker: {
      kind: a['kind'] === 'person' ? 'person' : a['kind'] === 'desk' ? 'desk' : 'agent',
      deskId: askerDesk,
      agentId: id(a['agentId'], 64),
      who: who(a['who']),
      label: plain(a['label'], 121) || 'A desk',
      name: plain(a['name'], 60) || 'them',
    },
    title: plain(o['title'], 80) || 'Something needs you',
    line: lineText ? { text: lineText, by: l['by'] === 'maia' || l['by'] === 'agent' || l['by'] === 'reader' ? l['by'] : 'code', from: id(l['from'], 40) } : null,
    answers,
    pick: pick !== null && pick >= 0 && pick < answers.length ? pick : null,
    freeform: {
      to: typeof f['to'] === 'string' ? plain(f['to'], 60) : null,
      max: Math.max(0, Math.min(2000, num(f['max']) ?? 0)),
      as: f['as'] === 'note' || f['as'] === 'message' || f['as'] === 'reply' ? f['as'] : 'none',
      draft: typeof f['draft'] === 'string' && f['draft'].trim() ? f['draft'].slice(0, 2000) : null,
    },
    later: { allowed: lt['allowed'] === true, until: num(lt['until']), kind: lt['kind'] === 'catchup' || lt['kind'] === 'in_20' ? lt['kind'] : null },
    dismissable: o['dismissable'] === true,
    materials: arr(o['materials'])
      .map(readMaterial)
      .filter((x): x is Material => !!x)
      .slice(0, 4),
    reply,
    dueAt: num(o['dueAt']),
    expiresAt: num(o['expiresAt']),
    untrusted: o['untrusted'] === true,
    risk: typeof o['risk'] === 'string' && /^[a-z]{1,10}$/.test(o['risk']) ? o['risk'] : null,
    state: has(STATES, o['state']) ? o['state'] : 'open',
    laterCount: Math.max(0, Math.round(num(o['laterCount']) ?? 0)),
    laterUntil: num(o['laterUntil']),
    at: num(o['at']) ?? 0,
  };
}

/** `reach.tray`, or null while the desk doesn't send one (an older desk, the shield off). */
export function readTray(raw: unknown): Tray | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = raw as Obj;
  const papers = arr(t['papers'])
    .map(readPaper)
    .filter((p): p is Paper => !!p)
    .slice(0, 50);
  const filed = arr(t['filed']).flatMap((v): Filed[] => {
    const o = obj(v);
    const paperId = typeof o['paperId'] === 'string' && /^pp-[a-z2-7]{20}$/.test(o['paperId']) ? o['paperId'] : null;
    if (!paperId) return [];
    return [{ paperId, kind: plain(o['kind'], 16), label: typeof o['label'] === 'string' ? plain(o['label'], 40) || null : null, to: typeof o['to'] === 'string' ? plain(o['to'], 60) || null : null, who: who(o['who']), state: has(STATES, o['state']) ? o['state'] : 'answered', at: num(o['at']) ?? 0 }];
  });
  return {
    count: Math.max(papers.length, Math.round(num(t['count']) ?? papers.length)),
    now: papers.length,
    later: Math.max(0, Math.round(num(t['later']) ?? 0)),
    papers,
    filed: filed.slice(0, 10),
  };
}

/** `agent.maia.tray.get {}`: every open paper (Later ones too) and the answers waiting for a desk. */
/** The asking thing's ids (a paper's, or a queued answer's as the paper had them when answered). */
function readReply(r: Obj, kind: ReplyKind, deskId: string): Paper['reply'] {
  const reply: Paper['reply'] = { kind, deskId };
  for (const k of ['approvalId', 'agentId', 'messageId', 'docId', 'channelId', 'todoId'] as const) {
    const x = id(r[k], 120);
    if (x) reply[k] = x;
  }
  return reply;
}

export function readTrayGet(raw: unknown): { papers: Paper[]; out: OutAnswer[] } {
  const o = obj(raw);
  const papers = arr(o['papers'])
    .map(readPaper)
    .filter((p): p is Paper => !!p);
  const out = arr(o['out']).flatMap((v): OutAnswer[] => {
    const x = obj(v);
    const outId = typeof x['outId'] === 'string' && /^po-[a-z2-7]{20}$/.test(x['outId']) ? x['outId'] : null;
    const paperId = typeof x['paperId'] === 'string' && /^pp-[a-z2-7]{20}$/.test(x['paperId']) ? x['paperId'] : null;
    const deskId = id(x['deskId']);
    if (!outId || !paperId || !deskId || !has(REPLIES, x['replyKind']) || !has(DOES, x['does'])) return [];
    const sha256 = typeof x['sha256'] === 'string' && /^[0-9a-f]{64}$/.test(x['sha256']) ? x['sha256'] : null;
    return [{ outId, paperId, deskId, replyKind: x['replyKind'], answerId: typeof x['answerId'] === 'string' ? x['answerId'].slice(0, 24) : '', does: x['does'], value: typeof x['value'] === 'string' ? x['value'].slice(0, 200) : null, text: typeof x['text'] === 'string' ? x['text'].slice(0, 2000) : null, at: num(x['at']) ?? 0, expiresAt: num(x['expiresAt']), reply: readReply(obj(x['reply']), x['replyKind'], deskId), sha256 }];
  });
  return { papers, out };
}

// ----- words

/** `{who}` in a paper's words, from that desk's Courier at draw time; "Someone" when it can't say. */
export function fillName(text: string, name: string | null): string {
  if (!text.includes('{who}')) return text;
  const n = name ? plain(name, 40) : null;
  return text.replace(/\{who\}/g, (_m, at: number) => n ?? (at === 0 || /[·.]\s*$/.test(text.slice(0, at)) ? 'Someone' : 'someone'));
}

/** The time chip: "Expires 4:10", "Due Fri", "Due 3:00". In the member's own zone and locale. */
export function chipWords(p: Pick<Paper, 'expiresAt' | 'dueAt'>, now: number, locale?: string, timeZone?: string): string | null {
  const clock = (at: number): string => {
    try {
      return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone }).format(at).replace(/\s?[AP]M$/i, '').replace(/\s+/g, ' ');
    } catch {
      return new Date(at).toISOString().slice(11, 16);
    }
  };
  const day = (at: number): string => {
    const d = (x: number): string => {
      try {
        return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(x);
      } catch {
        return new Date(x).toISOString().slice(0, 10);
      }
    };
    if (d(at) === d(now)) return clock(at);
    if (d(at) === d(now + 86_400_000)) return 'tomorrow';
    try {
      return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone }).format(at);
    } catch {
      return 'soon';
    }
  };
  if (p.expiresAt) return p.expiresAt - now < 24 * 3_600_000 ? `Expires ${clock(p.expiresAt)}` : `Expires ${day(p.expiresAt)}`;
  if (p.dueAt) return `Due ${day(p.dueAt)}`;
  return null;
}

/** The risk line under the title, with its glyph's name: what this would do beyond the desk. */
export function riskWords(risk: string | null, restorable: boolean | null = null): { text: string; glyph: 'out' | 'coin' | 'bin' | 'share' } | null {
  switch (risk) {
    case 'send':
      return { text: 'Sends outside your desk', glyph: 'out' };
    case 'egress':
      return { text: 'Shares outside your desk', glyph: 'share' };
    case 'spend':
      return { text: 'Spends money', glyph: 'coin' };
    case 'delete':
      // A Trash can bring it back: "for good" only when the asking desk's tool says it can't (null: not read yet).
      return { text: restorable ? 'Moves it to the Trash' : restorable === false ? 'Deletes for good' : 'Deletes', glyph: 'bin' };
    default:
      return null;
  }
}

/** Whose line it is, as the paper labels it ("Maia’s summary", "Writer’s summary"); code's own line has no label. */
export function lineLabel(p: Pick<Paper, 'line' | 'asker'>, name: string | null): string | null {
  if (!p.line) return null;
  if (p.line.by === 'maia' || p.line.by === 'reader') return 'Maia’s summary';
  if (p.line.by === 'agent') return `${fillName(p.asker.name, name)}’s summary`;
  return null;
}

/** The free-form box's placeholder: "Note for Writer…", "Reply to Rosa…", "Reply to Scout…". */
export function boxWords(p: Pick<Paper, 'freeform' | 'kind'>, name: string | null): string | null {
  const to = p.freeform.to ? fillName(p.freeform.to, name) : null;
  if (p.freeform.as === 'none' || !to) return null;
  return p.freeform.as === 'note' ? `Note for ${to}…` : `Reply to ${to}…`;
}

/** The filed line after an answer: "X1 Carbon · sent to Scout", "Sent back to Writer with your note", "Answered in Writer". */
export function filedWords(f: Filed, name: string | null): { lead: string; rest: string } {
  const to = f.to ? fillName(f.to, name) : null;
  const label = f.label ?? '';
  switch (f.state) {
    case 'withdrawn':
      return { lead: 'Answered elsewhere', rest: 'nothing more to do' };
    case 'expired':
      return { lead: 'Expired', rest: 'nothing was done' };
    case 'queued':
      return { lead: label || 'Your answer', rest: to ? `goes to ${to} when that desk wakes` : 'goes when that desk wakes' };
    case 'failed':
      return { lead: label || 'Your answer', rest: 'didn’t go · try again' };
    case 'sending':
      return { lead: label || 'Your answer', rest: to ? `sending to ${to}` : 'sending' };
    default:
      if (label === 'Ask for changes' || label === 'Sent back with your note') return { lead: 'Sent back', rest: to ? `to ${to} with your note` : 'with your note' };
      if (label === 'Decline') return { lead: 'Declined', rest: to ? `${to} can ask again` : 'they can ask again' };
      return { lead: label || 'Answered', rest: to ? `sent to ${to}` : 'done' };
  }
}

/** "2 answered · 1 for later": the group's tally after the last paper. */
export function tallyWords(answered: number, later: number): string {
  const parts: string[] = [];
  if (answered) parts.push(`${answered} answered`);
  if (later) parts.push(`${later} for later`);
  return parts.join(' · ') || 'Nothing waiting';
}

// ----- the confirm strip: exactly what goes where, from the approval's own payload (code's templates, never her line)

type P = Record<string, unknown>;
const str = (v: unknown, max = 120): string | null => (typeof v === 'string' && v.trim() ? plain(v, max) : null);
const host = (u: string): string => {
  try {
    return new URL(u).host || u;
  } catch {
    return u.replace(/^[a-z]+:\/\//i, '').split('/')[0] ?? u;
  }
};

/**
 * The confirm strip's words for an approval: what goes where, from its tool, payload and target. A spend says the page it pays on
 * (the desk said `spend`, the amount isn't known to code), a delete names the file or page, a send the site or the desk.
 */
export function confirmWords(verb: Verb, a: { tool: string; payload: unknown; target: unknown; context?: string; undo?: string | null } | null, deskName: string): { title: string; foot: string; button: string } {
  const payload = obj(a?.payload) as P;
  const target = obj(a?.target) as P;
  const where = str(payload['origin']) ?? str(target['origin']) ?? str(target['site']) ?? (str(payload['url']) ? host(String(payload['url'])) : null);
  const what = str(payload['path']) ?? str(target['path']) ?? str(target['title']) ?? str(payload['label']);
  switch (verb) {
    case 'pay':
      return { title: where ? `Pay on ${host(where)}?` : 'Pay for this?', foot: 'Money leaves once you confirm.', button: 'Pay' };
    case 'delete':
      // A move to a Trash says so, and how to get it back (the Agent app's own words for that tool).
      if (a?.undo) return { title: what ? `Move “${what}” to the Trash?` : 'Move this to the Trash?', foot: a.undo, button: 'Move to Trash' };
      return { title: what ? `Delete “${what}” for good?` : 'Delete this for good?', foot: 'It can’t be undone.', button: 'Delete' };
    case 'share':
      return { title: where ? `Open ${host(where)} from your ${deskName} desk?` : `Share this outside your ${deskName} desk?`, foot: 'What it reads there can leave with it.', button: 'Share it' };
    case 'approve':
      // A kind of action this desk didn't name: say what's known, and ask once more.
      return { title: `Let it go ahead on your ${deskName} desk?`, foot: 'Check what it does before you confirm.', button: 'Approve' };
    default:
      return { title: where ? `Send to ${host(where)} from your ${deskName} desk?` : `Send this from your ${deskName} desk?`, foot: 'Once it’s sent, it can’t be called back.', button: 'Send it' };
  }
}

/** Papers in her chat: `[paper:pp-…]` tokens, taken out of her words and drawn from the home desk's papers (never her text). */
export function paperTokens(text: string): { text: string; ids: string[] } {
  const ids: string[] = [];
  const out = text.replace(/\s*\[paper:(pp-[a-z2-7]{20})\]\s*/g, (_m, pid: string) => {
    if (!ids.includes(pid)) ids.push(pid);
    return ' ';
  });
  return { text: ids.length ? out.replace(/ {2,}/g, ' ').trim() : text, ids: ids.slice(0, 5) };
}
