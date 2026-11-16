// Every reply from a desk's `docs.*` (deskd API.md §25; `DocsMethods.java` is the truth where §25 is vague), read field by
// field. A field that's missing or the wrong type takes a safe default, and a document without a well-formed id or a title is
// dropped, so a desk that sends less (an older deskd) or more (a newer one) never breaks the window. Every string is desk text:
// shown as plain text only, never as HTML or a link, cut to its contract's length, with hidden characters taken out.
import type { Changes, Choice, Counts, Doc, DocCopy, DocDetail, DocKind, DocLink, DocList, DocsEvent, DocState, DocSummary, DocText, DocType, DocVersion, LineBox, PageHead, Place, Question, Rule, TextSection, TidyPreview, Toast } from './types';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Format characters (bidi controls and isolates, zero-width spaces, the BOM, tag characters), controls, the Hangul fillers and
 * the variation selectors out of anything shown (the office's `displayText` rule, as To-do's `plain`): only the joiners scripts
 * and emoji need stay, and newlines only where `lines` says.
 */
const HIDDEN = /(?![‌‍])[\p{Cf}\p{Cc}ᅟᅠㅤﾠ︀-︍\u{e0100}-\u{e01ef}]/gu;
export const plain = (v: unknown, max = 200, lines = false): string => {
  const s = typeof v === 'string' ? v : '';
  const clean = lines ? s.split('\n').map((l) => l.replace(HIDDEN, '')).join('\n') : s.replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim();
  return [...clean].slice(0, max).join('');
};

/** `d_` and 26 Crockford base32 characters, a ULID (§25). */
export const DOC_ID = /^d_[0-9A-HJKMNP-TV-Z]{26}$/;
const PLACES: readonly Place[] = ['needs', 'read', 'records', 'working'];
const KINDS: readonly DocKind[] = ['file', 'download', 'attachment', 'page', 'agent_output', 'writeup'];
const TYPES: readonly DocType[] = ['pdf', 'image', 'docx', 'xlsx', 'pptx', 'text', 'other'];
const STATES: readonly DocState[] = ['new', 'seen', 'handled'];
const pages = (v: unknown, max = 500): number[] => [...new Set(arr(v).filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= max))].sort((a, b) => a - b);

export function readSummary(v: unknown): DocSummary | null {
  const o = obj(v);
  if (!o) return null;
  const p = obj(o['pages']) ?? {};
  const asks = arr(o['asks']).filter((a): a is string => typeof a === 'string' && /^[a-z]{2,12}$/.test(a)).slice(0, 6);
  const due = str(o['due']);
  const changeLine = plain(o['changeLine'], 90);
  return {
    line: plain(o['line'], 90),
    what: plain(o['what'], 20),
    asks,
    due: due ? plain(due, 20) : null,
    pages: Object.fromEntries(Object.entries(p).flatMap(([k, n]) => (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 500 && /^[a-z]{2,12}$/.test(k) ? [[k, n]] : []))),
    changeLine: changeLine || null,
  };
}

/** One document, or null if it can't be one. */
export function readDoc(v: unknown): Doc | null {
  const o = obj(v);
  const id = str(o?.['id']);
  const title = plain(o?.['title'], 60);
  if (!o || !DOC_ID.test(id) || !title) return null;
  const place = str(o['place']) as Place;
  const kind = str(o['kind']) as DocKind;
  const raw = str(o['type']) as DocType;
  const type: DocType = TYPES.includes(raw) ? raw : 'other';
  const state = str(o['state']) as DocState;
  const reason = obj(o['reason']) ?? {};
  const from = obj(o['from']);
  const fromName = plain(from?.['name'], 60);
  const key = str(from?.['personKey']);
  const by = obj(o['changedBy']) ?? {};
  const source = obj(o['source']) ?? {};
  const danger = str(o['danger']);
  const sensitive = o['sensitive'] === true;
  const pageCount = numOrNull(o['pageCount']);
  const matched = o['matchedText'];
  return {
    id,
    kind: KINDS.includes(kind) ? kind : 'file',
    type,
    title,
    origName: plain(o['origName'], 255) || title,
    size: Math.max(0, num(o['size'])),
    place: PLACES.includes(place) ? place : 'records',
    maybe: o['maybe'] === true && place === 'needs',
    reason: { code: plain(reason['code'], 20) || 'default', text: plain(reason['text'], 60) },
    dueAt: numOrNull(o['dueAt']),
    from: fromName || key ? { name: fromName, personKey: /^pk_[0-9a-f]{16}$/.test(key) ? key : null } : null,
    arrivedAt: num(o['arrivedAt']),
    changedAt: num(o['changedAt']),
    changedBy: { kind: plain(by['kind'], 20) || 'member', name: plain(by['name'], 60) || null },
    state: STATES.includes(state) ? state : 'seen',
    heldUntil: numOrNull(o['heldUntil']),
    copies: Math.max(0, Math.floor(num(o['copies'], 1))),
    versions: Math.max(0, Math.floor(num(o['versions'], 1))),
    changedPages: pages(o['changedPages']),
    lastPage: Math.max(1, Math.floor(num(o['lastPage'], 1))),
    pageCount: pageCount !== null && pageCount >= 1 ? Math.min(500, Math.floor(pageCount)) : null,
    // A document with a danger word is never drawn, whatever else the desk says (§25).
    viewable: o['viewable'] !== false && !danger && type !== 'other',
    danger: danger ? plain(danger, 30) : null,
    untrusted: o['untrusted'] !== false,
    sensitive,
    sensitiveText: sensitive ? plain(o['sensitiveText'], 90) || null : null,
    // A sensitive document's summary shows only inside the viewer (`summaryShown` in `model.ts`); outside it, `sensitiveText`.
    summary: readSummary(o['summary']),
    source: { kind: plain(source['kind'], 20), label: plain(source['label'], 120) },
    ...(typeof matched === 'boolean' ? { matchedText: matched } : {}),
  };
}

