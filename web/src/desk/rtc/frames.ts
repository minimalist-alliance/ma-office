// Data-channel frames (design 4.2.4). Kind numbers follow the design's table order from 1, as in
// desk-rtc/internal/frame.
export const Kind = {
  HELLO: 1,
  AUTH: 2,
  ACTIVITY: 3,
  PING: 4,
  PONG: 5,
  CLOSE: 6,
  REQ: 7,
  RES: 8,
  ERR: 9,
  SUB: 10,
  UNSUB: 11,
  EVT: 12,
  CANCEL: 13,
  DATA: 14,
  CHUNK: 15,
  CREDIT: 16,
} as const;
export type FrameKind = (typeof Kind)[keyof typeof Kind];

export const FLAG_MORE = 1;
export const FLAG_BIN = 2;
export const FLAG_END = 4;

const KNOWN_FLAGS = FLAG_MORE | FLAG_BIN | FLAG_END;

const VERSION = 1;
export const HEADER_SIZE = 12;
export const MAX_FRAME = 16 * 1024;
export const MAX_PAYLOAD = MAX_FRAME - HEADER_SIZE;

export interface Frame {
  kind: number;
  flags: number;
  id: number;
  seq: number;
  payload: Uint8Array<ArrayBuffer>;
}

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

export function encodeFrame(kind: number, flags: number, id: number, seq: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  if (payload.length > MAX_PAYLOAD) throw new FrameError(`payload of ${payload.length} bytes doesn't fit one frame`);
  const out = new Uint8Array(HEADER_SIZE + payload.length);
  const view = new DataView(out.buffer);
  out[0] = VERSION;
  out[1] = kind;
  out[2] = flags;
  view.setUint32(4, id);
  view.setUint32(8, seq);
  out.set(payload, HEADER_SIZE);
  return out;
}

export function decodeFrame(data: ArrayBuffer | Uint8Array<ArrayBuffer>): Frame {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < HEADER_SIZE) throw new FrameError('frame is shorter than its header');
  if (bytes.length > MAX_FRAME) throw new FrameError('frame is over 16 KiB');
  if (bytes[0] !== VERSION) throw new FrameError(`unknown frame version ${bytes[0]}`);
  if (bytes[3] !== 0) throw new FrameError('the reserved byte is set');
  if ((bytes[2] as number) & ~KNOWN_FLAGS) throw new FrameError('unknown flag');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    kind: bytes[1] as number,
    flags: bytes[2] as number,
    id: view.getUint32(4),
    seq: view.getUint32(8),
    payload: bytes.subarray(HEADER_SIZE),
  };
}

/** One message as one or more frames: MORE on all but the last, END only on the last, BIN on all. */
export function encodeMessage(kind: number, flags: number, id: number, seq: number, bytes: Uint8Array): Uint8Array<ArrayBuffer>[] {
  const frames: Uint8Array<ArrayBuffer>[] = [];
  let at = 0;
  do {
    const end = Math.min(at + MAX_PAYLOAD, bytes.length);
    const last = end === bytes.length;
    frames.push(encodeFrame(kind, last ? flags : (flags & ~FLAG_END) | FLAG_MORE, id, seq, bytes.subarray(at, end)));
    at = end;
  } while (at < bytes.length);
  return frames;
}

export function encodeJson(kind: number, id: number, body: unknown): Uint8Array<ArrayBuffer>[] {
  return encodeMessage(kind, 0, id, 0, new TextEncoder().encode(JSON.stringify(body)));
}

export function decodeJson(payload: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(payload));
}

const MiB = 1024 * 1024;
/** The design's limits after reassembly. Kinds not listed are control messages. */
const LIMITS: Partial<Record<number, number>> = { [Kind.REQ]: MiB, [Kind.RES]: MiB, [Kind.EVT]: 64 * 1024, [Kind.DATA]: 4 * MiB };
const CONTROL_LIMIT = 64 * 1024;

/** Reassembly by (kind, id), so a short response can overtake a long one on the same channel. */
export class Reassembler {
  private readonly parts = new Map<string, { chunks: Uint8Array[]; size: number }>();

  /** The whole message once complete, else null. Throws when a message outgrows its limit. */
  push(frame: Frame): Uint8Array | null {
    const key = `${frame.kind}:${frame.id}`;
    const open = this.parts.get(key);
    if (!open && !(frame.flags & FLAG_MORE)) return frame.payload;

    const entry = open ?? { chunks: [], size: 0 };
    entry.chunks.push(frame.payload.slice());
    entry.size += frame.payload.length;
    if (entry.size > (LIMITS[frame.kind] ?? CONTROL_LIMIT)) {
      this.parts.delete(key);
      throw new FrameError(`message kind ${frame.kind} id ${frame.id} is over its limit`);
    }
    if (frame.flags & FLAG_MORE) {
      this.parts.set(key, entry);
      return null;
    }
    this.parts.delete(key);
    const whole = new Uint8Array(entry.size);
    let at = 0;
    for (const c of entry.chunks) {
      whole.set(c, at);
      at += c.length;
    }
    return whole;
  }

  clear(): void {
    this.parts.clear();
  }
}
