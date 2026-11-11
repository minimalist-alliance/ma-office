package com.minimalistalliance.desk.deskd.tier;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.platform.TierLimits;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.Map;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Browser time on its own clocks (ADR 0090 sections 2 to 6): what counts, the member's day and its edges, running out,
 * limits that change live, and what's kept across a restart. The timer isn't started: each test moves the clocks and
 * ticks by hand.
 */
class BrowserTimeTest {

    private static final TierLimits.Limits FREE = new TierLimits.Limits("free", 45, 2, 30);
    private static final String BOOT = "boot-1";

    @TempDir
    Path dir;

    private final MutableClock clock = new MutableClock(Instant.parse("2026-11-09T15:00:00Z"));
    private final AtomicLong nanos = new AtomicLong(1_000_000_000L);
    private final AtomicReference<String> accountZone = new AtomicReference<>();
    private final AtomicInteger outs = new AtomicInteger();
    private BrowserTime time;

    @AfterEach
    void tearDown() {
        if (time != null) {
            time.close();
        }
    }

    private BrowserTime meter(TierLimits.Limits limits) {
        return meter(limits, BOOT);
    }

    private BrowserTime meter(TierLimits.Limits limits, String bootId) {
        if (time != null) {
            time.close();
        }
        time = new BrowserTime(dir.resolve(BrowserTime.FILE), dir.resolve(BrowserTime.LIVE_FILE), bootId, clock, nanos::get, accountZone::get, limits);
        time.onOut(outs::incrementAndGet);
        return time;
    }

    /** Both clocks on by this much, then a tick, as the timer would. */
    private void pass(Duration by) {
        clock.advance(by);
        nanos.addAndGet(by.toNanos());
        time.tick();
    }

    private long usedSeconds() {
        return time.view().usedMillis() / 1000;
    }

    @Test
    void onlyLiveTimeCountsTowardsTheDayAndAllLiveTimeTowardsTheHeartbeat() {
        meter(FREE);
        pass(Duration.ofMinutes(5));
        assertThat(usedSeconds()).isZero();
        time.live(true);
        pass(Duration.ofSeconds(90));
        time.live(false);
        pass(Duration.ofMinutes(10));
        assertThat(usedSeconds()).isEqualTo(90);
        assertThat(time.liveSecondsSinceBoot()).isEqualTo(90);

        // A paid desk counts nothing towards a day, and still tells the heartbeat.
        time.limitsChanged(null);
        time.live(true);
        pass(Duration.ofSeconds(30));
        assertThat(time.view().limited()).isFalse();
        assertThat(time.liveSecondsSinceBoot()).isEqualTo(120);
        time.limitsChanged(FREE);
        assertThat(usedSeconds()).isEqualTo(90);
    }

    @Test
    void theDayEndsAtMidnightInTheAccountsZoneAndInUtcWithNone() {
        meter(FREE);
        time.live(true);
        pass(Duration.ofSeconds(1));
        assertThat(time.view().resetsAt()).isEqualTo(Instant.parse("2026-11-10T00:00:00Z"));
        assertThat(time.view().zone()).isEqualTo("Z");

        accountZone.set("America/Denver");
        // Today's end was fixed when the day opened: the new zone is the next day's.
        assertThat(time.view().resetsAt()).isEqualTo(Instant.parse("2026-11-10T00:00:00Z"));
        pass(Duration.ofHours(9));
        // 2026-11-10T00:00:01Z: a new day, by Denver's midnight, at least 23 h after the last ended: the 11th's.
        assertThat(time.view().resetsAt()).isEqualTo(Instant.parse("2026-11-11T07:00:00Z"));
        assertThat(time.view().zone()).isEqualTo("America/Denver");
        assertThat(usedSeconds()).isLessThan(9 * 3600);
    }

    @Test
    void aZoneThatCantBeUsedIsUtc() {
        accountZone.set("Mars/Olympus_Mons");
        meter(FREE);
        time.live(true);
        pass(Duration.ofSeconds(1));
        assertThat(time.view().resetsAt()).isEqualTo(Instant.parse("2026-11-10T00:00:00Z"));
    }

