// SHA-256 (FIPS 180-4), fed a piece at a time. WebCrypto can only hash a whole buffer at once, and a file from a
// desk arrives 16 KiB at a time, can be gigabytes, and may stop halfway and carry on over a new session. So this
// keeps its state between pieces, for as long as the file takes.
const K = Int32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** A SHA-256 part way through: plain numbers, so it can be kept in IndexedDB. */
export interface Sha256State {
  h: number[];
  block: number[];
  length: number;
}

export class Sha256 {
  private readonly h = Int32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private readonly w = new Int32Array(64);
  private readonly block = new Uint8Array(64);
  private fill = 0;
  private finished = false;
  /** Bytes hashed so far. */
  length = 0;

  update(data: Uint8Array): this {
    if (this.finished) throw new Error('this SHA-256 has already given its digest');
    const n = data.length;
    let i = 0;
    this.length += n;
    if (this.fill) {
      const take = Math.min(64 - this.fill, n);
      this.block.set(data.subarray(0, take), this.fill);
      this.fill += take;
      i = take;
      if (this.fill < 64) return this;
      this.compress(this.block, 0);
      this.fill = 0;
    }
    for (; i + 64 <= n; i += 64) this.compress(data, i);
    if (i < n) {
      this.block.set(data.subarray(i), 0);
      this.fill = n - i;
    }
    return this;
  }

  /** Everything needed to carry on later, even in another page: a download that resumes after a reload. */
  save(): Sha256State {
    if (this.finished) throw new Error('this SHA-256 has already given its digest');
    return { h: Array.from(this.h), block: Array.from(this.block.subarray(0, this.fill)), length: this.length };
  }

  static restore(s: Sha256State): Sha256 {
    const out = new Sha256();
    if (s.h.length !== 8 || s.block.length > 63 || s.block.length !== s.length % 64) throw new Error('not a SHA-256 state');
    out.h.set(s.h);
    out.block.set(s.block);
    out.fill = s.block.length;
    out.length = s.length;
    return out;
  }

  /** The 32-byte digest. Once only: the state is spent. */
  digest(): Uint8Array {
    if (this.finished) throw new Error('this SHA-256 has already given its digest');
    this.finished = true;
    const bits = this.length * 8;
    const tail = new Uint8Array(this.fill < 56 ? 64 : 128);
    tail.set(this.block.subarray(0, this.fill));
    tail[this.fill] = 0x80;
    const v = new DataView(tail.buffer);
    v.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
    v.setUint32(tail.length - 4, bits >>> 0);
    for (let at = 0; at < tail.length; at += 64) this.compress(tail, at);
    const out = new Uint8Array(32);
    const o = new DataView(out.buffer);
    for (let k = 0; k < 8; k += 1) o.setInt32(k * 4, this.h[k]!);
    return out;
  }

  private compress(d: Uint8Array, at: number): void {
    const w = this.w;
    const h = this.h;
    for (let t = 0; t < 16; t += 1) {
      const j = at + t * 4;
      w[t] = (d[j]! << 24) | (d[j + 1]! << 16) | (d[j + 2]! << 8) | d[j + 3]!;
    }
    for (let t = 16; t < 64; t += 1) {
      const x = w[t - 15]!;
      const y = w[t - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) | 0;
    }
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let dd = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;
    for (let t = 0; t < 64; t += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[t]! + w[t]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (dd + t1) | 0;
      dd = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0]! + a) | 0;
    h[1] = (h[1]! + b) | 0;
    h[2] = (h[2]! + c) | 0;
    h[3] = (h[3]! + dd) | 0;
    h[4] = (h[4]! + e) | 0;
    h[5] = (h[5]! + f) | 0;
    h[6] = (h[6]! + g) | 0;
    h[7] = (h[7]! + hh) | 0;
  }
}

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
