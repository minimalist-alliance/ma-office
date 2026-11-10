// One Browser window's simple view, outside React (design 7.4): which page shows, which view wins, what the stream
// does, and the member's actions on the real page. React reads `getView`; nothing here runs per frame.
import type { BrowserTab, DeskLink } from '../desk/deskLink';
import type { BrowserDriver } from '../browser/driver';
import { decideView, pageLine, type LineEvent, type PageStatus, type SiteChoice, type ViewDecision } from './decide';
import { applyMDoc, applyPatch, pageKey, PageHistory, type SimpleDoc } from './docStore';
import type { Block, PageMeta, SecretKind } from './mdoc';
import type { ActResult, IslandBox, MediaOp, MediaState, SimpleAction, SimpleSource, SourceMessage } from './source';
import { SiteMemory, siteOf } from './siteMemory';
import type { SimpleUi } from './ui';

/** A page that has sent nothing by now shows in full, for this visit only: "never a blank page" (the Designer's spec, 7). */
export const NO_PAGE_MS = 1_500;
/** An action with no answer by now gets the progress line (design 7.3, "What the user waits for"). */
export const PROGRESS_AFTER_MS = 100;
/** The full page's first frame, at most: past this the simple view steps aside anyway. */
const UNCOVER_MAX_MS = 1_500;
/**
 * After the member's own press of Simplified (or Try again) on a page the desk hasn't answered for, the view covers once
 * this has passed, with its progress line (the Designer's 300 ms `delayed` rule). A page the member only went to never
 * covers before its document is in hand: see `recompute`.
 */
export const COVER_AFTER_MS = 300;
/** Scrolling the real page to the member's place, before the full page's picture goes live, at most. */
const SWITCH_WAIT_MS = 400;
/** A field's value goes at most once a frame; its echo is the page's own value, applied when the member pauses or leaves. */
export const ADOPT_AFTER_MS = 600;
/** "Real page here from now on · Undo" stays this long (the Designer's spec, section 7). */
export const UNDO_MS = 8_000;
const REFUSED_MS = 6_000;
/** An action the desk took that changed nothing: the progress line goes after this. */
const BUSY_MAX_MS = 1_500;

// The video island's timings (the Designer's spec, section 6's table).
/** Starting: the spinner disc only after this. */
export const ISLAND_SPINNER_MS = 400;
/** Starting: no first frame by now, or a refusal, and it can't play here. */
export const ISLAND_FAIL_MS = 3_000;
/** Paused: the crop stops streaming after this. */
export const ISLAND_REST_MS = 5_000;
/** Playing: under this share in view, it's scrolled away; back at `ISLAND_BACK`. */
export const ISLAND_AWAY = 0.25;
export const ISLAND_BACK = 0.5;

export type IslandPhase = 'ready' | 'starting' | 'playing' | 'paused' | 'failed';

/** One island's state, as its frame and controls draw it. A new object on every change. */
export interface IslandState {
  phase: IslandPhase;
  /** Seconds, as known at `at` (`performance.now()`); while playing it runs on from there. */
  time: number;
  at: number;
  duration: number | null;
  buffered: number;
  volume: number;
  muted: boolean;
  captions: boolean;
  /** Starting for longer than `ISLAND_SPINNER_MS`. */
  slow: boolean;
  /** Playing, with under a quarter of it in view: the chip shows. */
  away: boolean;
}

/** Where the media is now, in seconds. */
export function islandTime(s: IslandState, now = performance.now()): number {
  const t = s.phase === 'playing' ? s.time + (now - s.at) / 1000 : s.time;
  return s.duration ? Math.min(t, s.duration) : t;
}

type IslandBlock = Extract<Block, { t: 'island' }>;

/** An `act` the desk didn't do, for a reason the member should hear about: the line offers the real page. */
const SAY_REFUSED: ReadonlySet<string> = new Set(['missed', 'changed', 'gone', 'label', 'dialog', 'sensitive', 'covered', 'frame_near', 'hidden', 'disabled', 'focus', 'kind', 'frames']);

const sameDecision = (a: ViewDecision, b: ViewDecision): boolean => a.view === b.view && a.canSwitch === b.canSwitch && a.why === b.why && a.reason === b.reason;

/** What a page the desk sent shows as: its `challenge` sends it to the real page with that challenge's line. */
const statusOf = (meta: PageMeta): PageStatus => (meta.challenge ? { kind: 'fallback', reason: meta.challenge } : { kind: 'ready' });

const BLANK = /^(about:blank|chrome:\/\/new-?tab(-page)?\/?)$/;

/**
 * What each desk link's `deskd` said of the simple view: false, it has none (`not_found`, or its switch off), so the next
 * Browser window on the same link starts on the real page at once; true, it serves it. Never asked twice on one link; a
 * new link (a reload) asks again.
 */
const SERVES = new WeakMap<object, boolean>();
/** The probe's answer, at most: past this the window shows the real page, for this window only, never a blank one. */
export const PROBE_MS = 1_500;

