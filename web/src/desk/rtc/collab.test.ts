// `collab`'s framing against a fake data channel. `rtc` runs it over a real one.
import { describe, expect, it } from 'vitest';
import { MAX_COLLAB_MESSAGE } from '../deskLink';
import { CollabWire, type CollabDataChannel } from './collab';
import { decodeFrame, encodeJson, encodeMessage, FLAG_BIN, FLAG_MORE, Kind, MAX_FRAME, MAX_PAYLOAD } from './frames';

class FakeChannel implements CollabDataChannel {
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onbufferedamountlow: (() => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  readonly sent: Uint8Array[] = [];

  send(frame: Uint8Array<ArrayBuffer>): void {
    this.sent.push(frame);
  }

  deliver(frame: Uint8Array): void {
    this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer });
  }
}

function wire(): { w: CollabWire; dc: FakeChannel; messages: Uint8Array[]; ends: string[] } {
  const dc = new FakeChannel();
  const w = new CollabWire();
  w.attach(dc);
  const messages: Uint8Array[] = [];
  const ends: string[] = [];
  w.onMessage = (b) => messages.push(b);
  w.onEnd = (why) => ends.push(why);
  return { w, dc, messages, ends };
}

const filled = (n: number): Uint8Array => new Uint8Array(n).map((_, i) => i % 251);

describe('sending', () => {
  it('a small message is one DATA frame with BIN, and not MORE', () => {
    const { w, dc } = wire();
    expect(w.send(new Uint8Array([1, 2, 3]))).toBe(true);
    const f = decodeFrame(dc.sent[0] as Uint8Array<ArrayBuffer>);
    expect(f.kind).toBe(Kind.DATA);
    expect(f.flags).toBe(FLAG_BIN);
    expect([...f.payload]).toEqual([1, 2, 3]);
  });

  it('a large one goes in frames of at most 16 KiB: BIN on all, MORE on all but the last, one id', () => {
    const { w, dc } = wire();
    const bytes = filled(MAX_PAYLOAD * 2 + 5);
    w.send(bytes);
    expect(dc.sent).toHaveLength(3);
    const frames = dc.sent.map((s) => decodeFrame(s as Uint8Array<ArrayBuffer>));
    expect(dc.sent.every((s) => s.length <= MAX_FRAME)).toBe(true);
    expect(frames.map((f) => f.flags)).toEqual([FLAG_BIN | FLAG_MORE, FLAG_BIN | FLAG_MORE, FLAG_BIN]);
    expect(new Set(frames.map((f) => f.id)).size).toBe(1);
    const back = new Uint8Array(bytes.length);
    let at = 0;
    for (const f of frames) {
      back.set(f.payload, at);
      at += f.payload.length;
    }
    expect(back).toEqual(bytes);
  });

  it('each message has its own id', () => {
    const { w, dc } = wire();
    w.send(new Uint8Array([1]));
    w.send(new Uint8Array([2]));
    const ids = dc.sent.map((s) => decodeFrame(s as Uint8Array<ArrayBuffer>).id);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('exactly 4 MiB goes. One byte more goes nowhere: not a frame of it', () => {
    const { w, dc, ends } = wire();
    expect(w.send(new Uint8Array(MAX_COLLAB_MESSAGE + 1))).toBe(false);
    expect(dc.sent).toHaveLength(0);
    expect(ends).toEqual([]);
    expect(w.open).toBe(true);
    expect(w.send(new Uint8Array(MAX_COLLAB_MESSAGE))).toBe(true);
    expect(dc.sent.length).toBe(Math.ceil(MAX_COLLAB_MESSAGE / MAX_PAYLOAD));
  });

  it('holds what the browser has no room for, in order, until its buffer drains', () => {
    const { w, dc } = wire();
    dc.bufferedAmount = 2 * 1024 * 1024;
    w.send(filled(10));
    w.send(filled(20));
    expect(dc.sent).toHaveLength(0);
    dc.bufferedAmount = 0;
    dc.onbufferedamountlow?.();
    expect(dc.sent.map((s) => decodeFrame(s as Uint8Array<ArrayBuffer>).payload.length)).toEqual([10, 20]);
  });

  it('says no once the channel is not open', () => {
    const { w, dc } = wire();
    dc.readyState = 'closed';
    expect(w.send(new Uint8Array(1))).toBe(false);
  });
});

describe('receiving', () => {
  it('hands on a BIN message whole, across its frames', () => {
    const { dc, messages } = wire();
    const bytes = filled(MAX_PAYLOAD + 100);
    for (const f of encodeMessage(Kind.DATA, FLAG_BIN, 9, 0, bytes)) dc.deliver(f);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(bytes);
  });

  it('{"t":"reset"} without BIN says reset, and the channel carries on', () => {
    const { w, dc, messages, ends } = wire();
    for (const f of encodeJson(Kind.DATA, 1, { t: 'reset' })) dc.deliver(f);
    expect(ends).toEqual(['reset']);
    expect(messages).toEqual([]);
    expect(w.open).toBe(true);
    expect(w.send(new Uint8Array(1))).toBe(true);
  });

  it('ignores other JSON, other kinds and bad frames', () => {
    const { dc, messages, ends } = wire();
    for (const f of encodeJson(Kind.DATA, 1, { t: 'something new' })) dc.deliver(f);
    for (const f of encodeJson(Kind.EVT, 1, { t: 'reset' })) dc.deliver(f);
    dc.deliver(new Uint8Array([9, 9, 9]));
    expect(messages).toEqual([]);
    expect(ends).toEqual([]);
  });
});

describe('the session', () => {
  it('reports the channel opening', () => {
    const dc = new FakeChannel();
    dc.readyState = 'connecting';
    const w = new CollabWire();
    let opened = 0;
    w.onOpen = () => (opened += 1);
    w.attach(dc);
    expect(w.open).toBe(false);
    dc.readyState = 'open';
    dc.onopen?.();
    expect(opened).toBe(1);
    expect(w.open).toBe(true);
  });

  it('ends once, says so, and forgets what was waiting', () => {
    const { w, dc, ends } = wire();
    dc.bufferedAmount = 2 * 1024 * 1024;
    w.send(filled(10));
    w.end();
    w.end();
    expect(ends).toEqual(['ended']);
    expect(w.open).toBe(false);
    expect(w.send(new Uint8Array(1))).toBe(false);
    dc.bufferedAmount = 0;
    dc.onbufferedamountlow?.();
    expect(dc.sent).toHaveLength(0);
  });

  it('the channel closing ends it', () => {
    const { dc, ends } = wire();
    dc.onclose?.();
    expect(ends).toEqual(['ended']);
  });
});
