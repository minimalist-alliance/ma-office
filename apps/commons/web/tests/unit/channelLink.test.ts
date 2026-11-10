// DataChannelLink over the Desk app's channel and over a plain RTCDataChannel: whole messages both ways, deskd's reset
// and the hello that follows it, and big messages cut into parts that join again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataChannelLink, fromDataChannel, type ChannelEnd, type CommonsChannel, type DataChannelLike } from '../../src/net/channelLink.ts';
import { MAX_MESSAGE, PartJoiner, REC, eachRecord, record, splitMessage } from '../../src/net/protocol.ts';

class FakeChannel implements CommonsChannel {
  open = false;
  onOpen: (() => void) | null = null;
  onMessage: ((bytes: Uint8Array) => void) | null = null;
  onEnd: ((why: ChannelEnd) => void) | null = null;
  sent: Uint8Array[] = [];
  send(bytes: Uint8Array): boolean {
    if (!this.open) return false;
    this.sent.push(bytes);
    return true;
  }
  up(): void {
    this.open = true;
    this.onOpen?.();
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('DataChannelLink', () => {
  it('opens with the channel, carries whole messages, and says hello again after a reset', () => {
    const ch = new FakeChannel();
    const link = new DataChannelLink(ch);
    const opens: number[] = [];
    const got: Uint8Array[] = [];
    let closes = 0;
    link.onOpen = () => opens.push(Date.now());
    link.onClose = () => closes++;
    link.onMessage = (m) => got.push(m);
    vi.advanceTimersByTime(1);
    expect(link.state).toBe('connecting');
    ch.up();
    expect(link.state).toBe('open');
    expect(opens.length).toBe(1);
    link.send(new Uint8Array([1, 2, 3]));
    expect(ch.sent).toEqual([new Uint8Array([1, 2, 3])]);
    ch.onMessage!(new Uint8Array([9]));
    expect(got).toEqual([new Uint8Array([9])]);

    // deskd's reset: closed now, open again after a short wait, so the room client says hello again.
    ch.onEnd!('reset');
    expect(link.state).toBe('closed');
    expect(closes).toBe(1);
    link.send(new Uint8Array([4]));
    expect(ch.sent.length).toBe(1);
    vi.advanceTimersByTime(499);
    expect(opens.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(opens.length).toBe(2);

    // Resets with nothing between them back off.
    ch.onEnd!('reset');
    vi.advanceTimersByTime(999);
    expect(opens.length).toBe(2);
    vi.advanceTimersByTime(1);
    expect(opens.length).toBe(3);
    ch.onMessage!(new Uint8Array([1]));
    ch.onEnd!('reset');
    vi.advanceTimersByTime(500);
    expect(opens.length).toBe(4);
  });

  it('waits for a new channel when the session ends', () => {
    const ch = new FakeChannel();
    const link = new DataChannelLink(ch);
    let opens = 0;
    link.onOpen = () => opens++;
    vi.advanceTimersByTime(1);
    ch.up();
    ch.open = false;
    ch.onEnd!('ended');
    vi.advanceTimersByTime(10_000);
    expect(link.state).toBe('closed');
    const next = new FakeChannel();
    next.open = true;
    link.attach(next);
    expect(link.state).toBe('open');
    expect(opens).toBe(2);
    ch.onMessage?.(new Uint8Array([1]));
  });

  it('cuts a message over 1 MiB into parts, and they join into the record', () => {
    const ch = new FakeChannel();
    const link = new DataChannelLink(ch);
    vi.advanceTimersByTime(1);
    ch.up();
    const big = record(REC.boardSnapshot, new Uint8Array(3 * MAX_MESSAGE).fill(7));
    link.send(big);
    expect(ch.sent.length).toBe(4);
    for (const m of ch.sent) expect(m.byteLength).toBeLessThanOrEqual(MAX_MESSAGE);
    const j = new PartJoiner();
    let whole: Uint8Array | null = null;
    for (const m of ch.sent)
      eachRecord(m, (t, p) => {
        expect(t).toBe(REC.part);
        whole = j.add(p) ?? whole;
      });
    expect(whole).toEqual(big);
  });

  it('splits between records and leaves small runs whole', () => {
    const small = record(REC.ctrl, new Uint8Array(100));
    expect(splitMessage(small)).toEqual([small]);
    const many = new Uint8Array(small.byteLength * 20000);
    for (let i = 0; i < 20000; i++) many.set(small, i * small.byteLength);
    const out = splitMessage(many);
    expect(out.length).toBe(Math.ceil(many.byteLength / MAX_MESSAGE));
    let n = 0;
    for (const m of out) eachRecord(m, () => n++);
    expect(n).toBe(20000);
  });

  it('takes a plain RTCDataChannel: binary is the room link, text {"t":"reset"} is deskd', () => {
    const dc: DataChannelLike & { sent: Uint8Array[]; readyState: string } = {
      readyState: 'connecting',
      bufferedAmount: 0,
      sent: [],
      send(d) {
        this.sent.push(d);
      },
      onopen: null,
      onmessage: null,
      onclose: null,
    };
    const ch = fromDataChannel(dc);
    const ends: ChannelEnd[] = [];
    const got: number[] = [];
    ch.onEnd = (w) => ends.push(w);
    ch.onMessage = (b) => got.push(b[0]!);
    expect(dc.binaryType).toBe('arraybuffer');
    expect(ch.send(new Uint8Array([1]))).toBe(false);
    dc.readyState = 'open';
    expect(ch.send(new Uint8Array([1]))).toBe(true);
    dc.onmessage!({ data: new Uint8Array([5]).buffer } as MessageEvent);
    dc.onmessage!({ data: '{"t":"reset"}' } as MessageEvent);
    dc.onmessage!({ data: 'something else' } as MessageEvent);
    dc.onclose!(new Event('close'));
    expect(got).toEqual([5]);
    expect(ends).toEqual(['reset', 'ended']);
  });
});
