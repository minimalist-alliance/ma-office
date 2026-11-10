package com.minimalistalliance.desk.agent.manager;

import java.security.SecureRandom;
import java.time.Clock;
import java.util.UUID;

/** UUIDv7 ids (ADR 0040 kept them from 0006): time-ordered, so runs sort by when they started. */
public final class RunIds {

    private static final SecureRandom RANDOM = new SecureRandom();

    private RunIds() {}

    public static UUID next(Clock clock) {
        long millis = clock.millis();
        byte[] random = new byte[10];
        RANDOM.nextBytes(random);
        long high = (millis << 16) | 0x7000L | ((random[0] & 0x0fL) << 8) | (random[1] & 0xffL);
        long low = 0x8000000000000000L | ((random[2] & 0x3fL) << 56);
        for (int i = 3; i < 10; i++) {
            low |= (random[i] & 0xffL) << (8 * (9 - i));
        }
        return new UUID(high, low);
    }
}
