package com.minimalistalliance.desk.deskd.auth;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;

/**
 * The jti of every token accepted, kept until the token can't verify anyway. Expired entries go as
 * new ones arrive, so there's no timer.
 */
final class ReplayCache {

    /** Far above what 4 sessions refreshing every 4 minutes need. Past it, tokens are refused. */
    static final int MAX_ENTRIES = 1024;

    private final ReentrantLock lock = new ReentrantLock();
    private final Map<String, Instant> seen = new HashMap<>();

    /** @return true if this jti is new, which also records it */
    boolean claim(String jti, Instant usableUntil, Instant now) {
        lock.lock();
        try {
            seen.values().removeIf(until -> !now.isBefore(until));
            if (seen.size() >= MAX_ENTRIES || seen.containsKey(jti)) {
                return false;
            }
            seen.put(jti, usableUntil);
            return true;
        } finally {
            lock.unlock();
        }
    }
}
