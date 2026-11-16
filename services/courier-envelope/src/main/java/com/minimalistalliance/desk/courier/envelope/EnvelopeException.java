package com.minimalistalliance.desk.courier.envelope;

/**
 * Why an envelope, a key bundle or a body couldn't be sealed or opened. {@link #reason()} is a short code a transport can
 * log, count and act on; the message never holds key material or content.
 */
public final class EnvelopeException extends Exception {

    /** The bytes aren't an envelope of this version: magic, suite, sizes, padding, the inner layout or the header. */
    public static final String FORMAT = "format";
    /** No box key of this desk has the envelope's key id: never ours, or retired and deleted. */
    public static final String UNKNOWN_KEY = "unknown_key";
    /** HPKE didn't open it: changed in transit, or sealed to another key. */
    public static final String CANNOT_OPEN = "cannot_open";
    /** It opened, but its signed header names another desk's identity as the recipient. */
    public static final String NOT_FOR_ME = "not_for_me";
    /** The sender's signature over the header doesn't verify under the identity key the header names. */
    public static final String BAD_SIGNATURE = "bad_signature";
    /** The body isn't the one the signed header describes: its length, digest or padding. */
    public static final String BODY_MISMATCH = "body_mismatch";
    /** The ciphertext drop ended early, ran long, or a chunk came out of order. */
    public static final String TRUNCATED = "truncated";
    /** Over a limit: the body, the header or the envelope. */
    public static final String TOO_LARGE = "too_large";
    /** The recipient's key bundle isn't valid: its signature, its box key, or its dates. */
    public static final String RECIPIENT_KEY = "recipient_key";

    private final String reason;

    public EnvelopeException(String reason, String message) {
        super(message);
        this.reason = reason;
    }

    public String reason() {
        return reason;
    }
}
