// The tab's DTLS identity (design 4.2.2): one ECDSA P-256 certificate per tab, in memory, 24 h. Its
// fingerprint is read from a real offer's SDP, which is the form the desk will compare.
import { clientFingerprintFromOffer } from './sdp';

const LIFETIME_MS = 24 * 60 * 60 * 1000;
const RENEW_BEFORE_MS = 60 * 60 * 1000;

export interface TabIdentity {
  certificate: RTCCertificate;
  /** `clientDtlsFingerprint`: "sha-256 AA:BB:…". */
  fingerprint: string;
}

async function make(): Promise<TabIdentity> {
  const certificate = await RTCPeerConnection.generateCertificate({
    name: 'ECDSA',
    namedCurve: 'P-256',
    expires: LIFETIME_MS,
  } as AlgorithmIdentifier);
  const scratch = new RTCPeerConnection({ certificates: [certificate] });
  try {
    scratch.createDataChannel('fingerprint');
    const offer = await scratch.createOffer();
    return { certificate, fingerprint: clientFingerprintFromOffer(offer.sdp ?? '') };
  } finally {
    scratch.close();
  }
}

let current: Promise<TabIdentity> | null = null;

export async function tabIdentity(): Promise<TabIdentity> {
  if (current) {
    const held = await current;
    if (held.certificate.expires - Date.now() > RENEW_BEFORE_MS) return held;
    current = null;
  }
  current ??= make().catch((err: unknown) => {
    current = null;
    throw err;
  });
  return current;
}
