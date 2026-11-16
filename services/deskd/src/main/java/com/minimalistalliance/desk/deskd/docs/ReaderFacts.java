package com.minimalistalliance.desk.deskd.docs;

import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * deskd's own check of the reader's facts (API.md §25), whatever desk-agent checked: the same closed words, a real date
 * (made the member's end of business that day), pages as numbers, lines of at most 90 plain characters. Anything else is
 * dropped; a malformed answer is nothing at all.
 */
final class ReaderFacts {

    static final Set<String> WHAT = Set.of("invoice", "contract", "statement", "receipt", "confirmation", "letter", "form",
            "report", "slides", "sheet", "photo", "other");
    static final Set<String> ASKS = Set.of("sign", "pay", "approve", "reply", "review", "decide");
    private static final Pattern UNSAFE = Pattern.compile("(?i)(https?:|www\\.|://|[<>\\[\\]{}`*_#|]|@[a-z0-9-]+\\.|\\p{Cc})");
    /** desk-agent's To-do link check (TodoFiler.LINKISH): schemes, addresses, and a name with a dot and letters not a file's ending. */
    private static final Pattern LINKISH = Pattern.compile(
            "(?i)(?:[a-z][a-z0-9+.-]*://|www\\.|@[a-z0-9-]+\\.|mailto:|javascript:|data:|\\b[a-z0-9][a-z0-9-]*"
                    + "(?:\\.[a-z0-9-]+)*\\.(?!(?:pdf|docx?|xlsx?|pptx?|txt|csv|png|jpe?g|gif|heic|zip|md|ics)\\b)"
                    + "[a-z][a-z0-9-]{1,23}\\b)");

    private ReaderFacts() {}

    static Map<String, Object> check(Map<String, Object> f, ZoneId zone, long now) {
        return check(f, zone, now, Integer.MAX_VALUE, true);
    }

    /** As desk-agent checks them (DOC-I1): a due year 2000 to 2100, pages the document has, a change line only for two versions. */
    static Map<String, Object> check(Map<String, Object> f, ZoneId zone, long now, int pageCount, boolean twoVersions) {
        if (f == null) {
            return null;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("what", f.get("what") instanceof String w && WHAT.contains(w) ? w : "other");
        List<String> asks = new ArrayList<>();
        if (f.get("asks") instanceof List<?> l) {
            for (Object o : l) {
                if (o instanceof String a && ASKS.contains(a) && !asks.contains(a)) {
                    asks.add(a);
                }
            }
        }
        out.put("asks", asks);
        if (f.get("due") instanceof String d && d.matches("\\d{4}-\\d{2}-\\d{2}")) {
            try {
                LocalDate day = LocalDate.parse(d);
                if (day.getYear() < 2000 || day.getYear() > 2100) {
                    throw new IllegalArgumentException("year");
                }
                out.put("due", day.toString());
                out.put("dueAt", day.atTime(LocalTime.of(17, 0)).atZone(zone).toInstant().toEpochMilli());
            } catch (RuntimeException e) {
                out.put("due", null);
            }
        } else {
            out.put("due", null);
        }
        Map<String, Object> pages = new LinkedHashMap<>();
        if (f.get("pages") instanceof Map<?, ?> pm) {
            for (Map.Entry<?, ?> e : pm.entrySet()) {
                if (e.getKey() instanceof String k && asks.contains(k) && e.getValue() instanceof Number n && n.intValue() >= 1
                        && n.intValue() <= Math.min(500, pageCount) && n.doubleValue() == n.intValue()) {
                    pages.put(k, n.intValue());
                }
            }
        }
        out.put("pages", pages);
        out.put("line", line(f.get("line")));
        String change = twoVersions ? line(f.get("changeLine")) : null;
        if (change != null) {
            out.put("changeLine", change);
        }
        out.put("sensitive", Boolean.TRUE.equals(f.get("sensitive")));
        out.put("model", "read");
        out.put("at", now);
        return out;
    }

    static String line(Object o) {
        if (!(o instanceof String s)) {
            return null;
        }
        String t = s.replaceAll("(?U)\\s+", " ").strip();
        if (t.isEmpty() || t.length() > 90 || hidden(t)) {
            return null;
        }
        // Read as a browser would: look-alike full stops and fullwidth letters folded, then the same checks (DOC-I1).
        String reads = java.text.Normalizer.normalize(t, java.text.Normalizer.Form.NFKC).replaceAll("[\u3002\uFF0E\uFF61]", ".");
        for (String form : java.util.List.of(t, reads)) {
            if (UNSAFE.matcher(form).find() || LINKISH.matcher(form).find()) {
                return null;
            }
        }
        return t;
    }

    /** Format characters (zero-width, bidi controls and isolates), private use, unassigned, line and paragraph separators. */
    static boolean hidden(String t) {
        for (int i = 0; i < t.length(); ) {
            int cp = t.codePointAt(i);
            int type = Character.getType(cp);
            if (type == Character.FORMAT || type == Character.PRIVATE_USE || type == Character.UNASSIGNED
                    || type == Character.LINE_SEPARATOR || type == Character.PARAGRAPH_SEPARATOR || type == Character.SURROGATE) {
                return true;
            }
            i += Character.charCount(cp);
        }
        return false;
    }
}
