// Courier's adapter: the member's `courier.*` methods and the `courier.changed` topic over one desk's link, every reply read
// through `wire.ts`. The wire is deskd's API.md §21. The window talks only to this, so the mock desk (`desk/mockDeskCourier.ts`)
// and a real deskd are the same to it. Each mutation carries one `idem` across a retry of a lost reply (§4).
//
// A linked mailbox's sign-in (`addAccount`) is the one secret that passes through here. It goes once, in that call's params,
// and nothing here keeps it, logs it, retries it on another key or puts it in an error: a refusal carries deskd's code and
// reason only.
import type { DeskLink, DeskRpc } from '../../desk/deskLink';
import { readTransfer } from './bulk';
import type { Account, AccountInput, Archive, Block, Changed, DeskKeys, Downloaded, Draft, Endpoint, Hit, Lane, Lookup, Medium, MemberKey, Message, Person, Preview, Row, Saved, Sent, Status, Suggestion, Thread } from './types';
import { readArchive, readDownloaded, readPreview, readSaved, readAccounts, readBlocks, readChanged, readDraft, readDrafts, readHtml, readKeys, readList, readLookup, readMemberKeys, readMessage, readPeople, readPerson, readSearch, readSent, readStatus, readSuggestions, readThread, SAFETY_NUMBER } from './wire';

/**
 * What the desk refused. `code` is deskd's (`bad_request`, `not_found`, `forbidden`, `conflict`, `unavailable`), with two the
 * window says apart: `offline` (no session) and `old` (a deskd before §21: `not_found` with no reason).
 */
export class CourierError extends Error {
  readonly code: string;
  readonly reason: string | null;
  readonly provider: string | null;
  /** An invite's refusal: whether this desk already pinned a key for the address (`pinned`). */
  readonly pinned: boolean;
  /** A key that changed since the member checked it: the new safety number to compare (`newSafetyNumber`). */
  readonly newSafetyNumber: string | null;
  constructor(code: string, reason: string | null = null, provider: string | null = null, extra: { pinned?: boolean; newSafetyNumber?: string | null } = {}) {
    super(`courier ${code}${reason ? ` ${reason}` : ''}`);
    this.name = 'CourierError';
    this.code = code;
    this.reason = reason;
    this.provider = provider;
    this.pinned = extra.pinned === true;
    this.newSafetyNumber = extra.newSafetyNumber ?? null;
  }
}

export function toCourierError(e: unknown): CourierError {
  if (e instanceof CourierError) return e;
  const o = e as { code?: unknown; details?: unknown; name?: unknown } | null;
  if (o && o.name === 'DeskNotConnected') return new CourierError('offline');
  const raw = typeof o?.code === 'string' ? o.code : 'internal';
  const details = o?.details && typeof o.details === 'object' ? (o.details as Record<string, unknown>) : {};
  const reason = typeof details['reason'] === 'string' ? (details['reason'] as string).slice(0, 40) : null;
  // A provider's own word (`forbidden` `{reason: sign_in, provider}`), kept to a plain word: it goes into a sentence.
  const provider = typeof details['provider'] === 'string' && /^[A-Za-z0-9 ._-]{1,40}$/.test(details['provider'] as string) ? (details['provider'] as string) : null;
  const newSafetyNumber = typeof details['newSafetyNumber'] === 'string' && SAFETY_NUMBER.test(details['newSafetyNumber']) ? details['newSafetyNumber'] : null;
  return new CourierError(raw === 'not_found' && reason === null ? 'old' : raw, reason, provider, { pinned: details['pinned'] === true, newSafetyNumber });
}

/** A desk that doesn't know a method yet: deskd's own `not_found` with nothing more (`old`), or one that names the method. */
export const unsupported = (e: unknown): boolean => {
  const err = toCourierError(e);
  return err.code === 'old' || (err.code === 'not_found' && err.reason === 'method');
};

/** A link made: `linkId` undoes it exactly, or is null where the desk can only merge two people (no Undo then). */
export interface Linked {
  linkId: string | null;
  channelId: string | null;
}

