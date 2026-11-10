package com.minimalistalliance.desk.agent.limits;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The price table in use (ADR 0043). The Platform is the source of truth: deskd fetches its table, as this service
 * can't reach the Platform, and pushes it over the agent socket. The bundled {@code pricing.json} is the seed until one
 * comes, and all there is with an older deskd.
 *
 * <p>A read is one volatile read, so a model call never waits here. A table that can't be used is ignored, with one log
 * line and none of its content, and the one in use stays. A settled cost stays as it was charged: a call takes its
 * price when it's reserved, so only new calls see a new table.
 */
public final class PriceTable {

    private static final Logger log = LoggerFactory.getLogger(PriceTable.class);
    /** What deskd will fetch, so a bigger one didn't come from it. */
    static final int MAX_BYTES = 1 << 20;

    private volatile Pricing current;

    public PriceTable(Pricing seed) {
        current = seed;
    }

    public Pricing current() {
        return current;
    }

    /** @return whether this table is now the one in use */
    public boolean apply(byte[] json) {
        try {
            if (json.length > MAX_BYTES) {
                throw new IllegalArgumentException("too big");
            }
            Pricing next = Pricing.parse(json);
            if (next.isEmpty()) {
                // No models, or none with a price.
                throw new IllegalArgumentException("no models");
            }
            current = next;
            log.info("price table in use, as of {}", next.checked());
            return true;
        } catch (RuntimeException e) {
            log.warn("a price table was ignored: it can't be used");
            return false;
        }
    }
}
