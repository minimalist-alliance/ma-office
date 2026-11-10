package com.minimalistalliance.desk.agent.team;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import org.junit.jupiter.api.Test;

class ScheduleTest {

    private static final ZoneId DENVER = ZoneId.of("America/Denver");
    private static final List<Integer> WEEKDAYS = List.of(1, 2, 3, 4, 5);
    private static final List<Integer> EVERY_DAY = List.of(1, 2, 3, 4, 5, 6, 7);

    private static long ms(String instant) {
        return Instant.parse(instant).toEpochMilli();
    }

    private static Long repeat(List<Integer> days, String time, String after, ZoneId zone) {
        return Schedule.next("repeat", days, time, null, null, 0, ms(after), zone);
    }

    @Test
    void weekdaysSkipTheWeekend() {
        // Friday 2026-11-06 09:00 MST is past 08:00; the next weekday is Monday the 9th, 08:00 MST = 15:00Z.
        assertThat(repeat(WEEKDAYS, "08:00", "2026-11-06T16:00:00Z", DENVER)).isEqualTo(ms("2026-11-09T15:00:00Z"));
        assertThat(repeat(WEEKDAYS, "08:00", "2026-11-07T20:00:00Z", DENVER)).as("Saturday")
                .isEqualTo(ms("2026-11-09T15:00:00Z"));
        assertThat(repeat(WEEKDAYS, "08:00", "2026-11-08T20:00:00Z", DENVER)).as("Sunday")
                .isEqualTo(ms("2026-11-09T15:00:00Z"));
        assertThat(repeat(WEEKDAYS, "08:00", "2026-11-06T14:59:00Z", DENVER)).as("Friday, before 08:00")
                .isEqualTo(ms("2026-11-06T15:00:00Z"));
    }

    @Test
    void theInstantItselfIsNotTheNextFire() {
        assertThat(repeat(WEEKDAYS, "08:00", "2026-11-04T15:00:00Z", DENVER)).isEqualTo(ms("2026-11-05T15:00:00Z"));
    }

    @Test
    void theZoneDecidesWhatEightMeans() {
        String after = "2026-11-04T00:00:00Z";
        assertThat(repeat(EVERY_DAY, "08:00", after, DENVER)).isEqualTo(ms("2026-11-04T15:00:00Z"));
        assertThat(repeat(EVERY_DAY, "08:00", after, ZoneId.of("UTC"))).isEqualTo(ms("2026-11-04T08:00:00Z"));
        assertThat(repeat(EVERY_DAY, "08:00", after, ZoneId.of("Asia/Tokyo"))).isEqualTo(ms("2026-11-04T23:00:00Z"));
    }

    /** 2027-03-14: 02:00 MST jumps to 03:00 MDT, so 02:30 never happens and runs at the first instant after the gap. */
    @Test
    void aTimeSkippedBySpringForwardRunsWhenTheGapEnds() {
        Long next = repeat(EVERY_DAY, "02:30", "2027-03-13T09:31:00Z", DENVER);

        assertThat(next).isEqualTo(ms("2027-03-14T09:00:00Z"));
        assertThat(Instant.ofEpochMilli(next).atZone(DENVER).toLocalTime()).hasToString("03:00");
        assertThat(repeat(EVERY_DAY, "02:30", "2027-03-14T09:00:00Z", DENVER)).as("and the next day, 02:30 as usual")
                .isEqualTo(ms("2027-03-15T08:30:00Z"));
    }

    /** 2027-11-07: 02:00 MDT falls back to 01:00 MST, so 01:30 happens twice; it runs once, at the first. */
    @Test
    void aTimeRepeatedByFallBackRunsOnceAtTheFirst() {
        Long first = repeat(EVERY_DAY, "01:30", "2027-11-06T08:00:00Z", DENVER);
        assertThat(first).isEqualTo(ms("2027-11-07T07:30:00Z"));

        Long after = repeat(EVERY_DAY, "01:30", "2027-11-07T07:30:00Z", DENVER);
        assertThat(after).as("not the second 01:30, an hour later").isEqualTo(ms("2027-11-08T08:30:00Z"));
    }

    @Test
    void everyMinutesCountFromTheAnchor() {
        long anchor = ms("2026-11-04T10:00:00Z");
        long ten = Duration.ofMinutes(10).toMillis();
        assertThat(Schedule.next("repeat", null, null, 10, null, anchor, anchor + 25 * 60_000L, DENVER))
                .isEqualTo(anchor + 3 * ten);
        assertThat(Schedule.next("repeat", null, null, 10, null, anchor, anchor + 2 * ten, DENVER))
                .as("on a step, the next step").isEqualTo(anchor + 3 * ten);
        assertThat(Schedule.next("repeat", null, null, 10, null, anchor, anchor - 1, DENVER))
                .as("before the anchor, the anchor").isEqualTo(anchor);
    }

    @Test
    void onceIsItsInstantIfStillAhead() {
        long at = ms("2026-11-05T12:00:00Z");
        assertThat(Schedule.next("once", null, null, null, at, 0, at - 1, DENVER)).isEqualTo(at);
        assertThat(Schedule.next("once", null, null, null, at, 0, at, DENVER)).isNull();
        assertThat(Schedule.next("once", null, null, null, at, 0, at + 1, DENVER)).as("in the past").isNull();
        assertThat(Schedule.next("once", null, null, null, null, 0, 0, DENVER)).isNull();
    }

    @Test
    void anIncompleteRepeatHasNoNext() {
        assertThat(Schedule.next("repeat", List.of(), "08:00", null, null, 0, 0, DENVER)).isNull();
        assertThat(Schedule.next("repeat", null, "08:00", null, null, 0, 0, DENVER)).isNull();
        assertThat(Schedule.next("repeat", WEEKDAYS, null, null, null, 0, 0, DENVER)).isNull();
        assertThat(Schedule.next("repeat", WEEKDAYS, "8am", null, null, 0, 0, DENVER)).isNull();
    }
}
