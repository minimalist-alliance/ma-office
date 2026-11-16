package com.minimalistalliance.desk.courier.envelope;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;
import org.bouncycastle.math.ec.rfc8032.Ed25519;

/**
 * A desk's public identity key: Ed25519 (RFC 8032), 32 bytes, contract 0.4.0's {@code identityKey}. It signs every
 * envelope the desk sends and the binding of its box key. It's what contacts pin and what a {@link SafetyNumber} is made
 * from, so it stays the same while the box key rotates under it. Only a reset (or a lost key) changes it, and then every
 * contact sees "key changed".
 */
public final class IdentityKey {

    public static final int BYTES = 32;
    public static final int SIGNATURE_BYTES = 64;

    private final byte[] key;

    private IdentityKey(byte[] key) {
        this.key = key;
    }

    /**
     * @throws EnvelopeException {@code format} unless it's 32 bytes encoding a point of the prime-order subgroup: no small
     *     or mixed order key, so no signature can verify under more than one message by a key's construction
     */
    public static IdentityKey of(byte[] key) throws EnvelopeException {
        if (key == null || key.length != BYTES || !Ed25519.validatePublicKeyFull(key, 0)) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "not an Ed25519 public key");
        }
        return new IdentityKey(key.clone());
    }

    /** From its base64url text. */
    public static IdentityKey parse(Object text) throws EnvelopeException {
        return of(B64.decode(text, BYTES));
    }

    public byte[] bytes() {
        return key.clone();
    }

    public String text() {
        return B64.encode(key);
    }

    /** Whether {@code signature} is this key's Ed25519 signature over {@code message}. */
    public boolean verifies(byte[] message, byte[] signature) {
        if (signature == null || signature.length != SIGNATURE_BYTES) {
            return false;
        }
        Ed25519Signer verifier = new Ed25519Signer();
        verifier.init(false, new Ed25519PublicKeyParameters(key, 0));
        verifier.update(message, 0, message.length);
        return verifier.verifySignature(signature);
    }

    static byte[] digest(String algorithm, byte[]... parts) {
        try {
            MessageDigest d = MessageDigest.getInstance(algorithm);
            for (byte[] part : parts) {
                d.update(part);
            }
            return d.digest();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof IdentityKey other && Arrays.equals(key, other.key);
    }

    @Override
    public int hashCode() {
        return Arrays.hashCode(key);
    }

    @Override
    public String toString() {
        return "IdentityKey[" + text().substring(0, 8) + "]";
    }
}
