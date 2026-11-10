import { describe, expect, it } from 'vitest';
import { answerMatchesIdentity, clientFingerprintFromOffer, sdpFingerprints, sha256Bytes } from './sdp';

const LOWER = 'f1d7a164dc82e7751dca45a9eea1ac23a3a30e548f77457a88289e2d1be45bc2';
const COLON = LOWER.toUpperCase().match(/../g)!.join(':');
const OTHER = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const OTHER_COLON = OTHER.toUpperCase().match(/../g)!.join(':');

const sdp = (...lines: string[]) => ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', ...lines, ''].join('\r\n');

describe('sdpFingerprints', () => {
  it('finds a line in each section, on CRLF or LF', () => {
    expect(sdpFingerprints(sdp(`a=fingerprint:sha-256 ${COLON}`, 'm=audio 9', `a=fingerprint:sha-256 ${COLON}`))).toHaveLength(2);
    expect(sdpFingerprints(`a=fingerprint:SHA-256 ${COLON}\na=ice-lite\n`)).toEqual([{ algorithm: 'sha-256', value: COLON }]);
  });

  it('finds nothing in an SDP without one', () => {
    expect(sdpFingerprints(sdp('m=audio 9'))).toEqual([]);
  });
});

describe('sha256Bytes', () => {
  it('decodes both formats to the same bytes', () => {
    expect(sha256Bytes(COLON)).toEqual(sha256Bytes(LOWER));
  });

  it('refuses anything else', () => {
    expect(sha256Bytes('ab:cd')).toBeNull();
    expect(sha256Bytes('zz'.repeat(32))).toBeNull();
    expect(sha256Bytes('')).toBeNull();
  });
});

describe('clientFingerprintFromOffer', () => {
  it('builds the format connect expects (auth.md 4.1)', () => {
    expect(clientFingerprintFromOffer(sdp(`a=fingerprint:sha-256 ${COLON.toLowerCase()}`))).toBe(`sha-256 ${COLON}`);
  });

  it('refuses a missing or non-SHA-256 fingerprint', () => {
    expect(() => clientFingerprintFromOffer(sdp('m=audio 9'))).toThrow();
    expect(() => clientFingerprintFromOffer(sdp(`a=fingerprint:sha-1 ${COLON}`))).toThrow();
  });
});

describe('answerMatchesIdentity (design 4.2.2 step 5)', () => {
  it('accepts several identical lines, comparing hex with colons against plain hex', () => {
    expect(answerMatchesIdentity(sdp(`a=fingerprint:sha-256 ${COLON}`, 'm=audio 9', `a=fingerprint:sha-256 ${COLON}`, 'm=application 9', `a=fingerprint:sha-256 ${COLON}`), [LOWER])).toBe(true);
  });

  it('accepts either fingerprint during a rotation', () => {
    expect(answerMatchesIdentity(sdp(`a=fingerprint:sha-256 ${OTHER_COLON}`), [LOWER, OTHER])).toBe(true);
  });

  it('ignores case', () => {
    expect(answerMatchesIdentity(sdp(`a=fingerprint:sha-256 ${COLON.toLowerCase()}`), [LOWER.toUpperCase()])).toBe(true);
  });

  it('refuses a fingerprint not in the list', () => {
    expect(answerMatchesIdentity(sdp(`a=fingerprint:sha-256 ${OTHER_COLON}`), [LOWER])).toBe(false);
  });

  it('refuses if any one line differs', () => {
    expect(answerMatchesIdentity(sdp(`a=fingerprint:sha-256 ${COLON}`, 'm=audio 9', `a=fingerprint:sha-256 ${OTHER_COLON}`), [LOWER])).toBe(false);
  });

  it('refuses no line at all, another algorithm, or an empty identity', () => {
    expect(answerMatchesIdentity(sdp('m=audio 9'), [LOWER])).toBe(false);
    expect(answerMatchesIdentity(sdp(`a=fingerprint:sha-1 ${COLON}`), [LOWER])).toBe(false);
    expect(answerMatchesIdentity(sdp(`a=fingerprint:sha-256 ${COLON}`), [])).toBe(false);
  });
});
