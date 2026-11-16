package com.minimalistalliance.desk.courier.envelope;

import java.security.SecureRandom;
import org.bouncycastle.crypto.AsymmetricCipherKeyPair;
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters;
import org.bouncycastle.crypto.params.X25519PublicKeyParameters;

/** A box key with its private half: an X25519 scalar, which opens what was sealed to the {@link BoxKey}. Never leaves the desk. */
public final class BoxKeyPair {

    public static final int SECRET_BYTES = 32;

    private final X25519PrivateKeyParameters secret;
    private final BoxKey publicKey;
    private final long createdAt;

    private BoxKeyPair(X25519PrivateKeyParameters secret, long createdAt) {
        this.secret = secret;
        this.createdAt = createdAt;
        try {
            this.publicKey = BoxKey.of(secret.generatePublicKey().getEncoded());
        } catch (EnvelopeException e) {
            throw new IllegalStateException("a generated X25519 key didn't validate", e);
        }
    }

    public static BoxKeyPair generate(SecureRandom random, long createdAt) {
        return new BoxKeyPair(new X25519PrivateKeyParameters(random), createdAt);
    }

    /** From the scalar the key store kept. The caller zeroes its array. */
    public static BoxKeyPair fromSecret(byte[] secret, long createdAt) {
        if (secret == null || secret.length != SECRET_BYTES) {
            throw new IllegalArgumentException("an X25519 private key is 32 bytes");
        }
        return new BoxKeyPair(new X25519PrivateKeyParameters(secret, 0), createdAt);
    }

    public BoxKey publicKey() {
        return publicKey;
    }

    /** When the desk made it, in epoch milliseconds: the newest is the one senders seal to. */
    public long createdAt() {
        return createdAt;
    }

    /** The scalar, for the key store to write. The caller zeroes it. */
    public byte[] secret() {
        return secret.getEncoded();
    }

    AsymmetricCipherKeyPair forHpke() {
        return new AsymmetricCipherKeyPair(new X25519PublicKeyParameters(publicKey.bytes(), 0), secret);
    }

    @Override
    public String toString() {
        return "BoxKeyPair[" + publicKey + "]";
    }
}
