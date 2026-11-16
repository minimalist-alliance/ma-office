package com.minimalistalliance.desk.deskd.courier.store;

import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * A member's search, by Notebook search's rules (agent tools draft §12): every word must match, by prefix at a word
 * start, ignoring case and accents; "quoted phrases" match as phrases; and {@code from:}, {@code to:},
 * {@code has:attachment}, {@code before:}, {@code after:}, {@code in:} and {@code is:unread} narrow it (plan §2.5).
 *
 * <p>Nothing a member types is an FTS5 operator: each word and phrase is quoted, its quotes doubled, so {@code NEAR},
 * {@code OR}, {@code -}, {@code ^}, {@code *}, {@code :} and parentheses are only text.
 */
public final class SearchQuery {

    public static final int MAX_CHARS = 500;
    public static final int MAX_TERMS = 16;
    private static final int MAX_TERM = 100;

    final List<String> words = new ArrayList<>();
    final List<String> phrases = new ArrayList<>();
    final List<String> from = new ArrayList<>();
    final List<String> to = new ArrayList<>();
    boolean hasAttachment;
    boolean unread;
    LocalDate before;
    LocalDate after;
    String in;
    /** True when nothing usable was typed: no words, phrases or filters. */
    boolean empty = true;

    private SearchQuery() {}

    /**
     * @throws IllegalArgumentException with a short reason for a query that's too long, a date that isn't one, or an
     *     {@code in:} that isn't a lane
     */
    public static SearchQuery parse(String q) {
        SearchQuery s = new SearchQuery();
        if (q == null) {
            return s;
        }
        if (q.length() > MAX_CHARS) {
            throw new IllegalArgumentException("too_long");
        }
        for (String[] token : tokens(Norm.clean(q, MAX_CHARS, false))) {
            String op = token[0];
            String value = token[1];
            boolean quoted = token[2] != null;
            if (op == null) {
                if (quoted) {
                    s.addPhrase(value);
                } else {
                    s.addWord(value);
                }
                continue;
            }
            switch (op) {
                case "from" -> addTo(s.from, value);
                case "to" -> addTo(s.to, value);
                case "has" -> {
                    if (value.equalsIgnoreCase("attachment") || value.equalsIgnoreCase("attachments")) {
                        s.hasAttachment = true;
                    } else {
                        throw new IllegalArgumentException("has");
                    }
                }
                case "is" -> {
                    if (value.equalsIgnoreCase("unread")) {
                        s.unread = true;
                    } else {
                        throw new IllegalArgumentException("is");
                    }
                }
                case "before" -> s.before = date(value);
                case "after" -> s.after = date(value);
                case "in" -> {
                    String lane = value.toLowerCase(Locale.ROOT);
                    if (!Lanes.valid(lane) && !lane.equals("sent") && !lane.equals("all")) {
                        throw new IllegalArgumentException("in");
                    }
                    s.in = lane;
                }
                default -> s.addWord(op + ":" + value);
            }
        }
        s.empty = s.words.isEmpty() && s.phrases.isEmpty() && s.from.isEmpty() && s.to.isEmpty() && !s.hasAttachment
                && !s.unread && s.before == null && s.after == null && s.in == null;
        if (s.words.size() + s.phrases.size() + s.from.size() + s.to.size() > MAX_TERMS) {
            throw new IllegalArgumentException("too_many_terms");
        }
        return s;
    }

    private static LocalDate date(String value) {
        try {
            return LocalDate.parse(value.replace('/', '-'));
        } catch (DateTimeParseException e) {
            throw new IllegalArgumentException("date");
        }
    }

    private static void addTo(List<String> list, String value) {
        String t = term(value);
        if (t != null && !list.contains(t)) {
            list.add(t);
        }
    }

    private void addWord(String value) {
        String t = term(value);
        if (t != null && !words.contains(t)) {
            words.add(t);
        }
    }

