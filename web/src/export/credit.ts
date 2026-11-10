// `bulk`'s flow control for one `data.read` (draft ADR "data export and transfer", section 7). `data.read` itself
// grants the first MiB. After that the reader grants more only as it writes, in steps of at least 256 KiB, so a slow
// disk slows its own transfer and nothing piles up in memory.
export const FIRST_WINDOW = 1024 * 1024;
export const CREDIT_STEP = 256 * 1024;

/** Positions are bytes of the file, from 0, as `data.read`'s `offset` counts them. */
export class CreditWindow {
  /** How far the desk may send. */
  granted: number;

  constructor(offset: number) {
    this.granted = offset + FIRST_WINDOW;
  }

  /**
   * Everything before `pos` is written. Returns the CREDIT to send: 0, or enough to keep a whole window ahead of what's
   * written, and never less than a step.
   */
  writtenTo(pos: number): number {
    const more = pos + FIRST_WINDOW - this.granted;
    if (more < CREDIT_STEP) return 0;
    this.granted += more;
    return more;
  }

  /** The desk has sent everything it may and is waiting on us, so a quiet transfer isn't a stalled one. */
  waitingOnUs(received: number): boolean {
    return received >= this.granted;
  }
}

/** The last CHUNK of a file: SHA-256 of bytes 0 to `size`, then `u64be size`. */
export interface Trailer {
  sha256: Uint8Array;
  size: number;
}

export function parseTrailer(payload: Uint8Array): Trailer | null {
  if (payload.length !== 40) return null;
  const size = new DataView(payload.buffer, payload.byteOffset + 32, 8).getBigUint64(0);
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { sha256: payload.slice(0, 32), size: Number(size) };
}

/** What arrived is exactly what the desk read: every byte, and the same hash end to end. */
export function trailerMatches(t: Trailer | null, digest: Uint8Array, received: number): boolean {
  if (!t || t.size !== received || digest.length !== 32) return false;
  for (let i = 0; i < 32; i += 1) if (t.sha256[i] !== digest[i]) return false;
  return true;
}
