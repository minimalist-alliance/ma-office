// The interface every desk connection implements (design 3.9, docs/interfaces/desk-runtime.md
// section 7). The real one is `rtc/rtcDeskLink.ts`: one WebRTC PeerConnection per desk through the
// gateway. Nothing outside `src/desk/` may depend on how a link is carried.
import type { A2aPage, Agent, AgentCaps, AttachCapsView, AuditPage, KeyMeta, LimitsView, Message, ModelInfo, Proposal, Provider, ThreadSnapshot, Timer, TimerList, WorkspaceFile, WorkspaceView } from '../../agent/src/client/types';
import type { ActivityRow, NotebookRec, PageRec, SearchHit, TabRec, VersionMeta } from '../../notebook/src/model/types.ts';
import type { TrafficStop } from './trafficStop';
import { guildAccess } from '../guild/access';
import type { GuildHello, GuildSettings, GuildUsage } from '../guild/api';

/** The `live.link` states of design 3.13. `resting`: the idle rule closed its sessions, and only the watch remains. */
export type LinkState = 'idle' | 'signaling' | 'connecting' | 'open' | 'resuming' | 'retrying' | 'denied' | 'resting';

/**
 * Result of `desk.status.get` (services/deskd/docs/API.md section 4). Every field is always present;
 * `deskId` and `instanceType` are null until deskd reads IMDS, `rtcVersion` until desk-rtc has answered.
 */
export interface DeskStatus {
  deskId: string | null;
  deskdVersion: string;
  rtcVersion: string | null;
  bootId: string;
  uptimeSec: number;
  javaVersion: string;
  instanceType: string | null;
}

/** `live` streams, `warm` keeps the encoder paused and ready, `off` stops it (docs/interfaces/desk-runtime.md 8.4). */
export type StreamState = 'live' | 'warm' | 'off';

/**
 * A tab in the desk's Chromium. `url` and `title` come from web pages, so they're untrusted text. `tabId` is
 * opaque, and changes if Chromium restarts.
 */
export interface BrowserTab {
  tabId: string;
  url: string;
  title: string;
  loading: boolean;
  active: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The page was refused protected playback (EME), once per page (deskd da3738de, TD-225); `browser/protectedPlayback.ts` is the one reader. */
  protectedMedia?: { at: string; keySystem: string };
}

