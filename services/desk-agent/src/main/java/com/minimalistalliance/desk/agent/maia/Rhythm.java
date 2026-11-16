package com.minimalistalliance.desk.agent.maia;

import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.TextStyle;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The shield's daily rhythm (the shield concept §5.5, §6): the member's day by the clock (work hours, focus hours,
 * evenings, quiet hours, weekends), the catch-up times, and a catch-up's shape: at most 7 lines after grouping, in the
 * order <b>Needs you · Working on · Read later · Records · Done for you</b>, "Cleared without you: n", then "That's all
 * for now." Words are code's templates: a catch-up costs nothing. Pure.
 */
public final class Rhythm {

    public static final String END = "That’s all for now.";
    /** A catch-up, at most this many lines after grouping. */
    public static final int CATCHUP_MAX = 7;
    /** The morning brief, at most. */
    public static final int BRIEF_MAX = 3;
    /** A catch-up that comes while the member is busy waits for a coarse break this long, then the line says so. */
    public static final long CATCHUP_WAIT_MS = 60 * 60_000L;

    private Rhythm() {}

    /** The member's day now, by the clock and their settings. */
    public record Day(ZoneId zone, String part, boolean workday, boolean workHours, boolean deep, boolean evening,
            boolean quiet, boolean weekend, boolean holdWork) {}

    /** Work hours: the span of the catch-ups (9:00 to 5:00 when there are fewer than two), weekdays. */
    static Reach.Span work(Reach.Settings s) {
        List<LocalTime> c = s.catchUps();
        if (c.size() < 2) {
            return new Reach.Span(LocalTime.of(9, 0), LocalTime.of(17, 0));
        }
        return new Reach.Span(c.get(0), c.get(c.size() - 1));
    }

    /** Quiet hours: the member's, else two hours after the last catch-up until the first (7:00 pm to 9:00 am). */
    static Reach.Span quiet(Reach.Settings s) {
        if (s.quietHours() != null) {
            return s.quietHours();
        }
        Reach.Span w = work(s);
        return new Reach.Span(w.to().plusHours(2), w.from());
    }

    public static Day day(long now, ZoneId zone, Reach.Settings s, long holdWorkUntil) {
        ZonedDateTime t = Instant.ofEpochMilli(now).atZone(zone);
        LocalTime time = t.toLocalTime();
        boolean weekend = t.getDayOfWeek() == DayOfWeek.SATURDAY || t.getDayOfWeek() == DayOfWeek.SUNDAY;
        Reach.Span w = work(s);
        boolean workHours = !weekend && w.contains(time);
        boolean quiet = quiet(s).contains(time);
        boolean deep = !weekend && s.focusHours().stream().anyMatch(f -> f.contains(time));
        boolean evening = !weekend && !workHours && !quiet && !time.isBefore(w.to());
        boolean holdWork = holdWorkUntil > now;
        String part = quiet ? "quiet" : weekend ? "weekend" : deep ? "deep" : workHours ? "work" : evening ? "evening"
                : "before";
        return new Day(zone, part, !weekend, workHours, deep, evening, quiet, weekend, holdWork);
    }

    /** Today's catch-up times as instants (weekends: only the first, for Personal). */
    static List<Long> times(long now, ZoneId zone, Reach.Settings s) {
        ZonedDateTime t = Instant.ofEpochMilli(now).atZone(zone);
        LocalDate d = t.toLocalDate();
        boolean weekend = t.getDayOfWeek() == DayOfWeek.SATURDAY || t.getDayOfWeek() == DayOfWeek.SUNDAY;
        List<Long> out = new ArrayList<>();
        for (LocalTime c : s.catchUps()) {
            out.add(d.atTime(c).atZone(zone).toInstant().toEpochMilli());
            if (weekend) {
                break;
            }
        }
        return out;
    }

    /** The latest catch-up time today at or before now that's after {@code givenAt}, or null. */
    public static Long due(long now, ZoneId zone, Reach.Settings s, long givenAt) {
        Long due = null;
        for (long at : times(now, zone, s)) {
            if (at <= now && at > givenAt) {
                due = at;
            }
        }
        return due;
    }

