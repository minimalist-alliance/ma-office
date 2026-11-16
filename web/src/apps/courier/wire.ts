// Every reply from a desk's `courier.*` (deskd API.md §21), read field by field. A field that's missing or the wrong type takes a
// safe default, and a row or message without an id is dropped, so a desk that sends less (an older deskd) or more (a newer one)
// never breaks the window. Every string is desk content written by other people: cleaned of the characters that could reorder
// or hide what a line says, and shown as plain text only. A message's HTML is read as a string here and goes only into the
// sandboxed frame (`frame.ts`).
import { DANGERS, LANES, MEDIA, type Account, type AccountKind, type Archive, type Attachment, type Auth, type Block, type Changed, type Channel, type Contact, type Danger, type DeskKeys, type Downloaded, type Draft, type Endpoint, type Hit, type Lane, type Last, type Lookup, type MacSync, type Medium, type MemberKey, type Message, type Person, type PersonEndpoint, type Preview, type Row, type Sender, type Saved, type Sent, type Status, type Suggestion, type Thread, type Warning } from './types';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown): boolean => v === true;

/**
 * Format characters (bidi controls and isolates, zero-width spaces, the BOM, tag characters), controls, the Hangul fillers and
 * the variation selectors out of anything shown. Only the joiners scripts and emoji need stay, and newlines only where `lines`
 * says (a message's text). Courier's store cleans its text the same way (API.md §21); this holds even for a desk that didn't.
 */
const HIDDEN = /(?![‌‍])[\p{Cf}\p{Cc}ᅟᅠㅤﾠ︀-︍\u{e0100}-\u{e01ef}]/gu;
export const plain = (s: string, lines = false): string => (lines ? s.split(/\r\n|\n/).map((l) => l.replace(HIDDEN, '')).join('\n') : s.replace(HIDDEN, ''));
const text = (v: unknown, max: number): string => plain(str(v)).slice(0, max);

/** A ULID, as every Courier id is (26 Crockford base-32 characters); anything else is no id. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const isId = (v: unknown): v is string => typeof v === 'string' && ULID.test(v);
const idOr = (v: unknown): string | null => (isId(v) ? v : null);
/** An account's id: deskd's own token (`imap-<hex>`, a ULID, `desk`): short, plain, nothing else. */
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const accountIdOr = (v: unknown): string | null => (typeof v === 'string' && ACCOUNT_ID.test(v) ? v : null);

const lane = (v: unknown, d: Lane = 'people'): Lane => (LANES.includes(v as Lane) ? (v as Lane) : d);
const medium = (v: unknown): Medium => (MEDIA.includes(v as Medium) ? (v as Medium) : 'email');
const mediumOrNull = (v: unknown): Medium | null => (MEDIA.includes(v as Medium) ? (v as Medium) : null);
const kind = (v: unknown): 'direct' | 'group' | 'self' => (v === 'group' || v === 'self' ? v : 'direct');
const direction = (v: unknown): 'in' | 'out' => (v === 'out' ? 'out' : 'in');

export function readContact(v: unknown): Contact | null {
  const o = obj(v);
  if (!o) return null;
  const ep = obj(o['endpoint']);
  return {
    contactId: str(o['contactId']),
    name: text(o['name'], 200),
    endpoint: { kind: text(ep?.['kind'], 20), value: text(ep?.['value'], 320) },
    known: bool(o['known']),
  };
}

export function readSender(v: unknown): Sender {
  const o = obj(v);
  if (!o) return null;
  if (o['me'] === true) return { me: true };
  const c = readContact(o);
  return c ? { me: false, ...c } : null;
}

function readLast(v: unknown): Last | null {
  const o = obj(v);
  const messageId = idOr(o?.['messageId']);
  if (!o || !messageId) return null;
  return {
    messageId,
    medium: medium(o['medium']),
    direction: direction(o['direction']),
    from: readSender(o['from']),
    subject: text(o['subject'], 300),
    snippet: text(o['snippet'], 300),
    at: num(o['at']),
    read: bool(o['read']),
    accountId: accountIdOr(o['accountId']),
    warned: bool(o['warned']),
  };
}