/** RPC methods the app calls, with their result types. Grows with the apps. */
export interface DeskRpc {
  'desk.status.get': DeskStatus;
  /** Whether this session's member is looking at the desk (task 46, `attention.ts`). Not a mutation; the last one wins. */
  'desk.attention.set': { seen?: boolean; frozen?: boolean };
  'browser.stream.set': { state?: StreamState };
  'browser.text.insert': Record<string, never>;
  /** Chromium's own zoom of the tab on screen (API.md section 10, "On a phone"). Not used: a pinch zooms the picture here. */
  'browser.pinch': Record<string, never>;
  'browser.tab.list': { tabs: BrowserTab[] };
  /** `netError` is a normal result: Chromium shows its own error page in the stream. */
  'browser.tab.navigate': { tabId: string; netError?: string };
  'browser.tab.back': { tabId: string };
  'browser.tab.forward': { tabId: string };
  'browser.tab.reload': { tabId: string };
  'browser.tab.activate': { tabId: string };
  'browser.tab.open': { tabId: string };
  'browser.tab.close': Record<string, never>;
  /** The reply says the desk's clipboard holds it. Not a mutation, so no `idem`. */
  'browser.clipboard.write': Record<string, never>;
  /** A string that's never empty, or null if the clipboard holds no text. Untrusted, as a page can put anything there. */
  'browser.clipboard.read': { text: string | null };
  /** The desk's parts (draft ADR "data export and transfer", section 7). Sizes are an estimate. */
  'data.parts.list': { parts: DataPart[]; helperVersion?: string };
  /** One page of a part's files, at most 2,000. `next` is null on the last. */
  'data.manifest': { entries: DataEntry[]; next: string | null };
  /** The file's bytes follow on `bulk` as CHUNK frames with this `transferId`. `size` counts from byte 0. */
  'data.read': { transferId: number; size: number; mtimeMs: number };
  'data.read.stop': Record<string, never>;
  // The Agent app (deskd API.md section 11). `web/agent` holds the shapes. `agent.key.add` is the one call with a key in it, so
  // nothing that handles params may log or keep them.
  // The Files app (services/deskd/docs/files.md). Owner sessions only; `files.read`'s bytes follow on `bulk`.
  'files.list': { entries: FileEntry[]; next: string | null; skipped: number };
  'files.stat': { entry: FileEntry; sniff: FileSniff | null };
  'files.search': { entries: (FileEntry & { path: string })[]; truncated: boolean };
  'files.usage': FilesUsage;
  'files.mkdir': { created: boolean };
  'files.rename': { path: string; replaced: string | null };
  'files.delete': { results: { path: string; ok: boolean; trashId?: string; code?: string }[] };
  'files.trash.list': { items: TrashItem[]; next: string | null };
  'files.trash.restore': { path: string };
  'files.trash.empty': { deleted: number; freedBytes: number };
  'files.read': { transferId: number; size: number; mtimeMs: number };
  'files.read.stop': Record<string, never>;
  'files.upload.begin': { uploadId: string; transferId: number; offset: number; window: number; size: number; expiresAt: string };
  'files.upload.status': { uploadId: string; path: string; size: number; committed: number; transferId: number; window: number; expiresAt: string };
  'files.upload.finish': { path: string; size: number; mtimeMs: number; sha256: string; replaced: string | null };
  'files.upload.abort': Record<string, never>;
  'agent.providers': { providers: Provider[] };
  'agent.list': { agents: Agent[] };
  'agent.create': { agent: Agent };
  'agent.update': { agent: Agent };
  'agent.bind': { agent: Agent };
  'agent.thread.get': ThreadSnapshot;
  'agent.message.send': { messageId: string; runId: string };
  'agent.attach.put': { uploadId: string; received: number; complete: boolean };
  'agent.attach.remove': Record<string, never>;
  'agent.attach.caps': AttachCapsView;
  'agent.attach.caps.set': AttachCapsView;
  'agent.run.stop': Record<string, never>;
  'agent.seen': Record<string, never>;
  'agent.key.list': { keys: KeyMeta[] };
  'agent.key.add': { key: KeyMeta };
  'agent.key.delete': Record<string, never>;
  'agent.key.models': { models: ModelInfo[] };
  'agent.limits.get': LimitsView;
  'agent.limits.set': LimitsView;
  'agent.audit.list': AuditPage;
  // Task 49 (services/desk-agent/docs/multi-agent.md): many agents on a desk, the lead's proposals, messages between agents,
  // workspaces, timers and icons. deskd answers every `agent.*` method for the desk's owner only.
  'agent.get': { agent: Agent };
  'agent.delete': Record<string, never>;
  'agent.links.set': { agent: Agent };
  'agent.caps': { caps: AgentCaps };
  'agent.proposal.answer': { proposal: Proposal };
  'agent.a2a.list': A2aPage;
  'agent.workspace.get': WorkspaceView;
  'agent.workspace.read': WorkspaceFile;
  'agent.workspace.delete': { usedBytes: number };
  'agent.workspace.share': { agent: Agent };
  'agent.timer.list': TimerList;
  'agent.timer.set': { timer: Timer };
  'agent.timer.delete': Record<string, never>;
  'agent.icon.upload': { agent?: Agent };
  'agent.icon.get': { png: string; version: number };
  // Notebook (API.md section 13). Flat, in pages: repeat with `next` until it's null. `part`: text to join until `next` is null, then `JSON.parse`.
  'notebook.tree': { notebooks: NotebookRec[]; tabs: TabRec[]; pages: PageRec[]; rev: number; next: string | null };
  'notebook.notebook.create': { notebook: NotebookRec; tab: TabRec; page: PageRec };
  'notebook.notebook.rename': Record<string, never>;
  'notebook.tab.create': { tab: TabRec; page: PageRec };
  'notebook.tab.rename': Record<string, never>;
  'notebook.tab.recolor': Record<string, never>;
  'notebook.tab.addAtPage': { tab: TabRec };
  'notebook.page.create': { page: PageRec };
  'notebook.page.move': Record<string, never>;
  'notebook.page.trash': Record<string, never>;
  'notebook.page.restore': Record<string, never>;
  // Colors (ADR 0091): a page's label, a copy of a page, and a page from a notebook file.
  'notebook.page.label': Record<string, never>;
  'notebook.page.duplicate': { page: PageRec };
  'notebook.page.import': { page: PageRec };
  'notebook.page.content': { part: string; next: string | null };
  'notebook.version.list': { versions: VersionMeta[] };
  'notebook.version.get': { meta: VersionMeta | null; part: string; next: string | null };
  'notebook.version.save': { version: VersionMeta | null };
  'notebook.version.restore': Record<string, never>;
  'notebook.version.asOf': { versionId: string | null };
  'notebook.activity': { rows: ActivityRow[] };
  'notebook.activity.days': { days: string[] };
  'notebook.search': { hits: SearchHit[] };
  'notebook.settings.set': Record<string, never>;
  // The Browser's simplified view (task 47): `deskd` API.md section 14 (`sub/minified-stage-a`). `simple/source.ts` is
  // the only caller, and `simple/mdoc.ts` reads `mdoc` field by field from a whitelist, so these stay loose here.
  'browser.minified.get': MinifiedView & { mdoc?: unknown; unchanged?: boolean };
  /** `{done: true}`, or `{done: false, reason}`; a `media` action also answers `paused`, `time`, `duration` and `muted`. */
  'browser.minified.act': { done?: boolean; reason?: string; reformatted?: boolean; paused?: boolean; time?: number; duration?: number; muted?: boolean };
  /** An image the tab already loaded, from Chromium's own copy: base64 bytes, never an address (T47-5). */
  'browser.minified.image': { imageId?: string; mime?: string; data?: string };
  /** An island's box on the real page now (T47-4). `live: false` says why, in `reason`. */
  'browser.minified.island': { islandId?: string; kind?: string; epoch?: number; live?: boolean; reason?: string; rect?: unknown; viewport?: unknown; dpr?: number; playing?: boolean; muted?: boolean };
  'browser.minified.site.get': MinifiedSite;
  'browser.minified.site.set': MinifiedSite;
  'browser.minified.sites.list': { sites: MinifiedSite[] };
  'browser.minified.sites.clear': Record<string, never>;
  // Site sign-ins (#11, deskd API.md section 10 "Signing in"). `browser/extensions/signIns.ts` reads each reply field by
  // field, so these stay loose. A passwords file's bytes go on `bulk` between `begin` and `finish`, and nowhere else.
  'browser.extensions.list': { extensions?: unknown };
  'browser.extension.open': { tabId?: string; page?: string };
  'browser.extension.close': { closed?: number };
  'browser.import.begin': { uploadId: string; transferId: number; window: number; size: number };
  'browser.import.finish': { kind?: string; found?: number; added?: number; alreadySaved?: number; refused?: number };
  'browser.import.abort': Record<string, never>;
  /** The spec's Stop (section 9.5), asked of the Desk Engineer: numbers only. `not_found` from a deskd without it. */
  'browser.passwords.count': { saved?: number };
  'browser.passwords.clear': { deleted?: number };
  /** ADR 0073's per-site ad switch: proposed in section 14, waiting on the System Engineer's blocklist; `not_found` until then. */
  'browser.adblock.site.set': { host?: string; on?: boolean };
  // A Guild Desk (task 48, contract 3.3 in `~/ma-coord/guild-eng.md`). `settings.*` for the Founder or an Officer with
  // `manage_agents`, `usage.get` for the Founder and Officers; deskd checks, and answers `forbidden` to anyone else.
  'guild.hello': GuildHello;
  'guild.settings.get': GuildSettings;
  'guild.settings.set': GuildSettings;
  'guild.usage.get': GuildUsage;
  // Desk apps (API.md section 19, ADR 0054). The shapes are read leniently where they're used (`deskapps/`): they're the
  // desk's word, and an app's results are the app's own.
  'apps.list': Record<string, unknown>;
  'apps.catalog.get': Record<string, unknown>;
  'apps.install': { id: string; version: string; state: string };
  'apps.remove': Record<string, never>;
  'apps.start': { id: string; state: string; problem: string | null };
  'apps.stop': { id: string; state: string; problem: string | null };
  'apps.view.get': Record<string, unknown>;
  'apps.call': unknown;
  'apps.mutate': unknown;
}

