// Dev and test only, through mockDeskLink.ts (never in a production bundle). One desk's Courier store held in memory and served
// as deskd serves the member's `courier.*` methods and the `courier.changed` topic (services/deskd/docs/API.md §21): lanes,
// channels, contacts, the message shape with its sanitized HTML (as `desk-parse`'s Courier mode writes it: links with no
// `href`, only `data-ma-*`), search with its operators, Requests, blocks, Done, Trash, drafts, the outbound queue with Undo, and
// linked mailboxes (write-only: a sign-in is checked, never kept, and never in the call log). It has no knowledge of the app: the
// app is tested against it, and it against §21.

import type { MockBulk } from './mockDeskData';

export const refusal = (code: string, details: Record<string, unknown> = {}): Error => Object.assign(new Error(`mock ${code}`), { code, details });

type Lane = 'people' | 'requests' | 'updates' | 'other' | 'spam' | 'trash';
type Medium = 'email' | 'ma' | 'imessage' | 'sms';
const LANES: Lane[] = ['people', 'requests', 'updates', 'other', 'spam', 'trash'];
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let serial = 0;
/** A ULID: 10 characters of time, 16 of a counter (deterministic within a page load). */
export function ulid(at = Date.now()): string {
  let t = at;
  let time = '';
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  serial += 1;
  let n = serial;
  let rest = '';
  for (let i = 0; i < 16; i += 1) {
    rest = CROCKFORD[n % 32] + rest;
    n = Math.floor(n / 32);
  }
  return time + rest;
}

interface Endpoint {
  id: string;
  contactId: string;
  kind: 'email' | 'ma' | 'phone' | 'apple';
  value: string;
  standing: 'known' | 'unknown' | 'blocked';
  /** Where it came from, for the person view: you added it, a contact card, the Mac's contacts, a provider's, a message. */
  source?: 'added' | 'card' | 'mac' | 'provider' | 'message';
}
interface SuggestRec {
  ep: string;
  into: string;
  source: 'mac' | 'card' | 'provider' | 'signature' | 'name';
  provider: string | null;
  strength: 'card' | 'hint' | 'name';
}
interface LinkRec {
  into: string;
  from: string;
  fromName: string;
  eps: string[];
  /** Messages that moved, and the channel they came from. */
  moved: string[];
  fromChannel: string | null;
}
interface Contact {
  contactId: string;
  name: string;
}
interface ChannelRec {
  channelId: string;
  kind: 'direct' | 'group' | 'self';
  title: string | null;
  members: string[];
}
interface Att {
  part: string;
  name: string;
  type: string;
  bytes: number;
  contentId: string | null;
  inline: boolean;
  danger: string | null;
}
interface Msg {
  messageId: string;
  channelId: string;
  threadId: string;
  direction: 'in' | 'out';
  medium: Medium;
  accountId: string | null;
  from: string | null;
  /** The endpoint it came from or went to, so a link or an unlink knows which messages go with an endpoint. */
  via: string | null;
  at: number;
  subject: string;
  text: string;
  html: string | null;
  lane: Lane;
  wasLane: Lane | null;
  read: boolean;
  bulk: boolean;
  status: 'received' | 'queued' | 'sending' | 'sent' | 'failed';
  dmarc: string | null;
  parse: { state: string; reason: string } | null;
  attachments: Att[];
  /** Wave 3.2: the learning filter's Spam, and the sender warnings made as it arrived. */
  screen?: 'filter' | null;
  warnings?: Record<string, unknown>[];
}
interface AccountRec {
  accountId: string;
  kind: 'desk' | 'imap' | 'jmap' | 'ma' | 'imessage';
  label: string;
  address: string;
  state: string;
  sending: boolean;
  signedIn: boolean | null;
  /** The Mac's account: its path's state, as deskd's `sync` (API.md §21). */
  sync?: { state: string; reason: string | null; path: string; checkedAt: number | null; device?: { check: string } };
}
interface DraftRec {
  draftId: string;
  channelId: string | null;
  medium: Medium | null;
  accountId: string | null;
  to: string[];
  subject: string;
  text: string;
  replyTo: string | null;
  version: number;
  updatedAt: number;
}
interface OutRec {
  outboundId: string;
  messageId: string;
  draft: DraftRec;
  undoUntil: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface MockCourierControl {
  /** Every method asked, in order. A sign-in's `secret` is never here: it reads `[sealed]`. */
  calls: { m: string; p: Record<string, unknown>; idem?: string }[];
  /** Transfers started on `bulk` (Download, "Show", a raw message), with their sizes. */
  transfers: { m: string; size: number }[];
  /** Every call of this method refuses with this code (and reason) until it is deleted. */
  refuse: Record<string, string | { code: string; details?: Record<string, unknown> }>;
  /** Whether a transport can check a linked mailbox (Wave 2.1): false answers `unavailable` `{reason: medium}` as deskd does before it. */
  imap: boolean;
  /** Replies wait this long. */
  delayMs: number;
  /** How many sign-ins were checked (their secrets are never kept). */
  signInsChecked: number;
}

type Listener = (msg: { type: string; channels: string[] | null; lanes: Lane[]; counts: boolean; drafts: boolean; outbound: boolean; accounts: boolean }) => void;

const domainOf = (v: string): string => v.slice(v.lastIndexOf('@') + 1).toLowerCase();

/** A member address as this desk pinned it (Wave 2.5's relay state, played): its numbers and what a changed key holds. */
interface PinRec {
  state: 'unverified' | 'verified' | 'changed';
  source: string;
  number: string;
  verifiedAt: number | null;
  newNumber: string | null;
  held: { text: string; at: number }[];
}

/** A safety number the mock makes up for an address: 60 digits in 12 groups of 5, the same every time. */
export function mockSafetyNumber(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  let out = '';
  for (let i = 0; out.length < 60; i += 1) {
    h = Math.imul(h ^ (i + 1), 16777619) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    out += String(h % 100000).padStart(5, '0');
  }
  return out.slice(0, 60).replace(/(\d{5})(?=\d)/g, '$1 ');
}
const READS = ['courier.status', 'courier.list', 'courier.attention', 'courier.thread', 'courier.message', 'courier.message.html', 'courier.search', 'courier.contacts.list', 'courier.contact.get', 'courier.drafts.list', 'courier.draft.get', 'courier.outbound.list', 'courier.accounts.list', 'courier.blocks.list', 'courier.keys', 'courier.links.suggest', 'courier.links.lookup', 'courier.contact.keys', 'courier.attachment.read', 'courier.attachment.image', 'courier.attachment.archive', 'courier.message.raw', 'courier.attachment.stop'];
/** deskd's links methods (API.md §21); `__maCourierMockInit.links: false` plays a deskd without them. */
export const LINK_METHODS = ['courier.links.suggest', 'courier.links.link', 'courier.links.undo', 'courier.links.unlink', 'courier.links.dismiss', 'courier.links.lookup'];
/** An account's id, as deskd makes them: its kind, a dash, 20 hex characters. */
let accountSerial = 0;
const accountId = (kind: string): string => `${kind}-${(0xc0de00 + (accountSerial += 1)).toString(16).padStart(20, '0')}`;
const isUlid = (v: unknown): v is string => typeof v === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(v);

/** A 1 x 1 picture the sandbox drew again (an inline `cid:` image), as its only `src` can be; neutral grey, since no UI shows green, brown or a warm tint. */
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mPonjznPwAGIQK6H/A4RgAAAABJRU5ErkJggg==';

export class MockCourierDesk {
  readonly control: MockCourierControl = { calls: [], refuse: {}, imap: true, delayMs: 0, signInsChecked: 0, transfers: [] };
  readonly deskId: string;
  private readonly contacts = new Map<string, Contact>();
  private readonly endpoints = new Map<string, Endpoint>();
  private readonly channels = new Map<string, ChannelRec>();
  private readonly messages = new Map<string, Msg>();
  private readonly accounts = new Map<string, AccountRec>();
  private readonly drafts = new Map<string, DraftRec>();
  private readonly outbound = new Map<string, OutRec>();
  private readonly blocks: { kind: 'address' | 'domain'; value: string }[] = [];
  private readonly doneAt = new Map<string, number>();
  private readonly idems = new Map<string, { key: string; result: unknown }>();
  private readonly listeners = new Set<Listener>();
  private readonly suggested: SuggestRec[] = [];
  /** What Save to Files wrote: `${messageId}|${part}` to its path in Files. */
  private readonly savedFiles = new Map<string, string>();
  /** "Not them", remembered per pair: `${endpointId}|${contactId}`. */
  private readonly dismissed = new Set<string>();
  private readonly linksMade = new Map<string, LinkRec>();
  /** Member addresses' pins, by address. */
  readonly pins = new Map<string, PinRec>();
  /** The desk's keys (`courier.keys`): the contract's fingerprint. `fingerprint` null plays a desk without `/data/keys`. */
  fingerprint: string | null = '3f2a-91c0-7d4e-b815-0a6c-e2f9-5b37-c41d';
  private pendingEvent: { channels: Set<string>; lanes: Set<Lane>; drafts: boolean; outbound: boolean; accounts: boolean } | null = null;
  /** The switch: `on`, or a reason `courier.status` gives (`store`, `switched_off`). */
  state: 'on' | 'store' | 'switched_off' = 'on';
  deskAccountId = '';
  gmailAccountId = '';

  constructor(deskId: string) {
    this.deskId = deskId;
  }

  // ---------------------------------------------------------------- seeding

  private contact(name: string, kind: Endpoint['kind'], value: string, standing: Endpoint['standing'] = 'known'): string {
    const contactId = ulid();
    this.contacts.set(contactId, { contactId, name });
    const id = ulid();
    this.endpoints.set(id, { id, contactId, kind, value, standing });
    return id;
  }

  private channel(members: string[], kind: ChannelRec['kind'] = 'direct', title: string | null = null): string {
    const channelId = ulid();
    this.channels.set(channelId, { channelId, kind, title, members });
    return channelId;
  }