export interface SimpleViewState {
  tabId: string | null;
  /** The tab's page now, as the desk's tabs say. */
  url: string | null;
  site: string | null;
  /** What's shown. It can be a page from history, or the last one, while the real page catches up (`stale`). */
  doc: SimpleDoc | null;
  stale: boolean;
  /** Bumped when a different page shows, so the view starts it at the top. */
  pageSerial: number;
  decision: ViewDecision;
  status: PageStatus;
  /** An action is out and nothing has changed for `PROGRESS_AFTER_MS`. */
  busy: boolean;
  /** The island whose crop streams now, if any. */
  liveIsland: string | null;
  /** The island that fills the window, if any. */
  filled: string | null;
  /** A playing island scrolled out of view, shown as the chip at the bottom. */
  chip: string | null;
}

interface TabPage {
  url: string;
  status: PageStatus;
  override: SiteChoice | null;
}

export class SimpleController {
  readonly memory: SiteMemory;
  private readonly history = new PageHistory();
  private readonly docs = new Map<string, SimpleDoc>();
  private readonly pages = new Map<string, TabPage>();
  private readonly listeners = new Set<() => void>();
  private supported: boolean | null = null;
  /** The desk has said whether it serves the simple view (`source.probe`), or the window stopped waiting for it. */
  private probed: boolean;
  private probeTimer = 0;
  private tabs: BrowserTab[] = [];
  private view: SimpleViewState;
  private offWatch: (() => void) | null = null;
  /** The tab whose page is watched: the one on screen. */
  private watched: string | null = null;
  private offMemory: (() => void) | null = null;
  private waitTimer = 0;
  private busyTimer = 0;
  private busyCap = 0;
  private lineTimer = 0;
  private lineEvent: LineEvent | null = null;
  private inFlight = 0;
  /** Fills not yet echoed, per ref, and when the member last typed in each. */
  private readonly fills = new Map<string, number>();
  private readonly typedAt = new Map<string, number>();
  private readonly pendingFill = new Map<string, string>();
  private fillFrame = 0;
  // Islands: one at a time, never by itself (the Designer's spec, section 6)
  private readonly islands = new Map<string, IslandState>();
  private readonly islandListeners = new Map<string, Set<() => void>>();
  private readonly islandTimers = new Map<string, number[]>();
  private active: string | null = null;
  private islandEpoch = 0;
  /** Each island's rectangle as the desk last gave it, for telling its crop from a frame of the whole screen. */
  private readonly islandBoxes = new Map<string, { width: number; height: number; dpr: number }>();
  // The switch to the full page
  private uncoverCancel: (() => void) | null = null;
  private uncoverTimer = 0;
  private coverTimer = 0;
  private switching = 0;
  /** The view is over the real page and not stepping aside: what the member sees is the view. */
  private shown = false;
  /** The page the member pressed Simplified or Try again on, while it has no answer: it may cover before its document. */
  private pressed: TabPage | null = null;
  /** Set by the view: the element at the top of what the member is reading. */
  topRef: () => string | null = () => null;
  private stopped = false;

  constructor(
    private readonly ui: SimpleUi,
    private readonly driver: BrowserDriver,
    readonly source: SimpleSource,
    readonly link: DeskLink,
  ) {
    this.memory = new SiteMemory(source.sites);
    const known = SERVES.get(link);
    if (known === false) this.supported = false;
    this.probed = known !== undefined || !source.probe;
    this.view = { tabId: null, url: null, site: null, doc: null, stale: false, pageSerial: 0, decision: ui.get().decision, status: { kind: 'waiting' }, busy: false, liveIsland: null, filled: null, chip: null };
  }

  // ----- React

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  readonly getView = (): SimpleViewState => this.view;

  private patch(p: Partial<SimpleViewState>): void {
    const keys = Object.keys(p) as (keyof SimpleViewState)[];
    if (keys.every((k) => this.view[k] === p[k])) return;
    this.view = { ...this.view, ...p };
    for (const fn of this.listeners) fn();
  }

  // ----- life

  start(): void {
    this.stopped = false;
    this.ui.toggle = this.toggle;
    this.ui.choose = this.choose;
    this.ui.lineAction = this.lineAction;
    this.ui.holdLine = this.holdLine;
    this.offMemory = this.memory.subscribe(() => this.recompute());
    this.recompute();
    if (!this.probed) this.probe();
  }

  /** Whether the desk serves the simple view at all, asked beside the stream's start, never ahead of it. */
  private probe(): void {
    const ask = this.source.probe?.();
    if (!ask) return;
    const done = (serves: boolean | null): void => {
      // The answer is the link's, whatever became of this window: the next window on it needn't ask.
      if (serves !== null) SERVES.set(this.link, serves);
      window.clearTimeout(this.probeTimer);
      if (this.stopped || this.probed) return;
      this.probed = true;
      if (serves === false) this.supported = false;
      this.setTabs(this.tabs);
    };
    // Too slow: the real page for this window, never a blank one; the next window asks again.
    this.probeTimer = window.setTimeout(() => {
      if (this.stopped || this.probed) return;
      this.probed = true;
      this.supported = false;
      this.setTabs(this.tabs);
    }, PROBE_MS);
    void ask.then((r) => done(r === 'yes' ? true : r === 'no' ? false : null));
  }

