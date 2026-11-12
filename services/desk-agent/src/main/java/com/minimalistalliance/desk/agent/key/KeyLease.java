package com.minimalistalliance.desk.agent.key;

import com.minimalistalliance.desk.agent.provider.ProviderId;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/**
 * A key lent for one call: a heap copy of its bytes, zeroed when the lease closes. Use it in try-with-resources and
 * don't keep what it returns.
 *
 * <p>{@link #headerValue} is the one place a key becomes a {@code String}, because the JDK's {@code HttpClient} takes
 * header values only as strings. That string can't be zeroed: the request holds it for the call, then it stays in the
 * heap, unreachable, until the collector reuses its memory, and the client copies it again into its own buffers on the
 * way to TLS. README.md, "Keys", lists what the JVM allows here and what it doesn't.
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

    /**
     * {@code prefix} and the key as one string, such as {@code "Bearer " + key}: see the class comment. It's joined as
     * bytes in an array zeroed here, so the one {@code String} that comes back is the only copy this makes that can't be
     * zeroed. Concatenating would make two: the key's own string, then the joined one (ISS-20).
     */
    public String headerValue(String prefix) {
        byte[] key = bytes();
        byte[] head = prefix.getBytes(StandardCharsets.US_ASCII);
        byte[] joined = new byte[head.length + key.length];
        try {
            System.arraycopy(head, 0, joined, 0, head.length);
            System.arraycopy(key, 0, joined, head.length, key.length);
            return new String(joined, StandardCharsets.US_ASCII);
        } finally {
            Arrays.fill(joined, (byte) 0);
        }
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