  /** A message into a channel, as a transport's `accept` would store it. Returns its id. */
  add(p: { channelId: string; from: string | null; medium?: Medium; subject?: string; text: string; html?: string | null; lane?: Lane; at: number; read?: boolean; bulk?: boolean; dmarc?: string | null; attachments?: Att[]; accountId?: string | null; parse?: { state: string; reason: string } | null; threadId?: string }): string {
    const messageId = ulid(p.at);
    const medium = p.medium ?? 'email';
    this.messages.set(messageId, {
      messageId,
      channelId: p.channelId,
      threadId: p.threadId ?? (medium === 'email' ? `t-${p.channelId}-${p.subject?.replace(/^re:\s*/i, '') ?? ''}` : ''),
      direction: p.from === null ? 'out' : 'in',
      medium,
      accountId: p.accountId === undefined ? (medium === 'email' ? this.gmailAccountId : null) : p.accountId,
      from: p.from,
      via: p.from ?? this.channels.get(p.channelId)?.members[0] ?? null,
      at: p.at,
      subject: p.subject ?? '',
      text: p.text,
      html: p.html ?? null,
      lane: p.lane ?? 'people',
      wasLane: null,
      read: p.read ?? p.from === null,
      bulk: p.bulk ?? false,
      status: p.from === null ? 'sent' : 'received',
      dmarc: medium === 'email' && p.from !== null ? (p.dmarc === undefined ? 'pass' : p.dmarc) : null,
      parse: p.parse ?? null,
      attachments: p.attachments ?? [],
    });
    return messageId;
  }

  seed(kind: 'personal' | 'other'): void {
    const now = Date.now();
    this.deskAccountId = accountId('desk');
    this.accounts.set(this.deskAccountId, { accountId: this.deskAccountId, kind: 'desk', label: "This desk's address", address: kind === 'personal' ? 'river.lantern@courier.example' : 'work.harbor@courier.example', state: 'receiving', sending: false, signedIn: null });
    this.gmailAccountId = accountId('imap');
    this.accounts.set(this.gmailAccountId, { accountId: this.gmailAccountId, kind: 'imap', label: 'Gmail', address: 'river.lantern@gmail.example', state: 'ready', sending: true, signedIn: true });
    if (kind !== 'personal') {
      const ada = this.contact('Ada Quinn', 'email', 'ada@quinn.example');
      const ch = this.channel([ada]);
      this.add({ channelId: ch, from: ada, subject: 'Thursday', text: 'Can we move Thursday to 3?', at: now - 2 * HOUR });
      return;
    }

    // People
    const dana = this.contact('Dana Ortiz', 'email', 'dana@ortiz.example');
    const danaCh = this.channel([dana]);
    this.add({ channelId: danaCh, from: null, subject: 'Garden plans', text: 'Here are the sketches for the back garden. Tell me what you think.', at: now - 26 * HOUR });
    this.add({
      channelId: danaCh,
      from: dana,
      subject: 'Re: Garden plans',
      text: 'These look lovely. The plant list is on the nursery page: Spring planting guide.\nLet me know by Friday if the raised beds work for you.\n\nDana',
      html:
        // eslint-disable-next-line ma/no-color-literals -- a sender's own table colour, as a sanitized email keeps it (`bgcolor`)
        '<table width="100%" cellpadding="0" cellspacing="0"><tr><td bgcolor="#f3f6fa" align="center">' +
        `<p><img src="${PIXEL}" alt="Garden sketch" width="1" height="1"></p>` +
        '<h2>Garden plans</h2></td></tr><tr><td>' +
        '<p>These look lovely. The plant list is on the nursery page: ' +
        '<a data-ma-href="https://nursery.example/spring-guide" data-ma-host="nursery.example" title="https://nursery.example/spring-guide" data-ma-warn="tracker">Spring planting guide</a>.</p>' +
        '<p>Let me know by Friday if the raised beds work for you.</p>' +
        '<p><img data-ma-src="https://images.example/beds.jpg" alt="Raised beds"></p>' +
        '<p>Dana</p></td></tr></table>',
      at: now - 3 * HOUR,
      read: false,
      attachments: [
        { part: '2', name: 'garden-sketch.pdf', type: 'application/pdf', bytes: 482_000, contentId: null, inline: false, danger: null },
        { part: '3', name: 'planting-tool.exe', type: 'application/x-msdownload', bytes: 1_204_000, contentId: null, inline: false, danger: 'program' },
      ],
    });

    const sam = this.contact('Sam Lee', 'ma', 'sam.lee@courier.example');
    this.pins.set('sam.lee@courier.example', { state: 'unverified', source: 'first_use', number: mockSafetyNumber('sam.lee@courier.example'), verifiedAt: null, newNumber: null, held: [] });
    const samCh = this.channel([sam]);
    this.add({ channelId: samCh, from: sam, medium: 'ma', text: 'Are we still on for the walk tomorrow?', at: now - 50 * MIN });
    this.add({ channelId: samCh, from: null, medium: 'ma', text: 'Yes. 8 at the north gate.', at: now - 45 * MIN });
    this.add({ channelId: samCh, from: sam, medium: 'ma', text: 'Perfect, see you there.', at: now - 40 * MIN, read: false });

    const priya = this.contact('Priya Shah', 'phone', '+15550142', 'known');
    const priyaCh = this.channel([priya]);
    this.add({ channelId: priyaCh, from: priya, medium: 'imessage', text: 'Landed. Taxi now.', at: now - 2 * DAY });

    const kim = this.contact('Kim Park', 'email', 'kim@park.example');
    const ola = this.contact('Ola Berg', 'email', 'ola@berg.example');
    const club = this.channel([dana, kim, ola], 'group', null);
    this.add({ channelId: club, from: kim, subject: 'Book club in December', text: 'Shall we read the lighthouse one next? I can host.', at: now - 5 * DAY });

    // Requests: one confirmed stranger, one that couldn't be confirmed, with links the sandbox flagged.
    const morgan = this.contact('Morgan Reyes', 'email', 'morgan@studio.example', 'unknown');
    const morganCh = this.channel([morgan]);
    this.add({ channelId: morganCh, from: morgan, subject: 'Collaboration on the spring show', text: 'Hello, I saw your prints at the market and wondered if you would show two of them in our spring show.', lane: 'requests', at: now - 6 * HOUR, read: false });
    const alerts = this.contact('Account Services', 'email', 'alerts@secure-login.example', 'unknown');
    const alertsCh = this.channel([alerts]);
    this.add({
      channelId: alertsCh,
      from: alerts,
      subject: 'Your account is on hold',
      text: 'We noticed unusual activity. Sign in at paypal.com to keep your account.',
      html:
        '<p>We noticed unusual activity.</p>' +
        '<p><a data-ma-href="https://paypa1-secure.example/login" data-ma-host="paypa1-secure.example" title="https://paypa1-secure.example/login" data-ma-warn="mismatch">Sign in at paypal.com</a> to keep your account.</p>' +
        '<p><a data-ma-href="https://xn--pypal-4ve.example/" data-ma-host="xn--pypal-4ve.example" title="https://xn--pypal-4ve.example/" data-ma-warn="punycode">Help centre</a></p>' +
        '<p><a data-ma-href="http://203.0.113.9/verify" data-ma-host="203.0.113.9" title="http://203.0.113.9/verify" data-ma-warn="ip">Verify</a></p>',
      lane: 'requests',
      at: now - 9 * HOUR,
      read: false,
      dmarc: 'fail',
      accountId: this.deskAccountId,
    });

    // Updates and Other
    const water = this.contact('City Water', 'email', 'news@citywater.example');
    const waterCh = this.channel([water]);
    this.add({ channelId: waterCh, from: water, subject: 'Your November bill', text: 'Your bill of $42.10 is ready. It is due on December 1.', lane: 'updates', bulk: true, at: now - 30 * HOUR });
    const air = this.contact('Northwind Air', 'email', 'bookings@northwind.example', 'unknown');
    const airCh = this.channel([air]);
    this.add({ channelId: airCh, from: air, subject: 'Your booking NW2291', text: 'Flight NW2291, December 12, 07:40. Check in opens 24 hours before.', lane: 'other', at: now - 4 * DAY });
    const odd = this.contact('Parcel Desk', 'email', 'notice@parcels.example', 'unknown');
    const oddCh = this.channel([odd]);
    this.add({ channelId: oddCh, from: odd, subject: 'Delivery notice', text: '', lane: 'other', at: now - 6 * DAY, parse: { state: 'refused', reason: 'too_deep' } });

    // Spam and Trash
    const spam = this.contact('Prize Team', 'email', 'win@prizes.example', 'unknown');
    const spamCh = this.channel([spam]);
    this.add({ channelId: spamCh, from: spam, subject: 'You may have won', text: 'Claim your prize today.', lane: 'spam', at: now - 2 * DAY, dmarc: 'fail' });
    const old = this.contact('Old Newsletter', 'email', 'hello@old.example');
    const oldCh = this.channel([old]);
    this.add({ channelId: oldCh, from: old, subject: 'Our last issue', text: 'Thanks for reading.', lane: 'trash', at: now - 8 * DAY });
  }

  /**
   * One person across channels (the Designer's flow 11): a number the Mac's contacts put on Dana's card, an address on Sam's,
   * Kim's on a card the member added, a Jordan Smith by name alone, and a new number in Requests that a card puts on Kim.
   * Seeded only when asked (`__maCourierMockInit.links`), so the other specs' lists stay as they were.
   */
  seedLinks(): void {
    const now = Date.now();
    const find = (value: string): Endpoint | undefined => [...this.endpoints.values()].find((e) => e.value === value);
    const dana = find('dana@ortiz.example')!;
    const sam = find('sam.lee@courier.example')!;
    const kim = find('kim@park.example')!;
    const num = this.contact('', 'phone', '+17205550142');
    this.endpoints.get(num)!.source = 'message';
    const numCh = this.channel([num]);
    this.add({ channelId: numCh, from: num, medium: 'imessage', text: 'Landed. Taxi now.', at: now - 26 * MIN, read: false });
    this.add({ channelId: numCh, from: null, medium: 'imessage', text: 'See you soon.', at: now - 24 * MIN });
    const samWork = this.contact('Sam Lee', 'email', 'sam@leeworks.example');
    const samWorkCh = this.channel([samWork]);
    this.add({ channelId: samWorkCh, from: samWork, subject: 'Studio keys', text: 'I left the studio keys with the front desk.', at: now - 3 * DAY });
    const kimMail = this.contact('', 'email', 'kim.park@mail.example');
    const kimMailCh = this.channel([kimMail]);
    this.add({ channelId: kimMailCh, from: kimMail, subject: 'Photos', text: 'Thanks for the photos.', at: now - 4 * DAY });
    const jordanEp = this.contact('Jordan Smith', 'email', 'jordan@smith.example');
    const jordan = this.endpoints.get(jordanEp)!;
    const jordanCh = this.channel([jordanEp]);
    this.add({ channelId: jordanCh, from: jordanEp, subject: 'Saturday', text: 'Saturday works for me.', at: now - 7 * DAY });
    const jordan2 = this.contact('Jordan Smith', 'email', 'jordan.s@mail.example');
    const jordan2Ch = this.channel([jordan2]);
    this.add({ channelId: jordan2Ch, from: jordan2, subject: 'Hello', text: 'Is this still your address?', at: now - 8 * DAY });
    const text = this.contact('', 'phone', '+13035550199', 'unknown');
    const textCh = this.channel([text]);
    this.add({ channelId: textCh, from: text, medium: 'sms', text: 'Hi, it’s Kim, new number.', lane: 'requests', at: now - 2 * HOUR, read: false });
    this.suggested.push(
      { ep: num, into: dana.contactId, source: 'mac', provider: null, strength: 'card' },
      { ep: samWork, into: sam.contactId, source: 'mac', provider: null, strength: 'card' },
      { ep: kimMail, into: kim.contactId, source: 'card', provider: null, strength: 'card' },
      { ep: jordan2, into: jordan.contactId, source: 'name', provider: null, strength: 'name' },
      { ep: text, into: kim.contactId, source: 'card', provider: null, strength: 'card' },
    );
    for (const id of [dana.id, sam.id]) this.endpoints.get(id)!.source = 'added';
  }

