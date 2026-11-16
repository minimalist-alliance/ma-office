package com.minimalistalliance.desk.deskd.docs;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Documents' words (deskd {@code API.md} §25 "Reasons"; the concept's §20): what a reason code says, at most six words,
 * the same in the office and in Desk Maia's handover. Braces are filled from desk records (data, at most 60 characters).
 */
final class Words {

    private Words() {}

    static final Map<String, String> PLACE = Map.of("needs", "Needs you", "maybe", "Maybe", "read", "Read later",
            "records", "Records", "working", "Working on");

    static final Map<String, String> DANGER = Map.of("program", "Program", "script", "Script", "macros", "Macros",
            "shortcut", "Shortcut", "disk_image", "Disk image", "archive_programs", "Archive with programs", "html",
            "Web page", "archive_unread", "Archive");

    static final Map<String, String> ASK_WORD = Map.of("sign", "Asks you to sign", "pay", "Asks you to pay", "reply",
            "Asks for your reply", "approve", "Asks you to approve", "decide", "Asks you to decide", "review",
            "Asks you to review");

    static final String END = "That\u2019s all for now.";

    /** The reason's words. {@code arg} is the code's one value (a name, a page, a day), or null. */
    static String reason(String code, String arg, Long dueAt, ZoneId zone, long now) {
        String who = arg == null || arg.isBlank() ? "someone" : arg;
        return switch (code) {
            case "due" -> due(dueAt, zone, now);
            case "todo" -> "On your to-do";
            case "changed" -> arg != null && arg.matches("[0-9]{1,3}(,[0-9]{1,3})*") ? pages(arg) : who + " changed it";
            case "newver" -> "New version from " + who;
            case "from" -> "From " + who;
            case "thread" -> "In your thread with " + first(who);
            case "made" -> "Made for you by " + who;
            case "always" -> "You asked to always see these";
            case "rule" -> "Your rule: " + PLACE.getOrDefault(arg, "Records");
            case "again" -> "You keep coming back to it";
            case "close" -> "Goes with this";
            case "new_sender" -> "New sender";
            case "first_kind" -> "First of its kind";
            case "fields" -> "Has empty signature fields";
            case "sign" -> arg == null ? "Asks you to sign" : "Asks you to sign · p. " + arg;
            case "pay" -> arg == null ? "Asks you to pay" : "Asks you to pay by " + arg;
            case "reply" -> "Asks for your reply";
            case "approve" -> "Asks you to approve";
            case "decide" -> "Asks you to decide";
            case "review" -> "Asks you to review";
            case "receipt" -> "A receipt";
            case "danger" -> DANGER.getOrDefault(arg, "File") + ". Maia won\u2019t open this.";
            case "download" -> "Downloaded " + dayWord(arg, zone, now);
            case "updates" -> "From a newsletter";
            case "own" -> "Added by you";
            case "agent" -> "Made by " + who;
            default -> "Kept in Records";
        };
    }

    /** "Page 3 changed" / "Pages 3 and 7 changed" / "Pages 2, 4 and 9 changed". */
    static String pages(String csv) {
        String[] p = csv.split(",");
        if (p.length == 1) {
            return "Page " + p[0] + " changed";
        }
        if (p.length > 4) {
            return p.length + " pages changed";
        }
        StringBuilder b = new StringBuilder("Pages ");
        for (int i = 0; i < p.length; i++) {
            if (i > 0) {
                b.append(i == p.length - 1 ? " and " : ", ");
            }
            b.append(p[i]);
        }
        return b.append(" changed").toString();
    }

    static String pages(List<Integer> pages) {
        if (pages.isEmpty()) {
            return "Nothing changed";
        }
        StringBuilder csv = new StringBuilder();
        for (int p : pages) {
            if (csv.length() > 0) {
                csv.append(',');
            }
            csv.append(p);
        }
        return pages(csv.toString());
    }

    static String due(Long dueAt, ZoneId zone, long now) {
        if (dueAt == null) {
            return "Due soon";
        }
        long hours = (dueAt - now) / 3_600_000L;
        LocalDate day = Instant.ofEpochMilli(dueAt).atZone(zone).toLocalDate();
        LocalDate today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate();
        if (dueAt < now) {
            return "Was due " + shortDay(day, today);
        }
        if (day.equals(today)) {
            return hours >= 1 && hours < 12 ? "Due in " + hours + (hours == 1 ? " hour" : " hours") : "Due today";
        }
        return "Due " + shortDay(day, today);
    }

    private static String shortDay(LocalDate day, LocalDate today) {
        long days = ChronoUnit.DAYS.between(today, day);
        if (days == 1) {
            return "tomorrow";
        }
        if (days == -1) {
            return "yesterday";
        }
        if (days > 1 && days < 7) {
            return day.getDayOfWeek().getDisplayName(java.time.format.TextStyle.SHORT, Locale.ENGLISH);
        }
        return day.format(DateTimeFormatter.ofPattern("d MMM", Locale.ENGLISH));
    }

    private static String dayWord(String atMs, ZoneId zone, long now) {
        try {
            LocalDate d = Instant.ofEpochMilli(Long.parseLong(atMs)).atZone(zone).toLocalDate();
            LocalDate today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate();
            return d.equals(today) ? "today" : shortDay(d, today);
        } catch (RuntimeException e) {
            return "recently";
        }
    }

    /** "12 Nov" in the member's zone. */
    static String day(long at, ZoneId zone) {
        ZonedDateTime z = Instant.ofEpochMilli(at).atZone(zone);
        return z.format(DateTimeFormatter.ofPattern("d MMM", Locale.ENGLISH));
    }

    static String first(String name) {
        int sp = name.indexOf(' ');
        return sp > 0 ? name.substring(0, sp) : name;
    }

    /** "3 copies: Mail, Downloads, Files". */
    static String copies(List<String> places) {
        return places.size() + " copies: " + String.join(", ", places);
    }

    static String sensitive(String who) {
        return who == null ? "A letter. Open to read." : "A letter from " + who + ". Open to read.";
    }
}
