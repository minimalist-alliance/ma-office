package com.minimalistalliance.desk.courier.envelope;

import java.util.Base64;

/** Base64url without padding, the only text form keys, digests and signatures take here. Decoding is strict. */
final class B64 {

    private static final Base64.Encoder ENCODER = Base64.getUrlEncoder().withoutPadding();
    private static final Base64.Decoder DECODER = Base64.getUrlDecoder();

    private B64() {}

    static String encode(byte[] bytes) {
        return ENCODER.encodeToString(bytes);
    }

    /** Decodes 1 to {@code max} bytes, refusing padding, other alphabets and non-canonical trailing bits. */
    static byte[] decodeUpTo(Object text, int max) throws EnvelopeException {
        if (!(text instanceof String s) || s.isEmpty() || s.length() > 4L * max / 3 + 3 || s.indexOf('=') >= 0) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "not base64url in range");
        }
        byte[] bytes;
        try {
            bytes = DECODER.decode(s);
        } catch (IllegalArgumentException e) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "not base64url");
        }
        if (bytes.length == 0 || bytes.length > max || !ENCODER.encodeToString(bytes).equals(s)) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "not base64url in range");
        }
        return bytes;
    }

    /**
     * Decodes exactly {@code length} bytes, refusing padding, other alphabets and non-canonical trailing bits, so each
     * value has one text form.
     */
    static byte[] decode(Object text, int length) throws EnvelopeException {
        if (!(text instanceof String s) || s.isEmpty() || s.length() > 4 * length / 3 + 3 || s.indexOf('=') >= 0) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "not base64url");
        }
        byte[] bytes;
        try {
            bytes = DECODER.decode(s);
        } catch (IllegalArgumentException e) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "not base64url");
        }
        if (bytes.length != length || !ENCODER.encodeToString(bytes).equals(s)) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "not base64url of the right length");
        }
        return bytes;
    }
}