  /** Watch the tab on screen, and only it (section 14: one subscription per tab shown). */
  private watch(tabId: string | null): void {
    if (tabId === this.watched || this.supported === false || this.stopped || !this.probed) return;
    this.offWatch?.();
    this.offWatch = null;
    this.watched = tabId;
    if (!tabId) return;
    this.offWatch = this.source.watch(tabId, {
      rev: () => this.docs.get(tabId)?.meta.rev ?? null,
      message: (m) => this.onMessage(tabId, m),
      refused: () => {
        // An older deskd, or its switch off: the real page, with no switch, until the next session asks again.
        if (this.stopped) return;
        this.supported = false;
        SERVES.set(this.link, false);
        this.offWatch?.();
        this.offWatch = null;
        this.recompute();
      },
    });
  }

  stop(): void {
    this.stopped = true;
    this.offWatch?.();
    this.offMemory?.();
    this.offWatch = null;
    this.offMemory = null;
    this.watched = null;
    for (const p of this.images.values()) void p.then((u) => u && URL.revokeObjectURL(u));
    this.images.clear();
    for (const t of [this.waitTimer, this.busyTimer, this.busyCap, this.lineTimer, this.uncoverTimer, this.coverTimer, this.probeTimer]) window.clearTimeout(t);
    this.resetIslands();
    cancelAnimationFrame(this.fillFrame);
    this.uncoverCancel?.();
    this.shown = false;
    this.pressed = null;
    this.coverTimer = 0;
    this.history.clear();
    this.docs.clear();
    this.ui.reset();
  }

  // ----- what the desk says

  setTabs(tabs: BrowserTab[]): void {
    this.tabs = tabs;
    this.history.keepOnly(tabs.map((t) => t.tabId));
    for (const id of [...this.docs.keys()]) if (!tabs.some((t) => t.tabId === id)) this.docs.delete(id);
    const active = tabs.find((t) => t.active);
    this.watch(active?.tabId ?? null);
    if (!active) {
      this.patch({ tabId: null, url: null, site: null, doc: null });
      this.recompute();
      return;
    }
    const url = active.url;
    const page = this.pages.get(active.tabId);
    if (!page || pageKey(page.url) !== pageKey(url)) this.newPage(active.tabId, url);
    else if (this.view.tabId !== active.tabId) this.showTab(active.tabId);
    this.recompute();
  }

  /** The tab is on a page it wasn't on: what the desk last sent for it, or history, shows until the page itself arrives. */
  private newPage(tabId: string, url: string): void {
    const doc = this.docs.get(tabId) ?? null;
    let status: PageStatus = { kind: 'waiting' };
    if (BLANK.test(url) || !url) status = { kind: 'blank' };
    else if (doc && pageKey(doc.meta.url) === pageKey(url)) status = statusOf(doc.meta);
    this.pages.set(tabId, { url, status, override: null });
    this.pressed = null;
    // A line is about its page; "Real page here from now on · Undo" stays only on its own site, where Undo still means it.
    if (this.lineEvent && (this.lineEvent !== 'picked' || siteOf(url) !== this.view.site)) this.setLine(null);
    this.showTab(tabId);
    this.armWait();
  }

  private showTab(tabId: string): void {
    const page = this.pages.get(tabId);
    const url = page?.url ?? null;
    const latest = this.docs.get(tabId) ?? null;
    const fits = latest && pageKey(latest.meta.url) === pageKey(url);
    const remembered = !fits && url ? this.history.get(tabId, pageKey(url)) : null;
    const doc = page?.status.kind === 'blank' ? null : fits ? latest : remembered ?? (this.view.tabId === tabId ? this.view.doc : null);
    const samePage = this.view.tabId === tabId && doc !== null && this.view.doc !== null && pageKey(doc.meta.url) === pageKey(this.view.doc.meta.url);
    if (!samePage) this.resetIslands();
    this.patch({
      tabId,
      url,
      site: siteOf(url),
      doc,
      stale: !fits,
      pageSerial: samePage ? this.view.pageSerial : this.view.pageSerial + 1,
    });
  }

  private armWait(): void {
    window.clearTimeout(this.waitTimer);
    const tabId = this.view.tabId;
    const page = tabId ? this.pages.get(tabId) : null;
    if (!tabId || !page || page.status.kind !== 'waiting') return;
    this.waitTimer = window.setTimeout(() => {
      const now = this.pages.get(tabId);
      if (now === page && now.status.kind === 'waiting') {
        now.status = { kind: 'slow' };
        this.recompute();
      }
    }, NO_PAGE_MS);
  }

  private onMessage(tabId: string, m: SourceMessage): void {
    if (this.stopped) return;
    this.supported = true;
    const page = this.pages.get(tabId);
    if (m.kind === 'pending') {
      this.recompute();
      return;
    }
    if (m.kind === 'fallback') {
      // The tab's page now, as the desk sees it: the real page, and why.
      if (page) {
        page.status = { kind: 'fallback', reason: m.reason };
        if (tabId === this.view.tabId) this.endBusy();
        this.recompute();
      }
      return;
    }
    const prev = this.docs.get(tabId) ?? null;
    const doc = m.kind === 'doc' ? applyMDoc(prev, m.mdoc) : applyPatch(prev, m.patch);
    if (!doc) {
      // A patch that doesn't fit what's held: ask for the whole document. One that can't be read is dropped, never asked
      // for again in a loop; the page's next change brings another.
      if (m.kind === 'patch') this.source.refresh(tabId);
      return;
    }
    this.docs.set(tabId, doc);
    this.history.put(tabId, { ...doc, meta: { ...doc.meta, url: pageKey(doc.meta.url) } });
    // The desk's page is newer than the tab list, which can trail by a second: it's the page now.
    if (page && pageKey(doc.meta.url) !== pageKey(page.url) && doc.meta.url) {
      this.pages.set(tabId, { url: doc.meta.url, status: { kind: 'waiting' }, override: null });
    }
    const now = this.pages.get(tabId);
    // A document is the tab as it is now: whatever fell back before, it's this page's own status from here.
    if (now) now.status = statusOf(doc.meta);
    if (tabId === this.view.tabId) {
      this.endBusy();
      this.showTab(tabId);
      this.recheckIsland();
    }
    this.recompute();
  }

