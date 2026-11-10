// The framing between deskd and desk-notebook: u32be length of what follows, u8 type, body.
export const FRAME_JSON = 0x01;
export const FRAME_COLLAB = 0x02;
/** What follows the length, type byte included, is at most this. */
export const MAX_FRAME = 4 * 1024 * 1024 + 64 * 1024;
/** One collab message may not pass 4 MiB: over that, deskd closes the whole session (API.md section 2). */
export const MAX_COLLAB_MESSAGE = 4 * 1024 * 1024;

export class FrameError extends Error {
  override name = 'FrameError';
}

export function encodeFrame(type: number, body: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(5 + body.length);
  out.writeUInt32BE(body.length + 1, 0);
  out[4] = type;
  out.set(body, 5);
  return out;
}

/** Reassembles frames from a byte stream. Throws FrameError on a length that can't be right. */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private size = 0;
  private need: number | null = null;

  push(chunk: Buffer, onFrame: (type: number, body: Uint8Array) => void): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    for (;;) {
      if (this.need === null) {
        if (this.size < 4) return;
        const len = this.take(4).readUInt32BE(0);
        if (len < 1 || len > MAX_FRAME) throw new FrameError('frame length out of range');
        this.need = len;
      }
      if (this.size < this.need) return;
      const frame = this.take(this.need);
      this.need = null;
      onFrame(frame[0] as number, new Uint8Array(frame.buffer, frame.byteOffset + 1, frame.length - 1));
    }
  }

  private take(n: number): Buffer {
    const first = this.chunks[0] as Buffer;
    this.size -= n;
    if (first.length === n) {
      this.chunks.shift();
      return first;
    }
    if (first.length > n) {
      this.chunks[0] = first.subarray(n);
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let at = 0;
    while (at < n) {
      const c = this.chunks[0] as Buffer;
      const use = Math.min(c.length, n - at);
      c.copy(out, at, 0, use);
      at += use;
      if (use === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(use);
    }
    return out;
  }
}
