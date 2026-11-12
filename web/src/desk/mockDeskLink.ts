// Dev and test only. Never in a production bundle (see createDeskLink).
import { api, ApiError } from '../platform/api';
import { THEMES } from '../theme/tokens';
import { accountFromQuery, capsFromQuery, type FixtureName } from '../../agent/src/mock/fixtures';
import { useDeskStore } from '../state/deskStore';
import { ATTENTION_DEADLINE_MS, AttentionSignal } from './attention';
import { MockAgentDesk, type MockAgentControl } from './mockDeskAgent';
import { answerData, MockBulk, newDataControl, type MockDataControl } from './mockDeskData';
import { cursorCss, InputEncoder } from './rtc/input';
import { refusalOf } from './rtc/policy';
import { Subscriptions } from './rtc/subs';
import { answerSignIns, signInsControl, type MockSignInsControl } from './mockSignIns';
import { DeskNotConnected, MAX_COLLAB_MESSAGE, type AgentActivity, type DeskAttentionMessage, type AppSummary, type BrowserInput, type BrowserMedia, type PhoneDevice, type BrowserViewMessage, type BrowserDownload, type BrowserDownloadsMessage, type BrowserLinkOutMessage, type BrowserTab, type BulkChannel, type CollabChannel, type CollabEnd, type DeskLink, type DeskRefusal, type DeskRpc, type LinkDeskState, type LinkDetails, type LinkState, type LinkTopics, type RawTopicEvent, type RpcOptions, type StreamState, type SummaryMessage } from './deskLink';
import type { MockCollabServer, MockNotebookControl } from './mockNotebook';
import { MockSimpleDesk, type MockSimpleControl } from './mockSimpleView';
import { isRefusal, type GuildAccess } from '../guild/access';
import { answerApps, appsControl, subscribeApps, subscribeAppTopic, type MockAppsControl } from './mockDeskApps';
import { answerGuild, guildCaller, guildControl, guildSessionMember, MockCommonsChannel, seedGuildAgent, seedGuildDesk, type GuildSessionMember, type MockGuildControl } from './mockGuild';

const SAMPLE: Record<string, AppSummary> = {
  chat: { badge: 4, widget: { title: '#general', text: 'Sam: the draft is ready for a look', foot: '3 unread channels' } },
  notebook: { widget: { title: 'Trip notes', text: 'Book the ferry before Friday. Packing list in the second tab.', foot: 'Today 09:12' } },
  browser: { widget: { title: 'Mock page title', text: 'example.org', foot: 'Normal mode' } },
  agent: { badge: 1, marks: ['C'], widget: { title: 'Manager', text: 'Waiting for your approval', foot: 'Today: $0.42 of $5' } },
};

/** What a dev or a `shell` test can steer and read, as `window.__maDeskMock`. */
export interface MockDeskControl {
  /** A Guild Desk's side (task 48, `mockGuild.ts`). */
  guild: MockGuildControl;
  /** Desk apps (API.md section 19, `mockDeskApps.ts`): Tally and the Bible's row. Off unless `__maAppsMockInit` turns it on. */
  apps: MockAppsControl;
  /**
   * The free tier's proposed `desk.contention` topic (S-119): this desk says its container is being held back. Off by
   * default, and refused like any topic a deskd doesn't serve when `refuse['desk.contention']` is set.
   */
  setHeld(deskId: string, held: boolean): void;
  /** A free desk waits for room, as `connect`'s `503 free_capacity_wait` says (S-119). */
  setBusy(deskId: string, busy: boolean): void;
  /** Every RPC, in order, with a key's `secret` taken out. A test's clipboard text stays in here, as nothing but the mock keeps any. */
  rpc: { m: string; p: Record<string, unknown>; options?: RpcOptions }[];
  /** Answer `m=video 0`, as for a browser with no H.264. */
  noVideo: boolean;
  /** Refuse these methods with this code, such as `not_found` for a desk that's older. Topics too, as they open. */
  refuse: Record<string, string>;
  /** `details` for a refusal, such as `{ reason: 'blocked' }`. */
  refuseDetails: Record<string, unknown>;
  /** The desk's tabs. Change them with `setTabs`, which sends a snapshot. */
  tabs: BrowserTab[];
  setTabs(tabs: BrowserTab[]): void;
  /**
   * How long the first `live` takes to bring Chromium up, as on a fresh root. Its reply gives up at the deadline as
   * deskd's does, the work carries on, and tab calls answer `unavailable` until it's up.
   */
  browserStartMs: number;
  /** How long a change takes to reach `browser.tabs`. It can be about a second. */
  topicDelayMs: number;
  /** A snapshot that isn't what `tabs` says now, as the topic can send before it has caught up. */
  sendSnapshot(tabs: BrowserTab[]): void;
  /** Methods that lose their session. `true`: the call had gone out and no answer will come. `false`: it never left. */
  lostSession: Record<string, boolean>;
  /** How long a refusal takes to come back, for what can change in that time. */
  refuseDelayMs: number;
  /** A `browser.tabs` `error` event, as when a refresh takes video away. */
  tabsError(code: string): void;
  /** The picture's size. Smaller desks send 1280x800, and it can change with no signaling. */
  picture: { width: number; height: number };
  /** Hold `browser.stream.set` this long, as a cold start does. */
  streamDelayMs: number;
  /** Don't draw the test picture, as if RTP never came. */
  noFrames: boolean;
  /** Frames drawn since the stream went `live`. */
  framesDrawn: number;
  /** Every input event as it would go on the wire. */
  input: { channel: 'input' | 'keys'; bytes: number[] }[];
  /** Pretend `input` has something buffered, so a MOVE is dropped. */
  inputBuffered: boolean;
  /** What the idle rule asked for, in order. */
  idle: string[];
  /** How many `ACTIVITY` reports got past the link's own limit. */
  activity: number;
  /** A `CURSOR` message from the desk, as the bytes `keys` would carry. */
  sendCursor(bytes: number[]): void;
  /** What the desk's `CLIPBOARD` holds, by `browser.clipboard.write` or `clipboardChanged`. Null: no text in it. */
  deskClipboard: string | null;
  /** Something on the desk takes the clipboard, and `browser.clipboard` says so. A page can do this with nobody asking. */
  clipboardChanged(text: string | null): void;
  /** The desk's Browser downloads, newest first, as `browser.downloads` has them (LS-31). `setDownloads` sends the list. */
  downloads: BrowserDownload[];
  setDownloads(downloads: BrowserDownload[]): void;
  /** The desk's Chromium refused protected playback in a tab: its `protectedMedia {at, keySystem}` on `browser.tabs` (TD-225). */
  protectedFailed(tabId: string, keySystem?: string): void;
  /**
   * A page on the desk hands over a link (#9): `browser.links`' `linkOut` to every session subscribed, as deskd sends it
   * (API.md section 10, "Links out"). `refuse['browser.links'] = 'not_found'` is a deskd or image before it.
   */
  linkOut(url: string, extra?: Partial<BrowserLinkOutMessage>): void;
  /**
   * The desk's Chromium isn't running (#9's Send to my desk): tab calls get `unavailable {reason: "chromium"}` until a
   * `browser.stream.set` with `warm` or `live` starts it, or, with `tabOpenStarts`, a `browser.tab.open` with `start: true`.
   */
  chromiumOff: boolean;
  /** deskd takes `browser.tab.open`'s `start` (the Desk Engineer's change #9 asks for). Off: today's deskd, which ignores it. */
  tabOpenStarts: boolean;
  /**
   * An own desk asleep, as `connect` would say: its link stays closed, and its state is `stopped`. A wake then goes through
   * Platform's phases, `wakeStepMs` each (starting, booting, connecting), and the link opens. `sleepFails` never wakes.
   */
  sleep(deskId: string, opts?: { fails?: boolean }): void;
  wakeStepMs: number;
  /** Methods whose answer waits for `releaseHeld`. */
  hold: Record<string, boolean>;
  releaseHeld(): void;
  /** The export's side: the desk's files, every `data.read` and CREDIT, and a session to drop partway. */
  data: MockDataControl;
  /** How long an export link's desk takes to wake after `connect`. */
  exportWakeMs: number;
  /** The Agent app's side: `web/agent`'s mock, on each desk. */
  agent: MockAgentControl;
  /** The session goes, as when the network does, and stays gone until `restoreLink`. One desk, or every desk. */
  dropLink(deskId?: string): void;
  restoreLink(deskId?: string): void;
  /** deskd's `{"t":"reset"}` on every open `collab`: the desk's sync service restarted. */
  resetCollab(): void;
  /** The Notebook's side (`mockNotebook.ts`), once something has used it. */
  notebook: Promise<MockNotebookControl>;
  /** The simple view's side (`mockSimpleView.ts`, task 47): its pages, the desk's per-site memory, and every action. */
  simple: MockSimpleControl;
  /** The Files app's side (`mockDeskFiles.ts`): each desk's tree and its knobs. */
  files: Promise<typeof import('./mockDeskFiles').filesControl>;
  /**
   * Each desk's side of `desk.attention` (task 46), as deskd API.md section 10 "Nobody looking" has it: a session that
   * hasn't said counts as looking while it wants `warm` or `live`; nobody looking for `attentionGraceMs` (5 s) cuts the
   * media, and the picture stops, but each session's `live` stands; nobody viewing the Browser (looking, with `warm` or
   * `live` wanted) for `freezeAfterMs` (60 s) freezes it, unless `keepThawed` (sound, a download, work). Looked at again,
   * the picture comes at once, from the frozen frame, and the thaw takes `thawMs`, as does a `live` on a frozen desk.
   */
  attention: Record<string, { seen: boolean; frozen: boolean }>;
  attentionGraceMs: number;
  freezeAfterMs: number;
  /** How long a thaw takes (`?thawMs=`, default 150 ms, deskd's expected 0.1 to 0.2 s). */
  thawMs: number;
  /** Something keeps that desk from freezing while unseen: sound, a download, a load. Its media is still cut. */
  keepThawed: Record<string, boolean>;
  setKeepThawed(deskId: string, on: boolean): void;
  /** That desk plays sound: it doesn't freeze, and its sessions hear it while their media flows (`silentFor`). */
  setSound(deskId: string, on: boolean): void;
  /** Every `desk.attention.set` the desk heard, with `performance.now()`. */
  attentionLog: { deskId: string; seen: boolean; at: number }[];
  /** Site sign-ins (#11, `mockSignIns.ts`): the password managers' list, the key's tab, and a passwords file on `bulk`. `?signIns=old` is a deskd before it, `?signIns=bitwarden` has Bitwarden installed, `?signInsStop=1` serves the Stop section. */
  signIns: MockSignInsControl;
  /**
   * deskd's phone view (API.md section 10, "On a phone"): `browser.view` per desk, the `device` each `desk.attention.set`
   * carried, and a field to report as focused. A seen phone gets the phone's view after `viewDelayMs`, anything else the
   * desk's own. Off unless `phoneView`: a deskd before it, which refuses the topic and ignores `device`, as most specs
   * expect of a phone's Browser. `setView` says what another session's phone would.
   */
  phoneView: boolean;
  view: Record<string, BrowserViewMessage>;
  setView(deskId: string, view: BrowserViewMessage): void;
  viewDelayMs: number;
  deviceLog: { deskId: string; device: PhoneDevice | null; at: number }[];
  setField(deskId: string, field: BrowserViewMessage['field']): void;
}