const contacts = (v: unknown): Contact[] => arr(v).map(readContact).filter((c): c is Contact => c !== null).slice(0, 50);

export function readRow(v: unknown): Row | null {
  const o = obj(v);
  const channelId = idOr(o?.['channelId']);
  if (!o || !channelId) return null;
  return {
    channelId,
    kind: kind(o['kind']),
    title: text(o['title'], 200),
    contacts: contacts(o['contacts']),
    lane: lane(o['lane']),
    lastAt: num(o['lastAt']),
    count: Math.max(0, num(o['count'])),
    unread: Math.max(0, num(o['unread'])),
    done: bool(o['done']),
    medium: mediumOrNull(o['medium']),
    last: readLast(o['last']),
  };
}

export function readList(v: unknown): { rows: Row[]; next: string | null } {
  const o = obj(v);
  return { rows: arr(o?.['rows']).map(readRow).filter((r): r is Row => r !== null), next: typeof o?.['next'] === 'string' ? (o['next'] as string) : null };
}

function readAuth(v: unknown): Auth | null {
  const o = obj(v);
  if (!o) return null;
  const confirmed = o['senderConfirmed'];
  return { spf: text(o['spf'], 20), dkim: text(o['dkim'], 20), dmarc: text(o['dmarc'], 20), senderConfirmed: typeof confirmed === 'boolean' ? confirmed : null, virus: o['virus'] === true };
}

function readAttachment(v: unknown): Attachment | null {
  const o = obj(v);
  if (!o) return null;
  const danger = DANGERS.includes(o['danger'] as Danger) ? (o['danger'] as Danger) : null;
  return { part: text(o['part'], 40), name: text(o['name'], 255) || 'attachment', type: text(o['type'], 120), bytes: Math.max(0, num(o['bytes'])), inline: bool(o['inline']), danger };
}

const STATUSES = ['received', 'queued', 'sending', 'sent', 'failed'] as const;

export function readMessage(v: unknown): Message | null {
  const o = obj(v);
  const messageId = idOr(o?.['messageId']);
  if (!o || !messageId) return null;
  const parse = obj(o['parse']);
  const attachments = arr(o['attachments']).map(readAttachment).filter((a): a is Attachment => a !== null).slice(0, 100);
  const status = STATUSES.includes(o['status'] as (typeof STATUSES)[number]) ? (o['status'] as Message['status']) : 'received';
  return {
    messageId,
    channelId: str(o['channelId']),
    threadId: str(o['threadId']),
    direction: direction(o['direction']),
    medium: medium(o['medium']),
    accountId: accountIdOr(o['accountId']),
    from: readSender(o['from']),
    at: num(o['at']),
    subject: text(o['subject'], 300),
    snippet: text(o['snippet'], 300),
    lane: lane(o['lane']),
    read: bool(o['read']),
    bulk: bool(o['bulk']),
    senderKnown: bool(o['senderKnown']),
    status,
    hasHtml: bool(o['hasHtml']),
    text: plain(str(o['text']), true),
    textMore: o['textMore'] === true || (typeof o['textNext'] === 'number' && o['textNext'] !== null),
    textNext: typeof o['textNext'] === 'number' ? (o['textNext'] as number) : null,
    parse: parse ? { state: text(parse['state'], 40), reason: text(parse['reason'], 80) } : null,
    auth: readAuth(o['auth']),
    attachmentCount: Math.max(attachments.length, num(o['attachmentCount'])),
    attachments,
    screen: o['screen'] === 'filter' ? 'filter' : null,
    warnings: readWarnings(o['warnings']),
  };
}

/** An ASCII domain as the desk gives it (a lookalike's, an `xn--` form): letters, digits, dots and hyphens only. */
const domainOr = (v: unknown): string => {
  const d = str(v).toLowerCase();
  return /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(d) ? d : '';
};