  // ----- which view

  private recompute(): void {
    const tabId = this.view.tabId;
    const page = tabId ? this.pages.get(tabId) : undefined;
    const site = this.view.site;
    const next = decideView({
      supported: this.supported,
      // Only a desk that has said it serves the view is asked for its site memory: never a call a desk of today can't answer.
      choice: site && this.probed && this.supported !== false ? this.memory.choice(site) : null,
      override: page?.override ?? null,
      status: page?.status ?? { kind: tabId ? 'waiting' : 'blank' },
    });
    // The same decision keeps its object, so nothing that reads it draws again for nothing.
    const decision = sameDecision(next, this.view.decision) ? this.view.decision : next;
    const was = this.view.decision;
    this.patch({ decision, status: page?.status ?? { kind: 'waiting' } });
    if (decision.view !== was.view) this.onViewChanged(decision.view);
    const line = pageLine(decision, this.lineEvent);
    const had = this.ui.get().line;
    const sameLine = line === had || (line !== null && had !== null && line.text === had.text && line.icon === had.icon && line.action === had.action);
    this.ui.set({ decision, available: this.probed ? this.supported !== false : null, line: sameLine ? had : line, host: site ?? '' });
    // Until the desk has said it serves the view, the window is the real page, its stream started as it always was: the
    // question goes beside it, never ahead of it. A yes switches to the view from then on (T47O-2's rules with it).
    if (!this.probed) {
      window.clearTimeout(this.coverTimer);
      this.coverTimer = 0;
      this.shown = false;
      this.ui.set({ covering: false, stream: 'off' });
    } else if (decision.view === 'simple') {
      // The view covers only with something to show: this page's document, a new tab's empty page, or the member's own
      // reading (the view's last page, with its progress line, while the next one comes). A page the member went to from
      // the real page stays the real page, its stream live and every click and key going to it, until its document is in
      // hand: never an empty cover over a page the member can see, which took the first click on the real test desk,
      // whose desk answers in seconds (Nov 10). A quick refusal never covers, nor does a slow one.
      const status = page?.status.kind;
      if (status === 'ready' || status === 'blank' || (this.shown && this.view.doc !== null)) this.cover();
      else if (page && page === this.pressed) {
        // The member asked for the view on this page: it covers after `COVER_AFTER_MS`, with its progress line.
        if (!this.coverTimer)
          this.coverTimer = window.setTimeout(() => {
            this.coverTimer = 0;
            const now = this.view.tabId ? this.pages.get(this.view.tabId) : undefined;
            if (!this.stopped && now === page && this.view.decision.view === 'simple') this.cover();
          }, COVER_AFTER_MS);
      } else if (this.shown) this.leave();
    }
  }

  /** The view over the real page, at once: T47O-2's rules from here (`driver.ts`, `BrowserApp.tsx`). */
  private cover(): void {
    window.clearTimeout(this.coverTimer);
    this.coverTimer = 0;
    if (!this.shown) {
      // Stepping aside is over: whatever was still to come of it, the view stays.
      this.switching += 1;
      this.cancelUncover();
    }
    this.shown = true;
    this.ui.set({ covering: true, stream: this.view.liveIsland ? 'island' : 'simple' });
  }

  private cancelUncover(): void {
    this.uncoverCancel?.();
    this.uncoverCancel = null;
    window.clearTimeout(this.uncoverTimer);
  }

  /**
   * The view steps aside for the real page: `first` (the real page scrolled to the member's place, at most
   * `SWITCH_WAIT_MS`), then the picture, and the view stays over it until the picture's first frame (design 7.4), so
   * nothing flashes. Until then it still covers, and T47O-2's rules hold.
   */
  private leave(first: Promise<unknown> = Promise.resolve()): void {
    this.shown = false;
    window.clearTimeout(this.coverTimer);
    this.coverTimer = 0;
    this.switching += 1;
    const serial = this.switching;
    this.cancelUncover();
    const wait = new Promise((done) => window.setTimeout(done, SWITCH_WAIT_MS));
    void Promise.race([first.catch(() => undefined), wait]).then(() => {
      if (serial !== this.switching || this.stopped) return;
      this.ui.set({ stream: 'off' });
      const uncover = (): void => {
        if (serial !== this.switching) return;
        this.cancelUncover();
        this.ui.set({ covering: false });
      };
      this.uncoverCancel = this.driver.onNextFrame(uncover);
      this.uncoverTimer = window.setTimeout(uncover, UNCOVER_MAX_MS);
    });
  }

