package com.minimalistalliance.desk.agent.limits;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.testing.FakeProvider;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

/** ADR 0043's periods: the desk's day, and days, weeks and months in the member's zone, from the same rows. */
class UsagePeriodsTest {

    private static final LimitPolicy NO_LIMITS = new LimitPolicy(
            Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE, 1000);

    @TempDir
    Path dir;

    private final MutableClock clock = new MutableClock(Instant.parse("2026-11-04T10:00:00Z"));
    private final AtomicLong runs = new AtomicLong();
    private volatile ZoneId zone = ZoneOffset.UTC;
    private UsageLedger ledger;

    @BeforeEach
    void open() throws Exception {
        ledger = new UsageLedger(dir.resolve("usage.db"), clock, () -> zone);
        ledger.open();
    }

    @AfterEach
    void close() {
        ledger.close();
    }

    private UsageLedger.Reservation spend(String agentId, long microUsd, LimitPolicy policy) throws Exception {
        return ledger.reserve(
                new UsageLedger.Call(agentId, "run-" + runs.incrementAndGet(), "k1", FakeProvider.ID, "m"),
                new UsageLedger.Estimate(microUsd, microUsd), policy);
    }

    private static LimitPolicy deskDay(Limit limit) {
        return new LimitPolicy(Limit.NONE, Limit.NONE, Limit.NONE, limit, Limit.NONE, Limit.NONE, Limit.NONE, 1000);
    }

    private UsageLedger.ScopeUsage usage(Scope scope) throws Exception {
        return ledger.usage("manager", null).stream().filter(u -> u.scope() == scope).findFirst().orElseThrow();
    }

    private void setLocal(String localDateTime) {
        clock.set(LocalDateTime.parse(localDateTime).atZone(zone).toInstant());
    }

    private Instant local(String localDateTime) {
        return LocalDateTime.parse(localDateTime).atZone(zone).toInstant();
    }

    @Test
    void theDesksDayCountsEveryAgentAndRefusesTheCallThatWouldPassIt() throws Exception {
        LimitPolicy policy = deskDay(new Limit(1000L, null));
        spend("manager", 600, policy);

        assertThatThrownBy(() -> spend("writer", 600, policy))
                .isInstanceOfSatisfying(LimitReachedException.class, e -> {
                    assertThat(e.scope()).isEqualTo(Scope.DESK_DAY);
                    assertThat(e.scope().wireName()).isEqualTo("desk_day");
                    assertThat(e.unit()).isEqualTo("usd");
                    assertThat(e.limit()).isEqualTo(1000);
                    assertThat(e.spent()).isEqualTo(600);
                    assertThat(e.needed()).isEqualTo(600);
                });
        // Nothing was written for the refused call, so what's left still fits.
        spend("writer", 400, policy);
        assertThat(usage(Scope.DESK_DAY).spent().microUsd()).isEqualTo(1000);
    }

    @Test
    void theDesksDayCanBeInTokens() throws Exception {
        LimitPolicy policy = deskDay(Limit.tokens(100));
        spend("manager", 80, policy);
        assertThatThrownBy(() -> spend("manager", 21, policy))
                .isInstanceOfSatisfying(LimitReachedException.class, e -> {
                    assertThat(e.scope()).isEqualTo(Scope.DESK_DAY);
                    assertThat(e.unit()).isEqualTo("tokens");
                });
    }

    @Test
    void noCapOnTheDesksDayByDefault() throws Exception {
        assertThat(LimitPolicy.DEFAULTS.deskDay()).isEqualTo(Limit.NONE);
        spend("manager", 900_000_000, deskDay(LimitPolicy.DEFAULTS.deskDay()));
    }

    /** Ten at once against room for three: one transaction each, so they can't share what's left. */
    @Test
    void concurrentReservationsCantShareWhatsLeftOfTheDesksDay() throws Exception {
        LimitPolicy policy = deskDay(new Limit(1000L, null));
        AtomicInteger reserved = new AtomicInteger();
        AtomicInteger refused = new AtomicInteger();
        CountDownLatch done = new CountDownLatch(10);
        for (int i = 0; i < 10; i++) {
            String agent = "agent-" + i;
            Thread.ofVirtual().start(() -> {
                try {
                    spend(agent, 300, policy);
                    reserved.incrementAndGet();
                } catch (LimitReachedException e) {
                    refused.incrementAndGet();
                } catch (Exception e) {
                    throw new IllegalStateException(e);
                } finally {
                    done.countDown();
                }
            });
        }
        assertThat(done.await(10, TimeUnit.SECONDS)).isTrue();
        assertThat(reserved.get()).isEqualTo(3);
        assertThat(refused.get()).isEqualTo(7);
        assertThat(usage(Scope.DESK_DAY).spent().microUsd()).isEqualTo(900);
    }

