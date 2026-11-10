// The brain of one Browser window, outside React: which stream state to ask for, what the `<video>` plays,
// and what the window should show. Nothing here runs per frame. The element plays by itself and the browser
// composites it, so a live picture costs no React and no DOM write.
import type { BrowserInput, BrowserMedia, BrowserTab, DeskLink, DeskRpc, StreamState } from '../desk/deskLink';
import { LastSound } from '../desk/sound';
import { addressToUrl } from './address';
import { loadLastScreen, saveLastScreen } from './lastScreen';
import { CANT_CONTROL, PASTE_FAILED, PASTE_TOO_BIG, StreamClipboard } from './clipboard';
import { certainlyNotDone, mayHaveGoneOut, mutate } from './mutate';
import { OLDER_THAN_PROFILE, StreamControl, STREAM_DEADLINE_MS, type StreamStatus } from './streamControl';
import type { SimpleStream } from '../simple/ui';

/**
 * A hidden tab stays `live` this long, then goes `warm`, which stops the picture and the sound together. Not while
 * the desk is playing sound, though (`desk/sound.ts`, ADR 0038): then it stays `live` until the sound has stopped.
 */
export const HIDDEN_LIVE_MS = 5 * 60 * 1000;

export interface BrowserView {
  /** The desk's final no to the stream: `not_found`, `forbidden`, `chromium_older_than_profile`. */
  refused: string | null;
  /** The member's try after `chromium_older_than_profile` is on its way. */
  trying: boolean;
  /** The desk refused `live` with `bandwidth_limit` (deskd API.md section 10): the window shows the pause instead. */
  bandwidthPaused: boolean;
  /** The desk's own time for that pause's end, or null if it didn't say. */
  bandwidthResumesAt: string | null;
  canPlayVideo: boolean;
  /** A frame of this session has been shown. */
  hasFrame: boolean;
  /** The element holds some picture, maybe from an earlier session, for a scrim to sit over. */
  hadFrame: boolean;
  /** Playing without sound, because the browser refused sound before a gesture. */
  muted: boolean;
  tabs: BrowserTab[];
  /** An address typed before the desk was ready. It opens when the desk is. */
  pendingAddress: string | null;
  /** One calm sentence about the last thing that didn't work. */
  notice: string | null;
  /** Composed or pasted text that can't safely go by itself. It waits for the member to send or discard it. */
  heldText: string | null;
  /** An address that needs the member again. A new object each time, so the address bar always hears it. */
  keptAddress: { url: string } | null;
  /** Typing goes to the page. */
  streamFocused: boolean;
  /** The element holds the last screen kept in this browser (`lastScreen.ts`), until this session's first frame. */
  lastScreen: boolean;
}

const INITIAL: BrowserView = { refused: null, trying: false, bandwidthPaused: false, bandwidthResumesAt: null, canPlayVideo: true, hasFrame: false, hadFrame: false, muted: false, tabs: [], pendingAddress: null, notice: null, heldText: null, keptAddress: null, streamFocused: false, lastScreen: false };
const NOTICE_MS = 5_000;
/** How often the last screen is kept while it shows (`lastScreen.ts`): a JPEG of one frame, about 10 ms of work. */
export const LAST_SCREEN_EVERY_MS = 30_000;
const PICK_A_TAB = "This page can't take that from here. Pick a tab.";
/** It may have gone out. Nothing goes again by itself, even what would be harmless to repeat: the member looks first. */
const DIDNT_ANSWER = "The page didn't answer. Check it before trying again.";
/** The bar's line while the desk won't start an older Chromium on the member's profile (ADR 0035). */
const WAITING_FOR_UPDATE = 'Waiting for an update. Your sign-ins are safe.';
/**
 * A tab change can take about a second to reach `browser.tabs`, so a snapshot in that time may still show the old
 * one. What the member just did holds until a snapshot agrees or this runs out, and then the desk is asked.
 */
const TAB_CHANGE_HOLD_MS = 2_000;
/** `browser.tab.navigate` answers when the page commits, or after 30 s (deskd API.md section 10). */
const NAVIGATE_DEADLINE_MS = 35_000;
/** How long `live` may go with no picture before asking again. A unit that died says nothing, and this starts it. */
const NO_PICTURE_ASK_AGAIN_MS = 30_000;
/**
 * Looked at again after a still (task 46): from the moment the window takes the stream back to its first real frame,
 * measured as `ma:browser-back`. Only the last one is kept.
 */