  /**
   * Spam and safety (Wave 3.2), seeded only when asked (`__maCourierMockInit.safety`): a stranger whose address looks like a
   * known one and who borrows Dana's name, a message the learning filter put in Spam, mail in Dana's name whose DMARC failed
   * (a Request, the coordinator's call), and a blocked domain.
   */
  seedSafety(): void {
    const now = Date.now();
    const pal = this.contact('Dana Ortiz', 'email', 'dana.ortiz@0rtiz-mail.example', 'unknown');
    const palCh = this.channel([pal]);
    this.add({ channelId: palCh, from: pal, subject: 'New bank details', text: 'Please use these new details for the invoice.', lane: 'requests', at: now - 40 * MIN, read: false, dmarc: 'none' });
    const m = [...this.messages.values()].find((x) => x.channelId === palCh)!;
    m.warnings = [
      { kind: 'not_usual_address', contactId: 'x', name: 'Dana Ortiz' },
      { kind: 'lookalike', domain: '0rtiz-mail.example', like: 'ortiz.example' },
    ];
    const dana = [...this.endpoints.values()].find((e) => e.value === 'dana@ortiz.example')!;
    const danaCh = [...this.channels.values()].find((c) => c.kind === 'direct' && c.members.includes(dana.id))!;
    this.add({ channelId: danaCh.channelId, from: dana.id, subject: 'Quick favour', text: 'Can you buy two gift cards for me today?', lane: 'requests', at: now - 20 * MIN, read: false, dmarc: 'fail' });
    const deals = this.contact('Deals Desk', 'email', 'offers@cheap-deals.example', 'unknown');
    const dealsCh = this.channel([deals]);
    this.add({ channelId: dealsCh, from: deals, subject: 'Limited offer', text: 'Act now.', lane: 'spam', at: now - 3 * HOUR, read: false });
    const f = [...this.messages.values()].find((x) => x.channelId === dealsCh)!;
    f.screen = 'filter';
    f.wasLane = 'requests';
    this.blocks.push({ kind: 'domain', value: 'prizes.example' });
  }

  /**
   * Attachments to fetch (Wave 3.1's Download, "Show" and the archive list), seeded only when asked
   * (`__maCourierMockInit.files`): Dana's photo and a ZIP of plans, an archive that holds a program, and a message that
   * couldn't be read safely (its raw download asks first).
   */
  seedFiles(): void {
    const now = Date.now();
    const dana = [...this.endpoints.values()].find((e) => e.value === 'dana@ortiz.example')!;
    const danaCh = [...this.channels.values()].find((c) => c.kind === 'direct' && c.members.includes(dana.id))!;
    this.add({
      channelId: danaCh.channelId,
      from: dana.id,
      subject: 'Photos of the beds',
      text: 'Here is the bed by the fence, and the plans as a ZIP.',
      at: now - 15 * MIN,
      read: false,
      attachments: [
        { part: '2', name: 'beds.png', type: 'image/png', bytes: 2_400, contentId: null, inline: false, danger: null },
        { part: '3', name: 'plans.zip', type: 'application/zip', bytes: 18_000, contentId: null, inline: false, danger: null },
        { part: '4', name: 'tools.zip', type: 'application/zip', bytes: 40_000, contentId: null, inline: false, danger: 'archive_programs' },
      ],
    });
    const odd = this.contact('Parcel Service', 'email', 'notice@parcels.example', 'unknown');
    const oddCh = this.channel([odd]);
    // As deskd stores one: no attachment rows (the sandbox read none), so its raw download asks first (`danger: unread`).
    this.add({ channelId: oddCh, from: odd, subject: 'Your parcel', text: '', lane: 'other', at: now - 2 * HOUR, parse: { state: 'refused', reason: 'too_many_parts' } });
  }

  /** A member's desk this one hasn't added, in Requests (flow 7), seeded only when asked (`__maCourierMockInit.memberRequest`). */
  seedMemberRequest(): void {
    const now = Date.now();
    const value = 'jules.park@courier.example';
    const jules = this.contact('Jules Park', 'ma', value, 'unknown');
    const ch = this.channel([jules]);
    this.add({ channelId: ch, from: jules, medium: 'ma', text: 'Hi, it’s Jules from the garden club.', lane: 'requests', at: now - 10 * MIN, read: false });
    this.pins.set(value, { state: 'unverified', source: 'first_use', number: mockSafetyNumber(value), verifiedAt: null, newNumber: null, held: [] });
  }

  /** The bytes behind an attachment or a raw message, as the sandbox cuts them: a real picture for an image. */
  private bytesOf(name: string, size: number): Uint8Array {
    if (/\.png$/i.test(name)) return Uint8Array.from(atob(PIXEL.slice(PIXEL.indexOf(',') + 1)), (c) => c.charCodeAt(0));
    const out = new Uint8Array(Math.max(1, Math.min(size, 256 * 1024)));
    const seed = new TextEncoder().encode(`mock bytes of ${name}\n`);
    for (let i = 0; i < out.length; i += 1) out[i] = seed[i % seed.length]!;
    return out;
  }

  /** Download, "Show" and the raw message, on this session's bulk (API.md §21): the reply names the transfer and its SHA-256. */
  private async transfer(method: string, p: Record<string, unknown>, bulk: MockBulk | null): Promise<unknown> {
    if (method === 'courier.attachment.stop') {
      bulk?.stop(Number(p['transferId']));
      return {};
    }
    const m = this.messages.get(this.id(p['messageId'], 'messageId'));
    if (!m) throw refusal('not_found');
    let bytes: Uint8Array;
    const out: Record<string, unknown> = {};
    if (method === 'courier.message.raw') {
      const danger = m.attachments.find((a) => a.danger)?.danger ?? (m.parse?.state === 'refused' ? 'unread' : null);
      if (danger && p['allowDanger'] !== true) throw refusal('forbidden', { reason: 'danger', danger });
      bytes = new TextEncoder().encode(`Subject: ${m.subject}\r\n\r\n${m.text}\r\n`);
      out['name'] = `${new Date(m.at).toISOString().slice(0, 10)} ${m.subject || 'Message'}.eml`;
    } else {
      const a = m.attachments.find((x) => x.part === p['part']);
      if (!a) throw refusal('not_found', { reason: 'part' });
      if (method === 'courier.attachment.image') {
        if (a.danger) throw refusal('forbidden', { reason: 'danger', danger: a.danger });
        if (!/\.(png|jpe?g|gif|bmp)$/i.test(a.name)) throw refusal('bad_request', { reason: 'unsupported' });
        bytes = this.bytesOf('preview.png', 0);
        Object.assign(out, { format: 'png', width: 1, height: 1 });
      } else {
        if (a.danger && p['allowDanger'] !== true) throw refusal('forbidden', { reason: 'danger', danger: a.danger });
        bytes = this.bytesOf(a.name, a.bytes);
        Object.assign(out, { name: a.name, type: a.danger ? 'application/octet-stream' : a.type, danger: a.danger });
      }
    }
    if (!bulk) throw refusal('unavailable');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
    const sha256 = Array.from(digest, (x) => x.toString(16).padStart(2, '0')).join('');
    this.control.transfers.push({ m: method, size: bytes.length });
    const transferId = bulk.read(`courier/${m.messageId}/${String(p['part'] ?? 'raw')}`, bytes, 0);
    return { transferId, size: bytes.length, mtimeMs: m.at, sha256, ...out };
  }

  /**
   * A member whose desk has a new key (flow 6), seeded only when asked (`__maCourierMockInit.keyChanged`): Rowan, checked by an
   * invite link last week, now signing with a new key, one message held until the member checks it.
   */
  seedKeyChanged(): void {
    const now = Date.now();
    const value = 'rowan.birch@courier.example';
    const rowan = this.contact('Rowan Birch', 'ma', value);
    const ch = this.channel([rowan]);
    this.add({ channelId: ch, from: null, medium: 'ma', text: 'Did the plans come through?', at: now - 30 * MIN });
    this.add({ channelId: ch, from: rowan, medium: 'ma', text: 'The plans are in the folder now.', at: now - 20 * MIN, read: false });
    this.pins.set(value, { state: 'changed', source: 'invite', number: mockSafetyNumber(value), verifiedAt: now - 7 * DAY, newNumber: mockSafetyNumber(`${value}#new`), held: [{ text: 'Here is the seed list, as promised.', at: now - 5 * MIN }] });
  }

  /** A pin as `courier.contact.keys` gives it. */
  private pinView(address: string): Record<string, unknown> {
    const pin = this.pins.get(address);
    if (!pin) return { address, state: 'none' };
    return {
      address,
      state: pin.state,
      source: pin.source,
      identityKey: 'I'.repeat(43),
      safetyNumber: pin.number,
      pinnedAt: Date.now() - 30 * DAY,
      verifiedAt: pin.verifiedAt,
      ...(pin.state === 'changed' ? { changedAt: Date.now() - HOUR, newIdentityKey: 'N'.repeat(43), newSafetyNumber: pin.newNumber } : {}),
      held: pin.state === 'changed' ? pin.held.length : 0,
    };
  }