    @Test
    void daysAcrossDstAreTwentyThreeAndTwentyFiveHours() {
        ZoneId denver = ZoneId.of("America/Denver");
        // The spring day, 2027-03-14: 23 hours.
        Instant spring = BrowserTime.nextMidnight(Instant.parse("2027-03-14T12:00:00Z"), denver);
        Instant springStart = BrowserTime.nextMidnight(Instant.parse("2027-03-13T12:00:00Z"), denver);
        assertThat(Duration.between(springStart, spring)).isEqualTo(Duration.ofHours(23));
        // The autumn day, 2026-11-01: 25 hours.
        Instant autumnStart = BrowserTime.nextMidnight(Instant.parse("2026-10-31T12:00:00Z"), denver);
        Instant autumn = BrowserTime.nextMidnight(Instant.parse("2026-11-01T12:00:00Z"), denver);
        assertThat(Duration.between(autumnStart, autumn)).isEqualTo(Duration.ofHours(25));
        // Neither meets the 20-hour floor, so neither moves.
        assertThat(BrowserTime.boundaryAfter(springStart.plusSeconds(1), denver, springStart)).isEqualTo(spring);
        assertThat(BrowserTime.boundaryAfter(autumnStart.plusSeconds(1), denver, autumnStart)).isEqualTo(autumn);
        // A zone whose midnight is skipped (Santiago springs forward at midnight): the day begins at 01:00.
        ZoneId santiago = ZoneId.of("America/Santiago");
        Instant gap = BrowserTime.nextMidnight(Instant.parse("2026-09-05T12:00:00Z"), santiago);
        assertThat(ZonedDateTime.ofInstant(gap, santiago).getHour()).isEqualTo(1);
    }

    @Test
    void aDayIsCountedRightThroughDstInTheMembersZone() {
        accountZone.set("America/Denver");
        clock.advance(Duration.between(clock.instant(), Instant.parse("2027-03-14T08:00:00Z")));
        meter(FREE);
        time.live(true);
        pass(Duration.ofMinutes(10));
        // 01:10 MST on the spring day: it ends at midnight on the 15th, MDT, which is 06:00Z.
        assertThat(time.view().resetsAt()).isEqualTo(Instant.parse("2027-03-15T06:00:00Z"));
        assertThat(usedSeconds()).isEqualTo(600);
    }

    @Test
    void hoppingZonesCantOpenAFreshDayEveryFewHours() {
        accountZone.set("America/Denver");
        meter(FREE);
        time.live(true);
        pass(Duration.ofSeconds(1));
        time.live(false);
        Instant denverMidnight = Instant.parse("2026-11-10T07:00:00Z");
        assertThat(time.view().resetsAt()).isEqualTo(denverMidnight);
        // Just after Denver's midnight, a zone whose midnight is 4 hours away.
        pass(Duration.between(clock.instant(), denverMidnight).plusSeconds(1));
        accountZone.set("Pacific/Pago_Pago");
        time.live(true);
        pass(Duration.ofSeconds(1));
        // Pago Pago's next midnight is 11:00Z the 10th, under 23 h after the last day's end, so it's the one after.
        assertThat(time.view().resetsAt()).isEqualTo(Instant.parse("2026-11-11T11:00:00Z"));
    }

    @Test
    void anHourEastIsAShortDayAndTwoHoursEastIsOneLongerDay() {
        accountZone.set("America/Denver");
        meter(FREE);
        time.live(true);
        pass(Duration.ofSeconds(1));
        time.live(false);
        Instant denverMidnight = Instant.parse("2026-11-10T07:00:00Z");
        pass(Duration.between(clock.instant(), denverMidnight).plusSeconds(1));
        // Chicago's midnight is 06:00Z the 11th, 23 h on: allowed, as a DST day is.
        accountZone.set("America/Chicago");
        time.live(true);
        pass(Duration.ofSeconds(1));
        time.live(false);
        Instant chicagoMidnight = Instant.parse("2026-11-11T06:00:00Z");
        assertThat(time.view().resetsAt()).isEqualTo(chicagoMidnight);
        pass(Duration.between(clock.instant(), chicagoMidnight).plusSeconds(1));
        // New York's next midnight is 05:00Z the 12th, 23 h on: allowed. Then two more hours east: London's next
        // midnight is 00:00Z the 13th, 19 h on, under the floor, so the day runs to the one after, on London's midnight.
        accountZone.set("America/New_York");
        time.live(true);
        pass(Duration.ofSeconds(1));
        time.live(false);
        Instant newYorkMidnight = Instant.parse("2026-11-12T05:00:00Z");
        assertThat(time.view().resetsAt()).isEqualTo(newYorkMidnight);
        pass(Duration.between(clock.instant(), newYorkMidnight).plusSeconds(1));
        accountZone.set("Europe/London");
        time.live(true);
        pass(Duration.ofSeconds(1));
        assertThat(time.view().resetsAt()).isEqualTo(Instant.parse("2026-11-14T00:00:00Z"));
    }