    private void addPhrase(String value) {
        String t = Norm.line(Norm.fold(value), MAX_TERM);
        if (t != null && hasWordChar(t) && !phrases.contains(t)) {
            phrases.add(t);
        }
    }

    /** Folded, with what isn't a letter or digit taken off both ends, as Notebook's {@code parseQuery} does. */
    static String term(String raw) {
        if (raw == null) {
            return null;
        }
        String f = Norm.fold(raw);
        int a = 0;
        int b = f.length();
        while (a < b && !Character.isLetterOrDigit(f.codePointAt(a))) {
            a += Character.charCount(f.codePointAt(a));
        }
        while (b > a && !Character.isLetterOrDigit(f.codePointBefore(b))) {
            b -= Character.charCount(f.codePointBefore(b));
        }
        String t = f.substring(a, b);
        if (t.isEmpty()) {
            return null;
        }
        return t.length() > MAX_TERM ? t.substring(0, MAX_TERM) : t;
    }

    private static boolean hasWordChar(String s) {
        return s.codePoints().anyMatch(Character::isLetterOrDigit);
    }

    /** Splits into {op, value, quoted?}: words, "quoted phrases", and {@code op:value} with the value quoted or not. */
    static List<String[]> tokens(String q) {
        List<String[]> out = new ArrayList<>();
        int i = 0;
        int n = q.length();
        while (i < n) {
            while (i < n && Character.isWhitespace(q.charAt(i))) {
                i++;
            }
            if (i >= n) {
                break;
            }
            String op = null;
            int colon = -1;
            // An operator is a known word right before a colon.
            for (String name : new String[] {"from", "to", "has", "before", "after", "in", "is"}) {
                int len = name.length();
                if (q.regionMatches(true, i, name, 0, len) && i + len < n && q.charAt(i + len) == ':') {
                    op = name;
                    colon = i + len;
                    break;
                }
            }
            if (op != null) {
                i = colon + 1;
                if (i >= n || Character.isWhitespace(q.charAt(i))) {
                    continue;
                }
            }
            if (i < n && q.charAt(i) == '"') {
                int end = q.indexOf('"', i + 1);
                String value = end < 0 ? q.substring(i + 1) : q.substring(i + 1, end);
                i = end < 0 ? n : end + 1;
                if (!value.isBlank()) {
                    out.add(new String[] {op, value, "q"});
                }
                continue;
            }
            int start = i;
            while (i < n && !Character.isWhitespace(q.charAt(i))) {
                i++;
            }
            out.add(new String[] {op, q.substring(start, i), null});
        }
        return out;
    }

    /** Nothing usable was typed: no words, phrases or filters. */
    public boolean isEmpty() {
        return empty;
    }

    /** One FTS5 string: quoted, its quotes doubled. */
    static String quote(String s) {
        return "\"" + s.replace("\"", "\"\"") + "\"";
    }

    /** The MATCH expression, or null when only filters were given. */
    String match() {
        List<String> parts = new ArrayList<>();
        for (String w : words) {
            parts.add(quote(w) + "*");
        }
        for (String p : phrases) {
            parts.add(quote(p));
        }
        for (String f : from) {
            parts.add("{search_from} : " + quote(f) + "*");
        }
        for (String t : to) {
            parts.add("{search_to} : " + quote(t) + "*");
        }
        return parts.isEmpty() ? null : String.join(" AND ", parts);
    }

    /** What to highlight in a snippet: the words, the phrases' words and the names searched for. */
    Set<String> highlights() {
        Set<String> out = new LinkedHashSet<>(words);
        for (String p : phrases) {
            for (String w : p.split("[^\\p{L}\\p{N}]+")) {
                if (!w.isEmpty()) {
                    out.add(w);
                }
            }
        }
        return out;
    }

    /** The day's start in the zone, in ms. */
    static long startOf(LocalDate day, ZoneId zone) {
        return day.atStartOfDay(zone).toInstant().toEpochMilli();
    }
}
