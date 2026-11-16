// Maia's web search in the office (ma-platform ADR 0137, contract maia.md "web_search", "sources", "Answering a web
// search"). One card for each reply's batch, never one a search; the sources under her reply, from the search API's own
// results, never her text. Every word here is the app's. Pure.

export type WebMode = 'ask' | 'auto';
export type WebDecision = 'approve' | 'decline' | 'always';

/** One batch waiting on the member, as the stream or a reloaded chat said it. */
export interface WebAsk {
  batchId: string;
  queries: string[];
  expiresAt: string | null;
  status: 'pending' | 'busy' | 'done' | 'expired';
  line: string | null;
}

/** A source under her reply. `url` is only ever http(s), checked here again. */
export interface WebSource {
  n: number;
  title: string;
  url: string;
  domain: string;
}

export const WEB_WORDS = {
  title: 'Search the web?',
  body: 'Maia would like to look these up:',
  approve: 'Search',
  decline: 'Not now',
  always: 'Always allow',
  alwaysHint: "Maia searches without asking from now on. Turn it off from any search line.",
  expired: 'This request has expired. Ask again if you still need it.',
  gone: 'This request is no longer waiting.',
  searching: 'Searching…',
  declined: 'Not searched.',
  status: 'Searching the web…',
  searched: 'Searched the web for',
  askFirst: 'Ask me first',
  askFirstDone: 'Maia will ask before she searches.',
  sources: 'Sources',
  failed: "That didn't go through. Try again in a moment.",
} as const;

const BATCH = /^w_[a-z2-7]{20}$/;
const MAX_QUERIES = 5;
const MAX_QUERY = 200;
const MAX_SOURCES = 8;

export const isBatchId = (v: unknown): v is string => typeof v === 'string' && BATCH.test(v);

/** Queries as plain text: strings only, one line each, at most five. Anything else reads as none. */
export function readQueries(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_QUERIES) return null;
  const out: string[] = [];
  for (const q of v) {
    if (typeof q !== 'string') return null;
    const line = q.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
    if (line) out.push(line);
  }
  return out.length ? out : null;
}

/** An http(s) address with no credentials, or null: a source never opens anything else. */
export function sourceHref(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  try {
    const u = new URL(raw);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** The `sources` list as the widget shows it. Bad entries are dropped; titles and domains are plain text. */
export function readSources(v: unknown): WebSource[] {
  if (!Array.isArray(v)) return [];
  const out: WebSource[] = [];
  for (const s of v.slice(0, MAX_SOURCES)) {
    if (!s || typeof s !== 'object') continue;
    const r = s as Record<string, unknown>;
    const url = sourceHref(r['url']);
    if (!url) continue;
    const domain = typeof r['domain'] === 'string' && r['domain'] ? r['domain'].slice(0, 120) : new URL(url).hostname;
    const title = typeof r['title'] === 'string' && r['title'].trim() ? r['title'].replace(/\s+/g, ' ').trim().slice(0, 120) : domain;
    const n = Number.isInteger(r['n']) && (r['n'] as number) > 0 ? (r['n'] as number) : out.length + 1;
    out.push({ n, title, url, domain });
  }
  return out;
}

/** A batch from `pendingWebSearch` on a reloaded chat, or null. Only while it's still good. */
export function readPending(v: unknown, now: number): WebAsk | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  const queries = readQueries(p['queries']);
  const expiresAt = typeof p['expiresAt'] === 'string' ? p['expiresAt'] : null;
  if (!isBatchId(p['batchId']) || !queries || !expiresAt || !(Date.parse(expiresAt) > now)) return null;
  return { batchId: p['batchId'], queries, expiresAt, status: 'pending', line: null };
}

export const webExpired = (ask: Pick<WebAsk, 'expiresAt'>, now: number): boolean => !!ask.expiresAt && !(Date.parse(ask.expiresAt) > now);

/** The body of an answer to a batch: no message and no files, only which batch and what they chose. */
export function answerBody(conversationId: string, batchId: string, decision: WebDecision, clientContext: unknown): Record<string, unknown> {
  return { conversationId, clientContext, webSearch: { batchId, decision } };
}

/** What the card says once answered, before her reply arrives under it. */
export const decidedLine = (decision: WebDecision): string => (decision === 'decline' ? WEB_WORDS.declined : WEB_WORDS.searching);

/** What an answer the server refused means for the card. */
export function refusedAnswer(status: number): { status: WebAsk['status']; line: string } {
  if (status === 410) return { status: 'expired', line: WEB_WORDS.expired };
  if (status === 404) return { status: 'done', line: WEB_WORDS.gone };
  return { status: 'pending', line: WEB_WORDS.failed };
}
