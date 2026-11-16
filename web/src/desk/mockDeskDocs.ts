// Dev and test only, through mockDeskLink.ts (never in a production bundle: `build-release.mjs` fails on its names). One desk's
// Documents index held in memory and served as deskd serves the member's `docs.*` methods and the `docs` topic (deskd API.md
// §24, `DocsMethods.java` where §24 is vague): places with Maybe after, the desk's own words (reasons, toasts, the end line,
// the first sort), chips that make rules, Undo by token, copies, versions and milestones, what changed, page images drawn here
// at the width asked and sent over `bulk` as JPEG with each line's box, the text for the reading view, a danger type refused,
// and topic events of ids and counts only. Demo data only: example names, no member's name.
import type { MockBulk } from './mockDeskData';
import { THEMES } from '../theme/tokens';

const refusal = (code: string, details: Record<string, unknown> = {}): Error => Object.assign(new Error(`mock ${code}`), { code, details });

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const END = 'That’s all for now.';
const PLACE: Record<string, string> = { needs: 'Needs you', read: 'Read later', records: 'Records', working: 'Working on' };

/** A ULID-shaped id: the prefix and 26 Crockford base32 characters. */
const uid = (prefix: string, n: number): string => `${prefix}01JCMA${String(n).padStart(20, '0')}`;
let serial = 100;
const next = (prefix: string): string => uid(prefix, (serial += 1));

type Place = 'needs' | 'read' | 'records' | 'working';
type Type = 'pdf' | 'image' | 'docx' | 'xlsx' | 'pptx' | 'text' | 'other';

interface Version {
  id: string;
  at: number;
  by: string;
  byName: string | null;
  milestone: string | null;
  milestoneText: string | null;
  pagesChanged: number[];
  restorable: boolean;
}

interface Copy {
  id: string;
  sourceKind: string;
  label: string;
  arrivedAt: number;
  path?: string;
}

interface Row {
  id: string;
  kind: string;
  type: Type;
  title: string;
  origName: string;
  size: number;
  place: Place;
  maybe: boolean;
  reasonCode: string;
  reasonText: string;
  dueAt: number | null;
  fromName: string | null;
  fromKey: string | null;
  arrivedAt: number;
  changedAt: number;
  changedBy: { kind: string; name: string | null };
  state: 'new' | 'seen' | 'handled';
  heldUntil: number | null;
  changedPages: number[];
  lastPage: number;
  pageCount: number | null;
  danger: string | null;
  untrusted: boolean;
  sensitive: boolean;
  summary: Record<string, unknown> | null;
  source: { kind: string; label: string };
  copies: Copy[];
  versions: Version[];
  links: { kind: string; ref: string; label: string }[];
  /** Each page's text, for the reading view, the text layer and search inside. */
  pages: string[];
  /** Each page's changed line indexes (against the version before). */
  changedLines: Record<number, number[]>;
  sections: { kind: string; text: string; rows?: string[][] }[] | null;
  changeLine: string | null;
  /** What "What's this?" finds, when it's asked. */
  reads: { line: string; what: string } | null;
}

export interface MockDocsControl {
  calls: { m: string; p: Record<string, unknown> }[];
  /** Every call of this method refuses with this code until it is deleted. */
  refuse: Record<string, string>;
  /** The parse sandbox can't be reached: pages and text are `unavailable` `sandbox`; the list still works. */
  sandbox: boolean;
  delayMs: number;
}

type Listener = (msg: { type: string; rev: number; ids: string[] | null; counts: Record<string, number> }) => void;

const day = (at: number): string => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const clock = (at: number): string => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();

/** "Page 3 changed" / "Pages 3 and 7 changed", as deskd's `Words.pages`. */
function pagesWords(p: number[]): string {
  if (!p.length) return 'Nothing changed';
  if (p.length === 1) return `Page ${p[0]} changed`;
  return `Pages ${p.slice(0, -1).join(', ')} and ${p[p.length - 1]} changed`;
}

const SENTENCES = [
  'The parties agree to the terms set out on these pages.',
  'Each section below names who does what, and by when.',
  'Questions about this document go to the sender by email.',
  'Nothing here changes the earlier agreement unless it says so.',
  'Amounts are shown before tax unless marked otherwise.',
  'Both copies carry the same weight once signed.',
];

/** A page's line boxes, the same every time for a page: a title on page 1, then lines in paragraphs. */
function boxes(page: number, count = 22): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  let y = 0.09;
  if (page === 1) {
    out.push([0.1, 0.07, 0.48, 0.028]);
    y = 0.15;
  }
  for (let i = 0; i < count; i += 1) {
    const end = i % 5 === 4;
    const w = end ? 0.36 + ((page * 7 + i * 3) % 20) / 100 : 0.72 + ((page + i) % 9) / 100;
    out.push([0.1, Number(y.toFixed(4)), Number(w.toFixed(4)), 0.0145]);
    y += end ? 0.05 : 0.031;
    if (y > 0.92) break;
  }
  return out;
}