const notebookModule = (): Promise<typeof import('./mockNotebook')> => import('./mockNotebook');
const filesModule = (): Promise<typeof import('./mockDeskFiles')> => import('./mockDeskFiles');
const mockLinks = new Set<MockDeskLink>();

const cursorListeners = new Set<(css: string) => void>();
const clipboardListeners = new Set<(m: { seq: number; type: string }) => void>();
const downloadListeners = new Set<(m: BrowserDownloadsMessage) => void>();
const linkOutListeners = new Set<(m: BrowserLinkOutMessage) => void>();
let linkOutSeq = 0;
/** Own desks asleep (`control.sleep`), and whether a wake of each gets anywhere. */
const asleep = new Map<string, 'stopped' | 'fails'>();
let downloadSeq = 0;
const heldAnswers: (() => void)[] = [];
let clipboardSeq = 0;
const links = new Set<MockDeskLink>();
const query = new URLSearchParams(window.location.search);
const heldDesks = new Map<string, boolean>();
const heldListeners = new Map<string, Set<(m: { seq: number; type: string; held: boolean }) => void>>();
let heldSeq = 0;
const busyDesks = new Set<string>();
const control: MockDeskControl = {
  guild: guildControl,
  apps: appsControl,
  setBusy: (deskId, busy) => {
    if (busy) busyDesks.add(deskId);
    else busyDesks.delete(deskId);
    for (const l of links) if (l.deskId === deskId) l.noteBusy();
  },
  setHeld: (deskId, held) => {
    heldDesks.set(deskId, held);
    heldSeq += 1;
    for (const fn of heldListeners.get(deskId) ?? []) fn({ seq: heldSeq, type: 'patch', held });
  },
  rpc: [],
  noVideo: false,
  refuse: {},
  refuseDetails: {},
  tabs: [{ tabId: 't1', url: 'https://example.org/', title: 'Example page', loading: false, active: true, canGoBack: false, canGoForward: false }],
  setTabs: (tabs) => {
    control.tabs = tabs;
    if (control.topicDelayMs) window.setTimeout(() => emitTabs(control.tabs), control.topicDelayMs);
    else emitTabs(control.tabs);
  },
  browserStartMs: 0,
  topicDelayMs: 0,
  sendSnapshot: (tabs) => emitTabs(tabs),
  tabsError: (code) => {
    for (const fn of tabRefusals) fn(code);
  },
  lostSession: {},
  refuseDelayMs: 0,
  picture: { width: 1280, height: 720 },
  streamDelayMs: 20,
  noFrames: false,
  framesDrawn: 0,
  input: [],
  inputBuffered: false,
  idle: [],
  activity: 0,
  sendCursor: (bytes) => {
    const css = cursorCss(new Uint8Array(bytes));
    if (css) for (const fn of cursorListeners) fn(css);
  },
  deskClipboard: null,
  clipboardChanged: (text) => {
    control.deskClipboard = text;
    clipboardSeq += 1;
    for (const fn of clipboardListeners) fn({ seq: clipboardSeq, type: 'changed' });
  },
  downloads: [],
  setDownloads: (downloads) => {
    control.downloads = downloads;
    downloadSeq += 1;
    for (const fn of downloadListeners) fn({ seq: downloadSeq, downloads });
  },
  protectedFailed: (tabId, keySystem = 'com.widevine.alpha') => {
    control.setTabs(control.tabs.map((t) => (t.tabId === tabId ? { ...t, protectedMedia: { at: new Date().toISOString(), keySystem } } : t)));
  },
  linkOut: (url, extra = {}) => {
    linkOutSeq += 1;
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase() ?? '';
    const shown = url.replace(/%([0-9A-F]{2})/gi, (m, h: string) => {
      const c = parseInt(h, 16);
      return c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : m;
    });
    const msg: BrowserLinkOutMessage = { seq: linkOutSeq, type: 'linkOut', url, scheme, displayText: shown, reason: 'externalScheme', at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), tabId: activeTab().tabId, ...extra };
    for (const fn of linkOutListeners) fn(msg);
  },
  chromiumOff: false,
  tabOpenStarts: false,
  sleep: (deskId, opts = {}) => {
    asleep.set(deskId, opts.fails ? 'fails' : 'stopped');
    for (const link of mockLinks) if (link.deskId === deskId) link.sleepForTest();
  },
  wakeStepMs: Number(query.get('wakeStepMs') ?? 400),
  hold: {},
  releaseHeld: () => {
    for (const answer of heldAnswers.splice(0)) answer();
  },
  data: newDataControl(),
  exportWakeMs: 600,
  agent: {
    fixture: (query.get('agentFixture') as FixtureName | null) ?? 'fresh',
    fast: query.get('speed') === 'fast',
    keysLast: query.get('keysLast') === '1',
    account: accountFromQuery(query),
    caps: capsFromQuery(query),
    down: false,
    setDown: (down) => {
      control.agent.down = down;
      for (const desk of Object.values(control.agent.desks)) {
        if (down) desk.quiet();
        else desk.resume();
      }
    },
    desks: {},
    restart: () => {
      for (const desk of Object.values(control.agent.desks)) {
        desk.client.restart();
        desk.resume();
      }
    },
    dropLink: (ms) => {
      for (const link of links) link.dropFor(ms);
    },
  },
  dropLink: (deskId) => {
    for (const link of mockLinks) if (!deskId || link.deskId === deskId) link.dropForTest();
  },
  restoreLink: (deskId) => {
    for (const link of mockLinks) if (!deskId || link.deskId === deskId) link.restoreForTest();
  },
  resetCollab: () => {
    for (const link of mockLinks) link.collabChannel?.reset();
  },
  get notebook() {
    return notebookModule().then((m) => m.mockNotebookControl);
  },
  get simple() {
    return simpleDesk.control;
  },
  get files() {
    return filesModule().then((m) => m.filesControl);
  },
  attention: {},
  attentionGraceMs: Number(query.get('attentionGraceMs') ?? 5_000),
  freezeAfterMs: Number(query.get('freezeAfterMs') ?? 60_000),
  thawMs: Number(query.get('thawMs') ?? 150),
  keepThawed: {},
  setKeepThawed: (deskId, on) => {
    control.keepThawed[deskId] = on;
    settleAttention(deskId);
  },
  setSound: (deskId, on) => {
    for (const link of mockLinks) if (link.deskId === deskId) link.heard();
    sounding.set(deskId, on);
    control.setKeepThawed(deskId, on);
  },
  attentionLog: [],
  signIns: signInsControl,
  phoneView: false,
  view: {},
  setView: (deskId, view) => publishView(deskId, view),
  viewDelayMs: 60,
  deviceLog: [],
  setField: (deskId, field) => {
    const v = control.view[deskId] ?? DESK_VIEW;
    publishView(deskId, { ...v, field });
  },
};
guildControl.kick = (deskId) => {
  for (const link of mockLinks) if (link.deskId === deskId) link.kickForTest();
};
(window as unknown as { __maDeskMock: MockDeskControl }).__maDeskMock = control;

