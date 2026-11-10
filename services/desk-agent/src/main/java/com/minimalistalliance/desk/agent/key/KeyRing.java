package com.minimalistalliance.desk.agent.key;

import com.minimalistalliance.desk.agent.provider.ProviderId;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The plaintext provider keys desk-agent holds in RAM while it runs. On disk they exist only sealed, in {@link
 * KeyVault} (ADR 0042), which is what brings them back at a start.
 *
 * <p>Each key sits in a direct buffer of its own: native memory the collector never moves, so there's exactly one
 * copy in RAM at rest, and {@link #drop} zeroes it. A key comes in as bytes, never as a {@code String}, and the
 * caller's array is zeroed as soon as it's copied, accepted or not. Calls borrow a heap copy through {@link #lend},
 * zeroed when the lease closes. Nothing here logs or prints a key, and {@code toString} shows ids only.
 *
 * <p>Adding a key is recorded first and refused if it can't be (design 9.11 audits key add, use and delete). A
 * drop is never refused: the key is zeroed, then the drop is recorded if it can be.
 */
public final class KeyRing implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(KeyRing.class);

    /** Where key events are recorded: the audit log, on a desk. Gets ids and counts, never a key. */
    @FunctionalInterface
    public interface Recorder {
        void record(String action, String target, String decision) throws Exception;
    }

    /** What a key id looks like: Platform's {@code KeyId}, or a test's. Never the key. */
    private static final Pattern KEY_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9_-]{0,63}");
    static final int MIN_BYTES = 8;
    static final int MAX_BYTES = 1024;

    private record Held(ProviderId provider, ByteBuffer secret) {}

    private final ReentrantLock lock = new ReentrantLock();
    private final Map<String, Held> keys = new HashMap<>();
    private final Recorder recorder;

    public KeyRing(Recorder recorder) {
        this.recorder = recorder;
    }

    static boolean validKeyId(String keyId) {
        return KEY_ID.matcher(keyId).matches();
    }

    /**
     * Keeps a key, replacing (and zeroing) any held under the same id. {@code secret} is zeroed before this returns,
     * whatever happens.
     *
     * @throws IllegalArgumentException if the id is malformed, or the key isn't 8 to 1024 printable ASCII
     *     characters with no space: it goes into an HTTP header, so a CR or LF could add one
     * @throws IllegalStateException if the addition can't be recorded, in which case it isn't kept
     */
    public void put(String keyId, ProviderId provider, byte[] secret) {
        try {
            check(keyId, secret);
            try {
                recorder.record("key.add", "key:" + keyId, "provider:" + provider.id());
            } catch (Exception e) {
                throw new IllegalStateException("can't record the key", null);
            }
            hold(keyId, provider, secret);
        } finally {
            Arrays.fill(secret, (byte) 0);
        }
    }

    /**
     * Puts back a key {@link KeyVault} kept, at a start. Like {@link #put(String, ProviderId, byte[])}, with the same
     * checks, and {@code secret} is zeroed before this returns, whatever happens. It writes no {@code key.add} row: the
     * member added this key earlier, and the start records one {@code key.restore} for all of them.
     *
     * @throws IllegalArgumentException if the id or the key isn't one {@link #put(String, ProviderId, byte[])} takes
     */
    public void restore(String keyId, ProviderId provider, byte[] secret) {
        try {
            check(keyId, secret);
            hold(keyId, provider, secret);
        } finally {
            Arrays.fill(secret, (byte) 0);
        }
    }

    private static void check(String keyId, byte[] secret) {
        if (!validKeyId(keyId)) {
            throw new IllegalArgumentException("bad key id");
        }
        if (secret.length < MIN_BYTES || secret.length > MAX_BYTES) {
            throw new IllegalArgumentException("a key is 8 to 1024 characters");
        }
        for (byte b : secret) {
            if (b < 0x21 || b > 0x7e) {
                throw new IllegalArgumentException("a key is printable ASCII with no spaces");
            }
        }
    }

    private void hold(String keyId, ProviderId provider, byte[] secret) {
        ByteBuffer held = ByteBuffer.allocateDirect(secret.length);
        held.put(0, secret);
        Held previous;
        lock.lock();
        try {
            previous = keys.put(keyId, new Held(provider, held));
        } finally {
            lock.unlock();
        }
        if (previous != null) {
            zero(previous.secret());
        }
    }

    /**
     * {@link #put(String, ProviderId, byte[])} from a direct buffer, as the agent socket reads a key: from {@code
     * secret}'s position to its limit, with no heap copy. The buffer's bytes are zeroed before this returns.
     */
    public void put(String keyId, ProviderId provider, ByteBuffer secret) {
        int start = secret.position();
        int length = secret.remaining();
        try {
            if (!validKeyId(keyId)) {
                throw new IllegalArgumentException("bad key id");
            }
            if (!wellFormed(secret)) {
                throw new IllegalArgumentException("a key is 8 to 1024 printable ASCII characters with no space");
            }
            try {
                recorder.record("key.add", "key:" + keyId, "provider:" + provider.id());
            } catch (Exception e) {
                throw new IllegalStateException("can't record the key", null);
            }
            ByteBuffer held = ByteBuffer.allocateDirect(length);
            held.put(0, secret, start, length);
            Held previous;
            lock.lock();
            try {
                previous = keys.put(keyId, new Held(provider, held));
            } finally {
                lock.unlock();
            }
            if (previous != null) {
                zero(previous.secret());
            }
        } finally {
            for (int i = 0; i < length; i++) {
                secret.put(start + i, (byte) 0);
            }
        }
    }

    /**
     * Whether the bytes from {@code secret}'s position to its limit have a key's shape, which {@link #put} requires: 8 to
     * 1024 printable ASCII characters with no space. Read in place, and left as they are.
     */
    public static boolean wellFormed(ByteBuffer secret) {
        int start = secret.position();
        int length = secret.remaining();
        if (length < MIN_BYTES || length > MAX_BYTES) {
            return false;
        }
        for (int i = 0; i < length; i++) {
            byte b = secret.get(start + i);
            if (b < 0x21 || b > 0x7e) {
                return false;
            }
        }
        return true;
    }

    /** @return whether a key was held under that id, in which case it's zeroed and recorded */
    public boolean drop(String keyId) {
        Held dropped;
        lock.lock();
        try {
            dropped = keys.remove(keyId);
        } finally {
            lock.unlock();
        }
        if (dropped == null) {
            return false;
        }
        zero(dropped.secret());
        recordQuietly("key:" + keyId, "zeroed");
        return true;
    }

    /** Zeroes and forgets every key held in RAM, on shutdown. What's sealed stays, for the next start. */
    public int dropAll() {
        Map<String, Held> all;
        lock.lock();
        try {
            all = new HashMap<>(keys);
            keys.clear();
        } finally {
            lock.unlock();
        }
        all.values().forEach(held -> zero(held.secret()));
        if (!all.isEmpty()) {
            recordQuietly("keys:all", "zeroed:" + all.size());
        }
        return all.size();
    }

    private void recordQuietly(String target, String decision) {
        try {
            recorder.record("key.drop", target, decision);
        } catch (Exception e) {
            log.warn("a key drop wasn't recorded: {}", e.getClass().getSimpleName());
        }
    }

    /** @return a lease on a copy of the key, or null if none is held under that id */
    public KeyLease lend(String keyId) {
        lock.lock();
        try {
            Held held = keys.get(keyId);
            if (held == null) {
                return null;
            }
            byte[] copy = new byte[held.secret().capacity()];
            held.secret().get(0, copy);
            return new KeyLease(keyId, held.provider(), copy);
        } finally {
            lock.unlock();
        }
    }

    /** @return the provider of the key under that id, or null */
    public ProviderId providerOf(String keyId) {
        lock.lock();
        try {
            Held held = keys.get(keyId);
            return held == null ? null : held.provider();
        } finally {
            lock.unlock();
        }
    }

    public int size() {
        lock.lock();
        try {
            return keys.size();
        } finally {
            lock.unlock();
        }
    }

    /** For tests: the buffer a key is held in, to check it's zeroed after a drop. */
    ByteBuffer heldBuffer(String keyId) {
        lock.lock();
        try {
            Held held = keys.get(keyId);
            return held == null ? null : held.secret();
        } finally {
            lock.unlock();
        }
    }

    private static void zero(ByteBuffer buffer) {
        for (int i = 0; i < buffer.capacity(); i++) {
            buffer.put(i, (byte) 0);
        }
    }

    @Override
    public void close() {
        dropAll();
    }

    @Override
    public String toString() {
        return "KeyRing[" + size() + " keys]";
    }
}