/** Sender warnings, field by field: one of an unknown kind, or with a field missing, isn't shown (at most 4). */
export function readWarnings(v: unknown): Warning[] {
  const out: Warning[] = [];
  for (const w of arr(v)) {
    const o = obj(w);
    if (!o || out.length === 4) continue;
    if (o['kind'] === 'not_usual_address') {
      const name = text(o['name'], 80).trim();
      if (name) out.push({ kind: 'not_usual_address', contactId: str(o['contactId']), name });
    } else if (o['kind'] === 'lookalike') {
      const domain = domainOr(o['domain']);
      const like = domainOr(o['like']);
      if (domain && like) out.push({ kind: 'lookalike', domain, like });
    } else if (o['kind'] === 'punycode') {
      const domain = domainOr(o['domain']);
      if (domain) out.push({ kind: 'punycode', domain });
    } else if (o['kind'] === 'name_held_address') {
      out.push({ kind: 'name_held_address' });
    }
  }
  return out;
}

/** `courier.attachment.save`'s answer. */
export function readSaved(v: unknown): Saved | null {
  const o = obj(v);
  const path = text(o?.['path'], 1024);
  if (!o || !path) return null;
  return { path, name: text(o['name'], 255), already: bool(o['already']) };
}

/**
 * A name to save a download under: one plain line, no folders, no leading dots, nothing a file system refuses, at most 120
 * characters with its extension kept. deskd cleans it too; the office never trusts it to.
 */
export function fileNameOf(v: unknown, fallback: string): string {
  // NFKC folds look-alike forms; the joiners and slash look-alikes Save to Files' names lose go here too (Security's CF-I2).
  let n = text(v, 400)
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\u2044\u2215\u2216\u2571\u29f8\u29f9\u2572\uff0f\uff3c]/g, '-')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .replace(/\s+/g, ' ');
  if (n.length > 120) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 13 ? n.slice(dot) : '';
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n || fallback;
}

const dangerOf = (v: unknown): Danger | null => DANGERS.find((d) => d === v) ?? null;

export function readDownloaded(v: unknown, fallback: string): Downloaded | null {
  const o = obj(v);
  if (!o || typeof o['size'] !== 'number') return null;
  return { name: fileNameOf(o['name'], fallback), size: num(o['size']), danger: dangerOf(o['danger']) };
}

export function readPreview(v: unknown, blob: Blob): Preview | null {
  const o = obj(v);
  const width = num(o?.['width']);
  const height = num(o?.['height']);
  if (!o || width <= 0 || height <= 0 || width > 100_000 || height > 100_000) return null;
  return { blob, width, height };
}

export function readArchive(v: unknown): Archive {
  const o = obj(v);
  const entries: Archive['entries'] = [];
  for (const e of arr(o?.['entries']).slice(0, 500)) {
    const x = obj(e);
    const name = text(x?.['name'], 300);
    if (!x || !name) continue;
    entries.push({ name, bytes: Math.max(0, num(x['bytes'])), dir: bool(x['dir']), encrypted: bool(x['encrypted']), danger: dangerOf(x['danger']) });
  }
  return { format: o?.['format'] === 'tar' ? 'tar' : 'zip', entries, total: Math.max(entries.length, num(o?.['total'])), truncated: bool(o?.['truncated']), danger: dangerOf(o?.['danger']) };
}

function readChannel(v: unknown): Channel | null {
  const o = obj(v);
  const channelId = idOr(o?.['channelId']);
  if (!o || !channelId) return null;
  return { channelId, kind: kind(o['kind']), title: text(o['title'], 200), contacts: contacts(o['contacts']) };
}

export function readThread(v: unknown): Thread | null {
  const o = obj(v);
  const channel = readChannel(o?.['channel']);
  if (!o || !channel) return null;
  return { channel, messages: arr(o['messages']).map(readMessage).filter((m): m is Message => m !== null), next: typeof o['next'] === 'string' ? (o['next'] as string) : null };
}

