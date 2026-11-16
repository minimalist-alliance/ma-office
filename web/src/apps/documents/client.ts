// Documents' adapter: the member's `docs.*` methods and the `docs` topic over one desk's link, every reply read through
// `wire.ts`. The wire is deskd's API.md §25 (`DocsMethods.java` where §25 is vague). The window talks only to this, so the mock
// desk (`desk/mockDeskDocs.ts`) and a real deskd are the same to it. Each mutation carries one `idem` across a retry of a lost
// reply (§4). Page images come over the desk's own `bulk` channel (Courier's reader, `courier/bulk.ts`): nothing of ours
// sees them, and they live only as Blob URLs the viewer revokes.
import type { DeskLink, DeskRpc } from '../../desk/deskLink';
import { readTransfer } from '../courier/bulk';
import type { Changes, Chip, Doc, DocDetail, DocList, DocsEvent, DocText, ListView, PageHead, Place, Question, Rule, TidyPreview, Toast } from './types';
import { plain, readChanges, readDetail, readDoc, readEvent, readList, readPage, readQuestions, readRules, readSearch, readText, readTidy, readToast } from './wire';

/**
 * What the desk refused, in the window's terms: `offline` (no session), `old` (a deskd before §25: `not_found` with no reason),
 * `gone` (`not_found` `doc`), `danger` (`forbidden` `danger`), `sandbox` (`unavailable` `sandbox`: the list works, the viewer
 * can't draw), `switched_off`, `paused` (a bandwidth limit), else deskd's own code.
 */
export class DocsError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, details: Record<string, unknown> = {}) {
    super(`docs ${code}`);
    this.name = 'DocsError';
    this.code = code;
    this.details = details;
  }
}

export function toDocsError(e: unknown): DocsError {
  if (e instanceof DocsError) return e;
  const o = e as { code?: unknown; details?: unknown; name?: unknown } | null;
  if (o && o.name === 'DeskNotConnected') return new DocsError('offline');
  const raw = typeof o?.code === 'string' ? o.code : 'internal';
  const details = o?.details && typeof o.details === 'object' ? (o.details as Record<string, unknown>) : {};
  const reason = details['reason'];
  if (raw === 'offline') return new DocsError('offline', details);
  if (raw === 'not_found') return new DocsError(reason === undefined ? 'old' : reason === 'doc' || reason === 'gone' ? 'gone' : 'not_found', details);
  if (raw === 'forbidden' && reason === 'danger') return new DocsError('danger', details);
  if (raw === 'unavailable' && (reason === 'sandbox' || reason === 'switched_off' || reason === 'bandwidth_limit')) return new DocsError(reason === 'bandwidth_limit' ? 'paused' : reason, details);
  return new DocsError(raw, details);
}

export interface ListQuery {
  place: Place;
  view?: ListView | null;
  person?: string | null;
  limit?: number;
}

export interface DocsClient {
  readonly deskId: string;
  list(q: ListQuery): Promise<DocList>;
  get(id: string): Promise<DocDetail>;
  search(q: string, inText: boolean): Promise<{ items: Doc[]; more: boolean }>;
  byPath(path: string): Promise<string>;
  text(id: string): Promise<DocText>;
  /** One page drawn by the desk at `width`, its bytes over `bulk` as a Blob. */
  page(id: string, page: number, width: number, signal?: AbortSignal): Promise<{ head: PageHead; blob: Blob }>;
  changes(id: string): Promise<Changes>;
  questions(): Promise<Question[]>;
  rules(): Promise<Rule[]>;
  tidy(): Promise<TidyPreview>;
  /** "What's this?": asks the desk's reader; the summary comes later, through the `docs` topic. */
  read(id: string): Promise<void>;
  tap(id: string, chip: Chip): Promise<{ doc: Doc | null; toast: Toast | null }>;
  /** `note`: what the desk says instead when it can't put things back itself (a tidy: "Restore them from Files' trash."). */
  undo(token: string): Promise<{ doc: Doc | null; note: string | null }>;
  answer(questionId: string, choice: string): Promise<void>;
  ruleRemove(id: string): Promise<void>;
  seen(id: string, page: number, ms: number): Promise<void>;
  restore(id: string, version: string): Promise<Toast | null>;
  tidyApply(): Promise<Toast | null>;
  askAllow(id: string): Promise<number | null>;
  /** Something changed on this desk: ids and counts only. A refusal (an older deskd) is said once. */
  watch(fn: (e: DocsEvent) => void, onRefused?: (code: string) => void): () => void;
}