  /** The held messages of a pin go into their conversation, as deskd's release does. Returns how many. */
  private release(address: string): number {
    const pin = this.pins.get(address);
    const ep = [...this.endpoints.values()].find((e) => e.value === address);
    if (!pin || !ep) return 0;
    const ch = this.directOf(ep.contactId) ?? this.channel([ep.id]);
    for (const h of pin.held) this.add({ channelId: ch, from: ep.id, medium: 'ma', text: h.text, at: h.at, read: false });
    const n = pin.held.length;
    pin.held = [];
    this.changed([ch], ['people']);
    return n;
  }

  // ---------------------------------------------------------------- what tests steer

  /** A message from someone new arrives, as a transport hands it over. */
  deliver(p: { name: string; address: string; subject: string; text: string; lane?: Lane; known?: boolean }): { messageId: string; channelId: string } {
    const existing = [...this.endpoints.values()].find((e) => e.value === p.address);
    const ep = existing?.id ?? this.contact(p.name, 'email', p.address, p.known === false ? 'unknown' : 'known');
    const ch = [...this.channels.values()].find((c) => c.kind === 'direct' && c.members[0] === ep)?.channelId ?? this.channel([ep]);
    const messageId = this.add({ channelId: ch, from: ep, subject: p.subject, text: p.text, lane: p.lane ?? 'people', at: Date.now(), read: false });
    this.changed([ch], [p.lane ?? 'people']);
    return { messageId, channelId: ch };
  }

  /** Replace a message's HTML as stored, for the frame's tests (as if the sandbox had written it). */
  setHtml(messageId: string, html: string): void {
    const m = this.messages.get(messageId);
    if (m) m.html = html;
  }

  /** The id of the first message matching a subject. */
  find(subject: string): string | null {
    return [...this.messages.values()].find((m) => m.subject === subject)?.messageId ?? null;
  }

  laneOf(messageId: string): Lane | null {
    return this.messages.get(messageId)?.lane ?? null;
  }

  blocked(): { kind: string; value: string }[] {
    return [...this.blocks];
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private changed(channels: string[], lanes: Lane[], more: { drafts?: boolean; outbound?: boolean; accounts?: boolean } = {}): void {
    const e = (this.pendingEvent ??= { channels: new Set(), lanes: new Set(), drafts: false, outbound: false, accounts: false });
    for (const c of channels) e.channels.add(c);
    for (const l of lanes) e.lanes.add(l);
    e.drafts ||= !!more.drafts;
    e.outbound ||= !!more.outbound;
    e.accounts ||= !!more.accounts;
    setTimeout(() => {
      const ev = this.pendingEvent;
      if (!ev) return;
      this.pendingEvent = null;
      const msg = { type: 'changed', channels: ev.channels.size > 50 ? null : [...ev.channels], lanes: [...ev.lanes], counts: true, drafts: ev.drafts, outbound: ev.outbound, accounts: ev.accounts };
      for (const fn of this.listeners) fn(msg);
    }, 30);
  }

  // ---------------------------------------------------------------- the wire

  private contactWire(epId: string): Record<string, unknown> | null {
    const ep = this.endpoints.get(epId);
    if (!ep) return null;
    const c = this.contacts.get(ep.contactId);
    return { contactId: ep.contactId, name: c?.name ?? '', endpoint: { kind: ep.kind, value: ep.value }, known: ep.standing === 'known' };
  }

  private sender(m: Msg): Record<string, unknown> | null {
    return m.from === null ? { me: true } : this.contactWire(m.from);
  }

  private snippet(m: Msg): string {
    return m.text.replace(/\s+/g, ' ').trim().slice(0, 140);
  }

  private full(m: Msg): Record<string, unknown> {
    const ep = m.from ? this.endpoints.get(m.from) : null;
    return {
      messageId: m.messageId,
      channelId: m.channelId,
      threadId: m.threadId,
      rfcMessageId: m.medium === 'email' ? `<${m.messageId.toLowerCase()}@mock.example>` : null,
      direction: m.direction,
      medium: m.medium,
      accountId: m.accountId,
      from: this.sender(m),
      at: m.at,
      sentAt: m.at,
      receivedAt: m.at,
      subject: m.subject,
      snippet: this.snippet(m),
      lane: m.lane,
      read: m.read,
      bulk: m.bulk,
      senderKnown: m.from === null || ep?.standing === 'known',
      authorKind: m.from === null ? 'member' : 'person',
      status: m.status,
      hasHtml: m.html !== null,
      textTruncated: false,
      textLength: m.text.length,
      parse: m.parse,
      auth: m.medium === 'email' && m.direction === 'in' && m.dmarc !== null ? { spam: 'pass', virus: 'pass', spf: m.dmarc, dkim: m.dmarc, dmarc: m.dmarc, senderConfirmed: m.dmarc === 'pass' } : null,
      labels: [],
      rawBytes: m.text.length + (m.html?.length ?? 0) + 400,
      attachmentCount: m.attachments.length,
      attachments: m.attachments,
      screen: m.screen ?? null,
      warnings: m.warnings ?? [],
    };
  }

  private brief(m: Msg): Record<string, unknown> {
    return { messageId: m.messageId, medium: m.medium, direction: m.direction, from: this.sender(m), subject: m.subject, snippet: this.snippet(m), at: m.at, read: m.read, accountId: m.accountId, warned: (m.warnings ?? []).length > 0 };
  }

  private channelWire(ch: ChannelRec): Record<string, unknown> {
    return { channelId: ch.channelId, kind: ch.kind, title: ch.title, preferredMedium: null, contacts: ch.members.map((e) => this.contactWire(e)).filter(Boolean) };
  }

  private inLane(lane: Lane): Msg[] {
    return [...this.messages.values()].filter((m) => m.lane === lane);
  }

  private isDone(channelId: string, lane: Lane, lastAt: number): boolean {
    const d = this.doneAt.get(`${channelId}:${lane}`);
    return d !== undefined && lastAt <= d;
  }

  private rows(lane: Lane, accountId: string | null, includeDone: boolean): Record<string, unknown>[] {
    const by = new Map<string, Msg[]>();
    for (const m of this.inLane(lane)) {
      if (!by.has(m.channelId)) by.set(m.channelId, []);
      by.get(m.channelId)!.push(m);
    }
    const out: Record<string, unknown>[] = [];
    for (const [channelId, ms] of by) {
      if (accountId && !ms.some((m) => m.accountId === accountId)) continue;
      ms.sort((a, b) => a.at - b.at);
      const last = ms[ms.length - 1]!;
      const done = this.isDone(channelId, lane, last.at);
      if (done && !includeDone) continue;
      const ch = this.channels.get(channelId)!;
      out.push({ ...this.channelWire(ch), lane, lastAt: last.at, count: ms.length, unread: ms.filter((m) => !m.read).length, done, medium: last.medium, last: this.brief(last) });
    }
    return out.sort((a, b) => (b['lastAt'] as number) - (a['lastAt'] as number));
  }

  /** `courier.attention`: the People lane's unread threads, structure only (no subject, name or address), as deskd gives it. */
  private attention(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const r of this.rows('people', null, false)) {
      if ((r['unread'] as number) <= 0 || r['kind'] === 'self' || out.length >= 50) continue;
      const channelId = r['channelId'] as string;
      const ms = [...this.messages.values()].filter((m) => m.channelId === channelId && !['spam', 'trash'].includes(m.lane)).sort((a, b) => a.at - b.at);
      const newest = [...ms].reverse().find((m) => m.direction === 'in' && m.lane === 'people' && !m.read);
      if (!newest) continue;
      const lastOut = Math.max(0, ...ms.filter((m) => m.direction === 'out').map((m) => m.at));
      const last = ms[ms.length - 1];
      const waiting = last && last.direction === 'in' ? ms.find((m) => m.direction === 'in' && m.lane === 'people' && m.at > lastOut) : undefined;
      const sent = ms.filter((m) => m.direction === 'out' && m.at >= Date.now() - 30 * 86_400_000).length;
      const contacts = ((r['contacts'] as Record<string, unknown>[]) ?? []).slice(0, 8);
      out.push({
        channelId,
        kind: r['kind'] === 'group' ? 'group' : 'direct',
        contactIds: contacts.map((c) => c['contactId']),
        known: contacts.some((c) => c['known'] === true),
        confirmed: newest.dmarc === 'pass',
        bulk: newest.bulk,
        theyWroteLastAt: waiting?.at ?? null,
        replyBand: sent === 0 ? 0 : sent <= 4 ? 1 : sent <= 12 ? 2 : 3,
        unread: r['unread'],
        newestAt: r['lastAt'],
      });
    }
    return out;
  }

  private status(): Record<string, unknown> {
    if (this.state !== 'on') return { state: this.state === 'switched_off' ? 'off' : 'unavailable', reason: this.state };
    const lanes = Object.fromEntries(LANES.map((l) => {
      const rows = this.rows(l, null, false);
      return [l, { count: rows.length, unread: rows.reduce((n, r) => n + (r['unread'] as number), 0) }];
    }));
    const pending = [...this.messages.values()].filter((m) => m.parse?.state === 'pending').length;
    return { state: 'on', reason: null, lanes, drafts: this.drafts.size, waiting: this.outbound.size, failed: 0, pending, bytes: 1_200_000, sending: true };
  }

  private page<T>(items: T[], before: unknown, limit: number): { page: T[]; next: string | null } {
    const from = typeof before === 'string' && /^o\d+$/.test(before) ? Number(before.slice(1)) : 0;
    const page = items.slice(from, from + limit);
    return { page, next: from + limit < items.length ? `o${from + limit}` : null };
  }

  private limit(p: Record<string, unknown>, d = 50): number {
    const l = p['limit'] === undefined ? d : Number(p['limit']);
    if (!Number.isInteger(l) || l < 1 || l > 100) throw refusal('bad_request', { reason: 'limit' });
    return l;
  }

  private lane(v: unknown, param = 'lane'): Lane {
    if (!LANES.includes(v as Lane)) throw refusal('bad_request', { reason: param });
    return v as Lane;
  }

