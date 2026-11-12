// One RTCPeerConnection to one desk and the framing on its channels. It knows nothing of the gateway
// or the retry policy: `rtcDeskLink.ts` carries its SDP and decides what its events mean.
import { DeskNotConnected, type BrowserInput, type BrowserMedia, type BulkChannel, type CreditMessage, type RpcOptions } from '../deskLink';
import { CollabWire, type CollabDataChannel } from './collab';
import { decodeFrame, decodeJson, encodeFrame, encodeJson, encodeMessage, FLAG_BIN, FLAG_END, FrameError, Kind, Reassembler } from './frames';
import { attachQuality, deskQualityReply } from '../../quality/link';
import { cursorCss, InputEncoder } from './input';
import { PongWatch } from './policy';
import { PictureHold, type AudioTotals } from './pictureHold';
import { answerRefusesVideo } from './sdp';
import { watchConnectRtt } from './connectRtt';

const CHANNELS: readonly { id: number; label: string; lossy?: boolean }[] = [
  { id: 0, label: 'ctl' },
  { id: 1, label: 'rpc' },
  { id: 2, label: 'events' },
  { id: 3, label: 'collab' },
  { id: 4, label: 'mdoc' },
  { id: 5, label: 'bulk' },
  { id: 6, label: 'input', lossy: true },
  { id: 7, label: 'keys' },
];
/**
 * A Guild Desk's session (task 48): data only, no picture, sound or input. `commons` is Commons' room link on channel 4,
 * `mdoc`'s id, which a Guild Desk never serves: desk-rtc bridges it to deskd as any of 0 to 5, and deskd relays it to Commons
 * with this member's verified identity (deskd API.md section 14 on `sub/deskd-guild-sessions`).
 */
const GUILD_CHANNELS: readonly { id: number; label: string; lossy?: boolean }[] = [
  { id: 0, label: 'ctl' },
  { id: 1, label: 'rpc' },
  { id: 2, label: 'events' },
  { id: 3, label: 'collab' },
  { id: 4, label: 'commons' },
];
const CTL = 0;
const RPC = 1;
const EVENTS = 2;
const COLLAB = 3;
const BULK = 5;
/** An upload stops sending above this much buffered on `bulk`, and carries on when it falls to `BULK_RESUME_AT` (files.md 5.2). */
const BULK_PAUSE_ABOVE = 1024 * 1024;
const BULK_RESUME_AT = 256 * 1024;

/** The desk's CREDIT body, if it is one: `bytes` is a whole number, as are `committed` and `error`'s absence or a string. */
function creditOf(body: unknown): CreditMessage | null {
  const b = body as CreditMessage | null;
  return Number.isSafeInteger(b?.bytes) && (b?.bytes as number) >= 0 ? b : null;
}
const INPUT = 6;
const KEYS = 7;
const COMMONS = 4; // a Guild Desk's only; `mdoc` on any other desk

const PING_EVERY_MS = 10_000;
const RECHECK_MS = 3_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** How long past a request's `deadlineMs` to wait for deskd to say so. */
const DEADLINE_SLACK_MS = 2_000;
/**
 * Calls that are the member's own doing, as a key or a click is: each lets go of the picture hold at once, so the page they
 * asked for isn't shown late (`pictureHold.ts`). The Browser bar's Back, Forward, Reload, a tab, a new tab and Enter in the
 * address are among them. Reads, such as `browser.tab.list`, aren't.
 */
const INPUT_CALLS: ReadonlySet<string> = new Set([
  'browser.text.insert',
  'browser.clipboard.write',
  'browser.tab.navigate',
  'browser.tab.back',
  'browser.tab.forward',
  'browser.tab.reload',
  'browser.tab.open',
  'browser.tab.activate',
  'browser.tab.close',
]);

/** How often the picture hold looks at the sound (`pictureHold.ts`). */
const HOLD_TICK_MS = 500;
const HELLO_ID = 0; // services/deskd/docs/API.md section 3
const NOTHING = new Uint8Array();

export type PeerHealth = 'connected' | 'disconnected' | 'failed';

