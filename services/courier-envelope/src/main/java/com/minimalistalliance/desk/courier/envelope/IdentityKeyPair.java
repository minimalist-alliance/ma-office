package com.minimalistalliance.desk.courier.envelope;

import java.security.SecureRandom;
import java.util.Arrays;
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;

/**
 * A desk's identity key with its private half: an Ed25519 seed. It never leaves the desk. Only the desk's key store makes
 * or loads one, and only {@link Envelope} and {@link KeyBundle} sign with it.
 */
public final class IdentityKeyPair {

    public static final int SEED_BYTES = 32;

    private final Ed25519PrivateKeyParameters secret;
    private final IdentityKey publicKey;

    private IdentityKeyPair(Ed25519PrivateKeyParameters secret) {
        this.secret = secret;
        try {
            this.publicKey = IdentityKey.of(secret.generatePublicKey().getEncoded());
        } catch (EnvelopeException e) {
            throw new IllegalStateException("a generated Ed25519 key didn't validate", e);
        }
    }

    public static IdentityKeyPair generate(SecureRandom random) {
        return new IdentityKeyPair(new Ed25519PrivateKeyParameters(random));
    }

    /** From a seed the key store kept. The caller zeroes its array; this keeps its own copy. */
    public static IdentityKeyPair fromSeed(byte[] seed) {
        if (seed == null || seed.length != SEED_BYTES) {
            throw new IllegalArgumentException("an Ed25519 seed is 32 bytes");
        }
        return new IdentityKeyPair(new Ed25519PrivateKeyParameters(seed, 0));
    }

    public IdentityKey publicKey() {
        return publicKey;
    }

    /** The seed, for the key store to write. The caller zeroes it. */
    public byte[] seed() {
        return secret.getEncoded();
    }

    /** Ed25519 over {@code message} (deterministic, RFC 8032). */
    public byte[] sign(byte[] message) {
        Ed25519Signer signer = new Ed25519Signer();
        signer.init(true, secret);
        signer.update(message, 0, message.length);
        return signer.generateSignature();
    }

    @Override
    public String toString() {
        return "IdentityKeyPair[" + publicKey + "]";
    }

    static void zero(byte[] bytes) {
        if (bytes != null) {
            Arrays.fill(bytes, (byte) 0);
        }
    }
}