  private id(v: unknown, param: string): string {
    if (!isUlid(v)) throw refusal('bad_request', { reason: param });
    return v;
  }

  private search(p: Record<string, unknown>): Record<string, unknown> {
    const q = typeof p['q'] === 'string' ? p['q'] : '';
    if (q.trim() === '') return { hits: [], next: null };
    if (q.length > 500) throw refusal('bad_request', { reason: 'too_long' });
    let lanes: Lane[] = p['lane'] ? [this.lane(p['lane'])] : ['people', 'requests', 'updates', 'other'];
    const words: string[] = [];
    let from: string | null = null;
    let hasAtt = false;
    let after = -Infinity;
    let before = Infinity;
    for (const raw of q.match(/"[^"]*"|\S+/g) ?? []) {
      const t = raw.toLowerCase();
      const op = /^(from|to|has|in|before|after|is):(.*)$/.exec(t);
      if (op) {
        const [, k, v] = op as unknown as [string, string, string];
        if (k === 'from') from = v;
        else if (k === 'has') {
          if (v !== 'attachment') throw refusal('bad_request', { reason: 'has' });
          hasAtt = true;
        } else if (k === 'in') {
          if (!LANES.includes(v as Lane)) throw refusal('bad_request', { reason: 'in' });
          lanes = [v as Lane];
        } else if (k === 'before' || k === 'after') {
          const ms = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : NaN;
          if (Number.isNaN(ms)) throw refusal('bad_request', { reason: 'date' });
          if (k === 'before') before = ms;
          else after = ms + DAY;
        } else if (k === 'is') throw refusal('bad_request', { reason: 'is' });
        continue;
      }
      words.push(t.replace(/^"|"$/g, ''));
    }
    if (words.length > 20) throw refusal('bad_request', { reason: 'too_many_terms' });
    const hits: Record<string, unknown>[] = [];
    const sorted = [...this.messages.values()].filter((m) => lanes.includes(m.lane)).sort((a, b) => b.at - a.at);
    for (const m of sorted) {
      if (m.at < after || m.at >= before) continue;
      if (hasAtt && m.attachments.length === 0) continue;
      const s = m.from ? this.contactWire(m.from) : null;
      const who = s ? `${s['name'] as string} ${(s['endpoint'] as { value: string }).value}`.toLowerCase() : 'you';
      if (from && !who.includes(from)) continue;
      const hay = `${m.subject} ${who} ${m.text} ${m.attachments.map((a) => a.name).join(' ')}`.toLowerCase();
      const tokens = hay.split(/[^\p{L}\p{N}]+/u);
      if (!words.every((w) => (w.includes(' ') ? hay.includes(w) : tokens.some((t) => t.startsWith(w))))) continue;
      // The snippet: from just before the first word found in the text, else the start.
      const text = m.text.replace(/\s+/g, ' ');
      const lower = text.toLowerCase();
      const firstAt = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
      const start = Math.max(0, firstAt - 30);
      const snippet = (start > 0 ? '…' : '') + text.slice(start, start + 160);
      const sl = snippet.toLowerCase();
      const matches: [number, number][] = [];
      for (const w of words) {
        let i = sl.indexOf(w);
        while (i >= 0 && matches.length < 20) {
          if (i === 0 || !/[\p{L}\p{N}]/u.test(sl[i - 1] ?? '')) matches.push([i, i + w.length]);
          i = sl.indexOf(w, i + w.length);
        }
      }
      matches.sort((a, b) => a[0] - b[0]);
      hits.push({ ...this.brief(m), channelId: m.channelId, lane: m.lane, snippet, matches });
    }
    const { page, next } = this.page(hits, p['before'], this.limit(p));
    return { hits: page, next };
  }

  private messageIdsOf(p: Record<string, unknown>): Msg[] {
    if (Array.isArray(p['messageIds'])) return (p['messageIds'] as unknown[]).map((id) => this.messages.get(this.id(id, 'messageIds'))).filter((m): m is Msg => !!m);
    const ch = this.id(p['channelId'], 'channelId');
    const lane = p['lane'] === undefined ? null : this.lane(p['lane']);
    return [...this.messages.values()].filter((m) => m.channelId === ch && (lane ? m.lane === lane : m.lane !== 'spam' && m.lane !== 'trash'));
  }

  private letIn(m: Msg): void {
    if (!m.from) return;
    const ep = this.endpoints.get(m.from);
    if (ep && ep.standing !== 'blocked') ep.standing = 'known';
  }

  async answer(method: string, params: Record<string, unknown>, idem?: string, bulk: MockBulk | null = null): Promise<unknown> {
    const logged = 'secret' in params ? { ...params, secret: '[sealed]' } : params;
    this.control.calls.push({ m: method, p: logged, ...(idem ? { idem } : {}) });
    if (this.control.delayMs) await new Promise((r) => setTimeout(r, this.control.delayMs));
    const always = this.control.refuse[method];
    if (always) throw typeof always === 'string' ? refusal(always) : refusal(always.code, always.details);
    if (method !== 'courier.status' && this.state !== 'on') throw refusal('unavailable', { reason: this.state });
    if (method === 'courier.attachment.read' || method === 'courier.attachment.image' || method === 'courier.message.raw' || method === 'courier.attachment.stop') {
      return this.transfer(method, params, bulk);
    }
    if (!READS.includes(method)) {
      if (!idem) throw refusal('bad_request', { reason: 'idem' });
      const key = `${method}|${JSON.stringify(params)}`;
      const kept = this.idems.get(idem);
      if (kept) {
        if (kept.key !== key) throw refusal('conflict', { reason: 'idem' });
        return kept.result;
      }
      const result = this.run(method, params);
      this.idems.set(idem, { key, result });
      return result;
    }
    return this.run(method, params);
  }