  /** A line the member's own step brought: for `ms`, or until the page changes. */
  private setLine(event: LineEvent | null, ms = 0): void {
    window.clearTimeout(this.lineTimer);
    this.lineEvent = event;
    this.lineMs = event ? ms : 0;
    if (event && ms && !this.lineHeld) this.armLine();
  }

  private lineMs = 0;
  private lineHeld = false;

  private armLine(): void {
    const event = this.lineEvent;
    window.clearTimeout(this.lineTimer);
    this.lineTimer = window.setTimeout(() => {
      if (this.lineEvent === event) {
        this.lineEvent = null;
        this.recompute();
      }
    }, this.lineMs);
  }

  /** The member is on the line (pointer or focus): a timed line waits, and gets its whole time again after. */
  readonly holdLine = (held: boolean): void => {
    this.lineHeld = held;
    if (held) window.clearTimeout(this.lineTimer);
    else if (this.lineEvent && this.lineMs) this.armLine();
  };

  private onViewChanged(view: SiteChoice): void {
    if (view === 'simple') return; // `recompute` covers once there's something to show, and the stream goes warm
    // To the full page: the real page scrolled to where the member was reading (`act scroll`, `start`), then the picture.
    const tabId = this.view.tabId;
    const doc = this.view.doc;
    const ref = this.shown ? this.topRef() : null;
    const target = ref ? doc?.nodes.get(ref) : undefined;
    this.pauseActive();
    this.patch({ liveIsland: null, filled: null, chip: null });
    const place = ref && target && tabId && doc ? this.source.act(tabId, doc.meta.rev, { node: ref, ...target }, { act: 'scroll', ref, to: 'start' }) : Promise.resolve();
    this.leave(place);
  }

  /** The bar's switch: a view, remembered for this site (design 7.4, "Toggle"; the Designer's spec, section 7). */
  readonly choose = (next: SiteChoice): void => {
    const d = this.view.decision;
    if (!d.canSwitch || d.view === next) return;
    const page = this.view.tabId ? this.pages.get(this.view.tabId) : undefined;
    if (page) {
      page.override = null;
      // A page that never came, or one the site's memory put in full: asking for it again is the member's call.
      const st = page.status;
      const ask = next === 'simple' && (st.kind === 'slow' || (st.kind === 'fallback' && (st.reason === 'member_choice' || st.reason === 'remembered')));
      this.pressed = next === 'simple' ? page : null;
      if (ask) {
        page.status = { kind: 'waiting' };
        this.armWait();
      }
      this.setLine(next === 'full' ? 'picked' : null, UNDO_MS);
      // The desk keeps the choice, then looks at the page again whatever its memory said (`get` with `retry`).
      const kept = this.memory.remember(this.view.site, next);
      const tabId = this.view.tabId;
      if (ask && tabId) void kept.then(() => this.source.retry(tabId));
    } else {
      this.setLine(next === 'full' ? 'picked' : null, UNDO_MS);
      void this.memory.remember(this.view.site, next);
    }
    this.recompute();
  };

  readonly toggle = (): void => this.choose(this.view.decision.view === 'simple' ? 'full' : 'simple');

  /** The line's one action: Undo a press of Real page, Try again, or the real page after a refusal. */
  readonly lineAction = (): void => {
    const line = pageLine(this.view.decision, this.lineEvent);
    if (!line?.action) return;
    if (line.action === 'undo') {
      this.setLine(null);
      void this.memory.remember(this.view.site, null);
      this.recompute();
    } else if (line.action === 'retry') {
      const tabId = this.view.tabId;
      const page = tabId ? this.pages.get(tabId) : undefined;
      if (!tabId || !page) return;
      page.status = { kind: 'waiting' };
      page.override = null;
      this.pressed = page;
      this.armWait();
      this.source.retry(tabId);
      this.recompute();
    } else this.showFull();
  };

  /** The full page for this page only, not remembered: the hidden control's "Show the real page", a refused click. */
  readonly showFull = (): void => {
    const page = this.view.tabId ? this.pages.get(this.view.tabId) : undefined;
    if (!page) return;
    page.override = 'full';
    if (this.lineEvent === 'refused') this.setLine(null);
    this.recompute();
  };

  /** "Sign in on (site)" or "Pay on (site)" (T47-1): the real page for this page, and the line says why. Simplified comes back on the next page. */
  readonly signIn = (kind: SecretKind = 'signin'): void => {
    this.setLine(kind === 'pay' ? 'pay' : 'signin');
    this.showFull();
  };

  // ----- actions

  /** One thing the member did. `onFail` undoes what showed at once, such as a checkbox's tick. */
  act(action: SimpleAction, onFail?: () => void): void {
    const tabId = this.view.tabId;
    const doc = this.view.doc;
    if (!tabId || !doc) return;
    const isFill = action.act === 'fill';
    // Scrolling the real page is the view's own step, not the member's: no progress line, and no line if it's refused.
    const quiet = isFill || action.act === 'scroll';
    const target = doc.nodes.get(action.ref);
    if (isFill) this.fills.set(action.ref, (this.fills.get(action.ref) ?? 0) + 1);
    if (!quiet) this.startBusy();
    const sent: Promise<ActResult> = target ? this.source.act(tabId, doc.meta.rev, { node: action.ref, ...target }, action) : Promise.resolve({ done: false, reason: 'gone' });
    sent.then(
      (r) => {
        if (isFill) this.fillDone(action.ref);
        if (r.done) {
          // Taken, and the page may not change at all (a button that opens nothing): the line doesn't run on for ever.
          if (!quiet) this.busyCap = window.setTimeout(() => this.endBusy(), BUSY_MAX_MS);
          return;
        }
        if (!quiet) this.endBusy();
        onFail?.();
        if (!quiet && SAY_REFUSED.has(r.reason)) this.refused();
      },
      () => {
        if (isFill) this.fillDone(action.ref);
        else if (!quiet) this.endBusy();
        onFail?.();
        if (!quiet) this.refused();
      },
    );
  }

