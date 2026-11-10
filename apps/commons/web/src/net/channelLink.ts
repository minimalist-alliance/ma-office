// The room link on a guild desk: the Desk app's `commons` data channel (channel 4), which deskd relays to Commons'
// service (README, "On a guild desk"). Each room-link message is one DATA with BIN, sent whole; deskd's non-BIN
// {"t":"reset"} means Commons' side of the relay closed, and the next message opens it again with a new hello.
// Voice stays Commons' own WebRTC connection, signalled over this link.
import type { CommonsLink, LinkState } from './link.ts';
import { MAX_MESSAGE, splitMessage } from './protocol.ts';

/** Why a channel stopped: deskd's reset (the channel carries on), or the desk session ended. */
export type ChannelEnd = 'reset' | 'ended';

/**
 * A channel that carries whole messages, ordered and reliable: the Desk app's per-session channel, in the shape of its
 * `CollabChannel` (web/src/desk/deskLink.ts). `fromDataChannel` makes one from a plain RTCDataChannel.
 */
export interface CommonsChannel {
  readonly open: boolean;
  onOpen: (() => void) | null;
  onMessage: ((bytes: Uint8Array) => void) | null;
  onEnd: ((why: ChannelEnd) => void) | null;
  /** False (or throws) if it didn't go. */
  send(bytes: Uint8Array): boolean | void;
  /** Bytes queued and not yet sent, if the channel knows. */
  readonly buffered?: number;
}

/** What Commons needs of an RTCDataChannel. */
export interface DataChannelLike {
  readonly readyState: string;
  readonly bufferedAmount?: number;
  binaryType?: string;
  send(data: Uint8Array<ArrayBuffer>): void;
  onopen: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  onclose: ((ev: Event) => unknown) | null;
}

function isReset(data: string): boolean {
  try {
    return (JSON.parse(data) as { t?: unknown }).t === 'reset';
  } catch {
    return false;
  }
}

/** A plain RTCDataChannel as a CommonsChannel: binary messages are room-link messages; text {"t":"reset"} is deskd's. */
export function fromDataChannel(dc: DataChannelLike): CommonsChannel {
  dc.binaryType = 'arraybuffer';
  const ch: CommonsChannel = {
    get open() {
      return dc.readyState === 'open';
    },
    get buffered() {
      return dc.bufferedAmount ?? 0;
    },
    onOpen: null,
    onMessage: null,
    onEnd: null,
    send(bytes) {
      if (dc.readyState !== 'open') return false;
      dc.send(bytes as Uint8Array<ArrayBuffer>);
      return true;
    },
  };
  dc.onopen = () => ch.onOpen?.();
  dc.onmessage = (e: MessageEvent) => {
    const d: unknown = e.data;
    if (typeof d === 'string') {
      if (isReset(d)) ch.onEnd?.('reset');
    } else if (d instanceof ArrayBuffer) ch.onMessage?.(new Uint8Array(d));
    else if (ArrayBuffer.isView(d)) ch.onMessage?.(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
  };
  dc.onclose = () => ch.onEnd?.('ended');
  return ch;
}

/**
 * The room link over a CommonsChannel. After deskd's reset it waits (0.5 s, doubling to 8 s while resets keep coming
 * with nothing in between) and opens again, so the room client says hello again. A new desk session hands a new
 * channel to attach().
 */
export class DataChannelLink implements CommonsLink {
  state: LinkState = 'connecting';
  onOpen = (): void => {};
  onMessage: (msg: Uint8Array) => void = () => {};
  onClose = (): void => {};
  private ch: CommonsChannel | null = null;
  private stopped = false;
  private delay = 500;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(ch: CommonsChannel | DataChannelLike) {
    // Attach on the next task, so the caller can set the handlers first.
    this.timer = setTimeout(() => {
      this.timer = null;
      this.attach(ch);
    }, 0);
  }

  get buffered(): number {
    return this.ch?.buffered ?? 0;
  }

  /** Takes a (new) channel: a new desk session's, or the first. */
  attach(c: CommonsChannel | DataChannelLike): void {
    if (this.stopped) return;
    const ch = 'readyState' in c ? fromDataChannel(c) : c;
    if (this.ch && this.ch !== ch) {
      const old = this.ch;
      old.onOpen = old.onMessage = old.onEnd = null;
      this.down();
    }
    this.ch = ch;
    ch.onOpen = () => this.up();
    ch.onMessage = (b) => {
      this.delay = 500;
      if (this.state === 'open') this.onMessage(b);
    };
    ch.onEnd = (why) => {
      this.down();
      if (why === 'reset') this.later();
    };
    if (ch.open) this.up();
  }

  private up(): void {
    if (this.stopped || this.state === 'open') return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.state = 'open';
    this.onOpen();
  }

  private down(): void {
    const was = this.state;
    this.state = 'closed';
    if (was === 'open') this.onClose();
  }

  private later(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.ch?.open) this.up();
    }, this.delay);
    this.delay = Math.min(this.delay * 2, 8000);
  }

  /** deskd's reset, for a Desk app that reports it itself rather than through onEnd. */
  reset(): void {
    this.down();
    this.later();
  }

  send(msg: Uint8Array): void {
    if (this.state !== 'open' || !this.ch) return;
    for (const m of msg.byteLength > MAX_MESSAGE ? splitMessage(msg) : [msg]) {
      if (this.ch.send(m) === false) return;
    }
  }

  close(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.ch) this.ch.onOpen = this.ch.onMessage = this.ch.onEnd = null;
    this.ch = null;
    this.state = 'closed';
  }
}

/**
 * For -dev and tests: a WebSocket to commons-server's /dev/channel, standing in for the guild desk's `commons` data
 * channel (the server plays deskd). It reopens itself after a drop, as a new desk session would be.
 */
export class WebSocketChannel implements CommonsChannel {
  onOpen: (() => void) | null = null;
  onMessage: ((bytes: Uint8Array) => void) | null = null;
  onEnd: ((why: ChannelEnd) => void) | null = null;
  private ws: WebSocket | null = null;
  private stopped = false;
  private delay = 500;

  constructor(private readonly url: string) {
    setTimeout(() => this.connect(), 0);
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get buffered(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.delay = 500;
      this.onOpen?.();
    };
    ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
      if (typeof e.data === 'string') {
        if (isReset(e.data)) this.onEnd?.('reset');
      } else this.onMessage?.(new Uint8Array(e.data));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onEnd?.('ended');
      if (!this.stopped) {
        setTimeout(() => this.connect(), this.delay);
        this.delay = Math.min(this.delay * 2, 8000);
      }
    };
  }

  send(bytes: Uint8Array): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(bytes);
    return true;
  }

  /** Test hooks: what deskd does on a token refresh, and on a removal. */
  devCaller(c: { role?: string; grants?: string[]; name?: string; badge?: string | null }): void {
    this.ws?.send(JSON.stringify({ t: 'caller', ...c }));
  }
  devDrop(): void {
    this.ws?.send(JSON.stringify({ t: 'drop' }));
  }

  close(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }
}