export interface PeerEvents {
  /** The PeerConnection's own state, as far as a link cares. */
  onHealth(h: PeerHealth): void;
  /** Three missed pongs on a visible tab, or `ctl` closed. */
  onDown(reason: string): void;
  /** `CLOSE {code, reason}` on `ctl`. */
  onCloseFrame(code: number, reason: string): void;
  onRtt(ms: number): void;
  /** One whole EVT from `events`. Its frame's `id` is the subId. */
  onEvent(subId: number, seq: number, body: unknown): void;
  /** A `CURSOR` from `keys`, as a CSS value. */
  onCursor(css: string): void;
}

export class RpcError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.details = details;
  }
}

interface Waiter {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: number;
}

export interface HelloReply {
  deskApi?: string;
  sessionId?: string;
  resumeToken?: string;
  resumed?: boolean;
}

/** The audio receiver's `inbound-rtp` fields the picture hold reads. */
interface InboundAudio {
  type: string;
  playoutId?: string;
  packetsReceived?: number;
  jitterBufferDelay?: number;
  jitterBufferEmittedCount?: number;
  totalAudioEnergy?: number;
  totalSamplesDuration?: number;
}

/** Design 6.5: the lowest playout delay the network allows. Not in every browser yet. */
function setLowestLatency(receiver: RTCRtpReceiver): void {
  if ('jitterBufferTarget' in receiver) (receiver as { jitterBufferTarget: number | null }).jitterBufferTarget = 0;
}

export class PeerSession {
  private readonly pc: RTCPeerConnection;
  private readonly channels = new Map<number, RTCDataChannel>();
  private readonly reassembly = new Map<number, Reassembler>();
  private readonly waiting = new Map<number, Waiter>();
  private readonly events: PeerEvents;
  private readonly deskId: string;
  /** Resolves when `ctl` and `rpc` are both open. Each channel opens on its own (desk-rtc README). */
  readonly channelsOpen: Promise<void>;
  private nextId = 1;
  private closed = false;
  private offQuality: (() => void) | null = null;

  private pingTimer = 0;
  private recheckTimer = 0;
  private readonly pingSentAt = new Map<number, number>();
  private readonly pongs = new PongWatch();

  private videoTrack: MediaStreamTrack | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  private videoReceiver: RTCRtpReceiver | null = null;
  private audioReceiver: RTCRtpReceiver | null = null;
  private readonly hold = new PictureHold();
  private holdTimer = 0;
  private videoRefused = false;
  private mediaStream: MediaStream | null = null;

  private drainWaiters: (() => void)[] = [];

  /**
   * CHUNK frames to their listener, CREDIT back on the same channel; and the Files app's uploads the other way: CHUNK out,
   * the desk's CREDIT in. Nothing reassembles: a CHUNK is one frame, and a CREDIT is one small frame.
   */
  readonly bulk: BulkChannel = {
    onChunk: null,
    onCredit: null,
    credit: (id, bytes) => void this.sendFrames(BULK, encodeJson(Kind.CREDIT, id, { bytes })),
    send: (id, seq, payload) => {
      const dc = this.channels.get(BULK);
      if (dc?.readyState !== 'open') return false;
      const frame = encodeFrame(Kind.CHUNK, FLAG_BIN, id, seq, payload);
      dc.send(frame);
      // `send` has taken its own copy, so the frame's copy of the file goes now: a passwords file's bytes (#11) never
      // linger here, and nothing else needs them.
      frame.fill(0);
      return true;
    },
    drained: () => {
      const dc = this.channels.get(BULK);
      if (dc?.readyState !== 'open' || dc.bufferedAmount <= BULK_PAUSE_ABOVE) return Promise.resolve();
      return new Promise<void>((resolve) => this.drainWaiters.push(resolve));
    },
  };

  private releaseDrained(): void {
    for (const w of this.drainWaiters.splice(0)) w();
  }

  /** The Notebook's page text. It opens on its own, and carries nothing until the Notebook asks. */
  readonly collab = new CollabWire();
  /** Commons' room link, on a Guild Desk only. Framed as `collab` is: DATA messages with BIN. */
  readonly commons = new CollabWire();