/** One mock desk's side of `desk.attention`. A mock desk has one session at most: its link's. */
interface AttentionDesk {
  open: boolean;
  /** What the session said, or null before it says. */
  said: boolean | null;
  /** The session wants `warm` or `live`, which counts as looking until it says. */
  wants: boolean;
  /** Nobody looking for the grace: no media to anyone, though what each session wants stands. */
  cut: boolean;
  frozen: boolean;
  /** Whether it was looked at when last settled, so only a look that's new thaws, as deskd's `recompute` does. */
  wasSeen: boolean;
  cutTimer: number;
  freezeTimer: number;
  thawTimer: number;
  seq: number;
  listeners: Set<(m: DeskAttentionMessage) => void>;
}
const attentionDesks = new Map<string, AttentionDesk>();
/** Desks playing sound (`setSound`). */
const sounding = new Map<string, boolean>();
function attentionDesk(deskId: string): AttentionDesk {
  let d = attentionDesks.get(deskId);
  if (!d) {
    d = { open: false, said: null, wants: false, cut: false, frozen: false, wasSeen: false, cutTimer: 0, freezeTimer: 0, thawTimer: 0, seq: 0, listeners: new Set() };
    attentionDesks.set(deskId, d);
  }
  return d;
}
const deskSeen = (d: AttentionDesk): boolean => d.open && (d.said ?? d.wants);

// ----- the phone view (API.md section 10, "On a phone")

const DESK_VIEW: BrowserViewMessage = { mode: 'desktop', field: null };
const viewListeners = new Map<string, Set<(m: BrowserViewMessage) => void>>();
const viewTimers = new Map<string, number>();
function publishView(deskId: string, v: BrowserViewMessage): void {
  control.view[deskId] = v;
  for (const fn of viewListeners.get(deskId) ?? []) fn(v);
  for (const link of mockLinks) if (link.deskId === deskId) link.refreshPicture();
}
/** A seen phone has the tabs, laid out at its size and scaled to fit the screen's top left, as deskd does. */
function settleView(deskId: string, sessionId: string | null, seen: boolean, device: PhoneDevice | null): void {
  if (!control.phoneView) return;
  window.clearTimeout(viewTimers.get(deskId));
  viewTimers.set(
    deskId,
    window.setTimeout(() => {
      const was = control.view[deskId] ?? DESK_VIEW;
      if (!seen || !device || !sessionId) {
        if (was.mode !== 'desktop') publishView(deskId, DESK_VIEW);
        return;
      }
      const screen = { ...control.picture };
      const scale = Math.floor(Math.min(screen.width / device.width, screen.height / device.height) * 100) / 100;
      const region = { x: 0, y: 0, width: Math.round(device.width * scale), height: Math.round(device.height * scale) };
      if (was.mode === 'phone' && was.sessionId === sessionId && was.width === device.width && was.height === device.height) return;
      publishView(deskId, { mode: 'phone', sessionId, width: device.width, height: device.height, scale, region, screen, field: null });
    }, control.viewDelayMs),
  );
}

function publishAttention(deskId: string): void {
  const d = attentionDesk(deskId);
  for (const link of mockLinks) if (link.deskId === deskId) link.refreshPicture();
  const now = { seen: deskSeen(d), frozen: d.frozen };
  const was = control.attention[deskId];
  if (was && was.seen === now.seen && was.frozen === now.frozen) return;
  control.attention[deskId] = now;
  d.seq += 1;
  for (const fn of d.listeners) fn({ seq: d.seq, type: 'snapshot', ...now });
}

/** A frozen Chromium thaws in `thawMs`, and the topic says `frozen` until it has (deskd's `BrowserFreeze.wake`). */
function thaw(deskId: string): void {
  const d = attentionDesk(deskId);
  if (!d.frozen || d.thawTimer) return;
  d.thawTimer = window.setTimeout(() => {
    d.thawTimer = 0;
    d.frozen = false;
    settleAttention(deskId);
  }, control.thawMs);
}

/**
 * deskd's `DeskAttention.recompute`: a new look sends the media again at once and thaws; nobody looking for the grace cuts
 * the media; nobody viewing the Browser and nothing keeping it, for `freezeAfterMs`, freezes it.
 */
function settleAttention(deskId: string): void {
  const d = attentionDesk(deskId);
  const seen = deskSeen(d);
  const kept = control.keepThawed[deskId] === true;
  if (seen) {
    window.clearTimeout(d.cutTimer);
    d.cutTimer = 0;
    d.cut = false;
    if (!d.wasSeen) thaw(deskId);
  } else if (!d.cut && !d.cutTimer) {
    d.cutTimer = window.setTimeout(() => {
      d.cutTimer = 0;
      if (deskSeen(d)) return;
      d.cut = true;
      publishAttention(deskId);
    }, control.attentionGraceMs);
  }
  d.wasSeen = seen;
  if ((seen && d.wants) || kept) {
    window.clearTimeout(d.freezeTimer);
    d.freezeTimer = 0;
    if (kept) thaw(deskId);
  } else if (!d.frozen && !d.freezeTimer) {
    d.freezeTimer = window.setTimeout(() => {
      d.freezeTimer = 0;
      if ((deskSeen(d) && d.wants) || control.keepThawed[deskId] || d.thawTimer) return;
      d.frozen = true;
      publishAttention(deskId);
    }, control.freezeAfterMs);
  }
  publishAttention(deskId);
}

/** Nothing reaches a session: its media is cut for want of anyone looking. A frozen desk looked at sends its last frame. */
const quietDesk = (deskId: string): boolean => attentionDesk(deskId).cut;

