package com.minimalistalliance.desk.deskd.aws;

import com.minimalistalliance.desk.deskd.imds.ImdsClient;
import java.io.IOException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.locks.ReentrantLock;

/**
 * The instance role's credentials, kept until shortly before they expire. Refreshes on use, so
 * there's no timer. Only the control plane's own threads call this, and client session threads never
 * wait on its lock, so it's held across the IMDS call.
 */
public final class RoleCredentials {

    /** IMDS has new credentials at least this long before the old ones expire. */
    private static final Duration REFRESH_BEFORE = Duration.ofMinutes(5);

    private final ImdsClient imds;
    private final Clock clock;
    private final ReentrantLock lock = new ReentrantLock();
    private AwsCredentials cached;

    public RoleCredentials(ImdsClient imds, Clock clock) {
        this.imds = imds;
        this.clock = clock;
    }

    /** @throws IOException if IMDS can't help and what's held has already expired */
    public AwsCredentials current() throws IOException, InterruptedException {
        lock.lockInterruptibly();
        try {
            Instant now = clock.instant();
            if (cached != null && now.plus(REFRESH_BEFORE).isBefore(cached.expiration())) {
                return cached;
            }
            try {
                cached = imds.roleCredentials();
            } catch (IOException e) {
                if (cached == null || !now.isBefore(cached.expiration())) {
                    throw e;
                }
            }
            return cached;
        } finally {
            lock.unlock();
        }
    }

    /** A service called these bad, so the next {@link #current} asks IMDS again. */
    public void invalidate() {
        lock.lock();
        try {
            cached = null;
        } finally {
            lock.unlock();
        }
    }
}