export const BACK_MARK = 'ma:browser-seen';
export const BACK_MEASURE = 'ma:browser-back';

export class BrowserDriver {
  private view = INITIAL;
  private readonly listeners = new Set<() => void>();
  private link: DeskLink | null = null;
  private offMedia: (() => void) | null = null;
  private offCursor: (() => void) | null = null;
  private offTabs: (() => void) | null = null;
  private offClipboard: (() => void) | null = null;
  private readonly clipboard = new StreamClipboard({
    link: () => this.link,
    open: () => this.mounted,
    insert: (text) => this.insertText(text),
    say: (line) => this.say(line),
  });
  /** `browser.tabs` has spoken in this session, so a slower `browser.tab.list` has nothing to add. */
  private tabsHeard = false;
  /** The desk's own last word on tabs. `view.tabs` is this, with what the member just did on top. */
  private deskTabs: BrowserTab[] = [];
  private heldActive: string | null = null;
  private readonly heldClosed = new Set<string>();
  private holdTimer = 0;
  private noticeTimer = 0;
  /** What's said for as long as text is held. */
  private heldLine = PICK_A_TAB;
  private noPictureTimer = 0;
  private media: BrowserMedia | null = null;
  private video: HTMLVideoElement | null = null;
  /** Holds the last frame once a session has gone: a closed PeerConnection ends its tracks, and the element goes black. */
  private held: HTMLCanvasElement | null = null;
  private readonly control: StreamControl;
  /** The desk whose last screen this window keeps (ma-platform ADR 0097): only one that starts with the office. */
  private lastScreenDesk: string | null = null;
  private lastScreenAsked = false;
  private lastScreenTimer = 0;

  private mounted = false;
  private parked = false;
  /** The simple view (task 47): `simple` keeps the stream warm, `island` streams one island's crop, `off` is the full page. */
  private simple: SimpleStream = 'off';
  /** The simple view is over the stream, though the stream may already be `off` while the real page catches up. */
  private covered = false;
  /**
   * Parked while it wants `live`, on a desk that knows `desk.attention`: the stream stays `live` while the window is open,
   * which the desk holds at `warm`'s cost while nobody looks and sends again the moment someone does, so coming back needs
   * no call (deskd API.md section 10, "Nobody looking"). Anywhere else, parked is `off`, as the design always had it.
   */
  private parkedLive = false;
  /** The desk says it has frozen its Chromium, for want of anyone looking (task 46, `desk/attention.ts`). */
  private frozen = false;
  /** The element has let go of the stream, and the held canvas shows the picture as it was (`holdStill`). */
  private detached = false;
  /** The held canvas holds a frame of this window's own picture, not a last screen read back from storage. */
  private heldIsLive = false;
  /** A still is waiting for the first real frame, to measure `ma:browser-back`. */
  private backPending = false;
  private hiddenLong = false;
  private hiddenTimer = 0;
  private readonly sound = new LastSound();
  private stopUnmuting: (() => void) | null = null;
  /** Cancels waiting for the first packet or frame of a session that has since gone. */
  private cancelWatch: (() => void) | null = null;

  constructor() {
    this.control = new StreamControl(
      (state) => this.sendStream(state),
      (status) => this.onStreamStatus(status),
    );
  }

  // ----- what the window reads

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  readonly getView = (): BrowserView => this.view;

  private patch(p: Partial<BrowserView>): void {
    const keys = Object.keys(p) as (keyof BrowserView)[];
    if (keys.every((k) => this.view[k] === p[k])) return;
    this.view = { ...this.view, ...p };
    for (const fn of this.listeners) fn();
  }

  // ----- the window's life

  mount(): void {
    this.mounted = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    this.onVisibility();
    this.apply();
    this.syncSubscriptions();
  }