/** One event of a topic as deskd sends it (API.md section 5), unflattened, for a relay that must pass `data` on as it came. */
export interface RawTopicEvent {
  type: string;
  seq: number;
  data: unknown;
}

/** An entry of the Files tree: `size` is null for a folder, `mtimeMs` whole milliseconds (files.md section 2). Names are untrusted text. */
export interface FileEntry {
  name: string;
  type: 'file' | 'dir';
  size: number | null;
  mtimeMs: number;
}

/** What `files.stat` made of a file's first 4 KiB, by magic bytes, never by name. */
export type FileSniff = { kind: 'image'; format: string } | { kind: 'other' };

export interface FilesUsage {
  drive: { totalBytes: number; usedBytes: number; freeBytes: number };
  files: { bytes: number; approx: boolean };
  trash: { bytes: number; items: number };
  floorBytes: number;
  uploadableBytes: number;
  /** A free desk's Files cap (ADR 0090) and what it counts (the tree, the trash and unfinished uploads). Absent from an older desk; null with no cap. */
  capBytes?: number | null;
  capUsedBytes?: number | null;
  computedAt: string;
}

export interface TrashItem {
  id: string;
  name: string;
  originalPath: string;
  type: 'file' | 'dir';
  bytes: number | null;
  deletedAt: string;
  purgeAt: string;
}

