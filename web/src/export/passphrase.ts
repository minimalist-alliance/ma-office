// An optional passphrase on the download (task 32, EXP-4). The finished archive is encrypted as it is copied out of the
// working copy, so the file the member keeps can't be opened without the passphrase they chose. We never see it, keep it
// or send it anywhere, and cannot recover it.
//
// The format ("MAEXPORT", version 1) is documented for anyone to read, and for `tools/export-decrypt/decrypt.mjs`:
//
//   offset  size  field
//   0       8     magic, the ASCII bytes "MAEXPORT"
//   8       1     format version, 1
//   9       1     key derivation, 1 = PBKDF2-HMAC-SHA-256 (the passphrase as NFC-normalised UTF-8)
//   10      1     cipher, 1 = AES-256-GCM
//   11      1     reserved, 0
//   12      4     PBKDF2 iterations, big-endian (600000)
//   16      16    salt, random
//   32      4     record size, big-endian (1048576): plaintext bytes in every record but the last
//   36      4     nonce prefix, random
//   40      ...   records, back to back
//
// A record is the ciphertext of up to one record size of the ZIP archive, then its 16-byte GCM tag. Its IV is the nonce
// prefix and the record's number (from 0) as 8 big-endian bytes. Its additional data is the 40 header bytes, the number
// as 8 big-endian bytes, and one byte: 1 on the last record, else 0. So a record can't be moved, dropped or repeated,
// and a file cut short fails at its end. The last record holds 0 to one record size of plaintext (0 only for an empty
// archive). Decrypting the whole file gives the ZIP exactly.
//
// The key derivation is PBKDF2 because it is what WebCrypto offers in every browser; the iteration count is in the
// header, so a later version can raise it.
export const MAGIC = 'MAEXPORT';
export const VERSION = 1;
export const HEADER = 40;
export const ENC_RECORD = 1024 * 1024;
export const TAG = 16;
export const ITERATIONS = 600_000;
export const MIN_PASSPHRASE = 10;

/** `….zip` becomes `….zip.enc`. */
export const encryptedName = (zipName: string): string => `${zipName}.enc`;

/** A passphrase is good if it's long enough; the page says how long. */
export const passphraseProblem = (p: string, again: string): string | null =>
  [...p].length < MIN_PASSPHRASE ? `Use at least ${MIN_PASSPHRASE} characters.` : p !== again ? "The two don't match." : null;

const text = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s.normalize('NFC')) as Uint8Array<ArrayBuffer>;

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', text(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const be64 = (n: number): Uint8Array<ArrayBuffer> => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
};

function recordParts(header: Uint8Array, prefix: Uint8Array, index: number, last: boolean): { iv: Uint8Array<ArrayBuffer>; aad: Uint8Array<ArrayBuffer> } {
  const iv = new Uint8Array(12);
  iv.set(prefix.subarray(0, 4));
  iv.set(be64(index), 4);
  const aad = new Uint8Array(HEADER + 9);
  aad.set(header.subarray(0, HEADER));
  aad.set(be64(index), HEADER);
  aad[HEADER + 8] = last ? 1 : 0;
  return { iv, aad };
}

/** Plaintext chunks of any size in, the encrypted file out: the header, then each record. */
export async function* encryptStream(plain: AsyncIterable<Uint8Array>, passphrase: string, opts: { iterations?: number; record?: number } = {}): AsyncGenerator<Uint8Array> {
  const iterations = opts.iterations ?? ITERATIONS;
  const record = opts.record ?? ENC_RECORD;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const header = new Uint8Array(HEADER);
  header.set(new TextEncoder().encode(MAGIC));
  header[8] = VERSION;
  header[9] = 1;
  header[10] = 1;
  const v = new DataView(header.buffer);
  v.setUint32(12, iterations);
  header.set(salt, 16);
  v.setUint32(32, record);
  crypto.getRandomValues(header.subarray(36, 40));
  const key = await deriveKey(passphrase, salt, iterations);
  yield header;

  const buf = new Uint8Array(record);
  let held = 0;
  let index = 0;
  const seal = async (len: number, last: boolean): Promise<Uint8Array> => {
    const { iv, aad } = recordParts(header, header.subarray(36, 40), index, last);
    index += 1;
    return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, buf.slice(0, len)));
  };
  for await (const chunk of plain) {
    for (let at = 0; at < chunk.length; ) {
      // A full record is held back until more arrives, so the last one can be marked as the last.
      if (held === record) {
        yield await seal(held, false);
        held = 0;
      }
      const take = Math.min(record - held, chunk.length - at);
      buf.set(chunk.subarray(at, at + take), held);
      held += take;
      at += take;
    }
  }
  yield await seal(held, true);
}

export class WrongPassphrase extends Error {
  constructor() {
    super('That passphrase does not open this file, or the file is damaged.');
    this.name = 'WrongPassphrase';
  }
}

/** The inverse, for tests and a possible page: the file in as chunks of any size, the ZIP out. */
export async function* decryptStream(file: AsyncIterable<Uint8Array>, passphrase: string): AsyncGenerator<Uint8Array> {
  let pending = new Uint8Array(0);
  const it = file[Symbol.asyncIterator]();
  let ended = false;
  const need = async (n: number): Promise<boolean> => {
    while (pending.length < n && !ended) {
      const r = await it.next();
      if (r.done) {
        ended = true;
        break;
      }
      const joined = new Uint8Array(pending.length + r.value.length);
      joined.set(pending);
      joined.set(r.value, pending.length);
      pending = joined;
    }
    return pending.length >= n;
  };
  if (!(await need(HEADER))) throw new WrongPassphrase();
  const header = pending.slice(0, HEADER);
  pending = pending.slice(HEADER);
  if (new TextDecoder().decode(header.subarray(0, 8)) !== MAGIC || header[8] !== VERSION || header[9] !== 1 || header[10] !== 1) throw new WrongPassphrase();
  const v = new DataView(header.buffer);
  const iterations = v.getUint32(12);
  const record = v.getUint32(32);
  if (iterations < 1 || iterations > 50_000_000 || record < 1 || record > 64 * 1024 * 1024) throw new WrongPassphrase();
  const key = await deriveKey(passphrase, header.slice(16, 32), iterations);
  for (let index = 0; ; index += 1) {
    await need(record + TAG + 1); // one byte past the record says whether it is the last
    const last = pending.length <= record + TAG;
    const len = Math.min(pending.length, record + TAG);
    if (len < TAG) throw new WrongPassphrase();
    const { iv, aad } = recordParts(header, header.subarray(36, 40), index, last);
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, pending.slice(0, len));
    } catch {
      throw new WrongPassphrase();
    }
    pending = pending.slice(len);
    yield new Uint8Array(plain);
    if (last) return;
  }
}