  /** Closed. An `off` still on its way carries on, so the desk isn't left streaming to nobody. */
  unmount(): void {
    this.mounted = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.clearTimeout(this.hiddenTimer);
    this.stopUnmuting?.();
    window.clearTimeout(this.noticeTimer);
    window.clearTimeout(this.noPictureTimer);
    window.clearTimeout(this.holdTimer);
    if (this.lastScreenTimer) window.clearInterval(this.lastScreenTimer);
    this.keepScreen();
    this.clipboard.sessionChanged();
    this.apply();
    this.syncSubscriptions();
    this.releaseIfDone();
  }

  /**
   * Keep this desk's last screen in this browser, and show it at once while the desk wakes (ma-platform ADR 0097: the
   * Alliance Member's desk, which starts with the office). Null keeps nothing. A copy is kept every
   * LAST_SCREEN_EVERY_MS while a frame shows and the tab is seen, when the tab hides, and when the session goes.
   */
  setLastScreen(deskId: string | null): void {
    if (deskId === this.lastScreenDesk) return;
    this.lastScreenDesk = deskId;
    this.lastScreenAsked = false;
    if (this.lastScreenTimer) window.clearInterval(this.lastScreenTimer);
    this.lastScreenTimer = 0;
    if (!deskId) return;
    this.lastScreenTimer = window.setInterval(() => {
      if (!document.hidden && !this.detached) this.keepScreen();
    }, LAST_SCREEN_EVERY_MS);
    void this.showLastScreen();
  }

  /** What the picture shows now, kept: the still while there is one. Nothing while no frame of this window has shown. */
  private keepScreen(): void {
    const { lastScreenDesk: desk, video, held } = this;
    // Under the simple view the element holds an island's crop or an old frame, which isn't the desk's screen.
    if (!desk || this.simple !== 'off') return;
    if (this.detached) {
      if (held && this.heldIsLive && !held.hidden) void saveLastScreen(desk, held);
    } else if (video && this.view.hasFrame && video.videoWidth) void saveLastScreen(desk, video);
  }