export interface DataPart {
  part: string;
  label?: string;
  files?: number;
  bytes?: number;
}

/** `path` is relative to the part, `/`-separated, as stored on the desk. Untrusted text. */
export interface DataEntry {
  path: string;
  type: 'file' | 'dir' | 'link';
  size?: number;
  mtimeMs?: number;
  mode?: number;
  target?: string;
}

/** deskd's CREDIT on `bulk` (JSON, kind 16): more credit for an upload, and how much the desk has written (files.md 5.2). */
export interface CreditMessage {
  /** File bytes the client may now send. 0 is a pure acknowledgement. */
  bytes: number;
  /** The offset written to the partial. */
  committed?: number;
  /** Terminal: `no_space`, `credit_violation`, `seq`, `superseded`, `aborted`, `io` or `expired`. The transfer is over, the session isn't. */
  error?: string;
}

/**
 * One session's `bulk` (channel 5): a file's bytes in CHUNK frames, and CREDIT back; the Files app sends CHUNKs the other way
 * (files.md 5). A new session is a new one.
 */
export interface BulkChannel {
  /** Hears every CHUNK on this session's `bulk`. One listener: the export page's, or the Files app's (`apps/files/hub.ts`), never both on one session. */
  onChunk: ((id: number, seq: number, end: boolean, payload: Uint8Array) => void) | null;
  /** Lets transfer `id` send `bytes` more. */
  credit(id: number, bytes: number): void;
  /** The desk's CREDIT frames (upload progress). One listener: the Files app's, which fans it out (`apps/files/hub.ts`). */
  onCredit: ((id: number, msg: CreditMessage) => void) | null;
  /** One upload CHUNK (BIN, no END), at most 16,372 bytes. False if the channel isn't open. */
  send(id: number, seq: number, payload: Uint8Array): boolean;
  /** Resolves once the channel has drained below 1 MiB buffered (it pauses above and resumes at 256 KiB). Resolves at once if it can't tell. */
  drained(): Promise<void>;
}

/** A DATA message over this closes the whole session, Browser included, with 4001 (API.md section 2). Nothing may send one. */
export const MAX_COLLAB_MESSAGE = 4 * 1024 * 1024;

/** `reset`: deskd's `{"t":"reset"}`, as the desk's sync service restarted or isn't there; the channel carries on. `ended`: this session is gone. */
export type CollabEnd = 'reset' | 'ended';

/** One session's `collab` (channel 3): one virtual WebSocket. A new session is a new one. */
export interface CollabChannel {
  /** It can carry messages now. Each data channel opens on its own, so a session can be up a moment before this one. */
  readonly open: boolean;
  onOpen: (() => void) | null;
  /** One whole message of Hocuspocus's protocol. One listener: the Notebook's. */
  onMessage: ((bytes: Uint8Array<ArrayBuffer>) => void) | null;
  onEnd: ((why: CollabEnd) => void) | null;
  /** False if it didn't go: over `MAX_COLLAB_MESSAGE`, or the channel isn't open. */
  send(bytes: Uint8Array): boolean;
}