async function drawPage(width: number, type: Type, page: number, title: boolean): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const w = Math.min(1600, Math.max(200, Math.round(width)));
  const h = type === 'image' ? Math.round(w * 1.3) : Math.round(w * 1.4142);
  const t = THEMES.light;
  if (typeof OffscreenCanvas === 'undefined') return { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: w, height: h };
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d')!;
  g.fillStyle = t.surface.window;
  g.fillRect(0, 0, w, h);
  if (type === 'image') {
    // A photographed receipt: a soft sheet with lines and a total.
    g.fillStyle = t.surface.sunken;
    g.fillRect(w * 0.12, h * 0.05, w * 0.76, h * 0.9);
    g.fillStyle = t.text.secondary;
    for (let i = 0; i < 14; i += 1) g.fillRect(w * 0.2, h * (0.12 + i * 0.05), w * (i % 3 === 2 ? 0.3 : 0.55), h * 0.012);
    g.fillStyle = t.text.primary;
    g.fillRect(w * 0.2, h * 0.84, w * 0.6, h * 0.02);
  } else {
    // Words as a sandbox draws them: a line of grey strokes, each word its own, inside the line's box.
    boxes(page).forEach((b, i) => {
      const head = title && i === 0 && page === 1;
      g.fillStyle = head ? t.text.primary : t.text.secondary;
      g.globalAlpha = head ? 0.85 : 0.55;
      let x = b[0] * w;
      const end = (b[0] + b[2]) * w;
      let k = 0;
      while (x < end - 4) {
        const word = Math.min(end - x, (0.03 + ((page * 13 + i * 7 + k * 5) % 9) / 100) * w);
        g.fillRect(x, (b[1] + b[3] * 0.2) * h, word, b[3] * 0.6 * h);
        x += word + 0.012 * w;
        k += 1;
      }
    });
    g.globalAlpha = 1;
    g.fillStyle = t.text.tertiary;
    g.font = `${Math.round(w / 60)}px sans-serif`;
    g.fillText(String(page), w / 2, h * 0.96);
  }
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: w, height: h };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}

export class MockDocsDesk {
  readonly control: MockDocsControl;
  readonly deskId: string;
  private readonly rows = new Map<string, Row>();
  private readonly listeners = new Set<Listener>();
  private readonly undos = new Map<string, () => void>();
  private rules: { id: string; text: string; effect: string; madeBy: string; at: number }[] = [];
  private questions: { id: string; kind: string; text: string; choices: { id: string; label: string }[]; docIds: string[] }[] = [];
  private firstSortTold = false;
  private firstSort: number | null = null;
  private tidyItems = 0;
  private rev = 1;
  private sharedKey: { key: string; at: number } | null = null;

