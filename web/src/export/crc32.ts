// CRC-32 (ISO 3309, the one ZIP uses), slicing by 8. Incremental: the running value is all the state there is, so
// a resumed file carries on from it.
const T = (() => {
  const t = new Uint32Array(8 * 256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  for (let s = 1; s < 8; s += 1) {
    for (let i = 0; i < 256; i += 1) {
      const prev = t[(s - 1) * 256 + i]!;
      t[s * 256 + i] = (prev >>> 8) ^ t[prev & 0xff]!;
    }
  }
  return t;
})();

/** The CRC of everything so far followed by `data`. Start from 0. */
export function crc32(crc: number, data: Uint8Array): number {
  let c = ~crc;
  let i = 0;
  const n = data.length;
  for (; i + 8 <= n; i += 8) {
    const a = c ^ (data[i]! | (data[i + 1]! << 8) | (data[i + 2]! << 16) | (data[i + 3]! << 24));
    c =
      T[1792 + (a & 0xff)]! ^
      T[1536 + ((a >>> 8) & 0xff)]! ^
      T[1280 + ((a >>> 16) & 0xff)]! ^
      T[1024 + (a >>> 24)]! ^
      T[768 + data[i + 4]!]! ^
      T[512 + data[i + 5]!]! ^
      T[256 + data[i + 6]!]! ^
      T[data[i + 7]!]!;
  }
  for (; i < n; i += 1) c = T[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}