const tabListeners = new Set<(m: { seq: number; tabs: BrowserTab[] }) => void>();
const tabRefusals = new Set<(code: string) => void>();
let tabSeq = 0;
/** When Chromium is up, once a slow `live` has asked for it. */
let browserUpAt = 0;
const browserDownMs = (): number => Math.max(0, browserUpAt - Date.now());
function emitTabs(tabs: BrowserTab[]): void {
  tabSeq += 1;
  for (const fn of tabListeners) fn({ seq: tabSeq, tabs });
  const active = tabs.find((t) => t.active);
  if (active) simpleDesk.tabChanged(active.tabId, active.url);
}

const activeTab = (): BrowserTab => (control.tabs.find((t) => t.active) ?? control.tabs[0]) as BrowserTab;
function patchActive(p: Partial<BrowserTab>): string {
  const tab = activeTab();
  control.setTabs(control.tabs.map((t) => (t === tab ? { ...t, ...p } : t)));
  return tab.tabId;
}

/** What deskd requires of each `browser.tab.*` and `browser.text.insert`, and what it does, on a small scale. */
function mockTabCall(method: string, params: Record<string, unknown>): unknown {
  const tabId = params['tabId'] as string | undefined;
  if (tabId !== undefined && !control.tabs.some((t) => t.tabId === tabId)) throw Object.assign(new Error('gone'), { code: 'not_found', details: { reason: 'tab' } });
  switch (method) {
    case 'browser.tab.navigate': {
      const url = params['url'] as string;
      const id = patchActive({ url, title: new URL(url).hostname, loading: true, canGoBack: true });
      window.setTimeout(() => patchActive({ loading: false }), 60);
      return { tabId: id };
    }
    case 'browser.tab.back':
      return { tabId: patchActive({ canGoBack: false, canGoForward: true }) };
    case 'browser.tab.forward':
      return { tabId: patchActive({ canGoBack: true, canGoForward: false }) };
    case 'browser.tab.reload':
      return { tabId: patchActive({}) };
    case 'browser.tab.activate':
      control.setTabs(control.tabs.map((t) => ({ ...t, active: t.tabId === tabId })));
      return { tabId };
    case 'browser.tab.open': {
      const id = `t${control.tabs.length + 1}-${tabSeq}`;
      control.setTabs([...control.tabs.map((t) => ({ ...t, active: false })), { tabId: id, url: (params['url'] as string) ?? 'about:blank', title: 'New tab', loading: false, active: true, canGoBack: false, canGoForward: false }]);
      return { tabId: id };
    }
    case 'browser.tab.close': {
      const rest = control.tabs.filter((t) => t.tabId !== tabId);
      if (rest.length && !rest.some((t) => t.active)) rest[0] = { ...(rest[0] as BrowserTab), active: true };
      control.setTabs(rest);
      return {};
    }
    default:
      throw Object.assign(new Error('no such method'), { code: 'not_found' });
  }
}

/** The simple view's desk: a click on a link there navigates the tab, as the real page would. */
const simpleDesk = new MockSimpleDesk((url) => {
  try {
    mockTabCall('browser.tab.navigate', { url });
  } catch {
    // no tab
  }
});
simpleDesk.tabChanged(activeTab().tabId, activeTab().url);
// `npm run dev` plays a desk that serves the simplified view with `?simple=1`; tests turn it on through the control.
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('simple') === '1') simpleDesk.control.serves = true;

const PICTURE_FPS = 30;

/** The stream's stand-in: a generated picture, drawn only while `live`, and plainly labeled as one. */
class TestPicture {
  readonly stream: MediaStream;
  private readonly canvas = document.createElement('canvas');
  private frame = 0;
  private timer = 0;

  constructor(private readonly deskId: string) {
    this.stream = this.canvas.captureStream(PICTURE_FPS);
  }

  setLive(live: boolean): void {
    window.clearInterval(this.timer);
    this.timer = live ? window.setInterval(() => this.draw(), 1000 / PICTURE_FPS) : 0;
  }

  stop(): void {
    this.setLive(false);
    for (const t of this.stream.getTracks()) t.stop();
  }

  private draw(): void {
    if (control.noFrames) return;
    const g = this.canvas.getContext('2d');
    if (!g) return;
    const { surface, accent, text } = THEMES.dark;
    // An island's crop (task 47) is the island's shape: a made-up video, plainly labeled as one.
    const island = simpleDesk.control.island;
    const scale = island ? Math.min(1, 640 / island.w) : 1;
    const { width, height } = island ? { width: Math.round(island.w * scale), height: Math.round(island.h * scale) } : control.picture;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.frame += 1;
    control.framesDrawn += 1;
    g.fillStyle = surface.panel;
    g.fillRect(0, 0, width, height);
    g.fillStyle = accent.default;
    g.fillRect((this.frame * 8) % width, island ? height / 2 - 30 : 320, island ? 60 : 80, island ? 60 : 80);
    g.fillStyle = text.primary;
    g.font = island ? '22px sans-serif' : '32px sans-serif';
    g.fillText(island ? 'Test video, not a real page' : 'Test picture, not a real desk', island ? 24 : 48, island ? 44 : 80);
    g.fillStyle = text.secondary;
    g.font = '20px sans-serif';
    g.fillText(`frame ${this.frame}`, 48, 120);
    // A phone's view, drawn where deskd draws it: the top left, at the phone's size times its scale.
    const view = control.view[this.deskId];
    if (!island && view?.mode === 'phone' && view.region) {
      const r = view.region;
      const k = view.scale ?? 1;
      g.fillStyle = surface.window;
      g.fillRect(r.x, r.y, r.width, r.height);
      g.fillStyle = text.primary;
      g.font = `${Math.round(22 * k)}px sans-serif`;
      g.fillText('Test page, laid out', r.x + 16 * k, r.y + 40 * k);
      g.fillText('for a phone', r.x + 16 * k, r.y + 70 * k);
      g.fillStyle = accent.default;
      g.fillRect(r.x + 16 * k, r.y + 100 * k + ((this.frame * 4) % Math.max(1, r.height - 160 * k)), r.width - 32 * k, 40 * k);
    }
  }
}

function mockInput(): BrowserInput {
  const encoder = new InputEncoder();
  const keys = (bytes: Uint8Array): void => void control.input.push({ channel: 'keys', bytes: [...bytes] });
  return {
    move: (x, y) => {
      if (control.inputBuffered) return false;
      control.input.push({ channel: 'input', bytes: [...encoder.move(x, y)] });
      return true;
    },
    button: (down, button, x, y) => keys(encoder.button(down, button, x, y)),
    wheel: (x, y, dx, dy) => keys(encoder.wheel(x, y, dx, dy)),
    key: (down, keysym) => keys(encoder.key(down, keysym)),
    releaseAll: () => keys(encoder.releaseAll()),
  };
}

/** `collab` for one mock session: a loopback to the desk's side in `mockNotebook.ts`, which it loads only if it's used. */
class MockCollab implements CollabChannel {
  open = true;
  onOpen: (() => void) | null = null;
  onMessage: ((bytes: Uint8Array<ArrayBuffer>) => void) | null = null;
  onEnd: ((why: CollabEnd) => void) | null = null;
  private server: Promise<MockCollabServer> | null = null;

  constructor(
    private readonly deskId: string,
    /** A message over 4 MiB closes the whole session on a real desk. */
    private readonly tooLarge: () => void,
  ) {}

  private serverNow(): Promise<MockCollabServer> {
    this.server ??= notebookModule().then((m) => new m.MockCollabServer(m.mockDesk(this.deskId), (bytes) => {
      if (this.open) window.setTimeout(() => this.onMessage?.(bytes), 0);
    }, () => guildCaller(this.deskId)));
    return this.server;
  }

  send(bytes: Uint8Array): boolean {
    if (!this.open) return false;
    const copy = bytes.slice();
    void notebookModule().then((m) => {
      m.mockNotebookControl.sizes.push(copy.length);
      if (copy.length > MAX_COLLAB_MESSAGE) m.mockNotebookControl.oversize += 1;
    });
    if (copy.length > MAX_COLLAB_MESSAGE) {
      this.tooLarge();
      return false;
    }
    void this.serverNow().then((s) => s.receive(copy));
    return true;
  }

