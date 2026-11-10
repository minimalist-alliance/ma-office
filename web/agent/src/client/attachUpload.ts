// One file up to the desk, a chunk at a time (ADR 0049). Shared by RpcAgentClient and the mock so they behave the same.
// The file is read a slice at a time from its Blob, so the browser never holds the whole of it as bytes, and each slice and
// its base64 text are dropped as soon as the call that carried it has answered. Nothing here writes to any storage.

/** The most raw bytes in a chunk, if the desk doesn't say (`chunkBytes` from `agent.attach.caps`). */
export const CHUNK_BYTES = 512 * 1024;

/** `agent.attach.put`'s `uploadId`: 8 to 48 of `A-Za-z0-9_-`, the client's choice. */
export function newUploadId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  let s = 'u';
  for (const x of b) s += x.toString(36).padStart(2, '0');
  return s.slice(0, 26);
}

/** Standard base64 with no prefix, built from whole 3-byte groups so nothing spreads a huge argument list. */
export function toBase64(bytes: Uint8Array): string {
  const STEP = 3 * 8192;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += STEP) {
    let bin = '';
    const end = Math.min(i + STEP, bytes.length);
    for (let j = i; j < end; j += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(j, Math.min(j + 8192, end)) as unknown as number[]);
    parts.push(btoa(bin));
  }
  return parts.join('');
}

export interface Chunk {
  index: number;
  /** Base64 of this chunk's bytes. */
  data: string;
  /** Raw bytes in it. */
  bytes: number;
}

/** How many `put`s a file of `size` bytes takes. */
export const chunkCount = (size: number, chunkBytes: number = CHUNK_BYTES): number => Math.max(1, Math.ceil(size / chunkBytes));

/**
 * Reads `file` in order and hands each chunk to `put`, waiting for its answer before reading the next. `put` rejecting stops the
 * upload with that error. `signal` stops it before the next chunk.
 */
export async function uploadInChunks(
  file: Blob,
  put: (chunk: Chunk) => Promise<void>,
  opts: { chunkBytes?: number; signal?: AbortSignal | undefined; onProgress?: ((done: number) => void) | undefined } = {},
): Promise<void> {
  const step = Math.max(1, Math.min(opts.chunkBytes ?? CHUNK_BYTES, CHUNK_BYTES));
  const n = chunkCount(file.size, step);
  for (let index = 0; index < n; index += 1) {
    if (opts.signal?.aborted) throw new DOMException('Upload stopped', 'AbortError');
    const slice = new Uint8Array(await file.slice(index * step, Math.min(file.size, (index + 1) * step)).arrayBuffer());
    const chunk: Chunk = { index, data: toBase64(slice), bytes: slice.length };
    slice.fill(0);
    await put(chunk);
    chunk.data = '';
    opts.onProgress?.((index + 1) / n);
  }
}
