package com.minimalistalliance.desk.deskd.protocol;

import java.util.concurrent.atomic.AtomicLong;

/** Bytes one session may hold in incomplete messages, across all its channels. */
public final class ReassemblyBudget {

    /** Room for one 4 MiB DATA message and a 1 MiB request at the same time. */
    public static final long DEFAULT_BYTES = 5L * 1024 * 1024;

    private final long limit;
    private final AtomicLong used = new AtomicLong();

    public ReassemblyBudget(long limit) {
        this.limit = limit;
    }

    boolean tryReserve(int bytes) {
        if (used.addAndGet(bytes) > limit) {
            used.addAndGet(-bytes);
            return false;
        }
        return true;
    }

    void release(int bytes) {
        used.addAndGet(-bytes);
    }

    public long used() {
        return used.get();
    }
}
