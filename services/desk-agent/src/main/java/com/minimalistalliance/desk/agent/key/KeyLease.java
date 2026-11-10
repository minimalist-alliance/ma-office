package com.minimalistalliance.desk.agent.key;

import com.minimalistalliance.desk.agent.provider.ProviderId;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/**
 * A key lent for one call: a heap copy of its bytes, zeroed when the lease closes. Use it in try-with-resources and
 * don't keep what it returns.
 *
 * <p>{@link #headerValue} is the one place a key becomes a {@code String}, because the JDK's {@code HttpClient} takes
 * header values only as strings. That string can't be zeroed: it stays in the heap, unreachable, until the
 * collector reuses its memory, and the client copies it again into its own buffers on the way to TLS. README.md,
 * "Keys", lists what the JVM allows here and what it doesn't.
 */
public final class KeyLease implements AutoCloseable {

    private final String keyId;
    private final ProviderId provider;
    private final byte[] ascii;
    private boolean closed;

    KeyLease(String keyId, ProviderId provider, byte[] ascii) {
        this.keyId = keyId;
        this.provider = provider;
        this.ascii = ascii;
    }

    public String keyId() {
        return keyId;
    }

    public ProviderId provider() {
        return provider;
    }

    /**
     * The key's ASCII bytes, this lease's own array, for a caller that can write bytes (a hash, a raw socket). Zeroed
     * when the lease closes.
     */
    public byte[] bytes() {
        if (closed) {
            throw new IllegalStateException("lease closed");
        }
        return ascii;
    }

    /** {@code prefix} and the key as one string, such as {@code "Bearer " + key}: see the class comment. */
    public String headerValue(String prefix) {
        return prefix + new String(bytes(), StandardCharsets.US_ASCII);
    }

    @Override
    public void close() {
        Arrays.fill(ascii, (byte) 0);
        closed = true;
    }

    @Override
    public String toString() {
        return "KeyLease[" + keyId + ", " + provider + "]";
    }
}
