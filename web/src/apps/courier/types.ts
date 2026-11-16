// Courier's wire as the office reads it: deskd API.md §21 (`courier.*`, the topic `courier.changed`). Every string here is desk
// content written by other people: shown as plain text only, never as HTML or a link. The one exception is a message's
// sanitized HTML, which is shown only inside the sandboxed frame (`frame.ts`).

export type Lane = 'people' | 'requests' | 'updates' | 'other' | 'spam' | 'trash';
export const LANES: readonly Lane[] = ['people', 'requests', 'updates', 'other', 'spam', 'trash'];
export type Medium = 'email' | 'ma' | 'imessage' | 'sms';
export const MEDIA: readonly Medium[] = ['email', 'ma', 'imessage', 'sms'];

export interface Endpoint {
  kind: string;
  value: string;
}

export interface Contact {
  contactId: string;
  /** The member's name for them, or the name the store kept; may be empty. Never a display name alone: show the address too. */
  name: string;
  endpoint: Endpoint;
  known: boolean;
}

/** Who sent a message: the member's own, or a contact record for the sender's endpoint (never a name in the message). */
export type Sender = { me: true } | ({ me: false } & Contact) | null;

export interface Last {
  messageId: string;
  medium: Medium;
  direction: 'in' | 'out';
  from: Sender;
  subject: string;
  snippet: string;
  at: number;
  read: boolean;
  accountId: string | null;
  /** The last message carries sender warnings (Wave 3.2), without saying which. */
  warned: boolean;
}

export interface Row {
  channelId: string;
  kind: 'direct' | 'group' | 'self';
  title: string;
  contacts: Contact[];
  lane: Lane;
  lastAt: number;
  count: number;
  unread: number;
  done: boolean;
  medium: Medium | null;
  last: Last | null;
}

export interface Auth {
  spf: string;
  dkim: string;
  dmarc: string;
  /** True only when DMARC passed. Null (no result) is unconfirmed too. */
  senderConfirmed: boolean | null;
  /** The transport's virus verdict: the raw message then asks before it downloads, as a dangerous attachment does. */
  virus?: boolean;
}

export type Danger = 'program' | 'script' | 'macros' | 'shortcut' | 'disk_image' | 'archive_programs' | 'html' | 'archive_unread';
export const DANGERS: readonly Danger[] = ['program', 'script', 'macros', 'shortcut', 'disk_image', 'archive_programs', 'html', 'archive_unread'];

export interface Attachment {
  part: string;
  name: string;
  type: string;
  bytes: number;
  inline: boolean;
  danger: Danger | null;
}

export interface Message {
  messageId: string;
  channelId: string;
  threadId: string;
  direction: 'in' | 'out';
  medium: Medium;
  accountId: string | null;
  from: Sender;
  at: number;
  subject: string;
  snippet: string;
  lane: Lane;
  read: boolean;
  bulk: boolean;
  senderKnown: boolean;
  status: 'received' | 'queued' | 'sending' | 'sent' | 'failed';
  hasHtml: boolean;
  /** The text as far as this answer carries it (2,000 characters in a thread, a 150,000 slice from `courier.message`). */
  text: string;
  /** More text past `text`: read it with `courier.message`. */
  textMore: boolean;
  /** Where the next slice starts, or null at the end (`courier.message` only). */
  textNext: number | null;
  parse: { state: string; reason: string } | null;
  auth: Auth | null;
  attachmentCount: number;
  attachments: Attachment[];
  /** `filter`: the desk's learning filter put it in Spam, not the member (Wave 3.2). */
  screen: 'filter' | null;
  /** Sender warnings made as it arrived (API.md §21, "Spam and safety"), each shown as a neutral card. */
  warnings: Warning[];
}

/** A sender warning (Wave 3.2). Every string is the desk's reading of a stranger's mail: plain text only. */
export type Warning =
  | { kind: 'not_usual_address'; contactId: string; name: string }
  | { kind: 'lookalike'; domain: string; like: string }
  | { kind: 'punycode'; domain: string }
  | { kind: 'name_held_address' };

/** "Save to Files" done (`courier.attachment.save`). */
export interface Saved {
  path: string;
  name: string;
  already: boolean;
}

/** A Download or a raw message, written and checked: the file name to save it under (cleaned), its size and danger. */
export interface Downloaded {
  name: string;
  size: number;
  danger: Danger | null;
}

/** "Show": the picture the sandbox drew again from the attachment's pixels. */
export interface Preview {
  blob: Blob;
  width: number;
  height: number;
}

/** An archive's file list, as the sandbox read it without unpacking: at most 500 entries, names cleaned. */
export interface Archive {
  format: 'zip' | 'tar';
  entries: { name: string; bytes: number; dir: boolean; encrypted: boolean; danger: Danger | null }[];
  total: number;
  truncated: boolean;
  danger: Danger | null;
}

export interface Channel {
  channelId: string;
  kind: 'direct' | 'group' | 'self';
  title: string;
  contacts: Contact[];
}

export interface Thread {
  channel: Channel;
  messages: Message[];
  next: string | null;
}

export interface Hit {
  messageId: string;
  channelId: string;
  lane: Lane;
  medium: Medium;
  direction: 'in' | 'out';
  from: Sender;
  subject: string;
  snippet: string;
  /** Character ranges in `snippet` that matched, `[start, end)`. */
  matches: [number, number][];
  at: number;
  read: boolean;
  accountId: string | null;
}