  /** Refused rather than guessed (design 7.3, "zero wrong-target clicks"): the real page is one press away. */
  private refused(): void {
    if (this.stopped) return;
    this.setLine('refused', REFUSED_MS);
    this.recompute();
  }

  /** Typing: the newest value goes once a frame (design 7.3). */
  fill(ref: string, value: string): void {
    this.typedAt.set(ref, performance.now());
    this.pendingFill.set(ref, value);
    if (!this.fillFrame) {
      this.fillFrame = requestAnimationFrame(() => {
        this.fillFrame = 0;
        for (const [r, v] of this.pendingFill) this.act({ act: 'fill', ref: r, value: v });
        this.pendingFill.clear();
      });
    }
  }

  /** Before Enter, what's typed must have gone, in order. */
  flushFills(): void {
    if (!this.fillFrame) return;
    cancelAnimationFrame(this.fillFrame);
    this.fillFrame = 0;
    for (const [r, v] of this.pendingFill) this.act({ act: 'fill', ref: r, value: v });
    this.pendingFill.clear();
  }

  private fillDone(ref: string): void {
    const n = (this.fills.get(ref) ?? 1) - 1;
    if (n > 0) this.fills.set(ref, n);
    else this.fills.delete(ref);
  }

  /** The page's own value for a field may replace what's typed: nothing typed is unconfirmed, and the member paused. */
  mayAdopt(ref: string): boolean {
    if (this.fills.has(ref) || this.pendingFill.has(ref)) return false;
    return performance.now() - (this.typedAt.get(ref) ?? 0) >= ADOPT_AFTER_MS;
  }

  private startBusy(): void {
    this.inFlight += 1;
    if (!this.busyTimer && !this.view.busy) this.busyTimer = window.setTimeout(() => {
      this.busyTimer = 0;
      if (this.inFlight > 0) this.patch({ busy: true });
    }, PROGRESS_AFTER_MS);
  }

  /** Something answered: the page changed, or the action failed. */
  private endBusy(): void {
    this.inFlight = 0;
    window.clearTimeout(this.busyTimer);
    window.clearTimeout(this.busyCap);
    this.busyTimer = 0;
    this.patch({ busy: false });
  }

  // ----- islands (design 7.4; the Designer's spec, section 6): never by itself, one at a time, its own controls