    /** 30 Nov 2026 is a Monday, so the same week runs on into December and ends a week on. */
    @ParameterizedTest
    @ValueSource(strings = {"America/Denver", "Pacific/Auckland"})
    void aDayAndAMonthEndAtTheMembersMidnight(String name) throws Exception {
        zone = ZoneId.of(name);
        setLocal("2026-11-30T23:30:00");
        spend("manager", 100, NO_LIMITS);
        assertThat(usage(Scope.AGENT_DAY).spent().microUsd()).isEqualTo(100);
        assertThat(usage(Scope.DESK_DAY).spent().microUsd()).isEqualTo(100);
        assertThat(usage(Scope.DESK_DAY).resetsAt()).isEqualTo(local("2026-12-01T00:00:00"));
        assertThat(usage(Scope.DESK_MONTH).resetsAt()).isEqualTo(local("2026-12-01T00:00:00"));
        assertThat(usage(Scope.AGENT_WEEK).resetsAt()).isEqualTo(local("2026-12-07T00:00:00"));

        setLocal("2026-11-30T23:59:59");
        assertThat(usage(Scope.DESK_DAY).spent().microUsd()).isEqualTo(100);
        assertThat(usage(Scope.DESK_MONTH).spent().microUsd()).isEqualTo(100);

        setLocal("2026-12-01T00:00:00");
        assertThat(usage(Scope.AGENT_DAY).spent().microUsd()).isZero();
        assertThat(usage(Scope.DESK_DAY).spent().microUsd()).isZero();
        assertThat(usage(Scope.AGENT_MONTH).spent().microUsd()).isZero();
        assertThat(usage(Scope.DESK_MONTH).spent().microUsd()).isZero();
        assertThat(usage(Scope.AGENT_WEEK).spent().microUsd()).isEqualTo(100);
        assertThat(usage(Scope.DESK_MONTH).resetsAt()).isEqualTo(local("2027-01-01T00:00:00"));

        setLocal("2026-12-06T23:59:59");
        assertThat(usage(Scope.AGENT_WEEK).spent().microUsd()).isEqualTo(100);
        setLocal("2026-12-07T00:00:00");
        assertThat(usage(Scope.AGENT_WEEK).spent().microUsd()).isZero();
        assertThat(usage(Scope.AGENT_WEEK).resetsAt()).isEqualTo(local("2026-12-14T00:00:00"));
    }

    /** The day the clocks change is one local day, of 23 or 25 hours, spent in one window. */
    @ParameterizedTest
    @CsvSource({
        "America/Denver, 2026-03-08, 23",
        "America/Denver, 2026-11-01, 25",
        "Pacific/Auckland, 2026-04-05, 25",
        "Pacific/Auckland, 2026-09-27, 23",
    })
    void aDayTheClocksChangeIsOneLocalDay(String name, String date, long hours) throws Exception {
        zone = ZoneId.of(name);
        Instant start = local(date + "T00:00:00");
        clock.set(start);
        spend("manager", 100, NO_LIMITS);
        assertThat(usage(Scope.DESK_DAY).spent().microUsd()).isEqualTo(100);
        Instant end = usage(Scope.DESK_DAY).resetsAt();
        assertThat(Duration.between(start, end)).isEqualTo(Duration.ofHours(hours));

        clock.set(end.minusSeconds(1));
        assertThat(usage(Scope.DESK_DAY).spent().microUsd()).isEqualTo(100);
        assertThat(usage(Scope.DESK_DAY).resetsAt()).isEqualTo(end);
        clock.set(end);
        assertThat(usage(Scope.DESK_DAY).spent().microUsd()).isZero();
    }

    /** Havana's clocks go forward at midnight, so that day starts at 01:00. */
    @Test
    void aDayWhoseMidnightDoesntExistStartsAtItsFirstMoment() throws Exception {
        zone = ZoneId.of("America/Havana");
        setLocal("2026-03-07T23:30:00");
        assertThat(usage(Scope.DESK_DAY).resetsAt()).isEqualTo(Instant.parse("2026-03-08T05:00:00Z"));
    }

    /** No schema, no rewrite: the same row is in today or out of it by which zone is asked. */
    @Test
    void changingTheZoneReWindowsTheSameRows() throws Exception {
        clock.set(Instant.parse("2026-11-05T05:00:00Z"));
        spend("manager", 100, NO_LIMITS);
        clock.set(Instant.parse("2026-11-05T08:00:00Z"));
        assertThat(usage(Scope.DESK_DAY).spent().microUsd()).isEqualTo(100);

        zone = ZoneId.of("America/Denver");
        // Denver's 5 Nov began at 07:00Z, after the row.
        assertThat(usage(Scope.DESK_DAY).spent().microUsd()).isZero();
        assertThat(usage(Scope.DESK_DAY).resetsAt()).isEqualTo(Instant.parse("2026-11-06T07:00:00Z"));
        LimitPolicy room = deskDay(new Limit(100L, null));
        UsageLedger.Reservation fits = spend("manager", 100, room);
        assertThat(fits.id()).isPositive();

        zone = ZoneId.of("Pacific/Auckland");
        // Auckland's 5 Nov began at 11:00Z the day before, so both rows are in it, and the same call no longer fits.
        assertThat(usage(Scope.DESK_DAY).spent().microUsd()).isEqualTo(200);
        assertThatThrownBy(() -> spend("manager", 100, room)).isInstanceOf(LimitReachedException.class);

        zone = ZoneOffset.UTC;
        assertThat(usage(Scope.DESK_DAY).spent().microUsd()).isEqualTo(200);
    }

    @Test
    void usageListsTheDesksDayWithTheOtherPeriods() throws Exception {
        assertThat(ledger.usage("manager", "k1")).extracting(UsageLedger.ScopeUsage::scope).isEqualTo(List.of(
                Scope.AGENT_DAY, Scope.AGENT_WEEK, Scope.AGENT_MONTH, Scope.DESK_DAY, Scope.DESK_MONTH, Scope.KEY_MONTH));
    }
}