/** An invite's Add, done: `checked` when the link's fingerprint checked the key; `released` held messages came in. */
export interface Added {
  contactId: string;
  channelId: string | null;
  checked: boolean;
  released: number;
}

export interface ListQuery {
  lane: Lane;
  accountId?: string | null;
  before?: string | null;
  limit?: number;
}

export interface SearchQuery {
  q: string;
  lane?: Lane | null;
  before?: string | null;
  /** The member's IANA zone, for `before:` and `after:`. */
  zone?: string | null;
}

export interface DraftInput {
  draftId?: string | null;
  channelId?: string | null;
  medium?: Medium | null;
  accountId?: string | null;
  to?: string[];
  subject?: string;
  text: string;
  replyTo?: string | null;
  baseVersion?: number | null;
}

export interface CourierClient {
  readonly deskId: string;
  status(): Promise<Status>;
  list(q: ListQuery): Promise<{ rows: Row[]; next: string | null }>;
  thread(channelId: string, lane?: Lane | null, before?: string | null): Promise<Thread | null>;
  message(messageId: string, from?: number): Promise<Message | null>;
  /** The sandbox's sanitized HTML, every slice joined (a message's HTML is capped by the parser). Only for the frame. */
  html(messageId: string): Promise<string | null>;
  search(q: SearchQuery): Promise<{ hits: Hit[]; next: string | null }>;
  accounts(): Promise<Account[]>;
  blocks(): Promise<Block[]>;
  drafts(): Promise<Draft[]>;
  draft(draftId: string): Promise<Draft | null>;
  setRead(channelId: string, lane: Lane, read: boolean): Promise<void>;
  setMessagesRead(messageIds: string[], read: boolean): Promise<void>;
  move(channelId: string, lane: Lane, to: Lane | 'restore'): Promise<void>;
  moveMessages(messageIds: string[], to: Lane | 'restore'): Promise<void>;
  done(channelId: string, lane: Lane, done: boolean): Promise<void>;
  decide(channelId: string, decision: 'let_in' | 'not_now' | 'block'): Promise<void>;
  block(kind: 'address' | 'domain', value: string): Promise<number>;
  unblock(kind: 'address' | 'domain', value: string): Promise<void>;
  remove(messageIds: string[], forever?: boolean): Promise<number>;
  emptyTrash(): Promise<number>;
  saveDraft(d: DraftInput): Promise<{ draftId: string; version: number }>;
  discardDraft(draftId: string): Promise<void>;
  send(draftId: string): Promise<Sent>;
  undoSend(outboundId: string): Promise<string | null>;
  renameContact(contactId: string, name: string): Promise<void>;
  /** A linked mailbox, write-only: the secret goes once and is never sent back. */
  addAccount(input: AccountInput): Promise<string>;
  removeAccount(accountId: string, keepMail: boolean): Promise<void>;
  /**
   * MA Connector for Mac: the code the Mac shows, claimed by this desk (`courier.imsg.pair`). The answer is the new account and
   * the Mac's key's first groups, which the Mac shows too.
   */
  pairMac(code: string): Promise<{ accountId: string; fingerprint: string; check: string }>;
  /** The desk's own keys, public facts only: the fingerprint an invite link carries. Unavailable on a desk without keys. */
  keys(): Promise<DeskKeys>;
  /** A person and every way to reach them. */
  person(contactId: string): Promise<Person | null>;
  /** People, for "Link to someone…"'s search. */
  people(q: string): Promise<Person[]>;
  /** "Is this also …?": for one endpoint, or every open one. Null where the desk doesn't make suggestions yet. */
  suggestions(endpoint?: Endpoint | null): Promise<Suggestion[] | null>;
  /**
   * Links an endpoint, or a whole person (`from`), onto `into`. Only ever on the member's press, and never a merge in its
   * place: a desk that doesn't know `courier.links.link` refuses (`old`), and nothing joins.
   */
  link(p: { into: string; from?: string | null; endpoint?: Endpoint | null }): Promise<Linked>;
  undoLink(linkId: string): Promise<void>;
  /** The endpoint goes back to a person of its own, its messages with it. */
  unlink(endpoint: Endpoint): Promise<{ contactId: string; channelId: string | null }>;
  /** "Not {first name}": remembered for that pair, never asked again. */
  dismiss(endpoint: Endpoint, into: string): Promise<void>;
  /** What a typed email or number already is on this desk. Null where the desk can't say. */
  lookup(endpoint: Endpoint): Promise<Lookup | null>;
  /**
   * An invite link's Add: the member address by its registry name, with the link's fingerprint. The desk looks its keys up and
   * pins them only if they match (Wave 2.5's `courier.contacts.add`). Refused `conflict` `{reason: fingerprint, pinned}` when
   * they don't, and `{reason: key_changed, newSafetyNumber}` when a key the member checked changed (the error carries both).
   */
  addMember(p: { name: string; fingerprint: string | null; displayName: string }): Promise<Added>;
  /** Each member address of a contact as this desk pinned it (`courier.contact.keys`). Empty where the desk can't say. */
  memberKeys(contactId: string): Promise<MemberKey[]>;
  /**
   * The member compared the safety number (`courier.contact.verify`): the pinned key's marks it checked; a changed key's new
   * one pins it, and its held messages come in. `conflict` `{reason: safety_number}` for any other number.
   */
  verifyKey(address: string, safetyNumber: string): Promise<{ released: number }>;
  /** "Report spam" (Wave 3.2): to Spam, the filter taught; with `block`, each sender blocked too (never a known contact on unconfirmed mail). */
  report(messageIds: string[], block?: boolean): Promise<number>;
  /** "Save to Files" (Wave 3.1): a dangerous type only with `allowDanger`, the member's second press. */
  saveAttachment(messageId: string, part: string, allowDanger: boolean): Promise<Saved>;
  /**
   * "Download" (Wave 3.1): the part's bytes on the desk's own `bulk`, each piece through `write` as it arrives, checked end to
   * end against the desk's SHA-256 before it resolves. A dangerous type only with `allowDanger`, the member's second press.
   */
  download(messageId: string, part: string, allowDanger: boolean, write: (bytes: Uint8Array) => Promise<void>, signal?: AbortSignal): Promise<Downloaded>;
  /** "Show": an image attachment redrawn in the sandbox from its pixels (PNG or JPEG, no metadata), as a picture. */
  preview(messageId: string, part: string, signal?: AbortSignal): Promise<Preview>;
  /** An archive's file list, read on the desk without unpacking it. */
  archive(messageId: string, part: string): Promise<Archive>;
  /** The message exactly as it came, as a `.eml`, on `bulk`: what a message that couldn't be read safely offers. */
  downloadRaw(messageId: string, allowDanger: boolean, write: (bytes: Uint8Array) => Promise<void>, signal?: AbortSignal): Promise<Downloaded>;
  /** Something changed on this desk: ids and lanes only. A refusal (an older deskd) is said once. */
  watch(fn: (c: Changed) => void, onRefused?: (code: string) => void): () => void;
}

