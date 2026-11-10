package com.minimalistalliance.desk.deskd.rpc;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.LongSupplier;

/**
 * Mutation results by idempotency key (design 4.2.5). Keys belong to one user and one method. A
 * result is kept 10 minutes from when it finished, on the desk rather than on a session, so it
 * outlives the 2 minute resume window and survives a client that had to start a fresh session.
 *
 * <p>The store is bounded by count and by bytes. Past either bound the oldest finished results go
 * first, so under sustained load a very late retry could run again; optimistic concurrency
 * ({@code p.rowVersion}) is what catches that. Calls still running are never evicted. Expired
 * entries go when something next touches the store, so there's no timer.
 */
final class IdempotencyStore {

    static final long DEFAULT_TTL_NANOS = 10L * 60 * 1_000_000_000L;
    static final int DEFAULT_MAX_ENTRIES = 4096;
    /** Room for 8 replies at the 1 MiB limit, and far more of the usual small ones. */
    static final long DEFAULT_MAX_BYTES = 8L * 1024 * 1024;

    /** A finished call, as it went on the wire. */
    record Stored(boolean error, byte[] payload) {}

    /** The caller owns the call: it runs the handler, then finishes or abandons the claim. */
    final class Claim {
        private final String key;
        private final Entry entry;
        private final boolean owner;

        private Claim(String key, Entry entry, boolean owner) {
            this.key = key;
            this.entry = entry;
            this.owner = owner;
        }

        boolean isOwner() {
            return owner;
        }

        /** Stores the outcome and wakes anyone waiting on the same key. */
        void finish(Stored stored) {
            lock.lock();
            try {
                entry.finishedAtNanos = nanoTime.getAsLong();
                entry.stored = stored;
                if (entries.get(key) == entry) {
                    bytes += stored.payload().length;
                    evict();
                }
            } finally {
                lock.unlock();
            }
            entry.done.complete(stored);
        }

        /** The handler stopped without applying anything, so a retry should run it again. */
        void abandon() {
            lock.lock();
            try {
                entries.remove(key, entry);
            } finally {
                lock.unlock();
            }
            entry.done.complete(null);
        }

        /**
         * Waits for the owner, for a claim that isn't the owner.
         *
         * @return the stored result, or null if the owner gave up and the caller should claim again
         */
        Stored await() throws InterruptedException {
            try {
                return entry.done.get();
            } catch (ExecutionException e) {
                return null;
            }
        }
    }

    private static final class Entry {
        final CompletableFuture<Stored> done = new CompletableFuture<>();
        Stored stored;
        long finishedAtNanos;
    }

    private final ReentrantLock lock = new ReentrantLock();
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private final LongSupplier nanoTime;
    private final long ttlNanos;
    private final int maxEntries;
    private final long maxBytes;
    private long bytes;

    IdempotencyStore(LongSupplier nanoTime, long ttlNanos, int maxEntries, long maxBytes) {
        this.nanoTime = nanoTime;
        this.ttlNanos = ttlNanos;
        this.maxEntries = maxEntries;
        this.maxBytes = maxBytes;
    }

    Claim claim(String sub, String method, String idem) {
        String key = sub + '\0' + method + '\0' + idem;
        lock.lock();
        try {
            purgeExpired();
            Entry existing = entries.get(key);
            if (existing != null) {
                return new Claim(key, existing, false);
            }
            Entry entry = new Entry();
            entries.put(key, entry);
            return new Claim(key, entry, true);
        } finally {
            lock.unlock();
        }
    }

    int size() {
        lock.lock();
        try {
            return entries.size();
        } finally {
            lock.unlock();
        }
    }

    long storedBytes() {
        lock.lock();
        try {
            return bytes;
        } finally {
            lock.unlock();
        }
    }

    private void purgeExpired() {
        long now = nanoTime.getAsLong();
        Iterator<Entry> iterator = entries.values().iterator();
        while (iterator.hasNext()) {
            Entry entry = iterator.next();
            if (entry.stored != null && now - entry.finishedAtNanos >= ttlNanos) {
                bytes -= entry.stored.payload().length;
                iterator.remove();
            }
        }
    }

    private void evict() {
        Iterator<Entry> iterator = entries.values().iterator();
        while ((entries.size() > maxEntries || bytes > maxBytes) && iterator.hasNext()) {
            Entry entry = iterator.next();
            if (entry.stored != null) {
                bytes -= entry.stored.payload().length;
                iterator.remove();
            }
        }
    }
}
