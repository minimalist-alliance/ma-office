package com.minimalistalliance.desk.deskd.courier.store;

import java.security.SecureRandom;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Desk-made ids: ULIDs (48 bits of milliseconds, 80 of randomness, Crockford base32, 26 characters), monotonic. Two made
 * in one millisecond, or with a clock that went back, sort in the order they were made, because the time used is never
 * below the last one's and the random part only goes up within it. So {@code (received_at, id)} is a strict order that
 * matches the order messages were stored, which the agent tools' cursor relies on (draft ADR §12).
 */
public final class Ulid {

    private static final char[] ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".toCharArray();
    private static final long MAX_TIME = (1L << 48) - 1;

    private final SecureRandom random = new SecureRandom();
    private final ReentrantLock lock = new ReentrantLock();
    private long lastTime = -1;
    private long hi; // the top 16 of the 80 random bits
    private long lo; // the low 64

    /** A new id for this moment, never below the last one. */
    public String next(long millis) {
        lock.lock();
        try {
            long time = Math.max(Math.min(Math.max(0, millis), MAX_TIME), lastTime);
            if (time == lastTime) {
                lo++;
                if (lo == 0) {
                    hi = (hi + 1) & 0xFFFF;
                    if (hi == 0) {
                        // 2^80 ids in one millisecond: move to the next one rather than wrap.
                        time++;
                    }
                }
            } else {
                hi = random.nextInt(1 << 16);
                lo = random.nextLong();
                // Room to count up within this millisecond without carrying into hi on the first few.
                lo &= 0x7FFF_FFFF_FFFF_FFFFL;
            }
            lastTime = time;
            return encode(time, hi, lo);
        } finally {
            lock.unlock();
        }
    }

    /**
     * Carries on from an id made before (the store's newest, at open), so ids made after a restart sort after it even in
     * the same millisecond.
     */
    public void seed(String id) {
        long time = timeOf(id);
        if (time < 0 || !valid(id)) {
            return;
        }
        long h = 0;
        long l = 0;
        for (int i = 10; i < 26; i++) {
            int v = value(id.charAt(i));
            h = ((h << 5) | (l >>> 59)) & 0xFFFF;
            l = (l << 5) | v;
        }
        lock.lock();
        try {
            if (time > lastTime || (time == lastTime && (Long.compareUnsigned(h, hi) > 0 || (h == hi && Long.compareUnsigned(l, lo) > 0)))) {
                lastTime = time;
                hi = h;
                lo = l;
            }
        } finally {
            lock.unlock();
        }
    }

    /** The time an id was made, or -1 if it isn't one. */
    public static long timeOf(String id) {
        if (id == null || id.length() != 26) {
            return -1;
        }
        long time = 0;
        for (int i = 0; i < 10; i++) {
            int v = value(id.charAt(i));
            if (v < 0) {
                return -1;
            }
            time = (time << 5) | v;
        }
        return time > MAX_TIME ? -1 : time;
    }

    /** True if this is 26 characters of the alphabet, as every id deskd made is. */
    public static boolean valid(String id) {
        if (id == null || id.length() != 26 || value(id.charAt(0)) > 7) {
            return false;
        }
        for (int i = 0; i < 26; i++) {
            if (value(id.charAt(i)) < 0) {
                return false;
            }
        }
        return true;
    }

    private static int value(char c) {
        for (int i = 0; i < ALPHABET.length; i++) {
            if (ALPHABET[i] == c) {
                return i;
            }
        }
        return -1;
    }

    static String encode(long time, long hi, long lo) {
        char[] out = new char[26];
        // 48 bits of time in 10 characters (the first holds 3 bits).
        long t = time;
        for (int i = 9; i >= 0; i--) {
            out[i] = ALPHABET[(int) (t & 31)];
            t >>>= 5;
        }
        // 80 random bits in 16 characters: hi (16 bits) then lo (64).
        long l = lo;
        long h = hi;
        for (int i = 25; i >= 10; i--) {
            out[i] = ALPHABET[(int) (l & 31)];
            l = (l >>> 5) | ((h & 31) << 59);
            h >>>= 5;
        }
        return new String(out);
    }
}
