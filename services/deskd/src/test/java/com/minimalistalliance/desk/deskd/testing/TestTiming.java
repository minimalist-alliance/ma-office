package com.minimalistalliance.desk.deskd.testing;

import java.time.Duration;
import org.awaitility.Awaitility;

/** Awaitility's default 100 ms poll adds seconds across these tests, on a shared 2-core machine. */
public final class TestTiming {

    private TestTiming() {}

    public static void pollFast() {
        Awaitility.setDefaultPollDelay(Duration.ZERO);
        Awaitility.setDefaultPollInterval(Duration.ofMillis(5));
    }
}
