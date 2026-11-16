package com.minimalistalliance.desk.agent.maia;

import com.minimalistalliance.desk.agent.service.RpcError;
import java.time.Clock;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Consumer;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The room's state: what the office last saw on the member's desks ({@code agent.maia.observe}), whether the member is
 * typing, what the list has shown, the last interrupt and batch, and her last "show me". {@link Attention} makes the
 * list from it; this class keeps it between calls and publishes topic {@code agent.maia} on each change.
 *
 * <p><b>What the office sends stays in memory.</b> Names and titles from the member's other desks are never written to
 * a disk here, and they're cut and cleaned as they come ({@link MaiaAgent#plain}). The list reacts to events (each
 * observe), with one timer for the next moment a rule changes by itself (an approval coming within the hour, a batch, a
 * snooze ending, typing going quiet): a background tab's timers throttle, so the office must never be what ticks.
 */
public final class Room implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(Room.class);

    static final int MAX_DESKS = 20;
    static final int MAX_AGENTS = 50;
    static final int MAX_APPROVALS = 100;
    static final int MAX_DUE = 20;
    static final int MAX_STOPPED = 50;
    /** Typing without a word for this long is not typing. */
    static final long TYPING_FOR = 20_000L;
    /** No observe for this long: "Connecting to your desks…". */
    static final long CONNECTING_AFTER = 120_000L;
    /** An unprompted show at most this often. */
    static final long SHOW_EVERY = 10 * Attention.MINUTE;
    /** Observes a second, at most. */
    static final int OBSERVES_PER_SECOND = 2;
    /** A snooze lasts this long, or until the member is back. */
    static final long SNOOZE = 2 * 60 * Attention.MINUTE;
    /** Results of her briefs are offered this long. */
    static final long RESULT_FOR = 24 * 60 * Attention.MINUTE;

    /** What the room asks of the rest of Maia Mode when it builds. */
    public interface Source {
        boolean on();

        boolean killed();

        Attention.Settings settings();

        /** What her calls drew on this desk today, in hundredths of a credit. Never money. */
        long creditsToday();

        /** The member's own day cap on her, in whole credits, or null for none. */
        Long cap();

        /** Her allowance as her service last reported it, for the room ({@link MaiaMode#allowanceView}); empty before any. */
        default Map<String, Object> allowanceView() {
            return Map.of();
        }

        /** Notes today, and notes held: {@code [today, held]}. */
        int[] noteCounts();

        /** Her briefs waiting, and answered today: {@code [onIt, doneToday]}. */
        int[] briefs();

        double weight();

        Map<String, Map<String, Long>> itemChoices();

        /**
         * What her briefs cost the member (their agents, on their own keys) today and this month, in all and per desk,
         * against the day's budget ({@link Wallet#spendView}); null for none.
         */
        default Map<String, Object> briefSpend() {
            return null;
        }

        /** The desk's zone, for the shield's clock. */
        default java.time.ZoneId zone() {
            return java.time.ZoneId.systemDefault();
        }

        /** The shield rang the bell for an item it holds: deskd reads it from {@code agent.state} ({@code maiaAway.ring}). */
        default void bellRang() {}
    }

    private final Clock clock;
    private final Source source;
    private final Consumer<Map<String, Object>> publish;
    private final ReentrantLock lock = new ReentrantLock();
    private final ScheduledExecutorService timer;
    private ScheduledFuture<?> next;

    private List<Attention.Desk> desks = List.of();
    private long observedAt;
    private boolean typing;
    private long typingAt;
    private final Set<String> shown = new HashSet<>();
    private final Map<String, Long> firstSeen = new HashMap<>();
    private long lastNoticeAt;
    private Map<String, Object> notice;
    private long lastBatchAt;
    private boolean releaseAll = true;
    private Map<String, Object> show;
    private long lastAutoShowAt;
    private final List<Attention.Result> results = new ArrayList<>();
    private final long[] observeWindow = new long[OBSERVES_PER_SECOND];
    private int observeIndex;
    private Attention.Output last;
    /** The focus shield (deskd API.md §23 "What reaches the member"), or null before Maia Mode wires it. */
    private volatile Shield shield;
    private Map<String, ReachItems.Extras> extras = Map.of();
    private Shield.Output lastShield;
    private long shieldNoticeAt;
    /** The office sends {@code focus}: an office without it gets the list as before. */
    private boolean focusOffice;
    /** The decision tray: its rows, the reports that need the member (memory), and what it last built. */
    private volatile TrayStore trayStore;
    private final Map<String, Tray.ReportFacts> reportFacts = new LinkedHashMap<>();
    private final Map<String, Long> traySeen = new HashMap<>();
    private List<Tray.Paper> lastTray = List.of();
    private final java.util.ArrayDeque<Map<String, Object>> filed = new java.util.ArrayDeque<>();
    /** Reports kept for papers at most this long (memory only). */
    static final long REPORT_FACTS_FOR = 7L * 24 * 60 * Attention.MINUTE;
    /** A filed line ("Sent to Scout") stays this long, at most {@link #FILED_MAX}. */
    static final long FILED_FOR = 2 * 60 * Attention.MINUTE;
    static final int FILED_MAX = 10;

    public Room(Clock clock, Source source, Consumer<Map<String, Object>> publish) {
        this.clock = clock;
        this.source = source;
        this.publish = publish;
        this.timer = Executors.newSingleThreadScheduledExecutor(Thread.ofVirtual().name("maia-room").factory());
    }

    /** The focus shield: it decides what reaches the member, and when. */
    public void shield(Shield s) {
        this.shield = s;
    }

    public Shield shield() {
        return shield;
    }

    // ---------------------------------------------------------------- inputs

    /** {@code agent.maia.observe}: the whole picture from the office. */
    public void observe(Map<String, Object> p) throws RpcError {
        long now = clock.millis();
        lock.lock();
        try {
            if (now - observeWindow[observeIndex] < 1_000L) {
                throw RpcError.of("rate_limited", "limit", "observe");
            }
            observeWindow[observeIndex] = now;
            observeIndex = (observeIndex + 1) % OBSERVES_PER_SECOND;
        } finally {
            lock.unlock();
        }
        List<Attention.Desk> parsed = parse(p);
        Map<String, ReachItems.Extras> more = extras(p);
        // What the member is doing, as ids and times only: kept in memory, never written (the shield's Focus).
        Focus.Now focus = Focus.parse(p.get("focus"), now);
        lock.lock();
        try {
            desks = parsed;
            extras = more;
            observedAt = now;
            focusOffice = p.containsKey("focus");
            if (p.get("typing") instanceof Boolean t) {
                setTyping(t, now);
            }
            Shield s = shield;
            if (s != null) {
                s.observe(focus, now);
                // Courier's reply bands, for the shield's one tagging question (never names).
                Map<String, Integer> bands = new HashMap<>();
                for (ReachItems.Extras x : more.values()) {
                    for (ReachItems.Thread t : x.threads()) {
                        for (Focus.Person p2 : t.contacts()) {
                            bands.merge(Reach.personKey(p2), t.replyBand(), Math::max);
                        }
                    }
                }
                if (!bands.isEmpty()) {
                    s.replyBands(bands);
                }
            }
        } finally {
            lock.unlock();
        }
        rebuild();
    }

    /** {@code agent.maia.typing}. */
    public void typing(boolean t) {
        lock.lock();
        try {
            setTyping(t, clock.millis());
        } finally {
            lock.unlock();
        }
        rebuild();
    }

    private void setTyping(boolean t, long now) {
        typing = t;
        typingAt = now;
    }

    /** {@code agent.maia.seen}: {@code back} releases what was batched and ends snoozes "until the next session". */
    public boolean seen(boolean back) {
        if (back) {
            lock.lock();
            try {
                releaseAll = true;
            } finally {
                lock.unlock();
            }
            rebuild();
        }
        return back;
    }

    // ---------------------------------------------------------------- the decision tray

    /** The tray's rows: papers are built from here on while the shield is on. */
    public void tray(TrayStore t) {
        this.trayStore = t;
    }

    public TrayStore trayStore() {
        return trayStore;
    }

    /** A report that needs the member (Phase 2's, code-parsed): kept in memory for its paper. */
    public void reportFacts(Tray.ReportFacts f) {
        if (f == null || f.messageId() == null) {
            return;
        }
        lock.lock();
        try {
            reportFacts.remove(f.messageId());
            reportFacts.put(f.messageId(), f);
            while (reportFacts.size() > Tray.MAX_PAPERS) {
                reportFacts.remove(reportFacts.keySet().iterator().next());
            }
        } finally {
            lock.unlock();
        }
    }

    /** Every open paper as last built, in stack order (Later ones too). */
    public List<Tray.Paper> papers() {
        lock.lock();
        try {
            return lastTray;
        } finally {
            lock.unlock();
        }
    }

    /** One paper as last built, or null. */
    public Tray.Paper paper(String paperId) {
        for (Tray.Paper p : papers()) {
            if (p.paperId().equals(paperId)) {
                return p;
            }
        }
        return null;
    }

    /** A paper was answered here: its filed line ("X1 Carbon · sent to Scout"), and it leaves the stack. */
    public void filed(Tray.Paper p, Tray.State s, long at) {
        lock.lock();
        try {
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("paperId", p.paperId());
            f.put("kind", p.kind());
            f.put("label", s.answerLabel());
            f.put("to", p.asker().get("name"));
            f.put("who", p.asker().get("who"));
            f.put("state", s.state());
            f.put("at", at);
            filed.removeIf(x -> p.paperId().equals(x.get("paperId")));
            filed.addFirst(f);
            while (filed.size() > FILED_MAX) {
                filed.removeLast();
            }
            if ("report".equals(p.kind()) && !s.open()) {
                Object mid = p.reply().get("messageId");
                reportFacts.remove(mid);
            }
        } finally {
            lock.unlock();
        }
        rebuild();
    }

    /** A filed paper's state changed (the office carried its answer, or couldn't): its line says so. */
    public void refiled(String paperId, String state, long at) {
        lock.lock();
        try {
            for (Map<String, Object> f : filed) {
                if (paperId.equals(f.get("paperId"))) {
                    f.put("state", state);
                    f.put("at", at);
                }
            }
            if ("open".equals(state)) {
                filed.removeIf(f -> paperId.equals(f.get("paperId")));
            }
        } finally {
            lock.unlock();
        }
        rebuild();
    }

    /** {@code reach.tray}: the open papers not put off, the counts, and the last filed lines. */
    private Map<String, Object> trayView(long now) {
        Map<String, Object> v = new LinkedHashMap<>(Tray.view(lastTray, now));
        filed.removeIf(f -> f.get("at") instanceof Long at && now - at > FILED_FOR);
        List<Map<String, Object>> lines = new ArrayList<>();
        for (Map<String, Object> f : filed) {
            lines.add(new LinkedHashMap<>(f));
        }
        v.put("filed", lines);
        return v;
    }

    private List<Tray.Paper> buildTray(long now, List<Reach.Item> items) {
        TrayStore t = trayStore;
        Shield s = shield;
        if (t == null || s == null) {
            return List.of();
        }
        reportFacts.values().removeIf(f -> now - f.at() > REPORT_FACTS_FOR);
        Map<String, Tray.State> states = t.states();
        List<Tray.Paper> built = Tray.build(new Tray.Input(now, source.zone(), s.settings(now), desks, extras,
                new ArrayList<>(reportFacts.values()), items, states, t.notes(now), traySeen));
        Set<String> present = new HashSet<>();
        List<Tray.Paper> open = new ArrayList<>();
        for (Tray.Paper p : built) {
            present.add(p.paperId());
            if (p.state().open()) {
                open.add(p);
            }
        }
        // A paper whose source left while its desk was there to say so (answered in the Agent app, on another device,
        // expired): withdrawn, with its line. A desk that's asleep or unread says nothing, so nothing is withdrawn.
        Set<String> seenDesks = new HashSet<>();
        for (Attention.Desk d : desks) {
            if (d.linkOpen()) {
                seenDesks.add(d.deskId());
            }
        }
        for (Tray.State st : states.values()) {
            if (st.open() && !present.contains(st.paperId()) && !"report".equals(st.kind())
                    && seenDesks.contains(st.deskId())) {
                Tray.State gone = Tray.gone(st, null, now);
                t.put(gone, now);
                Map<String, Object> f = new LinkedHashMap<>();
                f.put("paperId", st.paperId());
                f.put("kind", st.kind());
                f.put("label", null);
                f.put("to", null);
                f.put("state", gone.state());
                f.put("at", now);
                filed.removeIf(x -> st.paperId().equals(x.get("paperId")));
                filed.addFirst(f);
            }
        }
        traySeen.keySet().retainAll(present);
        return open;
    }

    /** A brief of hers was answered: a result to offer. */
    public void answered(Attention.Result result) {
        lock.lock();
        try {
            results.removeIf(r -> r.messageId().equals(result.messageId()));
            results.add(result);
        } finally {
            lock.unlock();
        }
        rebuild();
    }

    /** Her results the member has read (her thread was seen): they leave the list. */
    public void resultsSeen() {
        lock.lock();
        try {
            if (results.isEmpty()) {
                return;
            }
            results.clear();
        } finally {
            lock.unlock();
        }
        rebuild();
    }

    /**
     * Her {@code office_show}: open now when the member asked to see something, or when no unprompted show came in the
     * last 10 minutes; otherwise a "Show me" button. @return whether it opens now
     */
    public boolean show(String deskId, String app, String ref, boolean asked) {
        long now = clock.millis();
        boolean open;
        lock.lock();
        try {
            open = asked || now - lastAutoShowAt >= SHOW_EVERY;
            if (open && !asked) {
                lastAutoShowAt = now;
            }
            Map<String, Object> s = new LinkedHashMap<>();
            s.put("showId", "ms-" + Long.toString(now, 36) + Integer.toString((int) (Math.random() * 1296), 36));
            s.put("deskId", deskId);
            s.put("app", app);
            s.put("ref", ref);
            s.put("open", open);
            s.put("at", now);
            show = s;
        } finally {
            lock.unlock();
        }
        rebuild();
        return open;
    }

    /** The item with this id now, or null. */
    public Attention.Item item(String itemId) {
        lock.lock();
        try {
            if (last == null) {
                return null;
            }
            for (Attention.Item i : last.all()) {
                if (i.id().equals(itemId)) {
                    return i;
                }
            }
            return null;
        } finally {
            lock.unlock();
        }
    }

    /** A desk the office saw last, or null. */
    public Attention.Desk desk(String deskId) {
        lock.lock();
        try {
            for (Attention.Desk d : desks) {
                if (d.deskId().equals(deskId)) {
                    return d;
                }
            }
            return null;
        } finally {
            lock.unlock();
        }
    }

    public List<Attention.Desk> desks() {
        lock.lock();
        try {
            return desks;
        } finally {
            lock.unlock();
        }
    }

    public boolean typingNow() {
        lock.lock();
        try {
            return typing && clock.millis() - typingAt < TYPING_FOR;
        } finally {
            lock.unlock();
        }
    }

    // ---------------------------------------------------------------- the snapshot

    /** The room as topic {@code agent.maia} has it. */
    public Map<String, Object> snapshot() {
        lock.lock();
        try {
            if (last == null) {
                buildLocked();
            }
            return view(last);
        } finally {
            lock.unlock();
        }
    }

    /** Builds the list again and publishes it. Safe to call from any thread. */
    public void rebuild() {
        Map<String, Object> out;
        lock.lock();
        try {
            buildLocked();
            out = view(last);
        } catch (RuntimeException e) {
            log.warn("the room wasn't built: {}", e.getClass().getSimpleName());
            return;
        } finally {
            lock.unlock();
        }
        try {
            publish.accept(out);
        } catch (RuntimeException e) {
            log.warn("the room wasn't published: {}", e.getClass().getSimpleName());
        }
    }

    private void buildLocked() {
        long now = clock.millis();
        if (typing && now - typingAt >= TYPING_FOR) {
            typing = false;
        }
        results.removeIf(r -> now - r.at() > RESULT_FOR);
        // Back ends snoozes "until the next session" in the store first (MaiaMode.endSnoozes).
        Map<String, Map<String, Long>> choices = new HashMap<>(source.itemChoices());
        long credits = source.creditsToday();
        Long cap = source.cap();
        int[] notes = source.noteCounts();
        int[] briefs = source.briefs();
        Set<String> shieldHeld = Set.of();
        boolean shieldOn = false;
        Shield s = shield;
        lastShield = null;
        lastTray = List.of();
        if (s != null && focusOffice && source.on() && !source.killed()) {
            // The shield sees every item of the moment (the list's, each desk's Courier threads and documents) and
            // decides what reaches the member; the list then shows what it lets through, with no 30-minute batch.
            Attention.Input pre = new Attention.Input(now, source.settings(), desks, observedAt > 0, typing, credits,
                    cap, notes[0], notes[1], briefs[0], briefs[1], results, choices, shown, lastNoticeAt,
                    lastBatchAt, true);
            List<Attention.Item> listItems = Attention.items(pre, new HashMap<>(firstSeen));
            try {
                int rangBefore = s.ringReach();
                List<Reach.Item> fresh = ReachItems.all(listItems, desks, extras, resultStatus(), now, source.zone());
                lastShield = s.update(now, fresh, deskScopes(), deskNames());
                shieldOn = lastShield.on();
                try {
                    // The decision tray rides the shield: off with it ("Show everything as it comes" included).
                    lastTray = shieldOn ? buildTray(now, fresh) : List.of();
                } catch (RuntimeException e) {
                    lastTray = List.of();
                    log.warn("the tray wasn't built: {}", e.getClass().getSimpleName());
                }
                shieldHeld = lastShield.heldKeys();
                if (s.ringReach() != rangBefore) {
                    source.bellRang();
                }
            } catch (RuntimeException e) {
                log.warn("the shield wasn't built: {}", e.getClass().getSimpleName());
            }
        }
        Attention.Input in = new Attention.Input(now, source.settings(), desks, observedAt > 0, typing, credits,
                cap, notes[0], notes[1], briefs[0], briefs[1], results, choices, shown, lastNoticeAt,
                lastBatchAt, releaseAll || shieldOn, shieldHeld);
        Attention.Output out = Attention.build(in, firstSeen);
        shown.clear();
        shown.addAll(out.shown());
        if (out.batchReleased()) {
            lastBatchAt = now;
        }
        releaseAll = false;
        if (shieldOn) {
            // The interrupt is the shield's card: its gate, its 15-minute cap, its heads-up.
            if (lastShield.noticeAt() != null && lastShield.noticeAt() != shieldNoticeAt) {
                shieldNoticeAt = lastShield.noticeAt();
                lastNoticeAt = now;
                Map<String, Object> n = new LinkedHashMap<>();
                n.put("itemId", lastShield.noticeItemId());
                n.put("at", shieldNoticeAt);
                notice = n;
            }
        } else if (out.noticeItemId() != null) {
            lastNoticeAt = now;
            Map<String, Object> n = new LinkedHashMap<>();
            n.put("itemId", out.noticeItemId());
            n.put("at", now);
            notice = n;
        }
        last = out;
        schedule(now, in);
    }

    private Map<String, Object> view(Attention.Output out) {
        long now = clock.millis();
        Map<String, Object> room = new LinkedHashMap<>();
        room.put("on", source.on());
        room.put("killed", source.killed());
        room.put("status", out.status());
        room.put("todo", out.todo());
        Map<String, Object> allowance = new LinkedHashMap<>(source.allowanceView());
        allowance.put("today", Attention.credits2(out.creditsCenti()));
        allowance.put("cap", source.cap());
        room.put("allowance", allowance);
        Map<String, Object> briefs = null;
        try {
            briefs = source.briefSpend();
        } catch (RuntimeException e) {
            log.warn("her briefs' spend wasn't read: {}", e.getClass().getSimpleName());
        }
        Map<String, Object> foot = out.foot();
        if (briefs != null) {
            // Her day summary: her briefs' cost on the member's own keys, never her own usage in dollars.
            foot = new LinkedHashMap<>(foot);
            foot.put("line", "On it: " + foot.get("onIt") + " · Done today: " + foot.get("doneToday") + " · "
                    + briefs.get("line"));
        }
        room.put("briefs", briefs);
        room.put("foot", foot);
        room.put("notice", notice);
        room.put("show", show);
        int[] notes = source.noteCounts();
        room.put("notes", Map.of("today", notes[0], "held", notes[1]));
        room.put("choices", Map.of("weight", Choices.round(source.weight())));
        room.put("connecting", observedAt == 0 || now - observedAt > CONNECTING_AFTER);
        Map<String, Object> reach = lastShield == null ? null : lastShield.view();
        if (reach != null && lastShield.on() && trayStore != null) {
            reach = new LinkedHashMap<>(reach);
            reach.put("tray", trayView(now));
        }
        room.put("reach", reach);
        return room;
    }

    /** Each desk's scope for the shield: Work or Personal. */
    private Map<String, String> deskScopes() {
        Map<String, String> m = new HashMap<>();
        for (Attention.Desk d : desks) {
            m.put(d.deskId(), ReachItems.scope(d.kind()));
        }
        return m;
    }

    private Map<String, String> deskNames() {
        Map<String, String> m = new HashMap<>();
        for (Attention.Desk d : desks) {
            m.put(d.deskId(), d.name());
        }
        return m;
    }

    /** Per desk, the report status that most needs the member among her answered briefs (Phase 2's, code-parsed). */
    private Map<String, String> resultStatus() {
        Map<String, String> m = new HashMap<>();
        for (Attention.Result r : results) {
            if (r.status() == null) {
                continue;
            }
            String before = m.get(r.deskId());
            if (before == null || rank(r.status()) > rank(before)) {
                m.put(r.deskId(), r.status());
            }
        }
        return m;
    }

    private static int rank(String status) {
        return switch (status) {
            case "blocked" -> 3;
            case "needs_decision" -> 2;
            case "failed" -> 1;
            default -> 0;
        };
    }

    /** Each desk's {@code courier} and {@code docs}, for the shield; a Guild Desk's are never read. */
    static Map<String, ReachItems.Extras> extras(Map<String, Object> p) {
        Map<String, ReachItems.Extras> out = new HashMap<>();
        if (p.get("desks") instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map<?, ?> d && d.get("deskId") instanceof String id && deskId(id)
                        && !Boolean.TRUE.equals(d.get("guild")) && !"guild".equals(d.get("kind"))
                        && (d.get("courier") != null || d.get("docs") != null)) {
                    out.put(id, ReachItems.parse(id, d.get("courier"), d.get("docs")));
                }
            }
        }
        return out;
    }

    /** One timer, for the next moment a rule changes with no event: within the hour, due soon, a batch, typing. */
    private void schedule(long now, Attention.Input in) {
        long at = Long.MAX_VALUE;
        for (Attention.Desk d : in.desks()) {
            for (Attention.Approval a : d.approvals()) {
                long t = a.expiresAt() - Attention.APPROVAL_NOW;
                if (t > now) {
                    at = Math.min(at, t);
                }
                if (a.expiresAt() > now) {
                    at = Math.min(at, a.expiresAt());
                }
            }
            for (Attention.DueSoon s : d.dueSoon()) {
                long t = s.dueAt() - Attention.TODO_NOW;
                if (t > now) {
                    at = Math.min(at, t);
                }
            }
        }
        if (last != null && last.held() > 0 && in.shieldHeld().isEmpty() && lastShield == null) {
            at = Math.min(at, lastBatchAt + in.settings().batchEveryMin() * Attention.MINUTE);
        }
        if (lastShield != null && lastShield.wakeAt() != Long.MAX_VALUE) {
            at = Math.min(at, lastShield.wakeAt());
        }
        if (typing) {
            at = Math.min(at, typingAt + TYPING_FOR);
        }
        for (Map<String, Long> c : in.choices().values()) {
            Long until = c.get("snoozedUntil");
            if (until != null && until > now) {
                at = Math.min(at, until);
            }
        }
        if (next != null) {
            next.cancel(false);
            next = null;
        }
        if (at != Long.MAX_VALUE && !timer.isShutdown()) {
            next = timer.schedule(this::rebuild, Math.max(50, at - now + 50), TimeUnit.MILLISECONDS);
        }
    }

    // ---------------------------------------------------------------- the office's picture

    static List<Attention.Desk> parse(Map<String, Object> p) throws RpcError {
        if (!(p.get("desks") instanceof List<?> list)) {
            throw RpcError.badRequest("desks");
        }
        if (list.size() > MAX_DESKS) {
            throw RpcError.of("too_large", "detail", "desks");
        }
        List<Attention.Desk> out = new ArrayList<>();
        Set<String> ids = new HashSet<>();
        for (Object o : list) {
            if (!(o instanceof Map<?, ?> d) || !(d.get("deskId") instanceof String deskId) || !deskId(deskId)
                    || !ids.add(deskId)) {
                throw RpcError.badRequest("desks");
            }
            if (Boolean.TRUE.equals(d.get("guild")) || "guild".equals(d.get("kind"))) {
                // A Guild Desk is never in her room.
                continue;
            }
            String name = MaiaAgent.plain(d.get("name"), Attention.NAME_MAX);
            String state = word(d.get("state"), Set.of("running", "starting", "asleep", "stopped", "failed"),
                    "running");
            boolean open = "open".equals(d.get("link"));
            List<Attention.Agent> agents = new ArrayList<>();
            for (Object a : listOf(d.get("agents"), MAX_AGENTS, "agents")) {
                if (!(a instanceof Map<?, ?> m) || !(m.get("agentId") instanceof String agentId) || !agentId(agentId)) {
                    throw RpcError.badRequest("agents");
                }
                agents.add(new Attention.Agent(agentId, MaiaAgent.plain(m.get("name"), Attention.NAME_MAX),
                        word(m.get("status"), Set.of("online", "working", "error", "offline", "setup"), "online"),
                        m.get("statusDetail") instanceof String sd ? word(sd, Set.of("awaiting_approval",
                                "waiting_desk"), null) : null, count(m.get("approvalsPending")),
                        // Counts and dollars from that desk's team view, read leniently: no figure, no headroom.
                        Wallet.Headroom.parse(m.get("budget"))));
            }
            List<Attention.Approval> approvals = new ArrayList<>();
            for (Object a : listOf(d.get("approvals"), MAX_APPROVALS, "approvals")) {
                if (!(a instanceof Map<?, ?> m) || !(m.get("approvalId") instanceof String id) || !approvalId(id)
                        || !(m.get("expiresAt") instanceof Number at)) {
                    throw RpcError.badRequest("approvals");
                }
                // The class and the untrusted mark, for the decision tray's confirm strip: words from a closed set.
                approvals.add(new Attention.Approval(id, m.get("agentId") instanceof String ag && agentId(ag) ? ag
                        : "", at.longValue(), m.get("risk") instanceof String r && RISKS.contains(r) ? r : null,
                        Boolean.TRUE.equals(m.get("untrusted"))));
            }
            List<Attention.Stopped> stopped = new ArrayList<>();
            for (Object a : listOf(d.get("stopped"), MAX_STOPPED, "stopped")) {
                if (!(a instanceof Map<?, ?> m) || !(m.get("agentId") instanceof String ag) || !agentId(ag)) {
                    throw RpcError.badRequest("stopped");
                }
                stopped.add(new Attention.Stopped(ag, m.get("messageId") instanceof String mid ? Cut(mid) : null,
                        word(m.get("reason"), Set.of("limit_reached"), "other"),
                        m.get("at") instanceof Number at ? at.longValue() : 0));
            }
            int todosNew = 0;
            List<Attention.DueSoon> due = new ArrayList<>();
            if (d.get("todo") instanceof Map<?, ?> t) {
                todosNew = count(t.get("newFromAgents"));
                for (Object a : listOf(t.get("dueSoon"), MAX_DUE, "dueSoon")) {
                    if (!(a instanceof Map<?, ?> m) || !(m.get("dueAt") instanceof Number at)) {
                        throw RpcError.badRequest("dueSoon");
                    }
                    due.add(new Attention.DueSoon(m.get("id") instanceof String id ? Cut(id) : "",
                            MaiaAgent.plain(m.get("title"), Attention.NAME_MAX), at.longValue(),
                            m.get("mine") instanceof Boolean b ? b : null,
                            m.get("from") instanceof String f && FROM.contains(f) ? f : null));
                }
            }
            String kind = word(d.get("kind"), Set.of("personal", "work", "free", "test"), "personal");
            out.add(new Attention.Desk(deskId, name.isEmpty() ? "your desk" : name, kind, state, open, agents,
                    approvals, stopped, todosNew, due, Wallet.DeskBriefs.parse(d.get("briefs"))));
        }
        return out;
    }

    private static String Cut(String s) {
        return s.length() > 64 ? s.substring(0, 64) : s;
    }

    private static List<?> listOf(Object o, int max, String field) throws RpcError {
        if (o == null) {
            return List.of();
        }
        if (!(o instanceof List<?> l)) {
            throw RpcError.badRequest(field);
        }
        if (l.size() > max) {
            throw RpcError.of("too_large", "detail", field);
        }
        return l;
    }

    private static int count(Object o) {
        return o instanceof Number n ? (int) Math.max(0, Math.min(10_000, n.longValue())) : 0;
    }

    private static String word(Object o, Set<String> allowed, String fallback) {
        return o instanceof String s && allowed.contains(s) ? s : fallback;
    }

    /** An approval's class, as the office passes it (deskd API.md §18). */
    static final Set<String> RISKS = Set.of("write", "own", "send", "spend", "delete", "egress");
    /** Where a to-do came from when that's someone (To-do's source kinds but the member's own). */
    static final Set<String> FROM = Set.of("courier", "notebook", "browser", "files", "agent_chat", "desk");

    static boolean deskId(String s) {
        return s.matches("d-[a-z0-9]{1,40}");
    }

    static boolean agentId(String s) {
        return s.matches("[A-Za-z0-9_-]{1,64}");
    }

    static boolean approvalId(String s) {
        return s.matches("[A-Za-z0-9_-]{1,64}");
    }

    @Override
    public void close() {
        timer.shutdownNow();
    }

    /** For tests: the {@link Supplier} of the clock's time is the room's own. */
    Supplier<Long> now() {
        return clock::millis;
    }
}
