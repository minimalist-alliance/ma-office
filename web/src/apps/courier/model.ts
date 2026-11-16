// Courier's pure rules: what a row and a sender line say, when, the links a message's HTML holds (read from the sandbox's
// `data-ma-*`, checked again here), the search highlights and the reply's medium. No DOM and no desk: unit tested alone.
import type { Contact, Endpoint, Hit, Lane, MailLink, Medium, Message, Person, Row, Sender, Suggestion } from './types';
import { plain } from './wire';
import { W } from './words';

// ---------------------------------------------------------------- names and senders

/** A contact's name to show, or its address where it has none. Never a display name alone: callers show the address too. */
export const contactName = (c: Pick<Contact, 'name' | 'endpoint'>): string => c.name.trim() || c.endpoint.value || 'Unknown sender';

/** The name of who sent a message, the member's own as "You". */
export function senderName(s: Sender): string {
  if (!s) return 'Unknown sender';
  return s.me ? W.you : contactName(s);
}

/** The address under the name, when it adds something (it differs from the name). */
export function senderAddress(s: Sender): string {
  if (!s || s.me) return '';
  const v = s.endpoint.value;
  return v && v !== contactName(s) ? v : '';
}

/** A row's title: the list's own title, else its people's names. */
export function rowTitle(r: Pick<Row, 'title' | 'contacts' | 'kind'>): string {
  if (r.title.trim()) return r.title.trim();
  if (r.kind === 'self') return 'Notes to yourself';
  // One person with several ways to reach them (flow 11) is one name.
  const people = r.kind !== 'direct' ? r.contacts : r.contacts.filter((c, i) => !c.contactId || r.contacts.findIndex((x) => x.contactId === c.contactId) === i);
  const names = people.map(contactName);
  if (names.length === 0) return 'Unknown sender';
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`;
}

/** A row's one line: the last message's subject (for email) and its first words. */
export function rowLine(r: Row): string {
  const l = r.last;
  if (!l) return '';
  const who = l.direction === 'out' ? `${W.you}: ` : '';
  if (l.medium === 'email' && l.subject) return `${who}${l.subject}${l.snippet ? ` · ${l.snippet}` : ''}`;
  return `${who}${l.snippet || l.subject}`;
}

/** The domain of an address, lower case. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1).toLowerCase() : '';
}

/**
 * Whether to say "Couldn't confirm this came from {domain}": an email from someone else whose DMARC didn't pass, or with no
 * result at all (API.md §21: the verdict comes only from the transport's own verifier).
 */
export function unconfirmed(m: Pick<Message, 'medium' | 'direction' | 'auth' | 'from'>): boolean {
  if (m.medium !== 'email' || m.direction === 'out' || (m.from && m.from.me)) return false;
  return m.auth?.senderConfirmed !== true;
}

// ---------------------------------------------------------------- time

const pad = (n: number): string => String(n).padStart(2, '0');
interface Parts { y: number; mo: number; d: number; wd: string; h: number; mi: number }
function partsIn(at: number, tz: string | undefined): Parts {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(at))) p[x.type] = x.value;
  return { y: Number(p['year']), mo: Number(p['month']), d: Number(p['day']), wd: p['weekday'] ?? '', h: Number(p['hour']) % 24, mi: Number(p['minute']) };
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayNumber = (p: Parts): number => Date.UTC(p.y, p.mo - 1, p.d) / 86_400_000;

export function clock(at: number, tz?: string): string {
  const p = partsIn(at, tz);
  const h = p.h % 12 === 0 ? 12 : p.h % 12;
  return `${h}:${pad(p.mi)} ${p.h < 12 ? 'am' : 'pm'}`;
}

/** A list row's time: today's clock, "Yesterday", a weekday this week, "Nov 3" this year, "Nov 3, 2025" before. */
export function whenShort(at: number, now: number, tz?: string): string {
  if (!at) return '';
  const a = partsIn(at, tz);
  const n = partsIn(now, tz);
  const days = dayNumber(n) - dayNumber(a);
  if (days <= 0) return clock(at, tz);
  if (days === 1) return 'Yesterday';
  if (days < 7) return a.wd;
  if (a.y === n.y) return `${MONTHS[a.mo - 1]} ${a.d}`;
  return `${MONTHS[a.mo - 1]} ${a.d}, ${a.y}`;
}

/** A message's time in full: "Today, 3:05 pm", "Nov 3, 3:05 pm", "Nov 3, 2025, 3:05 pm". */
export function whenLong(at: number, now: number, tz?: string): string {
  if (!at) return '';
  const a = partsIn(at, tz);
  const n = partsIn(now, tz);
  const days = dayNumber(n) - dayNumber(a);
  const t = clock(at, tz);
  if (days <= 0) return `Today, ${t}`;
  if (days === 1) return `Yesterday, ${t}`;
  return a.y === n.y ? `${MONTHS[a.mo - 1]} ${a.d}, ${t}` : `${MONTHS[a.mo - 1]} ${a.d}, ${a.y}, ${t}`;
}

/** A day as a check names it: "Nov 14" this year, "Nov 14, 2025" before. */
export function dayWords(at: number, now: number, tz?: string): string {
  const a = partsIn(at, tz);
  return a.y === partsIn(now, tz).y ? `${MONTHS[a.mo - 1]} ${a.d}` : `${MONTHS[a.mo - 1]} ${a.d}, ${a.y}`;
}

/** Two safety numbers are the same when their digits are: spaces and line breaks don't count (flow 5). */
export const sameNumber = (typed: string, number: string): boolean => {
  const t = typed.replace(/\s+/g, '');
  return /^\d{60}$/.test(t) && t === number.replace(/\s+/g, '');
};

/** "2 h ago", "5 min ago", "just now", "3 days ago": the composer's reason for its medium. */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

/** A size in the units people read. */
export function sizeWords(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

// ---------------------------------------------------------------- links in a message's HTML

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** Character references, as the sandbox writes them (`&amp;`, `&quot;`, `&lt;`, numeric). Anything else stays as it came. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,6});/g, (all, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : '';
    }
    return ENTITY[e.toLowerCase()] ?? all;
  });
}

const WARNS = ['mismatch', 'ip', 'punycode', 'userinfo', 'tracker'] as const;

/**
 * Security's condition for a link (the parse read, Q3): the sandbox's `data-ma-href` is parsed again here, and only http,
 * https, mailto and tel are kept. Never put in an `href` or a `window.open` in the office's origin: a web link goes to the
 * desk's Browser, an address or a number to the clipboard. Null for anything else.
 */
export function safeTarget(raw: string): Pick<MailLink, 'href' | 'host' | 'scheme'> | null {
  const s = raw.trim();
  if (!s || s.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(s)) return null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme === 'http' || scheme === 'https') {
    if (!url.hostname) return null;
    // The sandbox already took any sign-in name out; one that's here anyway never goes on.
    url.username = '';
    url.password = '';
    return { href: url.href, host: url.hostname, scheme };
  }
  if (scheme === 'mailto') {
    const to = decodeURIComponentSafe(url.pathname).split(',')[0]?.trim() ?? '';
    // An address with a hidden or reordering character in it would show as something it isn't (Security's CA-L1).
    if (plain(to) !== to || !/^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/.test(to)) return null;
    return { href: `mailto:${to}`, host: to, scheme };
  }
  if (scheme === 'tel') {
    const n = decodeURIComponentSafe(url.pathname).replace(/[^0-9+*#]/g, '');
    if (!/^\+?[0-9*#]{3,20}$/.test(n)) return null;
    return { href: `tel:${n}`, host: n, scheme };
  }
  return null;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const ATTR = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*"([^"]*)"/g;
const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;

/**
 * The links in a message's sanitized HTML, from each `<a>`'s `data-ma-href`, `data-ma-warn` and its words, as the sandbox
 * wrote them (an `<a>` has no `href` there). Read as text, never through a document, so nothing here can load or run. A link
 * whose destination isn't one `safeTarget` keeps is left out. One per destination, the first's words, 100 at most.
 */
export function linksOf(html: string): MailLink[] {
  const out: MailLink[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(ANCHOR)) {
    const attrs: Record<string, string> = {};
    for (const a of (m[1] ?? '').matchAll(ATTR)) attrs[(a[1] ?? '').toLowerCase()] = decodeEntities(a[2] ?? '');
    const raw = attrs['data-ma-href'];
    if (!raw) continue;
    const t = safeTarget(raw);
    if (!t || seen.has(t.href)) continue;
    seen.add(t.href);
    const warn = (attrs['data-ma-warn'] ?? '').split(/\s+/).filter((w): w is (typeof WARNS)[number] => (WARNS as readonly string[]).includes(w));
    const words = plain(decodeEntities((m[2] ?? '').replace(/<[^>]*>/g, ' '))).replace(/\s+/g, ' ').trim().slice(0, 200);
    out.push({ ...t, warn: [...new Set(warn)], text: words });
    if (out.length >= 100) break;
  }
  return out;
}

/** Whether a message's HTML holds pictures from the web that the sandbox left unloaded (`data-ma-src`). */
export const hasRemoteImages = (html: string): boolean => /\sdata-ma-src="/.test(html);

/** The host a link's words name, when they look like one ("paypal.com" in "Log in to paypal.com"), for the mismatch line. */
export function wordsHost(words: string): string {
  const m = /\b((?:[a-z0-9-]+\.)+[a-z]{2,24})\b/i.exec(words);
  return m ? (m[1] ?? '').toLowerCase() : '';
}

// ---------------------------------------------------------------- search

export interface Segment {
  text: string;
  hit: boolean;
}

/** A snippet cut at its matches, for `<mark>`. Ranges that overlap or run past the end are merged or cut. */
export function highlight(snippet: string, matches: Hit['matches']): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const [a0, b0] of matches) {
    const a = Math.max(a0, at);
    const b = Math.min(b0, snippet.length);
    if (b <= a) continue;
    if (a > at) out.push({ text: snippet.slice(at, a), hit: false });
    out.push({ text: snippet.slice(a, b), hit: true });
    at = b;
  }
  if (at < snippet.length) out.push({ text: snippet.slice(at), hit: false });
  return out;
}

// ---------------------------------------------------------------- moving through a list

/** The next id by `delta` from `current` (the first going down from none, the last going up). */
export function step(ids: readonly string[], current: string | null, delta: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const i = current ? ids.indexOf(current) : -1;
  if (i < 0) return delta > 0 ? (ids[0] ?? null) : (ids[ids.length - 1] ?? null);
  return ids[Math.max(0, Math.min(ids.length - 1, i + delta))] ?? null;
}

/** The lane a row moves to as "Not spam", and which lanes show an action. */
export const spamLike = (l: Lane): boolean => l === 'spam' || l === 'trash';

// ---------------------------------------------------------------- compose and to-dos

export function replySubject(subject: string): string {
  const s = subject.trim();
  if (!s) return '';
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** What the composer sends by: the medium of the last message received in the thread (the plan §1.5), and why. */
export function replyMedium(messages: readonly Pick<Message, 'direction' | 'medium' | 'at'>[]): { medium: Medium; at: number } | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.direction === 'in') return { medium: m.medium, at: m.at };
  }
  const last = messages[messages.length - 1];
  return last ? { medium: last.medium, at: last.at } : null;
}

// ---------------------------------------------------------------- a message's first view (the Designer's call 1, Nov 14)

/** The member's last choice per sender, for this office's life only: a sender's address is desk content, so it isn't stored. */
const views = new Map<string, 'html' | 'text'>();
const viewKey = (m: Pick<Message, 'from'>): string | null => (m.from && !m.from.me ? `${m.from.endpoint.kind}:${m.from.endpoint.value.toLowerCase()}` : null);

/**
 * How a message with HTML opens: the member's last choice for its sender, else mail from a person (People and Other, not
 * bulk) as text and the rest as sent: Updates, and Requests', Spam's and Trash's, whose links and their warnings show only as
 * sent.
 */
export function firstView(m: Pick<Message, 'from' | 'lane' | 'bulk'>): 'html' | 'text' {
  const k = viewKey(m);
  const kept = k ? views.get(k) : undefined;
  if (kept) return kept;
  return (m.lane === 'people' || m.lane === 'other') && !m.bulk ? 'text' : 'html';
}

export function rememberView(m: Pick<Message, 'from'>, v: 'html' | 'text'): void {
  const k = viewKey(m);
  if (!k) return;
  views.set(k, v);
  if (views.size > 500) views.delete(views.keys().next().value as string);
}

// ---------------------------------------------------------------- one person across channels (the Designer's flow 11)

/** A person's first name for a button ("Link to Dana"): the first word of the member's name for them, else the whole of it. */
export function firstName(name: string): string {
  const n = name.trim();
  return n.split(/\s+/)[0] || n;
}

const isNumber = (e: Endpoint): boolean => e.kind === 'phone' || e.kind === 'sms';

/** A suggestion's one "why" line, strongest source first (the spec's table). */
export function whyLine(s: Pick<Suggestion, 'source' | 'provider' | 'endpoint' | 'into'>): string {
  const first = firstName(s.into.name);
  const kind = isNumber(s.endpoint) ? 'number' : 'address';
  switch (s.source) {
    case 'mac':
      return W.why.mac(kind, first);
    case 'card':
      return W.why.card(first);
    case 'provider':
      return W.why.provider(s.provider ?? 'mail', first);
    case 'signature':
      return W.why.signature(first, kind);
    case 'name':
      return W.why.name;
  }
}

/** Link people's lead: where its suggestions come from, in a phrase ("your Mac’s contacts and a card you added"). */
export function sourcesPhrase(list: readonly Pick<Suggestion, 'source' | 'provider'>[]): string {
  const parts: string[] = [];
  const cards = list.filter((s) => s.source === 'card').length;
  if (list.some((s) => s.source === 'mac')) parts.push(W.sourcePhrase.mac);
  if (cards) parts.push(W.sourcePhrase.card(cards));
  for (const p of [...new Set(list.filter((s) => s.source === 'provider').map((s) => s.provider ?? 'mail'))]) parts.push(W.sourcePhrase.provider(p));
  if (list.some((s) => s.source === 'signature')) parts.push(W.sourcePhrase.signature);
  if (list.some((s) => s.source === 'name')) parts.push(W.sourcePhrase.name);
  if (parts.length <= 1) return parts[0] ?? W.sourcePhrase.name;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The medium an endpoint is reached by, for the person view's line ("Email · you added it"). */
export function endpointMedium(e: Pick<Endpoint, 'kind'>): Medium {
  return e.kind === 'ma' ? 'ma' : e.kind === 'phone' || e.kind === 'sms' || e.kind === 'apple' ? 'imessage' : 'email';
}

/**
 * What the member typed in "Add an email or number": an email (a member address when it's on the Courier domain), a number,
 * or nothing Courier can add. Numbers keep their digits and a leading +; a plain 10-digit number is read as North American.
 */
export function parseEndpoint(raw: string, courierDomain: string | null): Endpoint | null {
  const t = plain(raw).trim();
  if (!t) return null;
  if (t.includes('@')) {
    if (!/^[^\s@]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/.test(t)) return null;
    const v = t.toLowerCase();
    return { kind: courierDomain && v.endsWith(`@${courierDomain}`) ? 'ma' : 'email', value: v };
  }
  if (!/^\+?[\d\s().-]{7,24}$/.test(t)) return null;
  const digits = t.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return { kind: 'phone', value: t.startsWith('+') ? `+${digits}` : digits.length === 10 ? `+1${digits}` : `+${digits}` };
}

/** A person's line under their name in a list: their first way to reach them, and how many more. */
export function waysLine(p: Pick<Person, 'endpoints'>): string {
  const [first, ...rest] = p.endpoints;
  if (!first) return '';
  return rest.length ? `${first.value} ${W.andMore(rest.length)}` : first.value;
}
