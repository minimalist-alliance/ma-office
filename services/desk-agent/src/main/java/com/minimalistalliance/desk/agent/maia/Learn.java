package com.minimalistalliance.desk.agent.maia;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The shield learns from the member's choices (the shield concept §10), counts only, on the home desk: "Not important"
 * holds a class until undone; "Not now" three times in 14 days asks "Keep them for catch-ups?"; "Sooner next time"
 * pulls
 * a class 15 closer; quick acts and fast dismissals drift a class by at most ±15, with a prior of 5 so one tap does
 * little, and counts halve every 30 days so habits can change. <b>Hard limits</b>, held by {@link Reach} and
 * {@link Shield}: learning can't open the interrupt gate, can't hold a code-rule Now or a list item, and can't hide
 * anything (a held item is still counted and listed). Pure.
 */
public final class Learn {

    public static final int MAX = 15;
    static final double PRIOR = 5;
    static final long DAY = 86_400_000L;
    static final long HALF_LIFE = 30 * DAY;
    static final long NOT_NOW_WINDOW = 14 * DAY;
    static final int NOT_NOW_ASK = 3;

    private Learn() {}

    /** One class's counts: {@code r} fast dismissals and Not nows, {@code a} quick acts, and the Not nows' times. */
    public record Counts(double r, double a, long at, List<Long> notNows) {
        public Counts {
            notNows = List.copyOf(notNows);
        }

        static final Counts ZERO = new Counts(0, 0, 0, List.of());

        /** Halved every 30 days. */
        Counts decayed(long now) {
            if (at == 0 || now <= at) {
                return this;
            }
            double f = Math.pow(0.5, (now - at) / (double) HALF_LIFE);
            return new Counts(r * f, a * f, now, notNows.stream().filter(t -> now - t < NOT_NOW_WINDOW).toList());
        }

        Counts reject(long now) {
            Counts d = decayed(now);
            return new Counts(d.r() + 1, d.a(), now, d.notNows());
        }

        Counts act(long now) {
            Counts d = decayed(now);
            return new Counts(d.r(), d.a() + 1, now, d.notNows());
        }

        Counts notNow(long now) {
            Counts d = decayed(now);
            List<Long> n = new ArrayList<>(d.notNows());
            n.add(now);
            return new Counts(d.r() + 1, d.a(), now, n);
        }

        Map<String, Object> view() {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("r", r);
            v.put("a", a);
            v.put("at", at);
            v.put("notNows", notNows);
            return v;
        }

        static Counts parse(Object raw) {
            if (!(raw instanceof Map<?, ?> m)) {
                return ZERO;
            }
            List<Long> n = new ArrayList<>();
            if (m.get("notNows") instanceof List<?> l) {
                for (Object o : l) {
                    if (o instanceof Number x) {
                        n.add(x.longValue());
                    }
                }
            }
            return new Counts(num(m.get("r")), num(m.get("a")), m.get("at") instanceof Number x ? x.longValue() : 0,
                    n);
        }
    }

    private static double num(Object o) {
        return o instanceof Number n && Double.isFinite(n.doubleValue()) ? Math.max(0, n.doubleValue()) : 0;
    }

    /**
     * A learned rule, visible in What I've learned with its date and Undo. {@code effect}: {@code hold} (Not
     * important), {@code catchups} (Keep them for catch-ups), {@code sooner} (Sooner next time), {@code not_for_this}
     * (a let-through rule that doesn't apply to this kind). {@code label} is code's words with the class's kind only;
     * names are drawn at read time.
     */
    public record Rule(String ruleId, String effect, String classKey, String kind, String scope, String source,
            long at) {
        Map<String, Object> view(String line) {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("ruleId", ruleId);
            v.put("effect", effect);
            v.put("kind", kind);
            v.put("line", line);
            v.put("at", at);
            return v;
        }

        Map<String, Object> stored() {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("ruleId", ruleId);
            v.put("effect", effect);
            v.put("classKey", classKey);
            v.put("kind", kind);
            v.put("scope", scope);
            v.put("source", source);
            v.put("at", at);
            return v;
        }

        static Rule parse(Object raw) {
            if (!(raw instanceof Map<?, ?> m) || !(m.get("ruleId") instanceof String id)
                    || !(m.get("effect") instanceof String e) || !(m.get("classKey") instanceof String c)) {
                return null;
            }
            return new Rule(id, e, c, m.get("kind") instanceof String k ? k : "", m.get("scope") instanceof String s
                    ? s : null, m.get("source") instanceof String so ? so : "", m.get("at") instanceof Number n
                    ? n.longValue() : 0);
        }
    }

