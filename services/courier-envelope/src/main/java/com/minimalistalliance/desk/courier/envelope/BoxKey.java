package com.minimalistalliance.desk.courier.envelope;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Arrays;
import org.bouncycastle.math.ec.rfc7748.X25519;

/**
 * A desk's public box key: X25519 (RFC 7748), 32 bytes, contract 0.4.0's {@code boxKey}: what senders seal to with
 * HPKE. It rotates under the same identity, each one bound to the desk's {@link IdentityKey} by a signature
 * ({@link PublishedKeys}). Envelopes don't name the box key they were sealed to (contract 0.4.0's outer shape has no key
 * id), so a desk tries its current key, then the retired ones it still keeps. {@link #id()} names a key in the desk's
 * own files and logs; it never goes on the wire.
 */
public final class BoxKey {

    public static final int BYTES = 32;
    public static final int ID_BYTES = 16;

    private static final byte[] ID_TAG = "ma-courier/v1 box key id\0".getBytes(StandardCharsets.US_ASCII);
    private static final SecureRandom RANDOM = new SecureRandom();

    private final byte[] key;
    private final byte[] id;

    private BoxKey(byte[] key) {
        this.key = key;
        this.id = Arrays.copyOf(IdentityKey.digest("SHA-256", ID_TAG, key), ID_BYTES);
    }

    /**
     * @throws EnvelopeException {@code format} unless it's 32 bytes and not a low-order point, whose shared secrets would be
     *     all zeros (RFC 7748 §6.1; RFC 9180 §7.1.4 aborts on it too)
     */
    public static BoxKey of(byte[] key) throws EnvelopeException {
        if (key == null || key.length != BYTES || !contributory(key)) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "not an X25519 public key");
        }
        return new BoxKey(key.clone());
    }

    public static BoxKey parse(Object text) throws EnvelopeException {
        return of(B64.decode(text, BYTES));
    }

    /** A trial agreement with a random scalar: false for the points whose every shared secret is zero. */
    private static boolean contributory(byte[] key) {
        byte[] scalar = new byte[X25519.SCALAR_SIZE];
        byte[] out = new byte[X25519.POINT_SIZE];
        RANDOM.nextBytes(scalar);
        try {
            return X25519.calculateAgreement(scalar, 0, key, 0, out, 0);
        } finally {
            Arrays.fill(scalar, (byte) 0);
            Arrays.fill(out, (byte) 0);
        }
    }

    public byte[] bytes() {
        return key.clone();
    }

    public String text() {
        return B64.encode(key);
    }

    /** The first 16 bytes of SHA-256 over a tag and the key. Not secret; it says which key, nothing else. */
    public byte[] id() {
        return id.clone();
    }

    public String idText() {
        return B64.encode(id);
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof BoxKey other && Arrays.equals(key, other.key);
    }

    @Override
    public int hashCode() {
        return Arrays.hashCode(key);
    }

    @Override
    public String toString() {
        return "BoxKey[" + idText() + "]";
    }
}
