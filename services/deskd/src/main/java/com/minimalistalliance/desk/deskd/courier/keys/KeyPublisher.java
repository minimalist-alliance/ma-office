package com.minimalistalliance.desk.deskd.courier.keys;

import com.minimalistalliance.desk.courier.envelope.PublishedKeys;
import java.time.Duration;

/**
 * Where the desk's public keys go: the platform's key directory ({@code PUT /v1/agent/keys}, contract 0.4.0 §3.1),
 * through {@link PlatformKeyPublisher}. A test or a self-hosted desk without the platform has its own.
 */
public interface KeyPublisher {

    /** What happened. {@code retryAfter} is null for "at the next sweep". */
    record Result(Outcome outcome, long keysVersion, String platformFingerprint, Duration retryAfter, String code) {
        static Result published(long keysVersion, String fingerprint) {
            return new Result(Outcome.PUBLISHED, keysVersion, fingerprint, null, null);
        }

        static Result later(String code, Duration retryAfter) {
            return new Result(Outcome.LATER, -1, null, retryAfter, code);
        }

        static Result never(String code) {
            return new Result(Outcome.NEVER, -1, null, null, code);
        }
    }

    enum Outcome {
        /** The directory holds these keys now. */
        PUBLISHED,
        /** Not now (paused, unreachable, a limit): try again later. */
        LATER,
        /** Not on this desk (a Guild Desk, say): don't try again until deskd restarts. */
        NEVER
    }

    Result publish(PublishedKeys keys) throws InterruptedException;

    /** For a desk with no platform: nothing is published, and nothing waits on it. */
    KeyPublisher NONE = keys -> Result.never("no_platform");
}