const docs = (v: unknown): Doc[] => arr(v).map(readDoc).filter((d): d is Doc => d !== null);

export function readCounts(v: unknown): Counts {
  const o = obj(v) ?? {};
  const n = (k: string): number => Math.max(0, Math.floor(num(o[k])));
  return { needs: n('needs'), maybe: n('maybe'), read: n('read'), records: n('records'), working: n('working') };
}

export function readList(v: unknown): DocList {
  const o = obj(v) ?? {};
  const cursor = str(o['cursor']);
  const end = plain(o['end'], 60);
  return { items: docs(o['items']), counts: readCounts(o['counts']), cursor: /^\d{1,6}$/.test(cursor) ? cursor : null, more: o['more'] === true, end: end || null };
}

export function readSearch(v: unknown): { items: Doc[]; more: boolean } {
  const o = obj(v) ?? {};
  return { items: docs(o['items']), more: o['more'] === true };
}

function readCopy(v: unknown): DocCopy | null {
  const o = obj(v);
  const id = str(o?.['id']);
  if (!o || !/^c_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null;
  const path = str(o['path']);
  return { id, sourceKind: plain(o['sourceKind'], 20), label: plain(o['label'], 120), arrivedAt: num(o['arrivedAt']), gone: o['gone'] === true, path: path && path.length <= 4096 && !path.includes('\0') ? path : null };
}

function readVersion(v: unknown): DocVersion | null {
  const o = obj(v);
  const id = str(o?.['id']);
  if (!o || !/^v_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null;
  const ms = plain(o['milestoneText'], 60);
  return {
    id,
    at: num(o['at']),
    by: plain(o['by'], 80),
    byName: plain(o['byName'], 60) || null,
    milestone: plain(o['milestone'], 20) || null,
    milestoneText: ms || null,
    pagesChanged: pages(o['pagesChanged']),
    current: o['current'] === true,
    restorable: o['restorable'] === true && o['current'] !== true,
  };
}

function readLink(v: unknown): DocLink | null {
  const o = obj(v);
  const label = plain(o?.['label'], 120);
  return o && label ? { kind: plain(o['kind'], 20), ref: plain(o['ref'], 120), label } : null;
}

export function readQuestion(v: unknown): Question | null {
  const o = obj(v);
  const id = str(o?.['id']);
  const text = plain(o?.['text'], 200);
  if (!o || !/^q_[0-9A-Za-z]{1,40}$/.test(id) || !text) return null;
  const choices = arr(o['choices'])
    .flatMap((c): Choice[] => {
      const x = obj(c);
      const cid = str(x?.['id']);
      const label = plain(x?.['label'], 40);
      return x && /^[a-z]{2,12}$/.test(cid) && label ? [{ id: cid, label }] : [];
    })
    .slice(0, 4);
  if (!choices.length) return null;
  return { id, kind: plain(o['kind'], 20), text, choices, docIds: arr(o['docIds']).filter((d): d is string => typeof d === 'string' && DOC_ID.test(d)) };
}

export const readQuestions = (v: unknown): Question[] => arr(obj(v)?.['questions']).map(readQuestion).filter((q): q is Question => q !== null);

export function readDetail(v: unknown): DocDetail | null {
  const o = obj(v) ?? {};
  const doc = readDoc(o['doc']);
  if (!doc) return null;
  const copiesText = plain(o['copiesText'], 120);
  const links = arr(o['links']).map(readLink).filter((l): l is DocLink => l !== null);
  const alsoIn = o['alsoIn'] === undefined ? links : arr(o['alsoIn']).map(readLink).filter((l): l is DocLink => l !== null);
  return {
    doc,
    copies: arr(o['copies']).map(readCopy).filter((c): c is DocCopy => c !== null),
    copiesText: copiesText || null,
    versions: arr(o['versions']).map(readVersion).filter((x): x is DocVersion => x !== null),
    links,
    alsoIn,
    questions: arr(o['questions']).map(readQuestion).filter((q): q is Question => q !== null),
  };
}

const SECTION_KINDS = ['p', 'h', 'table', 'slide', 'sheet'] as const;

export function readText(v: unknown): DocText {
  const o = obj(v) ?? {};
  const type = str(o['type']) as DocType;
  const sections = arr(o['sections']).flatMap((s): TextSection[] => {
    const x = obj(s);
    const kind = str(x?.['kind']) as TextSection['kind'];
    if (!x || !SECTION_KINDS.includes(kind)) return [];
    const rows = Array.isArray(x['rows']) ? x['rows'].slice(0, 500).map((r) => arr(r).slice(0, 50).map((c) => plain(c, 400))) : null;
    return [{ kind, text: plain(x['text'], 200_000, true), rows }];
  });
  const unread = plain(o['unread'], 30);
  return {
    type: TYPES.includes(type) ? type : 'other',
    pages: arr(o['pages']).flatMap((p) => {
      const x = obj(p);
      const n = num(x?.['n']);
      return x && Number.isInteger(n) && n >= 1 ? [{ n, text: plain(x['text'], 200_000, true) }] : [];
    }),
    sections,
    unread: unread || null,
  };
}

/** A page's reply (`docs.page`), before its bytes on `bulk`: null if it can't be one. */
export function readPage(v: unknown): PageHead | null {
  const o = obj(v);
  if (!o) return null;
  const id = o['transferId'];
  const size = o['size'];
  const sha = str(o['sha256']);
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || typeof size !== 'number' || size < 0 || !/^[0-9a-f]{64}$/.test(sha)) return null;
  const lines = arr(o['lines']).flatMap((l): LineBox[] => {
    const x = obj(l);
    const b = arr(x?.['b']);
    if (b.length !== 4 || !b.every((n) => typeof n === 'number' && Number.isFinite(n))) return [];
    const [bx, by, bw, bh] = (b as number[]).map((n) => Math.min(1, Math.max(0, n))) as [number, number, number, number];
    return [{ b: [bx, by, Math.min(bw, 1 - bx), Math.min(bh, 1 - by)], changed: x?.['changed'] === true }];
  });
  return {
    transferId: id,
    size,
    sha256: sha,
    format: o['format'] === 'png' ? 'png' : 'jpeg',
    width: Math.max(1, num(o['width'], 1)),
    height: Math.max(1, num(o['height'], 1)),
    pageCount: Math.max(1, Math.floor(num(o['pageCount'], 1))),
    lines: lines.slice(0, 2000),
  };
}

export function readChanges(v: unknown): Changes {
  const o = obj(v) ?? {};
  const cl = plain(o['changeLine'], 90);
  return { pages: pages(o['pages']), line: plain(o['line'], 90), changeLine: cl || null, paragraphs: arr(o['paragraphs']).filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0) };
}