export type StatusState = 'on' | 'off' | 'unavailable';
export interface Status {
  state: StatusState;
  reason: string | null;
  lanes: Record<Lane, { count: number; unread: number }>;
  drafts: number;
  waiting: number;
  failed: number;
  pending: number;
  sending: boolean;
}

export type AccountKind = 'desk' | 'imap' | 'jmap' | 'ma' | 'imessage';
export interface Account {
  accountId: string;
  kind: AccountKind;
  label: string;
  address: string;
  state: string;
  sending: boolean;
  /** Linked mailboxes only: whether its sealed sign-in is there and opens. False is "Sign in again". */
  signedIn: boolean | null;
  /** Linked mailboxes only: the named provider its servers are (`sync.provider`), so "Sign in again" opens its tile. */
  provider: string | null;
  /** The Mac's iMessage account only: how its path stands (`sync`, API.md §21). */
  mac?: MacSync | null;
}

/** A Mac account's state as the desk sees it: MA Connector (`path: connector`) or BlueBubbles. Never an address or a key. */
export interface MacSync {
  state: 'connecting' | 'syncing' | 'live' | 'waiting' | 'away' | 'needs_you' | 'off' | string;
  reason: string | null;
  path: 'connector' | 'bluebubbles' | string;
  /** When the Mac was last heard from, epoch ms. */
  checkedAt: number | null;
  /** MA Connector: the pairing's check number, which the Mac shows too ("1234 5678 9012"). */
  check: string | null;
}

export interface Block {
  kind: 'address' | 'domain';
  value: string;
}

export interface Draft {
  draftId: string;
  channelId: string | null;
  medium: Medium | null;
  accountId: string | null;
  to: string[];
  subject: string;
  text: string;
  version: number;
  updatedAt: number;
  replyTo: string | null;
}

export interface Sent {
  messageId: string;
  outboundId: string;
  undoUntil: number;
}

/** One `courier.changed` event: ids and lanes only, never a sender, a subject or text. `channels` null is "refresh what's shown". */
export interface Changed {
  type: 'snapshot' | 'changed';
  channels: string[] | null;
  lanes: Lane[];
  accounts: boolean;
  drafts: boolean;
  outbound: boolean;
}

/** A link the sandbox found in a message's HTML, read from its `data-ma-*` (never an `href`: it has none). */
export interface MailLink {
  /** The destination made plain by the sandbox, checked again here: only http, https, mailto and tel are kept. */
  href: string;
  /** The host to show beside it, from the destination itself. */
  host: string;
  scheme: 'http' | 'https' | 'mailto' | 'tel';
  /** `mismatch`, `ip`, `punycode`, `userinfo`, `tracker`. */
  warn: string[];
  /** The link's own words, as the message shows them. */
  text: string;
}

/** What an account sign-in sends: the secret goes once and is never kept by the office. */
export interface AccountInput {
  address: string;
  auth: 'password' | 'app_password';
  secret: string;
  username?: string;
  label?: string;
  /** The tile picked (`courier.accounts.providers`' id), for every named one; Other sends `server` instead. */
  provider?: string;
  server?: { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; security: 'tls' | 'starttls' };
}

// ---------------------------------------------------------------- one person across channels (the Designer's flow 11)

/** Where a suggestion comes from, strongest first (the spec's table): a contact card of any kind, a signature, a name alone. */
export type SuggestSource = 'mac' | 'card' | 'provider' | 'signature' | 'name';
export type Strength = 'card' | 'hint' | 'name';

/** "Is this also {name}?": an endpoint that may belong to a person the member already has. Never linked without a press. */
export interface Suggestion {
  endpoint: Endpoint;
  /** The person the endpoint is on now (its own, usually), and that person's conversation. */
  fromContactId: string;
  channelId: string | null;
  into: { contactId: string; name: string };
  source: SuggestSource;
  /** iCloud or Fastmail, for "Your {provider} contacts list this…". */
  provider: string | null;
  strength: Strength;
}

/** Where an endpoint on a person came from, for the person view's line. */
export type EndpointSource = 'added' | 'card' | 'mac' | 'provider' | 'message';

export interface PersonEndpoint {
  kind: string;
  value: string;
  standing: string;
  source: EndpointSource | null;
  provider: string | null;
  lastInboundAt: number | null;
}

/** A person: the member's name for them and every way to reach them (`courier.contact.get`). */
export interface Person {
  contactId: string;
  name: string;
  named: boolean;
  endpoints: PersonEndpoint[];
}

/** What a typed email or number already is on this desk, for the person view's Add. */
export interface Lookup {
  contactId: string | null;
  name: string;
  /** Endpoints on that person, this one included. */
  endpoints: number;
  messages: number;
}

/** The desk's own keys, public facts only (`courier.keys`): the contract's fingerprint, which an invite link carries. */
export interface DeskKeys {
  available: boolean;
  fingerprint: string | null;
}

/** A pinned key's state (`courier.contact.keys`, API.md §21 "The desk's address and members' messages"). */
export type KeyState = 'none' | 'unverified' | 'verified' | 'changed';

/**
 * One member address of a contact, as this desk pinned it: whether it's checked, the safety number (60 digits, 12 groups of
 * 5) and, when the key changed, the new one and how many messages are held until the member checks it.
 */
export interface MemberKey {
  address: string;
  state: KeyState;
  /** How it was pinned or checked: `invite`, `safety_number`, `first_use`, `link`, … */
  source: string | null;
  safetyNumber: string | null;
  verifiedAt: number | null;
  newSafetyNumber: string | null;
  held: number;
}