  readonly subscribeIsland = (key: string, fn: () => void): (() => void) => {
    let set = this.islandListeners.get(key);
    if (!set) {
      set = new Set();
      this.islandListeners.set(key, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  };

  /** The island's state, first from what the desk said of it: an element under DRM can't play here, from the start. */
  island(b: IslandBlock): IslandState {
    let s = this.islands.get(b.key);
    if (!s) {
      // DRM, or not live here (no island id, or a poster the real page wants clicked): it plays on the real page.
      s = { phase: b.drm || !b.ref ? 'failed' : 'ready', time: b.time, at: performance.now(), duration: b.duration, buffered: 0, volume: 1, muted: false, captions: b.captionsOn, slow: false, away: false };
      this.islands.set(b.key, s);
    }
    return s;
  }

  private setIsland(key: string, patch: Partial<IslandState>): void {
    const was = this.islands.get(key);
    if (!was) return;
    const next = { ...was, ...patch };
    this.islands.set(key, next);
    for (const fn of this.islandListeners.get(key) ?? []) fn();
    if ('away' in patch || 'phase' in patch) this.patch({ chip: this.chipKey() });
  }

  private chipKey(): string | null {
    const key = this.active;
    const s = key ? this.islands.get(key) : undefined;
    return key && s && s.away && (s.phase === 'playing' || s.phase === 'starting') ? key : null;
  }

  private islandTimer(key: string, ms: number, fn: () => void): void {
    const id = window.setTimeout(fn, ms);
    this.islandTimers.set(key, [...(this.islandTimers.get(key) ?? []), id]);
  }

  private clearIslandTimers(key: string): void {
    for (const id of this.islandTimers.get(key) ?? []) window.clearTimeout(id);
    this.islandTimers.delete(key);
  }

  private fromDesk(key: string, m: MediaState): void {
    const s = this.islands.get(key);
    if (!s) return;
    const patch: Partial<IslandState> = {};
    if (m.time !== undefined) {
      patch.time = Math.max(0, m.time);
      patch.at = performance.now();
    }
    if (m.duration !== undefined && m.duration > 0) patch.duration = m.duration;
    if (m.buffered !== undefined) patch.buffered = Math.max(0, m.buffered);
    if (m.volume !== undefined) patch.volume = Math.min(1, Math.max(0, m.volume));
    if (m.muted !== undefined) patch.muted = m.muted;
    if (m.captions !== undefined) patch.captions = m.captions;
    this.setIsland(key, patch);
  }

  private media(b: IslandBlock, op: MediaOp): Promise<void> {
    const tabId = this.view.tabId;
    const doc = this.view.doc;
    const target = b.ref ? doc?.nodes.get(b.ref) : undefined;
    if (!tabId || !doc || !b.ref || !target) return Promise.reject(new Error('no element'));
    return this.source.media(tabId, doc.meta.rev, { node: b.ref, ...target }, op).then((m) => this.fromDesk(b.key, m));
  }

  /** Play: the crop first, then the element, and the picture from the crop's first frame (≤ 300 ms is the desk's part). */
  play(b: IslandBlock): void {
    const s = this.island(b);
    const tabId = this.view.tabId;
    const islandId = b.ref;
    if (!tabId || !islandId || s.phase === 'failed' || s.phase === 'playing' || s.phase === 'starting' || this.view.decision.view !== 'simple') return;
    if (this.active && this.active !== b.key) this.pauseActive();
    this.clearIslandTimers(b.key);
    this.active = b.key;
    const epoch = ++this.islandEpoch;
    const cropOn = this.view.liveIsland === b.key;
    this.setIsland(b.key, { phase: cropOn ? 'playing' : 'starting', slow: false, at: performance.now() });
    if (!cropOn) {
      this.islandTimer(b.key, ISLAND_SPINNER_MS, () => this.islands.get(b.key)?.phase === 'starting' && this.setIsland(b.key, { slow: true }));
      this.islandTimer(b.key, ISLAND_FAIL_MS, () => this.islands.get(b.key)?.phase === 'starting' && this.failed(b, true));
    }
    // Its box first (section 14): nothing over it, and in view. Cropping the stream to it is the System Engineer's.
    const box: Promise<IslandBox> = cropOn ? Promise.resolve({ live: true, reason: null }) : this.source.island(tabId, islandId);
    box
      .then((x) => {
        if (epoch !== this.islandEpoch || this.stopped || this.view.decision.view !== 'simple') return undefined;
        if (!x.live) throw new Error(x.reason ?? 'not live');
        if (x.rect) this.islandBoxes.set(b.key, { ...x.rect, dpr: x.dpr && x.dpr > 0 ? x.dpr : 1 });
        this.patch({ liveIsland: b.key });
        this.ui.set({ stream: 'island' });
        return this.media(b, { op: 'play' });
      })
      .catch(() => {
        if (epoch === this.islandEpoch && !this.stopped) this.failed(b, true);
      });
  }

  /**
   * Whether a frame is the island's crop: its shape is the element's rectangle, and it's no bigger than the rectangle in
   * device pixels (`desk-stream` never scales a crop up). A frame of the whole screen, as a desk whose `deskd` sends no
   * `stream.crop` would stream, never shows in the island: no frame that fits in `ISLAND_FAIL_MS` and it can't play here.
   */
  islandFrameFits(key: string, w: number, h: number): boolean {
    const box = this.islandBoxes.get(key);
    if (!box || !w || !h) return true;
    const want = box.width / box.height;
    const shapeFits = Math.abs(w / h - want) / want <= 0.06;
    const sizeFits = w <= box.width * box.dpr * 1.1 + 4 && h <= box.height * box.dpr * 1.1 + 4;
    return shapeFits && sizeFits;
  }

  /** The crop's first frame is on screen: it plays. */
  islandFrame(key: string): void {
    const s = this.islands.get(key);
    if (s?.phase !== 'starting') return;
    this.clearIslandTimers(key);
    this.setIsland(key, { phase: 'playing', slow: false, at: performance.now() });
  }

  /** Pause: the last frame holds, and after `ISLAND_REST_MS` nothing streams. */
  pause(b: IslandBlock): void {
    const s = this.islands.get(b.key);
    if (!s || (s.phase !== 'playing' && s.phase !== 'starting')) return;
    this.clearIslandTimers(b.key);
    this.setIsland(b.key, { phase: 'paused', time: islandTime(s), at: performance.now(), slow: false });
    void this.media(b, { op: 'pause' }).catch(() => undefined);
    this.islandTimer(b.key, ISLAND_REST_MS, () => {
      if (this.islands.get(b.key)?.phase === 'paused' && this.view.liveIsland === b.key) this.cropOff();
    });
  }

  private pauseActive(): void {
    const key = this.active;
    const b = key ? this.islandBlock(key) : null;
    if (b) this.pause(b);
  }

  /** The crop stops: the stream goes back to warm, which has no picture (no method of its own on the wire). */
  private cropOff(): void {
    ++this.islandEpoch;
    this.patch({ liveIsland: null });
    if (this.view.decision.view === 'simple') this.ui.set({ stream: 'simple' });
  }

  /**
   * The page changed while an island's crop streams: something may be over it now (section 14's `island`, `live: false`
   * with `covered`, `wall`, `hidden` or `fullscreen`). Then it's paused, holds its last frame dimmed, and offers the real
   * page, never a crop of whatever is over it (T47-4, T47O-1). An island that left the page takes its crop with it.
   */
  private recheckIsland(): void {
    const key = this.view.liveIsland;
    const tabId = this.view.tabId;
    if (!key || !tabId) return;
    const b = this.islandBlock(key);
    if (!b?.ref) {
      if (this.active === key) this.active = null;
      this.cropOff();
      return;
    }
    const epoch = this.islandEpoch;
    this.source.island(tabId, b.ref).then(
      (x) => {
        if (epoch !== this.islandEpoch || this.stopped || this.view.liveIsland !== key || x.live) return;
        void this.media(b, { op: 'pause' }).catch(() => undefined);
        this.failed(b, false);
      },
      () => undefined,
    );
  }

  /**
   * It can't play here: DRM, a refused crop, or no first frame in `ISLAND_FAIL_MS`. If the member pressed play, the tab
   * goes to the real page by itself, scrolled to the player, with one line.
   */
  private failed(b: IslandBlock, pressed: boolean): void {
    this.clearIslandTimers(b.key);
    this.setIsland(b.key, { phase: 'failed', slow: false, away: false });
    if (this.active === b.key) this.active = null;
    this.cropOff();
    if (pressed) this.playOnRealPage(b);
  }

  /** "Play on the real page": the real page for this page, scrolled to the player. */
  playOnRealPage(b: IslandBlock): void {
    const tabId = this.view.tabId;
    const page = tabId ? this.pages.get(tabId) : undefined;
    if (!tabId || !page) return;
    if (b.ref) {
      const ref = b.ref;
      this.topRef = () => ref;
    }
    this.setLine('video');
    page.override = 'full';
    this.recompute();
  }

  seek(b: IslandBlock, time: number): void {
    const s = this.islands.get(b.key);
    if (!s) return;
    const t = Math.max(0, s.duration ? Math.min(time, s.duration) : time);
    this.setIsland(b.key, { time: t, at: performance.now() });
    void this.media(b, { op: 'seek', time: t }).catch(() => undefined);
  }

  volume(b: IslandBlock, volume: number, muted: boolean): void {
    if (!this.islands.has(b.key)) return;
    this.setIsland(b.key, { volume, muted });
    void this.media(b, { op: 'volume', volume, muted }).catch(() => undefined);
  }

  captions(b: IslandBlock): void {
    const s = this.islands.get(b.key);
    if (!s || b.captionsTrack < 0) return;
    this.setIsland(b.key, { captions: !s.captions });
    void this.media(b, { op: 'captions', track: s.captions ? -1 : b.captionsTrack }).catch(() => undefined);
  }

  /** The end of the media: it rests as paused, at its end. */
  ended(b: IslandBlock): void {
    const s = this.islands.get(b.key);
    if (s?.phase === 'playing') this.pause(b);
  }

  /** How much of it is in view (0 to 1): under a quarter while playing, the chip; back at a half (hysteresis). */
  islandSeen(key: string, ratio: number): void {
    const s = this.islands.get(key);
    if (!s || this.active !== key) return;
    if (!s.away && ratio < ISLAND_AWAY) this.setIsland(key, { away: true });
    else if (s.away && ratio >= ISLAND_BACK) this.setIsland(key, { away: false });
  }

  fillWindow(key: string | null): void {
    this.patch({ filled: key });
  }

  /** The island's block on the page now. */
  islandBlock(key: string): IslandBlock | null {
    const find = (bs: readonly Block[]): IslandBlock | null => {
      for (const b of bs) {
        if (b.t === 'island' && b.key === key) return b;
        if (b.t === 'group' || b.t === 'fold') {
          const inner = find(b.blocks);
          if (inner) return inner;
        }
      }
      return null;
    };
    return find(this.view.doc?.blocks.map((kb) => kb.block) ?? []);
  }

  /** The page was left, or the view changed: islands start over, and nothing streams for them. */
  resetIslands(): void {
    for (const key of this.islandTimers.keys()) this.clearIslandTimers(key);
    this.islands.clear();
    this.islandBoxes.clear();
    this.active = null;
    ++this.islandEpoch;
    if (this.view.liveIsland || this.view.filled || this.view.chip) this.patch({ liveIsland: null, filled: null, chip: null });
    for (const set of this.islandListeners.values()) for (const fn of set) fn();
  }

  // ----- more of a long page

  private lastMore = -Infinity;
  /** Near the end of a long list: the real page scrolled to its last node, so it loads more (section 14: `act scroll`). */
  more(): void {
    const now = performance.now();
    const doc = this.view.doc;
    if (now - this.lastMore < 2_000 || !doc || this.view.stale) return;
    let last: string | null = null;
    for (const [ref, t] of doc.nodes) if (t.block !== 'site') last = ref;
    if (!last) return;
    this.lastMore = now;
    this.act({ act: 'scroll', ref: last, to: 'start' });
  }

  // ----- images

  private readonly images = new Map<string, Promise<string | null>>();
  /** An image by its id, as a `blob:` URL made here (T47-5), kept for this window's 400 newest. */
  image(src: string): Promise<string | null> {
    const tabId = this.view.tabId;
    if (!tabId) return Promise.resolve(null);
    const key = `${tabId} ${src}`;
    let p = this.images.get(key);
    if (!p) {
      p = this.source.image(tabId, src).catch(() => null);
      this.images.set(key, p);
      if (this.images.size > 400) {
        const oldest = this.images.keys().next().value as string;
        void this.images.get(oldest)?.then((u) => u && URL.revokeObjectURL(u));
        this.images.delete(oldest);
      }
    }
    return p;
  }
}