type Call = <M extends keyof DeskRpc>(method: M, params?: Record<string, unknown>, options?: { idem?: string; deadlineMs?: number }) => Promise<DeskRpc[M]>;

/** A lost reply is asked again with the same key, three tries; a refusal is final. */
export async function mutate<T>(call: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let n = 0; n < tries; n += 1) {
    try {
      return await call();
    } catch (e) {
      last = e;
      const code = (e as { code?: unknown } | null)?.code;
      const lost = code === 'deadline_exceeded' || code === 'cancelled' || (code === 'unavailable' && !(e as { details?: { mayHaveApplied?: boolean; reason?: unknown } }).details?.mayHaveApplied && !(e as { details?: { reason?: unknown } }).details?.reason);
      if (!lost) break;
    }
  }
  throw toCourierError(last);
}

const HTML_SLICES = 40;

export function rpcCourierClient(link: DeskLink, idem: () => string): CourierClient {
  const call: Call = (m, p, o) => link.call(m, p, o);
  const read = async <T>(method: keyof DeskRpc, params: Record<string, unknown>, shape: (v: unknown) => T): Promise<T> => {
    try {
      return shape(await call(method, params));
    } catch (e) {
      throw toCourierError(e);
    }
  };
  const write = (method: keyof DeskRpc, params: Record<string, unknown>): Promise<unknown> => {
    const key = idem();
    return mutate(() => call(method, params, { idem: key }));
  };
  const n = (v: unknown, k: string): number => {
    const x = (v as Record<string, unknown> | null)?.[k];
    return typeof x === 'number' ? x : 0;
  };
  /** Ends one of this session's transfers on the desk (Cancel, a closed preview, a broken one): its staged copy goes at once. */
  const stop = (transferId: number): Promise<unknown> => call('courier.attachment.stop', { transferId }).catch(() => undefined);
  return {
    deskId: link.deskId,
    status: () => read('courier.status', {}, readStatus),
    list: (q) => read('courier.list', { lane: q.lane, ...(q.accountId ? { accountId: q.accountId } : {}), ...(q.before ? { before: q.before } : {}), limit: q.limit ?? 50 }, readList),
    thread: (channelId, lane, before) => read('courier.thread', { channelId, ...(lane ? { lane } : {}), ...(before ? { before } : {}), limit: 30 }, readThread),
    message: (messageId, from) => read('courier.message', { messageId, ...(from ? { from } : {}) }, readMessage),
    async html(messageId) {
      let out = '';
      let from: number | null = 0;
      try {
        for (let i = 0; from !== null && i < HTML_SLICES; i += 1) {
          const part = readHtml(await call('courier.message.html', { messageId, ...(from ? { from } : {}) }));
          out += part.html;
          from = part.next;
        }
      } catch (e) {
        const err = toCourierError(e);
        if (err.code === 'not_found' || err.code === 'old') return null;
        throw err;
      }
      return out;
    },
    search: (q) => read('courier.search', { q: q.q, ...(q.lane ? { lane: q.lane } : {}), ...(q.before ? { before: q.before } : {}), ...(q.zone ? { zone: q.zone } : {}), limit: 50 }, readSearch),
    accounts: () => read('courier.accounts.list', {}, readAccounts),
    blocks: () => read('courier.blocks.list', {}, readBlocks),
    drafts: () => read('courier.drafts.list', {}, readDrafts),
    draft: (draftId) => read('courier.draft.get', { draftId }, readDraft),
    setRead: async (channelId, lane, r) => void (await write('courier.read.set', { channelId, lane, read: r })),
    setMessagesRead: async (messageIds, r) => void (await write('courier.read.set', { messageIds, read: r })),
    move: async (channelId, lane, to) => void (await write('courier.move', { channelId, lane, to })),
    moveMessages: async (messageIds, to) => void (await write('courier.move', { messageIds, to })),
    done: async (channelId, lane, d) => void (await write('courier.done', { channelId, lane, done: d })),
    decide: async (channelId, decision) => void (await write('courier.request.decide', { channelId, decision })),
    block: async (kind, value) => n(await write('courier.block', { kind, value }), 'senders'),
    unblock: async (kind, value) => void (await write('courier.unblock', { kind, value })),
    remove: async (messageIds, forever) => n(await write('courier.delete', { messageIds, ...(forever ? { forever: true } : {}) }), 'deleted'),
    emptyTrash: async () => n(await write('courier.trash.empty', {}), 'deleted'),
    async saveDraft(d) {
      const params: Record<string, unknown> = { text: d.text };
      if (d.draftId) params['draftId'] = d.draftId;
      if (d.channelId) params['channelId'] = d.channelId;
      if (d.medium) params['medium'] = d.medium;
      if (d.accountId) params['accountId'] = d.accountId;
      if (d.to && d.to.length) params['to'] = d.to;
      if (d.subject !== undefined) params['subject'] = d.subject;
      if (d.replyTo) params['replyTo'] = d.replyTo;
      if (typeof d.baseVersion === 'number') params['baseVersion'] = d.baseVersion;
      const r = (await write('courier.draft.save', params)) as Record<string, unknown> | null;
      if (typeof r?.['draftId'] !== 'string') throw new CourierError('internal');
      return { draftId: r['draftId'] as string, version: n(r, 'version') };
    },
    discardDraft: async (draftId) => void (await write('courier.draft.discard', { draftId })),
    async send(draftId) {
      const sent = readSent(await write('courier.send', { draftId }));
      if (!sent) throw new CourierError('internal');
      return sent;
    },
    async undoSend(outboundId) {
      const r = (await write('courier.send.undo', { outboundId })) as Record<string, unknown> | null;
      return typeof r?.['draftId'] === 'string' ? (r['draftId'] as string) : null;
    },
    renameContact: async (contactId, name) => void (await write('courier.contact.rename', { contactId, name })),
    async addAccount(input) {
      // One key, one try for the lost-reply case only: the transport checks the secret with the provider, so a second try on
      // the same key just reads the first answer back (§4), and a new key is the member's own press.
      const params: Record<string, unknown> = { kind: 'imap', address: input.address, auth: input.auth, secret: input.secret };
      if (input.username) params['username'] = input.username;
      if (input.label) params['label'] = input.label;
      if (input.provider) params['provider'] = input.provider;
      if (input.server) params['server'] = input.server;
      const key = idem();
      const r = (await mutate(() => call('courier.accounts.add', params, { idem: key, deadlineMs: 60_000 }), 2)) as Record<string, unknown> | null;
      if (typeof r?.['accountId'] !== 'string') throw new CourierError('internal');
      return r['accountId'] as string;
    },
    removeAccount: async (accountId, keepMail) => void (await write('courier.accounts.remove', { accountId, keepMail })),
    async pairMac(code) {
      // One key: a second try after a lost answer reads the first answer back, and a code is claimed once.
      const key = idem();
      const r = (await mutate(() => call('courier.imsg.pair', { code }, { idem: key, deadlineMs: 30_000 }), 2)) as Record<string, unknown> | null;
      const accountId = typeof r?.['accountId'] === 'string' ? (r['accountId'] as string) : '';
      const fp = typeof r?.['fingerprint'] === 'string' && /^[0-9a-f]{4}-[0-9a-f]{4}$/.test(r['fingerprint'] as string) ? (r['fingerprint'] as string) : '';
      const check = typeof r?.['check'] === 'string' && /^\d{4} \d{4} \d{4}$/.test(r['check'] as string) ? (r['check'] as string) : '';
      if (!accountId) throw new CourierError('internal');
      return { accountId, fingerprint: fp, check };
    },
    keys: async () => {
      try {
        return readKeys(await call('courier.keys', {}));
      } catch {
        return { available: false, fingerprint: null };
      }
    },
    person: (contactId) => read('courier.contact.get', { contactId }, readPerson),
    people: (q) => read('courier.contacts.list', { ...(q.trim() ? { q: q.trim().slice(0, 100) } : {}), limit: 50 }, readPeople),
    async suggestions(endpoint) {
      try {
        return readSuggestions(await call('courier.links.suggest', endpoint ? { endpoint } : {}));
      } catch (e) {
        if (unsupported(e)) return null;
        throw toCourierError(e);
      }
    },
    async link({ into, from, endpoint }) {
      // Never a silent merge: a deskd before links refuses, and the window says it needs an update; nothing joins.
      const r = (await write('courier.links.link', { into, ...(from ? { from } : {}), ...(endpoint ? { endpoint } : {}) })) as Record<string, unknown> | null;
      const linkId = typeof r?.['linkId'] === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(r['linkId']) ? r['linkId'] : null;
      const channelId = typeof r?.['channelId'] === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(r['channelId']) ? r['channelId'] : null;
      return { linkId, channelId };
    },
    undoLink: async (linkId) => void (await write('courier.links.undo', { linkId })),
    async unlink(endpoint) {
      const r = (await write('courier.links.unlink', { endpoint })) as Record<string, unknown> | null;
      const channelId = typeof r?.['channelId'] === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(r['channelId']) ? r['channelId'] : null;
      return { contactId: typeof r?.['contactId'] === 'string' ? r['contactId'] : '', channelId };
    },
    dismiss: async (endpoint, into) => void (await write('courier.links.dismiss', { endpoint, into })),
    async lookup(endpoint) {
      try {
        return readLookup(await call('courier.links.lookup', { endpoint }));
      } catch (e) {
        if (unsupported(e)) return null;
        throw toCourierError(e);
      }
    },
    report: async (messageIds, block) => n(await write('courier.report', { messageIds, ...(block ? { block: true } : {}) }), 'reported'),
    async saveAttachment(messageId, part, allowDanger) {
      let zone: string | null = null;
      try {
        zone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
      } catch {
        zone = null;
      }
      const r = readSaved(await write('courier.attachment.save', { messageId, part, ...(allowDanger ? { allowDanger: true } : {}), ...(zone ? { zone } : {}) }));
      if (!r) throw new CourierError('internal');
      return r;
    },
    async download(messageId, part, allowDanger, put, signal) {
      try {
        const head = await readTransfer(link, () => call('courier.attachment.read', { messageId, part, ...(allowDanger ? { allowDanger: true } : {}) }, { deadlineMs: 120_000 }), stop, put, { signal });
        const d = readDownloaded(head.reply, `${part}.bin`);
        if (!d) throw new CourierError('internal');
        return d;
      } catch (e) {
        throw toCourierError(e);
      }
    },
    async preview(messageId, part, signal) {
      try {
        const parts: Uint8Array[] = [];
        const head = await readTransfer(link, () => call('courier.attachment.image', { messageId, part }, { deadlineMs: 120_000 }), stop, async (b) => void parts.push(b), { signal });
        // Only the two formats the sandbox draws; the picture's type is ours from that word, never the sender's claim (ADR 0054).
        const type = head.reply['format'] === 'jpeg' ? 'image/jpeg' : 'image/png';
        const p = readPreview(head.reply, new Blob(parts as BlobPart[], { type }));
        if (!p) throw new CourierError('internal');
        return p;
      } catch (e) {
        throw toCourierError(e);
      }
    },
    archive: (messageId, part) => read('courier.attachment.archive', { messageId, part }, readArchive),
    async downloadRaw(messageId, allowDanger, put, signal) {
      let zone: string | null = null;
      try {
        zone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
      } catch {
        zone = null;
      }
      try {
        const head = await readTransfer(link, () => call('courier.message.raw', { messageId, ...(allowDanger ? { allowDanger: true } : {}), ...(zone ? { zone } : {}) }, { deadlineMs: 120_000 }), stop, put, { signal });
        const d = readDownloaded(head.reply, 'message.eml');
        if (!d) throw new CourierError('internal');
        return d;
      } catch (e) {
        throw toCourierError(e);
      }
    },
    async addMember({ name, fingerprint, displayName }) {
      const r = (await write('courier.contacts.add', { name, ...(fingerprint ? { fingerprint } : {}), ...(displayName ? { displayName } : {}) })) as Record<string, unknown> | null;
      const channelId = typeof r?.['channelId'] === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(r['channelId']) ? r['channelId'] : null;
      const released = typeof r?.['released'] === 'number' && Number.isFinite(r['released']) ? Math.max(0, Math.floor(r['released'])) : 0;
      return { contactId: typeof r?.['contactId'] === 'string' ? r['contactId'] : '', channelId, checked: r?.['checked'] === 'invite', released };
    },
    async memberKeys(contactId) {
      try {
        return await read('courier.contact.keys', { contactId }, readMemberKeys);
      } catch (e) {
        if (unsupported(e)) return [];
        throw e;
      }
    },
    async verifyKey(address, safetyNumber) {
      const r = (await write('courier.contact.verify', { address, safetyNumber })) as Record<string, unknown> | null;
      return { released: typeof r?.['released'] === 'number' && Number.isFinite(r['released']) ? Math.max(0, Math.floor(r['released'])) : 0 };
    },
    watch(fn, onRefused) {
      return link.subscribe('courier.changed', (msg) => fn(readChanged(msg)), onRefused);
    },
  };
}