    @Test
    void hoppingZonesEveryDayForAWeekGainsAtMostOneDay() {
        // Money audit D1: at each new day, the zone whose midnight comes soonest. With a 23 h floor, a week holds at
        // most 8 days (168 / 23 is 7.3), where midnight alone would allow many more.
        List<String> zones = List.of("Pacific/Kiritimati", "Asia/Tokyo", "Europe/London", "America/Denver", "Pacific/Pago_Pago");
        accountZone.set("UTC");
        meter(FREE);
        Instant end = clock.instant().plus(Duration.ofDays(7));
        int days = 0;
        while (true) {
            time.live(true);
            pass(Duration.ofSeconds(1));
            time.live(false);
            Instant resetsAt = time.view().resetsAt();
            if (!resetsAt.isBefore(end)) {
                break;
            }
            days++;
            pass(Duration.between(clock.instant(), resetsAt).plusSeconds(1));
            Instant now = clock.instant();
            accountZone.set(zones.stream()
                    .min(java.util.Comparator.comparing(z -> BrowserTime.nextMidnight(now, java.time.ZoneId.of(z))))
                    .orElseThrow());
        }
        assertThat(days).isLessThanOrEqualTo(8);
    }

    @Test
    void runningOutWhileLiveTellsOnceAndHoldsUntilTheDayResets() {
        meter(FREE);
        time.live(true);
        pass(Duration.ofMinutes(44));
        assertThat(time.outUntil()).isNull();
        pass(Duration.ofSeconds(59));
        assertThat(time.outUntil()).isNull();
        assertThat(outs).hasValue(0);
        pass(Duration.ofSeconds(1));
        Instant resets = Instant.parse("2026-11-10T00:00:00Z");
        assertThat(time.outUntil()).isEqualTo(resets);
        assertThat(time.view().out()).isTrue();
        assertThat(outs).hasValue(1);
        pass(Duration.ofSeconds(5));
        assertThat(outs).hasValue(1);
        time.live(false);

        // At midnight it's over by itself, with no tick needed, and the next day is fresh.
        clock.advance(Duration.between(clock.instant(), resets));
        assertThat(time.outUntil()).isNull();
        nanos.addAndGet(Duration.ofHours(8).toNanos());
        time.tick();
        assertThat(time.view().out()).isFalse();
        assertThat(usedSeconds()).isZero();
    }

    @Test
    void anUpgradeLiftsTheLimitAtOnceAndARaisedOneToo() {
        meter(new TierLimits.Limits("free", 30, 2, 30));
        time.live(true);
        pass(Duration.ofMinutes(31));
        assertThat(time.outUntil()).isNotNull();
        time.limitsChanged(new TierLimits.Limits("free", 60, 2, 30));
        assertThat(time.outUntil()).isNull();
        time.limitsChanged(new TierLimits.Limits("free", 30, 2, 30));
        assertThat(time.outUntil()).isNotNull();
        time.limitsChanged(null);
        assertThat(time.outUntil()).isNull();
        assertThat(time.view().limited()).isFalse();
    }

    @Test
    void limitsThatAppearOnARunningDeskCountFromThenAndCanMeanOutAtOnce() {
        meter(FREE);
        time.live(true);
        pass(Duration.ofMinutes(40));
        time.limitsChanged(null);
        pass(Duration.ofMinutes(30));
        // Back to free the same day: the 40 minutes count, the 30 unlimited ones don't.
        time.limitsChanged(FREE);
        assertThat(usedSeconds()).isEqualTo(2400);
        pass(Duration.ofMinutes(5));
        assertThat(time.outUntil()).isNotNull();
        assertThat(outs).hasValue(1);

        // A lowered dial on a desk not live is out at the next tick, and tells.
        time.limitsChanged(null);
        time.live(false);
        time.tick();
        time.limitsChanged(new TierLimits.Limits("free", 30, 2, 30));
        assertThat(time.outUntil()).isNotNull();
        time.tick();
        assertThat(outs).hasValue(2);
    }