  private run(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case 'courier.status':
        return this.status();
      case 'courier.list': {
        const lane = this.lane(p['lane']);
        const rows = this.rows(lane, typeof p['accountId'] === 'string' ? p['accountId'] : null, p['includeDone'] === true);
        const { page, next } = this.page(rows, p['before'], this.limit(p));
        return { rows: page, next };
      }
      case 'courier.attention':
        return { threads: this.attention() };
      case 'courier.thread': {
        const ch = this.channels.get(this.id(p['channelId'], 'channelId'));
        if (!ch) throw refusal('not_found', { reason: 'channel' });
        const lane = p['lane'] === undefined ? null : this.lane(p['lane']);
        const ms = [...this.messages.values()].filter((m) => m.channelId === ch.channelId && (lane ? m.lane === lane : !['spam', 'trash'].includes(m.lane))).sort((a, b) => b.at - a.at);
        const { page, next } = this.page(ms, p['before'], this.limit(p, 50));
        return { channel: this.channelWire(ch), messages: page.reverse().map((m) => ({ ...this.full(m), text: m.text.slice(0, 2000), textMore: m.text.length > 2000 })), next };
      }
      case 'courier.message': {
        const m = this.messages.get(this.id(p['messageId'], 'messageId'));
        if (!m) throw refusal('not_found', { reason: 'message' });
        const from = typeof p['from'] === 'number' ? p['from'] : 0;
        const slice = m.text.slice(from, from + 150_000);
        const ch = this.channels.get(m.channelId)!;
        return { ...this.full(m), text: slice, textFrom: from, textNext: from + 150_000 < m.text.length ? from + 150_000 : null, recipients: ch.members.map((e) => ({ role: 'to', endpoint: this.contactWire(e)?.['endpoint'], contactId: this.endpoints.get(e)?.contactId, name: this.contactWire(e)?.['name'] })) };
      }
      case 'courier.message.html': {
        const m = this.messages.get(this.id(p['messageId'], 'messageId'));
        if (!m || m.html === null) throw refusal('not_found', { reason: 'html' });
        const from = typeof p['from'] === 'number' ? p['from'] : 0;
        // Slices of 2,000 characters here, so the window's joining of slices is tested.
        const next = from + 2000 < m.html.length ? from + 2000 : null;
        return { messageId: m.messageId, html: m.html.slice(from, from + 2000), from, next };
      }
      case 'courier.search':
        return this.search(p);
      case 'courier.contacts.list':
        return { contacts: [...this.contacts.values()].map((c) => ({ contactId: c.contactId, name: c.name, named: true, endpoints: [...this.endpoints.values()].filter((e) => e.contactId === c.contactId).map((e) => ({ kind: e.kind, value: e.value, standing: e.standing, lastInboundAt: null, lastInboundMedium: null })) })), next: null };
      case 'courier.accounts.list':
        return { accounts: [...this.accounts.values()] };
      case 'courier.blocks.list':
        return { blocks: [...this.blocks] };
      case 'courier.drafts.list':
        return { drafts: [...this.drafts.values()].map((d) => ({ ...d, text: d.text.slice(0, 200) })) };
      case 'courier.draft.get': {
        const d = this.drafts.get(this.id(p['draftId'], 'draftId'));
        if (!d) throw refusal('not_found', { reason: 'draft' });
        return d;
      }
      case 'courier.outbound.list':
        return { outbound: [...this.outbound.values()].map((o) => ({ outboundId: o.outboundId, messageId: o.messageId, channelId: o.draft.channelId, state: 'waiting', notBefore: o.undoUntil, attempts: 0, error: null, giveUpAt: null, medium: o.draft.medium, subject: o.draft.subject })) };
      case 'courier.read.set': {
        const read = p['read'] !== false;
        let changed = 0;
        const chs = new Set<string>();
        const lanes = new Set<Lane>();
        for (const m of this.messageIdsOf(p)) {
          if (m.read !== read) {
            m.read = read;
            changed += 1;
            chs.add(m.channelId);
            lanes.add(m.lane);
          }
        }
        if (changed) this.changed([...chs], [...lanes]);
        return { changed };
      }
      case 'courier.move': {
        const to = p['to'];
        if (to === 'requests' || (to !== 'restore' && !LANES.includes(to as Lane))) throw refusal('bad_request', { reason: 'to' });
        const ms = this.messageIdsOf(p);
        const chs = new Set<string>();
        const lanes = new Set<Lane>();
        for (const m of ms) {
          lanes.add(m.lane);
          const next: Lane = to === 'restore' ? (m.wasLane ?? 'people') : (to as Lane);
          if (to !== 'restore' && (to === 'spam' || to === 'trash')) m.wasLane = m.lane;
          if ((next === 'people' || next === 'updates') && ['requests', 'other', 'spam'].includes(m.lane)) this.letIn(m);
          m.lane = next;
          lanes.add(next);
          chs.add(m.channelId);
        }
        this.changed([...chs], [...lanes]);
        return { moved: ms.length };
      }
      case 'courier.done': {
        const ch = this.id(p['channelId'], 'channelId');
        const lane = this.lane(p['lane']);
        const ms = this.inLane(lane).filter((m) => m.channelId === ch);
        if (!ms.length) throw refusal('not_found', { reason: 'channel' });
        if (p['done'] === false) this.doneAt.delete(`${ch}:${lane}`);
        else this.doneAt.set(`${ch}:${lane}`, Math.max(...ms.map((m) => m.at)));
        this.changed([ch], [lane]);
        return {};
      }
      case 'courier.request.decide': {
        const ch = this.id(p['channelId'], 'channelId');
        const ms = this.inLane('requests').filter((m) => m.channelId === ch);
        if (!ms.length) throw refusal('not_found', { reason: 'request' });
        const d = p['decision'];
        if (d === 'let_in') {
          for (const m of ms) {
            this.letIn(m);
            m.lane = 'people';
          }
          this.changed([ch], ['requests', 'people']);
        } else if (d === 'not_now') {
          this.doneAt.set(`${ch}:requests`, Math.max(...ms.map((m) => m.at)));
          this.changed([ch], ['requests']);
        } else if (d === 'block') {
          const ep = ms[0]!.from ? this.endpoints.get(ms[0]!.from) : null;
          if (ep) {
            ep.standing = 'blocked';
            if (!this.blocks.some((b) => b.kind === 'address' && b.value === ep.value)) this.blocks.push({ kind: 'address', value: ep.value });
          }
          for (const m of ms) {
            m.wasLane = m.lane;
            m.lane = 'spam';
          }
          this.changed([ch], ['requests', 'spam']);
        } else throw refusal('bad_request', { reason: 'decision' });
        return {};
      }
      case 'courier.block': {
        const kind = p['kind'];
        const value = typeof p['value'] === 'string' ? p['value'].toLowerCase().trim() : '';
        if ((kind !== 'address' && kind !== 'domain') || !value) throw refusal('bad_request', { reason: kind !== 'address' && kind !== 'domain' ? 'kind' : 'value' });
        if (!this.blocks.some((b) => b.kind === kind && b.value === value)) this.blocks.push({ kind, value });
        let senders = 0;
        for (const ep of this.endpoints.values()) {
          if ((kind === 'address' && ep.value === value) || (kind === 'domain' && (domainOf(ep.value) === value || domainOf(ep.value).endsWith(`.${value}`)))) {
            ep.standing = 'blocked';
            senders += 1;
          }
        }
        this.changed([], [], {});
        return { senders };
      }
      case 'courier.unblock': {
        const i = this.blocks.findIndex((b) => b.kind === p['kind'] && b.value === p['value']);
        if (i >= 0) this.blocks.splice(i, 1);
        for (const ep of this.endpoints.values()) if (ep.standing === 'blocked' && ep.value === p['value']) ep.standing = 'unknown';
        return {};
      }
      case 'courier.delete': {
        const ids = Array.isArray(p['messageIds']) ? (p['messageIds'] as unknown[]) : null;
        if (!ids) throw refusal('bad_request', { reason: 'messageIds' });
        let deleted = 0;
        const chs = new Set<string>();
        const lanes = new Set<Lane>();
        for (const raw of ids) {
          const m = this.messages.get(this.id(raw, 'messageIds'));
          if (!m) continue;
          lanes.add(m.lane);
          chs.add(m.channelId);
          if (p['forever'] === true) {
            if (m.lane !== 'trash' && m.lane !== 'spam') throw refusal('bad_request', { reason: 'forever' });
            this.messages.delete(m.messageId);
          } else {
            m.wasLane = m.lane;
            m.lane = 'trash';
            lanes.add('trash');
          }
          deleted += 1;
        }
        this.changed([...chs], [...lanes]);
        return { deleted };
      }
      case 'courier.trash.empty': {
        const gone = this.inLane('trash');
        for (const m of gone) this.messages.delete(m.messageId);
        this.changed(gone.map((m) => m.channelId), ['trash']);
        return { deleted: gone.length };
      }
      case 'courier.draft.save': {
        if (typeof p['text'] !== 'string') throw refusal('bad_request', { reason: 'text' });
        const id = p['draftId'] === undefined ? null : this.id(p['draftId'], 'draftId');
        const had = id ? this.drafts.get(id) : undefined;
        if (id && !had) throw refusal('not_found', { reason: 'draft' });
        if (had && typeof p['baseVersion'] === 'number' && p['baseVersion'] !== had.version) throw refusal('conflict', { reason: 'version' });
        const d: DraftRec = {
          draftId: had?.draftId ?? ulid(),
          channelId: (p['channelId'] as string | undefined) ?? had?.channelId ?? null,
          medium: (p['medium'] as Medium | undefined) ?? had?.medium ?? null,
          accountId: (p['accountId'] as string | undefined) ?? had?.accountId ?? null,
          to: Array.isArray(p['to']) ? (p['to'] as string[]) : (had?.to ?? []),
          subject: typeof p['subject'] === 'string' ? p['subject'] : (had?.subject ?? ''),
          text: p['text'],
          replyTo: (p['replyTo'] as string | undefined) ?? had?.replyTo ?? null,
          version: (had?.version ?? 0) + 1,
          updatedAt: Date.now(),
        };
        this.drafts.set(d.draftId, d);
        this.changed([], [], { drafts: true });
        return { draftId: d.draftId, version: d.version };
      }
      case 'courier.draft.discard': {
        this.drafts.delete(this.id(p['draftId'], 'draftId'));
        this.changed([], [], { drafts: true });
        return {};
      }
      case 'courier.send': {
        const d = this.drafts.get(this.id(p['draftId'], 'draftId'));
        if (!d) throw refusal('not_found', { reason: 'draft' });
        const account = d.accountId ? this.accounts.get(d.accountId) : null;
        if (!account || !account.sending || d.medium !== 'email') throw refusal('unavailable', { reason: 'medium' });
        const ch = d.channelId ? this.channels.get(d.channelId) : null;
        if (ch && ch.members.some((e) => this.endpoints.get(e)?.standing === 'blocked')) throw refusal('forbidden', { reason: 'blocked' });
        const now = Date.now();
        const messageId = this.add({ channelId: d.channelId!, from: null, subject: d.subject, text: d.text, at: now, accountId: d.accountId });
        this.messages.get(messageId)!.status = 'queued';
        this.drafts.delete(d.draftId);
        const outboundId = ulid();
        const rec: OutRec = { outboundId, messageId, draft: d, undoUntil: now + 10_000, timer: null };
        rec.timer = setTimeout(() => {
          const m = this.messages.get(messageId);
          if (m) m.status = 'sent';
          this.outbound.delete(outboundId);
          this.changed([d.channelId!], ['people'], { outbound: true });
        }, 10_000);
        this.outbound.set(outboundId, rec);
        this.changed([d.channelId!], ['people'], { drafts: true, outbound: true });
        return { messageId, outboundId, undoUntil: rec.undoUntil };
      }
      case 'courier.send.undo': {
        const o = this.outbound.get(this.id(p['outboundId'], 'outboundId'));
        if (!o) throw refusal('conflict', { reason: 'too_late' });
        if (o.timer) clearTimeout(o.timer);
        this.outbound.delete(o.outboundId);
        this.messages.delete(o.messageId);
        const d = { ...o.draft, version: o.draft.version + 1, updatedAt: Date.now() };
        this.drafts.set(d.draftId, d);
        this.changed([d.channelId!], ['people'], { drafts: true, outbound: true });
        return { draftId: d.draftId };
      }
      case 'courier.contact.get': {
        const c = this.contacts.get(String(p['contactId'] ?? ''));
        if (!c) throw refusal('not_found', { reason: 'contact' });
        return this.personWire(c.contactId);
      }
      case 'courier.keys':
        return this.fingerprint ? { available: true, identityKey: 'A'.repeat(43), boxKey: 'B'.repeat(43), fingerprint: this.fingerprint, published: { current: true, keysVersion: 1, at: Date.now(), problem: null } } : (() => {
          throw refusal('unavailable', { reason: 'keys' });
        })();
      case 'courier.report': {
        // Report spam: to Spam (kept where it was for Not spam), the filter taught; Trash and the member's own are left out.
        const ids = Array.isArray(p['messageIds']) ? (p['messageIds'] as unknown[]).filter(isUlid) : [];
        if (ids.length === 0) throw refusal('bad_request', { reason: 'messageIds' });
        const lanes = new Set<Lane>();
        const channels = new Set<string>();
        let reported = 0;
        for (const id of ids) {
          const m = this.messages.get(id);
          if (!m || m.direction === 'out' || m.lane === 'trash') continue;
          lanes.add(m.lane);
          if (m.lane !== 'spam') {
            m.wasLane = m.lane;
            m.lane = 'spam';
          }
          m.screen = null;
          channels.add(m.channelId);
          reported += 1;
          if (p['block'] === true && m.from) {
            const ep = this.endpoints.get(m.from);
            if (ep && !(ep.standing === 'known' && m.dmarc !== 'pass')) this.blocks.push({ kind: 'address', value: ep.value });
          }
        }
        this.changed([...channels], [...lanes, 'spam']);
        return { reported };
      }
      case 'courier.attachment.archive': {
        const m = this.messages.get(this.id(p['messageId'], 'messageId'));
        const a = m?.attachments.find((x) => x.part === p['part']);
        if (!m || !a) throw refusal('not_found', { reason: 'part' });
        if (!/\.(zip|tar)$/i.test(a.name)) throw refusal('bad_request', { reason: 'unsupported' });
        const entries =
          a.danger === 'archive_programs'
            ? [
                { name: 'tools/', bytes: 0, dir: true, encrypted: false, danger: null },
                { name: 'tools/setup.exe', bytes: 31_000, dir: false, encrypted: false, danger: 'program' },
                { name: 'tools/readme.txt', bytes: 900, dir: false, encrypted: false, danger: null },
              ]
            : [
                { name: 'plans/', bytes: 0, dir: true, encrypted: false, danger: null },
                { name: 'plans/beds.pdf', bytes: 12_400, dir: false, encrypted: false, danger: null },
                { name: 'plans/budget.xlsx', bytes: 5_100, dir: false, encrypted: true, danger: null },
              ];
        return { format: 'zip', entries, total: entries.length, truncated: false, danger: a.danger };
      }
      case 'courier.attachment.save': {
        const m = this.messages.get(this.id(p['messageId'], 'messageId'));
        const a = m?.attachments.find((x) => x.part === p['part']);
        if (!m || !a) throw refusal('not_found', { reason: 'part' });
        if (a.danger && p['allowDanger'] !== true) throw refusal('forbidden', { reason: 'danger', danger: a.danger });
        const key = `${m.messageId}|${a.part}`;
        const day = new Date(m.at).toISOString().slice(0, 10);
        const path = this.savedFiles.get(key) ?? `Courier/${day} ${m.subject.replace(/^re:\s*/i, '') || 'Message'}/${a.name}`;
        const already = this.savedFiles.has(key);
        this.savedFiles.set(key, path);
        return { path, folder: path.slice(0, path.lastIndexOf('/')), name: a.name, bytes: a.bytes, sha256: '0'.repeat(64), already, danger: a.danger };
      }
      case 'courier.contacts.add': {
        // An invite link's Add: the member address on this desk's Courier domain, pinned only if its key matches the link.
        const name = String(p['name'] ?? '').toLowerCase();
        if (!/^[a-z0-9](?:[a-z0-9.-]{1,30}[a-z0-9])$/.test(name)) throw refusal('bad_request', { reason: 'name' });
        if (name.startsWith('closed')) throw refusal('not_found', { reason: 'address_closed' });
        const value = `${name}@courier.example`;
        const fp = typeof p['fingerprint'] === 'string' ? p['fingerprint'] : null;
        let pin = this.pins.get(value);
        // A link whose fingerprint isn't the directory's keys (the mock: one starting 0000); `pinned` says this desk has a key.
        if (fp?.startsWith('0000')) throw refusal('conflict', { reason: 'fingerprint', pinned: !!pin });
        // A key the member checked, changed since (the mock: a link starting 1111 for an address checked before): marked
        // changed, and the new safety number to compare.
        if (fp?.startsWith('1111') && pin?.state === 'verified' && pin.number !== mockSafetyNumber(`${value}#new`)) {
          pin.state = 'changed';
          pin.newNumber = mockSafetyNumber(`${value}#new`);
          throw refusal('conflict', { reason: 'key_changed', newSafetyNumber: pin.newNumber });
        }
        let released = 0;
        if (fp && pin?.state === 'changed') {
          // The link vouches for an unchecked change only; the mock's links do.
          pin.number = pin.newNumber ?? pin.number;
          pin.newNumber = null;
          released = this.release(value);
        }
        if (fp) pin = { state: 'verified', source: 'invite', number: pin?.number ?? mockSafetyNumber(value), verifiedAt: Date.now(), newNumber: null, held: [] };
        else pin ??= { state: 'unverified', source: 'link', number: mockSafetyNumber(value), verifiedAt: null, newNumber: null, held: [] };
        this.pins.set(value, pin);
        let ep = [...this.endpoints.values()].find((e) => e.value === value);
        if (!ep) {
          const id = this.contact(typeof p['displayName'] === 'string' ? p['displayName'] : '', 'ma', value);
          ep = this.endpoints.get(id)!;
          ep.source = 'added';
        }
        const channelId = this.directOf(ep.contactId) ?? this.channel([ep.id]);
        this.changed([channelId], ['people']);
        return { contactId: ep.contactId, channelId, checked: fp ? 'invite' : null, address: value, safetyNumber: pin.number, released };
      }
      case 'courier.contact.keys': {
        const id = String(p['contactId'] ?? '');
        if (!this.contacts.has(id)) throw refusal('bad_request', { reason: 'contactId' });
        return { keys: this.endpointsOf(id).filter((e) => e.kind === 'ma').map((e) => this.pinView(e.value)) };
      }
      case 'courier.contact.verify': {
        const address = String(p['address'] ?? '').toLowerCase();
        const number = String(p['safetyNumber'] ?? '');
        if (!/^\d{5}(?: \d{5}){11}$/.test(number)) throw refusal('bad_request', { reason: 'safetyNumber' });
        const pin = this.pins.get(address);
        const mismatch = (): never => {
          throw refusal('conflict', { reason: 'safety_number' });
        };
        if (!pin) {
          if (number !== mockSafetyNumber(address)) mismatch();
          this.pins.set(address, { state: 'verified', source: 'safety_number', number, verifiedAt: Date.now(), newNumber: null, held: [] });
          return { state: 'verified', released: 0 };
        }
        let released = 0;
        if (pin.state === 'changed' && number === pin.newNumber) {
          pin.number = number;
          released = this.release(address);
        } else if (number === pin.number) {
          // The pinned key, checked: a change meanwhile wasn't the contact's, and what it held goes.
          pin.held = [];
        } else mismatch();
        Object.assign(pin, { state: 'verified', source: 'safety_number', verifiedAt: Date.now(), newNumber: null });
        const ep = [...this.endpoints.values()].find((e) => e.value === address);
        const ch = ep ? this.directOf(ep.contactId) : null;
        this.changed(ch ? [ch] : [], ['people']);
        return { state: 'verified', released };
      }
      case 'courier.links.suggest':
        return { suggestions: this.suggestions(p['endpoint']) };
      case 'courier.links.lookup': {
        const ep = this.endpointByWire(p['endpoint']);
        if (!ep) return { contactId: null, name: '', endpoints: 0, messages: 0 };
        const c = this.contacts.get(ep.contactId);
        return { contactId: ep.contactId, name: c?.name ?? '', endpoints: this.endpointsOf(ep.contactId).length, messages: [...this.messages.values()].filter((m) => m.via === ep.id).length };
      }
      case 'courier.links.link':
        return this.link(p);
      case 'courier.links.undo': {
        const rec = this.linksMade.get(String(p['linkId'] ?? ''));
        if (!rec) throw refusal('not_found', { reason: 'link' });
        this.linksMade.delete(String(p['linkId']));
        if (!this.contacts.has(rec.from)) this.contacts.set(rec.from, { contactId: rec.from, name: rec.fromName });
        const back = rec.fromChannel && this.channels.has(rec.fromChannel) ? rec.fromChannel : this.channel([]);
        this.moveEndpoints(rec.eps, rec.from, back);
        this.changed([back, this.directOf(rec.into) ?? back], ['people', 'requests']);
        return {};
      }
      case 'courier.links.unlink': {
        const ep = this.endpointByWire(p['endpoint']);
        if (!ep) throw refusal('not_found', { reason: 'endpoint' });
        if (this.endpointsOf(ep.contactId).length < 2) throw refusal('conflict', { reason: 'only' });
        const was = this.directOf(ep.contactId);
        const contactId = ulid();
        this.contacts.set(contactId, { contactId, name: '' });
        const ch = this.channel([]);
        this.moveEndpoints([ep.id], contactId, ch);
        this.changed([ch, ...(was ? [was] : [])], ['people']);
        return { contactId, channelId: ch };
      }
      case 'courier.links.dismiss': {
        const ep = this.endpointByWire(p['endpoint']);
        if (!ep || typeof p['into'] !== 'string') throw refusal('bad_request', { reason: 'endpoint' });
        this.dismissed.add(`${ep.id}|${p['into']}`);
        this.changed([], ['people']);
        return {};
      }
      case 'courier.contact.merge': {
        const into = String(p['into'] ?? '');
        const from = String(p['from'] ?? '');
        if (!this.contacts.has(into) || !this.contacts.has(from) || into === from) throw refusal('not_found', { reason: 'contact' });
        this.link({ into, from });
        return {};
      }
      case 'courier.contact.rename': {
        const c = this.contacts.get(this.id(p['contactId'], 'contactId'));
        if (!c || typeof p['name'] !== 'string') throw refusal('not_found');
        c.name = p['name'];
        this.changed([], ['people']);
        return {};
      }
      case 'courier.accounts.add':
        return this.addAccount(p);
      case 'courier.imsg.pair':
        return this.pairMac(p);
      case 'courier.accounts.remove': {
        const a = typeof p['accountId'] === 'string' ? this.accounts.get(p['accountId']) : undefined;
        if (!a) throw refusal('not_found', { reason: 'account' });
        if (a.kind !== 'imap' && a.kind !== 'jmap' && a.kind !== 'imessage') throw refusal('bad_request', { reason: 'accountId' });
        this.accounts.delete(a.accountId);
        const lanes = new Set<Lane>();
        if (p['keepMail'] !== true) {
          for (const m of [...this.messages.values()]) {
            if (m.accountId === a.accountId) {
              lanes.add(m.lane);
              this.messages.delete(m.messageId);
            }
          }
        }
        this.changed([], [...lanes], { accounts: true });
        return {};
      }
      default:
        throw refusal('not_found', { reason: 'method' });
    }
  }

