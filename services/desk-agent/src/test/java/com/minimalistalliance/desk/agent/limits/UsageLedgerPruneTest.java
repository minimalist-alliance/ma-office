package com.minimalistalliance.desk.agent.limits;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.testing.FakeProvider;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Review finding 22: finished rows go once they're past what any limit reads, at open and then daily. */
class UsageLedgerPruneTest {

    private static final LimitPolicy NO_LIMITS = new LimitPolicy(
            Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE, 1000);
    private static final Usage USED = new Usage(100, 0, 0, 20, 0);

    @TempDir
    Path dir;

    private final MutableClock clock = new MutableClock(Instant.parse("2026-01-05T10:00:00Z"));
    private final AtomicLong runs = new AtomicLong();
    private UsageLedger ledger;

    @AfterEach
    void close() {
        if (ledger != null) {
            ledger.close();
        }
    }

    private UsageLedger open(Duration pruneEvery) throws Exception {
        ledger = new UsageLedger(dir.resolve("usage.db"), clock, () -> ZoneOffset.UTC, pruneEvery);
        ledger.open();
        return ledger;
    }

    private UsageLedger.Reservation reserve() throws Exception {
        return ledger.reserve(
                new UsageLedger.Call("manager", "run-" + runs.incrementAndGet(), "k1", FakeProvider.ID, "m"),
                new UsageLedger.Estimate(1000, 1000L), NO_LIMITS);
    }

    /** One of each way a call ends: settled, released and kept. */
    private void threeFinished() throws Exception {
        ledger.settle(reserve(), USED, 50L);
        ledger.release(reserve());
        ledger.keep(reserve());
    }

    @Test
    void openDropsFinishedRowsPastTheKeepAndLeavesTheMonthAlone() throws Exception {
        open(UsageLedger.PRUNE_EVERY);
        threeFinished();
        // A reservation a crash leaves: the next open keeps it as spent, and then it's as old as any other row.
        reserve();
        clock.advance(UsageLedger.KEEP.minusDays(30));
        threeFinished();
        ledger.close();

        clock.advance(Duration.ofDays(31));
        open(UsageLedger.PRUNE_EVERY);
        assertThat(ledger.orphansAtOpen()).isEqualTo(1);
        assertThat(ledger.rowsForTest()).isEqualTo(3);
        threeFinished();
        UsageLedger.Spent month = month();
        ledger.close();

        // Reopened at once, nothing more goes, and the month reads the same.
        open(UsageLedger.PRUNE_EVERY);
        assertThat(ledger.rowsForTest()).isEqualTo(6);
        assertThat(month()).isEqualTo(month);
    }

    @Test
    void anOpenLedgerPrunesOnItsOwnAndNeverTakesAReservationStillOut() throws Exception {
        open(Duration.ofMillis(50));
        UsageLedger.Reservation out = reserve();
        threeFinished();
        clock.advance(UsageLedger.KEEP.plusDays(1));
        threeFinished();

        // Only the reservation still out and the new rows stay.
        await().atMost(Duration.ofSeconds(10)).until(() -> ledger.rowsForTest() == 4);
        // A call that ends after all that is settled as ever, and its row is then as old as the others were.
        ledger.settle(out, USED, 50L);
        await().atMost(Duration.ofSeconds(10)).until(() -> ledger.rowsForTest() == 3);
    }

    private UsageLedger.Spent month() throws Exception {
        return ledger.usage("manager", null).stream()
                .filter(u -> u.scope() == Scope.DESK_MONTH)
                .findFirst()
                .orElseThrow()
                .spent();
    }
}
