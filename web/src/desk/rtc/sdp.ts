// `a=fingerprint` handling. Three formats meet here: SDP uses colon-separated hex, `connect` takes
// "sha-256 " plus that, and `deskIdentity` is 64 lowercase hex chars. Everyone decodes to bytes
// before comparing (docs/interfaces/desk-runtime.md section 4.4).

const SHA256_BYTES = 32;

export interface SdpFingerprint {
  algorithm: string;
  value: string;
}

/** Every `a=fingerprint` line. Chrome repeats it per section and Firefox writes one at session level. */
export function sdpFingerprints(sdp: string): SdpFingerprint[] {
  const found: SdpFingerprint[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.toLowerCase().startsWith('a=fingerprint:')) continue;
    const [algorithm = '', value = ''] = line.slice('a=fingerprint:'.length).trim().split(/\s+/);
    found.push({ algorithm: algorithm.toLowerCase(), value });
  }
  return found;
}

/** Hex, with or without colons, to bytes. Null when it isn't exactly a SHA-256 digest. */
export function sha256Bytes(hex: string): Uint8Array | null {
  const clean = hex.replaceAll(':', '');
  if (clean.length !== SHA256_BYTES * 2 || !/^[0-9a-fA-F]+$/.test(clean)) return null;
  const out = new Uint8Array(SHA256_BYTES);
  for (let i = 0; i < SHA256_BYTES; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** `clientDtlsFingerprint` for `connect` (contract auth.md section 4.1), from a local offer. */
export function clientFingerprintFromOffer(offerSdp: string): string {
  const fps = sdpFingerprints(offerSdp);
  const first = fps[0];
  if (!first) throw new Error('the local offer has no a=fingerprint');
  if (first.algorithm !== 'sha-256' || !sha256Bytes(first.value)) throw new Error(`the local offer's a=fingerprint isn't SHA-256: ${first.algorithm}`);
  return `sha-256 ${first.value.toUpperCase()}`;
}

/** Design 4.2.2 step 5: every line is SHA-256 and one of the desk's registered fingerprints. */
export function answerMatchesIdentity(answerSdp: string, identity: readonly string[]): boolean {
  const known = identity.map(sha256Bytes).filter((b): b is Uint8Array => b !== null);
  const lines = sdpFingerprints(answerSdp);
  if (!lines.length) return false;
  return lines.every((line) => {
    const got = line.algorithm === 'sha-256' ? sha256Bytes(line.value) : null;
    return got !== null && known.some((k) => sameBytes(k, got));
  });
}

/** The desk answers `m=video 0` to an offer with no constrained-baseline H.264 (desk-runtime.md 8.5). */
export function answerRefusesVideo(answerSdp: string): boolean {
  return /^m=video 0 /m.test(answerSdp);
}