    /** The next catch-up time after {@code now}, looking up to 4 days ahead, or null with none set. */
    public static Long next(long now, ZoneId zone, Reach.Settings s) {
        if (s.catchUps().isEmpty()) {
            return null;
        }
        for (int i = 0; i < 4; i++) {
            long dayAt = Instant.ofEpochMilli(now).atZone(zone).toLocalDate().plusDays(i).atStartOfDay(zone)
                    .toInstant().toEpochMilli() + 12 * 3_600_000L;
            for (long at : times(dayAt, zone, s)) {
                if (at > now) {
                    return at;
                }
            }
        }
        return null;
    }

    /**
     * The next moment the day's part changes by the clock (focus, quiet and work hours, catch-ups), today or tomorrow.
     */
    public static long nextBoundary(long now, ZoneId zone, Reach.Settings s) {
        List<LocalTime> marks = new ArrayList<>();
        for (Reach.Span f : s.focusHours()) {
            marks.add(f.from());
            marks.add(f.to());
        }
        Reach.Span q = quiet(s);
        marks.add(q.from());
        marks.add(q.to());
        Reach.Span w = work(s);
        marks.add(w.from());
        marks.add(w.to());
        LocalDate d = Instant.ofEpochMilli(now).atZone(zone).toLocalDate();
        long best = Long.MAX_VALUE;
        for (int i = 0; i < 2; i++) {
            for (LocalTime t : marks) {
                long at = d.plusDays(i).atTime(t).atZone(zone).toInstant().toEpochMilli();
                if (at > now && at < best) {
                    best = at;
                }
            }
        }
        return best;
    }

    /** The next catch-up at or after the start of the next workday (for "Hold Work until tomorrow at 9"). */
    public static long nextWorkdayStart(long now, ZoneId zone, Reach.Settings s) {
        LocalDate d = Instant.ofEpochMilli(now).atZone(zone).toLocalDate().plusDays(1);
        while (d.getDayOfWeek() == DayOfWeek.SATURDAY || d.getDayOfWeek() == DayOfWeek.SUNDAY) {
            d = d.plusDays(1);
        }
        return d.atTime(work(s).from()).atZone(zone).toInstant().toEpochMilli();
    }

    /** The last catch-up strictly after {@code now} and at or before {@code deadline}, or null (the deadline floor). */
    public static Long lastBefore(long deadline, long now, ZoneId zone, Reach.Settings s) {
        Long last = null;
        Long at = next(now, zone, s);
        int guard = 0;
        while (at != null && at <= deadline && guard++ < 40) {
            last = at;
            at = next(at, zone, s);
        }
        return last;
    }

    /** Whether {@code at} is today's last catch-up. */
    static boolean last(long at, ZoneId zone, Reach.Settings s) {
        List<Long> t = times(at, zone, s);
        return !t.isEmpty() && t.get(t.size() - 1) == at;
    }

    /** Whether {@code at} is today's first catch-up. */
    static boolean first(long at, ZoneId zone, Reach.Settings s) {
        List<Long> t = times(at, zone, s);
        return !t.isEmpty() && t.get(0) == at;
    }

    // ---------------------------------------------------------------- words

    /** "1:00", "11:30": the concept's clock words, in the desk's zone. */
    public static String clock(long at, ZoneId zone) {
        ZonedDateTime t = Instant.ofEpochMilli(at).atZone(zone);
        int h = t.getHour() % 12 == 0 ? 12 : t.getHour() % 12;
        return h + ":" + String.format(Locale.ROOT, "%02d", t.getMinute());
    }

    /** "today", "tomorrow", "yesterday", else the weekday ("Tue"), else "Nov 18". */
    public static String dayWords(long at, long now, ZoneId zone) {
        LocalDate a = Instant.ofEpochMilli(at).atZone(zone).toLocalDate();
        LocalDate n = Instant.ofEpochMilli(now).atZone(zone).toLocalDate();
        long days = a.toEpochDay() - n.toEpochDay();
        if (days == 0) {
            return "today";
        }
        if (days == 1) {
            return "tomorrow";
        }
        if (days == -1) {
            return "yesterday";
        }
        if (Math.abs(days) < 7) {
            return a.getDayOfWeek().getDisplayName(TextStyle.SHORT, Locale.ENGLISH);
        }
        return a.getMonth().getDisplayName(TextStyle.SHORT, Locale.ENGLISH) + " " + a.getDayOfMonth();
    }

