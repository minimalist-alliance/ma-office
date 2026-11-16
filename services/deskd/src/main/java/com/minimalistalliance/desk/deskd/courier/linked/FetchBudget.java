package com.minimalistalliance.desk.deskd.courier.linked;

import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;

/**
 * The bytes of messages fetched and not yet stored, across every linked mailbox: deskd's heap is shared (jvm.options), so
 * five first syncs at once hold no more than this. A message larger than the whole budget waits until nothing else is held,
 * then goes alone.
 */
final class FetchBudget {

    private final long total;
    private long held;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition freed = lock.newCondition();

    FetchBudget(long total) {
        this.total = total;
    }

    /** Waits for {@code bytes} (or the whole budget, for more), and returns what it took. */
    long take(long bytes) throws InterruptedException {
        long want = Math.min(Math.max(0, bytes), total);
        lock.lock();
        try {
            while (held + want > total) {
                freed.await();
            }
            held += want;
            return want;
        } finally {
            lock.unlock();
        }
    }

    void give(long bytes) {
        lock.lock();
        try {
            held = Math.max(0, held - bytes);
            freed.signalAll();
        } finally {
            lock.unlock();
        }
    }

    long held() {
        lock.lock();
        try {
            return held;
        } finally {
            lock.unlock();
        }
    }
}
