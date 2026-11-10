// Commons' framing on the room link, the twin of server/internal/wire/wire.go.
// A link message holds one or more records: [type u8][length u32 LE][payload].

export const REC = {
  ctrl: 1,
  boardUpdate: 2, // c→s [board][ref u32][yjs update]
  boardEntry: 3, // s→c [board][seq u32][yjs update]
  boardAck: 4, // s→c [board][seq u32][ref u32]
  boardSnapshot: 5, // c→s [board][upto u32][yjs state]
  cursor: 6, // c→s [x f32][y f32]; s→c [member u16][x f32][y f32]
  live: 7, // c→s [opaque]; s→c [member u16][opaque]
  speaking: 8, // s→c [n u16][member u16]×n
  part: 9, // both ways [last u8][bytes]: a piece of one record too big for a message
} as const;

export const PROTOCOL_VERSION = 2;

/** The most a link message may hold on a desk (deskd takes 4 MiB; smaller keeps a big board from holding up the rest). */
export const MAX_MESSAGE = 1 << 20;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** One record, ready to send as a link message. */
export function record(type: number, ...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(5 + n);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, n, true);
  let at = 5;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

export function ctrl(msg: object): Uint8Array {
  return record(REC.ctrl, enc.encode(JSON.stringify(msg)));
}

/** Calls fn for every record in a link message. */
export function eachRecord(msg: Uint8Array, fn: (type: number, payload: Uint8Array) => void): void {
  const dv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  let at = 0;
  while (at + 5 <= msg.byteLength) {
    const type = msg[at]!;
    const n = dv.getUint32(at + 1, true);
    if (at + 5 + n > msg.byteLength) throw new Error('commons: short record');
    fn(type, msg.subarray(at + 5, at + 5 + n));
    at += 5 + n;
  }
}

export function boardPrefix(id: string): Uint8Array {
  const b = enc.encode(id);
  const out = new Uint8Array(1 + b.byteLength);
  out[0] = b.byteLength;
  out.set(b, 1);
  return out;
}

export function readBoardId(p: Uint8Array): { id: string; rest: Uint8Array } {
  const n = p[0] ?? 0;
  return { id: dec.decode(p.subarray(1, 1 + n)), rest: p.subarray(1 + n) };
}

export function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, true);
  return b;
}

export function readU32(p: Uint8Array, at = 0): number {
  return new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(at, true);
}

export function readU16(p: Uint8Array, at = 0): number {
  return new DataView(p.buffer, p.byteOffset, p.byteLength).getUint16(at, true);
}

export function cursorBody(x: number, y: number): Uint8Array {
  const b = new Uint8Array(8);
  const dv = new DataView(b.buffer);
  dv.setFloat32(0, x, true);
  dv.setFloat32(4, y, true);
  return b;
}

/** A relayed cursor: member, and x, y (NaN when hidden). */
export function readCursor(p: Uint8Array): { member: number; x: number; y: number } {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  return { member: dv.getUint16(0, true), x: dv.getFloat32(2, true), y: dv.getFloat32(6, true) };
}

export function readSpeaking(p: Uint8Array): number[] {
  const n = readU16(p);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(readU16(p, 2 + i * 2));
  return out;
}

export function decodeCtrl(p: Uint8Array): Record<string, unknown> & { t: string } {
  return JSON.parse(dec.decode(p)) as Record<string, unknown> & { t: string };
}

/** Cuts a run of whole records into messages of at most max bytes, between records; a bigger record goes as parts. */
export function splitMessage(msg: Uint8Array, max = MAX_MESSAGE): Uint8Array[] {
  if (msg.byteLength <= max) return [msg];
  const out: Uint8Array[] = [];
  const dv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  let start = 0;
  let at = 0;
  while (at + 5 <= msg.byteLength) {
    const n = 5 + dv.getUint32(at + 1, true);
    if (at + n > msg.byteLength) break;
    if (n > max) {
      if (at > start) out.push(msg.subarray(start, at));
      out.push(...parts(msg.subarray(at, at + n), max));
      at += n;
      start = at;
      continue;
    }
    if (at + n - start > max) {
      out.push(msg.subarray(start, at));
      start = at;
    }
    at += n;
  }
  if (start < msg.byteLength) out.push(msg.subarray(start));
  return out;
}

/** One whole record as part records, each at most max bytes. */
export function parts(rec: Uint8Array, max = MAX_MESSAGE): Uint8Array[] {
  const body = max - 6;
  const out: Uint8Array[] = [];
  for (let at = 0; at < rec.byteLength; at += body) {
    const piece = rec.subarray(at, Math.min(at + body, rec.byteLength));
    out.push(record(REC.part, new Uint8Array([at + body >= rec.byteLength ? 1 : 0]), piece));
  }
  return out;
}

/** Puts part records back together. add() returns the whole record (header included) after the last part. */
export class PartJoiner {
  private chunks: Uint8Array[] = [];
  private size = 0;

  add(p: Uint8Array): Uint8Array | null {
    const piece = p.subarray(1);
    this.chunks.push(piece);
    this.size += piece.byteLength;
    if (this.size > (16 << 20) + 5) {
      this.chunks = [];
      this.size = 0;
      throw new Error('commons: parts too big');
    }
    if (p[0] !== 1) return null;
    const rec = new Uint8Array(this.size);
    let at = 0;
    for (const c of this.chunks) {
      rec.set(c, at);
      at += c.byteLength;
    }
    this.chunks = [];
    this.size = 0;
    return rec;
  }
}