    static String date(long at, ZoneId zone) {
        LocalDate a = Instant.ofEpochMilli(at).atZone(zone).toLocalDate();
        return a.getMonth().getDisplayName(TextStyle.SHORT, Locale.ENGLISH) + " " + a.getDayOfMonth();
    }

    static String things(int n) {
        return n == 1 ? "1 thing" : n + " things";
    }

    static String count(int n, String one, String many) {
        return n + " " + (n == 1 ? one : many);
    }

    // ---------------------------------------------------------------- a catch-up

    /** One line of a catch-up: an item with its action and chips. */
    public record Line(String itemKey, String itemId, String line, Map<String, Object> go, String goLabel,
            List<Map<String, Object>> choices) {
        Map<String, Object> view() {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("itemId", itemId);
            v.put("line", line);
            v.put("go", go);
            v.put("goLabel", goLabel);
            v.put("choices", choices);
            return v;
        }
    }

    public record Group(String id, String label, List<Line> items, String summary) {
        Map<String, Object> view() {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("id", id);
            v.put("label", label);
            v.put("items", items.stream().map(Line::view).toList());
            v.put("summary", summary);
            return v;
        }
    }

    public record CatchUp(String catchupId, String kind, String head, List<Group> groups, List<String> lines,
            Map<String, Object> question, long at, boolean waiting, List<String> itemKeys) {
        public CatchUp {
            groups = List.copyOf(groups);
            lines = List.copyOf(lines);
            itemKeys = List.copyOf(itemKeys);
        }

        int size() {
            int n = 0;
            for (Group g : groups) {
                n += g.items().size() + (g.summary() == null ? 0 : 1);
            }
            return n;
        }

        Map<String, Object> view() {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("catchupId", catchupId);
            v.put("kind", kind);
            v.put("head", head);
            v.put("groups", groups.stream().map(Group::view).toList());
            v.put("lines", lines);
            v.put("question", question);
            v.put("end", END);
            v.put("at", at);
            v.put("waiting", waiting);
            return v;
        }

        CatchUp shown() {
            return new CatchUp(catchupId, kind, head, groups, lines, question, at, false, itemKeys);
        }
    }

    /** One item offered to a catch-up, already placed in a group by the shield. */
    public record Entry(Reach.Item item, String group, Line line) {}

    static final List<String> ORDER = List.of("needs_you", "working_on", "read_later", "records", "done_for_you");
    static final Map<String, String> LABELS = Map.of("needs_you", "Needs you", "working_on", "Working on",
            "read_later", "Read later", "records", "Records", "done_for_you", "Done for you");