  // ---------------------------------------------------------------- one person across channels

  private endpointsOf(contactId: string): Endpoint[] {
    return [...this.endpoints.values()].filter((e) => e.contactId === contactId);
  }

  private endpointByWire(v: unknown): Endpoint | null {
    const o = v as { kind?: unknown; value?: unknown } | null;
    if (!o || typeof o.value !== 'string') return null;
    const value = o.value.trim().toLowerCase();
    return [...this.endpoints.values()].find((e) => e.value.toLowerCase() === value && (o.kind === undefined || e.kind === o.kind)) ?? null;
  }

  /** A person's own conversation: the direct channel whose members are all theirs. */
  private directOf(contactId: string): string | null {
    for (const c of this.channels.values()) {
      if (c.kind !== 'direct') continue;
      if (c.members.length && c.members.every((m) => this.endpoints.get(m)?.contactId === contactId)) return c.channelId;
    }
    return null;
  }

  private personWire(contactId: string): Record<string, unknown> {
    const c = this.contacts.get(contactId);
    return {
      contactId,
      name: c?.name ?? '',
      named: !!c?.name,
      endpoints: this.endpointsOf(contactId).map((e) => ({ kind: e.kind, value: e.value, standing: e.standing, source: e.source ?? 'message', lastInboundAt: null, lastInboundMedium: null })),
    };
  }