export interface RpcOptions {
  /** Required on a mutation (deskd API.md section 4). Keep it across a retry of a lost reply. */
  idem?: string;
  /** deskd gives up at this point. The link waits a little longer than this for the answer. */
  deadlineMs?: number;
}

/** Widget content for one app, sent by the desk, kept in memory only (design 3.8). */
export interface AppSummary {
  badge?: number;
  widget?: { title: string; text?: string; foot?: string };
  /** Provider monograms for the Agent tile. */
  marks?: string[];
}

export type AgentActivity =
  | { state: 'none' }
  | { state: 'no-key' }
  | { state: 'idle'; count?: number }
  | { state: 'working'; task?: string; count?: number }
  | { state: 'needs-you' }
  | { state: 'paused-limit' }
  | { state: 'error' };

export interface SummaryMessage {
  seq: number;
  /** `snapshot` replaces what's held, `patch` adds to it (design 3.9). */
  type?: string;
  agent?: AgentActivity;
  apps?: Record<string, AppSummary>;
}

/** Every event is a full snapshot, at most about 4 a second, and links clicked in the page count too. */
export interface BrowserTabsMessage {
  seq: number;
  tabs: BrowserTab[];
}

/** Something on the desk took the clipboard. There's no text in it, ever, and it isn't a member's copy: a page can do this by itself. */
export interface BrowserClipboardMessage {
  seq: number;
  type: string;
}

/**
 * One Browser download as the desk tells of it (topic `browser.downloads`, ADR 0092, LS-31). `name` is the file's name, from
 * web content: show it as plain text only. Nothing says where it came from.
 */
export interface BrowserDownload {
  id: string;
  name: string;
  state: 'inProgress' | 'completed' | 'canceled';
  receivedBytes: number;
  /** 0 when the size isn't known. */
  totalBytes: number;
  /** Where the finished file is in Files, only when it landed there; no image puts Browser downloads there yet. */
  filesPath?: string;
  /**
   * The download's own final http(s) address, for "Get it on this device" (#9). Asked of the Desk Engineer; no deskd sends it
   * yet, so the button stays hidden. Untrusted, and opened only as http or https (`browser/openOnDevice.ts`).
   */
  url?: string;
}

/** The desk's newest Browser downloads, newest first, at most 5. Every event is the whole list; a deskd before it refuses the SUB. */
export interface BrowserDownloadsMessage {
  seq: number;
  downloads: BrowserDownload[];
}

/**
 * A link a page on the desk tried to open and only the member's own device can (topic `browser.links`, event `linkOut`,
 * API.md section 10 "Links out"; #9). Every field is untrusted: `browser/handoff.ts` is the one reader. No first event and
 * nothing kept; a deskd before it refuses the SUB with `not_found`.
 */
export interface BrowserLinkOutMessage {
  seq: number;
  type?: string;
  url?: string;
  scheme?: string;
  displayText?: string;
  reason?: string;
  at?: string;
  tabId?: string;
}

/** A box in the picture, normalized to the whole picture (0 to 65535), as input is. */
export interface NormBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Topic `browser.view` (API.md section 10, "On a phone"): whose view the tabs have. While a phone's session has them,
 * Chromium draws the phone's view in `region` of the `screen` (screen pixels) and `field` is what has focus in the tab on
 * screen (never its value). A desk's own view is `{mode: "desktop", field: null}`. A deskd before it refuses the SUB.
 */
export interface BrowserViewMessage {
  mode: 'phone' | 'desktop';
  sessionId?: string;
  width?: number;
  height?: number;
  scale?: number;
  region?: { x: number; y: number; width: number; height: number };
  screen?: { width: number; height: number };
  field: { tabId?: string; kind: string; enterKey: string | null; box?: NormBox } | null;
}

/** `desk.attention.set`'s `device` on a phone: the CSS size of the box the Browser's picture fills. */
export interface PhoneDevice {
  kind: 'phone';
  width: number;
  height: number;
}