/** Lost replies are asked again with the same key, three tries; a refusal is final. */
async function mutate<T>(call: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let n = 0; n < 3; n += 1) {
    try {
      return await call();
    } catch (e) {
      last = e;
      const code = (e as { code?: unknown } | null)?.code;
      const lost = code === 'deadline_exceeded' || code === 'cancelled' || (code === 'unavailable' && !(e as { details?: { mayHaveApplied?: boolean } }).details?.mayHaveApplied && !(e as { details?: { reason?: unknown } }).details?.reason);
      if (!lost) break;
    }
  }
  throw toDocsError(last);
}

type Method = keyof DeskRpc & `docs.${string}`;

export function rpcDocsClient(link: DeskLink, idem: () => string): DocsClient {
  const read = async <T>(method: Method, params: Record<string, unknown>, parse: (v: unknown) => T, deadlineMs?: number): Promise<T> => {
    try {
      return parse(await link.call(method, params, deadlineMs ? { deadlineMs } : undefined));
    } catch (e) {
      throw toDocsError(e);
    }
  };
  const write = <T>(method: Method, params: Record<string, unknown>, parse: (v: unknown) => T): Promise<T> => {
    const key = idem();
    return mutate(() => link.call(method, params, { idem: key })).then(parse);
  };
  return {
    deskId: link.deskId,
    list: (q) => read('docs.list', { place: q.place, ...(q.view ? { view: q.view } : {}), ...(q.person ? { person: q.person } : {}), limit: q.limit ?? 50 }, readList),
    async get(id) {
      const d = await read('docs.get', { id }, readDetail);
      if (!d) throw new DocsError('internal');
      return d;
    },
    search: (q, inText) => read('docs.search', { q: q.slice(0, 200), ...(inText ? { inText: true } : {}), limit: 20 }, readSearch),
    async byPath(path) {
      const id = await read('docs.byPath', { path }, (v) => (v && typeof v === 'object' ? (v as { id?: unknown }).id : null), 30_000);
      if (typeof id !== 'string') throw new DocsError('internal');
      return id;
    },
    text: (id) => read('docs.text', { id }, readText, 30_000),
    async page(id, page, width, signal) {
      try {
        const parts: Uint8Array[] = [];
        const head = await readTransfer(
          link,
          () => link.call('docs.page', { id, page, width }, { deadlineMs: 60_000 }),
          (transferId) => link.call('docs.page.stop', { transferId }),
          async (b) => void parts.push(b),
          signal ? { signal } : {},
        );
        const h = readPage(head.reply);
        if (!h) throw new DocsError('internal');
        // The picture's type is ours, from the desk's word for the two formats its sandbox draws (never a claim of the file's).
        return { head: h, blob: new Blob(parts as BlobPart[], { type: h.format === 'png' ? 'image/png' : 'image/jpeg' }) };
      } catch (e) {
        throw toDocsError(e);
      }
    },
    changes: (id) => read('docs.changes', { id }, readChanges),
    questions: () => read('docs.questions', {}, readQuestions),
    rules: () => read('docs.rules', {}, readRules),
    tidy: () => read('docs.tidy', {}, readTidy),
    read: (id) => read('docs.read', { id }, () => undefined),
    tap: (id, chip) => write('docs.tap', { id, chip }, (v) => ({ doc: readDoc((v as { doc?: unknown } | null)?.doc), toast: readToast(v) })),
    undo: (token) => write('docs.undo', { token }, (v) => ({ doc: readDoc((v as { doc?: unknown } | null)?.doc), note: plain((v as { note?: unknown } | null)?.note, 120) || null })),
    answer: (questionId, choice) => write('docs.answer', { questionId, choice }, () => undefined),
    ruleRemove: (id) => write('docs.rule.remove', { id }, () => undefined),
    async seen(id, page, ms) {
      // A failure is quiet: the next open says it again.
      await write('docs.seen', { id, ...(page >= 1 ? { page: Math.min(500, page) } : {}), ms: Math.min(86_400_000, Math.max(0, Math.round(ms))) }, () => undefined).catch(() => undefined);
    },
    restore: (id, version) => write('docs.restore', { id, version }, readToast),
    tidyApply: () => write('docs.tidy.apply', {}, readToast),
    askAllow: (id) => write('docs.ask.allow', { id }, (v) => {
      const until = (v as { until?: unknown } | null)?.until;
      return typeof until === 'number' ? until : null;
    }),
    watch: (fn, onRefused) => link.subscribe('docs', (msg) => fn(readEvent(msg)), onRefused),
  };
}
