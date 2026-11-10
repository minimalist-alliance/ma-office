package com.minimalistalliance.desk.agent.team;

import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.zone.ZoneOffsetTransition;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;

/**
 * When a timer fires next (ADR 0047), in the member's zone: the zone the limits use, read at each computation, so a
 * changed zone moves the next fire of a "weekdays at 8" timer to 8 in the new zone.
 *
 * <ul>
 *   <li>{@code once}: its {@code at}, if still ahead.
 *   <li>{@code repeat} on days at a time: the first of those days, from today on, whose time is ahead. A time a clock
 *       change skips (02:30 on a spring-forward night) runs at the first instant after the gap; a time that happens
 *       twice (a fall-back night) runs at the first.
 *   <li>{@code repeat} every N minutes: from its anchor (when it was set), every N minutes, the first ahead.
 * </ul>
 */
public final class Schedule {

    public static final Pattern TIME = Pattern.compile("([01][0-9]|2[0-3]):([0-5][0-9])");

    private Schedule() {}

    /** @return the next fire after {@code afterMs}, or null for none */
    public static Long next(String kind, List<Integer> days, String time, Integer everyMinutes, Long atMs,
            long anchorMs, long afterMs, ZoneId zone) {
        if ("once".equals(kind)) {
            return atMs != null && atMs > afterMs ? atMs : null;
        }
        if (everyMinutes != null) {
            long step = everyMinutes * 60_000L;
            if (step <= 0) {
                return null;
            }
            if (anchorMs > afterMs) {
                return anchorMs;
            }
            long steps = (afterMs - anchorMs) / step + 1;
            return anchorMs + steps * step;
        }
        if (days == null || days.isEmpty() || time == null || !TIME.matcher(time).matches()) {
            return null;
        }
        Set<DayOfWeek> on = new TreeSet<>();
        for (int day : days) {
            on.add(DayOfWeek.of(day));
        }
        LocalTime at = LocalTime.parse(time);
        LocalDate date = Instant.ofEpochMilli(afterMs).atZone(zone).toLocalDate();
        for (int i = 0; i < 9; i++) {
            LocalDate candidate = date.plusDays(i);
            if (!on.contains(candidate.getDayOfWeek())) {
                continue;
            }
            long fire = instant(LocalDateTime.of(candidate, at), zone);
            if (fire > afterMs) {
                return fire;
            }
        }
        return null;
    }

    /** A local time in the zone: in a gap, the gap's end; in an overlap, the earlier. */
    static long instant(LocalDateTime local, ZoneId zone) {
        ZoneOffsetTransition transition = zone.getRules().getTransition(local);
        if (transition != null && transition.isGap()) {
            return transition.getInstant().toEpochMilli();
        }
        return local.atZone(zone).toInstant().toEpochMilli();
    }
}