    /** The class a rule covers: source and kind in that scope ("Not important" holds this). */
    public static String classOf(Reach.Item item) {
        return item.from() + "|" + item.kind() + "|" + (item.scope() == null ? "-" : item.scope());
    }

    /** The class implicit counts drift: with the day part (concept §10's class key). */
    public static String driftClass(Reach.Item item, String dayPart) {
        return classOf(item) + "|" + dayPart;
    }

    /** The bounded drift: {@code round(15 × (r − a) / (r + a + 5))}, so one tap does little. */
    public static int drift(Counts c) {
        if (c == null) {
            return 0;
        }
        double v = MAX * (c.r() - c.a()) / (c.r() + c.a() + PRIOR);
        return (int) Math.max(-MAX, Math.min(MAX, Math.round(v)));
    }

    /** Three Not nows within 14 days on one class: time to ask once. */
    public static boolean askKeep(Counts c, long now) {
        return c != null && c.notNows().stream().filter(t -> now - t < NOT_NOW_WINDOW).count() >= NOT_NOW_ASK;
    }

    /** What a class's rules do to an item: hold it, keep it for catch-ups, pull it closer (negative), else nothing. */
    public record Effect(boolean hold, boolean catchupsOnly, int learned) {}

    public static Effect effect(Reach.Item item, List<Rule> rules, Map<String, Counts> counts, String dayPart,
            long now) {
        String cls = classOf(item);
        boolean hold = false;
        boolean catchups = false;
        Integer sooner = null;
        for (Rule r : rules) {
            if (!r.classKey().equals(cls)) {
                continue;
            }
            switch (r.effect()) {
                case "hold" -> hold = true;
                case "catchups" -> catchups = true;
                case "sooner" -> sooner = -MAX;
                default -> {
                    // not_for_this works on the let-through list (Reach's exceptions), not here.
                }
            }
        }
        int learned = sooner != null ? sooner : drift(counts.getOrDefault(driftClass(item, dayPart), Counts.ZERO)
                .decayed(now));
        return new Effect(hold, catchups, learned);
    }

    /** "Newsletters wait for catch-ups (you said Not important, Nov 18)": a rule's line, names drawn by the caller. */
    public static String line(Rule r, String who, java.time.ZoneId zone) {
        String what = what(r.kind(), who);
        String date = Rhythm.date(r.at(), zone);
        return switch (r.effect()) {
            case "hold" -> what + " wait for catch-ups (you said Not important, " + date + ")";
            case "catchups" -> what + " wait for catch-ups (you said Keep them for catch-ups, " + date + ")";
            case "sooner" -> what + " come sooner (you said Sooner next time, " + date + ")";
            case "not_for_this" -> what + " don’t use your list (you said Not for this, " + date + ")";
            default -> what;
        };
    }

    /** The class in plain words: "Messages from {who}", "Answers from Scout", "Updates on Work". */
    static String what(String kind, String who) {
        String from = who == null || who.isEmpty() ? "" : " from " + who;
        return switch (kind) {
            case "message" -> "Messages" + from;
            case "doc" -> "Documents" + from;
            case "result" -> "Answers" + from;
            case "todos" -> "New to-dos" + from;
            case "approval" -> "Approvals" + from;
            case "notes", "notes_unsure" -> "Notes";
            case "desk_asleep" -> "Asleep desks";
            case "pickup" -> "Pick-ups";
            default -> "Updates" + from;
        };
    }
}