  /** The kept picture into the held canvas, once a window, if nothing of this session has shown yet. */
  private async showLastScreen(): Promise<void> {
    const desk = this.lastScreenDesk;
    const held = this.held;
    if (!desk || !held || this.lastScreenAsked || this.view.hasFrame || this.view.hadFrame) return;
    this.lastScreenAsked = true;
    const blob = await loadLastScreen(desk);
    if (!blob || typeof createImageBitmap !== 'function') return;
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      return;
    }
    // A real frame got here first, or the window went: the copy has nothing left to do.
    if (this.held !== held || this.view.hasFrame || this.lastScreenDesk !== desk) {
      bitmap.close();
      return;
    }
    held.width = bitmap.width;
    held.height = bitmap.height;
    held.getContext('2d')?.drawImage(bitmap, 0, 0);
    bitmap.close();
    held.hidden = false;
    this.heldIsLive = false;
    this.patch({ hadFrame: true, lastScreen: true });
  }

  /** A closed window lets go of its link once the desk has heard `off`, and not before. */
  private releaseIfDone(): void {
    if (this.mounted || !this.control.settled()) return;
    this.offMedia?.();
    this.offCursor?.();
    this.offMedia = null;
    this.offCursor = null;
    this.link = null;
  }

  /**
   * Its desk isn't the one on screen (`desk/attention.ts`): a still. The stream stays `live` where this session's desk has
   * said yes to `desk.attention.set` and this window wanted `live` (the Desk Engineer's part b: "keep `live` while its
   * Browser window is open"), and is `off` otherwise.
   */
  setParked(parked: boolean): void {
    if (parked !== this.parked) this.parkedLive = parked && this.wanted() === 'live' && this.link?.knowsAttention?.() === true;
    this.parked = parked;
    if (parked) this.syncStill(); // the picture as it is, before the desk stops sending it
    this.apply();
    if (!parked) this.syncStill(); // after `live` has gone out
  }

  /**
   * The desk's word on `desk.attention`. A parked window has its still already, so only a hidden tab acts on it: there
   * the stream can stay `live` for the sound (ADR 0038), and only the desk knows whether it froze or kept playing.
   */
  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
    this.syncStill();
  }

  private stillWanted(): boolean {
    return this.parked || (this.frozen && document.hidden);
  }

  private syncStill(): void {
    if (this.stillWanted()) this.holdStill();
    else this.leaveStill();
  }

  /**
   * Unseen (task 46): the picture as it was goes into the held canvas, and the element lets go of the stream, so nothing
   * decodes or plays and no input can reach the page. In memory only.
   */
  private holdStill(): void {
    const video = this.video;
    if (this.detached || !video) return;
    // Taken back a moment ago and no frame yet: the still over it is still the newest picture there is.
    const fresh = !this.backPending;
    this.detached = true;
    this.backPending = false;
    this.cancelWatch?.();
    this.cancelWatch = null;
    if (fresh) this.copyFrame();
    video.srcObject = null;
  }

  /** Looked at again: the element takes the stream back, and the still stays until its first real frame (`watchFirstFrame`). */
  private leaveStill(): void {
    if (!this.detached) return;
    this.detached = false;
    performance.clearMarks(BACK_MARK);
    performance.mark(BACK_MARK);
    this.backPending = true;
    this.showMedia();
  }

  /**
   * The simple view covers the stream. Until it steps aside, nothing the member does reaches the unseen real page by the
   * stream: no key, text, paste or pointer (security review T47O-2). Its own actions go by `act`, its islands by `media`.
   */
  setCovered(covered: boolean): void {
    this.covered = covered;
  }

  /** The stream takes no input: the simple view covers it, or shows over it while the real page catches up. */
  private get inputHeld(): boolean {
    return this.covered || this.simple !== 'off';
  }

  /** What the simple view needs of the stream (`simple/ui.ts`). The full page is `off`, as it was before the simple view. */
  setSimple(simple: SimpleStream): void {
    if (simple === this.simple) return;
    this.simple = simple;
    this.apply();
  }

  /**
   * The next frame the element shows, once: how the simple view knows the full page has caught up and can step aside
   * (design 7.4, "The minified view stays on screen until it does"). Returns a cancel.
   */
  onNextFrame(fn: () => void): () => void {
    const video = this.video;
    if (!video || typeof video.requestVideoFrameCallback !== 'function') {
      const id = window.setTimeout(fn, 300);
      return () => window.clearTimeout(id);
    }
    const id = video.requestVideoFrameCallback(() => fn());
    return () => video.cancelVideoFrameCallback(id);
  }

  setLink(link: DeskLink | null): void {
    if (link === this.link) return;
    this.offMedia?.();
    this.offCursor?.();
    this.offTabs?.();
    this.offTabs = null;
    this.offClipboard?.();
    this.offClipboard = null;
    this.clipboard.sessionChanged();
    this.link = link;
    this.offMedia = link?.onMedia(this.onMedia) ?? null;
    this.offCursor = link?.onCursor(this.onCursor) ?? null;
    this.onMedia(); // first: `browser.stream.set` is what starts the browser
    this.syncSubscriptions();
  }

  private syncSubscriptions(): void {
    if (this.mounted && this.link && !this.offTabs) {
      this.offTabs = this.link.subscribe('browser.tabs', (m) => this.onTabs(m.tabs), (code) => this.onTabsRefused(code));
      this.offClipboard = this.link.subscribe('browser.clipboard', (m) => this.clipboard.onEvent(m.type), (code) => this.clipboard.onTopicRefused(code));
    } else if (!this.mounted && this.offTabs) {
      this.offTabs();
      this.offTabs = null;
      this.offClipboard?.();
      this.offClipboard = null;
    }
  }

  private readonly onVisibility = (): void => {
    window.clearTimeout(this.hiddenTimer);
    if (document.hidden) {
      this.keepScreen();
      this.hiddenTimer = window.setTimeout(() => this.hiddenCheck(), HIDDEN_LIVE_MS);
    } else if (this.hiddenLong) {
      this.hiddenLong = false;
      this.apply();
    }
    this.syncStill();
  };

  /** Hidden past `HIDDEN_LIVE_MS`. While the desk plays sound the stream stays live, and this looks again when it may have stopped. */
  private hiddenCheck(): void {
    // Asked before `apply()`, whose own ask can only find less left: asked after, the clock could tick past the end in
    // between, leaving the stream live with no look again.
    const left = this.sound.left(this.media);
    this.hiddenLong = true;
    this.apply();
    if (left > 0) this.hiddenTimer = window.setTimeout(() => this.hiddenCheck(), left);
  }

  private wanted(): StreamState {
    if (!this.mounted || (this.parked && !this.parkedLive) || !this.view.canPlayVideo) return 'off';
    if (this.simple === 'simple') return 'warm';
    return this.hiddenLong && !this.sound.playing(this.media) ? 'warm' : 'live';
  }

  private apply(): void {
    this.control.set(this.wanted());
  }

  // ----- input

  /** The session's input, read per event so a new session is picked up with no wiring. */
  readonly input = (): BrowserInput | null => (this.inputHeld ? null : (this.link?.input() ?? null));

  /** The pointer is drawn locally (B12), so a new shape is one style write and never lags. */
  private readonly onCursor = (css: string): void => {
    if (this.video) this.video.style.cursor = css;
  };

  /**
   * Composed text, and pastes on a desk that can't take them on its clipboard. No `tabId`: what the member types goes
   * only to the tab on screen, or nowhere. It can't be queued silently, so a failure says so. Text that deskd couldn't
   * place, or that isn't certain to have failed, such as when the session drops while waiting, waits for the member
   * and is never sent again by itself.
   */
  readonly insertText = (text: string): void => {
    const link = this.link;
    if (!link || this.inputHeld) return;
    mutate((idem) => link.call('browser.text.insert', { text }, { idem })).catch((err: unknown) => {
      const { code = '', details = {} } = (err ?? {}) as { code?: string; details?: { reason?: string } };
      if (code === 'unavailable' && details.reason === 'active_tab') {
        this.holdText(text, PICK_A_TAB);
        this.listTabs(true);
      } else if (!certainlyNotDone(err)) this.holdText(text, DIDNT_ANSWER);
      else if (code === 'forbidden') this.say(CANT_CONTROL);
      else if (code === 'too_large') this.say(PASTE_TOO_BIG);
      else this.say(PASTE_FAILED);
    });
  };

  private holdText(text: string, line: string): void {
    this.heldLine = line;
    this.patch({ heldText: (this.view.heldText ?? '') + text });
    this.say(line, true);
  }

  /** Only ever by the member's own press: it's a new action with a new key, and it could land in another tab. */
  readonly sendHeldText = (): void => {
    const text = this.view.heldText;
    if (text === null || !this.link) return;
    this.patch({ heldText: null, notice: null });
    this.insertText(text);
  };

  readonly dropHeldText = (): void => this.patch({ heldText: null, notice: null });

  /** A real paste, and the key to press once the text is on the desk. */
  readonly paste = (text: string, pressKey: () => void, repeat: boolean): void => {
    if (!this.inputHeld) this.clipboard.paste(text, pressKey, repeat);
  };

  /** In the member's own chord or click, which is what lets their browser take the copy (`browser/clipboard.ts`). */
  readonly copyGesture = (chord: boolean): void => this.clipboard.gesture(chord);

  readonly setStreamFocused = (streamFocused: boolean): void => this.patch({ streamFocused });

  readonly noteTouch = (): void => this.say("Touch control isn't here yet. You can watch.");

  // ----- tabs and the address bar

  private onTabs(tabs: unknown): void {
    this.tabsHeard = true;
    this.setTabs(tabs);
  }

  /** A refresh took video away, so there's no picture and no list to come. Say so once, and stop asking. */
  private onTabsRefused(code: string): void {
    if (code === 'forbidden') this.control.refuse(code);
  }

  private setTabs(tabs: unknown): void {
    if (!Array.isArray(tabs)) return;
    this.deskTabs = tabs as BrowserTab[];
    // A hold ends when the desk agrees.
    if (this.heldActive && this.deskTabs.some((t) => t.tabId === this.heldActive && t.active)) this.heldActive = null;
    for (const id of this.heldClosed) {
      if (!this.deskTabs.some((t) => t.tabId === id)) this.heldClosed.delete(id);
    }
    if (!this.heldActive && !this.heldClosed.size) window.clearTimeout(this.holdTimer);
    this.showTabs();
  }

  private showTabs(): void {
    let shown = this.deskTabs.filter((t) => !this.heldClosed.has(t.tabId));
    const active = this.heldActive && shown.some((t) => t.tabId === this.heldActive) ? this.heldActive : null;
    if (active) shown = shown.map((t) => (t.active === (t.tabId === active) ? t : { ...t, active: t.tabId === active }));
    else if (this.heldClosed.size && shown[0] && !shown.some((t) => t.active)) shown[0] = { ...shown[0], active: true };
    // Up to 4 times a second while a page loads. Nothing new means no render.
    if (JSON.stringify(shown) !== JSON.stringify(this.view.tabs)) this.patch({ tabs: shown });
  }

  private holdTabChange(): void {
    this.showTabs();
    window.clearTimeout(this.holdTimer);
    this.holdTimer = window.setTimeout(() => this.endHold(), TAB_CHANGE_HOLD_MS);
  }

  /** What the member did didn't show, or didn't happen. Ask the desk, and show the answer. */
  private endHold(): void {
    window.clearTimeout(this.holdTimer);
    this.heldActive = null;
    this.heldClosed.clear();
    this.listTabs(true);
  }

  /** `always`: what we hold is known to be stale. Otherwise a snapshot that beat the answer is newer than it. */
  private listTabs(always = false): void {
    const link = this.link;
    if (!link) return;
    link.call('browser.tab.list').then(
      (r) => {
        if (this.link === link && (always || !this.tabsHeard)) this.setTabs(r.tabs);
      },
      () => {
        if (this.link === link) this.showTabs();
      },
    );
  }

  /** `lasting`: it stays until the member has dealt with what it's about. */
  private say(notice: string, lasting = false): void {
    window.clearTimeout(this.noticeTimer);
    this.patch({ notice });
    if (!lasting) this.noticeTimer = window.setTimeout(() => this.patch({ notice: this.view.heldText === null ? null : this.heldLine }), NOTICE_MS);
  }

  /** False when there's nothing to open. Before the desk is ready, it holds the address and says so. */
  navigate(typed: string): boolean {
    const url = addressToUrl(typed);
    if (!url) return false;
    if (this.media) this.tabAction('browser.tab.navigate', { url }, NAVIGATE_DEADLINE_MS);
    else this.patch({ pendingAddress: url });
    return true;
  }

  back(): void {
    this.tabAction('browser.tab.back', {});
  }

  forward(): void {
    this.tabAction('browser.tab.forward', {});
  }

  reload(): void {
    this.tabAction('browser.tab.reload', {});
  }

  openTab(): void {
    this.tabAction('browser.tab.open', {});
  }

  /** A link's middle click in the simple view: a new tab on the desk, at an http(s) address the view has checked. */
  openTabAt(url: string): void {
    this.tabAction('browser.tab.open', { url });
  }

  /** At once here. It holds through the second the topic can take to show it, and then the desk has the last word. */
  activateTab(tabId: string): void {
    this.heldActive = tabId;
    this.holdTabChange();
    this.tabAction('browser.tab.activate', { tabId });
  }

  closeTab(tabId: string): void {
    this.heldClosed.add(tabId);
    if (this.heldActive === tabId) this.heldActive = null;
    this.holdTabChange();
    this.tabAction('browser.tab.close', { tabId });
  }

  private tabAction<M extends keyof DeskRpc>(method: M, params: Record<string, unknown>, deadlineMs?: number): void {
    const link = this.link;
    if (!link) return;
    if (this.view.refused === OLDER_THAN_PROFILE) {
      // There's no Chromium to take it until the desk is fixed, and asking would only wait out the retries. An address stays.
      if (typeof params['url'] === 'string') this.patch({ keptAddress: { url: params['url'] } });
      this.say(WAITING_FOR_UPDATE);
      return;
    }
    mutate((idem) => link.call(method, params, deadlineMs ? { idem, deadlineMs } : { idem })).catch((err: unknown) => this.onTabActionFailed(err, method, params));
  }

  private onTabActionFailed(err: unknown, method: keyof DeskRpc, params: Record<string, unknown>): void {
    const { code = '', details = {} } = (err ?? {}) as { code?: string; details?: { reason?: string } };
    // deskd can't tell which tab is on screen, or it's a page it doesn't list. Naming a tab gets past that.
    const pickATab = code === 'unavailable' && details.reason === 'active_tab';
    const mayHave = mayHaveGoneOut(err);
    const goneTab = code === 'not_found' && details.reason === 'tab'; // Chromium restarted, or it closed itself
    if (method === 'browser.tab.activate' || method === 'browser.tab.close') this.endHold(); // the desk has the last word now
    else if (pickATab || mayHave || goneTab) this.listTabs(true);
    if ((pickATab || mayHave) && typeof params['url'] === 'string') this.patch({ keptAddress: { url: params['url'] } });

    if (pickATab) this.say(PICK_A_TAB);
    else if (mayHave) this.say(DIDNT_ANSWER);
    else if (code === 'bad_request' && details.reason === 'scheme') this.say('Only web addresses open here.');
    else if (code === 'bad_request' && details.reason === 'url') this.say("That isn't a web address.");
    else if (code === 'forbidden' && details.reason === 'blocked') this.say('This desk blocks that address.');
    else if (code === 'forbidden') this.say(CANT_CONTROL); // `reason: "permission"`, and asking again won't change it
    else if (code === 'not_found' && !goneTab) this.say("This desk's Browser can't do that yet.");
    else if (code === 'unavailable') this.say("The desk's browser is still starting. Try again in a moment.");
    else if (code && !goneTab) this.say("That didn't work. Try again.");
    // No code: it never left, because the session has gone, and the window already says so.
  }

  // ----- the stream

  private sendStream(state: StreamState): Promise<unknown> {
    return this.link?.call('browser.stream.set', { state }, { deadlineMs: STREAM_DEADLINE_MS }) ?? Promise.reject(new Error('no link'));
  }

  /** Only ever the member's press, after `chromium_older_than_profile`. One `live`, which may find the desk fixed. */
  readonly retryStream = (): void => this.control.retry();

  private onStreamStatus(status: StreamStatus): void {
    this.patch({ refused: status.refused, trying: status.trying, bandwidthPaused: status.bandwidthPaused, bandwidthResumesAt: status.resumesAt });
    // `warm` is enough for the tabs and a waiting address: the simple view needs no picture (task 47).
    if (status.live || (status.ready && this.simple !== 'off')) {
      if (!this.tabsHeard) this.listTabs();
      const url = this.view.pendingAddress;
      if (url) {
        this.patch({ pendingAddress: null });
        this.tabAction('browser.tab.navigate', { url }, NAVIGATE_DEADLINE_MS);
      }
      this.watchForNoPicture();
    }
    this.releaseIfDone();
  }

  private watchForNoPicture(): void {
    window.clearTimeout(this.noPictureTimer);
    if (this.view.hasFrame || this.view.refused || !this.media || this.wanted() !== 'live') return;
    this.noPictureTimer = window.setTimeout(() => {
      // A hidden tab shows no frames, so it can't tell.
      if (!document.hidden) this.control.again();
      this.watchForNoPicture();
    }, NO_PICTURE_ASK_AGAIN_MS);
  }

  private readonly onMedia = (): void => {
    const next = this.link?.media() ?? null;
    if (next === this.media) return;
    this.sound.left(this.media); // the last word of the session going, so a reconnect isn't taken for the sound stopping
    this.media = next;
    this.cancelWatch?.();
    this.cancelWatch = null;
    this.clipboard.sessionChanged();
    if (!next) {
      window.clearTimeout(this.noPictureTimer);
      window.clearTimeout(this.holdTimer);
      this.heldActive = null;
      this.heldClosed.clear();
      this.holdLastFrame();
      this.control.down();
      return;
    }
    this.tabsHeard = false;
    this.parkedLive = false; // a new session starts `off`, and an unseen desk's has nothing to keep
    this.patch({ canPlayVideo: next.canPlayVideo, hasFrame: false });
    this.apply();
    this.control.up();
    this.showMedia();
  };

  /** The element holds its last frame, so a new session's stream goes on only once it has something to show. Never under a still. */
  private showMedia(): void {
    const video = this.video;
    const media = this.media;
    if (this.detached || !video || !media || !media.canPlayVideo || video.srcObject === media.stream) return;
    const track = media.stream.getVideoTracks()[0];
    const swap = (): void => {
      this.cancelWatch = null;
      video.srcObject = media.stream;
      this.play(video);
      this.watchFirstFrame(video, media);
    };
    if (video.srcObject && track?.muted) {
      track.addEventListener('unmute', swap, { once: true });
      this.cancelWatch = () => track.removeEventListener('unmute', swap);
    } else {
      swap();
    }
  }

  private watchFirstFrame(video: HTMLVideoElement, media: BrowserMedia): void {
    let done = false;
    const seen = (): void => {
      if (done || this.media !== media) return;
      done = true;
      performance.mark('ma:browser-first-frame');
      if (this.backPending) {
        this.backPending = false;
        try {
          performance.clearMeasures(BACK_MEASURE);
          performance.measure(BACK_MEASURE, BACK_MARK);
        } catch {
          // The mark went, cleared elsewhere: a number for tests and the real-desk check, never anything a member sees.
        }
      }
      this.releaseHeldFrame();
      this.patch({ hasFrame: true, hadFrame: true, lastScreen: false });
    };
    if (typeof video.requestVideoFrameCallback === 'function') {
      const id = video.requestVideoFrameCallback(seen);
      this.cancelWatch = () => video.cancelVideoFrameCallback(id);
    } else {
      video.addEventListener('loadeddata', seen, { once: true });
      this.cancelWatch = () => video.removeEventListener('loadeddata', seen);
    }
  }

  // ----- the element

  /**
   * One copy, when the session goes. The link says so before it closes the PeerConnection, so there's a frame to take.
   * Under a still there's nothing new: the still is the last frame.
   */
  private holdLastFrame(): void {
    const held = this.held;
    if (!held || !(this.copyFrame() || (this.detached && this.heldIsLive && !held.hidden))) return;
    // Under the simple view the element holds an island's crop or an old frame, which isn't the desk's screen.
    if (this.lastScreenDesk && this.simple === 'off') void saveLastScreen(this.lastScreenDesk, held);
  }

  /** What the element shows now, into the held canvas over it. False if it shows no frame of this window's picture. */
  private copyFrame(): boolean {
    const { video, held } = this;
    if (!video || !held || !this.view.hasFrame || !video.videoWidth) return false;
    held.width = video.videoWidth;
    held.height = video.videoHeight;
    held.getContext('2d')?.drawImage(video, 0, 0);
    held.hidden = false;
    this.heldIsLive = true;
    return true;
  }

  private releaseHeldFrame(): void {
    const { held } = this;
    if (!held || held.hidden) return;
    held.hidden = true;
    held.width = 0; // lets go of the bitmap
    this.heldIsLive = false;
  }

  /** Called from the click that opened the window, when the session is already up: that's what lets sound play. */
  attachVideo(video: HTMLVideoElement, held: HTMLCanvasElement | null = null): () => void {
    this.video = video;
    this.held = held;
    void this.showLastScreen();
    this.showMedia();
    if (!video.srcObject) this.play(video);
    return () => {
      this.cancelWatch?.();
      this.cancelWatch = null;
      this.stopUnmuting?.();
      video.srcObject = null;
      if (this.video === video) {
        this.video = null;
        this.held = null;
      }
    };
  }

  private play(video: HTMLVideoElement): void {
    if (this.view.muted) {
      video.play().catch(() => {});
      return;
    }
    video.muted = false;
    video.play().catch((err: unknown) => {
      if (this.video === video && err instanceof DOMException && err.name === 'NotAllowedError') this.muteUntilGesture(video);
    });
  }

  /** A reload with a window restored has no gesture behind it. Play silently, and bring sound in on the first one. */
  private muteUntilGesture(video: HTMLVideoElement): void {
    video.muted = true;
    video.play().catch(() => {});
    this.patch({ muted: true });
    this.stopUnmuting?.();
    const unmute = (): void => {
      this.stopUnmuting?.();
      video.muted = false;
      this.patch({ muted: false });
      video.play().catch(() => {});
    };
    window.addEventListener('pointerdown', unmute, true);
    window.addEventListener('pointerup', unmute, true);
    window.addEventListener('keydown', unmute, true);
    this.stopUnmuting = () => {
      window.removeEventListener('pointerdown', unmute, true);
      window.removeEventListener('pointerup', unmute, true);
      window.removeEventListener('keydown', unmute, true);
      this.stopUnmuting = null;
    };
  }
}
