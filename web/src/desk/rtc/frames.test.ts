import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeFrame, decodeJson, encodeFrame, encodeJson, encodeMessage, FLAG_BIN, FLAG_END, FLAG_MORE, FrameError, HEADER_SIZE, Kind, MAX_FRAME, MAX_PAYLOAD, Reassembler } from './frames';

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string): Uint8Array<ArrayBuffer> => new Uint8Array((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));

interface VectorFlags {
  more: boolean;
  bin: boolean;
  end: boolean;
}
interface Vectors {
  kinds: Record<string, number>;
  valid: { name: string; hex: string; kind: string; kindCode: number; flags: VectorFlags; id: number; seq: number; payloadText?: string; payloadHex?: string }[];
  invalid: { name: string; why: string; hex: string }[];
  messages: { name: string; kind: string; flags: VectorFlags; id: number; seq: number; payloadLength: number; payloadSha256: string; frames: string[] }[];
}
const vectors = JSON.parse(readFileSync(new URL('../../../../services/deskd/src/test/resources/frames/vectors.json', import.meta.url), 'utf8')) as Vectors;
const flagBits = (f: VectorFlags): number => (f.more ? FLAG_MORE : 0) | (f.bin ? FLAG_BIN : 0) | (f.end ? FLAG_END : 0);
const payloadOf = (v: Vectors['valid'][number]): Uint8Array => (v.payloadHex !== undefined ? unhex(v.payloadHex) : new TextEncoder().encode(v.payloadText ?? ''));

describe("deskd's golden vectors (services/deskd/src/test/resources/frames/vectors.json)", () => {
  it('has the same kind numbers', () => {
    expect(vectors.kinds).toEqual(Kind);
  });

  it.each(vectors.valid.map((v) => [v.name, v] as const))('%s decodes and encodes byte for byte', (_name, v) => {
    const f = decodeFrame(unhex(v.hex));
    expect(f.kind).toBe(v.kindCode);
    expect(f.flags).toBe(flagBits(v.flags));
    expect(f.id).toBe(v.id);
    expect(f.seq).toBe(v.seq);
    expect(hex(f.payload)).toBe(hex(payloadOf(v)));
    expect(hex(encodeFrame(v.kindCode, flagBits(v.flags), v.id, v.seq, payloadOf(v)))).toBe(v.hex);
  });

  it.each(vectors.invalid.map((v) => [v.name, v] as const))('%s is refused', (_name, v) => {
    expect(() => decodeFrame(unhex(v.hex))).toThrow(FrameError);
  });

  it.each(vectors.messages.map((m) => [m.name, m] as const))('%s fragments and reassembles exactly', (_name, m) => {
    const r = new Reassembler();
    let whole: Uint8Array | null = null;
    for (const h of m.frames) whole = r.push(decodeFrame(unhex(h)));
    expect(whole?.length).toBe(m.payloadLength);
    expect(createHash('sha256').update(whole as Uint8Array).digest('hex')).toBe(m.payloadSha256);
    const again = encodeMessage(vectors.kinds[m.kind] as number, flagBits(m.flags), m.id, m.seq, whole as Uint8Array);
    expect(again.map(hex)).toEqual(m.frames);
  });
});