  reset(): void {
    const old = this.server;
    this.server = null;
    void old?.then((s) => s.drop());
    this.onEnd?.('reset');
  }

  end(): void {
    if (!this.open) return;
    this.open = false;
    void this.server?.then((s) => s.drop());
    this.onEnd?.('ended');
  }
}

export class MockDeskLink implements DeskLink {
  readonly available = true;
  readonly deskId: string;
  private state: LinkState = 'idle';
  private readonly listeners = new Set<(s: LinkState) => void>();
  private readonly mediaListeners = new Set<() => void>();
  private readonly startedAt = Date.now() - 754_000;
  private seq = 0;
  private sessionNo = 0;
  private picture: TestPicture | null = null;
  private currentMedia: BrowserMedia | null = null;
  private currentInput: BrowserInput | null = null;
  private activityAt = 0;
  private refusal: DeskRefusal | null = null;
  private readonly detailListeners = new Set<() => void>();
  private readonly purpose: 'export' | undefined;
  private session: MockBulk | null = null;
  private readonly agentSubs = new Subscriptions();
  collabChannel: MockCollab | null = null;
  private seqNotebook = 0;
  /** What this session's `browser.stream.set` last made of the picture. A frozen desk draws nothing either way. */
  private streamLive = false;
  /** When this session last heard its desk's sound, for `silentFor`. */
  private soundAt = 0;
  readonly attention = new AttentionSignal((seen, device) => this.call('desk.attention.set', device ? { seen, device } : { seen }, { deadlineMs: ATTENTION_DEADLINE_MS }));
  /**
   * A guild's panel (task 48): the Guild Desk's state, wake and token come from the harness's API for real, through
   * `guild/access.ts`, so a test sees every request. Only the session itself is the mock's: data only, no picture.
   */
  private readonly guild: GuildAccess | null;
  private guildDesk: LinkDetails['desk'] = null;
  private guildTry = 0;
  private guildTimer = 0;
  /** Who this Guild Desk session was opened for, from its guild token as deskd reads it (`guild.hello`). */
  private guildMember: GuildSessionMember | null = null;
  commonsChannel: MockCommonsChannel | null = null;

  constructor(deskId: string, purpose?: 'export', guild: GuildAccess | null = null) {
    this.deskId = deskId;
    this.purpose = purpose;
    this.guild = guild;
    if (purpose !== 'export') links.add(this);
    mockLinks.add(this);
  }

  /** This desk's `desk-agent`, from the first thing that asks. */
  private agentDesk(): MockAgentDesk {
    const name = useDeskStore.getState().desks.find((d) => d.id === this.deskId)?.name;
    const emit = (subId: number, seq: number, body: { type: string; data: unknown }): void => this.agentSubs.onEvent(subId, seq, body);
    if (!control.agent.desks[this.deskId] && this.guild) {
      control.agent.desks[this.deskId] = new MockAgentDesk(control.agent, control.refuse, emit, name);
      seedGuildAgent(control.agent.desks[this.deskId]!.client);
    }
    const desk = (control.agent.desks[this.deskId] ??= new MockAgentDesk(control.agent, control.refuse, emit, name));
    desk.emit = emit;
    return desk;
  }

  collab(): CollabChannel | null {
    return this.state === 'open' ? this.collabChannel : null;
  }

  commons(): CollabChannel | null {
    return this.state === 'open' ? this.commonsChannel : null;
  }

  /** deskd closed this member's session (contract 3.3): the real link asks for a fresh token, and so does this. */
  kickForTest(): void {
    if (!this.guild || this.state !== 'open') return;
    this.setSession(false);
    this.set('retrying');
    this.connectGuild(false);
  }

  /** The Guild Desk's state, wake and token from the harness, then a session of the mock's own. */
  private connectGuild(start: boolean): void {
    const access = this.guild!;
    const attempt = ++this.guildTry;
    window.clearTimeout(this.guildTimer);
    if (this.state !== 'open' && this.state !== 'retrying') this.set('signaling');
    access.connect(start, 'sha-256 MOCK').then(
      async (c) => {
        if (attempt !== this.guildTry) return;
        this.guildDesk = { state: c.state ?? null, phase: c.phase ?? null, queuePosition: null, stopAt: null };
        this.detailListeners.forEach((fn) => fn());
        if (c.state === 'stopped') {
          this.set('idle');
          return;
        }
        if (c.state !== 'running' || !c.deskToken) {
          this.guildTimer = window.setTimeout(() => this.connectGuild(false), guildControl.pollMs);
          return;
        }
        await seedGuildDesk(this.deskId, notebookModule);
        if (attempt !== this.guildTry) return;
        this.guildMember = guildSessionMember(this.deskId);
        this.setSession(true);
        this.set('open');
      },
      (err: unknown) => {
        if (attempt !== this.guildTry) return;
        // The data guard (ma-platform ADR 0110): `403 data_guard` on the token or the wake, with the guild's own words.
        const guard = err instanceof ApiError && err.code === 'data_guard' ? refusalOf('data_guard', err.details, window.location.hostname, err.message) : null;
        if (guard) {
          this.setRefusal(guard);
          this.set('denied');
          return;
        }
        if (isRefusal(err)) {
          this.set('denied');
          return;
        }
        this.set('retrying');
        this.guildTimer = window.setTimeout(() => this.connectGuild(false), 1_000);
      },
    );
  }

  dropForTest(): void {
    if (this.state !== 'open') return;
    this.setSession(false);
    this.set('retrying');
  }

  restoreForTest(): void {
    if (this.state !== 'retrying') return;
    this.setSession(true);
    this.set('open');
  }

  bulk(): BulkChannel | null {
    return this.state === 'open' ? this.session : null;
  }

  /** A session starts or ends: a new `bulk` each time, as a real session's is. */
  private setSession(on: boolean): void {
    this.session?.close();
    void filesModule().then((m) => m.filesControl.all().get(this.deskId)?.detach());
    this.session = on ? new MockBulk(control.data, () => this.dropSession()) : null;
    this.collabChannel?.end();
    this.collabChannel = on ? new MockCollab(this.deskId, () => this.dropForTest()) : null;
    this.commonsChannel?.end();
    this.commonsChannel = on && this.guild ? new MockCommonsChannel(this.deskId) : null;
    this.agentSubs.detach();
    if (this.purpose === 'export') return;
    const desk = this.agentDesk();
    desk.closeSubs();
    if (on) this.agentSubs.attach(desk, false);
  }

  /** `dropAfter`: the session goes, as when the network does, and a new one opens shortly. */
  private dropSession(ms = 400): void {
    this.setSession(false);
    this.set('retrying');
    window.setTimeout(() => {
      if (this.state !== 'retrying') return;
      this.setSession(true);
      this.set('open');
    }, ms);
  }

  dropFor(ms: number): void {
    if (this.state === 'open') this.dropSession(ms);
  }