/** The whole list of a desk's agents, on each change. No first event while `desk-agent` isn't running. */
export interface AgentStateMessage {
  seq: number;
  type?: string;
  agents: Agent[];
  /** The tier's values as the desk applies them (task 49). */
  caps?: AgentCaps;
}

/** `snapshot` with `messages` and perhaps `omitted`, `message` with `message`, `delta` with `messageId`, `runId` and `text`. */
export interface AgentConversationMessage {
  seq: number;
  type?: string;
  messages?: Message[];
  omitted?: number;
  message?: Message;
  messageId?: string;
  runId?: string;
  text?: string;
}

/** Something in the Notebook's tree changed: read it again if `rev` is newer. On subscribing, the first says where it stands. At most 4 a second. */
export interface NotebookTreeMessage {
  seq: number;
  rev: number;
}

/** A site's memory on the desk (API.md section 14): keyed by its registrable domain, which `deskd` works out from the host. */
export interface MinifiedSite {
  host?: string;
  view?: 'simplified' | 'stream' | null;
  sensitive?: boolean;
  lastFallback?: string;
}

/** What a tab shows in the simplified view (API.md section 14): `get`'s answer and the topic's `snapshot` and `changed`. */
export interface MinifiedView {
  tabId?: string;
  rev?: number;
  view?: 'simplified' | 'stream' | 'pending' | 'closed';
  fallback?: { reason?: string; cause?: string };
}

/**
 * Topic `browser.minified:<tabId>` (API.md section 14): `snapshot` and `changed` say to `get` the document again,
 * `patch` changes it in place from `base` to `rev`. Read loosely: `simple/source.ts` checks every field.
 */
export interface BrowserMinifiedEvent extends MinifiedView {
  type: string;
  seq: number;
  base?: number;
  at?: number;
  remove?: number;
  insert?: unknown;
  head?: unknown;
}

/** Whether any session is looking at the desk, and whether it has frozen its Chromium for want of one (task 46). */
export interface DeskAttentionMessage {
  seq: number;
  type?: string;
  seen?: boolean;
  frozen?: boolean;
}

/** The Files tree changed (files.md section 7): the folders whose listing changed (`null`: more than 50, refresh what you show). */
export interface FilesChangesMessage {
  seq: number;
  type?: string;
  dirs?: string[] | null;
  usage?: boolean;
  trash?: boolean;
}

/**
 * Proposed (the free tier, S-119; STATUS.md "For the Desk Engineer"): the desk's container is being held back on its
 * shared host, from its own cgroup `cpu.stat`. No deskd serves it yet, so a SUB is refused and nothing is ever said.
 */
export interface DeskContentionMessage {
  seq: number;
  type?: string;
  held?: boolean;
}

export type LinkTopics = {
  /** Installed apps (API.md section 19): `apps.list`'s result, whole, on every change. Read by `deskapps/door.ts`. */
  apps: { seq: number; type?: string; available?: unknown; reason?: unknown; apps?: unknown };
  'files.changes': FilesChangesMessage;
  summary: SummaryMessage;
  'desk.attention': DeskAttentionMessage;
  'desk.contention': DeskContentionMessage;
  'browser.tabs': BrowserTabsMessage;
  'browser.clipboard': BrowserClipboardMessage;
  'notebook.tree': NotebookTreeMessage;
  'agent.state': AgentStateMessage;
  [conversation: `agent.conversation:${string}`]: AgentConversationMessage;
  [minified: `browser.minified:${string}`]: BrowserMinifiedEvent;
  'browser.downloads': BrowserDownloadsMessage;
  'browser.links': BrowserLinkOutMessage;
  'browser.view': BrowserViewMessage;
};

/** What Platform last reported about this desk, through `connect` or the gateway. */
export interface LinkDeskState {
  state: string | null;
  phase: string | null;
  queuePosition: number | null;
  stopAt: string | null;
  /** Why a stop is announced (`data_guard`, ...), when the platform says. */
  stopReason?: string | null;
  /** A traffic stop's detail, from `desk.stopping` (TD-162). */
  stopDetail?: TrafficStop | null;
  /**
   * When the link last heard any of this, on this tab's clock (`Date.now()`). A desk list asked for before then is
   * older, and doesn't overrule it (`setDeskList`). Left out, the list always wins.
   */
  heardAt?: number;
}