export const readRules = (v: unknown): Rule[] =>
  arr(obj(v)?.['rules']).flatMap((r): Rule[] => {
    const x = obj(r);
    const id = str(x?.['id']);
    const text = plain(x?.['text'], 120);
    return x && /^r_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) && text ? [{ id, text, effect: plain(x['effect'], 20), madeBy: plain(x['madeBy'], 20) }] : [];
  });

export function readToast(v: unknown): Toast | null {
  const t = obj(obj(v)?.['toast']);
  const text = plain(t?.['text'], 120);
  if (!t || !text) return null;
  const undo = str(t['undo']);
  return { text, undo: /^u_[0-9A-Za-z]{1,40}$/.test(undo) ? undo : null };
}

export function readTidy(v: unknown): TidyPreview {
  const o = obj(v) ?? {};
  const text = plain(o['text'], 200);
  return { copies: Math.max(0, num(o['copies'])), downloads: Math.max(0, num(o['downloads'])), bytes: Math.max(0, num(o['bytes'])), items: arr(o['items']).length, text: text || null };
}

/** A `docs` topic message (§25): a `snapshot` of `{rev, counts}`, then `changed` `{rev, ids, counts}`. */
export function readEvent(v: unknown): DocsEvent {
  const o = obj(v) ?? {};
  const ids = o['ids'];
  return {
    type: str(o['type']),
    rev: num(o['rev']),
    ids: Array.isArray(ids) ? ids.filter((d): d is string => typeof d === 'string' && DOC_ID.test(d)).slice(0, 50) : null,
    counts: obj(o['counts']) ? readCounts(o['counts']) : null,
  };
}

/** `d_…` or `d_…#p3`: a document and a page, from Maia's `office_show` or a handover; null for anything else. */
export function parseDocRef(ref: unknown): { docId: string; page: number | null } | null {
  if (typeof ref !== 'string') return null;
  const m = /^(d_[0-9A-HJKMNP-TV-Z]{26})(?:#p([1-9][0-9]{0,2}))?$/.exec(ref);
  return m ? { docId: m[1]!, page: m[2] ? Number(m[2]) : null } : null;
}
