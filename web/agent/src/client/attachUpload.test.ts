import { describe, expect, it } from 'vitest';
import { CHUNK_BYTES, chunkCount, newUploadId, toBase64, uploadInChunks, type Chunk } from './attachUpload';

const bytesOf = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) % 256);
const fileOf = (n: number): File => new File([bytesOf(n) as BlobPart], 'a.bin');

async function run(n: number, opts: Parameters<typeof uploadInChunks>[2] = {}): Promise<Chunk[]> {
  const got: Chunk[] = [];
  await uploadInChunks(fileOf(n), async (c) => void got.push({ ...c }), opts);
  return got;
}

describe('uploadInChunks', () => {
  it('sends a small file as one chunk', async () => {
    const got = await run(100);
    expect(got.map((c) => [c.index, c.bytes])).toEqual([[0, 100]]);
    expect(got[0]!.data).toBe(Buffer.from(bytesOf(100)).toString('base64'));
  });

  it('cuts at 512 KiB, in order, and the last chunk is what is left', async () => {
    const got = await run(CHUNK_BYTES * 2 + 5);
    expect(got.map((c) => [c.index, c.bytes])).toEqual([[0, CHUNK_BYTES], [1, CHUNK_BYTES], [2, 5]]);
  });

  it('a file of exactly 512 KiB is one chunk', async () => {
    expect((await run(CHUNK_BYTES)).map((c) => c.bytes)).toEqual([CHUNK_BYTES]);
  });

  it('puts the file back together from its chunks', async () => {
    const n = CHUNK_BYTES + 1234;
    const got = await run(n);
    const joined = Buffer.concat(got.map((c) => Buffer.from(c.data, 'base64')));
    expect(joined.equals(Buffer.from(bytesOf(n)))).toBe(true);
  });

  it('never sends a chunk larger than the desk says, nor larger than 512 KiB', async () => {
    expect((await run(1000, { chunkBytes: 300 })).map((c) => c.bytes)).toEqual([300, 300, 300, 100]);
    expect((await run(CHUNK_BYTES + 1, { chunkBytes: 10 * CHUNK_BYTES })).map((c) => c.bytes)).toEqual([CHUNK_BYTES, 1]);
  });

  it('waits for each answer before reading the next, and stops on a refusal', async () => {
    const seen: number[] = [];
    await expect(
      uploadInChunks(fileOf(CHUNK_BYTES * 3), async (c) => {
        seen.push(c.index);
        if (c.index === 1) throw new Error('refused');
      }),
    ).rejects.toThrow('refused');
    expect(seen).toEqual([0, 1]);
  });

  it('reports progress, and stops before the next chunk when aborted', async () => {
    const ctl = new AbortController();
    const seen: number[] = [];
    const progress: number[] = [];
    await expect(
      uploadInChunks(
        fileOf(CHUNK_BYTES * 3),
        async (c) => {
          seen.push(c.index);
          if (c.index === 0) ctl.abort();
        },
        { signal: ctl.signal, onProgress: (p) => progress.push(p) },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toEqual([0]);
    expect(progress).toHaveLength(1);
  });

  it('an empty file is one empty chunk', async () => {
    expect(chunkCount(0)).toBe(1);
  });
});

describe('ids and base64', () => {
  it('an upload id fits the desk (8 to 48 of A-Za-z0-9_-) and differs each time', () => {
    const a = newUploadId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,48}$/);
    expect(newUploadId()).not.toBe(a);
  });

  it('base64 matches the standard for sizes around the 3-byte groups', () => {
    for (const n of [0, 1, 2, 3, 4, 24575, 24576, 24577, 50000]) expect(toBase64(bytesOf(n))).toBe(Buffer.from(bytesOf(n)).toString('base64'));
  });
});