/** Everything a link reports besides its state. Changes often, so none of it may drive a panel render. */
export interface LinkDetails {
  /** The session has been lost for 30 s or more. */
  unreachable: boolean;
  path: 'udp' | 'tcp' | 'relay' | null;
  /** The last `ctl` round trip. */
  rttMs: number | null;
  desk: LinkDeskState | null;
  /** `connect` said no for a reason the member should see (contract 0.3.11). Kept until a `connect` answers. */
  refusal: DeskRefusal | null;
  /** `connect` said `503 free_capacity_wait`: a free desk is waiting for room, and the link asks again at the pace given. */
  busy?: boolean;
}

/**
 * `account_suspended` and `account_inactive` say the membership isn't active, with a billing link if it's a good one.
 * `desk_unavailable` says nothing about why, so the page shows only the support address.
 */
export interface DeskRefusal {
  kind: 'suspended' | 'inactive' | 'unavailable' | 'data_guard';
  /** `details.billingUrl`, only if it passes `siblingUrl`. */
  billingUrl: string | null;
  /** `data_guard` only (ma-platform ADR 0110): the platform's own words, shown as given. */
  message?: string | null;
  /** `data_guard` only: `details.resumesAt`, the member's next billing day. */
  resumesAt?: string | null;
}

/** The desk's Browser as media, for one session. No RTP flows on it until `browser.stream.set` says `live`. */
export interface BrowserMedia {
  /** Video and audio together, for one `<video playsinline>`. Its tracks end with the session. */
  stream: MediaStream;
  /** False when the desk answered `m=video 0`: this browser offered no constrained-baseline H.264. */
  canPlayVideo: boolean;
  /** Milliseconds since this session last carried sound from the desk, Infinity before any (`desk/sound.ts`). */
  silentFor?: () => number;
}

/**
 * Input for the desk's Browser, for one session (docs/interfaces/desk-runtime.md 8.6). `x` and `y` are
 * normalized to the picture, 0 to 65535. All of it writes straight to a channel, with nothing queued here.
 */
export interface BrowserInput {
  /** False when `input` has anything buffered, so this one went nowhere: keep only the newest position. */
  move(x: number, y: number): boolean;
  button(down: boolean, button: number, x: number, y: number): void;
  wheel(x: number, y: number, dx: number, dy: number): void;
  key(down: boolean, keysym: number): void;
  releaseAll(): void;
}

