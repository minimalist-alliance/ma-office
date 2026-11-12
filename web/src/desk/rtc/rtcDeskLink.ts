// The real link: `connect` on api., `session.open` and `signal` on the gateway, then one WebRTC
// PeerConnection to the desk (design 4.2.1, 4.2.2, 4.2.7). This file is the policy; `peer.ts` holds
// the connection and `gateway.ts` the WebSocket. Nothing here runs per frame.
import { trafficStopOf } from '../trafficStop';
import { api, ApiError } from '../../platform/api';
import { SignInRequired } from '../../platform/auth';
import type { GuildAccess } from '../../guild/access';
import { ATTENTION_DEADLINE_MS, AttentionSignal } from '../attention';
import { DeskNotConnected, type BrowserInput, type BrowserMedia, type PhoneDevice, type BulkChannel, type CollabChannel, type DeskLink, type DeskRefusal, type DeskRpc, type LinkDetails, type LinkState, type LinkTopics, type RawTopicEvent, type RpcOptions } from '../deskLink';
import { backoffMs } from './backoff';
import { gateway, GatewayError, type GatewayListener, type GatewayMessage } from './gateway';
import { tabIdentity } from './identity';
import { PeerSession, type PeerHealth } from './peer';
import { CallWindow, closeCodeAction, CONNECT_CALLS_PER_MINUTE, notReadyRetryMs, RECHECK_FIRST_ATTEMPT, REFUSAL_CODES, refusalOf, sessionClosedAction, WAKE_POLL_MS, wakePollMs, type CloseAction } from './policy';
import { answerMatchesIdentity } from './sdp';
import { Subscriptions } from './subs';

const DESK_API = '1.0';
const BLIP_MS = 1_000;
const UNREACHABLE_MS = 30_000;
const OPEN_TIMEOUT_MS = 20_000;
const ANSWER_TIMEOUT_MS = 15_000;
const CHANNELS_TIMEOUT_MS = 15_000;
const RESTART_ANSWER_TIMEOUT_MS = 8_000;
const RESTART_CONNECT_TIMEOUT_MS = 10_000;
const REFRESH_RETRY_MS = 15_000;
const REFRESH_FALLBACK_MS = 3 * 60 * 1000;
const RATE_LIMIT_HOLD_MS = 30_000;
const RELOAD_GUARD_MS = 5 * 60 * 1000;
const WAKE_ASK_MS = 60_000;
const ACTIVITY_EVERY_MS = 60_000;
const RELOAD_KEY = 'ma.deskApi.reloadedAt';
/** A 429 from `connect` holds every call this long when it says nothing itself, and never longer than 5 minutes. */
const RATE_LIMITED_MS = 30_000;

/** Every `connect` in this tab, so the wake's fast poll keeps inside the member's limit (`CallWindow`). */
const connectCalls = new CallWindow(CONNECT_CALLS_PER_MINUTE, 60_000);

interface ConnectResponse {
  state?: string;
  phase?: string | null;
  deskToken: string;
  refreshAfter?: string;
  gateway?: string;
  deskIdentity?: { fingerprintsSha256?: string[] } | null;
  retryAfterSeconds?: number;
  pollAfterSeconds?: number;
  queue?: { position?: number } | null;
}

class IdentityMismatch extends Error {
  constructor() {
    super("the answer's a=fingerprint isn't one of the desk's");
    this.name = 'IdentityMismatch';
  }
}

/** The link rests until the desk list says it runs. `requested` and `provisioning` start on their own, so nothing asks. */
const isStopped = (state: string | undefined): boolean => state === 'stopped' || state === 'retained' || state === 'requested' || state === 'provisioning';

/**
 * How long until a desk that's stopping can be woken, from `connect`'s `409 invalid_state` (contract desks.md: from
 * `stopping`, with `retryAfterSeconds`), or null if the answer isn't that. 30 s if it gives no pace.
 */
function stoppingFor(err: ApiError): number | null {
  const d = err.details ?? {};
  const given = Number(d['retryAfterSeconds']) || err.retryAfterSec || 0;
  if (d['state'] !== 'stopping' && !given) return null;
  return Math.min(300, Math.max(1, given || 30)) * 1000;
}

/** A refusal the member should see, from `connect` or the gateway. */
function refusalFrom(err: unknown): DeskRefusal | null {
  const code = err instanceof ApiError || err instanceof GatewayError ? err.code : null;
  if (!code || !REFUSAL_CODES.has(code)) return null;
  return refusalOf(code, err instanceof ApiError ? err.details : null, window.location.hostname, err instanceof Error ? err.message : null);
}

