// The working copy at rest: AES-GCM records under a non-extractable WebCrypto key, which lives only in this browser's
// IndexedDB beside the journal and goes with it. Nothing of the member's is ever in the private storage or IndexedDB
// in the clear; it's decrypted only as the finished archive is copied out.
//
// Record `i` holds plaintext bytes [i * RECORD, (i + 1) * RECORD) of the archive, at `i * SLOT` in the file: its
// 12-byte IV, then the ciphertext and the 16-byte tag. Only the last can be short. The record's index is its
// additional data, so records can't be moved about. An IV is never used twice under a key: a domain byte (records or
// the journal), the session's epoch (raised in IndexedDB before a session writes anything), then a counter.
import type { Sink } from './zip';

export const RECORD = 1024 * 1024;
const IV = 12;
const TAG = 16;
export const SLOT = IV + RECORD + TAG;
/** What sealing adds to a record. */
export const OVERHEAD = IV + TAG;

/** Positional storage: the worker's sync access handle, or memory in a test. */
export interface Blocks {
  size(): number;
  writeAt(at: number, bytes: Uint8Array): Promise<void>;
  read(at: number, len: number): Promise<Uint8Array>;
  truncate(size: number): Promise<void>;
  flush(): Promise<void>;
}

/** AES-GCM, 256 bits, that WebCrypto will never hand out: `extractable: false`. */
export const newKey = (): Promise<CryptoKey> => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

export const DOMAIN_RECORDS = 0;
export const DOMAIN_JOURNAL = 1;

/** IVs for one session: domain, epoch (24 bits), counter (64 bits). */
export class Nonces {
  private counter = 0;
  constructor(private readonly epoch: number) {
    if (!Number.isInteger(epoch) || epoch < 1 || epoch >= 2 ** 24) throw new Error('an epoch is 1 to 2^24 - 1');
  }
  next(domain: number): Uint8Array<ArrayBuffer> {
    const iv = new Uint8Array(IV);
    const v = new DataView(iv.buffer);
    v.setUint32(0, ((domain & 0xff) << 24) | this.epoch);
    v.setBigUint64(4, BigInt(this.counter++));
    return iv;
  }
}

const indexAad = (i: number): Uint8Array<ArrayBuffer> => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(i));
  return b;
};

/** IV, then ciphertext and tag. */
export async function sealBytes(key: CryptoKey, iv: Uint8Array<ArrayBuffer>, plain: Uint8Array, aad: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plain as Uint8Array<ArrayBuffer>));
  const out = new Uint8Array(IV + ct.length);
  out.set(iv);
  out.set(ct, IV);
  return out;
}

/** Throws if it was changed, moved, or sealed under another key. */
export async function openBytes(key: CryptoKey, sealed: Uint8Array, aad: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  if (sealed.length < IV + TAG) throw new DOMException('a sealed record is too short', 'OperationError');
  const iv = sealed.slice(0, IV);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, sealed.slice(IV)));
}

/** The ZIP writer's sink: plaintext in, sealed records out. Only the record being filled is ever held in the clear. */
export class SealedSink implements Sink {
  private readonly tail = new Uint8Array(RECORD);
  private tailLen = 0;
  /** The record being filled. */
  private index = 0;

  constructor(
    private readonly blocks: Blocks,
    private readonly key: CryptoKey,
    private readonly nonces: Nonces,
  ) {}

  async write(bytes: Uint8Array): Promise<void> {
    for (let at = 0; at < bytes.length; ) {
      const take = Math.min(RECORD - this.tailLen, bytes.length - at);
      this.tail.set(bytes.subarray(at, at + take), this.tailLen);
      this.tailLen += take;
      at += take;
      if (this.tailLen === RECORD) {
        await this.seal();
        this.index += 1;
        this.tailLen = 0;
      }
    }
  }

  /** Seals the part-filled record too, under a new IV, and makes it all durable: what a journal checkpoint needs. */
  async flush(): Promise<void> {
    if (this.tailLen) await this.seal();
    await this.blocks.flush();
  }

  /** Back to `size` bytes of plaintext. A record cut in two is read back, and only its first part kept. */
  async truncate(size: number): Promise<void> {
    const i = Math.floor(size / RECORD);
    const within = size % RECORD;
    if (i === this.index && within <= this.tailLen) {
      this.tailLen = within;
    } else if (within === 0) {
      this.tailLen = 0;
    } else {
      const at = i * SLOT;
      const len = Math.min(SLOT, this.blocks.size() - at);
      if (len < IV + TAG + within) throw new DOMException('the working copy is shorter than its journal', 'NotFoundError');
      const plain = await this.openRecord(i, at, len, within);
      if (plain.length < within) throw new DOMException('the working copy is shorter than its journal', 'NotFoundError');
      this.tail.set(plain.subarray(0, within));
      this.tailLen = within;
      plain.fill(0);
    }
    this.index = i;
    // What's kept of a cut record is sealed again at once, so the working copy never holds less than its journal says.
    if (this.tailLen) {
      await this.seal();
      await this.blocks.truncate(i * SLOT + IV + this.tailLen + TAG);
    } else {
      await this.blocks.truncate(i * SLOT);
    }
  }

  /**
   * Record `i` as it is, or as an earlier cut to this same point left it: that cut seals the short record over the
   * long one before it truncates the rest, so a tab killed in between leaves the short record with the long one's tail
   * after it. Read at the short length, it opens.
   */
  private async openRecord(i: number, at: number, len: number, within: number): Promise<Uint8Array> {
    try {
      return await openBytes(this.key, await this.blocks.read(at, len), indexAad(i));
    } catch (err) {
      const short = IV + within + TAG;
      if (len === short) throw err;
      return openBytes(this.key, await this.blocks.read(at, short), indexAad(i));
    }
  }

  private async seal(): Promise<void> {
    const sealed = await sealBytes(this.key, this.nonces.next(DOMAIN_RECORDS), this.tail.subarray(0, this.tailLen), indexAad(this.index));
    await this.blocks.writeAt(this.index * SLOT, sealed);
  }
}

/** The archive in the clear, record by record, from `size` bytes of sealed records. */
export async function* unseal(blocks: Pick<Blocks, 'read'>, size: number, key: CryptoKey): AsyncGenerator<Uint8Array> {
  for (let i = 0; i * SLOT < size; i += 1) {
    const at = i * SLOT;
    yield await openBytes(key, await blocks.read(at, Math.min(SLOT, size - at)), indexAad(i));
  }
}