export interface DeskLink {
  readonly deskId: string;
  /** Current state. Listen with `onStatus`. */
  status(): LinkState;
  onStatus(fn: (state: LinkState) => void): () => void;
  details(): LinkDetails;
  onDetails(fn: () => void): () => void;
  /** `true` when a real desk can answer. */
  readonly available: boolean;
  /** Idempotent while the link is active. After a stop, it starts it again. */
  connect(): void;
  close(): void;
  /**
   * The member focused this desk or opened one of its apps. Wakes it only if `connect` says it's
   * stopped. Nothing else may wake a desk: rendering, refreshes and retries all send `start: false`.
   */
  wake(): void;
  /**
   * `GET /v1/me` says the membership is active again (paying brings the desks back, and nothing else tells this tab).
   * A link refused for the membership forgets the refusal and asks `connect` once more, with `start: false`. Anything
   * else does nothing, and a desk that can't be opened is never asked again.
   */
  recheck(): void;
  /** The idle rule (`idle.ts`): close this desk's sessions and keep only the watch. Never wakes anything. */
  rest(): void;
  /** The idle rule no longer holds: open a session again, with `start: false`. Does nothing unless resting. */
  reopen(): void;
  /** Input the app handled itself, not on channels 6 and 7. Goes to the desk as `ACTIVITY`, at most once a minute. */
  reportActivity(): void;
  /**
   * Whether the member is looking at this desk (`attention.ts`). Goes as `desk.attention.set` on change and again on each
   * new session. Never wakes anything: with no session open, it waits for one.
   */
  setSeen(seen: boolean): void;
  /**
   * The phone this office is on, while its Browser shows the real page here, or null (API.md section 10, "On a phone"):
   * goes with every `desk.attention.set`, so the desk lays the tabs out for it. Never for a keyboard coming or going.
   */
  setDevice?(device: PhoneDevice | null): void;
  /** This session's id, to tell whether `browser.view`'s phone is this one. Null with no session. */
  currentSessionId?(): string | null;
  /**
   * This session's desk said yes to `desk.attention.set`, so it holds an unseen session's `live` at `warm`'s cost and
   * sends media again the moment it's looked at (deskd API.md section 10, "Nobody looking"). False on a desk before that.
   */
  knowsAttention?(): boolean;
  /** One RPC. Rejects with `DeskNotConnected` when there is no open link. */
  call<M extends keyof DeskRpc>(method: M, params?: Record<string, unknown>, options?: RpcOptions): Promise<DeskRpc[M]>;
  /** This session's media, or null when no session is open. An ICE restart keeps it; a new session replaces it. */
  media(): BrowserMedia | null;
  onMedia(fn: () => void): () => void;
  /** This session's input, or null when no session is open. */
  input(): BrowserInput | null;
  /** This session's `bulk`, or null when no session is open. */
  bulk(): BulkChannel | null;
  /** This session's `collab`, or null when no session is open. */
  collab(): CollabChannel | null;
  /**
   * A Guild Desk session's `commons` (channel 4, task 48): Commons' room link, DATA messages with BIN as `collab`'s, which deskd
   * relays to Commons with the member's verified identity. Null when no session is open, and on any other desk.
   */
  commons?(): CollabChannel | null;
  /** The remote pointer's shape changed: a CSS `cursor` value. It's applied locally, so it never lags. */
  onCursor(fn: (css: string) => void): () => void;
  /**
   * Returns an unsubscribe function. Nothing is delivered while the link is closed, and every new session
   * asks again. `onRefused` hears a final no, such as `not_found` for a topic this desk doesn't serve yet.
   */
  subscribe<T extends keyof LinkTopics>(topic: T, fn: (msg: LinkTopics[T]) => void, onRefused?: (code: string) => void): () => void;
  /**
   * The same, for a topic named at run time, its events as they came: an app's own topic (`app:<id>:<topic>`), which the
   * app view's bridge passes on untouched (`deskapps/host/bridge.ts`).
   */
  subscribeRaw(topic: string, fn: (e: RawTopicEvent) => void, onRefused?: (code: string) => void): () => void;
}

export class DeskNotConnected extends Error {
  /** It had gone out when the session went and no answer came, so it may have happened. Otherwise it never left. */
  inFlight: boolean;

  constructor(deskId: string, inFlight = false) {
    super(`Desk ${deskId} is not connected`);
    this.name = 'DeskNotConnected';
    this.inFlight = inFlight;
  }
}

/**
 * Which link a desk gets. `export` is a closed account's export-only session (no video, no input, only `data.*`):
 * its every `connect` says `purpose: "export"` and wakes the desk, as only the member's own download makes one. `import.meta.env.MODE` is replaced at build time, so a production
 * bundle drops the mock branch and contains no mock code (scripts/build-release.mjs checks this).
 */
export async function createDeskLink(deskId: string, purpose?: 'export'): Promise<DeskLink> {
  // A guild's panel opens its Guild Desk with a guild token, never an owner's (task 48, `guild/access.ts`).
  const guild = purpose ? null : guildAccess(deskId);
  // `?link=real` lets a shell test see the real `connect` calls against the harness's fake API.
  if (import.meta.env.MODE !== 'production' && new URLSearchParams(window.location.search).get('link') !== 'real') {
    const { MockDeskLink } = await import('./mockDeskLink');
    return new MockDeskLink(deskId, purpose, guild);
  }
  const { RtcDeskLink } = await loadRtcLink();
  return new RtcDeskLink(deskId, purpose, guild);
}

/** The real link's code (WebRTC, the gateway, subscriptions) isn't part of the first paint: it loads when a desk opens, or earlier when `prefetchRtcLink` finds the page idle. */
const loadRtcLink = (): Promise<typeof import('./rtc/rtcDeskLink')> => import('./rtc/rtcDeskLink');

export function prefetchRtcLink(): void {
  void loadRtcLink().catch(() => undefined);
}