  private readonly encoder = new InputEncoder();
  /** Handlers write straight here. `input` drops rather than queues: a late MOVE is worthless. */
  readonly input: BrowserInput = {
    move: (x, y) => {
      this.noteInput();
      const dc = this.channels.get(INPUT);
      if (dc?.readyState !== 'open' || dc.bufferedAmount > 0) return false;
      dc.send(this.encoder.move(x, y));
      return true;
    },
    button: (down, button, x, y) => {
      this.noteInput();
      this.sendKeys(this.encoder.button(down, button, x, y));
    },
    wheel: (x, y, dx, dy) => {
      this.noteInput();
      this.sendKeys(this.encoder.wheel(x, y, dx, dy));
    },
    key: (down, keysym) => {
      this.noteInput();
      this.sendKeys(this.encoder.key(down, keysym));
    },
    releaseAll: () => this.sendKeys(this.encoder.releaseAll()),
  };

  /** `guild`: a Guild Desk's data-only session, with no media sections in its offer at all. */
  constructor(deskId: string, certificate: RTCCertificate, iceServers: RTCIceServer[], events: PeerEvents, guild = false) {
    this.deskId = deskId;
    this.events = events;
    this.pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require', certificates: [certificate] });
    if (!guild) watchConnectRtt(this.pc, deskId); // one connect-time round trip a session, where client-config asks (ma-platform ADR 0112 P4)
    this.pc.addEventListener('connectionstatechange', () => {
      const s = this.pc.connectionState;
      if (s === 'connected' || s === 'disconnected' || s === 'failed') this.events.onHealth(s);
    });
    // Fires during setRemoteDescription, since the answer has a=sendonly on both. There's one of each kind.
    // The stream ids are `desk-video` and `desk-audio`, but `track.id` is the browser's own on a transceiver we made.
    this.pc.addEventListener('track', (e: RTCTrackEvent) => {
      if (e.track.kind === 'video') {
        this.videoTrack = e.track;
        this.videoReceiver = e.receiver;
        setLowestLatency(e.receiver);
      } else {
        this.audioTrack = e.track;
        this.audioReceiver = e.receiver;
      }
    });
    // Audio before video before data: the first section carries the BUNDLE tag (desk-runtime.md 4.4). A Guild Desk has no
    // picture and no sound of its own: Commons' voice keeps its own connection, signaled over `commons`.
    if (!guild) {
      this.pc.addTransceiver('audio', { direction: 'recvonly' });
      this.pc.addTransceiver('video', { direction: 'recvonly' });
      this.holdTimer = window.setInterval(() => void this.holdTick(), HOLD_TICK_MS);
    }
    let opened: () => void = () => {};
    let failed: (e: Error) => void = () => {};
    this.channelsOpen = new Promise((resolve, reject) => {
      opened = resolve;
      failed = reject;
    });
    this.channelsOpen.catch(() => {}); // a caller may have given up already
    let waitingFor = 2;
    for (const c of guild ? GUILD_CHANNELS : CHANNELS) {
      const dc = this.pc.createDataChannel(c.label, c.lossy ? { negotiated: true, id: c.id, ordered: false, maxRetransmits: 0 } : { negotiated: true, id: c.id, ordered: true });
      dc.binaryType = 'arraybuffer';
      this.channels.set(c.id, dc);
      if (c.id === CTL || c.id === RPC) {
        dc.onopen = () => {
          waitingFor -= 1;
          if (waitingFor === 0) opened();
        };
        dc.onclose = () => {
          failed(new Error(`${c.label} closed before it opened`));
          if (!this.closed) this.events.onDown(`${c.label} closed`);
        };
        const reassembler = new Reassembler();
        this.reassembly.set(c.id, reassembler);
        dc.onmessage = (e) => this.onChannelMessage(reassembler, e.data as ArrayBuffer);
      } else if (c.id === EVENTS) {
        const reassembler = new Reassembler();
        this.reassembly.set(c.id, reassembler);
        dc.onmessage = (e) => this.onEventsMessage(reassembler, e.data as ArrayBuffer);
      } else if (c.id === COLLAB) {
        this.collab.attach(dc as unknown as CollabDataChannel);
      } else if (c.id === COMMONS) {
        this.commons.attach(dc as unknown as CollabDataChannel);
      } else if (c.id === BULK) {
        dc.bufferedAmountLowThreshold = BULK_RESUME_AT;
        dc.onbufferedamountlow = () => this.releaseDrained();
        dc.onmessage = (e) => {
          try {
            const f = decodeFrame(e.data as ArrayBuffer);
            if (f.kind === Kind.CHUNK) this.bulk.onChunk?.(f.id, f.seq, (f.flags & FLAG_END) !== 0, f.payload);
            else if (f.kind === Kind.CREDIT && this.bulk.onCredit) {
              const msg = creditOf(decodeJson(f.payload));
              if (msg) this.bulk.onCredit(f.id, msg);
            }
          } catch {
            // a bad frame isn't worth tearing the link down for: the transfer's sequence or trailer catches it
          }
        };
      } else if (c.id === KEYS) {
        dc.onopen = () => (this.offQuality = attachQuality(this.deskId, (b) => this.sendKeys(this.encoder.stamp(b)))); // stream quality, ADR 0039
        dc.onmessage = (e) => {
          const bytes = new Uint8Array(e.data as ArrayBuffer);
          const css = cursorCss(bytes);
          if (css) this.events.onCursor(css);
          else deskQualityReply(this.deskId, bytes);
        };
      }
    }
  }

