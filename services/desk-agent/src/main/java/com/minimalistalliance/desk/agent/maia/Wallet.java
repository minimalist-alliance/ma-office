package com.minimalistalliance.desk.agent.maia;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.team.TextChecks;
import com.minimalistalliance.desk.agent.tool.RunContext;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.SQLException;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Desk Maia's sense of the member's wallet when she briefs agents on their other desks (the owner, Nov 15: "People
 * aren't going to want to use and trust Maia Mode if it just destroys their wallets", and then "Will users have to
 * approve that EVERY time?"). The agents she briefs run on the member's own keys; this is how she plans around what they
 * cost, and when she asks first. deskd {@code API.md} §23, "Her briefs and the member's wallet".
 *
 * <p><b>What she reads.</b> Each desk's own team view ({@code agent.usage.summary}, counts and dollars from its usage
 * ledger, ADR 0043) gives every agent's headroom (what's left of its day and month limits, and what one brief from
 * another desk may spend there now) and its usual task cost; the office passes them in {@code agent.maia.observe}
 * ({@link Headroom}), with what her briefs cost on that desk today and this month ({@link DeskBriefs}).
 *
 * <p><b>What she estimates.</b> A brief costs about the answering agent's usual task (its briefs from her when it has
 * {@link #MIN_HISTORY}, else its tasks, else {@link #DEFAULT_TASK}), times how much the brief asks for ({@link #size}).
 *
 * <p><b>When she asks.</b> Never on a normal day. The member has one daily budget for her briefs ({@link
 * #DEFAULT_DAILY} unless they set one). Inside it a brief just goes. Code holds it and puts the choice to the member,
 * with the estimate, only when:
 * <ol>
 *   <li>it would pass an agent's own limit (its day or month, or what one brief may spend there): {@code maia_limit},
 *       and "Go" isn't offered while nothing is left, since the desk would refuse it anyway;
 *   <li>it would take her briefs past the day's budget: {@code maia_held};
 *   <li>it costs more than {@link #UNUSUAL} times that agent's usual task and more than the member's ask line
 *       ({@link #DEFAULT_ASK_ABOVE}): {@code maia_held}.
 * </ol>
 * Each ask offers "Always OK for tasks like this": that agent's tasks up to this size never ask again for the budget
 * or their size (an agent's own limits still do). The member sees and clears these in her settings.
 *
 * <p><b>What it never does.</b> Nothing here raises a limit: the desks' hard caps (ADR 0043's reserve, the run cap,
 * the share for messages from other desks) still refuse a run that would pass them, whatever she or this says. Her
 * budget, the ask line and "Always OK" change only from the member's own session ({@code agent.maia.set}, or a tap on
 * code's own card): she has no tool for any of them, and her own {@code ask_member} choices can't make one.
 */
public final class Wallet {

    private static final Logger log = LoggerFactory.getLogger(Wallet.class);

    /** The daily budget for her briefs when the member hasn't set one: $3. */
    public static final long DEFAULT_DAILY = 3_000_000L;
    /** The ask line when the member hasn't set one: a brief over $0.50 that's also unusual for its agent asks. */
    public static final long DEFAULT_ASK_ABOVE = 500_000L;
    /** An agent with too little history: $0.20 a task. */
    static final long DEFAULT_TASK = 200_000L;
    /** Unusual is more than this many times the agent's usual task. */
    static final double UNUSUAL = 3.0;
    /** Tasks (or briefs) an agent needs before its average is its usual cost. */
    static final int MIN_HISTORY = 2;
    /** A brief's size, at most. */
    static final double MAX_SIZE = 6.0;
    /** The least an estimate is: a cent. */
    static final long FLOOR = 10_000L;
    /** A "Go" holds this long, for one brief to that agent. */
    static final long PASS_FOR = 15 * 60_000L;
    /** A "Go" covers a brief up to this much more than the estimate it answered. */
    static final double PASS_SLACK = 1.5;
    /** "Always OK" covers tasks up to this much more than the one it answered, to the next 10 cents. */
    static final double ALWAYS_SLACK = 1.25;
    static final int MAX_ALWAYS = 50;
    /** A held brief is forgotten after this long. */
    static final long HELD_FOR = 60 * 60_000L;
    /** The most a budget or ask line may be set to: $1,000. */
    static final double MAX_SETTING_USD = 1000;
    /** What the office may say of a figure, at most ($1M): past it the figure is ignored. */
    static final long MAX_FIGURE = 1_000_000_000_000L;
    /** Her store's count of estimates per desk and day, for a desk the office hasn't read. */
    static final String EST = "brief_usd";

    /** Choice ids of code's card. */
    static final String GO = "go";
    static final String ALWAYS = "always";
    static final String CHEAPER = "cheaper";
    static final String TRY = "try";
    static final String OTHER_WAY = "another";
    static final String SKIP = "skip";

    // ---------------------------------------------------------------- what the office reads on each desk

    /**
     * One agent on another desk, as the office read it from that desk's team view: µ$, null where there's no cap or no
     * figure. {@code dayLeft}: before its day or week limit or the desk's day limit; {@code monthLeft}: before its month,
     * the desk's month or its key's month; {@code briefMax}: what a run answering another desk may spend there now (its
     * share for messages, and its run limit); {@code perTask}, {@code tasks}: its average over its tasks in 7 days;
     * {@code perBrief}, {@code briefs}: over runs her briefs started there in 30 days.
     */
    public record Headroom(Long dayLeft, Long monthLeft, Long runMax, Long briefMax, Long perTask, int tasks,
            Long perBrief, int briefs) {

        public static final Headroom UNKNOWN = new Headroom(null, null, null, null, null, 0, null, 0);

        /** Its usual task's cost, or null with too little history. */
        Long usual() {
            if (briefs >= MIN_HISTORY && perBrief != null) {
                return perBrief;
            }
            return tasks >= MIN_HISTORY && perTask != null ? perTask : null;
        }

        /** The least of what's left that a brief would hit first, with which: {@code [left, which]}, or null. */
        Object[] tightest() {
            Long left = null;
            String which = null;
            if (briefMax != null) {
                left = briefMax;
                which = "brief";
            }
            if (dayLeft != null && (left == null || dayLeft < left)) {
                left = dayLeft;
                which = "day";
            }
            if (monthLeft != null && (left == null || monthLeft < left)) {
                left = monthLeft;
                which = "month";
            }
            return left == null ? null : new Object[] {left, which};
        }

        /** The office's figures, read leniently: anything out of range is no figure. */
        static Headroom parse(Object raw) {
            if (!(raw instanceof Map<?, ?> m)) {
                return null;
            }
            return new Headroom(money(m.get("dayLeftMicroUsd")), money(m.get("monthLeftMicroUsd")),
                    money(m.get("runMaxMicroUsd")), money(m.get("briefMaxMicroUsd")), money(m.get("perTaskMicroUsd")),
                    count(m.get("tasks")), money(m.get("perBriefMicroUsd")), count(m.get("briefs")));
        }

        /** The most careful reading of several agents (the desk's answering agent unknown): least left, most usual. */
        static Headroom merge(List<Headroom> all) {
            if (all.isEmpty()) {
                return UNKNOWN;
            }
            Long day = null;
            Long month = null;
            Long run = null;
            Long brief = null;
            Long usual = null;
            for (Headroom h : all) {
                day = least(day, h.dayLeft());
                month = least(month, h.monthLeft());
                run = least(run, h.runMax());
                brief = least(brief, h.briefMax());
                Long u = h.usual();
                if (u != null && (usual == null || u > usual)) {
                    usual = u;
                }
            }
            return new Headroom(day, month, run, brief, usual, usual == null ? 0 : MIN_HISTORY, null, 0);
        }

        private static Long least(Long a, Long b) {
            if (a == null) {
                return b;
            }
            return b == null ? a : Long.valueOf(Math.min(a, b));
        }
    }

    /** What her briefs cost on one desk, from that desk's own ledger: today and this month, µ$ and runs. */
    public record DeskBriefs(long todayMicroUsd, long monthMicroUsd, int today, int month) {

        static DeskBriefs parse(Object raw) {
            if (!(raw instanceof Map<?, ?> m)) {
                return null;
            }
            Long today = money(m.get("todayMicroUsd"));
            Long month = money(m.get("monthMicroUsd"));
            if (today == null && month == null) {
                return null;
            }
            long t = today == null ? 0 : today;
            return new DeskBriefs(t, Math.max(t, month == null ? 0 : month), count(m.get("today")),
                    count(m.get("month")));
        }
    }

    /** "Always OK for tasks like this": that agent's tasks up to this much never ask for the budget or their size. */
    public record AlwaysOk(String deskId, String agentId, long upToMicroUsd, long at) {

        Map<String, Object> view() {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("deskId", deskId);
            v.put("agentId", agentId);
            v.put("upToUsd", usd(upToMicroUsd));
            v.put("at", at);
            return v;
        }
    }

    /** The member's settings: the daily budget for her briefs, the ask line, and what they said is always OK. */
    public record Settings(long dailyMicroUsd, long askAboveMicroUsd, List<AlwaysOk> alwaysOk) {

        AlwaysOk alwaysFor(String deskId, String agentId) {
            for (AlwaysOk a : alwaysOk) {
                if (a.deskId().equals(deskId) && a.agentId().equals(agentId)) {
                    return a;
                }
            }
            return null;
        }
    }

    /** A brief's estimate: µ$, the agent's usual task it came from, whether that was history, and the brief's size. */
    public record Estimate(long microUsd, long usualMicroUsd, boolean fromHistory, double size) {}

    public enum Kind {
        GO,
        UNUSUAL,
        BUDGET,
        LIMIT
    }

    /**
     * What code decided for one brief. For {@code LIMIT}, {@code limit} is {@code day}, {@code month} or {@code brief}
     * and {@code left} what's left there; {@code committed} is her briefs' spend today before this one.
     */
    public record Decision(Kind kind, Estimate estimate, String limit, Long left, long committed, long budget) {}

    // ---------------------------------------------------------------- the estimate

    private static final Pattern ITEM_LINE = Pattern.compile("(?m)^[ \\t]*(?:[-*\u2022]|\\d{1,3}[.)])[ \\t]+\\S");
    /** A count of things: "12 laptops", "20 competitors' sites", "50 old emails". */
    private static final Pattern COUNT = Pattern.compile(
            "\\b(\\d{1,4})\\s+(?:[A-Za-z][\\w'-]*\\s+){0,2}?[A-Za-z][\\w'-]*s\\b");
    /** Words that widen a task. */
    private static final Pattern WIDE = Pattern.compile("\\b(?:all|every|entire|everything|thorough(?:ly)?|in[ -]depth"
            + "|deep[ -]dive|comprehensive|exhaustive(?:ly)?)\\b", Pattern.CASE_INSENSITIVE);

    /**
     * How much a brief asks for, from 1 (an ordinary task) to {@link #MAX_SIZE}: longer briefs (past 120 words), a list
     * of 4 or more items, a count of 5 or more things, and words that widen it ("all", "every", "in depth"). Code, so the
     * same brief always sizes the same, and trimming or splitting one shows.
     */
    static double size(String text) {
        if (text == null || text.isBlank()) {
            return 1;
        }
        String t = text.strip();
        int words = t.split("\\s+").length;
        double s = 1 + Math.min(2, Math.max(0, words - 120) / 200.0);
        int things = 0;
        int items = 0;
        Matcher lines = ITEM_LINE.matcher(t);
        while (lines.find()) {
            items++;
        }
        if (items >= 4) {
            things = items;
        }
        Matcher counts = COUNT.matcher(t);
        while (counts.find()) {
            int n = Integer.parseInt(counts.group(1));
            if (n >= 5 && n <= 1000) {
                things = Math.max(things, n);
            }
        }
        if (things > 0) {
            s *= Math.max(1, Math.min(4, things / 3.0));
        }
        if (WIDE.matcher(t).find()) {
            s *= 1.5;
        }
        return Math.min(MAX_SIZE, s);
    }

    /** A brief's estimate for that agent: its usual task (or {@link #DEFAULT_TASK}) times the brief's size. */
    static Estimate estimate(Headroom h, String text) {
        Long usual = h == null ? null : h.usual();
        long base = usual == null ? DEFAULT_TASK : Math.max(FLOOR, usual);
        double size = size(text);
        return new Estimate(Math.max(FLOOR, Math.round(base * size)), base, usual != null, size);
    }

    /**
     * The rule, as one pure function. An agent's own limits first: never waived, and with nothing left not even by a
     * "Go". Then a "Go" lets it on. Then the day's budget, and an unusual cost over the ask line, unless the member said
     * tasks like this are always OK.
     */
    static Decision decide(Estimate e, Headroom h, Settings s, AlwaysOk always, long committed, boolean pass) {
        long est = e.microUsd();
        Object[] tight = h == null ? null : h.tightest();
        if (tight != null && est > (Long) tight[0] && (!pass || (Long) tight[0] <= 0)) {
            return new Decision(Kind.LIMIT, e, (String) tight[1], (Long) tight[0], committed, s.dailyMicroUsd());
        }
        if (pass) {
            return new Decision(Kind.GO, e, null, null, committed, s.dailyMicroUsd());
        }
        boolean covered = always != null && est <= always.upToMicroUsd();
        if (!covered && committed + est > s.dailyMicroUsd()) {
            return new Decision(Kind.BUDGET, e, null, null, committed, s.dailyMicroUsd());
        }
        if (!covered && est > s.askAboveMicroUsd() && est > UNUSUAL * e.usualMicroUsd()) {
            return new Decision(Kind.UNUSUAL, e, null, null, committed, s.dailyMicroUsd());
        }
        return new Decision(Kind.GO, e, null, null, committed, s.dailyMicroUsd());
    }

    // ---------------------------------------------------------------- state

    /** Who answers her on a desk, and what the office read of them. */
    record Answering(String agentId, String name, Headroom headroom) {}

    /** A brief code held for the member's choice. {@code answer} is their tap, once they've tapped. */
    private record Held(String deskId, String agentId, String text, Decision decision, String messageId, long at,
            String answer, boolean said) {}

    private record Pass(String agentId, long upTo, long until) {}

    private record Flight(String deskId, String day, long microUsd) {}

    private final MaiaMode maia;
    private final Object lock = new Object();
    private final Map<String, Held> held = new LinkedHashMap<>();
    private final Map<String, Pass> passes = new LinkedHashMap<>();
    private final List<Flight> flights = new ArrayList<>();
    /** Each brief's decision by run, desk and text: the guard runs at the look and again as the call goes. */
    private final Map<String, Object[]> decided = new LinkedHashMap<>(16, 0.75f, true);
    private volatile Notes.Poster poster;

    Wallet(MaiaMode maia) {
        this.maia = maia;
    }

    /** Posts code's own messages of hers (the card). */
    void poster(Notes.Poster p) {
        this.poster = p;
    }

    // ---------------------------------------------------------------- settings

    Settings settings() {
        Map<String, Object> mode = maia.mode();
        Map<String, Object> b = mode.get("budget") instanceof Map<?, ?> m ? MaiaMode.cast(m) : Map.of();
        long daily = microOf(b.get("dailyUsd"), DEFAULT_DAILY);
        long ask = microOf(b.get("askAboveUsd"), DEFAULT_ASK_ABOVE);
        List<AlwaysOk> always = new ArrayList<>();
        if (b.get("alwaysOk") instanceof List<?> list) {
            for (Object o : list) {
                AlwaysOk a = alwaysOf(o);
                if (a != null) {
                    always.add(a);
                }
            }
        }
        return new Settings(daily, ask, List.copyOf(always));
    }

    /** {@code {maia}.budget}: the member's settings, as dollars. */
    Map<String, Object> view() {
        Settings s = settings();
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("dailyUsd", usd(s.dailyMicroUsd()));
        v.put("askAboveUsd", usd(s.askAboveMicroUsd()));
        List<Map<String, Object>> always = new ArrayList<>();
        for (AlwaysOk a : s.alwaysOk()) {
            always.add(a.view());
        }
        v.put("alwaysOk", always);
        return v;
    }

    /**
     * {@code agent.maia.set {budget}}, the member's own: {@code dailyUsd} and {@code askAboveUsd} 0 to $1,000, and
     * {@code alwaysOk} only ever narrowed (entries removed): new ones come only from a tap on code's own card.
     */
    static Map<String, Object> set(Object raw, Object before) throws RpcError {
        if (!(raw instanceof Map<?, ?> given)) {
            throw RpcError.badRequest("budget");
        }
        Map<String, Object> out = before instanceof Map<?, ?> b ? new LinkedHashMap<>(MaiaMode.cast(b))
                : new LinkedHashMap<>();
        for (Map.Entry<?, ?> e : given.entrySet()) {
            String k = String.valueOf(e.getKey());
            Object v = e.getValue();
            switch (k) {
                case "dailyUsd", "askAboveUsd" -> {
                    if (!(v instanceof Number n) || Double.isNaN(n.doubleValue()) || n.doubleValue() < 0
                            || n.doubleValue() > MAX_SETTING_USD) {
                        throw RpcError.of("bad_request", "reason", "range", "detail", "budget." + k);
                    }
                    out.put(k, n.doubleValue());
                }
                case "alwaysOk" -> {
                    if (!(v instanceof List<?> list) || list.size() > MAX_ALWAYS) {
                        throw RpcError.badRequest("budget.alwaysOk");
                    }
                    List<Object> kept = before instanceof Map<?, ?> b && b.get("alwaysOk") instanceof List<?> l
                            ? new ArrayList<>(l) : new ArrayList<>();
                    List<Object> next = new ArrayList<>();
                    for (Object o : list) {
                        if (!(o instanceof Map<?, ?> m) || !(m.get("deskId") instanceof String d)
                                || !(m.get("agentId") instanceof String a)) {
                            throw RpcError.badRequest("budget.alwaysOk");
                        }
                        Object found = null;
                        for (Object k0 : kept) {
                            if (k0 instanceof Map<?, ?> km && d.equals(km.get("deskId")) && a.equals(km.get("agentId"))) {
                                found = k0;
                            }
                        }
                        if (found == null) {
                            // Only ever narrower: a new one comes from the member's tap on code's card.
                            throw RpcError.of("bad_request", "reason", "narrow_only", "detail", "budget.alwaysOk");
                        }
                        next.add(found);
                    }
                    out.put(k, next);
                }
                default -> throw RpcError.of("bad_request", "detail", "budget." + k);
            }
        }
        return out;
    }

    // ---------------------------------------------------------------- the guard

    /**
     * Her brief to {@code deskId}, judged once per run, desk and text: null to let it go, else {@code maia_held} (code
     * has put the choice to the member) or {@code maia_limit} (an agent's own limit; the member's options are on a card
     * too). Never throws: anything that fails here lets the desks' own caps decide, as before.
     */
    String check(RunContext run, String deskId, Object rawText) {
        String text = rawText instanceof String s ? s : "";
        String key = run.runId() + "\u0000" + deskId + "\u0000" + sha(text);
        try {
            synchronized (lock) {
                Object[] seen = decided.get(key);
                if (seen != null) {
                    return (String) seen[0];
                }
            }
            Answering who = answering(deskId);
            Estimate e = estimate(who.headroom(), text);
            Settings s = settings();
            long committed = committedToday();
            AlwaysOk always = who.agentId() == null ? null : s.alwaysFor(deskId, who.agentId());
            Decision d = decide(e, who.headroom(), s, always, committed, false);
            if (d.kind() != Kind.GO && takePass(deskId, who.agentId(), e.microUsd())) {
                d = decide(e, who.headroom(), s, always, committed, true);
            }
            String refusal = switch (d.kind()) {
                case GO -> null;
                case LIMIT -> "maia_limit";
                default -> "maia_held";
            };
            synchronized (lock) {
                decided.put(key, new Object[] {refusal, d.estimate().microUsd()});
                Iterator<String> it = decided.keySet().iterator();
                while (decided.size() > 200 && it.hasNext()) {
                    it.next();
                    it.remove();
                }
            }
            if (refusal != null) {
                try {
                    hold(deskId, who, text, d);
                } catch (RuntimeException failed) {
                    // Decided is decided: held, even with no card (Security's MB-L1).
                    log.warn("a held brief's card wasn't made: {}", failed.getClass().getSimpleName());
                }
            }
            return refusal;
        } catch (RuntimeException e) {
            log.warn("a brief's cost wasn't judged: {}", e.getClass().getSimpleName());
            return null;
        }
    }

    /**
     * Her brief went: its estimate counts until the answer comes and the desk's own figure takes over. Its decision goes,
     * so the same brief sent again is judged again, with this one counted (Security's MB-M1).
     */
    void sent(RunContext run, String deskId, Object rawText) {
        String text = rawText instanceof String s ? s : "";
        String key = run.runId() + "\u0000" + deskId + "\u0000" + sha(text);
        long est;
        synchronized (lock) {
            Object[] seen = decided.remove(key);
            est = seen == null ? estimate(answering(deskId).headroom(), text).microUsd() : (Long) seen[1];
            flights.add(new Flight(deskId, maia.today(), est));
            held.remove(deskId);
        }
        try {
            maia.store().add(maia.today(), EST, deskId, est);
        } catch (SQLException e) {
            log.warn("a brief's estimate wasn't kept: {}", e.getClass().getSimpleName());
        }
    }

    /** Her brief didn't go (deskd refused it, or the member declined its card): its decision goes too. */
    void notSent(RunContext run, String deskId, Object rawText) {
        String text = rawText instanceof String s ? s : "";
        synchronized (lock) {
            decided.remove(run.runId() + "\u0000" + deskId + "\u0000" + sha(text));
        }
    }

    /** An answer from that desk came: the oldest brief there no longer counts as its estimate. */
    void answered(String deskId) {
        synchronized (lock) {
            for (Iterator<Flight> it = flights.iterator(); it.hasNext(); ) {
                if (it.next().deskId().equals(deskId)) {
                    it.remove();
                    return;
                }
            }
        }
    }

    /**
     * Her briefs' spend today: on each desk, what its own ledger says (the office's last read) plus the estimates of
     * briefs still out there; for a desk the office hasn't read, the estimates of today's briefs to it.
     */
    long committedToday() {
        Map<String, long[]> by = byDesk();
        long total = 0;
        for (long[] v : by.values()) {
            total += v[0];
        }
        return total;
    }

    /** Per desk: {@code [today, month]} µ$, as {@link #committedToday} counts today. */
    private Map<String, long[]> byDesk() {
        String today = maia.today();
        String monthStart = LocalDate.parse(today).withDayOfMonth(1).toString();
        Map<String, Long> estToday;
        Map<String, Long> estMonth;
        try {
            estToday = maia.store().sums(EST, today);
            estMonth = maia.store().sums(EST, monthStart);
        } catch (SQLException e) {
            estToday = Map.of();
            estMonth = Map.of();
        }
        Map<String, Long> out0 = new LinkedHashMap<>();
        synchronized (lock) {
            for (Flight f : flights) {
                if (f.day().equals(today)) {
                    out0.merge(f.deskId(), f.microUsd(), Long::sum);
                }
            }
        }
        Map<String, long[]> out = new LinkedHashMap<>();
        Set<String> desks = new java.util.LinkedHashSet<>();
        for (MaiaStore.Grant g : maia.grants()) {
            desks.add(g.deskId());
        }
        for (Attention.Desk d : maia.room().desks()) {
            desks.add(d.deskId());
        }
        desks.addAll(estMonth.keySet());
        for (String desk : desks) {
            Attention.Desk d = maia.room().desk(desk);
            DeskBriefs seen = d == null ? null : d.briefs();
            long inFlight = out0.getOrDefault(desk, 0L);
            long day;
            long month;
            if (seen != null) {
                day = seen.todayMicroUsd() + inFlight;
                month = seen.monthMicroUsd() + inFlight;
            } else {
                day = estToday.getOrDefault(desk, 0L);
                month = estMonth.getOrDefault(desk, 0L);
            }
            out.put(desk, new long[] {day, month});
        }
        return out;
    }

    /** The room's and the team view's {@code briefs}: today and this month in all and per desk, and the budget. */
    Map<String, Object> spendView() {
        Map<String, long[]> by = byDesk();
        long today = 0;
        long month = 0;
        List<Map<String, Object>> desks = new ArrayList<>();
        for (Map.Entry<String, long[]> e : by.entrySet()) {
            today += e.getValue()[0];
            month += e.getValue()[1];
            if (e.getValue()[1] == 0 && maia.grantFor(e.getKey(), "brief") == null) {
                continue;
            }
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("deskId", e.getKey());
            v.put("deskName", deskName(e.getKey()));
            v.put("todayMicroUsd", e.getValue()[0]);
            v.put("monthMicroUsd", e.getValue()[1]);
            desks.add(v);
        }
        Settings s = settings();
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("todayMicroUsd", today);
        v.put("monthMicroUsd", month);
        v.put("budgetMicroUsd", s.dailyMicroUsd());
        v.put("desks", desks);
        v.put("line", "Briefs today " + Attention.dollars(today) + " of " + Attention.dollars(s.dailyMicroUsd()));
        return v;
    }

    // ---------------------------------------------------------------- who answers

    Answering answering(String deskId) {
        String[] peer = maia.answeringAgent(deskId);
        Attention.Desk d = maia.room().desk(deskId);
        if (d == null) {
            return new Answering(peer == null ? null : peer[0], peer == null ? null : plainName(peer[1]),
                    Headroom.UNKNOWN);
        }
        if (peer != null) {
            for (Attention.Agent a : d.agents()) {
                if (a.agentId().equals(peer[0])) {
                    return new Answering(a.agentId(), a.name().isEmpty() ? plainName(peer[1]) : a.name(),
                            a.headroom() == null ? Headroom.UNKNOWN : a.headroom());
                }
            }
            return new Answering(peer[0], plainName(peer[1]), Headroom.UNKNOWN);
        }
        List<Attention.Agent> agents = d.agents().stream().filter(a -> !MaiaAgent.is(a.agentId())).toList();
        if (agents.size() == 1) {
            Attention.Agent a = agents.get(0);
            return new Answering(a.agentId(), a.name(), a.headroom() == null ? Headroom.UNKNOWN : a.headroom());
        }
        List<Headroom> all = new ArrayList<>();
        for (Attention.Agent a : agents) {
            if (a.headroom() != null) {
                all.add(a.headroom());
            }
        }
        return new Answering(null, null, Headroom.merge(all));
    }

    // ---------------------------------------------------------------- the card

    /** Holds a brief and puts the choice to the member, once while its card is open. */
    private void hold(String deskId, Answering who, String text, Decision d) {
        long now = maia.clock().millis();
        Held before;
        synchronized (lock) {
            before = held.get(deskId);
        }
        if (before != null && before.answer() == null && now - before.at() < HELD_FOR && open(before.messageId())) {
            return;
        }
        Notes.Poster p = poster;
        String messageId = null;
        Map<String, Object> card = card(deskId, who, d);
        if (p != null) {
            try {
                messageId = p.post((String) card.get("text"), MaiaMode.cast((Map<?, ?>) card.get("extras")));
            } catch (SQLException | RuntimeException e) {
                log.warn("a brief's card wasn't posted: {}", e.getClass().getSimpleName());
            }
        }
        synchronized (lock) {
            held.put(deskId, new Held(deskId, who.agentId(), text, d, messageId, now, null, false));
        }
        maia.audit("agent:maia", "maia.brief.held", "desk:" + deskId + " est:" + d.estimate().microUsd(),
                d.kind().name().toLowerCase(Locale.ROOT));
        maia.room().rebuild();
    }

    private boolean open(String messageId) {
        if (messageId == null) {
            return false;
        }
        Map<String, Object> extras = maia.extras(messageId);
        return extras != null && extras.get("choices") instanceof Map<?, ?> c && "open".equals(c.get("state"));
    }

    /** Code's card: its text and extras ({@code choices} of kind {@code budget}, and {@code cost}). */
    Map<String, Object> card(String deskId, Answering who, Decision d) {
        String desk = deskName(deskId);
        String agent = who.name() == null || who.name().isBlank() ? null : who.name();
        String whom = "your " + desk + (agent == null ? " desk" : " " + agent);
        String est = Attention.dollars(d.estimate().microUsd());
        String text;
        List<String[]> options = new ArrayList<>();
        switch (d.kind()) {
            case UNUSUAL -> {
                long times = Math.max(2, Math.round((double) d.estimate().microUsd() / d.estimate().usualMicroUsd()));
                text = "This one's bigger than usual: about " + est + " on " + whom + ", about " + times
                        + " times its usual task. Go ahead?";
                options.add(new String[] {GO, "Go"});
                options.add(new String[] {ALWAYS, "Always OK for tasks like this"});
                options.add(new String[] {CHEAPER, "Cheaper way"});
                options.add(new String[] {SKIP, "Skip"});
            }
            case BUDGET -> {
                text = "About " + est + " on " + whom + " would take my briefs past today's "
                        + Attention.dollars(d.budget()) + " budget (" + Attention.dollars(d.committed())
                        + " used). Go ahead?";
                options.add(new String[] {CHEAPER, "Cheaper way"});
                options.add(new String[] {GO, "Go"});
                options.add(new String[] {ALWAYS, "Always OK for tasks like this"});
                options.add(new String[] {SKIP, "Skip"});
            }
            default -> {
                long left = d.left() == null ? 0 : Math.max(0, d.left());
                String owner = Character.toUpperCase(whom.charAt(0)) + whom.substring(1);
                text = switch (d.limit()) {
                    case "month" -> owner + " has " + Attention.dollars(left) + " left this month, and this is about "
                            + est + ".";
                    case "brief" -> "A task from me may spend at most " + Attention.dollars(left) + " on " + whom
                            + " right now, and this is about " + est + ".";
                    default -> owner + " has " + Attention.dollars(left) + " left today, and this is about " + est
                            + ".";
                };
                if (left > 0) {
                    text += " It would stop at its limit.";
                    options.add(new String[] {CHEAPER, "Cheaper way"});
                    options.add(new String[] {TRY, "Try anyway"});
                } else {
                    options.add(new String[] {OTHER_WAY, "Another way"});
                }
                options.add(new String[] {SKIP, "Skip"});
            }
        }
        List<Map<String, Object>> opts = new ArrayList<>();
        for (String[] o : options) {
            opts.add(Map.of("id", o[0], "label", o[1]));
        }
        Map<String, Object> choices = new LinkedHashMap<>();
        choices.put("question", text);
        choices.put("options", opts);
        choices.put("recommended", options.get(0)[0]);
        choices.put("other", false);
        choices.put("state", "open");
        choices.put("answer", null);
        choices.put("kind", "budget");
        Map<String, Object> brief = new LinkedHashMap<>();
        brief.put("deskId", deskId);
        brief.put("agentId", who.agentId());
        brief.put("estimateMicroUsd", d.estimate().microUsd());
        brief.put("reason", d.kind().name().toLowerCase(Locale.ROOT));
        choices.put("brief", brief);
        Map<String, Object> cost = new LinkedHashMap<>();
        cost.put("estimateMicroUsd", d.estimate().microUsd());
        cost.put("usualMicroUsd", d.estimate().usualMicroUsd());
        cost.put("reason", d.kind().name().toLowerCase(Locale.ROOT));
        cost.put("line", "About " + est + (d.estimate().fromHistory() ? " · usually "
                + Attention.dollars(d.estimate().usualMicroUsd()) : "") + " · " + desk
                + (agent == null ? "" : " " + agent));
        Map<String, Object> extras = new LinkedHashMap<>();
        extras.put("choices", choices);
        extras.put("cost", cost);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("text", text);
        out.put("extras", extras);
        return out;
    }

    /**
     * The member tapped code's card ({@code agent.maia.choose} on {@code kind: "budget"}). "Go" and "Try anyway" let
     * that agent take one brief of about this size in the next {@link #PASS_FOR}; "Always OK" keeps that agent's tasks of
     * this size from asking again, and lets this one go; "Cheaper way" and "Another way" go to her as the member's words,
     * with her note saying what to look for; "Skip" drops it and starts nothing. @return {@code agent.maia.choose}'s answer
     */
    Map<String, Object> answer(String messageId, Map<String, Object> choice, String choiceId, String label)
            throws RpcError, SQLException {
        Map<String, Object> brief = choice.get("brief") instanceof Map<?, ?> b ? MaiaMode.cast(b) : Map.of();
        String deskId = brief.get("deskId") instanceof String d ? d : null;
        String agentId = brief.get("agentId") instanceof String a ? a : null;
        long est = brief.get("estimateMicroUsd") instanceof Number n ? Math.max(FLOOR, n.longValue()) : FLOOR;
        long now = maia.clock().millis();
        synchronized (lock) {
            Held h = deskId == null ? null : held.get(deskId);
            if (h != null && SKIP.equals(choiceId)) {
                held.remove(deskId);
            } else if (h != null) {
                held.put(deskId, new Held(h.deskId(), h.agentId(), h.text(), h.decision(), h.messageId(), h.at(),
                        choiceId, false));
            }
            if (deskId != null && (GO.equals(choiceId) || TRY.equals(choiceId) || ALWAYS.equals(choiceId))) {
                passes.put(deskId, new Pass(agentId, Math.round(est * PASS_SLACK), now + PASS_FOR));
            }
        }
        if (ALWAYS.equals(choiceId) && deskId != null && agentId != null) {
            remember(deskId, agentId, est, now);
        }
        maia.audit("user", "maia.brief.answer", "desk:" + deskId + " est:" + est, choiceId);
        if (SKIP.equals(choiceId)) {
            maia.room().rebuild();
            return Map.of("messageId", messageId);
        }
        return null;
    }

    /** "Always OK for tasks like this": that agent, up to this estimate and a quarter, to the next 10 cents. */
    private void remember(String deskId, String agentId, long est, long now) throws SQLException {
        long upTo = (long) Math.ceil(est * ALWAYS_SLACK / 100_000.0) * 100_000L;
        maia.updateBudget(budget -> {
            List<Object> list = budget.get("alwaysOk") instanceof List<?> l ? new ArrayList<>(l) : new ArrayList<>();
            list.removeIf(o -> o instanceof Map<?, ?> m && deskId.equals(m.get("deskId"))
                    && agentId.equals(m.get("agentId")));
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("deskId", deskId);
            entry.put("agentId", agentId);
            entry.put("upToUsd", usd(upTo));
            entry.put("at", now);
            list.add(entry);
            while (list.size() > MAX_ALWAYS) {
                list.remove(0);
            }
            budget.put("alwaysOk", list);
        });
        maia.audit("user", "maia.budget.always", "desk:" + deskId + " agent:" + agentId + " upTo:" + upTo, "ok");
    }

    private boolean takePass(String deskId, String agentId, long est) {
        synchronized (lock) {
            Pass p = passes.get(deskId);
            if (p == null) {
                return false;
            }
            if (maia.clock().millis() > p.until()) {
                passes.remove(deskId);
                return false;
            }
            if ((p.agentId() != null && agentId != null && !p.agentId().equals(agentId)) || est > p.upTo()) {
                return false;
            }
            passes.remove(deskId);
            return true;
        }
    }

    // ---------------------------------------------------------------- her note and the room

    /**
     * Her note's lines on money (they change from call to call): her briefs today against the budget, each briefable
     * desk's answering agent with its usual task and what's left, and a held brief or the member's answer to one.
     */
    String noteLines() {
        StringBuilder out = new StringBuilder();
        long t = maia.clock().millis();
        boolean any;
        synchronized (lock) {
            any = !held.isEmpty();
        }
        for (MaiaStore.Grant g : maia.grants()) {
            any |= g.allows("brief", t);
        }
        if (!any) {
            // No desk she may brief and nothing held: nothing of money to say.
            return "";
        }
        Settings s = settings();
        Map<String, Object> spend = spendView();
        out.append("Briefs today: ").append(Attention.dollars((Long) spend.get("todayMicroUsd")))
                .append(" of the member's ").append(Attention.dollars(s.dailyMicroUsd()))
                .append(" daily budget for your briefs; this month ")
                .append(Attention.dollars((Long) spend.get("monthMicroUsd"))).append('.');
        for (MaiaStore.Grant g : maia.grants()) {
            if (!g.allows("brief", t)) {
                continue;
            }
            Answering who = answering(g.deskId());
            Headroom h = who.headroom();
            out.append('\n').append(quoted(deskName(g.deskId()))).append(" (").append(g.deskId()).append("): ");
            out.append(who.name() == null ? "its answering agent" : quoted(who.name()));
            Long usual = h.usual();
            out.append(usual == null ? ", usual task unknown (about " + Attention.dollars(DEFAULT_TASK) + " assumed)"
                    : ", usual task about " + Attention.dollars(usual));
            if (h.dayLeft() != null) {
                out.append(", ").append(Attention.dollars(Math.max(0, h.dayLeft()))).append(" left today");
            }
            if (h.monthLeft() != null) {
                out.append(", ").append(Attention.dollars(Math.max(0, h.monthLeft()))).append(" left this month");
            }
            if (h.briefMax() != null) {
                out.append(", one brief may spend up to ").append(Attention.dollars(Math.max(0, h.briefMax())));
            }
            AlwaysOk a = who.agentId() == null ? null : s.alwaysFor(g.deskId(), who.agentId());
            if (a != null) {
                out.append(", tasks up to ").append(Attention.dollars(a.upToMicroUsd())).append(" always OK");
            }
            out.append('.');
        }
        List<Held> now;
        List<String> passedBy = new ArrayList<>();
        synchronized (lock) {
            for (Held h : held.values()) {
                if (h.answer() == null && !open(h.messageId())) {
                    // The member wrote something else instead (the card passed by): nothing waits on it (MB-I2).
                    passedBy.add(h.deskId());
                }
            }
            held.keySet().removeAll(passedBy);
            held.values().removeIf(h -> t - h.at() > HELD_FOR);
            now = new ArrayList<>(held.values());
            // An answer is said in one run's note; that run's end lets it go.
            held.replaceAll((k, h) -> h.answer() == null ? h : new Held(h.deskId(), h.agentId(), h.text(),
                    h.decision(), h.messageId(), h.at(), h.answer(), true));
        }
        for (Held h : now) {
            String desk = quoted(deskName(h.deskId()));
            String est = Attention.dollars(h.decision().estimate().microUsd());
            if (h.answer() == null) {
                out.append("\nWaiting on the member: your brief to ").append(desk).append(" (about ").append(est)
                        .append(") is held for their choice, under your messages. Don't send it again or ask again.");
            } else if (GO.equals(h.answer()) || TRY.equals(h.answer()) || ALWAYS.equals(h.answer())) {
                out.append("\nThe member said yes to your held brief to ").append(desk).append(" (about ").append(est)
                        .append("): send it now with desk_message, as it was: ")
                        .append(new String(Json.bytes(h.text()), StandardCharsets.UTF_8));
            } else {
                out.append("\nThe member asked for ").append(OTHER_WAY.equals(h.answer()) ? "another way" : "a cheaper way")
                        .append(" for your held brief to ").append(desk).append(" (about ").append(est)
                        .append(", usual task about ").append(Attention.dollars(h.decision().estimate().usualMicroUsd()))
                        .append("): trim it, split it into smaller briefs, or brief a desk whose agent costs less or"
                                + " has more left, then brief again. The brief was: ")
                        .append(new String(Json.bytes(h.text()), StandardCharsets.UTF_8));
            }
        }
        return out.toString();
    }

    /** Whether code's card is open: her own question waits until the member has answered it. */
    boolean cardOpen() {
        List<Held> now;
        synchronized (lock) {
            now = new ArrayList<>(held.values());
        }
        for (Held h : now) {
            if (h.answer() == null && open(h.messageId())) {
                return true;
            }
        }
        return false;
    }

    /** A run of hers ended: a held brief's answer that a note has said is done. */
    void runEnded() {
        synchronized (lock) {
            held.values().removeIf(h -> h.answer() != null && h.said());
        }
    }

    // ---------------------------------------------------------------- helpers

    private String deskName(String deskId) {
        for (MaiaStore.Grant g : maia.grants()) {
            if (g.deskId().equals(deskId)) {
                return MaiaAgent.plain(g.deskName(), Attention.NAME_MAX);
            }
        }
        Attention.Desk d = maia.room().desk(deskId);
        return d == null ? "your desk" : d.name();
    }

    private static String plainName(String name) {
        String p = MaiaAgent.plain(name, 40);
        return p.isEmpty() || TextChecks.hidden(p) ? null : p;
    }

    private static String quoted(String s) {
        return new String(Json.bytes(s), StandardCharsets.UTF_8);
    }

    private static Long money(Object o) {
        if (!(o instanceof Number n) || Double.isNaN(n.doubleValue()) || n.doubleValue() < 0
                || n.doubleValue() > MAX_FIGURE) {
            return null;
        }
        return n.longValue();
    }

    private static int count(Object o) {
        return o instanceof Number n && n.doubleValue() >= 0 ? (int) Math.min(1_000_000, n.longValue()) : 0;
    }

    private static long microOf(Object o, long fallback) {
        return o instanceof Number n && n.doubleValue() >= 0 && n.doubleValue() <= MAX_SETTING_USD
                ? Math.round(n.doubleValue() * 1_000_000) : fallback;
    }

    static double usd(long micro) {
        return Math.round(micro / 10_000.0) / 100.0;
    }

    private static AlwaysOk alwaysOf(Object o) {
        if (!(o instanceof Map<?, ?> m) || !(m.get("deskId") instanceof String d) || !Room.deskId(d)
                || !(m.get("agentId") instanceof String a) || !Room.agentId(a)) {
            return null;
        }
        long upTo = microOf(m.get("upToUsd"), -1);
        if (upTo < 0) {
            return null;
        }
        return new AlwaysOk(d, a, upTo, m.get("at") instanceof Number at ? at.longValue() : 0);
    }

    private static String sha(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