  constructor(deskId: string, control: Partial<MockDocsControl> = {}) {
    this.deskId = deskId;
    this.control = { calls: [], refuse: {}, sandbox: false, delayMs: 0, ...control };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get currentRev(): number {
    return this.rev;
  }

  counts(): Record<string, number> {
    const now = Date.now();
    const live = [...this.rows.values()].filter((r) => r.state !== 'handled' && !(r.heldUntil && r.heldUntil > now));
    return {
      needs: live.filter((r) => r.place === 'needs' && !r.maybe).length,
      maybe: live.filter((r) => r.place === 'needs' && r.maybe).length,
      read: [...this.rows.values()].filter((r) => r.place === 'read').length,
      records: [...this.rows.values()].filter((r) => r.place === 'records').length,
      working: [...this.rows.values()].filter((r) => r.place === 'working').length,
    };
  }

  private changed(ids: string[] | null): void {
    this.rev += 1;
    const msg = { type: 'changed', rev: this.rev, ids, counts: this.counts() };
    for (const f of this.listeners) f(msg);
  }

  /** A document, as a test or a fixture adds it. */
  add(r: Partial<Row> & { title: string; type: Type }): Row {
    const now = Date.now();
    const id = r.id ?? next('d_');
    const row: Row = {
      kind: 'attachment',
      origName: `${r.title}.pdf`,
      size: 182_044,
      place: 'records',
      maybe: false,
      reasonCode: 'default',
      reasonText: 'Kept in Records',
      dueAt: null,
      fromName: null,
      fromKey: null,
      arrivedAt: now - DAY,
      changedAt: now - DAY,
      changedBy: { kind: 'person', name: null },
      state: 'seen',
      heldUntil: null,
      changedPages: [],
      lastPage: 1,
      pageCount: r.type === 'pdf' ? 2 : r.type === 'image' ? 1 : null,
      danger: null,
      untrusted: true,
      sensitive: false,
      summary: null,
      source: { kind: 'courier', label: 'Email' },
      copies: [],
      versions: [],
      links: [],
      pages: [],
      changedLines: {},
      sections: null,
      changeLine: null,
      reads: null,
      ...r,
      id,
    } as Row;
    if (!row.copies.length) row.copies = [{ id: next('c_'), sourceKind: row.source.kind === 'files' ? 'files' : 'courier', label: row.source.label, arrivedAt: row.arrivedAt }];
    if (!row.versions.length) row.versions = [{ id: next('v_'), at: row.arrivedAt, by: row.fromKey ?? 'member', byName: row.fromName, milestone: 'received', milestoneText: row.fromName ? `Received from ${row.fromName}` : null, pagesChanged: [], restorable: false }];
    if (!row.pages.length && (row.type === 'pdf' || row.type === 'text')) {
      row.pages = Array.from({ length: row.pageCount ?? 1 }, (_, i) => `Page ${i + 1}. ${SENTENCES.slice(i % 3, (i % 3) + 4).join(' ')}`);
    }
    this.rows.set(id, row);
    return row;
  }

  private wire(r: Row): Record<string, unknown> {
    const now = Date.now();
    return {
      id: r.id,
      kind: r.kind,
      type: r.type,
      title: r.title,
      origName: r.origName,
      size: r.size,
      place: r.place,
      maybe: r.maybe,
      reason: { code: r.reasonCode, text: r.reasonText },
      dueAt: r.dueAt,
      from: r.fromName || r.fromKey ? { name: r.fromName, personKey: r.fromKey } : null,
      arrivedAt: r.arrivedAt,
      changedAt: r.changedAt,
      changedBy: r.changedBy,
      state: r.state,
      heldUntil: r.heldUntil && r.heldUntil > now ? r.heldUntil : null,
      copies: r.copies.length,
      versions: r.versions.length,
      changedPages: r.changedPages,
      lastPage: r.lastPage,
      pageCount: r.pageCount,
      viewable: r.type !== 'other' && !r.danger,
      danger: r.danger,
      untrusted: r.untrusted,
      sensitive: r.sensitive,
      summary: r.summary,
      source: r.source,
      ...(r.sensitive ? { sensitiveText: r.fromName ? `A letter from ${r.fromName}. Open to read.` : 'A letter. Open to read.' } : {}),
    };
  }

  private row(id: unknown): Row {
    const r = typeof id === 'string' ? this.rows.get(id) : undefined;
    if (!r) throw refusal(typeof id === 'string' && /^d_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ? 'not_found' : 'bad_request', { reason: typeof id === 'string' && /^d_/.test(id) ? 'doc' : 'id' });
    return r;
  }

  private undoToken(fn: () => void): string {
    const t = next('u_');
    this.undos.set(t, fn);
    return t;
  }

  /** The member's `docs.*`, as deskd answers them. */
  async answer(method: string, p: Record<string, unknown>, bulk?: MockBulk | null): Promise<unknown> {
    this.control.calls.push({ m: method, p });
    if (this.control.delayMs) await new Promise((r) => setTimeout(r, this.control.delayMs));
    const refused = this.control.refuse[method];
    if (refused) throw refusal(refused, refused === 'unavailable' ? { reason: 'sandbox' } : {});
    const now = Date.now();
    switch (method) {
      case 'docs.list': {
        const place = typeof p['place'] === 'string' ? p['place'] : 'needs';
        const view = p['view'];
        let rows = [...this.rows.values()].filter((r) => place === 'all' || r.place === place);
        if (place === 'needs') rows = rows.filter((r) => r.state !== 'handled' && !(r.heldUntil && r.heldUntil > now));
        if (view === 'week') rows = rows.filter((r) => Math.max(r.arrivedAt, r.changedAt) > now - 7 * DAY);
        // Maybe after the sure ones; then by what changed last.
        rows.sort((a, b) => Number(a.maybe) - Number(b.maybe) || b.changedAt - a.changedAt);
        if (view === 'people') {
          const order = [...new Set(rows.map((r) => r.fromKey ?? ''))];
          rows.sort((a, b) => order.indexOf(a.fromKey ?? '') - order.indexOf(b.fromKey ?? '') || Number(a.maybe) - Number(b.maybe));
        }
        return { items: rows.map((r) => this.wire(r)), counts: this.counts(), cursor: null, more: false, end: place === 'needs' || place === 'read' ? END : null };
      }
      case 'docs.get': {
        const r = this.row(p['id']);
        const places = r.copies.map((k) => (k.sourceKind === 'courier' ? 'Mail' : k.sourceKind === 'downloads' ? 'Downloads' : 'Files'));
        return {
          doc: this.wire(r),
          copies: r.copies.map((k) => ({ ...k, gone: false })),
          copiesText: places.length > 1 ? `${places.length} copies: ${places.join(', ')}` : null,
          versions: r.versions.map((v, i) => ({ ...v, sha256: '0'.repeat(64), current: i === 0, restorable: i > 0 && v.restorable })),
          links: r.links,
          alsoIn: r.links,
          questions: [],
        };
      }
      case 'docs.search': {
        const q = String(p['q'] ?? '').toLowerCase().trim();
        const inText = p['inText'] === true;
        const items = [...this.rows.values()].flatMap((r) => {
          const name = `${r.title} ${r.origName}`.toLowerCase().includes(q);
          const inside = inText && (r.pages.join(' ') + (r.sections ?? []).map((s) => s.text).join(' ')).toLowerCase().includes(q);
          return q && (name || inside) ? [{ ...this.wire(r), matchedText: !name && inside }] : [];
        });
        return { items, more: false };
      }
      case 'docs.byPath': {
        const path = String(p['path'] ?? '');
        const r = [...this.rows.values()].find((x) => x.copies.some((k) => k.path === path));
        if (r) return { id: r.id };
        // Not indexed yet: deskd indexes it now, then answers.
        const name = path.slice(path.lastIndexOf('/') + 1);
        const ext = (name.split('.').pop() ?? '').toLowerCase();
        const type: Type = ext === 'pdf' ? 'pdf' : /^(png|jpe?g|gif|bmp)$/.test(ext) ? 'image' : ext === 'docx' || ext === 'xlsx' || ext === 'pptx' ? (ext as Type) : /^(txt|md|csv)$/.test(ext) ? 'text' : 'other';
        if (type === 'other') throw refusal('not_found', { reason: 'doc' });
        const added = this.add({ title: `${day(now)} · You · ${name.replace(/\.[^.]+$/, '')}`, origName: name, type, kind: 'file', place: 'read', reasonCode: 'own', reasonText: 'Added by you', source: { kind: 'files', label: `Files · ${path}` }, copies: [{ id: next('c_'), sourceKind: 'files', label: `Files · ${path}`, arrivedAt: now, path }], untrusted: false, fromName: 'You', ...(type === 'text' ? { pages: [`The text of ${name}.`] } : {}) });
        this.changed([added.id]);
        return { id: added.id };
      }
      case 'docs.text': {
        const r = this.row(p['id']);
        if (r.danger) throw refusal('forbidden', { reason: 'danger', danger: r.danger });
        if (this.control.sandbox) throw refusal('unavailable', { reason: 'sandbox' });
        if (r.sections) return { type: r.type, sections: r.sections.map((s) => ({ ...s })) };
        return { type: r.type, pages: r.pages.map((text, i) => ({ n: i + 1, text })) };
      }
      case 'docs.page': {
        const r = this.row(p['id']);
        if (r.danger) throw refusal('forbidden', { reason: 'danger', danger: r.danger });
        if (r.type !== 'pdf' && r.type !== 'image') throw refusal('bad_request', { reason: 'unsupported' });
        if (this.control.sandbox) throw refusal('unavailable', { reason: 'sandbox' });
        const page = typeof p['page'] === 'number' ? p['page'] : 1;
        if (page < 1 || page > (r.pageCount ?? 1)) throw refusal('not_found', { reason: 'page' });
        if (!bulk) throw refusal('unavailable');
        const img = await drawPage(typeof p['width'] === 'number' ? p['width'] : 800, r.type, page, true);
        const changed = new Set(r.changedLines[page] ?? []);
        const lines = r.type === 'pdf' ? boxes(page).map((b, i) => ({ b, changed: changed.has(i) })) : [];
        const transferId = bulk.read(`docs/${r.id}/${page}`, img.bytes, 0);
        return { transferId, size: img.bytes.length, sha256: await sha256(img.bytes), format: 'jpeg', width: img.width, height: img.height, pageCount: r.pageCount ?? 1, lines };
      }
      case 'docs.page.stop':
        if (typeof p['transferId'] === 'number') bulk?.stop(p['transferId']);
        return {};
      case 'docs.changes': {
        const r = this.row(p['id']);
        if (r.danger) throw refusal('forbidden', { reason: 'danger', danger: r.danger });
        const pages = Object.keys(r.changedLines).map(Number).sort((a, b) => a - b);
        if (r.versions.length < 2) return { pages: [], line: 'This is the first version.' };
        return { pages, line: pagesWords(pages), ...(r.changeLine ? { changeLine: r.changeLine } : {}) };
      }
      case 'docs.questions': {
        const qs: unknown[] = this.questions.map((q) => ({ ...q }));
        if (this.firstSort !== null && !this.firstSortTold) {
          const c = this.counts();
          const k = (c['needs'] ?? 0) + (c['maybe'] ?? 0);
          qs.unshift({ id: 'q_firstsort', kind: 'firstsort', text: `I sorted ${this.firstSort} documents. ${k === 0 ? 'None of them need you.' : `${k} might need you.`}`, choices: [{ id: 'show', label: 'Show me' }, { id: 'later', label: 'Later' }], docIds: [] });
        }
        return { questions: qs };
      }
      case 'docs.rules':
        return { rules: this.rules.map((r) => ({ id: r.id, match: {}, effect: r.effect, madeBy: r.madeBy, at: r.at, text: r.text })) };
      case 'docs.summary': {
        const c = this.counts();
        return { counts: c, needsYou: c['needs'], maybe: c['maybe'], held: 0 };
      }
      case 'docs.feed': {
        // `{front: true}` only (the office's observe for the shield): ids, places and times.
        const now = Date.now();
        const SHIELD: Record<Place, string> = { needs: 'needs_you', read: 'read_later', records: 'records', working: 'working' };
        const rows = [...this.rows.values()]
          .filter((r) => r.state !== 'handled' && !(r.heldUntil && r.heldUntil > now) && (r.place === 'needs' || (r.place === 'read' && r.state === 'new') || r.changedPages.length > 0))
          .sort((a, b) => Number(a.place !== 'needs') - Number(b.place !== 'needs') || Number(a.maybe) - Number(b.maybe) || b.changedAt - a.changedAt);
        return { items: rows.slice(0, 50).map((r) => ({ docId: r.id, place: r.place === 'needs' && r.maybe ? 'maybe' : SHIELD[r.place], dueAt: r.dueAt, changed: r.changedPages.length > 0, at: r.changedAt })), more: rows.length > 50 };
      }
      case 'docs.tidy':
        return this.tidyItems
          ? { copies: 2, downloads: 1, drafts: 0, bytes: 3 * 1024 * 1024, items: Array.from({ length: this.tidyItems }, (_, i) => ({ id: uid('d_', 900 + i), copyId: uid('c_', 900 + i), label: 'Downloads', size: 1024 })), text: 'Tidy up? 2 extra copies and 1 downloads you haven’t opened (3 MB). They go to the trash for 30 days.' }
          : { copies: 0, downloads: 0, drafts: 0, bytes: 0, items: [] };
      case 'docs.read': {
        const r = this.row(p['id']);
        if (r.danger) throw refusal('forbidden', { reason: 'danger', danger: r.danger });
        // The reader answers a moment later; the summary comes through the topic, as on a desk.
        setTimeout(() => {
          r.summary = { line: r.reads?.line ?? `A ${r.type === 'image' ? 'photo' : 'document'} from ${r.fromName ?? 'you'}.`, what: r.reads?.what ?? 'other', asks: [], due: null, pages: {}, at: Date.now() };
          this.changed([r.id]);
        }, 500);
        return {};
      }
      case 'docs.tap': {
        const r = this.row(p['id']);
        const chip = p['chip'];
        const before = { place: r.place, maybe: r.maybe, state: r.state, heldUntil: r.heldUntil, reasonCode: r.reasonCode, reasonText: r.reasonText };
        const kind = r.title.split(' · ')[2]?.toLowerCase() ?? 'document';
        const kinds = `${kind.charAt(0).toUpperCase()}${kind.slice(1)}${kind.endsWith('s') ? '' : 's'}`;
        const from = r.fromName ? ` from ${r.fromName}` : '';
        let text: string;
        let ruleId: string | null = null;
        if (chip === 'not_now') {
          r.heldUntil = now + 3 * HOUR;
          text = `Held until ${clock(r.heldUntil)}`;
        } else if (chip === 'done') {
          r.state = 'handled';
          text = 'Done';
        } else if (chip === 'not_important' || chip === 'sooner') {
          const effect = chip === 'sooner' ? 'needs' : 'records';
          ruleId = next('r_');
          this.rules.push({ id: ruleId, text: `${kinds}${from} → ${PLACE[effect]}`, effect, madeBy: 'tap', at: now });
          r.place = effect;
          r.maybe = false;
          r.reasonCode = 'rule';
          r.reasonText = `Your rule: ${PLACE[effect]}`;
          text = chip === 'sooner' ? `${kinds}${from} go to Needs you now.` : `Not important: ${kinds}${from} go to Records now.`;
        } else throw refusal('bad_request', { reason: 'chip' });
        const token = this.undoToken(() => {
          Object.assign(r, before);
          if (ruleId) this.rules = this.rules.filter((x) => x.id !== ruleId);
        });
        this.changed([r.id]);
        return { doc: this.wire(r), ...(ruleId ? { rule: { id: ruleId } } : {}), toast: { text, undo: token } };
      }
      case 'docs.undo': {
        const fn = typeof p['token'] === 'string' ? this.undos.get(p['token']) : undefined;
        if (!fn) throw refusal('not_found', { reason: 'token' });
        this.undos.delete(p['token'] as string);
        fn();
        this.changed(null);
        return {};
      }
      case 'docs.answer': {
        const qid = p['questionId'];
        if (qid === 'q_firstsort') {
          this.firstSortTold = true;
          return {};
        }
        this.questions = this.questions.filter((q) => q.id !== qid);
        this.changed(null);
        return {};
      }
      case 'docs.rule.remove':
        this.rules = this.rules.filter((r) => r.id !== p['id']);
        this.changed(null);
        return {};
      case 'docs.seen': {
        const r = this.row(p['id']);
        if (r.state === 'new') r.state = 'seen';
        if (typeof p['page'] === 'number') r.lastPage = p['page'];
        r.changedPages = [];
        if (r.reasonCode === 'changed') {
          r.reasonCode = r.fromName ? 'from' : 'default';
          r.reasonText = r.fromName ? `From ${r.fromName}` : 'Kept in Records';
        }
        this.changed([r.id]);
        return {};
      }
      case 'docs.restore': {
        const r = this.row(p['id']);
        const v = r.versions.find((x) => x.id === p['version']);
        if (!v || !v.restorable) throw refusal('not_found', { reason: 'version' });
        const added: Version = { id: next('v_'), at: now, by: 'member', byName: 'You', milestone: 'restored', milestoneText: 'Restored', pagesChanged: v.pagesChanged, restorable: false };
        r.versions = [added, ...r.versions.map((x, i) => (i === 0 ? { ...x, restorable: true } : x))];
        const token = this.undoToken(() => {
          r.versions = r.versions.filter((x) => x.id !== added.id);
        });
        this.changed([r.id]);
        return { doc: this.wire(r), toast: { text: 'Restored. The newer one is kept as a version.', undo: token } };
      }
      case 'docs.tidy.apply': {
        const moved = this.tidyItems;
        this.tidyItems = 0;
        const token = this.undoToken(() => (this.tidyItems = moved));
        this.changed(null);
        return { moved, toast: { text: `Tidied. ${moved} ${moved === 1 ? 'item' : 'items'} in the trash for 30 days.`, undo: token } };
      }
      case 'docs.ask.allow': {
        const r = this.row(p['id']);
        if (r.danger) throw refusal('forbidden', { reason: 'danger', danger: r.danger });
        return { until: now + 10 * MIN };
      }
      // The office's one person key (`personKey.ts`): a stand-in desk keeps it in memory only.
      case 'docs.key.get':
        return this.sharedKey ? { keyId: this.sharedKey.key.slice(0, 8), shared: true, key: this.sharedKey.key, at: this.sharedKey.at } : { keyId: '0badf00d', shared: false };
      case 'docs.key.set': {
        const key = typeof p['key'] === 'string' && /^[0-9a-f]{64}$/.test(p['key']) ? p['key'] : null;
        if (!key) throw refusal('bad_request', { reason: 'key' });
        const changed = this.sharedKey?.key !== key;
        this.sharedKey = { key, at: typeof p['at'] === 'number' ? p['at'] : now };
        return { keyId: key.slice(0, 8), changed };
      }
      default:
        throw refusal('not_found');
    }
  }

  /** The sample: a contract with a changed page 3, an invoice, Maybe's two, a newsletter, a plan, a receipt, a program refused, a download. */
  seed(kind: 'personal' | 'work' | 'other'): void {
    const now = Date.now();
    const rosa = 'pk_3f9a12c04b7e8d51';
    const north = 'pk_8c21d0e5f3a49b72';
    if (kind === 'personal') {
      const contractLines: Record<number, number[]> = { 3: [6, 7, 8] };
      this.add({
        id: uid('d_', 1),
        type: 'pdf',
        title: `${day(now - 2 * DAY)} · Rosa Ortiz · Contract`,
        origName: 'Contract v3 final (1).pdf',
        place: 'needs',
        reasonCode: 'changed',
        reasonText: 'Page 3 changed',
        fromName: 'Rosa Ortiz',
        fromKey: rosa,
        arrivedAt: now - 9 * DAY,
        changedAt: now - 2 * HOUR,
        changedBy: { kind: 'person', name: 'Rosa Ortiz' },
        state: 'seen',
        changedPages: [3],
        pageCount: 6,
        lastPage: 1,
        summary: { line: 'The payment date moved to 1 December (p. 3).', what: 'contract', asks: ['sign'], due: null, pages: { sign: 6 }, changeLine: 'Rosa moved the payment date to 1 December.', at: now - HOUR },
        changeLine: 'Rosa moved the payment date to 1 December.',
        changedLines: contractLines,
        source: { kind: 'courier', label: 'Email from Rosa Ortiz · Contract' },
        copies: [
          { id: uid('c_', 1), sourceKind: 'courier', label: 'Email from Rosa Ortiz · Contract', arrivedAt: now - 2 * HOUR },
          { id: uid('c_', 2), sourceKind: 'files', label: 'Files · Documents/Contract.pdf', arrivedAt: now - 9 * DAY, path: 'Documents/Contract.pdf' },
        ],
        versions: [
          { id: uid('v_', 3), at: now - 2 * HOUR, by: rosa, byName: 'Rosa Ortiz', milestone: 'received', milestoneText: 'Received from Rosa Ortiz', pagesChanged: [3], restorable: false },
          { id: uid('v_', 2), at: now - 5 * DAY, by: 'agent:ag-writer', byName: 'Writer', milestone: 'edited', milestoneText: 'Edited by Writer', pagesChanged: [2], restorable: true },
          { id: uid('v_', 1), at: now - 9 * DAY, by: rosa, byName: 'Rosa Ortiz', milestone: 'received', milestoneText: 'Received from Rosa Ortiz', pagesChanged: [], restorable: true },
        ],
        links: [{ kind: 'thread', ref: 'ch-rosa', label: 'Your thread with Rosa' }],
        pages: [
          'Service agreement between the client and Rosa Ortiz Studio. Page 1 sets out who the parties are.',
          'Page 2. The work: a brand refresh in three parts, delivered over eight weeks.',
          'Page 3. Payment. The client pays the full amount by 1 December. Late payment adds no fee in the first week.',
          'Page 4. Changes to the work are agreed in writing by both parties.',
          'Page 5. Either party may end this agreement with 14 days’ notice.',
          'Page 6. Signatures. Sign and date below.',
        ],
      });
      this.add({
        id: uid('d_', 2),
        type: 'pdf',
        title: `${day(now - DAY)} · Northwind · Invoice`,
        origName: 'INV-20931.pdf',
        place: 'needs',
        reasonCode: 'pay',
        reasonText: 'Asks you to pay by 1 Dec',
        dueAt: now + 12 * DAY,
        fromName: 'Northwind',
        fromKey: north,
        arrivedAt: now - DAY,
        changedAt: now - DAY,
        state: 'new',
        pageCount: 1,
        source: { kind: 'courier', label: 'Email from Northwind · Invoice 20931' },
        reads: { line: 'An invoice for 340 dollars, due 1 December.', what: 'invoice' },
      });
      this.add({
        id: uid('d_', 3),
        type: 'pdf',
        title: `${day(now - 3 * HOUR)} · Sam Lee · Lease form`,
        origName: 'lease_form_FINAL_v2.pdf',
        place: 'needs',
        maybe: true,
        reasonCode: 'fields',
        reasonText: 'Has empty signature fields',
        fromName: 'Sam Lee',
        fromKey: 'pk_51e7a0c93d2b6f48',
        arrivedAt: now - 3 * HOUR,
        changedAt: now - 3 * HOUR,
        state: 'new',
        pageCount: 3,
        source: { kind: 'courier', label: 'Email from Sam Lee · Lease' },
      });
      this.add({
        id: uid('d_', 4),
        type: 'pdf',
        title: `${day(now - 5 * HOUR)} · Harbor Dental · Letter`,
        origName: 'letter.pdf',
        place: 'needs',
        maybe: true,
        reasonCode: 'new_sender',
        reasonText: 'New sender',
        fromName: 'Harbor Dental',
        fromKey: 'pk_0d4c8e2a71f5b936',
        arrivedAt: now - 5 * HOUR,
        changedAt: now - 5 * HOUR,
        state: 'new',
        sensitive: true,
        pageCount: 1,
        summary: { line: 'Your next appointment is on 4 December.', what: 'letter', asks: [], due: null, pages: {}, at: now - HOUR },
        source: { kind: 'courier', label: 'Email from Harbor Dental' },
      });
      this.add({
        id: uid('d_', 5),
        type: 'text',
        title: `${day(now - 2 * DAY)} · Field Notes · Newsletter`,
        origName: 'field-notes-112.md',
        place: 'read',
        reasonCode: 'updates',
        reasonText: 'From a newsletter',
        fromName: 'Field Notes',
        fromKey: 'pk_9a6b3c1d2e4f5071',
        arrivedAt: now - 2 * DAY,
        changedAt: now - 2 * DAY,
        pages: ['Field Notes, issue 112.\n\nThis week: quieter tools, fewer tabs, and a short walk before lunch.\n\nThree small habits that keep a desk calm.'],
        source: { kind: 'courier', label: 'Email from Field Notes' },
      });
      this.add({
        id: uid('d_', 6),
        type: 'docx',
        kind: 'file',
        title: `${day(now - 3 * DAY)} · You · Trip plan`,
        origName: 'Trip plan.docx',
        place: 'read',
        reasonCode: 'own',
        reasonText: 'Added by you',
        fromName: 'You',
        untrusted: false,
        arrivedAt: now - 3 * DAY,
        changedAt: now - DAY,
        pageCount: null,
        sections: [
          { kind: 'h', text: 'Trip plan' },
          { kind: 'p', text: 'Leave Friday morning, back Sunday evening. Two nights by the lake.' },
          { kind: 'h', text: 'What to bring' },
          { kind: 'p', text: 'Walking shoes, a warm layer, the small camera.' },
          { kind: 'table', text: 'Costs', rows: [['Item', 'Cost'], ['Cabin', '220'], ['Train', '64']] },
        ],
        versions: [
          { id: uid('v_', 62), at: now - DAY, by: 'member', byName: 'You', milestone: null, milestoneText: null, pagesChanged: [], restorable: false },
          { id: uid('v_', 61), at: now - 3 * DAY, by: 'member', byName: 'You', milestone: null, milestoneText: null, pagesChanged: [], restorable: true },
        ],
        source: { kind: 'files', label: 'Files · Documents/Trip plan.docx' },
        copies: [{ id: uid('c_', 6), sourceKind: 'files', label: 'Files · Documents/Trip plan.docx', arrivedAt: now - 3 * DAY, path: 'Documents/Trip plan.docx' }],
      });
      this.add({
        id: uid('d_', 7),
        type: 'image',
        title: `${day(now - 6 * DAY)} · Northwind · Receipt`,
        origName: 'IMG_2231.jpg',
        place: 'records',
        reasonCode: 'receipt',
        reasonText: 'A receipt',
        fromName: 'Northwind',
        fromKey: north,
        arrivedAt: now - 6 * DAY,
        changedAt: now - 6 * DAY,
        pageCount: 1,
        source: { kind: 'courier', label: 'Email from Northwind · Receipt' },
      });
      this.add({
        id: uid('d_', 8),
        type: 'other',
        title: `${day(now - 4 * DAY)} · Unknown sender · Invoice tool`,
        origName: 'invoice_viewer.exe',
        place: 'records',
        reasonCode: 'danger',
        reasonText: 'Program. Maia won’t open this.',
        danger: 'program',
        fromName: 'Unknown sender',
        arrivedAt: now - 4 * DAY,
        changedAt: now - 4 * DAY,
        pageCount: null,
        source: { kind: 'courier', label: 'Email from an unknown sender' },
      });
      this.add({
        id: uid('d_', 9),
        type: 'pdf',
        kind: 'download',
        title: `${day(now - HOUR)} · Browser · Report`,
        origName: 'report.pdf',
        place: 'working',
        reasonCode: 'download',
        reasonText: 'Downloaded today',
        fromName: 'Browser',
        arrivedAt: now - HOUR,
        changedAt: now - HOUR,
        pageCount: 2,
        source: { kind: 'files', label: 'Files · Documents/report.pdf' },
        copies: [{ id: uid('c_', 9), sourceKind: 'files', label: 'Files · Documents/report.pdf', arrivedAt: now - HOUR, path: 'Documents/report.pdf' }],
      });
      this.add({
        id: uid('d_', 10),
        type: 'text',
        kind: 'file',
        title: `${day(now - 20 * DAY)} · You · readme`,
        origName: 'readme.txt',
        place: 'records',
        reasonCode: 'default',
        reasonText: 'Kept in Records',
        fromName: 'You',
        untrusted: false,
        arrivedAt: now - 20 * DAY,
        changedAt: now - 20 * DAY,
        pages: ['Everything here is on your desk, and only on your desk.'],
        source: { kind: 'files', label: 'Files · readme.txt' },
        copies: [{ id: uid('c_', 10), sourceKind: 'files', label: 'Files · readme.txt', arrivedAt: now - 20 * DAY, path: 'readme.txt' }],
      });
      this.rules = [{ id: uid('r_', 1), text: 'Invoices from Northwind → Needs you', effect: 'needs', madeBy: 'answer', at: now - 20 * DAY }];
      this.questions = [{ id: uid('q_', 1), kind: 'file', text: 'New from Harbor Dental: a letter. Where should these go?', choices: [{ id: 'needs', label: 'Needs you' }, { id: 'read', label: 'Read later' }, { id: 'records', label: 'Records' }, { id: 'ask', label: 'Ask me each time' }], docIds: [uid('d_', 4)] }];
      this.firstSort = 312;
      this.tidyItems = 3;
    } else if (kind === 'work') {
      this.add({
        id: uid('d_', 21),
        type: 'pptx',
        title: `${day(now - DAY)} · Acme · Proposal`,
        origName: 'Acme proposal.pptx',
        place: 'needs',
        reasonCode: 'from',
        reasonText: 'From Acme',
        fromName: 'Acme',
        fromKey: 'pk_7b2e9f0c1a3d4e56',
        arrivedAt: now - DAY,
        changedAt: now - DAY,
        state: 'new',
        pageCount: null,
        sections: [
          { kind: 'slide', text: 'A calmer onboarding, in three steps.' },
          { kind: 'slide', text: 'Step one: one question at a time.' },
          { kind: 'slide', text: 'Timeline: six weeks, starting in January.' },
        ],
        source: { kind: 'courier', label: 'Email from Acme · Proposal' },
      });
      this.add({
        id: uid('d_', 22),
        type: 'xlsx',
        kind: 'agent_output',
        title: `${day(now - 2 * HOUR)} · Writer · Quarterly numbers`,
        origName: 'q3-numbers.xlsx',
        place: 'working',
        reasonCode: 'made',
        reasonText: 'Made for you by Writer',
        fromName: 'Writer',
        arrivedAt: now - 2 * HOUR,
        changedAt: now - 2 * HOUR,
        pageCount: null,
        sections: [{ kind: 'sheet', text: 'Q3', rows: [['Month', 'Visits', 'Sign-ups'], ['July', '1,204', '88'], ['August', '1,390', '97'], ['September', '1,512', '121']] }],
        source: { kind: 'files', label: 'Files · Work/q3-numbers.xlsx' },
      });
      // A Notebook page and a write-up an agent left for one of Maia's briefs (the index's second build): quiet, never new.
      this.add({
        id: uid('d_', 23),
        type: 'text',
        kind: 'page',
        title: `${day(now - 5 * HOUR)} · You · Acme kickoff notes`,
        origName: 'Acme kickoff notes.md',
        place: 'records',
        reasonCode: 'default',
        reasonText: 'Kept in Records',
        fromName: null,
        changedBy: { kind: 'member', name: null },
        untrusted: false,
        arrivedAt: now - 5 * HOUR,
        changedAt: now - 5 * HOUR,
        pages: ['Acme kickoff notes\n\nBudget review with Sam on Friday. Proposal timeline: six weeks from January.'],
        source: { kind: 'notebook', label: 'Notebook · Work' },
        copies: [{ id: uid('c_', 23), sourceKind: 'notebook', label: 'Notebook · Work', arrivedAt: now - 5 * HOUR }],
      });
      this.add({
        id: uid('d_', 24),
        type: 'text',
        kind: 'writeup',
        title: `${day(now - 3 * HOUR)} · Scout · Write-up`,
        origName: 'Write-up.md',
        place: 'read',
        reasonCode: 'made',
        reasonText: 'Made for you by Scout',
        fromName: null,
        changedBy: { kind: 'agent', name: 'Scout' },
        arrivedAt: now - 3 * HOUR,
        changedAt: now - 3 * HOUR,
        pages: ['Quotes compared for the Acme rollout.\n\nPlan B is the cheapest over a year; plan A starts sooner.'],
        source: { kind: 'writeup', label: 'Write-up by Scout' },
        copies: [{ id: uid('c_', 24), sourceKind: 'writeup', label: 'Write-up by Scout', arrivedAt: now - 3 * HOUR }],
      });
    } else {
      this.add({ id: next('d_'), type: 'pdf', title: `${day(now - DAY)} · You · Notes`, place: 'read', reasonCode: 'own', reasonText: 'Added by you', fromName: 'You', untrusted: false, source: { kind: 'files', label: 'Files · Notes.pdf' } });
    }
  }
}

const desks = new Map<string, MockDocsDesk>();

/** One desk's index, made and seeded the first time it's asked: `d-personal…` and `d-work…` with the sample, any other with one document. */
export function mockDocs(deskId: string): MockDocsDesk {
  let desk = desks.get(deskId);
  if (!desk) {
    // `window.__maDocsMockInit = { refuse: { 'docs.list': 'not_found' }, sandbox: true }` before load: a deskd before §24, or a desk whose sandbox is away.
    const init = (globalThis as { __maDocsMockInit?: { refuse?: Record<string, string>; sandbox?: boolean } }).__maDocsMockInit;
    desk = new MockDocsDesk(deskId, { ...(init?.refuse ? { refuse: { ...init.refuse } } : {}), ...(init?.sandbox ? { sandbox: true } : {}) });
    desk.seed(deskId.startsWith('d-personal') ? 'personal' : deskId.startsWith('d-work') ? 'work' : 'other');
    desks.set(deskId, desk);
  }
  return desk;
}

/** `__maDeskMock.docs`: each desk's index, for a test to steer. */
export const docsControl = {
  desk: (deskId: string): MockDocsDesk => mockDocs(deskId),
  all: (): ReadonlyMap<string, MockDocsDesk> => desks,
};