    /**
     * A catch-up from what's held: at most {@link #CATCHUP_MAX} lines (the brief: {@link #BRIEF_MAX} items). Needs you
     * and Working on are one line each; Read later and Records are counted by kind ("4 updates"); what didn't fit stays
     * in To-do and is said in one line. Null when there's nothing to say: a catch-up that finds nothing says nothing.
     */
    static CatchUp build(String catchupId, String kind, String head0, long now, List<Entry> entries, List<String> done,
            int cleared, List<String> extra, Map<String, Object> question, boolean waiting) {
        boolean brief = "brief".equals(kind);
        int max = brief ? BRIEF_MAX : CATCHUP_MAX;
        Map<String, List<Entry>> by = new LinkedHashMap<>();
        for (String g : ORDER) {
            by.put(g, new ArrayList<>());
        }
        for (Entry e : entries) {
            by.computeIfAbsent(e.group(), k -> new ArrayList<>()).add(e);
        }
        List<Group> groups = new ArrayList<>();
        List<String> keys = new ArrayList<>();
        int used = 0;
        int left = 0;
        // Summary lines first reserve their place so the tail is never cut for a long head.
        int tail = 0;
        if (!brief) {
            tail += by.get("read_later").isEmpty() ? 0 : 1;
            tail += by.get("records").isEmpty() ? 0 : 1;
            tail += done.isEmpty() ? 0 : 1;
        }
        // Needs you and Working on: one line each; past the room, the rest of a group is counted in one line ("And 4
        // more: 3 messages · 1 answer"), so every held thing is said at a catch-up and nothing is left out silently.
        // The brief keeps its 3 and leaves the rest for the next catch-up.
        List<Entry> need = by.get("needs_you");
        List<Entry> work = by.get("working_on");
        int room = max - tail;
        int[] budget;
        if (brief) {
            int b1 = Math.min(need.size(), room);
            budget = new int[] {b1, Math.min(work.size(), room - b1)};
        } else if (need.size() + work.size() <= room) {
            budget = new int[] {need.size(), work.size()};
        } else {
            int b1 = Math.min(need.size(), room - (work.isEmpty() ? 0 : 1));
            budget = new int[] {b1, Math.max(0, room - b1)};
        }
        int gi = 0;
        for (String g : List.of("needs_you", "working_on")) {
            List<Entry> es = by.get(g);
            int lines0 = budget[gi++];
            List<Line> lines = new ArrayList<>();
            List<Entry> rest = new ArrayList<>();
            boolean overflow = es.size() > lines0;
            int individual = overflow && !brief ? Math.max(0, lines0 - 1) : lines0;
            for (int k = 0; k < es.size(); k++) {
                if (k < individual) {
                    lines.add(es.get(k).line());
                    keys.add(es.get(k).item().key());
                    used++;
                } else if (!brief && lines0 > 0) {
                    rest.add(es.get(k));
                } else {
                    left++;
                }
            }
            String summary = null;
            if (!rest.isEmpty()) {
                summary = (lines.isEmpty() ? "" : "And " + rest.size() + " more: ") + kindsLine(rest);
                for (Entry e : rest) {
                    keys.add(e.item().key());
                }
                used++;
            }
            if (!lines.isEmpty() || summary != null) {
                groups.add(new Group(g, LABELS.get(g), lines, summary));
            }
        }
        if (brief) {
            left += by.get("read_later").size() + by.get("records").size();
        } else {
            for (String g : List.of("read_later", "records")) {
                List<Entry> es = by.get(g);
                if (es.isEmpty()) {
                    continue;
                }
                if (used >= max) {
                    left += es.size();
                    continue;
                }
                groups.add(new Group(g, LABELS.get(g), List.of(), kindsLine(es)));
                for (Entry e : es) {
                    keys.add(e.item().key());
                }
                used++;
            }
            if (!done.isEmpty() && used < max) {
                groups.add(new Group("done_for_you", LABELS.get("done_for_you"), List.of(), String.join(" · ",
                        done)));
                used++;
            }
        }
        List<String> lines = new ArrayList<>();
        if (cleared > 0 && !brief) {
            lines.add("Cleared without you: " + count(cleared, "update", "updates"));
        }
        if (left > 0) {
            lines.add(left == 1 ? "1 more is in To-do" : left + " more are in To-do");
        }
        lines.addAll(extra);
        if (groups.isEmpty() && question == null && extra.isEmpty()) {
            return null;
        }
        int items = keys.size();
        String head = head0 != null ? head0 : brief ? (items == 0 ? "Good morning." : "Good morning. "
                + (items == 1 ? "One thing" : words(items) + " things") + " today.") : head0;
        return new CatchUp(catchupId, kind, head, groups, lines, question, now, waiting, keys);
    }

    /** "4 updates · 2 documents": a group's kinds, counted. */
    static String kindsLine(List<Entry> es) {
        Map<String, Integer> n = new LinkedHashMap<>();
        for (Entry e : es) {
            n.merge(kindWord(e.item()), Math.max(1, e.item().count()), Integer::sum);
        }
        List<String> parts = new ArrayList<>();
        for (Map.Entry<String, Integer> e : n.entrySet()) {
            String[] w = e.getKey().split("\\|");
            parts.add(count(e.getValue(), w[0], w[1]));
        }
        return String.join(" · ", parts);
    }

    static String kindWord(Reach.Item i) {
        return switch (i.kind()) {
            case "message" -> "message|messages";
            case "doc" -> i.record() ? "record|records" : "document|documents";
            case "result" -> "answer|answers";
            case "notes", "notes_unsure" -> "note|notes";
            case "desk_asleep" -> "desk asleep|desks asleep";
            case "todos" -> "to-do|to-dos";
            case "account" -> "notice|notices";
            default -> "update|updates";
        };
    }

    static String words(int n) {
        return switch (n) {
            case 2 -> "Two";
            case 3 -> "Three";
            default -> String.valueOf(n);
        };
    }
}