describe('frames (design 4.2.4)', () => {
  it('numbers the kinds in the design table order, as desk-rtc does', () => {
    expect(Object.values(Kind)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(Object.keys(Kind).slice(0, 3)).toEqual(['HELLO', 'AUTH', 'ACTIVITY']);
  });

  it("matches desk-rtc's encoding byte for byte", () => {
    // frame.Encode(frame.Hello, 0, 7, 0, []byte("{}")) in desk-rtc/internal/frame.
    const f = encodeFrame(Kind.HELLO, 0, 7, 0, new TextEncoder().encode('{}'));
    expect(hex(f)).toBe('0101000000000007000000007b7d');
    // frame.Encode(frame.Chunk, FlagBin|FlagEnd, 0x01020304, 0x0a0b0c0d, {0xff}).
    const c = encodeFrame(Kind.CHUNK, FLAG_BIN | FLAG_END, 0x01020304, 0x0a0b0c0d, new Uint8Array([0xff]));
    expect(hex(c)).toBe('010f0600010203040a0b0c0dff');
  });

  it('decodes what it encodes', () => {
    const f = decodeFrame(encodeFrame(Kind.RES, FLAG_MORE, 0xfffffffe, 3, new Uint8Array([1, 2, 3])));
    expect(f).toMatchObject({ kind: Kind.RES, flags: FLAG_MORE, id: 0xfffffffe, seq: 3 });
    expect([...f.payload]).toEqual([1, 2, 3]);
  });

  it('decodes a view into a larger buffer', () => {
    const inner = encodeFrame(Kind.PING, 0, 9, 0, new Uint8Array([7]));
    const big = new Uint8Array(inner.length + 8);
    big.set(inner, 8);
    const f = decodeFrame(big.subarray(8));
    expect(f.id).toBe(9);
    expect([...f.payload]).toEqual([7]);
  });

  it('refuses a short frame or an unknown version', () => {
    expect(() => decodeFrame(new Uint8Array(HEADER_SIZE - 1))).toThrow(FrameError);
    const bad = encodeFrame(Kind.PING, 0, 1, 0, new Uint8Array());
    bad[0] = 2;
    expect(() => decodeFrame(bad)).toThrow(FrameError);
  });

  it('refuses a payload that overflows one frame', () => {
    expect(() => encodeFrame(Kind.REQ, 0, 1, 0, new Uint8Array(MAX_PAYLOAD + 1))).toThrow(FrameError);
  });

  it('splits a long JSON message into frames of at most 16 KiB', () => {
    const body = { text: 'x'.repeat(40_000) };
    const frames = encodeJson(Kind.REQ, 5, body);
    expect(frames.length).toBe(3);
    for (const f of frames) expect(f.length).toBeLessThanOrEqual(MAX_FRAME);
    expect(frames.map((f) => decodeFrame(f).flags)).toEqual([FLAG_MORE, FLAG_MORE, 0]);
    const r = new Reassembler();
    const out = frames.map((f) => r.push(decodeFrame(f)));
    expect(out.slice(0, 2)).toEqual([null, null]);
    expect(decodeJson(out[2] as Uint8Array)).toEqual(body);
  });

  it('sends an empty payload as a single frame', () => {
    const frames = encodeJson(Kind.PING, 1, {});
    expect(frames.length).toBe(1);
    expect(decodeJson(decodeFrame(frames[0] as Uint8Array<ArrayBuffer>).payload)).toEqual({});
  });
});

describe('reassembly', () => {
  const part = (kind: number, id: number, flags: number, text: string) => decodeFrame(encodeFrame(kind, flags, id, 0, new TextEncoder().encode(text)));
  const text = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);

  it('hands a whole frame straight through', () => {
    expect(text(new Reassembler().push(part(Kind.RES, 1, 0, 'one')))).toBe('one');
  });

  it('lets a short response overtake a long one', () => {
    const r = new Reassembler();
    expect(r.push(part(Kind.RES, 1, FLAG_MORE, 'long-'))).toBeNull();
    expect(text(r.push(part(Kind.RES, 2, 0, 'short')))).toBe('short');
    expect(text(r.push(part(Kind.RES, 1, 0, 'end')))).toBe('long-end');
  });

  it('keys by kind as well as id', () => {
    const r = new Reassembler();
    expect(r.push(part(Kind.RES, 1, FLAG_MORE, 'res-'))).toBeNull();
    expect(r.push(part(Kind.EVT, 1, FLAG_MORE, 'evt-'))).toBeNull();
    expect(text(r.push(part(Kind.EVT, 1, 0, 'b')))).toBe('evt-b');
    expect(text(r.push(part(Kind.RES, 1, 0, 'a')))).toBe('res-a');
  });

  it('keeps its own copy, since the channel may reuse the buffer', () => {
    const r = new Reassembler();
    const first = part(Kind.RES, 1, FLAG_MORE, 'abc');
    r.push(first);
    first.payload.fill(0);
    expect(text(r.push(part(Kind.RES, 1, 0, 'd')))).toBe('abcd');
  });

  it('drops a message over its limit and recovers for the next', () => {
    const r = new Reassembler();
    const big = 'x'.repeat(MAX_PAYLOAD);
    expect(() => {
      for (let i = 0; i < 5; i += 1) r.push(part(Kind.EVT, 1, FLAG_MORE, big));
    }).toThrow(FrameError);
    expect(text(r.push(part(Kind.EVT, 1, 0, 'next')))).toBe('next');
  });
});