    @Test
    void theDayAndTheCountSinceBootSurviveARestart() throws Exception {
        meter(FREE);
        time.live(true);
        pass(Duration.ofMinutes(20));
        time.live(false);
        time.tick();
        Map<String, Object> kept = Json.parseObject(Files.readAllBytes(dir.resolve(BrowserTime.FILE)));
        assertThat(((Number) Json.object(kept, "day").get("usedMs")).longValue()).isEqualTo(1_200_000L);
        assertThat(Json.object(kept, "day")).containsEntry("zone", "Z");

        meter(FREE);
        assertThat(usedSeconds()).isEqualTo(1200);
        assertThat(time.liveSecondsSinceBoot()).isEqualTo(1200);
        time.live(true);
        pass(Duration.ofMinutes(25));
        assertThat(time.outUntil()).isNotNull();

        // Out survives a restart too.
        time.close();
        meter(FREE);
        assertThat(time.outUntil()).isEqualTo(Instant.parse("2026-11-10T00:00:00Z"));
        // A reboot starts the heartbeat's count again; the day stays.
        meter(FREE, "boot-2");
        assertThat(time.liveSecondsSinceBoot()).isZero();
        assertThat(usedSeconds()).isEqualTo(2700);
    }

    @Test
    void whileLiveItsSavedEveryTenSecondsSoACrashLosesLittle() throws Exception {
        meter(FREE);
        time.live(true);
        pass(Duration.ofSeconds(5));
        pass(Duration.ofSeconds(6));
        Map<String, Object> kept = Json.parseObject(Files.readAllBytes(dir.resolve(BrowserTime.FILE)));
        assertThat(((Number) Json.object(kept, "day").get("usedMs")).longValue()).isEqualTo(11_000L);
        Map<String, Object> live = Json.parseObject(Files.readAllBytes(dir.resolve(BrowserTime.LIVE_FILE)));
        assertThat(live).containsEntry("bootId", BOOT);
        assertThat(((Number) live.get("liveMs")).longValue()).isEqualTo(11_000L);
    }

    @Test
    void aJunkDayFileIsAFreshDay() throws Exception {
        Files.writeString(dir.resolve(BrowserTime.FILE), "{\"day\": {\"openedAt\": \"yesterday\"}}");
        meter(FREE);
        assertThat(usedSeconds()).isZero();
        assertThat(time.outUntil()).isNull();
        time.live(true);
        pass(Duration.ofSeconds(3));
        assertThat(usedSeconds()).isEqualTo(3);
    }

    @Test
    void theDayEndingWhileLiveCountsOnlyWhatCameAfterToTheNewDay() {
        clock.advance(Duration.between(clock.instant(), Instant.parse("2026-11-09T23:59:50Z")));
        meter(FREE);
        time.live(true);
        pass(Duration.ofSeconds(5));
        assertThat(time.view().resetsAt()).isEqualTo(Instant.parse("2026-11-10T00:00:00Z"));
        pass(Duration.ofSeconds(10));
        assertThat(time.view().resetsAt()).isEqualTo(Instant.parse("2026-11-11T00:00:00Z"));
        assertThat(usedSeconds()).isEqualTo(5);
    }

    @Test
    void aWallClockThatJumpsAddsNoTime() {
        meter(FREE);
        time.live(true);
        clock.advance(Duration.ofHours(3));
        nanos.addAndGet(Duration.ofSeconds(2).toNanos());
        time.tick();
        assertThat(usedSeconds()).isEqualTo(2);
    }

    @Test
    void theTimerSleepsUntilTheTimeRunsOutAndThenTellsByItself() throws Exception {
        // A minute a day, 58 s of it used: the timer, on the real clocks, wakes as the last 2 s go.
        Instant now = Instant.now();
        Files.writeString(dir.resolve(BrowserTime.FILE), "{\"day\": {\"openedAt\": \"" + now.minusSeconds(60) + "\", \"resetsAt\": \""
                + BrowserTime.nextMidnight(now, java.time.ZoneOffset.UTC) + "\", \"zone\": \"Z\", \"usedMs\": 58000}}");
        time = new BrowserTime(
                dir.resolve(BrowserTime.FILE), dir.resolve(BrowserTime.LIVE_FILE), BOOT, java.time.Clock.systemUTC(), System::nanoTime,
                () -> null, new TierLimits.Limits("free", 1, 2, 30));
        java.util.concurrent.CountDownLatch out = new java.util.concurrent.CountDownLatch(1);
        time.onOut(out::countDown);
        time.start();
        time.live(true);
        assertThat(out.await(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        assertThat(time.outUntil()).isNotNull();
    }
}