/** `courier.message.html`'s answer: the HTML string as the sandbox wrote it, for the frame alone. */
export function readHtml(v: unknown): { html: string; next: number | null } {
  const o = obj(v);
  return { html: str(o?.['html']), next: typeof o?.['next'] === 'number' ? (o['next'] as number) : null };
}

function readMatches(v: unknown, len: number): [number, number][] {
  const out: [number, number][] = [];
  for (const m of arr(v).slice(0, 50)) {
    if (!Array.isArray(m) || m.length !== 2) continue;
    const [a, b] = m as unknown[];
    if (typeof a === 'number' && typeof b === 'number' && a >= 0 && b > a && b <= len) out.push([a, b]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

export function readHit(v: unknown): Hit | null {
  const o = obj(v);
  const messageId = idOr(o?.['messageId']);
  const channelId = idOr(o?.['channelId']);
  if (!o || !messageId || !channelId) return null;
  // The ranges are the desk's, on its snippet: read on the raw string, so cleaning can't move them. A snippet that needed
  // cleaning loses its highlights rather than marking the wrong words.
  const raw = str(o['snippet']).slice(0, 400);
  const snippet = plain(raw);
  return {
    messageId,
    channelId,
    lane: lane(o['lane']),
    medium: medium(o['medium']),
    direction: direction(o['direction']),
    from: readSender(o['from']),
    subject: text(o['subject'], 300),
    snippet,
    matches: snippet === raw ? readMatches(o['matches'], snippet.length) : [],
    at: num(o['at']),
    read: bool(o['read']),
    accountId: accountIdOr(o['accountId']),
  };
}

export function readSearch(v: unknown): { hits: Hit[]; next: string | null } {
  const o = obj(v);
  return { hits: arr(o?.['hits']).map(readHit).filter((h): h is Hit => h !== null), next: typeof o?.['next'] === 'string' ? (o['next'] as string) : null };
}

export function readStatus(v: unknown): Status {
  const o = obj(v);
  const lanes = obj(o?.['lanes']);
  const state = o?.['state'] === 'on' || o?.['state'] === 'off' ? (o['state'] as 'on' | 'off') : 'unavailable';
  const counts = Object.fromEntries(
    LANES.map((l) => {
      const c = obj(lanes?.[l]);
      return [l, { count: Math.max(0, num(c?.['count'])), unread: Math.max(0, num(c?.['unread'])) }];
    }),
  ) as Status['lanes'];
  return {
    state,
    reason: typeof o?.['reason'] === 'string' ? text(o['reason'], 40) : null,
    lanes: counts,
    drafts: Math.max(0, num(o?.['drafts'])),
    waiting: Math.max(0, num(o?.['waiting'])),
    failed: Math.max(0, num(o?.['failed'])),
    pending: Math.max(0, num(o?.['pending'])),
    sending: bool(o?.['sending']),
  };
}

const ACCOUNT_KINDS: readonly AccountKind[] = ['desk', 'imap', 'jmap', 'ma', 'imessage'];

export function readAccounts(v: unknown): Account[] {
  const o = obj(v);
  const out: Account[] = [];
  for (const a of arr(o?.['accounts'])) {
    const x = obj(a);
    const accountId = accountIdOr(x?.['accountId']);
    if (!x || !accountId) continue;
    const k = ACCOUNT_KINDS.includes(x['kind'] as AccountKind) ? (x['kind'] as AccountKind) : null;
    if (!k) continue;
    out.push({
      accountId,
      kind: k,
      label: text(x['label'], 80),
      address: text(x['address'], 320),
      state: text(x['state'], 40),
      sending: bool(x['sending']),
      signedIn: typeof x['signedIn'] === 'boolean' ? (x['signedIn'] as boolean) : null,
      provider: ((p) => (typeof p === 'string' && /^[a-z]{1,16}$/.test(p) ? p : null))(obj(x['sync'])?.['provider']),
      ...(k === 'imessage' ? { mac: readMacSync(x['sync']) } : {}),
    });
  }
  return out;
}

/** A Mac account's `sync`: short words only, each checked; the desk never sends an address, a password or a key in it. */
export function readMacSync(v: unknown): MacSync | null {
  const o = obj(v);
  if (!o) return null;
  const word = (w: unknown): string | null => (typeof w === 'string' && /^[a-z_]{1,24}$/.test(w) ? w : null);
  const at = o['checkedAt'];
  const c = obj(o['device'])?.['check'];
  return { state: word(o['state']) ?? 'connecting', reason: word(o['reason']), path: word(o['path']) ?? 'bluebubbles', checkedAt: typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : null, check: typeof c === 'string' && /^\d{4} \d{4} \d{4}$/.test(c) ? c : null };
}

export function readBlocks(v: unknown): Block[] {
  const o = obj(v);
  const out: Block[] = [];
  for (const b of arr(o?.['blocks'])) {
    const x = obj(b);
    if (!x || (x['kind'] !== 'address' && x['kind'] !== 'domain')) continue;
    out.push({ kind: x['kind'], value: text(x['value'], 320) });
  }
  return out;
}

export function readDraft(v: unknown): Draft | null {
  const o = obj(v);
  const draftId = idOr(o?.['draftId']);
  if (!o || !draftId) return null;
  return {
    draftId,
    channelId: idOr(o['channelId']),
    medium: mediumOrNull(o['medium']),
    accountId: accountIdOr(o['accountId']),
    to: arr(o['to']).filter((t): t is string => typeof t === 'string').map((t) => plain(t).slice(0, 320)).slice(0, 50),
    subject: text(o['subject'], 300),
    text: plain(str(o['text']), true),
    version: num(o['version']),
    updatedAt: num(o['updatedAt']),
    replyTo: idOr(o['replyTo']),
  };
}

export function readDrafts(v: unknown): Draft[] {
  const o = obj(v);
  return arr(o?.['drafts']).map(readDraft).filter((d): d is Draft => d !== null);
}

export function readSent(v: unknown): Sent | null {
  const o = obj(v);
  const messageId = idOr(o?.['messageId']);
  const outboundId = idOr(o?.['outboundId']);
  return messageId && outboundId ? { messageId, outboundId, undoUntil: num(o?.['undoUntil']) } : null;
}

/** One `courier.changed` event (flattened by the link): ids and lanes only. */
export function readChanged(v: unknown): Changed {
  const o = obj(v);
  const chs = o?.['channels'];
  return {
    type: o?.['type'] === 'snapshot' ? 'snapshot' : 'changed',
    channels: Array.isArray(chs) ? chs.filter(isId) : null,
    lanes: arr(o?.['lanes']).filter((l): l is Lane => LANES.includes(l as Lane)),
    accounts: o?.['accounts'] === true,
    drafts: o?.['drafts'] === true,
    outbound: o?.['outbound'] === true,
  };
}

// ---------------------------------------------------------------- one person across channels, and the desk's keys

const SOURCES = ['mac', 'card', 'provider', 'signature', 'name'] as const;
const STRENGTHS = ['card', 'hint', 'name'] as const;
const EP_SOURCES = ['added', 'card', 'mac', 'provider', 'message'] as const;
/** A provider's name in a sentence ("Your iCloud contacts…"): a plain word, nothing else. */
const providerOr = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9 ._-]{1,30}$/.test(v) ? v : null);
const endpointOf = (v: unknown): Endpoint | null => {
  const o = obj(v);
  const kind = text(o?.['kind'], 20);
  const value = text(o?.['value'], 320);
  return kind && value ? { kind, value } : null;
};

export function readSuggestions(v: unknown): Suggestion[] {
  const out: Suggestion[] = [];
  for (const s of arr(obj(v)?.['suggestions'])) {
    const o = obj(s);
    const endpoint = endpointOf(o?.['endpoint']);
    const into = obj(o?.['into']);
    const source = SOURCES.find((x) => x === o?.['source']);
    const intoId = str(into?.['contactId']);
    const name = text(into?.['name'], 200).trim();
    // A suggestion names someone: one with no name, or of an unknown kind, isn't one.
    if (!o || !endpoint || !source || !intoId || !name) continue;
    out.push({
      endpoint,
      fromContactId: str(o['fromContactId']),
      channelId: idOr(o['channelId']),
      into: { contactId: intoId, name },
      source,
      provider: providerOr(o['provider']),
      strength: STRENGTHS.find((x) => x === o['strength']) ?? (source === 'name' ? 'name' : source === 'signature' ? 'hint' : 'card'),
    });
  }
  return out;
}

export function readPerson(v: unknown): Person | null {
  const o = obj(v);
  const contactId = str(o?.['contactId']);
  if (!o || !contactId) return null;
  const endpoints: PersonEndpoint[] = [];
  for (const e of arr(o['endpoints'])) {
    const ep = obj(e);
    const kv = endpointOf(ep);
    if (!ep || !kv) continue;
    endpoints.push({ ...kv, standing: text(ep['standing'], 20), source: EP_SOURCES.find((x) => x === ep['source']) ?? null, provider: providerOr(ep['provider']), lastInboundAt: typeof ep['lastInboundAt'] === 'number' ? ep['lastInboundAt'] : null });
  }
  return { contactId, name: text(o['name'], 200), named: bool(o['named']), endpoints };
}

export function readPeople(v: unknown): Person[] {
  return arr(obj(v)?.['contacts']).map(readPerson).filter((p): p is Person => p !== null);
}

export function readLookup(v: unknown): Lookup {
  const o = obj(v);
  const contactId = str(o?.['contactId']) || null;
  return { contactId, name: text(o?.['name'], 200), endpoints: num(o?.['endpoints'], contactId ? 1 : 0), messages: num(o?.['messages']) };
}

/** The contract's fingerprint: 32 lowercase hex characters in 8 groups of 4 (relay.md 0.4.0 §2.1). Anything else is none. */
const FINGERPRINT = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){7}$/;

