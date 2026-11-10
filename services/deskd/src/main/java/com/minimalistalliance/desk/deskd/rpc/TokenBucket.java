package com.minimalistalliance.desk.deskd.rpc;

import java.util.function.LongSupplier;

/** Rate limit worked out on arrival, so it needs no timer. Used by one thread at a time. */
public final class TokenBucket {

    private final double perNano;
    private final double capacity;
    private final LongSupplier nanoTime;
    private double tokens;
    private long lastNanos;

    public TokenBucket(int perSecond, int capacity, LongSupplier nanoTime) {
        this.perNano = perSecond / 1e9;
        this.capacity = capacity;
        this.nanoTime = nanoTime;
        this.tokens = capacity;
        this.lastNanos = nanoTime.getAsLong();
    }

    public boolean tryAcquire() {
        long now = nanoTime.getAsLong();
        tokens = Math.min(capacity, tokens + (now - lastNanos) * perNano);
        lastNanos = now;
        if (tokens < 1) {
            return false;
        }
        tokens -= 1;
        return true;
    }
}