  private suggestions(only: unknown): Record<string, unknown>[] {
    const want = only === undefined ? null : this.endpointByWire(only);
    if (only !== undefined && !want) return [];
    const out: Record<string, unknown>[] = [];
    for (const s of this.suggested) {
      const ep = this.endpoints.get(s.ep);
      const into = this.contacts.get(s.into);
      if (!ep || !into || (want && want.id !== ep.id)) continue;
      if (ep.contactId === s.into || this.dismissed.has(`${ep.id}|${s.into}`) || ep.standing === 'blocked') continue;
      out.push({ endpoint: { kind: ep.kind, value: ep.value }, fromContactId: ep.contactId, channelId: this.directOf(ep.contactId), into: { contactId: into.contactId, name: into.name }, source: s.source, provider: s.provider, strength: s.strength });
    }
    return out;
  }

  /** Moves endpoints onto a person, with every message that came or went through them, into that person's conversation. */
  private moveEndpoints(eps: string[], into: string, intoChannel: string): string[] {
    const moved: string[] = [];
    const set = new Set(eps);
    for (const id of eps) {
      const ep = this.endpoints.get(id);
      if (ep) ep.contactId = into;
    }
    for (const c of this.channels.values()) {
      if (c.kind !== 'direct' || c.channelId === intoChannel) continue;
      c.members = c.members.filter((m) => !set.has(m));
    }
    const ch = this.channels.get(intoChannel)!;
    for (const id of eps) if (!ch.members.includes(id)) ch.members.push(id);
    for (const m of this.messages.values()) {
      const direct = this.channels.get(m.channelId)?.kind === 'direct';
      if (direct && m.via && set.has(m.via) && m.channelId !== intoChannel) {
        m.channelId = intoChannel;
        moved.push(m.messageId);
      }
    }
    for (const c of [...this.channels.values()]) if (c.kind === 'direct' && c.members.length === 0) this.channels.delete(c.channelId);
    return moved;
  }

  private link(p: Record<string, unknown>): { linkId: string; channelId: string } {
    const into = String(p['into'] ?? '');
    if (!this.contacts.has(into)) throw refusal('not_found', { reason: 'contact' });
    let eps: string[];
    let from: string;
    if (typeof p['from'] === 'string') {
      from = p['from'];
      if (from === into || !this.contacts.has(from)) throw refusal('bad_request', { reason: 'from' });
      eps = this.endpointsOf(from).map((e) => e.id);
    } else {
      const wire = p['endpoint'] as { kind?: unknown; value?: unknown } | undefined;
      let ep = this.endpointByWire(wire);
      if (!ep) {
        // A new email or number typed in the person view: it starts on this person, with nothing to bring in.
        if (typeof wire?.value !== 'string' || !['email', 'phone', 'ma'].includes(String(wire.kind))) throw refusal('bad_request', { reason: 'endpoint' });
        const id = ulid();
        ep = { id, contactId: into, kind: wire.kind as Endpoint['kind'], value: wire.value.trim(), standing: 'known', source: 'added' };
        this.endpoints.set(id, ep);
        const ch = this.directOf(into) ?? this.channel([]);
        this.channels.get(ch)!.members.push(id);
        const linkId = ulid();
        this.changed([ch], ['people']);
        return { linkId, channelId: ch };
      }
      from = ep.contactId;
      if (from === into) throw refusal('conflict', { reason: 'already' });
      eps = [ep.id];
    }
    const fromName = this.contacts.get(from)?.name ?? '';
    const fromChannel = this.directOf(from);
    const intoChannel = this.directOf(into) ?? this.channel([]);
    // Linking lets a Requests endpoint in: its messages join People, and it's known from now on.
    for (const id of eps) {
      const ep = this.endpoints.get(id);
      if (ep && ep.standing === 'unknown') ep.standing = 'known';
    }
    const moved = this.moveEndpoints(eps, into, intoChannel);
    for (const id of moved) {
      const m = this.messages.get(id);
      if (m && m.lane === 'requests') m.lane = 'people';
    }
    if (this.endpointsOf(from).length === 0) this.contacts.delete(from);
    const linkId = ulid();
    this.linksMade.set(linkId, { into, from, fromName, eps, moved, fromChannel });
    this.changed([intoChannel, ...(fromChannel ? [fromChannel] : [])], ['people', 'requests']);
    return { linkId, channelId: intoChannel };
  }

  /**
   * MA Connector for Mac's pairing (deskd courier.imsg.pair): the mock's Mac shows `BCDF-GHJK`; `BCDF-ZZZZ` is a Mac that
   * says it needs Full Disk Access; any other code isn't waiting. One Mac a desk.
   */
  private pairMac(p: Record<string, unknown>): unknown {
    const raw = typeof p['code'] === 'string' ? p['code'] : '';
    const code = raw.toUpperCase().replace(/[\s-]/g, '');
    if (!/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/.test(code)) throw refusal('bad_request', { reason: 'code' });
    if ([...this.accounts.values()].some((a) => a.kind === 'imessage')) throw refusal('conflict', { reason: 'too_many' });
    if (code !== 'BCDFGHJK' && code !== 'BCDFZZZZ') throw refusal('not_found', { reason: 'code' });
    const id = accountId('imessage');
    const device = { check: '4071 2958 3316' };
    const sync = code === 'BCDFZZZZ' ? { state: 'needs_you', reason: 'full_disk', path: 'connector', checkedAt: Date.now(), device } : { state: 'live', reason: null, path: 'connector', checkedAt: Date.now() - 120_000, device };
    this.accounts.set(id, { accountId: id, kind: 'imessage', label: 'Mac', address: '', state: 'ok', sending: true, signedIn: true, sync });
    this.changed([], [], { accounts: true });
    return { accountId: id, fingerprint: '3f2a-91c0', check: '4071 2958 3316' };
  }

  private addAccount(p: Record<string, unknown>): unknown {
    if (p['kind'] !== 'imap') throw refusal('bad_request', { reason: 'kind' });
    const address = typeof p['address'] === 'string' ? p['address'].trim() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw refusal('bad_request', { reason: 'address' });
    if (p['auth'] !== 'password' && p['auth'] !== 'app_password') throw refusal('bad_request', { reason: 'auth' });
    const secret = p['secret'];
    if (typeof secret !== 'string' || secret.length < 1 || secret.length > 8192 || /[\u0000-\u001f\u007f]/.test(secret)) throw refusal('bad_request', { reason: 'secret' });
    const server = p['server'] as Record<string, unknown> | undefined;
    if (server !== undefined) {
      const ok = typeof server['imapHost'] === 'string' && typeof server['smtpHost'] === 'string' && Number.isInteger(server['imapPort']) && Number.isInteger(server['smtpPort']) && (server['security'] === 'tls' || server['security'] === 'starttls');
      if (!ok) throw refusal('bad_request', { reason: 'server' });
    }
    const picked = p['provider'];
    if (picked !== undefined && !['gmail', 'icloud', 'fastmail', 'yahoo', 'outlook', 'other'].includes(picked as string)) throw refusal('bad_request', { reason: 'provider' });
    if (!this.control.imap) throw refusal('unavailable', { reason: 'medium' });
    if (picked === 'outlook') throw refusal('unavailable', { reason: 'oauth' });
    const linked = [...this.accounts.values()].filter((a) => a.kind === 'imap' || a.kind === 'jmap');
    if (linked.length >= 5) throw refusal('conflict', { reason: 'too_many' });
    this.control.signInsChecked += 1;
    const host = typeof server?.['imapHost'] === 'string' ? server['imapHost'] : '';
    if (host.startsWith('unreachable.')) throw refusal('unavailable', { reason: 'provider' });
    // The mock's provider refuses one password, so the refusal's words can be tested. Nothing of the secret is kept.
    const d = domainOf(address);
    const provider = d.startsWith('gmail.') ? 'Gmail' : d.startsWith('icloud.') || d.startsWith('me.') ? 'iCloud' : d.startsWith('yahoo.') ? 'Yahoo' : d.startsWith('fastmail.') ? 'Fastmail' : 'IMAP';
    if (secret === 'wrong-password') throw refusal('forbidden', { reason: 'sign_in', provider });
    const id = accountId('imap');
    const label = typeof p['label'] === 'string' && p['label'].trim() ? p['label'].trim() : provider === 'IMAP' ? d : provider;
    if ([...this.accounts.values()].some((a) => a.address === address.toLowerCase())) throw refusal('conflict', { reason: 'exists' });
    this.accounts.set(id, { accountId: id, kind: 'imap', label, address: address.toLowerCase(), state: 'syncing', sending: true, signedIn: true });
    this.changed([], [], { accounts: true });
    return { accountId: id };
  }
}

const desks = new Map<string, MockCourierDesk>();

/** One desk's store, made and seeded the first time it's asked: `d-personal…` with the full sample, any other with one thread. */
export function mockCourier(deskId: string): MockCourierDesk {
  let desk = desks.get(deskId);
  if (!desk) {
    desk = new MockCourierDesk(deskId);
    desk.seed(deskId.startsWith('d-personal') ? 'personal' : 'other');
    const init = (window as unknown as { __maCourierMockInit?: { state?: 'store' | 'switched_off'; imap?: boolean; old?: boolean; links?: boolean; keys?: boolean; safety?: boolean; keyChanged?: boolean; files?: boolean; memberRequest?: boolean } }).__maCourierMockInit;
    if (init?.state) desk.state = init.state;
    if (init?.links === true && deskId.startsWith('d-personal')) desk.seedLinks();
    if (init?.safety === true && deskId.startsWith('d-personal')) desk.seedSafety();
    if (init?.keyChanged === true && deskId.startsWith('d-personal')) desk.seedKeyChanged();
    if (init?.files === true && deskId.startsWith('d-personal')) desk.seedFiles();
    if (init?.memberRequest === true && deskId.startsWith('d-personal')) desk.seedMemberRequest();
    if (init?.links === false) for (const m of LINK_METHODS) desk.control.refuse[m] = 'not_found';
    if (init?.keys === false) desk.fingerprint = null;
    if (init?.imap === false) desk.control.imap = false;
    if (init?.old) {
      // A deskd before §21: every `courier.*` is `not_found` with no reason.
      for (const m of [...READS, 'courier.read.set']) desk.control.refuse[m] = 'not_found';
    }
    desks.set(deskId, desk);
  }
  return desk;
}

export const courierControl = {
  desk: (deskId: string): MockCourierDesk => mockCourier(deskId),
};