export function readKeys(v: unknown): DeskKeys {
  const o = obj(v);
  const fp = str(o?.['fingerprint']).toLowerCase();
  // Not until the platform's key directory holds these keys (`published.current`): a link shared before then would fail
  // every Add as a mismatch (Security's CF-I1). A deskd that doesn't say counts as published.
  const published = obj(o?.['published']);
  const current = !published || published['current'] !== false;
  const available = bool(o?.['available']) && FINGERPRINT.test(fp) && current;
  return { available, fingerprint: available ? fp : null };
}

/** A safety number as deskd writes it: 60 digits in 12 groups of 5, spaced. */
export const SAFETY_NUMBER = /^\d{5}(?: \d{5}){11}$/;
const safetyOf = (v: unknown): string | null => (typeof v === 'string' && SAFETY_NUMBER.test(v) ? v : null);
const KEY_STATES = ['none', 'unverified', 'verified', 'changed'] as const;

/** `courier.contact.keys`: one row per member address of the contact. An address deskd didn't give in full is left out. */
export function readMemberKeys(v: unknown): MemberKey[] {
  const out: MemberKey[] = [];
  for (const k of arr(obj(v)?.['keys'])) {
    const o = obj(k);
    const address = str(o?.['address']).toLowerCase();
    const state = KEY_STATES.find((s) => s === o?.['state']);
    if (!o || !state || !/^[a-z0-9.-]{1,64}@[a-z0-9.-]{1,253}$/.test(address)) continue;
    const at = o['verifiedAt'];
    out.push({
      address,
      state,
      source: /^[a-z_]{1,20}$/.test(str(o['source'])) ? str(o['source']) : null,
      safetyNumber: safetyOf(o['safetyNumber']),
      verifiedAt: typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : null,
      newSafetyNumber: state === 'changed' ? safetyOf(o['newSafetyNumber']) : null,
      held: typeof o['held'] === 'number' && Number.isFinite(o['held']) ? Math.max(0, Math.min(10_000, Math.floor(o['held']))) : 0,
    });
  }
  return out.slice(0, 20);
}
