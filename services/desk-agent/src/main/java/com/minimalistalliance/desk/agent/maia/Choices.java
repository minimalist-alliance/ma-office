package com.minimalistalliance.desk.agent.maia;

import com.minimalistalliance.desk.agent.json.Json;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Multiple-choice replies and the member's weight for them (the owner, Nov 12: "she needs to offer multiple choice
 * responses as often as is possible ... track how often users ignore the MC response or provide an other response which
 * should influence how often Maia will use MC prompting ... if the user asks for more MC prompting this obviously raises
 * the weight back up"; {@code API.md} §23, "A chat turn, with choices").
 *
 * <p><b>Counts only, never text.</b> What's kept is seven numbers and a time: offered, tapped, other, ignored, asked
 * for more, asked for fewer, and the weight. Whether a message asks for more or fewer is read here, in code, from the
 * member's message as it goes by, and nothing of the message is kept. The weight lives on the home desk, so every
 * device the member uses sees the same one, and {@link #reset} starts it again.
 *
 * <p><b>The rule.</b> The weight starts at {@link #START}. A tap raises it by {@link #TAP}; "Other" lowers it by
 * {@link #OTHER} and passing the choices by (writing something else) by {@link #IGNORED}; asking for choices puts it
 * back to at least {@link #START}, and asking for fewer to at most {@link #FEWER_CEILING}. Her context gets the rule
 * ({@link #RULE}: offer choices above {@link #THRESHOLD}, and always for a decision with clear options or an OK), which
 * never changes, and her note the weight ({@link #weightLine}), which moves with most taps and passes: kept out of the
 * context so the provider's cache holds it (Nov 15).
 */
public final class Choices {

    public static final double START = 0.8;
    public static final double THRESHOLD = 0.5;
    static final double TAP = 0.06;
    static final double OTHER = 0.08;
    static final double IGNORED = 0.10;
    static final double FEWER_CEILING = 0.3;

    /** At most this many options, and at least two; each label this long at most. */
    public static final int MAX_OPTIONS = 4;
    public static final int MIN_OPTIONS = 2;
    public static final int MAX_LABEL = 40;
    public static final int MAX_QUESTION = 200;

    private static final Pattern FEWER = Pattern.compile(
            "\\b(?:no|stop|fewer|less|without|quit|don'?t (?:give|offer|show) me|enough)\\b[^.?!]{0,24}"
                    + "\\b(?:options|choices|multiple[\\s-]?choice|buttons)\\b"
                    + "|\\bjust ask me\\b|\\blet me (?:just )?type\\b",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern MORE = Pattern.compile(
            "\\bmultiple[\\s-]?choice\\b|\\b(?:give|show|offer|send) me (?:some |a few |more )?(?:options|choices)\\b"
                    + "|\\b(?:more|some) (?:options|choices)\\b|\\boptions,? please\\b|\\bchoices,? please\\b"
                    + "|\\bgive me (?:a )?(?:menu|list) to pick\\b",
            Pattern.CASE_INSENSITIVE);

    /** What a member's message says about choices, read in code. */
    public enum Ask {
        NONE,
        MORE,
        FEWER
    }

    /** The counts, as kept. */
    public record Counts(double weight, long offered, long tapped, long other, long ignored, long askedMore,
            long askedFewer, long updatedAt) {

        static Counts fresh(long now) {
            return new Counts(START, 0, 0, 0, 0, 0, 0, now);
        }

        public Map<String, Object> view() {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("weight", round(weight));
            v.put("offered", offered);
            v.put("tapped", tapped);
            v.put("other", other);
            v.put("ignored", ignored);
            v.put("askedMore", askedMore);
            v.put("askedFewer", askedFewer);
            v.put("updatedAt", updatedAt);
            return v;
        }
    }

    private final MaiaStore store;
    private final Clock clock;
    private final Object lock = new Object();

    public Choices(MaiaStore store, Clock clock) {
        this.store = store;
        this.clock = clock;
    }

    /** The member's message read for an ask for more or fewer choices. Fewer wins when both match. */
    public static Ask ask(String text) {
        if (text == null || text.isBlank()) {
            return Ask.NONE;
        }
        String t = text.toLowerCase(Locale.ROOT);
        if (FEWER.matcher(t).find()) {
            return Ask.FEWER;
        }
        return MORE.matcher(t).find() ? Ask.MORE : Ask.NONE;
    }

    /** The weight after one event: the rule, as one pure function so a test can walk it. */
    static double next(double w, String event) {
        double out = switch (event) {
            case "tapped" -> w + TAP;
            case "other" -> w - OTHER;
            case "ignored" -> w - IGNORED;
            case "askedMore" -> Math.max(w, START);
            case "askedFewer" -> Math.min(w, FEWER_CEILING);
            default -> w;
        };
        return Math.max(0, Math.min(1, out));
    }

    public Counts counts() throws SQLException {
        String raw = store.setting(MaiaStore.CHOICES);
        if (raw == null) {
            return Counts.fresh(clock.millis());
        }
        Map<String, Object> m = MaiaStore.parse(raw);
        double weight = m.get("weight") instanceof Number n ? n.doubleValue() : START;
        if (!(weight >= 0 && weight <= 1)) {
            weight = START;
        }
        return new Counts(weight, num(m, "offered"), num(m, "tapped"), num(m, "other"), num(m, "ignored"),
                num(m, "askedMore"), num(m, "askedFewer"), num(m, "updatedAt"));
    }

    /** One event: {@code offered}, {@code tapped}, {@code other}, {@code ignored}, {@code askedMore}, {@code askedFewer}. */
    public Counts record(String event) throws SQLException {
        synchronized (lock) {
            Counts c = counts();
            double w = next(c.weight(), event);
            Counts n = new Counts(w,
                    c.offered() + ("offered".equals(event) ? 1 : 0),
                    c.tapped() + ("tapped".equals(event) ? 1 : 0),
                    c.other() + ("other".equals(event) ? 1 : 0),
                    c.ignored() + ("ignored".equals(event) ? 1 : 0),
                    c.askedMore() + ("askedMore".equals(event) ? 1 : 0),
                    c.askedFewer() + ("askedFewer".equals(event) ? 1 : 0),
                    clock.millis());
            store.setSetting(MaiaStore.CHOICES, new String(Json.bytes(n.view()), StandardCharsets.UTF_8));
            return n;
        }
    }

    public Counts reset() throws SQLException {
        synchronized (lock) {
            Counts n = Counts.fresh(clock.millis());
            store.setSetting(MaiaStore.CHOICES, new String(Json.bytes(n.view()), StandardCharsets.UTF_8));
            return n;
        }
    }

    /** The rule her context gets, as the concept states it: the same on every call; the weight is in her note. */
    public static final String RULE = "Offer choices when your choice weight for this member (in the home desk's note)"
            + " is above " + THRESHOLD + ", and always for a decision with clear options or anything that needs the"
            + " member's OK, however low the weight.";

    /** The line her note gets: the weight now. */
    public static String weightLine(double weight) {
        return "Your choice weight for this member is " + round(weight) + " (0 to 1).";
    }

    /**
     * Choices as the model asked for them ({@code ask_member}), checked in code: a question of 1 to
     * {@link #MAX_QUESTION} characters, {@link #MIN_OPTIONS} to {@link #MAX_OPTIONS} distinct labels of 1 to
     * {@link #MAX_LABEL} characters each, plain text on one line with no link or Markdown; the first is her pick.
     *
     * @return the reply's {@code choices}, or null with the reason in {@code why[0]}
     */
    public static Map<String, Object> shape(Object question, Object options, String[] why) {
        String q = MaiaAgent.plain(question, MAX_QUESTION + 1);
        if (q.isEmpty() || q.codePointCount(0, q.length()) > MAX_QUESTION) {
            why[0] = "question";
            return null;
        }
        if (!(options instanceof java.util.List<?> list) || list.size() < MIN_OPTIONS || list.size() > MAX_OPTIONS) {
            why[0] = "options";
            return null;
        }
        java.util.List<Map<String, Object>> out = new java.util.ArrayList<>();
        java.util.Set<String> seen = new java.util.HashSet<>();
        int i = 0;
        for (Object o : list) {
            String label = MaiaAgent.plain(o, MAX_LABEL + 1);
            if (label.isEmpty() || label.codePointCount(0, label.length()) > MAX_LABEL || looksLikeMarkup(label)
                    || !seen.add(label.toLowerCase(Locale.ROOT))) {
                why[0] = "options";
                return null;
            }
            Map<String, Object> option = new LinkedHashMap<>();
            option.put("id", "c" + (++i));
            option.put("label", label);
            out.add(option);
        }
        Map<String, Object> choices = new LinkedHashMap<>();
        choices.put("question", q);
        choices.put("options", out);
        choices.put("recommended", "c1");
        choices.put("other", true);
        choices.put("state", "open");
        choices.put("answer", null);
        return choices;
    }

    /** A link, a Markdown link or emphasis, or HTML: a choice is a few plain words. */
    static boolean looksLikeMarkup(String label) {
        String l = label.toLowerCase(Locale.ROOT);
        return l.contains("://") || l.contains("www.") || l.contains("](") || l.contains("<") || l.contains(">")
                || l.contains("**") || l.contains("`") || l.matches(".*\\b[a-z0-9-]+\\.(?:com|net|org|io|co|ai)\\b.*");
    }

    private static long num(Map<String, Object> m, String key) {
        return m.get(key) instanceof Number n ? Math.max(0, n.longValue()) : 0;
    }

    static double round(double w) {
        return Math.round(w * 100) / 100.0;
    }
}
