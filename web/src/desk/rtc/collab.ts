// `collab` (channel 3) for one session: one virtual WebSocket, as DATA frames (API.md section 13). Each binary message of
// Hocuspocus's protocol is one DATA message with BIN set. It knows nothing of Hocuspocus or Yjs.
//
// A DATA message over 4 MiB closes the whole session, Browser included, with 4001, so `send` refuses one before any of it
// goes. What it does send it never drops: a message half sent would count against deskd's limit on incomplete messages.
import { MAX_COLLAB_MESSAGE, type CollabChannel, type CollabEnd } from '../deskLink';
import { decodeFrame, decodeJson, encodeMessage, FLAG_BIN, FrameError, Kind, Reassembler } from './frames';

/** Over this much waiting in the browser, the rest waits here (API.md section 6: flow control is the client's). */
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;

/** What this needs of an `RTCDataChannel`. */
export interface CollabDataChannel {
  readyState: string;
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  onbufferedamountlow: (() => void) | null;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null;
  send(frame: Uint8Array<ArrayBuffer>): void;
}

export class CollabWire implements CollabChannel {
  onOpen: (() => void) | null = null;
  onMessage: ((bytes: Uint8Array<ArrayBuffer>) => void) | null = null;
  onEnd: ((why: CollabEnd) => void) | null = null;

  private dc: CollabDataChannel | null = null;
  private ended = false;
  private nextId = 1;
  private readonly waiting: Uint8Array<ArrayBuffer>[] = [];
  private readonly reassembler = new Reassembler();

  get open(): boolean {
    return !this.ended && this.dc?.readyState === 'open';
  }

  attach(dc: CollabDataChannel): void {
    this.dc = dc;
    dc.bufferedAmountLowThreshold = LOW_WATER;
    dc.onbufferedamountlow = () => this.pump();
    dc.onopen = () => {
      if (!this.ended) this.onOpen?.();
    };
    dc.onclose = () => this.end();
    dc.onmessage = (e) => this.receive(e.data);
  }

  /** False if it can't go: over the limit, or this session has no channel open. */
  send(bytes: Uint8Array): boolean {
    if (bytes.length > MAX_COLLAB_MESSAGE || !this.open) return false;
    this.waiting.push(...encodeMessage(Kind.DATA, FLAG_BIN, this.nextId, 0, bytes));
    this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1;
    this.pump();
    return this.open;
  }

  /** This session is over. Nothing more comes or goes. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.waiting.length = 0;
    this.reassembler.clear();
    this.onEnd?.('ended');
  }

  private pump(): void {
    const dc = this.dc;
    if (!dc) return;
    try {
      while (this.waiting.length && dc.readyState === 'open' && dc.bufferedAmount < HIGH_WATER) {
        dc.send(this.waiting.shift() as Uint8Array<ArrayBuffer>);
      }
    } catch {
      this.end(); // the browser's own queue refused it: nothing further on this channel can be trusted to arrive whole
    }
  }

  private receive(data: ArrayBuffer): void {
    let bin: boolean;
    let whole: Uint8Array | null;
    try {
      const f = decodeFrame(data);
      if (f.kind !== Kind.DATA) return;
      bin = (f.flags & FLAG_BIN) !== 0;
      whole = this.reassembler.push(f);
    } catch (err) {
      if (err instanceof FrameError) return; // a bad frame isn't worth tearing the link down for
      throw err;
    }
    if (!whole) return;
    if (bin) {
      this.onMessage?.(whole.slice());
      return;
    }
    let body: { t?: unknown } | null = null;
    try {
      body = decodeJson(whole) as { t?: unknown } | null;
    } catch {
      return;
    }
    if (body?.t === 'reset') this.onEnd?.('reset');
  }
}