  /** A closed account's export link asks Platform for real, so a test sees the `connect`, and the desk wakes. */
  private connectForExport(): void {
    this.set('signaling');
    api(`/v1/desks/${encodeURIComponent(this.deskId)}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'owner', purpose: 'export', start: true, clientDtlsFingerprint: 'sha-256 MOCK' }),
    }).then(
      () =>
        window.setTimeout(() => {
          if (this.state !== 'signaling') return;
          this.setSession(true);
          this.set('open');
        }, control.exportWakeMs),
      () => this.set('denied'),
    );
  }

  status(): LinkState {
    return this.state;
  }

  onStatus(fn: (s: LinkState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  details(): LinkDetails {
    return { unreachable: false, path: null, rttMs: null, desk: this.guildDesk ?? this.sleepDesk, refusal: this.refusal, busy: busyDesks.has(this.deskId) };
  }

  onDetails(fn: () => void): () => void {
    this.detailListeners.add(fn);
    return () => this.detailListeners.delete(fn);
  }

  /** The harness changed whether this desk is waiting for room. */
  noteBusy(): void {
    this.detailListeners.forEach((fn) => fn());
  }

  private setRefusal(r: DeskRefusal | null): void {
    this.refusal = r;
    this.detailListeners.forEach((fn) => fn());
  }

  private set(next: LinkState): void {
    const was = this.state;
    this.state = next;
    if (this.purpose !== 'export' && (was === 'open') !== (next === 'open')) {
      // A session opens or goes, as the real link's does: the desk forgets what the last one said.
      const d = attentionDesk(this.deskId);
      d.open = next === 'open';
      d.said = null;
      d.wants = false;
      settleAttention(this.deskId);
      if (next === 'open') {
        this.sessionNo += 1;
        this.attention.up();
      } else {
        this.attention.down();
        // That session's phone leaves: the desk takes its own view back.
        const v = control.view[this.deskId];
        if (v?.mode === 'phone') settleView(this.deskId, null, false, null);
      }
    }
    this.listeners.forEach((fn) => fn(next));
  }

  setSeen(seen: boolean): void {
    if (this.purpose !== 'export' && !this.guild) this.attention.want(seen);
  }

  setDevice(device: PhoneDevice | null): void {
    if (this.purpose !== 'export' && !this.guild) this.attention.device(device);
  }

  /** A session's id while one is open, as the gateway gives it, for `browser.view`'s `sessionId`. */
  currentSessionId(): string | null {
    return this.state === 'open' ? `cs-mock-${this.deskId}-${this.sessionNo}` : null;
  }

  knowsAttention(): boolean {
    return this.attention.answer === 'ok';
  }

  /** The picture draws while the session wants `live` and its desk sends media. */
  refreshPicture(): void {
    this.heard();
    this.picture?.setLive(this.streamLive && !quietDesk(this.deskId));
  }

  /** Notes the sound as heard now if it is reaching this session, before anything changes whether it does. */
  heard(): void {
    if (sounding.get(this.deskId) && this.streamLive && !quietDesk(this.deskId)) this.soundAt = Date.now();
  }

  private silentFor(): number {
    this.heard();
    return this.soundAt ? Date.now() - this.soundAt : Infinity;
  }

  connect(): void {
    if (this.purpose === 'export') {
      this.connectForExport();
      return;
    }
    if (this.guild) {
      if (this.state === 'idle' || this.state === 'denied') this.connectGuild(false);
      return;
    }
    // `?refuse=account_suspended&billing=<url>`: `connect` says no as Platform's does, and nothing asks again.
    const q = new URLSearchParams(window.location.search);
    // `&message=<words>&resumes=<ISO time>` for `data_guard`, as `403 data_guard` carries them (ma-platform ADR 0110).
    const refusal = refusalOf(q.get('refuse'), { billingUrl: q.get('billing'), resumesAt: q.get('resumes') }, window.location.hostname, q.get('message'));
    if (refusal) {
      this.setRefusal(refusal);
      this.set('denied');
      return;
    }
    if (asleep.has(this.deskId)) {
      this.sleepForTest();
      return;
    }
    this.set('signaling');
    window.setTimeout(() => this.set('connecting'), 20);
    window.setTimeout(() => {
      this.setSession(true);
      this.set('open');
      this.setMedia(true);
    }, 40);
  }

  /** As `connect` says of a stopped desk (`control.sleep`): no session, and the desk's state for the office. */
  private sleepDesk: LinkDeskState | null = null;

  sleepForTest(): void {
    this.setSession(false);
    this.set('idle');
    this.setMedia(false);
    this.sayDesk('stopped', null);
  }

  private sayDesk(state: string, phase: string | null): void {
    this.sleepDesk = { state, phase, queuePosition: null, stopAt: null, heardAt: Date.now() };
    this.detailListeners.forEach((fn) => fn());
  }

  /** A wake of a sleeping mock desk: Platform's phases, then a session. One that `fails` stays at its first step. */
  private wakeFromSleep(): void {
    const how = asleep.get(this.deskId);
    if (!how || this.waking) return;
    this.waking = true;
    const step = control.wakeStepMs;
    this.sayDesk('starting', 'starting');
    if (how === 'fails') return;
    window.setTimeout(() => this.sayDesk('starting', 'booting'), step);
    window.setTimeout(() => this.sayDesk('starting', 'connecting'), 2 * step);
    window.setTimeout(() => {
      asleep.delete(this.deskId);
      this.waking = false;
      this.sayDesk('running', 'ready');
      this.set('signaling');
      window.setTimeout(() => {
        this.setSession(true);
        this.set('open');
        this.setMedia(true);
      }, 40);
    }, 3 * step);
  }

  private waking = false;

  close(): void {
    this.guildTry += 1;
    window.clearTimeout(this.guildTimer);
    this.setSession(false);
    links.delete(this);
    this.set('idle');
    this.setMedia(false);
    if (this.refusal) this.setRefusal(null);
  }

  wake(): void {
    if (this.guild) {
      if (this.state === 'resting') this.reopen();
      else if (this.state !== 'open') this.connectGuild(true);
      return;
    }
    // A mock desk is always running, unless a test put it to sleep (`control.sleep`).
    if (asleep.has(this.deskId)) {
      this.wakeFromSleep();
      return;
    }
    this.reopen();
  }

  recheck(): void {
    // The URL can't change under a page, so a refused mock desk stays refused.
  }

  rest(): void {
    if (this.state === 'resting') return;
    control.idle.push('rest');
    this.setSession(false);
    this.set('resting');
    this.setMedia(false);
  }

  reopen(): void {
    if (this.state !== 'resting') return;
    control.idle.push('reopen');
    this.setSession(true);
    this.set('open');
    if (!this.guild) this.setMedia(true);
  }

  reportActivity(): void {
    if (Date.now() - this.activityAt < 60_000) return;
    this.activityAt = Date.now();
    control.activity += 1;
  }

  media(): BrowserMedia | null {
    this.refreshCanPlay();
    return this.currentMedia;
  }

  onMedia(fn: () => void): () => void {
    this.mediaListeners.add(fn);
    return () => this.mediaListeners.delete(fn);
  }

  input(): BrowserInput | null {
    return this.currentInput;
  }

  onCursor(fn: (css: string) => void): () => void {
    cursorListeners.add(fn);
    return () => cursorListeners.delete(fn);
  }

  private setMedia(on: boolean): void {
    this.streamLive = false;
    this.currentInput = on ? mockInput() : null;
    const old = this.picture;
    this.picture = on ? new TestPicture(this.deskId) : null;
    this.currentMedia = this.picture ? { stream: this.picture.stream, canPlayVideo: !control.noVideo, silentFor: () => this.silentFor() } : null;
    this.mediaListeners.forEach((fn) => fn());
    old?.stop(); // after, as the real link closes its PeerConnection: a window takes its last frame first
  }

  /** Reads it again, so a test can set `noVideo` before a window opens. */
  private refreshCanPlay(): void {
    if (this.currentMedia && this.currentMedia.canPlayVideo === control.noVideo) {
      this.currentMedia = { ...this.currentMedia, canPlayVideo: !control.noVideo };
    }
  }

  call<M extends keyof DeskRpc>(method: M, params: Record<string, unknown> = {}, options?: RpcOptions): Promise<DeskRpc[M]> {
    // A key never stays anywhere, this record included (web/agent/README.md, "The key").
    // Nor does a file's content (ADR 0049): a chunk is logged by its size.
    const kept = 'secret' in params ? { ...params, secret: '[redacted]' } : method === 'agent.attach.put' && typeof params['data'] === 'string' ? { ...params, data: `[${params['data'].length} base64 characters]` } : params;
    control.rpc.push({ m: method, p: kept, ...(options ? { options } : {}) });
    if (control.hold[method]) {
      return new Promise((resolve, reject) => heldAnswers.push(() => void this.answer(method, params, options).then(resolve, reject)));
    }
    return this.answer(method, params, options);
  }

  private answer<M extends keyof DeskRpc>(method: M, params: Record<string, unknown>, options?: RpcOptions): Promise<DeskRpc[M]> {
    if (this.state !== 'open' && (method.startsWith('data.') || method.startsWith('files.') || method.startsWith('agent.') || method.startsWith('notebook.'))) return Promise.reject(new DeskNotConnected(this.deskId));
    // An export session may call only `desk.status.get` and `data.*` (draft ADR "data export and transfer", section 6).
    if (this.purpose === 'export' && method !== 'desk.status.get' && !method.startsWith('data.')) {
      return Promise.reject(Object.assign(new Error('export scope'), { code: 'forbidden', details: {} }));
    }
    if (method.startsWith('data.') && !control.refuse[method]) {
      return answerData(control.data, this.session, method, params, { deskId: this.deskId, scope: this.purpose ?? 'owner' }) as Promise<DeskRpc[M]>;
    }
    const lost = control.lostSession[method];
    if (lost !== undefined) return Promise.reject(new DeskNotConnected(this.deskId, lost));
    const refusal = control.refuse[method];
    if (refusal) {
      const refused = Object.assign(new Error(`mock refused ${method}`), { code: refusal, details: control.refuseDetails });
      return new Promise((_, reject) => {
        if (control.refuseDelayMs) window.setTimeout(() => reject(refused), control.refuseDelayMs);
        else reject(refused);
      });
    }
    if (method.startsWith('files.')) {
      const { idem } = options ?? {};
      return filesModule().then((m) => {
        const desk = m.mockFiles(this.deskId, this.guild !== null);
        desk.control.onDrop = () => this.dropSession();
        return desk.answer(method, params, { bulk: this.session, scope: this.purpose ?? 'owner', ...(idem ? { idem } : {}) });
      }) as Promise<DeskRpc[M]>;
    }
    if (method.startsWith('apps.')) {
      if (this.state !== 'open') return Promise.reject(new DeskNotConnected(this.deskId));
      return answerApps(this.deskId, method, params, options?.idem) as Promise<DeskRpc[M]>;
    }
    if (method.startsWith('guild.')) {
      if (!this.guild || this.state !== 'open') return Promise.reject(new DeskNotConnected(this.deskId));
      return answerGuild(this.deskId, method, params, this.guildMember) as Promise<DeskRpc[M]>;
    }
    if (method.startsWith('agent.')) return this.agentDesk().answer(method, params, options) as Promise<DeskRpc[M]>;
    if (method.startsWith('notebook.')) return notebookModule().then((m) => m.mockDesk(this.deskId).answer(method, params, options?.idem)) as Promise<DeskRpc[M]>;
    if (method.startsWith('browser.minified.') || method === 'browser.adblock.site.set') {
      const run = (): Promise<DeskRpc[M]> => {
        // A desk today: its `deskd` has no section 14, so these are "No such method" (section 4).
        if (!simpleDesk.control.serves) return Promise.reject(Object.assign(new Error(`no such method ${method}`), { code: 'not_found', details: {} }));
        // API.md section 14: only `act` and the ad switch are mutations (`site.set` and `sites.clear` aren't).
        if ((method === 'browser.minified.act' || method === 'browser.adblock.site.set') && !options?.idem) {
          return Promise.reject(Object.assign(new Error(`${method} needs idem`), { code: 'bad_request', details: {} }));
        }
        try {
          return Promise.resolve(simpleDesk.answer(method, params) as DeskRpc[M]);
        } catch (err) {
          return Promise.reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      const delay = method === 'browser.minified.site.get' ? simpleDesk.control.siteDelayMs : 0;
      return delay > 0 ? new Promise<void>((done) => window.setTimeout(done, delay)).then(run) : run();
    }
    const signIns = answerSignIns(method, params, options, this.state === 'open' ? this.session : null, { get: () => control.tabs, set: (tabs) => control.setTabs(tabs) });
    if (signIns) return signIns as Promise<DeskRpc[M]>;
    if (control.chromiumOff && method === 'browser.tab.open' && control.tabOpenStarts && params['start'] === true) control.chromiumOff = false;
    if ((browserDownMs() > 0 || control.chromiumOff) && (method === 'browser.text.insert' || method.startsWith('browser.tab.'))) {
      return Promise.reject(Object.assign(new Error('Chromium is starting'), { code: 'unavailable', details: { reason: 'chromium' } }));
    }
    const mutation = method.startsWith('browser.tab.') && method !== 'browser.tab.list';
    if ((mutation || method === 'browser.text.insert') && !options?.idem) {
      return Promise.reject(Object.assign(new Error(`${method} needs idem`), { code: 'bad_request', details: {} }));
    }
    if (method === 'desk.attention.set') {
      if (this.state !== 'open') return Promise.reject(new DeskNotConnected(this.deskId));
      if (this.purpose === 'export') return Promise.reject(Object.assign(new Error('scope'), { code: 'forbidden', details: { reason: 'scope' } }));
      const seen = params['seen'];
      if (typeof seen !== 'boolean') return Promise.reject(Object.assign(new Error('seen'), { code: 'bad_request', details: { reason: 'seen' } }));
      control.attentionLog.push({ deskId: this.deskId, seen, at: performance.now() });
      const device = (params['device'] as PhoneDevice | undefined) ?? null;
      if (device && (device.kind !== 'phone' || !(device.width >= 160 && device.width <= 2048) || !(device.height >= 160 && device.height <= 2048) || !Number.isInteger(device.width) || !Number.isInteger(device.height))) {
        return Promise.reject(Object.assign(new Error('device'), { code: 'bad_request', details: { reason: 'device' } }));
      }
      control.deviceLog.push({ deskId: this.deskId, device, at: performance.now() });
      settleView(this.deskId, this.currentSessionId(), seen, device);
      const d = attentionDesk(this.deskId);
      d.said = seen;
      settleAttention(this.deskId);
      return Promise.resolve({ seen: deskSeen(d), frozen: d.frozen } as DeskRpc[M]);
    }
    if (method === 'desk.status.get') {
      return Promise.resolve({
        deskId: this.deskId,
        deskdVersion: 'mock-0.0.0',
        rtcVersion: 'mock-0.0.0',
        bootId: 'mock-boot',
        uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
        javaVersion: '21.mock',
        instanceType: 'mock.large',
      } satisfies DeskRpc['desk.status.get'] as DeskRpc[M]);
    }
    if (method === 'browser.text.insert') return Promise.resolve({} as DeskRpc[M]);
    // As API.md section 10 says, on a small scale. The X side, and whether a page can reach it, are the real desk's to prove.
    if (method === 'browser.clipboard.write') {
      const text = (params['text'] as string).replace(/\0/g, '');
      if (new TextEncoder().encode(params['text'] as string).length > 1_000_000) {
        return Promise.reject(Object.assign(new Error('over the cap'), { code: 'too_large', details: { limit: 1_000_000 } }));
      }
      if (text) control.deskClipboard = text;
      return Promise.resolve({} as DeskRpc[M]);
    }
    if (method === 'browser.clipboard.read') return Promise.resolve({ text: control.deskClipboard } as DeskRpc[M]);
    if (method === 'browser.tab.list') return Promise.resolve({ tabs: control.tabs } as DeskRpc[M]);
    if (mutation) {
      try {
        return Promise.resolve(mockTabCall(method, params) as DeskRpc[M]);
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
    if (method === 'browser.stream.set') {
      const state = params['state'] as StreamState;
      // An island's crop has no wire of its own: the stream going warm, or off, is the crop ending.
      if (state !== 'live') simpleDesk.control.island = null;
      if (state === 'live' && control.browserStartMs && !browserUpAt) browserUpAt = Date.now() + control.browserStartMs;
      if (state === 'live' || state === 'warm') control.chromiumOff = false;
      const wait = Math.max(control.streamDelayMs, browserDownMs());
      const deadline = options?.deadlineMs ?? Infinity;
      return new Promise((resolve, reject) => {
        const arrive = (): void => {
          this.heard();
          this.streamLive = state === 'live';
          attentionDesk(this.deskId).wants = state !== 'off';
          if (state === 'live') thaw(this.deskId); // deskd thaws Chromium first
          settleAttention(this.deskId);
        };
        if (wait > deadline) {
          window.setTimeout(arrive, wait);
          window.setTimeout(() => reject(Object.assign(new Error('deadline'), { code: 'deadline_exceeded', details: {} })), deadline);
          return;
        }
        window.setTimeout(() => {
          arrive();
          resolve({ state } as DeskRpc[M]);
        }, wait);
      });
    }
    return Promise.reject(Object.assign(new Error(`mock: unknown method ${String(method)}`), { code: 'not_found' }));
  }

  subscribeRaw(topic: string, fn: (e: RawTopicEvent) => void, onRefused?: (code: string) => void): () => void {
    if (topic.startsWith('app:')) return subscribeAppTopic(this.deskId, topic, fn, onRefused);
    window.setTimeout(() => onRefused?.('not_found'), 0);
    return () => {};
  }

  subscribe<T extends keyof LinkTopics>(topic: T, fn: (msg: LinkTopics[T]) => void, onRefused?: (code: string) => void): () => void {
    if (topic === 'apps') {
      const refusal = control.refuse[topic];
      if (refusal) {
        window.setTimeout(() => onRefused?.(refusal), 0);
        return () => {};
      }
      return subscribeApps(this.deskId, fn as (msg: Record<string, unknown>) => void);
    }
    if (typeof topic === 'string' && topic.startsWith('agent.')) {
      // The real link's own subscriptions, so several listeners share one, a new session asks again, and a refusal is final.
      return this.agentSubs.subscribe(topic, {}, {
        event: ({ type, seq, data }) => {
          if (data && typeof data === 'object') fn({ ...data, type, seq } as LinkTopics[T]);
        },
        ...(onRefused ? { refused: onRefused } : {}),
      });
    }
    if (topic === 'browser.tabs') {
      const refusal = control.refuse[topic];
      if (refusal) {
        onRefused?.(refusal);
        return () => {};
      }
      const listener = fn as (m: { seq: number; tabs: BrowserTab[] }) => void;
      tabListeners.add(listener);
      const refused = (code: string): void => onRefused?.(code);
      tabRefusals.add(refused);
      const timer = window.setTimeout(() => listener({ seq: tabSeq, tabs: control.tabs }), 10 + browserDownMs());
      return () => {
        window.clearTimeout(timer);
        tabListeners.delete(listener);
        tabRefusals.delete(refused);
      };
    }
    if (typeof topic === 'string' && topic.startsWith('browser.minified:')) {
      // API.md section 14's topic, one per tab: `{type, seq, ...data}`, as the real link hands events on.
      const refusal = control.refuse['browser.minified'] ?? (simpleDesk.control.serves ? undefined : 'not_found');
      if (refusal) {
        const timer = window.setTimeout(() => onRefused?.(refusal), 10);
        return () => window.clearTimeout(timer);
      }
      return simpleDesk.watch(topic.slice('browser.minified:'.length), fn as unknown as Parameters<MockSimpleDesk['watch']>[1]);
    }
    if (topic === 'browser.clipboard') {
      const refusal = control.refuse[topic];
      if (refusal) {
        onRefused?.(refusal);
        return () => {};
      }
      // No first event, as on a real desk.
      const listener = fn as (m: { seq: number; type: string }) => void;
      clipboardListeners.add(listener);
      return () => clipboardListeners.delete(listener);
    }
    if (topic === 'browser.downloads') {
      // `refuse['browser.downloads'] = 'not_found'` is a deskd before it.
      const refusal = control.refuse[topic];
      if (refusal) {
        const timer = window.setTimeout(() => onRefused?.(refusal), 10);
        return () => window.clearTimeout(timer);
      }
      const listener = fn as (m: BrowserDownloadsMessage) => void;
      downloadListeners.add(listener);
      const timer = window.setTimeout(() => listener({ seq: downloadSeq, downloads: control.downloads }), 10);
      return () => {
        window.clearTimeout(timer);
        downloadListeners.delete(listener);
      };
    }
    if (topic === 'browser.view') {
      const refusal = control.refuse[topic] ?? (control.phoneView ? undefined : 'not_found');
      if (refusal) {
        const timer = window.setTimeout(() => onRefused?.(refusal), 10);
        return () => window.clearTimeout(timer);
      }
      const listener = fn as (m: BrowserViewMessage) => void;
      let set = viewListeners.get(this.deskId);
      if (!set) viewListeners.set(this.deskId, (set = new Set()));
      set.add(listener);
      const timer = window.setTimeout(() => listener(control.view[this.deskId] ?? DESK_VIEW), 10);
      return () => {
        window.clearTimeout(timer);
        set.delete(listener);
      };
    }
    if (topic === 'browser.links') {
      // `refuse['browser.links'] = 'not_found'` is a deskd or an image before Links out. No first event, nothing kept.
      const refusal = control.refuse[topic];
      if (refusal) {
        const timer = window.setTimeout(() => onRefused?.(refusal), 10);
        return () => window.clearTimeout(timer);
      }
      const listener = fn as (m: BrowserLinkOutMessage) => void;
      const own = (m: BrowserLinkOutMessage): void => {
        if (this.state === 'open') listener(m);
      };
      linkOutListeners.add(own);
      return () => linkOutListeners.delete(own);
    }
    if (topic === 'files.changes') {
      const refusal = control.refuse[topic];
      if (refusal) {
        onRefused?.(refusal);
        return () => {};
      }
      let off: (() => void) | null = null;
      let gone = false;
      let seq = 0;
      void filesModule().then((m) => {
        if (gone) return;
        const desk = m.mockFiles(this.deskId, this.guild !== null);
        (fn as (msg: LinkTopics['files.changes']) => void)({ seq: (seq += 1), type: 'snapshot' });
        off = desk.subscribe((e) => {
          if (this.state === 'open') (fn as (msg: LinkTopics['files.changes']) => void)({ seq: (seq += 1), type: 'event', ...e });
        });
      });
      return () => {
        gone = true;
        off?.();
      };
    }
    if (topic === 'notebook.tree') {
      const refusal = control.refuse[topic];
      if (refusal) {
        onRefused?.(refusal);
        return () => {};
      }
      let off: (() => void) | null = null;
      let gone = false;
      void notebookModule().then((m) => {
        if (gone) return;
        off = m.mockDesk(this.deskId).onRev((rev) => {
          this.seqNotebook += 1;
          if (this.state === 'open') (fn as (msg: LinkTopics['notebook.tree']) => void)({ seq: this.seqNotebook, rev });
        });
      });
      return () => {
        gone = true;
        off?.();
      };
    }
    if (topic === 'desk.contention') {
      const refusal = control.refuse[topic];
      if (refusal) {
        onRefused?.(refusal);
        return () => {};
      }
      const listener = fn as (m: { seq: number; type: string; held: boolean }) => void;
      const set = heldListeners.get(this.deskId) ?? new Set();
      heldListeners.set(this.deskId, set);
      set.add(listener);
      const timer = window.setTimeout(() => listener({ seq: heldSeq, type: 'snapshot', held: heldDesks.get(this.deskId) === true }), 10);
      return () => {
        window.clearTimeout(timer);
        set.delete(listener);
      };
    }
    if (topic === 'desk.attention') {
      const refusal = control.refuse[topic];
      if (refusal) {
        onRefused?.(refusal);
        return () => {};
      }
      const d = attentionDesk(this.deskId);
      const listener = fn as (m: DeskAttentionMessage) => void;
      d.listeners.add(listener);
      const timer = window.setTimeout(() => listener({ seq: d.seq, type: 'snapshot', seen: deskSeen(d), frozen: d.frozen }), 10);
      return () => {
        window.clearTimeout(timer);
        d.listeners.delete(listener);
      };
    }
    if (topic !== 'summary') return () => {};
    // `?agent=needs-you` and the like: the states that put an agent's status in the strip. `?agent=live`: `summary` has no word
    // on the agents, as on a real desk today, so `agent.state` fills it.
    const word = new URLSearchParams(window.location.search).get('agent') ?? 'idle';
    const agent = { state: word } as AgentActivity;
    const send = (): void => {
      this.seq += 1;
      const msg: SummaryMessage = { seq: this.seq, ...(word === 'live' ? {} : { agent }), apps: SAMPLE };
      fn(msg as LinkTopics[T]);
    };
    const timer = window.setTimeout(send, 60);
    return () => window.clearTimeout(timer);
  }
}