/** A major `deskApi` mismatch means this bundle is out of date. Reload, but never in a loop. */
function reloadBundle(): boolean {
  try {
    if (Date.now() - Number(window.sessionStorage.getItem(RELOAD_KEY) ?? 0) < RELOAD_GUARD_MS) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

export class RtcDeskLink implements DeskLink, GatewayListener {
  readonly available = true;
  readonly deskId: string;

  private actual: LinkState = 'idle';
  private shown: LinkState = 'idle';
  private readonly statusListeners = new Set<(s: LinkState) => void>();
  private readonly detailListeners = new Set<() => void>();
  private info: LinkDetails = { unreachable: false, path: null, rttMs: null, desk: null, refusal: null, busy: false };

  /** connect() was called, and nothing has told the link to stop. */
  private wanted = false;
  /** The idle rule closed the session. Still `wanted`, so the watch and its token carry on. */
  private resting = false;
  private activitySentAt = 0;
  /** Until when `wake()`'s request holds: the next `connect` answer acts on it. Nobody's waiting after that. */
  private wakeAskedUntil = 0;
  /** When the member's request to wake runs out, across retries after a passing failure. */
  private wakeGiveUpAt = 0;
  private attempt = 0;
  private gen = 0;
  private retryTimer = 0;
  private notBefore = 0;
  private waitingForReady = false;
  /** `connect` answers since the last open that said not ready and set no pace. */
  private notReadyChecks = 0;
  /** `connect` has shown the desk on its way up since the last open. */
  private waking = false;
  /** When the gateway last said `phase: ready`. A `connect` asked before that may have an older answer. */
  private readyHeardAt = 0;
  /** A member asked for this desk while it was asleep or waking, so the wake is polled at `WAKE_POLL_MS`. */
  private wokeHere = false;
  /** When that wake was asked for: the fast poll lasts `WAKE_FAST_FOR_MS`. */
  private wakeStartedAt = 0;
  /** The desk is shown waking on the member's word alone (`showWaking`): nothing from `connect` has said so yet. */
  private shownWaking = false;

  private peer: PeerSession | null = null;
  private opened = false;
  private sessionId: string | null = null;
  private resume: { sessionId: string; resumeToken: string } | null = null;
  private restarting = false;
  private stopping = false;
  private answerWait: { resolve: (sdp: string) => void; reject: (e: Error) => void } | null = null;

  private token: string | null = null;
  private refreshAtMs = 0;
  private identity: string[] = [];
  private refreshTimer = 0;
  /** A session has been opened, so the gateway should report this desk's state from now on. */
  private watching = false;
  private watchedOn = -1;

  private lostSince: number | null = null;
  private blipTimer = 0;
  private unreachableTimer = 0;
  private setupStartedAt = 0;
  /** Outlives sessions: each new one asks for all of these again. */
  private readonly subs = new Subscriptions();
  /** `desk.attention.set`, again on each new session (`attention.ts`). An export session never says. */
  readonly attention = new AttentionSignal((seen, device) => this.call('desk.attention.set', device ? { seen, device } : { seen }, { deadlineMs: ATTENTION_DEADLINE_MS }));
  private currentMedia: BrowserMedia | null = null;
  private readonly mediaListeners = new Set<() => void>();
  private readonly cursorListeners = new Set<(css: string) => void>();

  /** `export`: a closed account's export-only session, asked for by the member's download (`createDeskLink`). */
  private readonly purpose: 'export' | undefined;
  /**
   * A guild's panel (task 48): its Guild Desk opens with a guild token from `guild/access.ts`, as data only. `deskId` stays the
   * panel's, for the office's stores; the gateway knows the Guild Desk by its own id, `remoteId`.
   */
  private readonly guild: GuildAccess | null;
  private remoteId: string;

  constructor(deskId: string, purpose?: 'export', guild: GuildAccess | null = null) {
    this.deskId = deskId;
    this.purpose = purpose;
    this.guild = guild;
    this.remoteId = deskId;
  }

  status(): LinkState {
    return this.shown;
  }

  onStatus(fn: (s: LinkState) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  details(): LinkDetails {
    return this.info;
  }

  onDetails(fn: () => void): () => void {
    this.detailListeners.add(fn);
    return () => this.detailListeners.delete(fn);
  }

  connect(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.stopping = false;
    gateway.add(this);
    window.addEventListener('online', this.onWakeUp);
    window.addEventListener('focus', this.onWakeUp);
    document.addEventListener('visibilitychange', this.onWakeUp);
    window.addEventListener('pagehide', this.onPageHide);
    this.setState('signaling');
    void this.establish();
  }

  close(): void {
    this.stop('idle', 'closed_by_client');
    if (this.info.refusal) this.patchInfo({ refusal: null });
    if (this.info.busy) this.patchInfo({ busy: false });
  }

  wake(): void {
    if (this.opened) return; // running
    if (this.waitingForReady) {
      // Already on its way up, perhaps from another tab: someone is waiting for it here now, so look sooner.
      if (this.waking) this.markWokeHere();
      return;
    }
    if (this.info.refusal) return; // `connect` refuses with or without `start`; `recheck` is the only way back
    this.wakeAskedUntil = this.wakeGiveUpAt = Date.now() + WAKE_ASK_MS;
    this.showWaking();
    if (this.resting) this.reopen();
    else if (this.wanted) this.retryNow(); // an answer is on its way, or a retry is
    else this.connect();
  }

  recheck(): void {
    const r = this.info.refusal;
    if (this.wanted || !r || r.kind === 'unavailable') return; // a desk that can't be opened is never asked again
    this.patchInfo({ refusal: null });
    this.connect();
  }

  private markWokeHere(): void {
    if (this.wokeHere) return;
    this.wokeHere = true;
    this.wakeStartedAt = Date.now();
  }

  /**
   * The member asked, and the last word on this desk is that it's stopped, so `start: true` is a round trip or two
   * away (`start: false` first, then the wake). Say it's waking now: the window and the status line said "asleep"
   * until the wake's own answer, about 2 s on a real desk (TD-227 part 3). Whatever `connect` says next replaces it,
   * and a wake that never goes out puts "stopped" back (`unshowWaking`). Not a Guild Desk's, whose wake is its own.
   */
  private showWaking(): void {
    if (this.guild || this.info.desk?.state !== 'stopped') return;
    this.patchDesk({ state: 'starting', phase: 'starting', queuePosition: null });
    this.shownWaking = true;
  }

  private unshowWaking(): void {
    if (!this.shownWaking) return;
    this.shownWaking = false;
    this.patchDesk({ state: 'stopped', phase: 'stopped', queuePosition: null });
  }

  /** The link rests, and nothing retries it: not a timer, not a poll, not a refresh, not a focus. */
  private refuse(r: DeskRefusal): void {
    this.patchInfo({ refusal: r }); // first, so nothing shows "access denied" in between
    this.stop('denied', 'closed_by_client');
  }

  rest(): void {
    if (!this.wanted || this.resting) return;
    this.resting = true;
    this.dropPeer('closed_by_client'); // keeps the desk's state for the resume window
    window.clearTimeout(this.retryTimer);
    this.retryTimer = 0;
    this.waitingForReady = false;
    this.notReadyChecks = 0;
    this.waking = false;
    this.wokeHere = false;
    this.wakeAskedUntil = 0;
    this.clearLost();
    this.setState('resting');
  }

  reopen(): void {
    if (!this.resting) return;
    this.resting = false;
    this.setState('signaling');
    void this.establish();
  }

  reportActivity(): void {
    const now = Date.now();
    if (!this.opened || now - this.activitySentAt < ACTIVITY_EVERY_MS) return;
    this.activitySentAt = now;
    this.peer?.sendActivity(new Date(now).toISOString().replace(/\.\d+Z$/, 'Z'));
  }

  setSeen(seen: boolean): void {
    // A Guild Desk has no Browser to freeze, and many members: nobody's looking means nothing to it.
    if (this.purpose !== 'export' && !this.guild) this.attention.want(seen);
  }

  knowsAttention(): boolean {
    return this.attention.answer === 'ok';
  }

  setDevice(device: PhoneDevice | null): void {
    if (this.purpose !== 'export' && !this.guild) this.attention.device(device);
  }

  /** This session's id from the gateway, which `browser.view` names its phone by. */
  currentSessionId(): string | null {
    return this.sessionId;
  }

  call<M extends keyof DeskRpc>(method: M, params: Record<string, unknown> = {}, options?: RpcOptions): Promise<DeskRpc[M]> {
    if (!this.peer || !this.opened) return Promise.reject(new DeskNotConnected(this.deskId));
    return this.peer.call(method, params, options) as Promise<DeskRpc[M]>;
  }

  media(): BrowserMedia | null {
    return this.currentMedia;
  }

  onMedia(fn: () => void): () => void {
    this.mediaListeners.add(fn);
    return () => this.mediaListeners.delete(fn);
  }

  input(): BrowserInput | null {
    return this.opened ? (this.peer?.input ?? null) : null;
  }

  bulk(): BulkChannel | null {
    return this.opened ? (this.peer?.bulk ?? null) : null;
  }

  collab(): CollabChannel | null {
    return this.opened ? (this.peer?.collab ?? null) : null;
  }

  commons(): CollabChannel | null {
    return this.opened && this.guild ? (this.peer?.commons ?? null) : null;
  }

  onCursor(fn: (css: string) => void): () => void {
    this.cursorListeners.add(fn);
    return () => this.cursorListeners.delete(fn);
  }

  private setMedia(next: BrowserMedia | null): void {
    if (this.currentMedia === next) return;
    this.currentMedia = next;
    for (const fn of this.mediaListeners) fn();
  }

  subscribe<T extends keyof LinkTopics>(topic: T, fn: (msg: LinkTopics[T]) => void, onRefused?: (code: string) => void): () => void {
    return this.subs.subscribe(topic, {}, {
      event: ({ type, seq, data }) => {
        if (data && typeof data === 'object') fn({ ...data, type, seq } as LinkTopics[T]);
      },
      ...(onRefused ? { refused: onRefused } : {}),
    });
  }

  subscribeRaw(topic: string, fn: (e: RawTopicEvent) => void, onRefused?: (code: string) => void): () => void {
    return this.subs.subscribe(topic, {}, { event: ({ type, seq, data }) => fn({ type, seq, data }), ...(onRefused ? { refused: onRefused } : {}) });
  }

  // ----- state and what shows

  private setState(next: LinkState): void {
    this.actual = next;
    this.publish();
  }

  private publish(): void {
    if (this.blipTimer) return; // a loss shorter than 1 s shows nothing
    if (this.shown === this.actual) return;
    this.shown = this.actual;
    for (const fn of this.statusListeners) fn(this.shown);
  }

  private patchInfo(p: Partial<LinkDetails>): void {
    this.info = { ...this.info, ...p };
    for (const fn of this.detailListeners) fn();
  }

  private beginLost(): void {
    if (this.lostSince !== null) return;
    this.lostSince = Date.now();
    this.blipTimer = window.setTimeout(() => {
      this.blipTimer = 0;
      this.publish();
    }, BLIP_MS);
    this.unreachableTimer = window.setTimeout(() => this.patchInfo({ unreachable: true }), UNREACHABLE_MS);
  }

  private clearLost(): void {
    this.lostSince = null;
    window.clearTimeout(this.blipTimer);
    window.clearTimeout(this.unreachableTimer);
    this.blipTimer = 0;
    this.unreachableTimer = 0;
    if (this.info.unreachable) this.patchInfo({ unreachable: false });
  }

  // ----- opening a connection

  private async callConnect(start: boolean): Promise<ConnectResponse> {
    const { fingerprint } = await tabIdentity();
    if (this.guild) {
      const c = await this.guild.connect(start, fingerprint);
      if (c.remoteDeskId) this.remoteId = c.remoteDeskId;
      return c;
    }
    connectCalls.note(Date.now());
    const res = await api<ConnectResponse>(`/v1/desks/${encodeURIComponent(this.deskId)}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `purpose` is left out when there's none: JSON drops an undefined field.
      body: JSON.stringify({ scope: 'owner', start: start || !!this.purpose, clientDtlsFingerprint: fingerprint, purpose: this.purpose }),
    });
    if (!res.data) throw new Error('connect returned no body');
    return { ...res.data, retryAfterSeconds: res.data.retryAfterSeconds ?? (Number(res.retryAfter) || undefined) };
  }

  /** Whatever `connect` said, kept and passed on. */
  private absorbConnect(c: ConnectResponse): void {
    if (this.info.refusal) this.info = { ...this.info, refusal: null }; // told by `patchDesk`'s update
    if (this.info.busy) this.patchInfo({ busy: false });
    this.token = c.deskToken;
    this.identity = c.deskIdentity?.fingerprintsSha256 ?? this.identity;
    gateway.fallbackUrl(c.gateway);
    this.patchDesk({ state: c.state ?? null, phase: c.phase ?? null, queuePosition: c.queue?.position ?? null });
    this.scheduleRefresh(c.refreshAfter);
  }

  private patchDesk(p: Partial<NonNullable<LinkDetails['desk']>>): void {
    const cur = this.info.desk ?? { state: null, phase: null, queuePosition: null, stopAt: null };
    if (p.state !== undefined) this.shownWaking = false; // the desk's own word from here on
    this.patchInfo({ desk: { ...cur, ...p, heardAt: Date.now() } });
  }

  /** `start` is only ever true right after an answer that says a desk the member asked for is stopped. */
  private async establish(start = false): Promise<void> {
    const gen = ++this.gen;
    const stale = (): boolean => gen !== this.gen || !this.wanted;
    this.setupStartedAt = performance.now();
    this.waitingForReady = false;
    const askedAt = Date.now();
    try {
      const c = await this.callConnect(start);
      if (stale()) return;
      const asked = Date.now() < this.wakeAskedUntil;
      this.wakeAskedUntil = 0;
      if (asked || start) this.markWokeHere();
      // Not `retained`: that desk can't be started, only restored or exported.
      if (asked && !start && c.state === 'stopped') {
        // `start: true` goes out next, so this "stopped" is already out of date: it shows waking, as from the click.
        this.absorbConnect(this.guild ? c : { ...c, state: 'starting', phase: 'starting' });
        this.shownWaking = !this.guild;
        void this.establish(true);
        return;
      }
      this.absorbConnect(c);

      if (isStopped(c.state) || c.phase === 'failed') {
        this.stop('idle', 'closed_by_client');
        return;
      }
      if (c.state === 'stopping') {
        this.act('stopping');
        return;
      }
      // Open a session only at `ready`. A watch from an earlier session can end this wait early.
      if (c.phase !== 'ready' || !this.identity.length) {
        this.waitingForReady = true;
        if (c.state !== 'running') this.waking = true;
        if (this.waking) this.watchWake();
        const pace = (c.retryAfterSeconds ?? c.pollAfterSeconds ?? 0) * 1000;
        this.scheduleRetry(this.readyHeardAt >= askedAt ? 0 : this.notReadyWaitMs(c.phase ?? null, pace));
        return;
      }

      const opened = await gateway.request({ type: 'session.open', deskId: this.remoteId, deskToken: c.deskToken } as GatewayMessage, OPEN_TIMEOUT_MS);
      if (stale()) {
        if (opened.sessionId) gateway.send({ type: 'session.close', sessionId: opened.sessionId, reason: 'closed_by_client' });
        return;
      }
      if (!opened.sessionId) throw new GatewayError('bad_reply', 'session.opened had no sessionId', true);
      this.sessionId = opened.sessionId;
      if (this.watching) this.watchedOn = -1; // a wake's watch: again, with this session's token, which is refreshed from here on
      this.watching = true;
      this.ensureWatch();

      const { certificate } = await tabIdentity();
      if (stale()) return;
      const peer = new PeerSession(this.remoteId, certificate, opened.iceServers ?? [], {
        onHealth: (h) => this.onHealth(peer, h),
        onDown: () => this.onPeerDown(peer),
        onCloseFrame: (code, reason) => this.onCloseFrame(peer, code, reason),
        onRtt: (ms) => this.patchInfo({ rttMs: ms }),
        onEvent: (subId, seq, body) => this.subs.onEvent(subId, seq, body),
        onCursor: (css) => {
          for (const fn of this.cursorListeners) fn(css);
        },
      }, this.guild !== null);
      this.peer = peer;
      this.opened = false;
      const offer = await peer.createOffer();
      if (stale()) return;
      const answerSdp = await this.exchangeOffer(offer, false, ANSWER_TIMEOUT_MS);
      if (stale()) return;
      if (!answerMatchesIdentity(answerSdp, this.identity)) throw new IdentityMismatch();
      if (this.lostSince === null) this.setState('connecting');
      await peer.applyAnswer(answerSdp);
      await withTimeout(peer.channelsOpen, CHANNELS_TIMEOUT_MS, 'channels did not open');
      if (stale()) return;

      const hello = await peer.hello({ deskApi: DESK_API, appVersion: __MA_VERSION__, ...(this.resume ? { resume: this.resume } : {}) });
      if (stale()) return;
      if (hello.deskApi?.split('.')[0] !== DESK_API.split('.')[0]) {
        this.onApiMismatch();
        return;
      }
      if (hello.resumeToken) this.resume = { sessionId: this.sessionId, resumeToken: hello.resumeToken };

      peer.startPings();
      this.opened = true;
      this.attempt = 0;
      this.wakeAskedUntil = 0; // done with: a request that came during setup must not outlive it
      this.notReadyChecks = 0;
      this.waking = false;
      this.wokeHere = false;
      this.clearLost();
      performance.measure('ma:desk-link-open', { start: this.setupStartedAt });
      this.setState('open');
      this.setMedia(this.guild ? null : peer.media()); // first: `browser.stream.set`, which starts the browser, goes before anything that needs it
      this.attention.up(); // next to it: a desk frozen for want of a viewer thaws now, and an unseen one hears so at once
      this.subs.attach(peer, hello.resumed === true);
      void this.readPath(peer);
    } catch (err) {
      if (!stale()) this.onSetupFailed(err, start);
    }
  }

  /**
   * Until the next `connect` after one that said the desk isn't ready. A wake a member asked for here polls fast
   * (`wakePollMs`); anything else keeps `connect`'s pace or grows from 3 s. Never sooner than the tab's `connect`
   * budget has room for.
   */
  private notReadyWaitMs(phase: string | null, paceMs: number): number {
    const now = Date.now();
    const ms = this.waking && this.wokeHere ? wakePollMs({ phase, paceMs, wakeAgeMs: now - this.wakeStartedAt }) : paceMs || notReadyRetryMs(this.notReadyChecks++, this.waking);
    return Math.max(ms, connectCalls.waitMs(now));
  }

  /**
   * A desk on its way up is watched on the gateway now, with the wake's own token, not only once a session has opened
   * (contract gateway.md 2.1 and 2.2, desks.md "Restart on open"). Its `phase: ready` then arrives as a push, as soon
   * as the desk is on the gateway, and the poll is the fallback. A watch keeps nothing awake and spends no token.
   */
  private watchWake(): void {
    if (this.guild) return;
    if (!this.watching) {
      this.watching = true;
      if (!gateway.isUp()) void gateway.ready().catch(() => {}); // `onUp` sends it once the socket is open
    }
    this.ensureWatch();
  }

  private async readPath(peer: PeerSession): Promise<void> {
    const path = await peer.path().catch(() => null);
    if (path && this.peer === peer) this.patchInfo({ path });
  }

  /** Send an offer through `signal` and wait for the answer or a refusal. */
  private exchangeOffer(sdp: string, restart: boolean, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.answerWait?.reject(new Error('superseded'));
      const timer = window.setTimeout(() => {
        this.answerWait = null;
        reject(new GatewayError('timeout', 'no answer from the desk', true));
      }, timeoutMs);
      this.answerWait = {
        resolve: (answer) => {
          window.clearTimeout(timer);
          resolve(answer);
        },
        reject: (e) => {
          window.clearTimeout(timer);
          reject(e);
        },
      };
      const data = restart ? { type: 'offer', sdp, restart: true } : { type: 'offer', sdp };
      // The id brings any error back to `onMessage`, which fails this wait.
      if (!gateway.send({ type: 'signal', id: `signal:${this.sessionId}`, sessionId: this.sessionId ?? undefined, data })) {
        this.answerWait.reject(new GatewayError('gateway_down', "couldn't send the offer", true));
        this.answerWait = null;
      }
    });
  }

  private onSetupFailed(err: unknown, wasWake: boolean): void {
    if (err instanceof SignInRequired) {
      this.stop('idle', 'closed_by_client'); // the session layer takes it from here
      return;
    }
    // A free desk with no room yet (`503 free_capacity_wait`): a wait, not an error. Asked again at the pace it gives.
    if (err instanceof ApiError && err.code === 'free_capacity_wait') {
      this.patchInfo({ busy: true });
      this.setState('retrying');
      this.scheduleRetry(Math.min(600, Math.max(5, Number(err.details?.['retryAfterSeconds']) || err.retryAfterSec || 120)) * 1000);
      return;
    }
    const refusal = refusalFrom(err);
    if (refusal) {
      this.refuse(refusal); // a refused wake too: `start: false` would only be refused again
      return;
    }
    if (err instanceof ApiError && err.status === 429) {
      // The API's own limit: nothing goes before it says, however this link would otherwise retry.
      const given = Number(err.details?.['retryAfterSeconds']) || err.retryAfterSec || RATE_LIMITED_MS / 1000;
      this.notBefore = Math.max(this.notBefore, Date.now() + Math.min(300, Math.max(1, given)) * 1000);
    }
    if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
      if (this.purpose === 'export' && err.code === 'invalid_state' && stoppingFor(err) !== null) {
        // An export link always asks with `start: true`, and a desk that's stopping (its export window ended) says
        // `409` until it has stopped, when it can be woken again. So ask again at the pace it gives, still wanted.
        this.setState('retrying');
        this.scheduleRetry(stoppingFor(err)!);
        return;
      }
      if (wasWake) {
        // Refused a wake (a Give Back window, a spend cap): `start: false` isn't refused, and says why.
        this.scheduleRetry(0);
        return;
      }
      this.stop(err.status === 403 ? 'denied' : 'idle', 'closed_by_client');
      return;
    }
    if (err instanceof GatewayError && err.code === 'desk_stopping') {
      this.act('stopping');
      return;
    }
    if (err instanceof IdentityMismatch) {
      // Rotated, or someone else answering. The next try asks `connect` for a fresh list.
      console.warn(`Desk ${this.deskId}: ${err.message}`);
      this.dropPeer('identity_mismatch');
    } else {
      this.dropPeer('closed_by_client');
    }
    // A wake that hit a passing failure is still wanted: the retry asks again while the request holds.
    if (wasWake && Date.now() < this.wakeGiveUpAt) this.wakeAskedUntil = this.wakeGiveUpAt;
    // A wake shown on the member's word alone, whose request has run out: no `start: true` got through, so it's asleep.
    else if (Date.now() >= this.wakeGiveUpAt && Date.now() >= this.wakeAskedUntil) this.unshowWaking();
    this.retryWithBackoff();
  }

  // ----- keeping it open and repairing it

  private retryWithBackoff(): void {
    this.beginLost();
    this.setState('retrying');
    // In a wake's fast poll a failure never asks sooner than the poll would have.
    const ms = backoffMs(this.attempt);
    this.scheduleRetry(this.waking && this.wokeHere ? Math.max(ms, WAKE_POLL_MS) : ms);
    this.attempt += 1;
  }

  private scheduleRetry(ms: number): void {
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = 0;
      void this.establish();
    }, Math.max(ms, this.notBefore - Date.now()));
  }

  /** `online`, tab focus, or the gateway saying the desk is ready: don't wait out the backoff. */
  private retryNow(): void {
    if (!this.retryTimer || Date.now() < this.notBefore) return;
    window.clearTimeout(this.retryTimer);
    this.retryTimer = 0;
    void this.establish();
  }

  private readonly onWakeUp = (): void => {
    if (document.hidden || !this.wanted) return;
    gateway.kick();
    this.peer?.recheck();
    this.retryNow();
  };

  private readonly onPageHide = (): void => {
    if (this.sessionId) gateway.send({ type: 'session.close', sessionId: this.sessionId, reason: 'closed_by_client' });
  };

  private onHealth(peer: PeerSession, h: PeerHealth): void {
    if (peer !== this.peer || !this.opened) return;
    if (h === 'connected') {
      if (this.lostSince !== null && !this.restarting) this.recovered(peer);
    } else if (h === 'disconnected') {
      this.onTrouble(peer);
    } else {
      this.abandon('closed_by_client');
    }
  }

  private onPeerDown(peer: PeerSession): void {
    if (peer === this.peer && this.opened) this.onTrouble(peer);
  }

  private onTrouble(peer: PeerSession): void {
    this.beginLost();
    if (this.stopping) {
      this.act('stopping');
      return;
    }
    if (!this.restarting) void this.restartIce(peer);
  }

  /** ICE restart first: same PeerConnection, so DTLS, SCTP and channels carry on. */
  private async restartIce(peer: PeerSession): Promise<void> {
    this.restarting = true;
    this.setState('resuming');
    try {
      const offer = await peer.createOffer(true);
      if (peer !== this.peer) return;
      const answer = await this.exchangeOffer(offer, true, RESTART_ANSWER_TIMEOUT_MS);
      if (peer !== this.peer) return;
      if (!answerMatchesIdentity(answer, this.identity)) throw new IdentityMismatch();
      await peer.applyAnswer(answer);
      await peer.waitConnected(RESTART_CONNECT_TIMEOUT_MS);
      if (peer !== this.peer) return;
      this.restarting = false;
      performance.mark('ma:desk-ice-restarted');
      this.recovered(peer);
    } catch (err) {
      if (peer !== this.peer) return;
      this.restarting = false;
      if (err instanceof IdentityMismatch) console.warn(`Desk ${this.deskId}: ${err.message}`);
      this.abandon(err instanceof IdentityMismatch ? 'identity_mismatch' : 'closed_by_client');
    }
  }

  private recovered(peer: PeerSession): void {
    peer.resetPings();
    this.attempt = 0;
    this.clearLost();
    this.setState('open');
    void this.readPath(peer);
  }

  /** The restart failed or the desk's session is gone: a new connection, resuming by HELLO. */
  private abandon(reason: string): void {
    this.dropPeer(reason);
    this.retryWithBackoff();
  }

  private dropPeer(reason: string): void {
    this.gen += 1;
    this.restarting = false;
    this.opened = false;
    this.subs.detach();
    this.attention.down();
    this.setMedia(null);
    this.answerWait?.reject(new Error('the connection closed'));
    this.answerWait = null;
    this.peer?.close();
    this.peer = null;
    if (this.sessionId) gateway.send({ type: 'session.close', sessionId: this.sessionId, reason });
    this.sessionId = null;
  }

  /** Stop retrying. Only a fresh connect() brings it back. */
  private stop(state: LinkState, reason: string): void {
    this.wanted = false;
    this.resting = false;
    this.unshowWaking();
    this.wokeHere = false;
    this.dropPeer(reason);
    window.clearTimeout(this.retryTimer);
    window.clearTimeout(this.refreshTimer);
    this.notReadyChecks = 0;
    this.waking = false;
    this.retryTimer = 0;
    this.refreshTimer = 0;
    this.waitingForReady = false;
    this.wakeAskedUntil = 0;
    this.clearLost();
    this.watching = false; // a fresh `connect()` watches again: from its wake, or its first session
    this.watchedOn = -1;
    gateway.remove(this);
    window.removeEventListener('online', this.onWakeUp);
    window.removeEventListener('focus', this.onWakeUp);
    document.removeEventListener('visibilitychange', this.onWakeUp);
    window.removeEventListener('pagehide', this.onPageHide);
    this.setState(state);
  }

  private onCloseFrame(peer: PeerSession, code: number, reason: string): void {
    if (peer !== this.peer) return;
    if (code === 4000 || code === 4001) console.warn(`Desk ${this.deskId} closed the session: ${code} ${reason}`); // a bug on one side
    this.act(closeCodeAction(code));
  }

  private act(action: CloseAction): void {
    switch (action) {
      case 'deny':
        // On a Guild Desk a role or a grant changed, or the member left: a fresh token says which (contract 3.3), and a
        // refused one ends it in `onSetupFailed`. Backing off, so a desk that keeps saying no isn't asked in a loop.
        if (this.guild) {
          this.abandon('closed_by_client');
          return;
        }
        this.stop('denied', 'closed_by_client');
        return;
      case 'replaced':
        this.stop(this.actual, 'replaced');
        return;
      case 'reload':
        this.onApiMismatch();
        return;
      case 'hold':
        this.notBefore = Date.now() + RATE_LIMIT_HOLD_MS;
        this.abandon('closed_by_client');
        return;
      case 'recheck':
        if (this.stopping) {
          this.act('stopping'); // the gateway has said so too
          return;
        }
        // Never lower: `closed_by_desk` is also how a session that keeps failing ends, and that must back off.
        this.attempt = Math.max(this.attempt, RECHECK_FIRST_ATTEMPT);
        this.abandon('closed_by_client');
        return;
      case 'stopping':
        this.patchDesk({ state: 'stopping' });
        this.stop('idle', 'desk_stopping');
        return;
      default:
        this.abandon('closed_by_client');
    }
  }

  private onApiMismatch(): void {
    if (reloadBundle()) return;
    // A reload already didn't help. Say the desk can't be reached rather than loop.
    this.beginLost();
    this.setState('retrying');
    this.wanted = false;
    this.dropPeer('closed_by_client');
  }

  // ----- the token

  private scheduleRefresh(refreshAfter: string | undefined): void {
    window.clearTimeout(this.refreshTimer);
    const left = refreshAfter ? Date.parse(refreshAfter) - Date.now() : Number.NaN;
    // A little before `refreshAfter`. A clock that disagrees with Platform's falls back to a fixed step.
    const delay = left > 0 ? left * 0.9 : REFRESH_FALLBACK_MS;
    this.refreshAtMs = Date.now() + delay;
    this.refreshTimer = window.setTimeout(() => void this.refreshToken(), delay);
  }

  private async refreshToken(): Promise<void> {
    if (!this.wanted) return;
    let c: ConnectResponse;
    try {
      c = await this.callConnect(false); // a refresh must never wake a stopped desk
    } catch (err) {
      if (err instanceof SignInRequired || !this.wanted) return;
      const refusal = refusalFrom(err);
      if (refusal) {
        this.refuse(refusal);
        return;
      }
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = window.setTimeout(() => void this.refreshToken(), REFRESH_RETRY_MS);
      return;
    }
    if (!this.wanted) return;
    this.absorbConnect(c);
    if (isStopped(c.state)) {
      this.stop('idle', 'closed_by_client');
      return;
    }
    this.watchedOn = -1;
    this.ensureWatch();
    await this.deliverToken(c.deskToken);
  }

  /**
   * Both ways, every time. A gateway that has lost its link to the desk may still say `session.refreshed`,
   * so its answer proves nothing (deskd API.md section 3). A token works once, so whichever copy lands
   * second is refused, and that changes nothing: `peer.ts` drops AUTH's reply, and the gateway's is ignored.
   */
  private async deliverToken(deskToken: string): Promise<void> {
    if (!this.peer || !this.opened || !this.sessionId) return;
    this.peer.sendAuth(deskToken);
    await gateway.request({ type: 'session.refresh', sessionId: this.sessionId, deskToken } as GatewayMessage, RESTART_ANSWER_TIMEOUT_MS).catch(() => {});
  }

  // ----- the gateway

  wantsGateway(): boolean {
    return this.wanted;
  }

  onUp(): void {
    if (!this.wanted) return;
    if (this.sessionId && this.opened) void this.resumeSession();
    else this.ensureWatch();
    this.retryNow();
  }

  private ensureWatch(): void {
    if (!this.watching || !this.token || this.watchedOn === gateway.serial) return;
    if (gateway.send({ type: 'watch', id: `watch:${this.deskId}`, deskId: this.remoteId, deskToken: this.token } as GatewayMessage)) {
      this.watchedOn = gateway.serial;
    }
  }

  /** The gateway's 2 h close, or a blip: reattach. The PeerConnection never noticed. */
  private async resumeSession(): Promise<void> {
    const sessionId = this.sessionId;
    try {
      if (Date.now() >= this.refreshAtMs) {
        try {
          this.absorbConnect(await this.callConnect(false));
        } catch (err) {
          if (err instanceof SignInRequired) return;
          const refusal = refusalFrom(err);
          if (refusal) {
            if (sessionId === this.sessionId) this.refuse(refusal);
            return;
          }
          // `connect` can't answer for now, maybe for the same reason the gateway dropped. The token we hold may
          // still do, and the refresh timer keeps trying. If it's too old the gateway says so below.
        }
      }
      if (sessionId !== this.sessionId || !this.token) return;
      await gateway.request({ type: 'session.resume', sessionId, deskId: this.remoteId, deskToken: this.token } as GatewayMessage, OPEN_TIMEOUT_MS);
      this.ensureWatch();
    } catch (err) {
      if (sessionId !== this.sessionId || !(err instanceof GatewayError)) return;
      if (err.retryable) {
        // `desk_not_ready`: the desk's link to the gateway is down, not this session (gateway.md, "Resume
        // after a client reconnect"). It's ours again, ICE never noticed, and the token has yet to reach the desk.
        if (this.token) this.peer?.sendAuth(this.token);
        this.ensureWatch();
        return;
      }
      // `session_not_found`: past the 60 s hold the desk has closed its side, so ICE will fail shortly anyway.
      this.abandon('closed_by_client');
    }
  }

  onMessage(m: GatewayMessage): void {
    if (m.type === 'error') {
      if (m.id === `signal:${this.sessionId}` && this.answerWait) {
        this.answerWait.reject(new GatewayError(m.code ?? 'error', m.message ?? 'signal refused', m.retryable));
        this.answerWait = null;
      }
      return;
    }
    if (m.sessionId) {
      if (m.sessionId !== this.sessionId) return;
      if (m.type === 'signal') this.onSignal(m.data);
      else if (m.type === 'session.closed') this.onSessionClosed(m.reason ?? '');
      else if (m.iceServers) this.peer?.useIceServers(m.iceServers); // new TURN servers, from a refresh or resume (gateway.md 2.4)
      return;
    }
    if (m.deskId !== this.remoteId) return;
    switch (m.type) {
      case 'desk.state':
        this.patchDesk({ state: m.state ?? null });
        if (isStopped(m.state)) this.stop('idle', 'desk_stopping');
        else this.stopping = m.state === 'stopping'; // a cancelled idle stop goes back to running
        break;
      case 'watching':
        // The watch's own answer, with the desk as the gateway has it: a desk that came up before the watch did is
        // ready already, and no `desk.progress` will say so.
        if (m.phase === 'ready') {
          this.readyHeardAt = Date.now();
          this.retryNow();
        }
        break;
      case 'desk.progress':
        this.patchDesk({ phase: m.phase ?? null, queuePosition: m.queue?.position ?? null });
        if (m.phase === 'stopped' || m.phase === 'failed') this.stop('idle', 'desk_stopping');
        else if (m.phase === 'ready') {
          this.readyHeardAt = Date.now();
          this.retryNow(); // any wait, a backoff's too, is over
        }
        break;
      case 'desk.stopping':
        this.stopping = true;
        this.patchDesk({ state: 'stopping', stopAt: m.stopAt ?? null, stopReason: m.stopReason ?? m.reason ?? null, stopDetail: trafficStopOf(m.stopDetail) });
        break;
      default:
    }
  }

  private onSignal(data: unknown): void {
    const d = data as { type?: string; sdp?: string; code?: string; message?: string } | null;
    if (!this.answerWait || !d) return;
    if (d.type === 'answer' && d.sdp) this.answerWait.resolve(d.sdp);
    else this.answerWait.reject(new GatewayError(d.code ?? 'refused', d.message ?? 'the desk refused the offer', true));
    this.answerWait = null;
  }

  private onSessionClosed(reason: string): void {
    const action = sessionClosedAction(reason);
    if (action === 'reconnect' || action === 'recheck') this.sessionId = null; // already gone: nothing to tell the gateway
    this.act(action);
  }
}

function withTimeout(p: Promise<void>, ms: number, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new GatewayError('timeout', message, true)), ms);
    p.then(
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      (err: unknown) => {
        window.clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