  /** The offer SDP, right after setLocalDescription: never wait for gathering, never trickle. */
  async createOffer(iceRestart = false): Promise<string> {
    const offer = await this.pc.createOffer({ iceRestart });
    await this.pc.setLocalDescription(offer);
    return offer.sdp ?? '';
  }

  async applyAnswer(sdp: string): Promise<void> {
    this.videoRefused = answerRefusesVideo(sdp);
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  /** After the answer. The tracks stay for the session; nothing renegotiates (desk-runtime.md 8.5). */
  media(): BrowserMedia {
    const tracks = [this.videoTrack, this.audioTrack].filter((t): t is MediaStreamTrack => t !== null);
    this.mediaStream ??= new MediaStream(tracks);
    return { stream: this.mediaStream, canPlayVideo: this.videoTrack !== null && !this.videoRefused, silentFor: () => performance.now() - this.hold.heardAt };
  }

  /** Resolves on `connected`; rejects after `ms`. */
  waitConnected(ms: number): Promise<void> {
    if (this.pc.connectionState === 'connected') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onChange = (): void => {
        if (this.pc.connectionState !== 'connected') return;
        window.clearTimeout(timer);
        this.pc.removeEventListener('connectionstatechange', onChange);
        resolve();
      };
      const timer = window.setTimeout(() => {
        this.pc.removeEventListener('connectionstatechange', onChange);
        reject(new Error('ICE did not reconnect'));
      }, ms);
      this.pc.addEventListener('connectionstatechange', onChange);
    });
  }

  hello(body: Record<string, unknown>): Promise<HelloReply> {
    return this.request(CTL, Kind.HELLO, body, HELLO_ID) as Promise<HelloReply>;
  }

  call(method: string, params: Record<string, unknown>, options: RpcOptions = {}): Promise<unknown> {
    const { idem, deadlineMs } = options;
    if (INPUT_CALLS.has(method)) this.noteInput();
    const body = { m: method, p: params, ...(idem ? { idem } : {}), ...(deadlineMs ? { deadlineMs } : {}) };
    return this.request(RPC, Kind.REQ, body, this.nextId++, deadlineMs ? deadlineMs + DEADLINE_SLACK_MS : REQUEST_TIMEOUT_MS);
  }

  sub(body: { topic: string; params: Record<string, unknown>; since?: number }): Promise<{ subId: number }> {
    return this.request(RPC, Kind.SUB, body) as Promise<{ subId: number }>;
  }

  unsub(subId: number): Promise<unknown> {
    return this.request(RPC, Kind.UNSUB, { subId });
  }

  /** In-band token refresh. It goes on every refresh, beside the gateway's copy. deskd's answer is ignored. */
  sendAuth(deskToken: string): void {
    this.sendFrames(CTL, encodeJson(Kind.AUTH, this.nextId++, { deskToken }));
  }

  /**
   * This session's new TURN servers, from `session.refreshed` or a resume's `session.opened` (ma-platform contract
   * gateway.md 2.4): the last ones expire with the token they came with, so the next ICE restart allocates with these.
   * `[]` is the relay paused, and is used as given. They're credentials: kept only in the connection, never logged.
   */
  useIceServers(iceServers: unknown): void {
    if (this.closed || !Array.isArray(iceServers)) return;
    try {
      this.pc.setConfiguration({ ...this.pc.getConfiguration(), iceServers: iceServers as RTCIceServer[] });
    } catch {
      // Servers the browser won't take: it keeps the last ones, and a restart that can't allocate opens a new session.
    }
  }

  /** Input handled here, not on channels 6 and 7, which desk-rtc counts itself (deskd API.md section 3). */
  sendActivity(lastInputAt: string): void {
    this.sendFrames(CTL, encodeJson(Kind.ACTIVITY, 0, { lastInputAt }));
  }

  /** Which path the selected candidate pair uses. Stats are cheap, but not for every frame. */
  async path(): Promise<'udp' | 'tcp' | 'relay' | null> {
    const stats = await this.pc.getStats();
    let pairId: string | null = null;
    stats.forEach((r: { type: string; selectedCandidatePairId?: string }) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
    });
    if (!pairId) return null;
    const pair = stats.get(pairId) as { localCandidateId?: string } | undefined;
    const local = pair?.localCandidateId ? (stats.get(pair.localCandidateId) as { protocol?: string; candidateType?: string } | undefined) : undefined;
    if (!local) return null;
    if (local.candidateType === 'relay') return 'relay';
    return local.protocol === 'tcp' ? 'tcp' : 'udp';
  }

  startPings(): void {
    window.clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => this.pingTick(), PING_EVERY_MS);
    this.pingTick();
  }

  /** Tab focus: a hidden tab's misses are soft, so look again now. */
  recheck(): void {
    if (this.closed || !this.pongs.anyMissed()) return;
    this.sendPing();
    window.clearTimeout(this.recheckTimer);
    this.recheckTimer = window.setTimeout(() => {
      if (!this.closed && this.pongs.isDown()) this.events.onDown('missed pongs');
    }, RECHECK_MS);
  }

  /** Clear the miss count after a repair, so the next tick starts from a clean slate. */
  resetPings(): void {
    this.pongs.reset();
    this.pingSentAt.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    window.clearInterval(this.pingTimer);
    window.clearInterval(this.holdTimer);
    window.clearTimeout(this.recheckTimer);
    this.offQuality?.();
    for (const [id, w] of this.waiting) {
      this.waiting.delete(id);
      window.clearTimeout(w.timer);
      w.reject(new DeskNotConnected(this.deskId, true));
    }
    for (const r of this.reassembly.values()) r.clear();
    this.collab.end();
    this.commons.end();
    this.releaseDrained();
    this.pc.close();
  }

  /** Input lets go of the picture hold at once, before the desk's answer to it can arrive. */
  private noteInput(): void {
    if (this.hold.input(performance.now())) this.setHold(0);
  }

  /**
   * desk-rtc puts the hold in the playout-delay extension of this session's video, which is what a browser obeys: Chrome ignores
   * the video receiver's `jitterBufferTarget` while frames carry playout-delay 0, 0 (measured, `e2e/av-sync/runs/hold-1.json`).
   */
  private setHold(ms: number): void {
    this.sendKeys(this.encoder.hold(ms));
  }

  /** The picture hold (`pictureHold.ts`): the sound's buffering, from the audio receiver's own stats, twice a second. Also whether there's sound. */
  private async holdTick(): Promise<void> {
    const rx = this.audioReceiver;
    if (this.closed || !rx || !this.videoReceiver || this.channels.get(KEYS)?.readyState !== 'open') return;
    // A hidden tab never holds the picture, but it still listens, as its stream stays live while the desk plays sound (task 22).
    if (document.hidden && this.hold.input(performance.now())) this.setHold(0);
    const stats = await rx.getStats();
    let r: InboundAudio | undefined;
    stats.forEach((x: InboundAudio) => {
      if (x.type === 'inbound-rtp') r = x;
    });
    const a = r as InboundAudio | undefined;
    if (!a || this.closed) return;
    const playout = a.playoutId ? (stats.get(a.playoutId) as { totalPlayoutDelay?: number; totalSamplesCount?: number } | undefined) : undefined;
    const t: AudioTotals = {
      at: performance.now(),
      packetsReceived: a.packetsReceived ?? 0,
      jitterBufferDelay: a.jitterBufferDelay ?? 0,
      jitterBufferEmittedCount: a.jitterBufferEmittedCount ?? 0,
      totalAudioEnergy: a.totalAudioEnergy,
      totalSamplesDuration: a.totalSamplesDuration,
      totalPlayoutDelay: playout?.totalPlayoutDelay,
      totalSamplesCount: playout?.totalSamplesCount,
    };
    const next = this.hold.sample(t);
    if (next !== null) this.setHold(next);
  }

  private pingTick(): void {
    if (this.pongs.tick(document.hidden)) {
      this.events.onDown('missed pongs');
      return;
    }
    this.sendPing();
  }

  private sendPing(): void {
    const id = this.nextId++;
    this.pingSentAt.set(id, performance.now());
    this.sendFrames(CTL, encodeMessage(Kind.PING, 0, id, 0, NOTHING));
  }

  private sendFrames(channel: number, frames: Uint8Array<ArrayBuffer>[]): boolean {
    const dc = this.channels.get(channel);
    if (dc?.readyState !== 'open') return false;
    for (const f of frames) dc.send(f);
    return true;
  }

  private sendKeys(event: Uint8Array<ArrayBuffer>): void {
    const dc = this.channels.get(KEYS);
    if (dc?.readyState === 'open') dc.send(event);
  }

  private request(channel: number, kind: number, body: unknown, id = this.nextId++, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.waiting.delete(id);
        reject(new RpcError('deadline_exceeded', 'the desk did not answer in time'));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      if (!this.sendFrames(channel, encodeJson(kind, id, body))) {
        window.clearTimeout(timer);
        this.waiting.delete(id);
        reject(new DeskNotConnected(this.deskId));
      }
    });
  }

  private onEventsMessage(reassembler: Reassembler, data: ArrayBuffer): void {
    let id: number;
    let seq: number;
    let body: unknown;
    try {
      const f = decodeFrame(data);
      if (f.kind !== Kind.EVT) return;
      const whole = reassembler.push(f);
      if (!whole) return;
      id = f.id;
      seq = f.seq;
      body = decodeJson(whole);
    } catch {
      return; // a bad frame isn't worth tearing the link down for
    }
    this.events.onEvent(id, seq, body);
  }

  private onChannelMessage(reassembler: Reassembler, data: ArrayBuffer): void {
    let whole: Uint8Array | null;
    let kind: number;
    let id: number;
    try {
      const f = decodeFrame(data);
      kind = f.kind;
      id = f.id;
      if (kind !== Kind.PONG && kind !== Kind.CLOSE && kind !== Kind.HELLO && kind !== Kind.RES && kind !== Kind.ERR) return; // unknown kinds and AUTH's reply
      whole = reassembler.push(f);
    } catch (err) {
      if (err instanceof FrameError) return; // a bad frame isn't worth tearing the link down for
      throw err;
    }
    if (!whole) return;

    if (kind === Kind.PONG) {
      const sentAt = this.pingSentAt.get(id);
      this.pingSentAt.clear();
      this.pongs.pong();
      if (sentAt !== undefined) this.events.onRtt(performance.now() - sentAt);
      return;
    }
    let body: unknown;
    try {
      body = decodeJson(whole);
    } catch {
      return;
    }
    if (kind === Kind.CLOSE) {
      const { code = 0, reason = '' } = body as { code?: number; reason?: string };
      this.events.onCloseFrame(code, reason);
      return;
    }
    const w = this.waiting.get(id);
    if (!w) return;
    this.waiting.delete(id);
    window.clearTimeout(w.timer);
    if (kind === Kind.ERR) {
      const { code = 'internal', message = 'the desk refused', details = {} } = body as { code?: string; message?: string; details?: Record<string, unknown> };
      w.reject(new RpcError(code, message, details));
    } else {
      w.resolve(body);
    }
  }
}
