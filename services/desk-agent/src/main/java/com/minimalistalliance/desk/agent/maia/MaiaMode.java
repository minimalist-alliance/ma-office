package com.minimalistalliance.desk.agent.maia;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.service.Caller;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.team.TextChecks;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Maia Mode on this desk (deskd {@code API.md} §23): whether it's on, the kill switch, the member's settings, her grants,
 * the list's choices, and every {@code agent.maia.*} method. Desk Maia herself runs as the agent {@link MaiaAgent#ID};
 * {@link MaiaProfile} is her prompt and tools, {@link Room} the list, {@link Notes} and {@link TodoFiler} the two use
 * cases.
 *
 * <p><b>Dark by default.</b> Nothing here does anything until the member turns Maia Mode on from their own session
 * with the disclosure accepted, and the Platform's flag decides who sees that switch at all. <b>The kill switch</b> is
 * {@code <dataDir>/maia-switch} saying {@code off} (or {@code DESK_AGENT_MAIA=off}): Maia Mode is off at once, whatever
 * the member chose, read at every call.
 */
public final class MaiaMode implements Room.Source, AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(MaiaMode.class);

    /**
     * The disclosure the member accepted to turn Maia Mode on. Version 2 (Nov 14) says she runs on Minimalist Alliance's
     * AI service within the member's Maia allowance; a desk that holds only version 1 (which said she ran on the member's
     * own key) refuses her sends and turns until the member accepts version 2.
     */
    public static final String DISCLOSURE = "maia-mode-v2";
    public static final String TOPIC = "agent.maia";
    public static final String SWITCH_FILE = "maia-switch";
    /** Her credits a day ({@code maia_counts}), in hundredths of a credit. */
    static final String CREDITS = "credits";

    /** The scopes a grant may hold. */
    static final Set<String> SCOPES = Set.of("brief", "show");
    static final int GRANT_DAYS = 7;
    static final int GRANT_MAX_DAYS = 30;
    /** Her grants, at most. */
    static final int MAX_GRANTS = 20;

    /** The most a member's own day cap on her may be, in whole credits. */
    static final long MAX_CAP_CREDITS = 1_000_000;

    /**
     * The caps, with the Officer tier's defaults until the Platform sends the tier's own values. Her own spend has no cap
     * of the desk's: her service's allowance, in credits, per tier in the Platform's settings, is the limit, and its day and
     * week amounts only pace her (the owner, Nov 15). {@code coordinatorDailyCredits} is the member's own day cap on her,
     * in whole credits against what her calls drew on this desk today, or null for none (the default); the Platform never
     * sets it. {@code coordinatorDailyUsd} is retired: her calls are the company's, so a dollar cap means nothing on the
     * desk (a stored one is ignored and dropped at the next change of caps; sending one is refused).
     */
    record Caps(Long coordinatorDailyCredits, double startedRunsDailyUsd, int briefsPerDay, int notesPerDay,
            int todosPerDeskPerDay) {
        static final Caps DEFAULT = new Caps(null, 2, 60, 50, 20);

        Map<String, Object> view() {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("coordinatorDailyCredits", coordinatorDailyCredits);
            v.put("startedRunsDailyUsd", startedRunsDailyUsd);
            v.put("briefsPerDay", briefsPerDay);
            v.put("notesPerDay", notesPerDay);
            v.put("todosPerDeskPerDay", todosPerDeskPerDay);
            return v;
        }
    }

    /**
     * The member's Maia credits as her service last reported them (ma-platform {@code desk-maia.md} 0.4.8, whole credits):
     * the month's amount and what's left of it, the week's and day's amounts and what's used of them (pace only, never a
     * lockout), top-up credits left, and where the last answer drew from: {@code day}, {@code week}, {@code month},
     * {@code topUp} or {@code lighter} (null for a word the desk doesn't know).
     */
    public record Credits(long month, long monthLeft, long week, long weekUsed, long day, long dayUsed, long topUpLeft,
            String drawingFrom, Long left, long starting, Long lighterLeft) {

        /** Desk Maia's own credits as contract 0.4.8 said them: no one wallet yet ({@code left} unknown). */
        public Credits(long month, long monthLeft, long week, long weekUsed, long day, long dayUsed, long topUpLeft,
                String drawingFrom) {
            this(month, monthLeft, week, weekUsed, day, dayUsed, topUpLeft, drawingFrom, null, 0, null);
        }

        /**
         * Whether this is the member's one wallet (contract 0.4.10, the coordinator's decision of Nov 15): the monthly
         * part, the starting credits and top-ups in one balance, shared with their agents on MA's credits.
         */
        public boolean wallet() {
            return left != null;
        }
    }

    /**
     * The member's Maia allowance as her service last reported it: the share left (0 to 1, never money; with credits, the
     * month's), when it resets (with credits, the month's renewal: a date, never a countdown), whether it's used up (the
     * service said {@code limit}; without credits, also nothing left), the credits (null for a tier that shares its Maia
     * allowance, or an older Platform), and whether she's on the lighter model because the month's credits and top-ups are
     * used up (she keeps working).
     */
    public record Allowance(double fraction, Instant resetsAt, boolean usedUp, Credits credits, boolean lighter) {
        public Allowance(double fraction, Instant resetsAt, boolean usedUp) {
            this(fraction, resetsAt, usedUp, null, false);
        }
    }

    /** What Maia Mode needs from the agent service. */
    public interface Host {
        /** Starts her run on the member's message, as {@code agent.message.send} does. @return {messageId, runId} */
        Map<String, Object> sendAsMember(String text) throws RpcError, SQLException;

        /** Stops her runs now. */
        void stopRuns();

        ZoneId zone();

        /** Her memory lines and her thread's summary go. */
        void clearMemory();

        /** A message of hers changed (its choices, its notes): the conversation topic gets it again. */
        void republish(String messageId);

        /** The tier deskd last sent (`desk.account.set`), as JSON, or null. */
        String tier();

        /** Whether this is a Guild Desk. */
        boolean guildDesk();

        /** Whether the owner's age band is adult. */
        boolean adult();

        /** Her agent row was made (or already was): it's bound to Minimalist Alliance's service, and her runner with it. */
        default void agentMade() {}

        /** Her Maia allowance as her service last reported it, or null before any answer (and once it has reset). */
        default Allowance allowance() {
            return null;
        }

        /**
         * Who answers her briefs on that desk: the other desk's agent her send half was accepted for, {@code [agentId,
         * name]} (the name is that desk's text), or null when none is known.
         */
        default String[] answeringAgent(String deskId) {
            return null;
        }

        /**
         * The decision tray's answer to a report, sent as her brief's follow-up under her grant for that desk: code's
         * desk message, never her model. @return {@code sent}, {@code answered} (that desk answered in the wait: the
         * answer was handed on as a report), or {@code refused:<word>}
         */
        default String trayBrief(String deskId, String text) {
            return "refused:unavailable";
        }
    }

    private final MaiaStore store;
    private final Clock clock;
    private final Path dataDir;
    private final Host host;
    private final Choices choices;
    private final Room room;
    private final Wallet wallet;
    private final FocusStore focusStore;
    private final Shield shield;
    private final TrayStore trayStore;
    private final AuditSink audit;
    private volatile Notes notes;
    private volatile TodoFiler todos;
    private final String envSwitch;
    private static final SecureRandom RANDOM = new SecureRandom();

    /** The audit log, ids only. */
    @FunctionalInterface
    public interface AuditSink {
        void append(String actor, String action, String target, String decision);
    }

    public MaiaMode(MaiaStore store, Clock clock, Path dataDir, Host host, AuditSink audit,
            Consumer<Map<String, Object>> publish) {
        this(store, clock, dataDir, host, audit, publish, System.getenv("DESK_AGENT_MAIA"));
    }

    MaiaMode(MaiaStore store, Clock clock, Path dataDir, Host host, AuditSink audit,
            Consumer<Map<String, Object>> publish, String envSwitch) {
        this.store = store;
        this.clock = clock;
        this.dataDir = dataDir;
        this.host = host;
        this.audit = audit;
        this.envSwitch = envSwitch;
        this.choices = new Choices(store, clock);
        this.room = new Room(clock, this, publish);
        this.wallet = new Wallet(this);
        // The focus shield (deskd API.md §23 "What reaches the member"): code on this desk decides what reaches the
        // member and when; its rows are maia_focus_* in agent.db, focus itself stays in memory.
        this.focusStore = new FocusStore(store.agents());
        this.shield = new Shield(focusStore, host::zone);
        this.room.shield(shield);
        // The decision tray (API.md §23 "The tray"): papers built by code from what the shield holds; their state in
        // maia_tray_* rows, never free-form text past its sending.
        this.trayStore = new TrayStore(store.agents());
        this.room.tray(trayStore);
    }

    /** Her chats are removed after this many days (the disclosure; ma-platform's /privacy bullet and KB page). */
    public static final int CHAT_DAYS = 90;
    private final java.util.concurrent.ScheduledExecutorService upkeep =
            java.util.concurrent.Executors.newSingleThreadScheduledExecutor(
                    Thread.ofVirtual().name("maia-upkeep").factory());
    private volatile Switch lastSwitch = Switch.NONE;
    /** One read-and-write of a reply's extras at a time: choices, note chips, a show and desk origins (DMA-I7). */
    private final java.util.concurrent.locks.ReentrantLock extrasLock = new java.util.concurrent.locks.ReentrantLock();

    /** Starts the upkeep: at once, then every 10 minutes. */
    public void start() {
        upkeep.scheduleWithFixedDelay(this::upkeep, 0, 10, java.util.concurrent.TimeUnit.MINUTES);
    }

    /**
     * Her chats older than {@link #CHAT_DAYS} go, with what they kept; held notes past 7 days are dropped; and when the
     * switch is first seen off (or no longer listing this desk), her runs stop.
     */
    public void upkeep() {
        try {
            Switch now = switchState();
            if (now != Switch.ON && lastSwitch == Switch.ON) {
                host.stopRuns();
                audit.append("system", "maia.switch", "maia", now == Switch.OFF ? "off" : "unlisted");
            }
            lastSwitch = now;
            Away a = away;
            if (a != null) {
                a.store().prune(clock.millis());
            }
            int pruned = store.pruneChats(clock.millis() - CHAT_DAYS * 86_400_000L);
            store.sweepNotes(clock.millis() - Notes.HELD_FOR, LocalDate.parse(today()).minusDays(CHAT_DAYS).toString());
            if (pruned > 0) {
                audit.append("system", "maia.prune", "maia", "messages:" + pruned);
            }
            focusStore.prune(LocalDate.parse(today()));
            trayStore.prune(clock.millis());
        } catch (SQLException | RuntimeException e) {
            log.warn("Maia Mode's upkeep failed: {}", e.getClass().getSimpleName());
        }
    }

    public void notes(Notes n) {
        this.notes = n;
    }

    private volatile Away away;

    /** Maia Mode Phase 2: she keeps going while the member is away. */
    public void away(Away a) {
        this.away = a;
    }

    /** Phase 2's while-away machinery, or null before it's set. */
    public Away away() {
        return away;
    }

    /** When reports marked "later" are read at the latest, minutes ({@code {maia}.reports.laterMaxMin}, 30 by default). */
    public int laterMaxMin() {
        if (mode().get("reports") instanceof Map<?, ?> r && r.get("laterMaxMin") instanceof Number n) {
            return Math.max(Away.LATER_MIN_MIN, Math.min(Away.LATER_MAX_MIN, n.intValue()));
        }
        return Away.LATER_DEFAULT_MIN;
    }

    /** Her latest reply with open choices, and those choices, or null (Away's summary). */
    public Map<String, Object> openChoicesOf(String[] messageIdOut) throws SQLException {
        String id = store.openChoices();
        if (id == null) {
            return null;
        }
        Map<String, Object> extras = store.extras(id);
        if (extras == null || !(extras.get("choices") instanceof Map<?, ?> c)) {
            return null;
        }
        messageIdOut[0] = id;
        return new LinkedHashMap<>(cast(c));
    }

    /** A reply's open choices moved to code's summary: this one isn't open any more. */
    public void moveChoices(String messageId) throws SQLException {
        extrasLock.lock();
        try {
            Map<String, Object> extras = store.extras(messageId);
            if (extras != null && extras.get("choices") instanceof Map<?, ?> c) {
                Map<String, Object> ch = new LinkedHashMap<>(cast(c));
                ch.put("state", "passed");
                extras.put("choices", ch);
                store.putExtras(messageId, extras);
            }
        } finally {
            extrasLock.unlock();
        }
        host.republish(messageId);
    }

    public void todos(TodoFiler t) {
        this.todos = t;
    }

    public MaiaStore store() {
        return store;
    }

    public Room room() {
        return room;
    }

    /** The focus shield. */
    public Shield shield() {
        return shield;
    }

    /** The decision tray's rows. */
    public TrayStore trayStore() {
        return trayStore;
    }

    // ---------------------------------------------------------------- the decision tray (API.md §23 "The tray")

    private static final java.util.regex.Pattern DEVICE = java.util.regex.Pattern.compile("dv-[a-z0-9]{8,32}");
    private static final java.util.regex.Pattern OUT_ID = java.util.regex.Pattern.compile("po-[a-z2-7]{20}");
    private static final Set<String> DELIVERED = Set.of("sent", "queued", "failed", "gone", "changed", "expired");
    private static final java.util.regex.Pattern SHA256 = java.util.regex.Pattern.compile("[0-9a-f]{64}");
    /** A queued reply or to-do answer waits this long for its desk to wake; an approval's own expiry otherwise. */
    static final long OUT_MS = 24L * 3_600_000L;

    private Tray.Paper paperOf(Map<String, Object> p) throws RpcError {
        Object id = p.get("paperId");
        if (!(id instanceof String paperId) || !Tray.paperIdOk(paperId)) {
            throw RpcError.badRequest("paperId");
        }
        Tray.Paper paper = room.paper(paperId);
        if (paper == null) {
            Tray.State s = trayStore.state(paperId);
            if (s != null && !s.open()) {
                throw RpcError.of("conflict", "reason", "answered", "state", s.state());
            }
            throw RpcError.notFound("paper");
        }
        return paper;
    }

    /**
     * {@code agent.maia.tray.get}: one paper ({@code {paperId}}), or every open one, Later ones too, with the answers
     * waiting for a desk ({@code out}: the member's own words only until sent), for the office to carry when a desk's
     * link opens.
     */
    private Map<String, Object> trayGet(Map<String, Object> p) throws RpcError {
        long now = clock.millis();
        if (p.get("paperId") != null) {
            Tray.Paper paper = paperOf(p);
            return Map.of("paper", paper.view());
        }
        List<Map<String, Object>> papers = new ArrayList<>();
        for (Tray.Paper x : room.papers()) {
            Map<String, Object> v = new LinkedHashMap<>(x.view());
            v.put("laterUntil", x.state().laterUntil() > now ? x.state().laterUntil() : null);
            papers.add(v);
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (TrayStore.Out o : trayStore.out()) {
            if (o.expiresAt() != null && o.expiresAt() <= now) {
                // Older than its source's own expiry: dropped, and the paper says nothing was done.
                trayStore.sent(o.outId());
                Tray.State st = trayStore.state(o.paperId());
                if (st != null) {
                    trayStore.put(st.with("expired"), now);
                }
                continue;
            }
            out.add(o.view());
        }
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("papers", papers);
        r.put("out", out);
        return r;
    }

    /**
     * {@code agent.maia.tray.answer}: the member's answer to a paper ({@code {paperId, answerId, text?, device?}}), or
     * the office's word on carrying one ({@code {paperId, outId, delivered}}). The member's tap is the only way a paper
     * is answered: she has no tool for it. An answer for the asking desk is queued here first (so a closed office
     * loses nothing) and the office carries it with the member's own token; her brief's follow-up goes from here.
     */
    private Map<String, Object> trayAnswer(Map<String, Object> p) throws RpcError {
        long now = clock.millis();
        if (p.get("outId") != null) {
            return trayDelivered(p, now);
        }
        Tray.Paper paper = paperOf(p);
        String answerId = p.get("answerId") instanceof String a && (Tray.answerIdOk(a) || "custom".equals(a)) ? a
                : null;
        if (answerId == null) {
            throw RpcError.badRequest("answerId");
        }
        String text = p.get("text") instanceof String t ? t : null;
        if (p.get("text") != null && text == null) {
            throw RpcError.badRequest("text");
        }
        String device = p.get("device") instanceof String d && DEVICE.matcher(d).matches() ? d : null;
        // Approve names the payload the member saw (its hash, from the asking desk at draw time): the office approves
        // only that, and anything else comes back "This changed" (Security's TRAY-M1).
        Tray.Answer chosen = "custom".equals(answerId) ? null : paper.answer(answerId);
        String sha256 = p.get("sha256") instanceof String h && SHA256.matcher(h).matches() ? h : null;
        if (p.get("sha256") != null && sha256 == null) {
            throw RpcError.badRequest("sha256");
        }
        if (chosen != null && "approve".equals(chosen.does()) && sha256 == null) {
            throw RpcError.badRequest("sha256");
        }
        Tray.Answered done = Tray.answer(paper, answerId, text, device, now);
        Tray.State st = done.state();
        trayStore.put(st, now);
        Tray.Answer a = chosen;
        String does = a == null ? ("approval".equals(paper.kind()) ? "decline" : "reply") : a.does();
        audit.append("user", "maia.tray.answer", "paper:" + paper.paperId(), does);
        // Learning: an answer soon after it was put in front of the member is a quick act for that class.
        learnFrom(paper, "go");
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("deliver", done.deliver());
        if ("follow_up".equals(does)) {
            r.put("until", st.laterUntil());
        }
        if ("office".equals(done.deliver()) || "home".equals(done.deliver())) {
            // Kept no longer than its source's own expiry; a reply or a to-do's answer a day at most (TRAY-I1).
            Long expires = paper.expiresAt() != null ? paper.expiresAt() : now + OUT_MS;
            TrayStore.Out o = new TrayStore.Out(AwayStore.id("po-"), paper.paperId(), paper.deskId(),
                    (String) paper.reply().get("kind"), answerId, does, a == null ? null : a.value(),
                    text == null || text.isBlank() ? null : text.strip(), now, expires, "waiting", paper.reply(),
                    "approve".equals(does) ? sha256 : null);
            trayStore.queue(o);
            r.put("outId", o.outId());
            if ("home".equals(done.deliver())) {
                sendBrief(paper, o, a == null ? "Your reply" : a.label());
            }
        }
        if (!st.open()) {
            room.filed(paper, st, now);
        }
        room.rebuild();
        r.put("paper", paperView(paper, st));
        return r;
    }

    private Map<String, Object> paperView(Tray.Paper paper, Tray.State st) {
        Map<String, Object> v = new LinkedHashMap<>(paper.view());
        v.put("state", st.state());
        if (st.answerId() != null) {
            v.put("answer", Map.of("answerId", st.answerId(), "label", st.answerLabel() == null ? "" : st.answerLabel(),
                    "at", st.answeredAt()));
        }
        return v;
    }

    /** The office carried (or couldn't carry) a queued answer to the asking desk. */
    private Map<String, Object> trayDelivered(Map<String, Object> p, long now) throws RpcError {
        if (!(p.get("outId") instanceof String outId) || !OUT_ID.matcher(outId).matches()) {
            throw RpcError.badRequest("outId");
        }
        if (!(p.get("delivered") instanceof String word) || !DELIVERED.contains(word)) {
            throw RpcError.badRequest("delivered");
        }
        TrayStore.Out o = trayStore.out().stream().filter(x -> x.outId().equals(outId)).findFirst().orElse(null);
        if (o == null) {
            // Carried already (another device, a retry): nothing more to do.
            return Map.of();
        }
        if (!(p.get("paperId") instanceof String pid) || !pid.equals(o.paperId())) {
            throw RpcError.badRequest("paperId");
        }
        Tray.State st = trayStore.state(o.paperId());
        String state = switch (word) {
            case "sent" -> "sent";
            case "queued" -> "queued";
            case "gone" -> "withdrawn";
            case "expired" -> "expired";
            case "changed" -> "open";
            default -> "failed";
        };
        if (!"queued".equals(word)) {
            // Sent, or it can't go (answered elsewhere, expired, changed): the member's words go now.
            trayStore.sent(outId);
        }
        if (st != null) {
            Tray.State next = "open".equals(state) ? st.answered(null, null, 0, null, "open") : st.with(state);
            trayStore.put(next, now);
            room.refiled(o.paperId(), state, now);
        }
        audit.append("user", "maia.tray.delivered", "paper:" + o.paperId(), word);
        room.rebuild();
        return Map.of("state", state);
    }

    /** {@code agent.maia.tray.later}: to the next catch-up, while the deadline allows. */
    private Map<String, Object> trayLater(Map<String, Object> p) throws RpcError {
        long now = clock.millis();
        Tray.Paper paper = paperOf(p);
        Tray.State st = Tray.laterOn(paper, now);
        trayStore.put(st, now);
        audit.append("user", "maia.tray.later", "paper:" + paper.paperId(), "ok");
        // Learning: Later counts as Not now for that class.
        learnFrom(paper, "at_catchup");
        room.rebuild();
        return Map.of("paper", paperView(paper, st), "until", st.laterUntil());
    }

    private void learnFrom(Tray.Paper paper, String answer) {
        try {
            shield.answer(Map.of("itemId", paper.itemId(), "answer", answer), clock.millis());
        } catch (RpcError | RuntimeException e) {
            // An item the shield no longer holds: nothing to learn from.
        }
    }

    /**
     * Her brief's follow-up for a report's paper: "The member answered: {label}. {their words}", sent by code under her
     * grant for that desk (her model never reads it). Off the caller's thread: a desk message waits for its answer.
     */
    private void sendBrief(Tray.Paper paper, TrayStore.Out o, String label) {
        String words = "The member answered from their desk: " + MaiaAgent.plain(label, Tray.LABEL_MAX + 12) + "."
                + (o.text() == null ? "" : "\n\nTheir words: " + o.text())
                + ("custom".equals(o.does()) && o.value() != null && !o.value().equals(label) ? "\n\n" + o.value()
                : "");
        Thread.ofVirtual().name("maia-tray-brief").start(() -> {
            String said;
            try {
                said = grantFor(paper.deskId(), "brief") == null ? "refused:maia_grant"
                        : host.trayBrief(paper.deskId(), words);
            } catch (RuntimeException e) {
                said = "refused:failed";
            }
            try {
                trayDelivered(Map.of("paperId", paper.paperId(), "outId", o.outId(), "delivered",
                        said.startsWith("refused") ? "failed" : "sent"), clock.millis());
            } catch (RpcError e) {
                log.warn("a tray answer's state wasn't kept: {}", e.code());
            }
        });
    }

    public Choices choices() {
        return choices;
    }

    /** Her sense of the member's wallet for her briefs. */
    public Wallet wallet() {
        return wallet;
    }

    /** Posts code's own messages of hers: the held notes' question, and a held brief's card. */
    public void poster(Notes.Poster p) {
        wallet.poster(p);
    }

    /** Who answers her briefs on that desk, {@code [agentId, name]}, or null. */
    String[] answeringAgent(String deskId) {
        try {
            String[] peer = host.answeringAgent(deskId);
            return peer != null && peer.length == 2 && peer[0] != null && Room.agentId(peer[0]) ? peer : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** Changes the member's budget settings for her briefs, by code (their tap on its card). */
    void updateBudget(Consumer<Map<String, Object>> change) throws SQLException {
        Map<String, Object> m = mode();
        Map<String, Object> budget = m.get("budget") instanceof Map<?, ?> b ? new LinkedHashMap<>(cast(b))
                : new LinkedHashMap<>();
        change.accept(budget);
        m.put("budget", budget);
        putMode(m);
    }

    public Notes notes() {
        return notes;
    }

    public TodoFiler todoFiler() {
        return todos;
    }

    public Clock clock() {
        return clock;
    }

    // ---------------------------------------------------------------- on, off, the switch

    /** The desk's switch: {@code ON} lists this desk for Maia Mode, {@code OFF} is the kill switch, {@code NONE} is neither. */
    enum Switch {
        NONE,
        ON,
        OFF
    }

    /**
     * The switch, read at every call: {@code DESK_AGENT_MAIA} and {@code <dataDir>/maia-switch}'s first line. {@code off}
     * from either wins; then {@code on} from either. A file that is there but isn't a plain file, can't be read or says
     * anything else is {@code off}: it only ever stops Maia Mode.
     */
    Switch switchState() {
        String env = envSwitch == null ? "" : envSwitch.strip().toLowerCase(java.util.Locale.ROOT);
        if ("off".equals(env)) {
            return Switch.OFF;
        }
        Switch file = Switch.NONE;
        Path path = dataDir.resolve(SWITCH_FILE);
        try {
            if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
                if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
                    return Switch.OFF;
                }
                List<String> lines = Files.readAllLines(path, StandardCharsets.UTF_8);
                String first = lines.isEmpty() ? "" : lines.get(0).strip().toLowerCase(java.util.Locale.ROOT);
                file = "on".equals(first) ? Switch.ON : Switch.OFF;
            }
        } catch (IOException | RuntimeException e) {
            return Switch.OFF;
        }
        if (file == Switch.OFF) {
            return Switch.OFF;
        }
        return "on".equals(env) || file == Switch.ON ? Switch.ON : Switch.NONE;
    }

    /** The kill switch: {@code off} in the file or the environment. */
    @Override
    public boolean killed() {
        return switchState() == Switch.OFF;
    }

    /**
     * Whether this desk is listed for Maia Mode: its switch says {@code on} (Phase 1: the owner's desk only, written at
     * its rollout). The Platform's list (`/v1/me` `maiaMode.enabled`) doesn't reach the desk yet, so the desk refuses
     * Desk Maia unless it was listed here (the Platform's Security read, MMP-L1).
     */
    public boolean listed() {
        return switchState() == Switch.ON;
    }

    /** What the member chose, whatever the switch says. */
    @Override
    public boolean on() {
        return Boolean.TRUE.equals(mode().get("on"));
    }

    /** On, listed, and not stopped by the switch, a teen's band or a Guild Desk: what every action of hers needs. */
    public boolean active() {
        return on() && listed() && host.adult() && !host.guildDesk();
    }

    /** Whether the member accepted the disclosure in force ({@link #DISCLOSURE}), not only an older one. */
    public boolean disclosed() {
        return DISCLOSURE.equals(mode().get("disclosure"));
    }

    /**
     * Refuses {@code precondition_failed} {@code disclosure} while the desk holds only an older disclosure: the room shows
     * the new one, and the member's acceptance (`agent.maia.set {on: true, disclosure}`) lets her work again.
     */
    public void requireDisclosure() throws RpcError {
        if (!disclosed()) {
            throw RpcError.of("precondition_failed", "reason", "disclosure");
        }
    }

    /** Refuses unless {@link #active()}. */
    public void requireActive() throws RpcError {
        if (host.guildDesk()) {
            throw RpcError.of("forbidden", "reason", "guild");
        }
        if (!host.adult()) {
            throw RpcError.of("forbidden", "reason", "age_band");
        }
        Switch sw = switchState();
        if (sw == Switch.OFF) {
            throw RpcError.of("forbidden", "reason", "maia_off");
        }
        if (sw != Switch.ON) {
            throw RpcError.of("forbidden", "reason", "not_listed");
        }
        if (!on()) {
            throw RpcError.of("forbidden", "reason", "maia_off");
        }
    }

    Map<String, Object> mode() {
        try {
            String raw = store.setting(MaiaStore.MODE);
            return raw == null ? new LinkedHashMap<>() : MaiaStore.parse(raw);
        } catch (SQLException e) {
            log.warn("Maia Mode's setting wasn't read: {}", e.getClass().getSimpleName());
            return new LinkedHashMap<>();
        }
    }

    private void putMode(Map<String, Object> m) throws SQLException {
        m.put("updatedAt", clock.millis());
        store.setSetting(MaiaStore.MODE, new String(Json.bytes(m), StandardCharsets.UTF_8));
    }

    @Override
    public Attention.Settings settings() {
        Map<String, Object> a = mode().get("attention") instanceof Map<?, ?> m ? cast(m) : Map.of();
        Attention.Settings d = Attention.Settings.DEFAULT;
        return new Attention.Settings(intIn(a.get("visible"), 1, 5, d.visible()),
                intIn(a.get("interruptEveryMin"), 5, 120, d.interruptEveryMin()),
                intIn(a.get("batchEveryMin"), 10, 240, d.batchEveryMin()),
                !(a.get("quietWhileTyping") instanceof Boolean q) || q,
                intIn(a.get("todosVisible"), 1, 3, d.todosVisible()));
    }

    /**
     * The tier's top for each cap: the Platform's {@code maiaMode} values when deskd sent them, else the defaults
     * ({@link Caps#DEFAULT}). Never a top on her own spend: her service's allowance is that, in credits.
     */
    Caps tierCaps() {
        String raw = host.tier();
        if (raw != null) {
            Map<String, Object> tier = MaiaStore.parse(raw);
            if (tier.get("maiaMode") instanceof Map<?, ?> mm) {
                Map<String, Object> m = cast(mm);
                Caps o = Caps.DEFAULT;
                return new Caps(null,
                        numIn(m.get("startedRunsDailyUsd"), 0, 100, o.startedRunsDailyUsd()),
                        intIn(m.get("briefsPerDay"), 0, 1000, o.briefsPerDay()),
                        intIn(m.get("notesPerDay"), 0, 1000, o.notesPerDay()),
                        intIn(m.get("todosPerDeskPerDay"), 0, 1000, o.todosPerDeskPerDay()));
            }
        }
        return Caps.DEFAULT;
    }

    /** The caps in force: the member's, never above the tier's; her day cap in credits only when the member set one. */
    Caps caps() {
        Caps top = tierCaps();
        Map<String, Object> m = mode().get("caps") instanceof Map<?, ?> c ? cast(c) : Map.of();
        Long credits = m.get("coordinatorDailyCredits") instanceof Number n && n.doubleValue() >= 0
                && n.doubleValue() <= MAX_CAP_CREDITS && n.doubleValue() == Math.rint(n.doubleValue()) ? n.longValue()
                        : null;
        return new Caps(credits,
                numIn(m.get("startedRunsDailyUsd"), 0, top.startedRunsDailyUsd(), top.startedRunsDailyUsd()),
                intIn(m.get("briefsPerDay"), 0, top.briefsPerDay(), top.briefsPerDay()),
                intIn(m.get("notesPerDay"), 0, top.notesPerDay(), top.notesPerDay()),
                intIn(m.get("todosPerDeskPerDay"), 0, top.todosPerDeskPerDay(), top.todosPerDeskPerDay()));
    }

    public int briefsPerDay() {
        return caps().briefsPerDay();
    }

    public int notesPerDay() {
        return caps().notesPerDay();
    }

    public int todosPerDeskPerDay() {
        return caps().todosPerDeskPerDay();
    }

    /** The member's own day cap on her, in whole credits, or null for none (the default). */
    public Long capCredits() {
        return caps().coordinatorDailyCredits();
    }

    /** What her calls drew on this desk today, in the desk's zone, in hundredths of a credit (her service's costCredits). */
    public long creditsTodayCenti() {
        try {
            return store.sum(today(), CREDITS, "all");
        } catch (SQLException e) {
            return 0;
        }
    }

    /** A call of hers drew this much, in hundredths of a credit: counted on today, in the desk's zone. */
    public void creditsSpent(long centi) {
        if (centi <= 0) {
            return;
        }
        try {
            store.add(today(), CREDITS, "all", centi);
        } catch (SQLException e) {
            log.warn("her credits weren't counted: {}", e.getClass().getSimpleName());
        }
    }

    /** Whether the member's own day cap on her is reached: what her calls drew today, at or past it. */
    public boolean capReached() {
        Long cap = capCredits();
        return cap != null && creditsTodayCenti() >= cap * 100;
    }

    /**
     * Her next turn's refusal while the member's own day cap is reached: {@code limit} with reason
     * {@code limit_cap}, window {@code day} and the desk's next midnight; null otherwise.
     */
    public com.minimalistalliance.desk.agent.provider.ProviderException.Details capRefusal() {
        if (!capReached()) {
            return null;
        }
        Instant midnight = LocalDate.parse(today()).plusDays(1).atStartOfDay(host.zone()).toInstant();
        return new com.minimalistalliance.desk.agent.provider.ProviderException.Details(
                com.minimalistalliance.desk.agent.provider.ma.MaiaServiceProvider.CAP, "day", midnight.toString(), null);
    }

    /** Her Maia allowance as her service last reported it, or null before any answer. */
    public Allowance allowance() {
        try {
            return host.allowance();
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** The From Maia tab her notes go to, or null. */
    public String notesTabId() {
        return mode().get("notesTabId") instanceof String s ? s : null;
    }

    /** Today, in the desk's zone. */
    public String today() {
        return LocalDate.ofInstant(Instant.ofEpochMilli(clock.millis()), host.zone()).toString();
    }

    public ZoneId zone() {
        return host.zone();
    }

    // ---------------------------------------------------------------- Room.Source

    @Override
    public void bellRang() {
        Away a = away;
        if (a != null) {
            a.ringChanged();
        }
    }

    @Override
    public long creditsToday() {
        return creditsTodayCenti();
    }

    @Override
    public Long cap() {
        return capCredits();
    }

    @Override
    public Map<String, Object> allowanceView() {
        return allowanceView(allowance());
    }

    /**
     * Her allowance for the room (topic {@code agent.maia} {@code allowance}): the share left and its reset, whether it's
     * used up, whether she's on the lighter model, and the credits when the Platform sends them. Empty before any answer.
     * Never money.
     */
    static Map<String, Object> allowanceView(Allowance a) {
        Map<String, Object> v = new LinkedHashMap<>();
        if (a == null) {
            return v;
        }
        v.put("fraction", Math.round(a.fraction() * 1000) / 1000.0);
        if (a.resetsAt() != null) {
            v.put("resetsAt", a.resetsAt().toString());
        }
        v.put("usedUp", a.usedUp());
        v.put("lighter", a.lighter());
        Credits c = a.credits();
        if (c != null) {
            Map<String, Object> cv = new LinkedHashMap<>();
            cv.put("month", c.month());
            cv.put("monthLeft", c.monthLeft());
            cv.put("week", c.week());
            cv.put("weekUsed", c.weekUsed());
            cv.put("day", c.day());
            cv.put("dayUsed", c.dayUsed());
            cv.put("topUpLeft", c.topUpLeft());
            cv.put("drawingFrom", c.drawingFrom());
            if (c.wallet()) {
                // The one wallet (0.4.10): everything usable, and the starting credits left.
                cv.put("left", c.left());
                cv.put("starting", c.starting());
                if (c.lighterLeft() != null) {
                    cv.put("lighterLeft", c.lighterLeft());
                }
            }
            v.put("credits", cv);
        }
        return v;
    }

    @Override
    public int[] noteCounts() {
        try {
            int today = 0;
            for (MaiaStore.Note n : store.notesOfDay(today())) {
                if ("filed".equals(n.state())) {
                    today++;
                }
            }
            return new int[] {today, store.notesInState("held").size()};
        } catch (SQLException e) {
            return new int[] {0, 0};
        }
    }

    private final java.util.concurrent.atomic.AtomicInteger onIt = new java.util.concurrent.atomic.AtomicInteger();

    @Override
    public Map<String, Object> briefSpend() {
        return on() ? wallet.spendView() : null;
    }

    @Override
    public int[] briefs() {
        int done;
        try {
            done = store.count(today(), "answered", "all");
        } catch (SQLException e) {
            done = 0;
        }
        return new int[] {Math.max(0, onIt.get()), done};
    }

    /** A brief went out and its answer hasn't come. */
    public void briefSent(String deskId) {
        onIt.incrementAndGet();
        try {
            store.grantUsed(deskId, clock.millis());
        } catch (SQLException e) {
            log.warn("a grant's use wasn't kept: {}", e.getClass().getSimpleName());
        }
        audit.append("agent:maia", "maia.brief", "desk:" + deskId, "ok");
        room.rebuild();
    }

    /** A brief's answer came (into her run or her thread). */
    public void briefAnswered(String deskId, String deskName, String agentName, String messageId) {
        briefAnswered(deskId, deskName, agentName, messageId, null);
    }

    /**
     * As above, with the report as code read it: its status for the focus shield, and for the decision tray its summary,
     * the agent's own question and its write-up (a paper when it needs a decision or is blocked).
     */
    public void reportAnswered(String deskId, String deskName, String agentName, String messageId,
            Reports.Report report) {
        if (report != null && messageId != null && ("needs_decision".equals(report.status())
                || "blocked".equals(report.status()))) {
            room.reportFacts(new Tray.ReportFacts(messageId, deskId, deskName, agentName, report.status(),
                    report.summary(), report.ask(), report.writeupId(), clock.millis()));
        }
        briefAnswered(deskId, deskName, agentName, messageId, report == null ? null : report.status());
    }

    /** As above, with the report's code-parsed status (Phase 2's), which the focus shield reads. */
    public void briefAnswered(String deskId, String deskName, String agentName, String messageId, String status) {
        onIt.updateAndGet(n -> Math.max(0, n - 1));
        wallet.answered(deskId);
        try {
            store.take(today(), "answered", "all", Integer.MAX_VALUE);
        } catch (SQLException e) {
            log.warn("an answer wasn't counted: {}", e.getClass().getSimpleName());
        }
        if (messageId != null) {
            room.answered(new Attention.Result(messageId, deskId, deskName == null ? "your desk" : deskName,
                    agentName == null ? "An agent" : agentName, clock.millis(), status));
        } else {
            room.rebuild();
        }
    }

    /** Her run ended: waits it held end with it. */
    public void runEnded() {
        wallet.runEnded();
        room.rebuild();
    }

    @Override
    public double weight() {
        try {
            return choices.counts().weight();
        } catch (SQLException e) {
            return Choices.START;
        }
    }

    @Override
    public Map<String, Map<String, Long>> itemChoices() {
        try {
            return store.items();
        } catch (SQLException e) {
            return Map.of();
        }
    }

    // ---------------------------------------------------------------- grants

    /** Her live grant for this desk with this scope, or null. */
    public MaiaStore.Grant grantFor(String deskId, String scope) {
        try {
            MaiaStore.Grant g = store.grant(deskId);
            return g != null && g.allows(scope, clock.millis()) ? g : null;
        } catch (SQLException e) {
            return null;
        }
    }

    public List<MaiaStore.Grant> grants() {
        try {
            return store.grants();
        } catch (SQLException e) {
            return List.of();
        }
    }

    // ---------------------------------------------------------------- RPC

    /** @return whether {@code method} is one of Maia Mode's */
    public static boolean handles(String method) {
        return method.startsWith("agent.maia.");
    }

    /** One {@code agent.maia.*} call. {@code half} says, for a grant, where her W6 half stands: {@code none} etc. */
    public Map<String, Object> call(String method, Map<String, Object> p, Caller caller,
            java.util.function.Function<String, String> half) throws RpcError, SQLException {
        if (!caller.isOwner()) {
            throw RpcError.of("forbidden", "reason", "permission");
        }
        if (host.guildDesk()) {
            throw RpcError.of("forbidden", "reason", "guild");
        }
        switch (method) {
            case "agent.maia.get" -> {
                return Map.of("maia", view());
            }
            case "agent.maia.reach.get" -> {
                // A read, as agent.maia.get: the member's settings for what reaches them.
                return Map.of("reach", reachView());
            }
            case "agent.maia.set" -> {
                return Map.of("maia", set(p));
            }
            case "agent.maia.forget" -> {
                forget();
                return Map.of("maia", view());
            }
            case "agent.maia.grants.list" -> {
                return Map.of("grants", grantViews(half));
            }
            case "agent.maia.grant.revoke" -> {
                revoke(deskIdOf(p));
                return Map.of("grants", grantViews(half));
            }
            case "agent.maia.choices.get" -> {
                return Map.of("choices", choices.counts().view());
            }
            case "agent.maia.notes.list" -> {
                return Map.of("notes", notesList(p));
            }
            case "agent.maia.todos.set" -> {
                // Taking a switch away is always allowed, Maia Mode off or not (Security's DMA-L2).
                if (Boolean.FALSE.equals(p.get("on")) && todos != null) {
                    return Map.of("todos", todos.set(p));
                }
            }
            default -> {
                // Everything else needs Maia Mode on.
            }
        }
        requireActive();
        return switch (method) {
            case "agent.maia.observe" -> {
                room.observe(p);
                Away a = away;
                if (a != null) {
                    a.observed();
                }
                yield Map.of();
            }
            case "agent.maia.typing" -> {
                if (!(p.get("typing") instanceof Boolean t)) {
                    throw RpcError.badRequest("typing");
                }
                room.typing(t);
                yield Map.of();
            }
            case "agent.maia.seen" -> {
                boolean back = Boolean.TRUE.equals(p.get("back"));
                if (back) {
                    endSnoozes();
                }
                room.seen(back);
                Away a = away;
                if (back && a != null) {
                    a.back();
                }
                yield Map.of();
            }
            case "agent.maia.item.snooze" -> Map.of("item", snooze(p));
            case "agent.maia.item.dismiss" -> {
                dismiss(p);
                yield Map.of();
            }
            case "agent.maia.choose" -> choose(p);
            case "agent.maia.choices.reset" -> {
                Choices.Counts c = choices.reset();
                audit.append("user", "maia.choices.reset", "maia", "ok");
                room.rebuild();
                yield Map.of("choices", c.view());
            }
            case "agent.maia.grant.set" -> Map.of("grant", grantSet(p, half));
            case "agent.maia.reach.set" -> {
                shield.set(p, clock.millis());
                audit.append("user", "maia.reach.set", "maia", "ok");
                room.rebuild();
                yield Map.of("reach", reachView());
            }
            case "agent.maia.reach.answer" -> {
                int before = shield.learnedView(clock.millis()).size();
                shield.answer(p, clock.millis());
                int after = shield.learnedView(clock.millis()).size();
                if (after != before) {
                    audit.append("user", "maia.reach.rule", "maia", "learned:" + (p.get("answer") instanceof String a
                            && a.matches("[a-z_]{1,24}") ? a : "answer"));
                }
                room.rebuild();
                yield Map.of();
            }
            case "agent.maia.reach.hold" -> {
                Map<String, Object> hold = shield.hold(p, clock.millis());
                audit.append("user", "maia.reach.hold", "maia", hold.isEmpty() ? "clear" : "until");
                room.rebuild();
                yield Map.of("hold", hold);
            }
            case "agent.maia.reach.held" -> {
                String deskId = p.get("deskId") instanceof String d && Room.deskId(d) ? d : null;
                String kind = p.get("kind") instanceof String k && k.matches("[a-z_]{1,24}") ? k : null;
                String contactId = p.get("contactId") instanceof String c && Focus.contactId(c) ? c : null;
                int limit = p.get("limit") instanceof Number n ? Math.max(1, Math.min(200, n.intValue())) : 100;
                yield Map.of("items", shield.held(deskId, kind, contactId, limit, clock.millis()));
            }
            case "agent.maia.reach.back" -> {
                shield.back(stringOf(p, "cardId"), !Boolean.FALSE.equals(p.get("taken")), clock.millis());
                room.rebuild();
                yield Map.of();
            }
            case "agent.maia.reach.working.clear" -> {
                shield.clearTask(clock.millis());
                room.rebuild();
                yield Map.of();
            }
            case "agent.maia.reach.learned.undo" -> {
                shield.undoLearned(stringOf(p, "ruleId"), clock.millis());
                audit.append("user", "maia.reach.rule", "maia", "undo");
                room.rebuild();
                yield Map.of("reach", reachView());
            }
            case "agent.maia.tray.get" -> trayGet(p);
            case "agent.maia.tray.answer" -> trayAnswer(p);
            case "agent.maia.tray.later" -> trayLater(p);
            case "agent.maia.reach.learned.reset" -> {
                shield.resetLearned(clock.millis());
                audit.append("user", "maia.reach.rule", "maia", "reset");
                room.rebuild();
                yield Map.of("reach", reachView());
            }
            case "agent.maia.note.file" -> {
                Notes n = notes;
                if (n == null) {
                    throw RpcError.of("unavailable", "reason", "notes");
                }
                yield Map.of("note", n.file(stringOf(p, "noteId"), stringOf(p, "area")));
            }
            case "agent.maia.todos.set" -> {
                TodoFiler t = todos;
                if (t == null) {
                    throw RpcError.of("unavailable", "reason", "todos");
                }
                yield Map.of("todos", t.set(p));
            }
            default -> throw RpcError.of("not_found", "detail", "method");
        };
    }

    Map<String, Object> view() {
        Map<String, Object> m = mode();
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("on", Boolean.TRUE.equals(m.get("on")));
        v.put("killed", killed());
        v.put("listed", listed());
        v.put("agentId", MaiaAgent.ID);
        v.put("disclosure", m.get("disclosure"));
        v.put("home", Map.of("deskId", m.get("homeDeskId") instanceof String h ? h : ""));
        Attention.Settings s = settings();
        Map<String, Object> a = new LinkedHashMap<>();
        a.put("visible", s.visible());
        a.put("nowMax", 1);
        a.put("interruptEveryMin", s.interruptEveryMin());
        a.put("batchEveryMin", s.batchEveryMin());
        a.put("quietWhileTyping", s.quietWhileTyping());
        a.put("todosVisible", s.todosVisible());
        v.put("attention", a);
        v.put("caps", caps().view());
        v.put("reports", Map.of("laterMaxMin", laterMaxMin()));
        v.put("budget", wallet.view());
        v.put("notesTabId", notesTabId());
        v.put("choices", Map.of("weight", Choices.round(weight())));
        TodoFiler t = todos;
        try {
            v.put("todos", t == null ? List.of() : t.views());
        } catch (SQLException e) {
            v.put("todos", List.of());
        }
        v.put("updatedAt", m.get("updatedAt"));
        return v;
    }

    private Map<String, Object> set(Map<String, Object> p) throws RpcError, SQLException {
        Set<String> known = Set.of("on", "disclosure", "attention", "caps", "notesTabId", "homeDeskId", "noteRules",
                "reports", "budget");
        for (String key : p.keySet()) {
            if (!known.contains(key)) {
                throw RpcError.of("bad_request", "detail", key);
            }
        }
        Map<String, Object> m = mode();
        boolean wasOn = Boolean.TRUE.equals(m.get("on"));
        Boolean on = p.get("on") instanceof Boolean b ? b : null;
        if (p.containsKey("on") && on == null) {
            throw RpcError.badRequest("on");
        }
        boolean turningOn = Boolean.TRUE.equals(on) && !wasOn;
        if (Boolean.TRUE.equals(on) || (wasOn && on == null)) {
            // Changing anything but turning it off needs it allowed here.
            if (!host.adult()) {
                throw RpcError.of("forbidden", "reason", "age_band");
            }
            if (killed()) {
                throw RpcError.of("forbidden", "reason", "maia_off");
            }
            if (!listed()) {
                throw RpcError.of("forbidden", "reason", "not_listed");
            }
            if (free()) {
                throw RpcError.of("forbidden", "reason", "tier");
            }
        }
        boolean accepting = Boolean.TRUE.equals(on) && DISCLOSURE.equals(p.get("disclosure"))
                && !DISCLOSURE.equals(m.get("disclosure"));
        if (Boolean.TRUE.equals(on)) {
            // Turning on, or saying on again, needs the disclosure in force: an older acceptance doesn't count (v2, Nov 14).
            Object disclosure = p.get("disclosure");
            if (!DISCLOSURE.equals(disclosure) && !DISCLOSURE.equals(m.get("disclosure"))) {
                throw RpcError.of("precondition_failed", "reason", "disclosure");
            }
        }
        if (p.get("attention") != null) {
            m.put("attention", attention(p.get("attention"), m.get("attention")));
        }
        if (p.get("caps") != null) {
            m.put("caps", capsOf(p.get("caps"), m.get("caps")));
        }
        if (p.get("budget") != null) {
            // The member's own comfort for her briefs (their agents, their keys): never a desk's limit.
            m.put("budget", Wallet.set(p.get("budget"), m.get("budget")));
        }
        if (p.containsKey("notesTabId")) {
            Object tab = p.get("notesTabId");
            if (tab != null && !(tab instanceof String s && s.matches("[A-Za-z0-9_:.-]{1,80}"))) {
                throw RpcError.badRequest("notesTabId");
            }
            m.put("notesTabId", tab);
        }
        if (p.containsKey("noteRules")) {
            m.put("noteRules", noteRules(p.get("noteRules")));
        }
        if (p.containsKey("reports")) {
            // When reports marked "later" are read at the latest (Maia Mode Phase 2), minutes.
            if (!(p.get("reports") instanceof Map<?, ?> r) || r.keySet().stream().anyMatch(k -> !"laterMaxMin".equals(k))) {
                throw RpcError.badRequest("reports");
            }
            m.put("reports", Map.of("laterMaxMin", ranged(r.get("laterMaxMin"), Away.LATER_MIN_MIN, Away.LATER_MAX_MIN,
                    "reports.laterMaxMin")));
        }
        if (p.get("homeDeskId") instanceof String home) {
            if (!Room.deskId(home)) {
                throw RpcError.badRequest("homeDeskId");
            }
            m.put("homeDeskId", home);
        }
        if (turningOn || accepting) {
            m.put("disclosure", DISCLOSURE);
            store.ensureAgent();
        }
        if (on != null) {
            m.put("on", on);
        }
        putMode(m);
        if (turningOn || accepting) {
            // Her row is bound to Minimalist Alliance's service, never a member's key.
            host.agentMade();
        }
        if (turningOn) {
            audit.append("user", "maia.on", "maia", "ok");
        } else if (accepting) {
            audit.append("user", "maia.disclosure", "maia", DISCLOSURE);
        }
        if (Boolean.FALSE.equals(on) && wasOn) {
            // Off: every grant goes at once and her runs stop. Notes and to-dos stay: they're the member's.
            int revoked = store.deleteAllGrants();
            host.stopRuns();
            audit.append("user", "maia.off", "maia", "grants:" + revoked);
        } else if (!turningOn) {
            audit.append("user", "maia.set", "maia", "ok");
        }
        room.rebuild();
        return view();
    }

    private boolean free() {
        String raw = host.tier();
        if (raw == null) {
            return false;
        }
        Map<String, Object> tier = MaiaStore.parse(raw);
        return "free".equals(tier.get("name")) || "free".equals(tier.get("tier"));
    }

    /** The member's word rules for notes: {@code [{word, area}]}, at most 20, each word 1 to 40 plain characters. */
    private static List<Map<String, Object>> noteRules(Object raw) throws RpcError {
        if (!(raw instanceof List<?> list) || list.size() > 20) {
            throw RpcError.badRequest("noteRules");
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object o : list) {
            if (!(o instanceof Map<?, ?> r) || !(r.get("word") instanceof String w) || w.isBlank()
                    || w.strip().length() > 40 || TextChecks.hidden(w) || !(r.get("area") instanceof String a)
                    || !Set.of("work", "personal").contains(a)) {
                throw RpcError.badRequest("noteRules");
            }
            out.add(Map.of("word", w.strip(), "area", a));
        }
        return out;
    }

    private static Map<String, Object> attention(Object raw, Object before) throws RpcError {
        if (!(raw instanceof Map<?, ?> given)) {
            throw RpcError.badRequest("attention");
        }
        Map<String, Object> out = before instanceof Map<?, ?> b ? new LinkedHashMap<>(cast(b)) : new LinkedHashMap<>();
        for (Map.Entry<?, ?> e : given.entrySet()) {
            String k = String.valueOf(e.getKey());
            Object v = e.getValue();
            switch (k) {
                case "visible" -> out.put(k, ranged(v, 1, 5, "attention.visible"));
                case "nowMax" -> {
                    if (!(v instanceof Number n) || n.intValue() != 1) {
                        throw RpcError.of("bad_request", "reason", "range", "detail", "attention.nowMax");
                    }
                }
                case "interruptEveryMin" -> out.put(k, ranged(v, 5, 120, "attention.interruptEveryMin"));
                case "batchEveryMin" -> out.put(k, ranged(v, 10, 240, "attention.batchEveryMin"));
                case "todosVisible" -> out.put(k, ranged(v, 1, 3, "attention.todosVisible"));
                case "quietWhileTyping" -> {
                    if (!(v instanceof Boolean)) {
                        throw RpcError.badRequest("attention.quietWhileTyping");
                    }
                    out.put(k, v);
                }
                default -> throw RpcError.of("bad_request", "detail", "attention." + k);
            }
        }
        return out;
    }

    private Map<String, Object> capsOf(Object raw, Object before) throws RpcError {
        if (!(raw instanceof Map<?, ?> given)) {
            throw RpcError.badRequest("caps");
        }
        Caps top = tierCaps();
        Map<String, Object> out = before instanceof Map<?, ?> b ? new LinkedHashMap<>(cast(b)) : new LinkedHashMap<>();
        // A dollar cap on her is retired (her calls are the company's): one stored before goes with this change.
        out.remove("coordinatorDailyUsd");
        for (Map.Entry<?, ?> e : given.entrySet()) {
            String k = String.valueOf(e.getKey());
            if ("coordinatorDailyCredits".equals(k)) {
                // The member's own day cap on her, in whole credits; null clears it.
                if (e.getValue() == null) {
                    out.remove(k);
                    continue;
                }
                if (!(e.getValue() instanceof Number n) || n.doubleValue() != Math.rint(n.doubleValue())
                        || n.doubleValue() < 0 || n.doubleValue() > MAX_CAP_CREDITS) {
                    throw RpcError.of("bad_request", "reason", "range", "detail", "caps." + k);
                }
                out.put(k, n.longValue());
                continue;
            }
            if (!(e.getValue() instanceof Number n) || n.doubleValue() < 0 || Double.isNaN(n.doubleValue())) {
                throw RpcError.badRequest("caps." + k);
            }
            double limit = switch (k) {
                case "startedRunsDailyUsd" -> top.startedRunsDailyUsd();
                case "briefsPerDay" -> top.briefsPerDay();
                case "notesPerDay" -> top.notesPerDay();
                case "todosPerDeskPerDay" -> top.todosPerDeskPerDay();
                default -> throw RpcError.of("bad_request", "detail", "caps." + k);
            };
            if (n.doubleValue() > limit) {
                throw RpcError.of("bad_request", "reason", "above_tier", "detail", "caps." + k);
            }
            out.put(k, n);
        }
        return out;
    }

    private static int ranged(Object v, int lo, int hi, String field) throws RpcError {
        if (!(v instanceof Number n) || n.doubleValue() != Math.rint(n.doubleValue()) || n.intValue() < lo
                || n.intValue() > hi) {
            throw RpcError.of("bad_request", "reason", "range", "detail", field);
        }
        return n.intValue();
    }

    /** {@code {reach}}: the member's settings, what's learned (lines with names drawn now) and the counts. */
    Map<String, Object> reachView() {
        long now = clock.millis();
        Map<String, Object> v = new LinkedHashMap<>(shield.settings(now).view());
        v.put("learned", shield.learnedView(now));
        v.put("counts", shield.counts(now));
        return v;
    }

    private void forget() throws SQLException {
        shield.forget(clock.millis());
        trayStore.forget();
        host.stopRuns();
        Away a = away;
        if (a != null) {
            a.store().forget();
        }
        store.pruneChats(Long.MAX_VALUE);
        store.deleteThread();
        store.forget();
        host.clearMemory();
        audit.append("user", "maia.forget", "maia", "ok");
        room.rebuild();
    }

    // ---------------------------------------------------------------- grants

    private List<Map<String, Object>> grantViews(java.util.function.Function<String, String> half)
            throws SQLException {
        List<Map<String, Object>> out = new ArrayList<>();
        String today = today();
        for (MaiaStore.Grant g : store.grants()) {
            out.add(grantView(g, half, today));
        }
        return out;
    }

    private Map<String, Object> grantView(MaiaStore.Grant g, java.util.function.Function<String, String> half,
            String today) throws SQLException {
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("grantId", g.grantId());
        v.put("deskId", g.deskId());
        v.put("deskName", g.deskName());
        v.put("scopes", g.scopes());
        v.put("keepsToItself", g.keepsToItself());
        v.put("expiresAt", g.expiresAt());
        v.put("createdAt", g.createdAt());
        v.put("briefsToday", store.count(today, "brief", g.deskId()));
        v.put("lastUsedAt", g.lastUsedAt());
        v.put("half", half == null ? "none" : half.apply(g.deskId()));
        return v;
    }

    private Map<String, Object> grantSet(Map<String, Object> p, java.util.function.Function<String, String> half)
            throws RpcError, SQLException {
        Set<String> known = Set.of("deskId", "deskName", "scopes", "days", "keepsToItself");
        for (String key : p.keySet()) {
            if (!known.contains(key)) {
                throw RpcError.of("bad_request", "detail", key);
            }
        }
        String deskId = deskIdOf(p);
        String name = p.get("deskName") instanceof String n ? n.strip() : "";
        if (name.isEmpty() || name.codePointCount(0, name.length()) > 60 || TextChecks.hidden(name)
                || name.chars().anyMatch(Character::isISOControl)) {
            throw RpcError.of("bad_request", "reason", "name", "detail", "deskName");
        }
        if (!(p.get("scopes") instanceof List<?> list) || list.isEmpty()) {
            throw RpcError.badRequest("scopes");
        }
        List<String> scopes = new ArrayList<>();
        for (Object s : list) {
            if (!(s instanceof String scope) || !SCOPES.contains(scope)) {
                throw RpcError.badRequest("scopes");
            }
            if (!scopes.contains(scope)) {
                scopes.add(scope);
            }
        }
        scopes.sort(null);
        int days = p.get("days") == null ? GRANT_DAYS : ranged(p.get("days"), 1, GRANT_MAX_DAYS, "days");
        Object keeps = p.get("keepsToItself");
        if (keeps != null && !(keeps instanceof Boolean)) {
            throw RpcError.badRequest("keepsToItself");
        }
        long now = clock.millis();
        MaiaStore.Grant before = store.grant(deskId);
        if (before == null && store.grants().size() >= MAX_GRANTS) {
            throw RpcError.of("bad_request", "reason", "too_many", "detail", "deskId");
        }
        MaiaStore.Grant g = new MaiaStore.Grant(deskId, before == null ? newId("mg") : before.grantId(), name,
                scopes, keeps == null ? before != null && before.keepsToItself() : (Boolean) keeps,
                now + days * 86_400_000L, before == null ? now : before.createdAt(),
                before == null ? null : before.lastUsedAt());
        store.putGrant(g);
        audit.append("user", "maia.grant", "desk:" + deskId + " scopes:" + String.join(",", scopes) + " days:" + days
                + (g.keepsToItself() ? " keeps" : ""), before == null ? "ok" : "extended");
        room.rebuild();
        return grantView(g, half, today());
    }

    private void revoke(String deskId) throws RpcError, SQLException {
        if (!store.deleteGrant(deskId)) {
            throw RpcError.notFound("grant");
        }
        audit.append("user", "maia.revoke", "desk:" + deskId, "ok");
        room.rebuild();
    }

    // ---------------------------------------------------------------- items

    private Map<String, Object> snooze(Map<String, Object> p) throws RpcError, SQLException {
        Attention.Item item = room.item(stringOf(p, "itemId"));
        if (item == null) {
            throw RpcError.notFound("item");
        }
        long until = clock.millis() + Room.SNOOZE;
        store.putItem(item.key(), until, null);
        room.rebuild();
        Map<String, Object> v = item.view("snoozed");
        v.put("snoozedUntil", until);
        return v;
    }

    private void dismiss(Map<String, Object> p) throws RpcError, SQLException {
        Attention.Item item = room.item(stringOf(p, "itemId"));
        if (item == null) {
            throw RpcError.notFound("item");
        }
        if (!Attention.dismissable(item.kind())) {
            throw RpcError.of("bad_request", "reason", "kind");
        }
        store.putItem(item.key(), null, clock.millis());
        if ("result".equals(item.kind())) {
            room.resultsSeen();
        }
        room.rebuild();
    }

    private void endSnoozes() throws SQLException {
        for (Map.Entry<String, Map<String, Long>> e : store.items().entrySet()) {
            if (e.getValue().get("snoozedUntil") != null) {
                store.putItem(e.getKey(), null, e.getValue().get("dismissedAt"));
            }
        }
    }

    // ---------------------------------------------------------------- choices

    /** A tap on one of her choices: its label goes to her as the member's message. */
    private Map<String, Object> choose(Map<String, Object> p) throws RpcError, SQLException {
        String messageId = stringOf(p, "messageId");
        String choiceId = stringOf(p, "choiceId");
        Map<String, Object> choice;
        String label = null;
        extrasLock.lock();
        try {
            Map<String, Object> extras = store.extras(messageId);
            if (extras == null || !(extras.get("choices") instanceof Map<?, ?> c)) {
                throw RpcError.notFound("message");
            }
            choice = new LinkedHashMap<>(cast(c));
            if (!"open".equals(choice.get("state"))) {
                throw RpcError.of("conflict", "reason", "answered");
            }
            if (choice.get("options") instanceof List<?> options) {
                for (Object o : options) {
                    if (o instanceof Map<?, ?> option && choiceId.equals(option.get("id"))
                            && option.get("label") instanceof String l) {
                        label = l;
                    }
                }
            }
            if (label == null) {
                throw RpcError.notFound("choice");
            }
            choice.put("state", "answered");
            choice.put("answer", choiceId);
            extras.put("choices", choice);
            store.putExtras(messageId, extras);
        } finally {
            extrasLock.unlock();
        }
        host.republish(messageId);
        if ("notes".equals(choice.get("kind")) && choice.get("noteIds") instanceof List<?> ids) {
            // Code's own question about held notes: the answer files them, and starts no run of hers.
            Notes n = notes;
            if (n == null) {
                throw RpcError.of("unavailable", "reason", "notes");
            }
            n.answer(ids, choiceId);
            return Map.of("messageId", messageId);
        }
        if ("away".equals(choice.get("kind")) && "close".equals(choiceId)) {
            // Code's own "That's all for now" under the summary: nothing more, and no run of hers.
            room.rebuild();
            return Map.of("messageId", messageId);
        }
        if ("budget".equals(choice.get("kind"))) {
            // Code's own card for a held brief: "Skip" starts nothing; the rest go to her as the member's words.
            Map<String, Object> done = wallet.answer(messageId, choice, choiceId, label);
            if (done != null) {
                return done;
            }
            Map<String, Object> sent = host.sendAsMember(label);
            room.rebuild();
            return sent;
        }
        choices.record("tapped");
        // The tap is the member's message, exactly as if typed: her run starts on it.
        Map<String, Object> sent = host.sendAsMember(label);
        room.rebuild();
        return sent;
    }

    /**
     * The member is about to send her a message (not a tap): open choices are answered "Other" or passed by, and the
     * message is read for an ask for more or fewer choices. Counts only.
     */
    public void beforeSend(String text, Object choice) throws RpcError, SQLException {
        requireActive();
        boolean other = choice instanceof Map<?, ?> c && Boolean.TRUE.equals(c.get("other"));
        if (choice != null && !(choice instanceof Map<?, ?>)) {
            throw RpcError.badRequest("choice");
        }
        String open;
        boolean forThis = false;
        extrasLock.lock();
        try {
            open = store.openChoices();
            if (open != null) {
                Map<String, Object> extras = store.extras(open);
                Map<String, Object> ch = new LinkedHashMap<>(cast((Map<?, ?>) extras.get("choices")));
                forThis = other && choice instanceof Map<?, ?> c && open.equals(c.get("messageId"));
                ch.put("state", forThis ? "answered" : "passed");
                ch.put("answer", forThis ? "other" : null);
                extras.put("choices", ch);
                store.putExtras(open, extras);
            }
        } finally {
            extrasLock.unlock();
        }
        if (open != null) {
            choices.record(forThis ? "other" : "ignored");
            host.republish(open);
        }
        switch (Choices.ask(text)) {
            case MORE -> choices.record("askedMore");
            case FEWER -> choices.record("askedFewer");
            default -> {}
        }
    }

    /** {@code ask_member}: her question with choices on her reply. Her last call in a run wins. */
    public String offer(String replyId, Map<String, Object> input) throws SQLException {
        if (wallet.cardOpen()) {
            return "Refused: held. The member has code's choice about a held brief open: wait for their answer.";
        }
        String[] why = new String[1];
        Map<String, Object> shaped = Choices.shape(input.get("question"), input.get("choices"), why);
        if (shaped == null) {
            return "Refused: " + why[0] + ". Give a short question and 2 to 4 short, different answers in the member's"
                    + " words, plain text, your pick first.";
        }
        boolean again;
        extrasLock.lock();
        try {
            Map<String, Object> extras = store.extras(replyId);
            extras = extras == null ? new LinkedHashMap<>() : extras;
            again = extras.get("choices") != null;
            extras.put("choices", shaped);
            store.putExtras(replyId, extras);
        } finally {
            extrasLock.unlock();
        }
        if (!again) {
            choices.record("offered");
        }
        host.republish(replyId);
        // The run ends here when this is the step's only kind of call (MaiaProfile's endsRun): nothing more is written.
        // With other calls beside it, her next step adds only what's new (the restatement guard backs that up).
        return "Shown to the member under your reply as tappable choices, with Other. Your reply is complete: don't"
                + " write it again or list the choices.";
    }

    /** Her extras for one of her replies, to merge into its view, or null. */
    public Map<String, Object> extras(String messageId) {
        try {
            return store.extras(messageId);
        } catch (SQLException e) {
            return null;
        }
    }

    /** Adds a note chip to a reply of hers. */
    public void putNoteChip(String replyId, Map<String, Object> chip) throws SQLException {
        extrasLock.lock();
        try {
            Map<String, Object> extras = store.extras(replyId);
            extras = extras == null ? new LinkedHashMap<>() : extras;
            List<Object> chips = extras.get("notes") instanceof List<?> l ? new ArrayList<>(l) : new ArrayList<>();
            chips.removeIf(c -> c instanceof Map<?, ?> m && chip.get("area").equals(m.get("area")));
            chips.add(chip);
            extras.put("notes", chips);
            store.putExtras(replyId, extras);
        } finally {
            extrasLock.unlock();
        }
        host.republish(replyId);
    }

    /** A private answer from this desk came into the run of this reply of hers ("keeps to itself", DMA-L1). */
    public void originOnReply(String replyId, String deskId) {
        extrasLock.lock();
        try {
            Map<String, Object> extras = store.extras(replyId);
            extras = extras == null ? new LinkedHashMap<>() : extras;
            List<Object> origins = extras.get("deskOrigins") instanceof List<?> l ? new ArrayList<>(l)
                    : new ArrayList<>();
            if (!origins.contains(deskId)) {
                origins.add(deskId);
            }
            extras.put("deskOrigins", origins);
            store.putExtras(replyId, extras);
        } catch (SQLException e) {
            log.warn("an answer's desk wasn't kept: {}", e.getClass().getSimpleName());
        } finally {
            extrasLock.unlock();
        }
    }

    /**
     * Her run ended on her allowance (the service's {@code 429 limit}): the reply carries {@code limit: {reason, window,
     * resetsAt}}, as far as the service said, for the room's one line with the reset in the member's own time.
     */
    public void limitOnReply(String replyId, com.minimalistalliance.desk.agent.provider.ProviderException.Details d) {
        Map<String, Object> limit = new LinkedHashMap<>();
        if (d != null) {
            if (d.reason() != null) {
                limit.put("reason", d.reason());
            }
            if (d.window() != null) {
                limit.put("window", d.window());
            }
            if (d.resetsAt() != null) {
                limit.put("resetsAt", d.resetsAt());
            }
        }
        extrasLock.lock();
        try {
            Map<String, Object> extras = store.extras(replyId);
            extras = extras == null ? new LinkedHashMap<>() : extras;
            extras.put("limit", limit);
            store.putExtras(replyId, extras);
        } catch (SQLException e) {
            log.warn("her limit wasn't kept on her reply: {}", e.getClass().getSimpleName());
        } finally {
            extrasLock.unlock();
        }
    }

    /** Puts {@code doc} (a handover card: its desk and document) on a reply of hers; the last one wins. */
    public void putDoc(String replyId, Map<String, Object> doc) throws SQLException {
        extrasLock.lock();
        try {
            Map<String, Object> extras = store.extras(replyId);
            extras = extras == null ? new LinkedHashMap<>() : extras;
            extras.put("doc", doc);
            store.putExtras(replyId, extras);
        } finally {
            extrasLock.unlock();
        }
        host.republish(replyId);
    }

    /** Puts {@code show} on a reply of hers. */
    public void putShow(String replyId, Map<String, Object> show) throws SQLException {
        extrasLock.lock();
        try {
            Map<String, Object> extras = store.extras(replyId);
            extras = extras == null ? new LinkedHashMap<>() : extras;
            extras.put("show", show);
            store.putExtras(replyId, extras);
        } finally {
            extrasLock.unlock();
        }
        host.republish(replyId);
    }

    private List<Map<String, Object>> notesList(Map<String, Object> p) throws RpcError, SQLException {
        String day = p.get("day") == null ? today() : stringOf(p, "day");
        try {
            LocalDate.parse(day);
        } catch (RuntimeException e) {
            throw RpcError.badRequest("day");
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (MaiaStore.Note n : store.notesOfDay(day)) {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("noteId", n.id());
            v.put("area", n.area());
            v.put("kind", n.kind());
            v.put("state", n.state());
            v.put("approvalId", n.approvalId());
            v.put("pageId", n.pageId());
            v.put("at", n.at());
            out.add(v);
        }
        return out;
    }

    // ---------------------------------------------------------------- helpers

    public void audit(String actor, String action, String target, String decision) {
        audit.append(actor, action, target, decision);
    }

    static String deskIdOf(Map<String, Object> p) throws RpcError {
        if (!(p.get("deskId") instanceof String id) || !Room.deskId(id)) {
            throw RpcError.badRequest("deskId");
        }
        return id;
    }

    static String stringOf(Map<String, Object> p, String key) throws RpcError {
        if (!(p.get(key) instanceof String s) || s.isEmpty() || s.length() > 128) {
            throw RpcError.badRequest(key);
        }
        return s;
    }

    static String newId(String prefix) {
        String alphabet = "abcdefghijklmnopqrstuvwxyz234567";
        StringBuilder out = new StringBuilder(prefix).append('-');
        for (int i = 0; i < 16; i++) {
            out.append(alphabet.charAt(RANDOM.nextInt(32)));
        }
        return out.toString();
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> cast(Map<?, ?> m) {
        return (Map<String, Object>) m;
    }

    private static int intIn(Object v, int lo, int hi, int fallback) {
        return v instanceof Number n && n.intValue() >= lo && n.intValue() <= hi ? n.intValue() : fallback;
    }

    private static double numIn(Object v, double lo, double hi, double fallback) {
        return v instanceof Number n && n.doubleValue() >= lo && n.doubleValue() <= hi ? n.doubleValue() : fallback;
    }

    @Override
    public void close() {
        upkeep.shutdownNow();
        room.close();
        TodoFiler t = todos;
        if (t != null) {
            t.close();
        }
        Notes n = notes;
        if (n != null) {
            n.close();
        }
    }
}
