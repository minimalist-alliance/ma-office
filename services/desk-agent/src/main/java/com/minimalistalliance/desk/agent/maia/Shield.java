package com.minimalistalliance.desk.agent.maia;

import com.minimalistalliance.desk.agent.service.RpcError;
import java.security.SecureRandom;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Supplier;

/**
 * The focus shield's state between calls (the shield concept; deskd {@code API.md} §23 "What reaches the member"): the
 * model of now ({@link Focus.Tracker}), each item's delivery state, the card in flight, catch-ups, Back and pick-ups,
 * the hold, the stated task, the budgets, and learning. {@link Room} calls {@link #observe} with the office's
 * {@code focus} block and {@link #update} with the items of the moment on every rebuild; the result is the topic's
 * {@code reach}, the list keys the shield holds, the interrupt (the room's {@code notice}) and the next moment a rule
 * changes by itself. <b>Code decides</b>: no model call, no credits.
 *
 * <p><b>What's kept</b> ({@link Store}, {@code maia_focus_*} in {@code agent.db}): items by key with their level, state
 * and times (never a title), the member's settings and list, learned rules and counts, the day's counts. Focus itself
 * (desk, app, item, people, timing) stays in memory.
 */
public final class Shield {

    static final long MINUTE = 60_000L;
    static final long DAY = 86_400_000L;
    /** A second event from the same source within this merges and is a repeat. */
    static final long MERGE_MS = 10 * MINUTE;
    /** Records, updates and notes older than this go back to their own app: "Cleared without you". */
    static final long CLEAR_AFTER = 7 * DAY;
    /** The stated task ends after this long with focus elsewhere, or at the end of the day. */
    static final long TASK_IDLE = 2 * 60 * MINUTE;
    static final int ITEMS_MAX = 500;
    static final int HELD_LIST_MAX = 200;
    private static final SecureRandom RANDOM = new SecureRandom();

    /** Where the shield's rows live. {@link FocusStore} in production, {@link Memory} in tests and the evals. */
    public interface Store {
        Reach.Settings settings(long now);

        void putSettings(Reach.Settings s);

        Map<String, Object> state();

        void putState(Map<String, Object> state);

        void count(String day, String name, int n);

        int sum(String fromDay, String toDay, String name);

        void miss(String itemKey, String kind, long at);

        /** "Delete Maia Mode history": items, counts, learned rules and drift; the settings and list stay. */
        void forget();
    }

    /** The store in memory (tests, evals). */
    public static final class Memory implements Store {
        private Reach.Settings settings;
        private Map<String, Object> state = new LinkedHashMap<>();
        private final Map<String, Integer> counts = new HashMap<>();
        public final List<String> misses = new ArrayList<>();

        public Memory() {}

        public Memory(Reach.Settings s) {
            this.settings = s;
        }

        @Override
        public Reach.Settings settings(long now) {
            return settings == null ? Reach.Settings.defaults(now) : settings;
        }

        @Override
        public void putSettings(Reach.Settings s) {
            settings = s;
        }

        @Override
        public Map<String, Object> state() {
            return state;
        }

        @Override
        public void putState(Map<String, Object> s) {
            state = s;
        }

        @Override
        public void count(String day, String name, int n) {
            counts.merge(day + "|" + name, n, Integer::sum);
        }

        @Override
        public int sum(String fromDay, String toDay, String name) {
            int n = 0;
            for (Map.Entry<String, Integer> e : counts.entrySet()) {
                String[] p = e.getKey().split("\\|", 2);
                if (p[1].equals(name) && p[0].compareTo(fromDay) >= 0 && p[0].compareTo(toDay) <= 0) {
                    n += e.getValue();
                }
            }
            return n;
        }

        @Override
        public void miss(String itemKey, String kind, long at) {
            misses.add(itemKey);
        }

        @Override
        public void forget() {
            state = new LinkedHashMap<>();
            counts.clear();
            misses.clear();
        }
    }

    /** One item's delivery state, kept by key: ids, kinds and times only. */
    static final class ItemState {
        final String key;
        String kind;
        String deskId;
        String level = "hold";
        /** {@code new}, {@code carded}, {@code shown} (delivered or listed), {@code rest} (Not now), {@code done}. */
        String state = "new";
        long firstSeenAt;
        long readyAt;
        long deliveredAt;
        long restUntil;
        long snoozeUntil;
        boolean afterThis;
        boolean caughtUp;
        boolean missed;
        boolean away;
        Long deadlineAt;
        int count;
        int repeats;
        long lastEventAt;
        String how;

        ItemState(String key) {
            this.key = key;
        }

        boolean waiting(long now) {
            return ("new".equals(state) || "rest".equals(state) && now >= restUntil) && now >= snoozeUntil;
        }

        boolean held(long now) {
            return "new".equals(state) || "rest".equals(state);
        }

        Map<String, Object> stored() {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("kind", kind);
            v.put("deskId", deskId);
            v.put("level", level);
            v.put("state", state);
            v.put("firstSeenAt", firstSeenAt);
            v.put("readyAt", readyAt);
            v.put("deliveredAt", deliveredAt);
            v.put("restUntil", restUntil);
            v.put("snoozeUntil", snoozeUntil);
            v.put("afterThis", afterThis);
            v.put("caughtUp", caughtUp);
            v.put("missed", missed);
            v.put("away", away);
            v.put("deadlineAt", deadlineAt);
            v.put("count", count);
            v.put("repeats", repeats);
            v.put("lastEventAt", lastEventAt);
            v.put("how", how);
            return v;
        }

        static ItemState parse(String key, Object raw) {
            ItemState s = new ItemState(key);
            if (raw instanceof Map<?, ?> m) {
                s.kind = str(m.get("kind"));
                s.deskId = str(m.get("deskId"));
                s.level = str(m.get("level")) == null ? "hold" : str(m.get("level"));
                s.state = str(m.get("state")) == null ? "new" : str(m.get("state"));
                s.firstSeenAt = num(m.get("firstSeenAt"));
                s.readyAt = num(m.get("readyAt"));
                s.deliveredAt = num(m.get("deliveredAt"));
                s.restUntil = num(m.get("restUntil"));
                s.snoozeUntil = num(m.get("snoozeUntil"));
                s.afterThis = Boolean.TRUE.equals(m.get("afterThis"));
                s.caughtUp = Boolean.TRUE.equals(m.get("caughtUp"));
                s.missed = Boolean.TRUE.equals(m.get("missed"));
                s.away = Boolean.TRUE.equals(m.get("away"));
                s.deadlineAt = m.get("deadlineAt") instanceof Number n ? n.longValue() : null;
                s.count = (int) num(m.get("count"));
                s.repeats = (int) num(m.get("repeats"));
                s.lastEventAt = num(m.get("lastEventAt"));
                s.how = str(m.get("how"));
            }
            return s;
        }
    }

    /** The card in flight: one at a time. */
    static final class Card {
        String cardId;
        String itemKey;
        Deliver.Level level;
        String device;
        long createdAt;
        long showAt;
        long tuckAt;
        long afterUntil;
        String afterText;
        boolean visible;
        /** It was chosen at a break (the heads-up's 8 s may outlast the break's 20 s). */
        boolean atBreak;
        boolean taken;
        long takenAt;
        String firstRule;
        Snapshot snapshot;
        /** Other gate items waiting when an interrupt shows: they come on the same card, so it's one interruption. */
        final List<String> more = new ArrayList<>();
    }

    /** Where the member was when a card appeared: for Back and the ready-to-resume line. */
    record Snapshot(String surface, String deskId, String app, Focus.Ref item, long lastChangeAt, String label) {}

    /** A question waiting for the next catch-up (one per catch-up). */
    record Question(String questionId, String text, List<Map<String, Object>> choices, String ref, long at) {
        Map<String, Object> view() {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("questionId", questionId);
            v.put("text", text);
            v.put("choices", choices);
            if (ref != null && ref.startsWith("person:")) {
                String[] p = ref.substring(7).split(":", 2);
                v.put("who", Map.of("deskId", p[0], "contactId", p[1]));
            }
            return v;
        }
    }

    /**
     * What happened in one update, for the room, the audit's counts and the evals' delivery log. {@code what}:
     * {@code heads_up}, {@code interrupt}, {@code offer}, {@code seen}, {@code missed}, {@code bell} (an interrupt-level
     * item while the member is away: the bell's fixed words), a catch-up's kind and one {@code catchup_item} per item
     * in it. {@code atBreak}: a break was open (or the item was about to expire).
     */
    public record Delivery(String what, String itemKey, String kind, String level, String state, long at,
            String text, boolean atBreak) {
        public Delivery(String what, String itemKey, String kind, String level, String state, long at, String text) {
            this(what, itemKey, kind, level, state, at, text, false);
        }
    }

    /** One update's result. */
    public record Output(Map<String, Object> view, Set<String> heldKeys, String noticeItemId, Long noticeAt,
            long wakeAt, List<Delivery> deliveries, boolean on) {}

    private final Store store;
    private final Supplier<ZoneId> zone;
    final Focus.Tracker tracker = new Focus.Tracker();
    private final Map<String, ItemState> items = new LinkedHashMap<>();
    private final Map<String, Reach.Item> live = new LinkedHashMap<>();
    private final Map<String, Reach.Score> scores = new HashMap<>();
    private final Map<String, Deliver.Level> levels = new HashMap<>();
    private final Map<String, String> deskNames = new HashMap<>();
    private Reach.Settings settings;
    private List<Learn.Rule> learned = new ArrayList<>();
    private final Map<String, Learn.Counts> classes = new HashMap<>();
    private final Set<String> exceptions = new HashSet<>();
    private final Map<String, String> tags = new HashMap<>();
    private final Map<String, Integer> replyBands = new HashMap<>();
    private Card card;
    private Rhythm.CatchUp catchup;
    private Map<String, Object> back;
    private String backCardId;
    private Snapshot backSnapshot;
    private long backUntil;
    private long backOfferedAt;
    private final Map<String, Snapshot> pickups = new LinkedHashMap<>();
    private final Map<String, Long> pickupAt = new HashMap<>();
    private String pickupLine;
    private long lastInterruptAt;
    private final List<Long> offersHour = new ArrayList<>();
    private int offersToday;
    private String offersDay = "";
    private long lastCatchUpAt;
    private long catchUpPendingSince;
    private String briefDay = "";
    private String weekAskedDay = "";
    private String paceAskedDay = "";
    private String tagAskedDay = "";
    private long holdUntil;
    private long holdWorkUntil;
    private Reach.Task task;
    private List<Reach.Pick> week = new ArrayList<>();
    private final List<Question> questions = new ArrayList<>();
    private final Set<String> firstShown = new HashSet<>();
    private boolean askedEmail;
    private boolean emailMe;
    private boolean wasAway = true;
    private long idleSince;
    static final long IDLE_BELL_MS = 5 * MINUTE;
    /** When the member was last back (a wait for a break counts from then, not from an item's arrival). */
    private long presentSince;
    private long awaySince;
    private boolean pendingReturn;
    private int awayInterrupts;
    private boolean loaded;
    private boolean dirty;
    private long savedAt;
    private Map<String, Object> lastAnswer;
    private long noticeAt;
    private String noticeItemId;
    /** What the member's own taps delivered (a waiting catch-up opened), for the next update's log. */
    private final List<Delivery> opened = new ArrayList<>();
    /** Interrupt-level items the bell has been told of while away, once each. */
    private final Set<String> rang = new HashSet<>();
    /**
     * The bell as the shield's rules let it ring (Phase 2's {@code maia.away} bell; fixed words, no content), counted
     * up for deskd's "once per rise": her questions and her finishing while away (Phase 2's counts, through the
     * shield's quiet hours and day's bells), and interrupt-level items it holds (approvals are rung by each desk's own
     * deskd, so never here).
     */
    private int ringQuestion;
    private int ringDone;
    private int ringReach;
    private int seenAsks;
    private int seenDone;
    /** Phase 2's counts are taken as seen at the first look (a restart never rings what was already held). */
    private boolean ringPrimed;

    public Shield(Store store, Supplier<ZoneId> zone) {
        this.store = store;
        this.zone = zone;
    }

    // ---------------------------------------------------------------- inputs

    /** The office's {@code focus} block (already parsed). */
    public synchronized void observe(Focus.Now now, long at) {
        load(at);
        Rhythm.Day day = Rhythm.day(at, zone.get(), settings, holdWorkUntil);
        Focus.observe(tracker, now, at, day.deep(), holdUntil > at);
        // A completed action while a card's one thing was taken: Back comes.
        if (card != null && card.taken && now != null && backCardId == null) {
            for (Focus.Event e : now.events()) {
                if (e.at() >= card.takenAt) {
                    offerBack(at);
                    break;
                }
            }
        }
    }

    /** No observe this time, only the clock (a timer). */
    public synchronized void observedNothing() {
        // Focus.tick runs in update.
    }

    /** Courier's reply bands, per contact, for the one tagging question (people written to more than once a week). */
    public synchronized void replyBands(Map<String, Integer> bands) {
        replyBands.clear();
        replyBands.putAll(bands);
    }

    public synchronized Reach.Settings settings(long now) {
        load(now);
        return settings;
    }

    public synchronized boolean on(long now) {
        load(now);
        return !settings.showAll();
    }

    public synchronized Focus.Now focusNow() {
        return tracker.now;
    }

    // ---------------------------------------------------------------- the update

    /**
     * Everything again, for this moment: the items as the list and the office have them now (titles in memory only),
     * desk scopes ({@code work}/{@code personal}) and names.
     */
    public synchronized Output update(long now, List<Reach.Item> fresh, Map<String, String> deskScope,
            Map<String, String> names) {
        load(now);
        ZoneId z = zone.get();
        Reach.Settings s = settings;
        deskNames.clear();
        deskNames.putAll(names);
        Rhythm.Day day = Rhythm.day(now, z, s, holdWorkUntil);
        boolean holdOn = holdUntil > now;
        Focus.tick(tracker, now, day.deep(), holdOn);
        Focus.State st = Focus.state(tracker, now, day.deep(), holdOn);
        Focus.Kind brk = Focus.breakOpen(tracker, now);
        List<Delivery> log = new ArrayList<>(opened);
        opened.clear();
        String today = date(now, z);
        if (!today.equals(offersDay)) {
            offersDay = today;
            offersToday = 0;
            pickups.clear();
            pickupAt.clear();
        }
        offersHour.removeIf(t -> now - t >= 60 * MINUTE);
        if (task != null && (!date(task.setAt(), z).equals(today) || taskIdle(now))) {
            task = null;
            dirty = true;
        }

        // Away and back.
        boolean away = st == Focus.State.AWAY;
        if (away && !wasAway) {
            awaySince = now;
        }
        boolean returned = wasAway && !away;
        if (returned) {
            presentSince = now;
        }
        if (returned && awaySince > 0 && now - awaySince >= 5 * MINUTE) {
            pendingReturn = items.values().stream().anyMatch(i -> i.away && live.containsKey(i.key));
        }
        wasAway = away;

        // Items: merge what came, forget what left at its source.
        Map<String, Reach.Item> now0 = new LinkedHashMap<>();
        for (Reach.Item i : fresh) {
            now0.putIfAbsent(i.key(), i);
        }
        for (Map.Entry<String, Snapshot> p : pickups.entrySet()) {
            Reach.Item pick = pickupItem(p.getKey(), p.getValue(), pickupAt.getOrDefault(p.getKey(), now));
            now0.put(pick.key(), pick);
        }
        live.clear();
        live.putAll(now0);
        for (Reach.Item i : now0.values()) {
            ItemState is = items.get(i.key());
            if (is == null) {
                if (items.size() >= ITEMS_MAX) {
                    continue;
                }
                is = new ItemState(i.key());
                is.kind = i.kind();
                is.deskId = i.deskId();
                is.firstSeenAt = now;
                is.readyAt = now;
                is.count = i.count();
                is.lastEventAt = now;
                is.away = away;
                items.put(i.key(), is);
                count(now, "arrived", 1);
                dirty = true;
            } else if (i.count() > is.count) {
                // A new event on an item already there: merged, and a repeat within its rest window.
                boolean resting = "rest".equals(is.state) && now < is.restUntil;
                if (resting || now - is.lastEventAt < MERGE_MS) {
                    is.repeats = Math.min(3, is.repeats + 1);
                } else if (!"rest".equals(is.state)) {
                    is.repeats = 0;
                }
                if ("shown".equals(is.state) || "done".equals(is.state)) {
                    is.state = "new";
                    is.readyAt = now;
                    is.caughtUp = false;
                }
                is.lastEventAt = now;
                is.count = i.count();
                if (away) {
                    is.away = true;
                }
                dirty = true;
            } else if (i.count() < is.count) {
                is.count = i.count();
            }
            is.deadlineAt = i.deadlineAt();
        }
        for (var it = items.entrySet().iterator(); it.hasNext();) {
            var e = it.next();
            if (!now0.containsKey(e.getKey())) {
                // Resolved at its source: it leaves quietly.
                if (card != null && e.getKey().equals(card.itemKey)) {
                    if (card.taken && backCardId == null) {
                        offerBack(now);
                    }
                    if (!card.taken) {
                        card = null;
                    }
                }
                it.remove();
                dirty = true;
            }
        }

        // Scores and levels.
        boolean budget = offersToday >= Deliver.OFFERS_PER_DAY || lowCapacity(now, day);
        Focus.Sphere sphere = Focus.sphere(tracker, now);
        Reach.Context ctx = new Reach.Context(now, tracker.now, sphere, task, week, s, day, deskScope, tags,
                i -> Learn.effect(i, learned, classes, day.part(), now).learned(),
                i -> items.containsKey(i.key()) ? items.get(i.key()).repeats : 0, budget, exceptions,
                Focus.people(tracker, now));
        scores.clear();
        levels.clear();
        for (Reach.Item i : live.values()) {
            ItemState is = items.get(i.key());
            if (is == null) {
                continue;
            }
            Reach.Score sc = Reach.score(i, ctx);
            Learn.Effect eff = Learn.effect(i, learned, classes, day.part(), now);
            Deliver.Level lv = "pickup".equals(i.kind()) ? Deliver.Level.PERIPHERY : Deliver.level(sc, eff);
            if (i.record() && lv != Deliver.Level.INTERRUPT) {
                lv = Deliver.Level.HOLD;
            }
            scores.put(i.key(), sc);
            levels.put(i.key(), lv);
            String lvName = lv.name().toLowerCase(java.util.Locale.ROOT);
            if (!lvName.equals(is.level)) {
                is.level = lvName;
                dirty = true;
            }
            if (sc.seen() && ("new".equals(is.state) || "rest".equals(is.state))) {
                // The member is looking at it: marked seen, no event.
                is.state = "shown";
                is.how = "seen";
                is.deliveredAt = now;
                log.add(new Delivery("seen", i.key(), i.kind(), lvName, st.name().toLowerCase(java.util.Locale.ROOT),
                        now, null));
                dirty = true;
            }
            // A held item past its deadline is a miss (S11): logged once, asked about at the next catch-up.
            if (is.deadlineAt != null && is.deadlineAt <= now && !is.missed && is.held(now)
                    && ("new".equals(is.state) || "rest".equals(is.state)) && is.deliveredAt == 0) {
                is.missed = true;
                store.miss(i.key(), i.kind(), now);
                count(now, "missed", 1);
                log.add(new Delivery("missed", i.key(), i.kind(), lvName, null, now, null));
                dirty = true;
            }
            // Records, updates and notes older than 7 days go back to their own app.
            if (("record".equals(i.need()) || "info".equals(i.need())) && !"code".equals(sc.rule())
                    && now - is.firstSeenAt > CLEAR_AFTER && !"done".equals(is.state) && !"cleared".equals(is.state)) {
                is.state = "cleared";
                count(now, "cleared", 1);
                dirty = true;
            }
        }

        // The card in flight.
        if (card != null) {
            Reach.Item ci = live.get(card.itemKey);
            if (ci == null && !card.taken) {
                card = null;
            } else if (!card.visible && card.afterUntil == 0 && !card.taken) {
                // The heads-up: the card follows 8 s later, once typing and calls allow.
                if (now >= card.showAt && st != Focus.State.TYPING && st != Focus.State.CALL
                        && st != Focus.State.AWAY) {
                    show(card, now, st, log);
                }
            } else if (card.visible && !card.taken && card.level == Deliver.Level.OFFER && card.tuckAt > 0
                    && now >= card.tuckAt) {
                // An untouched offer tucks back; it stays listed in To-do and isn't offered at breaks again.
                ItemState is = items.get(card.itemKey);
                if (is != null && "carded".equals(is.state)) {
                    is.state = "shown";
                    is.how = "tucked";
                }
                card = null;
                dirty = true;
            } else if (card.afterUntil > 0 && now >= card.afterUntil) {
                card = null;
            } else if (card.taken && backCardId == null && now - card.takenAt >= 10 * MINUTE) {
                offerBack(now);
            }
        }
        if (back != null && now >= backUntil) {
            // Back not taken: if the member isn't back on the task, it becomes a pick-up (only her own interruptions).
            if (backSnapshot != null && !onSnapshot(backSnapshot)) {
                // Not resumed: a pick-up, offered at the first coarse break 2 minutes after Back came.
                pickups.put("pickup:" + backCardId, backSnapshot);
                pickupAt.put("pickup:" + backCardId, backOfferedAt + Deliver.PICKUP_AFTER);
                count(now, "pickups", 1);
            }
            count(now, "back_ignored", 1);
            back = null;
            backCardId = null;
            backSnapshot = null;
            card = null;
            dirty = true;
        }
        if (card != null && card.taken && back == null && backCardId != null) {
            card = null;
        }

        boolean on = !s.showAll();
        // Idle at the office (2 minutes without input): nothing is put in front of no one; coming back is the break.
        boolean idle = tracker.now != null && tracker.now.idle() && !away;
        if (idle && idleSince == 0) {
            idleSince = now;
        } else if (!idle) {
            idleSince = 0;
        }
        // Idle a while with the office open counts as away for the bell (her phone and mail, fixed words).
        boolean bellable = away || idle && now - idleSince >= IDLE_BELL_MS;
        // Catch-ups first: a catch-up given now uses the break, so no card comes with it.
        if (on && !idle && catchUps(now, z, s, day, st, brk, returned, away, log)) {
            Focus.closeBreak(tracker);
            brk = null;
        }
        if (on && !away) {
            // Interrupts first (while idle, only what's about to expire: the card waits on screen): the gate, the 15-minute cap, the state's rule, the heads-up.
            if (card == null) {
                List<Reach.Item> gate = new ArrayList<>();
                for (Reach.Item i : live.values()) {
                    ItemState is = items.get(i.key());
                    if (levels.get(i.key()) == Deliver.Level.INTERRUPT && is != null && is.waiting(now)) {
                        gate.add(i);
                    }
                }
                // Expiring first, then within the hour, then the member's people and code-rule Now (a desk stuck, a
                // limit) in the order they came, then the list's kinds (due today, money) by their deadlines.
                gate.sort(Comparator.comparingInt((Reach.Item i) -> tier(i, now))
                        .thenComparing(i -> i.deadlineAt() == null ? Long.MAX_VALUE : i.deadlineAt())
                        .thenComparingLong(i -> items.get(i.key()).readyAt).thenComparing(Reach.Item::key));
                for (Reach.Item i : gate) {
                    ItemState is = items.get(i.key());
                    boolean exp = expiring(i, now);
                    // The spacing between interrupts; one with a deadline that can't wait it out comes anyway.
                    boolean needsNow = i.deadlineAt() != null && i.deadlineAt() - now <= Deliver.INTERRUPT_SPACING;
                    boolean capOk = now - lastInterruptAt >= Deliver.INTERRUPT_SPACING
                            || needsNow && now - lastInterruptAt >= Deliver.INTERRUPT_EVERY || exp;
                    if (is.afterThis && brk != Focus.Kind.COARSE && !exp || idle && !exp) {
                        continue;
                    }
                    // Just in time: a deadline item that isn't a person on the list comes at a coarse break, or once
                    // its deadline is near, so several come together on one card instead of one interruption each.
                    if (justInTime(i, now) && brk != Focus.Kind.COARSE) {
                        continue;
                    }
                    boolean settling = now < tracker.settleUntil && !exp;
                    long waited = now - Math.max(is.readyAt, presentSince);
                    if (capOk && !settling && Deliver.interruptMay(st, brk, scores.get(i.key()), day, exp, waited)) {
                        card = newCard(i, Deliver.Level.INTERRUPT, now);
                        if (exp) {
                            show(card, now, st, log);
                        } else {
                            card.showAt = now + Deliver.HEADS_UP_MS;
                            log.add(new Delivery("heads_up", i.key(), i.kind(), "interrupt",
                                    st.name().toLowerCase(java.util.Locale.ROOT), now, "One thing in a moment"));
                        }
                        lastInterruptAt = now;
                        Focus.closeBreak(tracker);
                        break;
                    }
                }
            }
            // Offers: one a break, three an hour; closest first; documents only when linked; records never.
            if (card == null && brk != null && !idle && offersHour.size() < Deliver.OFFERS_PER_HOUR) {
                int upTo = Deliver.offerUpTo(st, brk);
                Reach.Item best = null;
                for (Reach.Item i : live.values()) {
                    ItemState is = items.get(i.key());
                    Reach.Score sc = scores.get(i.key());
                    Deliver.Level lv = levels.get(i.key());
                    if (is == null || sc == null || !"new".equals(is.state) || now < is.snoozeUntil
                            || i.record() || lv == Deliver.Level.INTERRUPT || lv == Deliver.Level.HOLD) {
                        continue;
                    }
                    if (is.afterThis && brk != Focus.Kind.COARSE) {
                        continue;
                    }
                    boolean floor = floor(i, now, z, s);
                    boolean fits = upTo >= 0 && sc.distance() <= upTo && lv == Deliver.Level.OFFER;
                    if ("doc".equals(i.kind()) && (!Set.of("sphere", "person", "task").contains(sc.close())
                            || sc.distance() > Deliver.OFFER_FINE)) {
                        fits = false;
                    }
                    if (!fits && !(floor && st != Focus.State.TYPING && st != Focus.State.CALL)) {
                        continue;
                    }
                    if (is.afterThis) {
                        fits = true;
                    }
                    if (best == null || better(i, best, now)) {
                        best = i;
                    }
                }
                if (best != null) {
                    card = newCard(best, Deliver.Level.OFFER, now);
                    show(card, now, st, log);
                    card.tuckAt = now + Deliver.TUCK_MS;
                    offersHour.add(now);
                    offersToday++;
                    Focus.closeBreak(tracker);
                }
            }
            // An item about to pass its deadline with no break coming: offered when typing and calls allow.
            if (card == null && st != Focus.State.TYPING && st != Focus.State.CALL) {
                for (Reach.Item i : live.values()) {
                    ItemState is = items.get(i.key());
                    if (is != null && "new".equals(is.state) && !i.record() && i.deadlineAt() != null
                            && i.deadlineAt() > now && i.deadlineAt() - now <= Deliver.EXPIRING
                            && levels.get(i.key()) != Deliver.Level.HOLD && now >= is.snoozeUntil) {
                        card = newCard(i, Deliver.Level.OFFER, now);
                        show(card, now, st, log);
                        card.tuckAt = now + Deliver.TUCK_MS;
                        break;
                    }
                }
            }
        }

        if (bellable) {
            // Interrupt-level items held while away: Phase 2's bell (fixed words, no content). Quiet hours let only
            // code-rule Now and "any time" entries ring; at most BELLS_PER_DAY a day. An approval is rung by
            // its own desk's deskd (Phase 2), so it's in the log (the member's phone rings for it) but never counted here.
            int n = 0;
            for (Reach.Item i : live.values()) {
                ItemState is = items.get(i.key());
                if (levels.get(i.key()) == Deliver.Level.INTERRUPT && is != null && is.waiting(now)) {
                    n++;
                    Reach.Score sc = scores.get(i.key());
                    if (day.quiet() && !sc.anyTime() || rang.contains(i.key() + "#" + is.count)) {
                        continue;
                    }
                    if ("approval".equals(i.kind())) {
                        rang.add(i.key() + "#" + is.count);
                        log.add(new Delivery("bell", i.key(), i.kind(), "interrupt", "away", now, null, false));
                    } else if (bellsToday(now) < BELLS_PER_DAY) {
                        rang.add(i.key() + "#" + is.count);
                        ringReach++;
                        count(now, "bell", 1);
                        log.add(new Delivery("bell", i.key(), i.kind(), "interrupt", "away", now, null, false));
                    }
                }
            }
            awayInterrupts = n;
        } else {
            rang.clear();
        }

        // The view.
        Set<String> held = new HashSet<>();
        int heldCount = 0;
        int waitingNow = 0;
        for (Reach.Item i : live.values()) {
            ItemState is = items.get(i.key());
            Deliver.Level lv = levels.get(i.key());
            if (is == null || lv == null) {
                continue;
            }
            if (lv == Deliver.Level.HOLD && !"pickup".equals(i.kind())) {
                held.add(i.key());
            }
            if (is.held(now) && !"cleared".equals(is.state)) {
                heldCount++;
                if (lv == Deliver.Level.INTERRUPT) {
                    waitingNow++;
                }
            }
        }
        Map<String, Object> view = on ? view(now, z, st, heldCount, waitingNow) : offView();
        String nid = null;
        Long nat = null;
        if (noticeItemId != null) {
            nid = noticeItemId;
            nat = noticeAt;
        }
        long wake = wake(now, z, s, day, st);
        if (dirty && now - savedAt >= 10_000L) {
            save(now);
        }
        return new Output(view, on ? held : Set.of(), nid, nat, wake, log, on);
    }

    private boolean better(Reach.Item a, Reach.Item b, long now) {
        int da = scores.get(a.key()).distance();
        int db = scores.get(b.key()).distance();
        if (da != db) {
            return da < db;
        }
        long xa = a.deadlineAt() == null ? Long.MAX_VALUE : a.deadlineAt();
        long xb = b.deadlineAt() == null ? Long.MAX_VALUE : b.deadlineAt();
        if (xa != xb) {
            return xa < xb;
        }
        return items.get(a.key()).firstSeenAt < items.get(b.key()).firstSeenAt;
    }

    /** A gate item with a deadline far enough off to wait for a coarse break or its last moment (not a person). */
    private boolean justInTime(Reach.Item i, long now) {
        if (i.deadlineAt() == null || i.deadlineAt() - now <= Deliver.JUST_IN_TIME) {
            return false;
        }
        Reach.Score sc = scores.get(i.key());
        if (sc != null && sc.rule() != null && !"code".equals(sc.rule()) && !"stuck".equals(sc.rule())) {
            Reach.Rule r = settings.letThrough().stream().filter(x -> x.ruleId().equals(sc.rule())).findFirst()
                    .orElse(null);
            if (r != null && !"match".equals(r.kind())) {
                return false;
            }
        }
        return true;
    }

    /** The gate's order: 0 expiring, 1 within the hour, 2 a person or group on the list or a code-rule Now, 3 the rest. */
    private int tier(Reach.Item i, long now) {
        if (expiring(i, now)) {
            return 0;
        }
        if (i.deadlineAt() != null && i.deadlineAt() - now <= 60 * MINUTE) {
            return 1;
        }
        Reach.Score sc = scores.get(i.key());
        if (i.codeNow() || sc != null && "stuck".equals(sc.rule())) {
            return 2;
        }
        if (sc != null && sc.rule() != null) {
            Reach.Rule r = settings.letThrough().stream().filter(x -> x.ruleId().equals(sc.rule())).findFirst()
                    .orElse(null);
            if (r != null && !"match".equals(r.kind())) {
                return 2;
            }
        }
        return 3;
    }

    private static boolean expiring(Reach.Item i, long now) {
        return i.deadlineAt() != null && i.deadlineAt() > now && i.deadlineAt() - now <= Deliver.EXPIRING;
    }

    /** The deadline floor: no catch-up before its deadline, and it's within 3 hours. */
    private boolean floor(Reach.Item i, long now, ZoneId z, Reach.Settings s) {
        if (i.deadlineAt() == null || i.deadlineAt() <= now) {
            return false;
        }
        return Rhythm.lastBefore(i.deadlineAt(), now, z, s) == null && i.deadlineAt() - now <= Deliver.FLOOR;
    }

    private boolean lowCapacity(long now, Rhythm.Day day) {
        if (Focus.flowMs(tracker, now) >= Focus.FLOW_LOW_MS) {
            return true;
        }
        if (offersToday * 4 >= Deliver.OFFERS_PER_DAY * 3) {
            return true;
        }
        Long next = Rhythm.next(now, day.zone(), settings);
        return lastCatchUpAt > 0 && Rhythm.last(lastCatchUpAt, day.zone(), settings)
                && date(lastCatchUpAt, day.zone()).equals(date(now, day.zone())) && next != null;
    }

    private boolean taskIdle(long now) {
        if (task == null || task.refs().isEmpty()) {
            return false;
        }
        Focus.Sphere sp = Focus.sphere(tracker, now);
        boolean onIt = sp != null && task.refs().stream().anyMatch(r -> Objects.equals(r, sp));
        if (onIt) {
            taskSeenAt = now;
        }
        return now - Math.max(taskSeenAt, task.setAt()) >= TASK_IDLE;
    }

    private long taskSeenAt;

    private Card newCard(Reach.Item i, Deliver.Level level, long now) {
        Card c = new Card();
        c.cardId = "mc-" + token();
        c.itemKey = i.key();
        c.level = level;
        c.device = tracker.device();
        c.createdAt = now;
        c.showAt = now;
        c.atBreak = Focus.breakOpen(tracker, now) != null;
        Reach.Score sc = scores.get(i.key());
        if (sc != null && sc.rule() != null && !"code".equals(sc.rule()) && !"stuck".equals(sc.rule())
                && !firstShown.contains(sc.rule())) {
            c.firstRule = sc.rule();
        }
        return c;
    }

    private void show(Card c, long now, Focus.State st, List<Delivery> log) {
        c.visible = true;
        c.showAt = now;
        ItemState is = items.get(c.itemKey);
        Reach.Item i = live.get(c.itemKey);
        if (is != null) {
            is.state = "carded";
            is.deliveredAt = now;
            is.how = c.level == Deliver.Level.INTERRUPT ? "interrupt" : "offer";
            is.afterThis = false;
        }
        c.snapshot = snapshot(now);
        if (c.firstRule != null) {
            firstShown.add(c.firstRule);
        }
        if (c.level == Deliver.Level.INTERRUPT) {
            noticeItemId = i == null ? null : i.id();
            noticeAt = now;
            count(now, "interrupts", 1);
            // Up to 2 more that may interrupt now ride on this card: one interruption instead of three.
            for (Reach.Item o : live.values()) {
                ItemState os = items.get(o.key());
                if (c.more.size() >= Deliver.MORE_MAX || o.key().equals(c.itemKey) || os == null
                        || levels.get(o.key()) != Deliver.Level.INTERRUPT || !os.waiting(now)
                        || Rhythm.day(now, zone.get(), settings, holdWorkUntil).quiet()
                        && !scores.get(o.key()).anyTime()) {
                    continue;
                }
                c.more.add(o.key());
                os.state = "carded";
                os.deliveredAt = now;
                os.how = "interrupt";
                log.add(new Delivery("interrupt_more", o.key(), o.kind(), "interrupt",
                        st.name().toLowerCase(java.util.Locale.ROOT), now, o.title(), true));
            }
        } else {
            count(now, "offers", 1);
        }
        boolean atBreak = st == Focus.State.FINE || st == Focus.State.COARSE || c.atBreak
                || Focus.breakOpen(tracker, now) != null || i != null && expiring(i, now);
        if (atBreak) {
            count(now, "at_break", 1);
        }
        count(now, "delivered", 1);
        log.add(new Delivery(c.level == Deliver.Level.INTERRUPT ? "interrupt" : "offer", c.itemKey,
                i == null ? null : i.kind(), c.level.name().toLowerCase(java.util.Locale.ROOT),
                st.name().toLowerCase(java.util.Locale.ROOT), now, i == null ? null : i.title(), atBreak));
        dirty = true;
    }

    private Snapshot snapshot(long now) {
        Focus.Now f = tracker.now;
        if (f == null) {
            return null;
        }
        String label = null;
        if (task != null && task.refs().stream().anyMatch(r -> Objects.equals(r.deskId(), f.deskId())
                && Objects.equals(r.item(), f.item()))) {
            label = task.label();
        }
        return new Snapshot(f.surface(), f.deskId(), f.app(), f.item(), Focus.placeSince(tracker), label);
    }

    private boolean onSnapshot(Snapshot s) {
        Focus.Now f = tracker.now;
        return f != null && Objects.equals(f.deskId(), s.deskId()) && Objects.equals(f.app(), s.app())
                && Objects.equals(f.item(), s.item());
    }

    private void offerBack(long now) {
        if (card == null || card.snapshot == null) {
            return;
        }
        backCardId = card.cardId;
        backSnapshot = card.snapshot;
        backUntil = now + Deliver.BACK_FOR;
        backOfferedAt = now;
        back = backView(card.cardId, card.snapshot, now);
        dirty = true;
    }

    private Map<String, Object> backView(String cardId, Snapshot s, long now) {
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("cardId", cardId);
        v.put("label", "Back to " + placeLabel(s));
        v.put("resume", resume(s, now));
        v.put("deskId", s.deskId());
        v.put("app", s.app());
        v.put("item", s.item() == null ? null : Map.of("kind", s.item().kind(), "id", s.item().id()));
        v.put("surface", s.surface());
        v.put("until", backUntil);
        return v;
    }

    /** "Q3 plan" (their words), else the app ("Notebook"). */
    private String placeLabel(Snapshot s) {
        if (s.label() != null) {
            return s.label();
        }
        return appWord(s.app());
    }

    /** "You were on Q3 plan in Notebook, Work. Last change 3 min ago." Written by code from the snapshot. */
    String resume(Snapshot s, long now) {
        String desk = s.deskId() == null ? null : deskNames.get(s.deskId());
        String where = appWord(s.app()) + (desk == null ? "" : ", " + desk);
        String first = s.label() != null ? "You were on " + s.label() + " in " + where + "."
                : "You were in " + where + ".";
        long ago = Math.max(0, now - s.lastChangeAt());
        return first + " Last change " + (ago < MINUTE ? "just now." : Attention.duration(ago) + " ago.");
    }

    static String appWord(String app) {
        if (app == null) {
            return "your desk";
        }
        if (app.startsWith("agent")) {
            return "Agents";
        }
        if (app.startsWith("app:")) {
            return "an app";
        }
        return switch (app) {
            case "notebook" -> "Notebook";
            case "courier" -> "Courier";
            case "todo" -> "To-do";
            case "files" -> "Files";
            case "browser" -> "Browser";
            case "commons" -> "Commons";
            case "maia" -> "Maia’s room";
            default -> "your desk";
        };
    }

    private Reach.Item pickupItem(String key, Snapshot s, long at) {
        Map<String, Object> go = new LinkedHashMap<>();
        go.put("kind", "back");
        go.put("cardId", key.substring("pickup:".length()));
        go.put("deskId", s.deskId());
        go.put("app", s.app());
        go.put("item", s.item() == null ? null : Map.of("kind", s.item().kind(), "id", s.item().id()));
        String label = placeLabel(s);
        return new Reach.Item(key, "pickup", s.deskId(), deskNames.get(s.deskId()), null, false,
                new Reach.Refs(s.app(), null, null, null, null, s.item() == null ? null : s.item().id(), List.of()),
                Reach.Sender.NONE, null, false, "action", Set.of(), 1, at, true, "Pick up: " + label,
                deskNames.getOrDefault(s.deskId(), "Your desk"), go, "Pick up");
    }

    // ---------------------------------------------------------------- catch-ups

    /** @return whether a catch-up was given now */
    private boolean catchUps(long now, ZoneId z, Reach.Settings s, Rhythm.Day day, Focus.State st, Focus.Kind brk,
            boolean returned, boolean away, List<Delivery> log) {
        Long due = Rhythm.due(now, z, s, lastCatchUpAt);
        // The return catch-up: everything held while the member was away, at the first coarse break after; folded
        // into a catch-up that's due now (it brings everything held anyway).
        if (pendingReturn && !away && due != null) {
            pendingReturn = false;
            for (ItemState is : items.values()) {
                is.away = false;
            }
        }
        boolean given = false;
        boolean quietNow = st == Focus.State.TYPING || st == Focus.State.CALL;
        if (pendingReturn && !away && !quietNow) {
            pendingReturn = false;
            List<Rhythm.Entry> es = new ArrayList<>();
            boolean urgentHeld = false;
            for (Reach.Item i : live.values()) {
                ItemState is = items.get(i.key());
                if (is != null && is.held(now) && !"cleared".equals(is.state) && "new".equals(is.state)
                        && !(scores.get(i.key()) != null && scores.get(i.key()).partitioned())
                        && !"pickup".equals(i.kind())) {
                    es.add(entry(i, now));
                    urgentHeld |= levels.get(i.key()) == Deliver.Level.INTERRUPT;
                }
            }
            for (ItemState is : items.values()) {
                is.away = false;
            }
            Question q = null;
            if (urgentHeld && !askedEmail) {
                askedEmail = true;
                q = new Question("email_me", "Something needed you while you were away. Email me next time?",
                        List.of(Deliver.choice("yes", "Yes"), Deliver.choice("no", "No")), null, now);
            }
            Rhythm.CatchUp c = Rhythm.build("mu-" + token(), "return", "While you were away · "
                    + Rhythm.things(es.size()), now, es, List.of(), 0, List.of(), q == null ? null : q.view(), false);
            if (c != null) {
                asked = q;
                deliverCatchUp(c, now, st, log);
                given = true;
            }
        }
        if (due == null) {
            catchUpPendingSince = 0;
            return given;
        }
        if (away) {
            // The office is closed: the time is kept, and the return catch-up brings it. The day's first waits for the
            // member: the morning brief is the first time they're present after it.
            if (date(now, z).equals(briefDay) || !day.workday()) {
                lastCatchUpAt = due;
                dirty = true;
            }
            return given;
        }
        boolean busy = st == Focus.State.TYPING || st == Focus.State.CALL || st == Focus.State.DEEP
                || st == Focus.State.HOLD;
        if (catchUpPendingSince == 0) {
            catchUpPendingSince = now;
        }
        boolean waited = now - catchUpPendingSince >= Rhythm.CATCHUP_WAIT_MS;
        // Never over typing or a call; focus hours and a hold wait for a coarse break (up to an hour, then the line).
        boolean typingOrCall = st == Focus.State.TYPING || st == Focus.State.CALL;
        if (typingOrCall && !waited || busy && brk != Focus.Kind.COARSE && !waited) {
            return given;
        }
        lastCatchUpAt = due;
        catchUpPendingSince = 0;
        dirty = true;
        String today = date(now, z);
        boolean weekday = !day.weekend();
        // The morning brief: the first presence after the day's first catch-up time, while that's the one due; a member
        // who arrives after a later one gets that catch-up whole.
        boolean brief = !today.equals(briefDay) && weekday && Rhythm.first(due, z, s);
        boolean lastOne = Rhythm.last(due, z, s);
        List<Rhythm.Entry> es = new ArrayList<>();
        // A catch-up at a day's edge (9:00, 5:00) covers both sides of it: Work and Personal by the clock either side.
        Rhythm.Day edge = Rhythm.day(due - MINUTE, z, s, holdWorkUntil);
        Rhythm.Day at = Rhythm.day(due, z, s, holdWorkUntil);
        int docs = 0;
        for (Reach.Item i : live.values()) {
            ItemState is = items.get(i.key());
            if (is == null || !is.held(now) || "cleared".equals(is.state) || "pickup".equals(i.kind())) {
                continue;
            }
            Reach.Score sc = scores.get(i.key());
            // Work or Personal outside its hours waits for its own catch-up; a "Not now" before this one comes now.
            if (sc != null && !sc.gate() && Reach.offHours(i, edge, s) && Reach.offHours(i, at, s)) {
                continue;
            }
            if ("rest".equals(is.state) && now < is.restUntil && is.restUntil > due + MINUTE) {
                continue;
            }
            Rhythm.Entry e = entry(i, now);
            if ("doc".equals(i.kind()) && !"records".equals(e.group()) && !"read_later".equals(e.group())
                    && ++docs > 3) {
                // At most 3 documents a catch-up as their own lines; the rest are counted under Read later.
                e = new Rhythm.Entry(i, "read_later", e.line());
            }
            es.add(e);
        }
        es.sort(Comparator.comparingInt((Rhythm.Entry e) -> Rhythm.ORDER.indexOf(e.group()))
                .thenComparingInt(e -> scores.containsKey(e.item().key()) ? scores.get(e.item().key()).distance()
                        : 100));
        List<String> done = new ArrayList<>();
        int notes = 0;
        for (Rhythm.Entry e : es) {
            if (e.item().tags().contains("done")) {
                notes += e.item().count();
            }
        }
        es.removeIf(e -> e.item().tags().contains("done"));
        if (notes > 0) {
            done.add("Filed " + Rhythm.count(notes, "note", "notes"));
        }
        int cleared = (int) items.values().stream().filter(i -> "cleared".equals(i.state) && !i.caughtUp).count();
        items.values().stream().filter(i -> "cleared".equals(i.state)).forEach(i -> i.caughtUp = true);
        List<String> extra = new ArrayList<>();
        Question q = null;
        if (lastOne) {
            long tomorrow = live.values().stream().filter(i -> i.deadlineAt() != null
                    && "tomorrow".equals(Rhythm.dayWords(i.deadlineAt(), now, z))).count();
            if (tomorrow > 0) {
                extra.add("Tomorrow: " + tomorrow + " due");
            }
            if (Instant.ofEpochMilli(now).atZone(z).getDayOfWeek() == DayOfWeek.FRIDAY) {
                String week = weekLine(now, z);
                if (week != null) {
                    extra.add(week);
                }
                if (!today.equals(paceAskedDay) && weeksOfUse(now) >= 1) {
                    paceAskedDay = today;
                    q = new Question("pace", "How was the pace?", List.of(Deliver.choice("calm", "Calm"),
                            Deliver.choice("ok", "OK"), Deliver.choice("too_much", "Too much"),
                            Deliver.choice("missed", "Missed something")), null, now);
                }
            }
            if (q == null && "let".equals(s.evenings()) && weekday) {
                q = new Question("hold_work_tonight", "Hold Work until tomorrow at "
                        + Rhythm.clock(Rhythm.nextWorkdayStart(now, z, s), z) + "?", List.of(Deliver.choice("yes",
                        "Yes"), Deliver.choice("not_today", "Not today")), null, now);
            }
        }
        if (q == null && brief && Instant.ofEpochMilli(now).atZone(z).getDayOfWeek() == DayOfWeek.MONDAY
                && !today.equals(weekAskedDay)) {
            q = weekQuestion(now);
            if (q != null) {
                weekAskedDay = today;
            }
        }
        if (q == null && !questions.isEmpty()) {
            q = questions.remove(0);
        }
        if (q == null && !brief) {
            q = tagQuestion(now, today);
        }
        String head = brief ? null : "Your " + Rhythm.clock(due, z) + " catch-up · "
                + Rhythm.things(Math.min(es.size(), Rhythm.CATCHUP_MAX)) + ", "
                + (es.stream().anyMatch(e -> levels.get(e.item().key()) == Deliver.Level.INTERRUPT)
                        ? "one needs you" : "nothing urgent");
        boolean waiting = busy && waited;
        Rhythm.CatchUp c = Rhythm.build("mu-" + token(), brief ? "brief" : "catchup", head, now, es, done, cleared,
                extra, q == null ? null : q.view(), waiting);
        if (weekday) {
            briefDay = today;
        }
        if (c == null) {
            // A catch-up that finds nothing says nothing.
            if (q != null && !"pace".equals(q.questionId()) && !"week_pick".equals(q.questionId())) {
                questions.add(0, q);
            }
            return given;
        }
        asked = q;
        deliverCatchUp(c, now, st, log);
        return true;
    }

    private void deliverCatchUp(Rhythm.CatchUp c, long now, Focus.State st, List<Delivery> log) {
        catchup = c;
        if (!c.waiting()) {
            markCaughtUp(c, now);
        }
        count(now, "catchups", 1);
        count(now, "catchup_items", c.itemKeys().size());
        log.add(new Delivery(c.waiting() ? "catchup_ready" : c.kind(), null, null, null,
                st.name().toLowerCase(java.util.Locale.ROOT), now, c.head(), true));
        if (!c.waiting()) {
            for (String k : c.itemKeys()) {
                log.add(new Delivery("catchup_item", k, items.containsKey(k) ? items.get(k).kind : null,
                        items.containsKey(k) ? items.get(k).level : null, c.kind(), now, null, true));
            }
        }
        dirty = true;
    }

    private void markCaughtUp(Rhythm.CatchUp c, long now) {
        for (String k : c.itemKeys()) {
            ItemState is = items.get(k);
            if (is != null && is.held(now)) {
                is.state = "shown";
                is.caughtUp = true;
                is.deliveredAt = now;
                is.how = "catchup";
            }
        }
    }

    private Rhythm.Entry entry(Reach.Item i, long now) {
        Reach.Score sc = scores.get(i.key());
        Deliver.Level lv = levels.get(i.key());
        String group;
        if (i.record()) {
            group = "records";
        } else if (lv == Deliver.Level.INTERRUPT || "you".equals(i.need()) || i.tags().contains("due_today")
                || i.deadlineAt() != null && i.deadlineAt() - now <= DAY) {
            group = "needs_you";
        } else if (sc != null && Set.of("sphere", "person", "task", "week").contains(sc.close())) {
            group = "working_on";
        } else if ("action".equals(i.need()) && !"doc".equals(i.kind())) {
            group = "needs_you";
        } else {
            group = "read_later";
        }
        List<Map<String, Object>> chips = new ArrayList<>();
        if (!(lv == Deliver.Level.INTERRUPT && sc != null && sc.rule() != null)) {
            chips.add(Deliver.choice("not_important", "Not important"));
        }
        chips.add(Deliver.choice("sooner", "Sooner next time"));
        Rhythm.Line line = new Rhythm.Line(i.key(), i.id(), i.title(), i.go(), Deliver.goLabel(i), chips);
        return new Rhythm.Entry(i, group, line);
    }

    private Question weekQuestion(long now) {
        List<Focus.Sphere> top = Focus.recent(tracker, now, 7 * DAY, 3);
        if (top.isEmpty()) {
            return null;
        }
        List<Map<String, Object>> choices = new ArrayList<>();
        int n = 0;
        for (Focus.Sphere sp : top) {
            Map<String, Object> c = Deliver.choice("pick-" + n, appWord(sp.app()) + " on "
                    + deskNames.getOrDefault(sp.deskId(), "a desk"));
            c.put("ref", Map.of("deskId", sp.deskId(), "app", sp.app(), "item", Map.of("kind", sp.item().kind(),
                    "id", sp.item().id())));
            choices.add(c);
            n++;
        }
        choices.add(Deliver.choice("not_now", "Not now"));
        weekOffer = top;
        return new Question("week_pick", "Anything to keep close this week?", choices, null, now);
    }

    private List<Focus.Sphere> weekOffer = List.of();

    /**
     * "Is {who} family, a client, or neither?": at most one a day, only with a group on the list (its choices are the
     * list's groups), only about people the member writes to more than once a week (reply band 2 or more).
     */
    private Question tagQuestion(long now, String today) {
        List<String> groups = settings.letThrough().stream().filter(r -> "group".equals(r.kind()))
                .map(Reach.Rule::group).distinct().toList();
        if (today.equals(tagAskedDay) || groups.isEmpty()) {
            return null;
        }
        for (Map.Entry<String, Integer> e : replyBands.entrySet()) {
            if (e.getValue() >= 2 && !tags.containsKey(e.getKey())) {
                tagAskedDay = today;
                List<Map<String, Object>> choices = new ArrayList<>();
                List<String> words = new ArrayList<>();
                List<String> each = new ArrayList<>();
                for (String g : groups) {
                    if ("boss_clients".equals(g)) {
                        each.add("boss");
                        each.add("clients");
                    } else {
                        each.add(g);
                    }
                }
                for (String g : each.stream().distinct().limit(3).toList()) {
                    String w = switch (g) {
                        case "family" -> "family";
                        case "boss" -> "your boss";
                        case "clients" -> "a client";
                        default -> "on your team";
                    };
                    words.add(w);
                    choices.add(Deliver.choice(g, Character.toUpperCase(w.charAt(0)) + w.substring(1)));
                }
                choices.add(Deliver.choice("neither", "Neither"));
                String text = "Is {who} " + String.join(", ", words) + ", or neither?";
                return new Question("tag_contact", text, choices, "person:" + e.getKey(), now);
            }
        }
        return null;
    }

    /** A contact's group, as the member said (the tagging question) or the office already knows it. */
    public synchronized void tag(Focus.Person p, String group) {
        if (p != null && (Reach.TAGS.contains(group) || "neither".equals(group))) {
            tags.put(Reach.personKey(p), group);
            dirty = true;
        }
    }

    private String weekLine(long now, ZoneId z) {
        LocalDate d = Instant.ofEpochMilli(now).atZone(z).toLocalDate();
        String from = d.minusDays(d.getDayOfWeek().getValue() - 1).toString();
        String to = d.toString();
        int held = store.sum(from, to, "arrived");
        int missed = store.sum(from, to, "missed");
        int ruled = store.sum(from, to, "missed_ruled");
        if (held == 0) {
            return null;
        }
        if (missed == 0) {
            return "This week I held " + held + " things. Nothing urgent was missed.";
        }
        if (ruled >= missed) {
            return "This week I held " + held + " things. I was late with " + missed + ". "
                    + (missed == 1 ? "It now gets through." : "They now get through.");
        }
        return "This week I held " + held + " things.";
    }

    private int weeksOfUse(long now) {
        long first = items.values().stream().mapToLong(i -> i.firstSeenAt).min().orElse(now);
        return (int) ((now - Math.min(first, firstUseAt == 0 ? now : firstUseAt)) / (7 * DAY));
    }

    private long firstUseAt;

    // ---------------------------------------------------------------- the view

    private Map<String, Object> offView() {
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("on", false);
        v.put("device", null);
        v.put("line", null);
        v.put("card", null);
        v.put("catchup", null);
        v.put("back", null);
        v.put("working", null);
        v.put("hold", null);
        v.put("held", Map.of("count", 0, "now", 0));
        v.put("accent", List.of());
        return v;
    }

    private Map<String, Object> view(long now, ZoneId z, Focus.State st, int heldCount, int waitingNow) {
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("on", true);
        v.put("device", tracker.device());
        Map<String, Object> line = new LinkedHashMap<>();
        String kind;
        String text;
        Map<String, Object> action = null;
        String dot = "none";
        if (card != null && !card.visible && card.afterUntil == 0 && !card.taken) {
            kind = "heads_up";
            text = "One thing in a moment";
            dot = "accent";
            // "Not yet" on the line: agent.maia.reach.answer {cardId, answer: not_yet}.
            action = Map.of("kind", "heads_up", "cardId", card.cardId);
        } else if (back != null) {
            kind = "back";
            text = String.valueOf(back.get("label"));
            action = Map.of("kind", "back", "cardId", backCardId);
        } else if (catchup != null && catchup.waiting()) {
            kind = "catchup";
            text = "Your " + Rhythm.clock(lastCatchUpAt, z) + " catch-up is ready";
            action = Map.of("kind", "catchup", "catchupId", catchup.catchupId());
        } else if (pickupLine(now) != null) {
            kind = "pickup";
            text = pickupLine;
            action = Map.of("kind", "pickup", "itemId", Attention.id(pickupKey), "cardId",
                    pickupKey.substring("pickup:".length()));
        } else if (holdUntil > now) {
            kind = "hold";
            text = "Holding until " + Rhythm.clock(holdUntil, z) + " · your list still gets through";
        } else if (heldCount == 0 && waitingNow == 0) {
            kind = "clear";
            text = "All clear";
        } else {
            kind = "held";
            text = Deliver.heldLine(heldCount, waitingNow);
            if (waitingNow > 0 && st == Focus.State.CALL) {
                dot = "accent";
            }
        }
        line.put("kind", kind);
        line.put("text", text);
        line.put("held", heldCount);
        line.put("dot", dot);
        line.put("action", action);
        v.put("line", line);
        v.put("card", cardView(now, z));
        v.put("catchup", catchup == null ? null : catchup.view());
        v.put("back", back);
        v.put("working", task == null ? null : Map.of("label", task.label()));
        v.put("hold", holdUntil > now ? Map.of("until", holdUntil) : null);
        v.put("held", Map.of("count", heldCount, "now", waitingNow));
        v.put("accent", accent(now));
        return v;
    }

    /**
     * The office's tiles under the shield (concept §5.6): their badges are still counts with no accent, except where an
     * interrupt-level item waits (a let-through match or a code-rule Now): those desks' apps, ids only, at most 20.
     */
    private List<Map<String, Object>> accent(long now) {
        Set<String> seen = new HashSet<>();
        List<Map<String, Object>> out = new ArrayList<>();
        for (Reach.Item i : live.values()) {
            ItemState is = items.get(i.key());
            String app = i.refs().app();
            if (out.size() >= 20 || is == null || i.deskId() == null || app == null || !is.held(now)
                    || levels.get(i.key()) != Deliver.Level.INTERRUPT) {
                continue;
            }
            String agentId = "agent".equals(app) ? i.refs().agentId() : null;
            if (seen.add(i.deskId() + "|" + app + "|" + agentId)) {
                Map<String, Object> a = new LinkedHashMap<>();
                a.put("deskId", i.deskId());
                a.put("app", app);
                a.put("agentId", agentId);
                out.add(a);
            }
        }
        return out;
    }

    private String pickupKey;
    private long pickupUntil;

    /** The pick-up line at a coarse break, at most once each, for a minute (it stays listed in To-do). */
    private String pickupLine(long now) {
        if (pickupLine != null && pickupKey != null && pickups.containsKey(pickupKey) && now < pickupUntil) {
            return pickupLine;
        }
        pickupLine = null;
        pickupKey = null;
        if (Focus.breakOpen(tracker, now) != Focus.Kind.COARSE) {
            return null;
        }
        for (Map.Entry<String, Snapshot> p : pickups.entrySet()) {
            ItemState is = items.get(p.getKey());
            if (onSnapshot(p.getValue())) {
                // Back on that task by themselves: nothing to pick up.
                if (is != null) {
                    is.state = "done";
                }
                continue;
            }
            if (is != null && "new".equals(is.state) && now >= pickupAt.getOrDefault(p.getKey(), 0L)) {
                pickupKey = p.getKey();
                pickupLine = "Pick up: " + placeLabel(p.getValue());
                pickupUntil = now + Deliver.BACK_FOR;
                is.state = "shown";
                is.how = "pickup_line";
                return pickupLine;
            }
        }
        pickupLine = null;
        pickupKey = null;
        return null;
    }

    private Map<String, Object> cardView(long now, ZoneId z) {
        if (card == null || card.taken || (!card.visible && card.afterUntil == 0)) {
            return null;
        }
        Reach.Item i = live.get(card.itemKey);
        if (i == null) {
            return null;
        }
        Reach.Score sc = scores.get(i.key());
        Reach.Context ctx = context(now);
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("cardId", card.cardId);
        v.put("itemId", i.id());
        v.put("level", card.level.name().toLowerCase(java.util.Locale.ROOT));
        v.put("kind", i.kind());
        v.put("deskId", i.deskId());
        v.put("source", i.source());
        v.put("what", i.title());
        v.put("why", sc == null ? null : Reach.why(i, sc, ctx));
        String more = null;
        if (sc != null && sc.rule() != null && !"code".equals(sc.rule()) && !"stuck".equals(sc.rule())) {
            more = settings.letThrough().stream().filter(r -> r.ruleId().equals(sc.rule())).findFirst()
                    .map(Reach::ruleLine).orElse(null);
        }
        v.put("whyMore", more);
        v.put("go", i.go());
        v.put("goLabel", Deliver.goLabel(i));
        v.put("choices", Deliver.choices(i, card.level, now, Rhythm.next(now, z, settings), z));
        Map<String, Object> quote = null;
        if ("message".equals(i.kind()) && i.refs().channelId() != null) {
            quote = Map.of("deskId", i.deskId(), "channelId", i.refs().channelId());
        }
        v.put("quote", quote);
        if (i.sender().person() != null) {
            v.put("who", Map.of("deskId", i.sender().person().deskId(), "contactId",
                    i.sender().person().contactId()));
        }
        Map<String, Object> first = null;
        if (card.firstRule != null) {
            String rl = settings.letThrough().stream().filter(r -> r.ruleId().equals(card.firstRule)).findFirst()
                    .map(r -> "I let this through because " + lower(Reach.ruleLine(r)) + ".").orElse(null);
            if (rl != null) {
                first = new LinkedHashMap<>();
                first.put("text", rl);
                first.put("choices", List.of(Deliver.choice("keep", "Keep"), Deliver.choice("not_for_this",
                        "Not for this")));
            }
        }
        v.put("first", first);
        Map<String, Object> after = null;
        if (card.afterUntil > 0) {
            after = new LinkedHashMap<>();
            after.put("text", card.afterText);
            after.put("choices", "not_important_done".equals(lastAnswerKind()) ? List.of(Deliver.choice("undo",
                    "Undo")) : List.of(Deliver.choice("not_important", "Not important"), Deliver.choice("undo",
                    "Undo")));
            after.put("until", card.afterUntil);
        }
        v.put("after", after);
        List<Map<String, Object>> riders = new ArrayList<>();
        for (String k : card.more) {
            Reach.Item o = live.get(k);
            Reach.Score os = scores.get(k);
            if (o == null || os == null) {
                continue;
            }
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("itemId", o.id());
            m.put("kind", o.kind());
            m.put("source", o.source());
            m.put("what", o.title());
            m.put("why", Reach.why(o, os, ctx));
            m.put("go", o.go());
            m.put("goLabel", Deliver.goLabel(o));
            riders.add(m);
        }
        v.put("more", riders);
        v.put("at", card.showAt);
        v.put("tuckAt", card.level == Deliver.Level.OFFER && card.afterUntil == 0 ? card.tuckAt : null);
        v.put("device", card.device);
        return v;
    }

    private String lastAnswerKind() {
        return lastAnswer == null ? null : String.valueOf(lastAnswer.get("kind"));
    }

    private static String lower(String s) {
        if (s.startsWith("{who}") || s.isEmpty()) {
            return s;
        }
        // "Family is on your list" → "family is on your list"; "You asked …" → "you asked …".
        return Character.toLowerCase(s.charAt(0)) + s.substring(1);
    }

    Reach.Context context(long now) {
        ZoneId z = zone.get();
        Rhythm.Day day = Rhythm.day(now, z, settings, holdWorkUntil);
        return new Reach.Context(now, tracker.now, Focus.sphere(tracker, now), task, week, settings, day, Map.of(),
                tags, i -> 0, i -> 0, false, exceptions, Focus.people(tracker, now));
    }

    /** The next moment a rule changes with no event. */
    private long wake(long now, ZoneId z, Reach.Settings s, Rhythm.Day day, Focus.State st) {
        long at = wake0(now, z, s, st);
        return at <= now ? now + 1_000L : at;
    }

    private static long later(long at, long t, long now) {
        return t > now ? Math.min(at, t) : at;
    }

    private long wake0(long now, ZoneId z, Reach.Settings s, Focus.State st) {
        long at = Long.MAX_VALUE;
        if (card != null) {
            if (!card.visible && card.afterUntil == 0) {
                at = later(at, Math.max(card.showAt, now + 1_000), now);
            }
            if (card.tuckAt > now) {
                at = later(at, card.tuckAt, now);
            }
            if (card.afterUntil > now) {
                at = later(at, card.afterUntil, now);
            }
        }
        if (back != null) {
            at = later(at, backUntil, now);
        }
        if (tracker.breakUntil > now) {
            at = later(at, tracker.breakUntil, now);
        }
        if (tracker.settleUntil > now) {
            at = later(at, tracker.settleUntil, now);
        }
        if (tracker.now != null && tracker.now.typing()) {
            at = later(at, tracker.typingAt + Focus.TYPING_MS, now);
        }
        if (tracker.observedAt > 0 && !wasAway) {
            at = later(at, tracker.observedAt + Focus.AWAY_MS, now);
        }
        Long next = Rhythm.next(now, z, s);
        if (next != null) {
            at = later(at, next, now);
        }
        if (catchUpPendingSince > 0) {
            at = later(at, catchUpPendingSince + Rhythm.CATCHUP_WAIT_MS, now);
        }
        if (holdUntil > now) {
            at = later(at, holdUntil, now);
        }
        // Focus hours, quiet hours and work hours begin and end by the clock: the next of those moments.
        at = later(at, Rhythm.nextBoundary(now, z, s), now);
        for (Reach.Item i : live.values()) {
            ItemState is = items.get(i.key());
            if (is == null) {
                continue;
            }
            if (is.snoozeUntil > now) {
                at = later(at, is.snoozeUntil, now);
            }
            if ("rest".equals(is.state) && is.restUntil > now) {
                at = later(at, is.restUntil, now);
            }
            if (levels.get(i.key()) == Deliver.Level.INTERRUPT && is.waiting(now)) {
                long w = is.readyAt + (st == Focus.State.STEADY ? Deliver.STEADY_WAIT : Deliver.DEEP_WAIT);
                if (w > now) {
                    at = later(at, w, now);
                }
                at = later(at, lastInterruptAt + Deliver.INTERRUPT_EVERY, now);
                at = later(at, lastInterruptAt + Deliver.INTERRUPT_SPACING, now);
            }
            if (i.deadlineAt() != null) {
                for (long t : new long[] {i.deadlineAt() - Deliver.FLOOR, i.deadlineAt() - Deliver.EXPIRING,
                        i.deadlineAt() - 60 * MINUTE, i.deadlineAt() - Deliver.JUST_IN_TIME, i.deadlineAt()}) {
                    if (t > now) {
                        at = later(at, t, now);
                    }
                }
            }
        }
        return at;
    }

    // ---------------------------------------------------------------- the member's answers

    /** {@code agent.maia.reach.answer}. */
    public synchronized void answer(Map<String, Object> p, long now) throws RpcError {
        load(now);
        String answer = p.get("answer") instanceof String a && a.matches("[a-z_]{1,24}") ? a : null;
        if (answer == null && !(p.get("pick") instanceof String)) {
            throw RpcError.badRequest("answer");
        }
        if (p.get("questionId") instanceof String qid) {
            question(qid, answer, p.get("pick"), now);
            return;
        }
        if (answer == null) {
            throw RpcError.badRequest("answer");
        }
        if (p.get("catchupId") instanceof String cid) {
            if (catchup == null || !catchup.catchupId().equals(cid)) {
                throw RpcError.notFound("catchup");
            }
            if ("open".equals(answer)) {
                markCaughtUp(catchup, now);
                for (String k : catchup.itemKeys()) {
                    opened.add(new Delivery("catchup_item", k, items.containsKey(k) ? items.get(k).kind : null,
                            items.containsKey(k) ? items.get(k).level : null, catchup.kind(), now, null, true));
                }
                catchup = catchup.shown();
            } else if ("dismiss".equals(answer)) {
                catchup = null;
            } else {
                throw RpcError.badRequest("answer");
            }
            dirty = true;
            return;
        }
        Reach.Item item = null;
        Card c = null;
        if (p.get("cardId") instanceof String cardId) {
            if (card != null && card.cardId.equals(cardId)) {
                c = card;
                item = live.get(card.itemKey);
            } else if (cardId.equals(backCardId) && "back".equals(answer)) {
                back(cardId, true, now);
                return;
            } else {
                throw RpcError.notFound("card");
            }
        } else if (p.get("itemId") instanceof String itemId) {
            for (Reach.Item i : live.values()) {
                if (i.id().equals(itemId)) {
                    item = i;
                }
            }
            if (card != null && item != null && card.itemKey.equals(item.key())) {
                c = card;
            }
        }
        if (item == null) {
            throw RpcError.notFound("item");
        }
        ItemState is = items.get(item.key());
        if (is == null) {
            throw RpcError.notFound("item");
        }
        ZoneId z = zone.get();
        Long next = Rhythm.next(now, z, settings);
        Rhythm.Day day = Rhythm.day(now, z, settings, holdWorkUntil);
        String dk = Learn.driftClass(item, day.part());
        Reach.Score sc = scores.get(item.key());
        boolean gateItem = sc != null && sc.gate();
        switch (answer) {
            case "go" -> {
                is.state = "shown";
                is.how = is.how == null ? "go" : is.how;
                if (now - is.deliveredAt <= 2 * MINUTE) {
                    classes.merge(dk, Learn.Counts.ZERO.act(now), (a, b) -> a.act(now));
                }
                if (c != null) {
                    c.taken = true;
                    c.takenAt = now;
                }
                count(now, "go", 1);
            }
            case "after_this" -> {
                is.state = "new";
                is.afterThis = true;
                is.readyAt = now;
                if (c != null) {
                    card = null;
                }
            }
            case "in_20" -> {
                is.state = "new";
                is.snoozeUntil = now + 20 * MINUTE;
                is.readyAt = is.snoozeUntil;
                if (c != null) {
                    card = null;
                }
            }
            case "at_catchup", "not_now" -> {
                if ("not_now".equals(answer) && !Attention.dismissable(item.kind())) {
                    throw RpcError.of("bad_request", "reason", "kind");
                }
                is.state = "rest";
                is.restUntil = next == null ? now + 2 * 60 * MINUTE : next;
                if ("not_now".equals(answer)) {
                    classes.merge(dk, Learn.Counts.ZERO.notNow(now), (a, b) -> a.notNow(now));
                    Learn.Counts cls = classes.get(dk);
                    String keepCls = Learn.classOf(item);
                    if (Learn.askKeep(cls, now) && learned.stream().noneMatch(r -> r.classKey().equals(keepCls))
                            && questions.stream().noneMatch(q -> keepCls.equals(q.ref()))) {
                        questions.add(new Question("keep_for_catchups", "You’ve held these three times. Keep them"
                                + " for catch-ups?", List.of(Deliver.choice("yes", "Yes"), Deliver.choice("no",
                                "No")), keepCls, now));
                    }
                    count(now, "not_now", 1);
                }
                if (c != null) {
                    c.afterUntil = now + Deliver.AFTER_FOR;
                    c.afterText = "Held until " + Rhythm.clock(is.restUntil, z);
                    c.visible = true;
                }
                lastAnswer = Map.of("kind", answer, "key", item.key());
            }
            case "not_important" -> {
                if (gateItem) {
                    // Learning can't hold a code-rule Now or a list item: only the member edits the list.
                    throw RpcError.of("bad_request", "reason", "kind");
                }
                String cls = Learn.classOf(item);
                if (learned.stream().noneMatch(r -> r.classKey().equals(cls) && "hold".equals(r.effect()))) {
                    learned.add(new Learn.Rule("ml-" + token(), "hold", cls, item.kind(), item.scope(),
                            item.from(), now));
                }
                is.state = "rest";
                is.restUntil = next == null ? now + 2 * 60 * MINUTE : next;
                classes.merge(dk, Learn.Counts.ZERO.reject(now), (a, b) -> a.reject(now));
                if (c != null) {
                    c.afterUntil = now + Deliver.AFTER_FOR;
                    c.afterText = "Got it. " + Learn.what(item.kind(), null) + " wait for catch-ups.";
                    c.visible = true;
                }
                lastAnswer = Map.of("kind", "not_important_done", "key", item.key(), "cls", cls);
                count(now, "not_important", 1);
            }
            case "sooner", "missed" -> {
                String cls = Learn.classOf(item);
                learned.removeIf(r -> r.classKey().equals(cls) && !"not_for_this".equals(r.effect()));
                learned.add(new Learn.Rule("ml-" + token(), "sooner", cls, item.kind(), item.scope(),
                        item.from(), now));
                if ("missed".equals(answer)) {
                    store.miss(item.key(), item.kind(), now);
                    count(now, "missed", 1);
                    count(now, "missed_ruled", 1);
                }
                Focus.Person person = item.sender().person();
                if (person != null && settings.letThrough().stream().noneMatch(r -> "person".equals(r.kind())
                        && person.equals(r.person()))) {
                    String who = "person:" + Reach.personKey(item.sender().person());
                    boolean full = settings.letThrough().size() >= Reach.LIST_MAX;
                    questions.add(new Question("add_to_list", full ? "Add {who} to your list? It has 5 already."
                            : "Add {who} to your list?", full ? List.of(Deliver.choice("change", "Swap one"),
                            Deliver.choice("no", "No")) : List.of(Deliver.choice("yes", "Yes"),
                            Deliver.choice("no", "No")), who, now));
                }
                count(now, "sooner", 1);
            }
            case "undo" -> undo(now);
            case "keep" -> {
                if (c != null) {
                    c.firstRule = null;
                }
            }
            case "not_for_this" -> {
                if (sc != null && sc.rule() != null && !"code".equals(sc.rule()) && !"stuck".equals(sc.rule())) {
                    exceptions.add(sc.rule() + "|" + item.kind());
                    learned.add(new Learn.Rule("ml-" + token(), "not_for_this", sc.rule() + "|" + item.kind(),
                            item.kind(), item.scope(), item.from(), now));
                }
                if (c != null) {
                    c.firstRule = null;
                }
            }
            case "not_yet" -> {
                if (c == null || c.visible) {
                    throw RpcError.badRequest("answer");
                }
                if (!expiring(item, now)) {
                    is.afterThis = true;
                    is.state = "new";
                    card = null;
                    lastInterruptAt = 0;
                }
            }
            case "replied" -> {
                // A quick reply sent from the card, a held row or a paper: done here, a quick act for its class, and no
                // Back (the member never left what they were doing).
                if (!"message".equals(item.kind()) && !"doc".equals(item.kind())) {
                    throw RpcError.of("bad_request", "reason", "kind");
                }
                is.state = "done";
                if (now - is.deliveredAt <= 2 * MINUTE) {
                    classes.merge(dk, Learn.Counts.ZERO.act(now), (a, b) -> a.act(now));
                }
                count(now, "go", 1);
                if (c != null) {
                    card = null;
                }
            }
            case "dismiss" -> {
                if (!Attention.dismissable(item.kind())) {
                    throw RpcError.of("bad_request", "reason", "kind");
                }
                is.state = "done";
                if (now - is.deliveredAt <= 10_000L) {
                    classes.merge(dk, Learn.Counts.ZERO.reject(now), (a, b) -> a.reject(now));
                }
                if (c != null) {
                    card = null;
                }
            }
            default -> throw RpcError.badRequest("answer");
        }
        if (c != null && card != c) {
            release(c);
        }
        dirty = true;
        save(now);
    }

    /** A card gone: what rode on it stays listed in To-do. */
    private void release(Card c) {
        for (String k : c.more) {
            ItemState os = items.get(k);
            if (os != null && "carded".equals(os.state)) {
                os.state = "shown";
            }
        }
    }

    private void undo(long now) {
        if (lastAnswer == null) {
            return;
        }
        String key = String.valueOf(lastAnswer.get("key"));
        ItemState is = items.get(key);
        if (is != null) {
            is.state = "carded".equals(is.how) ? "carded" : "shown";
            is.restUntil = 0;
        }
        if ("not_important_done".equals(lastAnswer.get("kind"))) {
            Object cls = lastAnswer.get("cls");
            learned.removeIf(r -> r.classKey().equals(cls) && "hold".equals(r.effect()));
        }
        lastAnswer = null;
        if (card != null) {
            card.afterUntil = now;
        }
    }

    private void question(String qid, String answer, Object pick, long now) throws RpcError {
        Map<String, Object> q = catchup == null ? null : catchup.question();
        if (q == null || !qid.equals(q.get("questionId"))) {
            throw RpcError.notFound("question");
        }
        ZoneId z = zone.get();
        switch (qid) {
            case "keep_for_catchups" -> {
                String cls = refOf(q);
                if ("yes".equals(answer) && cls != null) {
                    String[] parts = cls.split("\\|");
                    learned.add(new Learn.Rule("ml-" + token(), "catchups", cls, parts.length > 1 ? parts[1] : "",
                            parts.length > 2 && !"-".equals(parts[2]) ? parts[2] : null, parts[0], now));
                }
            }
            case "add_to_list" -> {
                String who = refOf(q);
                if ("yes".equals(answer) && who != null && who.startsWith("person:")
                        && settings.letThrough().size() < Reach.LIST_MAX) {
                    String[] pr = who.substring(7).split(":", 2);
                    List<Reach.Rule> list = new ArrayList<>(settings.letThrough());
                    list.add(new Reach.Rule("mr-" + token(), "person", new Focus.Person(pr[0], pr[1]), null, null,
                            null, false, "correction", now));
                    settings = settings.withList(list);
                    store.putSettings(settings);
                }
            }
            case "hold_work_tonight" -> {
                if ("yes".equals(answer)) {
                    holdWorkUntil = Rhythm.nextWorkdayStart(now, z, settings);
                }
            }
            case "week_pick" -> {
                if (pick instanceof String id && id.matches("pick-[0-2]")) {
                    int n = id.charAt(5) - '0';
                    if (n < weekOffer.size()) {
                        Focus.Sphere sp = weekOffer.get(n);
                        if (week.size() >= 3) {
                            week.remove(0);
                        }
                        week.add(new Reach.Pick("mp-" + token(), sp, appWord(sp.app()) + " on "
                                + deskNames.getOrDefault(sp.deskId(), "a desk")));
                    }
                } else if ("not_now".equals(answer)) {
                    // Nothing kept close this week.
                    week.clear();
                }
            }
            case "email_me" -> emailMe = "yes".equals(answer);
            case "pace" -> {
                count(now, "pace_" + (pick instanceof String pk && pk.matches("[a-z_]{1,12}") ? pk : answer), 1);
                if ("missed".equals(answer) || "missed".equals(pick)) {
                    count(now, "missed_said", 1);
                }
            }
            case "tag_contact" -> {
                String who = refOf(q);
                if (who != null && who.startsWith("person:") && (Reach.TAGS.contains(answer)
                        || "neither".equals(answer))) {
                    tags.put(who.substring(7), answer);
                }
            }
            default -> throw RpcError.notFound("question");
        }
        catchup = new Rhythm.CatchUp(catchup.catchupId(), catchup.kind(), catchup.head(), catchup.groups(),
                catchup.lines(), null, catchup.at(), catchup.waiting(), catchup.itemKeys());
        dirty = true;
        save(now);
    }

    private String refOf(Map<String, Object> q) {
        return asked != null && asked.questionId().equals(q.get("questionId")) ? asked.ref() : null;
    }

    /** The question the catch-up on screen asks. */
    private Question asked;

    /** {@code agent.maia.reach.hold}. */
    public synchronized Map<String, Object> hold(Map<String, Object> p, long now) throws RpcError {
        load(now);
        ZoneId z = zone.get();
        if (Boolean.TRUE.equals(p.get("clear"))) {
            holdUntil = 0;
        } else if (p.get("minutes") instanceof Number m) {
            int min = m.intValue();
            if (min < 15 || min > 720 || m.doubleValue() != min) {
                throw RpcError.of("bad_request", "reason", "range", "detail", "minutes");
            }
            holdUntil = now + min * MINUTE;
        } else if ("catchup".equals(p.get("until"))) {
            Long next = Rhythm.next(now, z, settings);
            holdUntil = next == null ? now + 60 * MINUTE : next;
        } else if ("tomorrow".equals(p.get("until"))) {
            holdUntil = Rhythm.nextWorkdayStart(now, z, settings);
        } else {
            throw RpcError.badRequest("hold");
        }
        dirty = true;
        save(now);
        return holdUntil > now ? Map.of("until", holdUntil) : new LinkedHashMap<>();
    }

    /** "Holding until 11:30" for her note, or null. */
    public synchronized String holdNote(long now) {
        return holdUntil > now ? "The member asked to hold everything until " + Rhythm.clock(holdUntil, zone.get())
                + " (their list still gets through)." : null;
    }

    /** {@code agent.maia.reach.back}. */
    public synchronized void back(String cardId, boolean taken, long now) throws RpcError {
        load(now);
        if (cardId == null || !cardId.equals(backCardId) && !pickups.containsKey("pickup:" + cardId)) {
            throw RpcError.notFound("card");
        }
        if (pickups.remove("pickup:" + cardId) != null) {
            pickupAt.remove("pickup:" + cardId);
            if (Objects.equals(pickupKey, "pickup:" + cardId)) {
                pickupLine = null;
                pickupKey = null;
            }
        }
        if (cardId.equals(backCardId)) {
            count(now, taken ? "back_taken" : "back_ignored", 1);
            back = null;
            backCardId = null;
            backSnapshot = null;
            card = null;
        }
        dirty = true;
    }

    /** {@code working_on}: the member's stated task, refs picked by code from the last 2 hours. */
    public synchronized Map<String, Object> focusSet(String label, long now) throws RpcError {
        load(now);
        String l = MaiaAgent.plain(label, Reach.LABEL_MAX);
        if (l.isBlank()) {
            throw RpcError.badRequest("label");
        }
        List<Focus.Sphere> refs = Focus.recent(tracker, now, 2 * 60 * MINUTE, 3);
        task = new Reach.Task(l, refs, now);
        taskSeenAt = now;
        dirty = true;
        save(now);
        return Map.of("label", l, "refs", refs.size());
    }

    public synchronized void clearTask(long now) {
        load(now);
        task = null;
        dirty = true;
        save(now);
    }

    /** {@code agent.maia.reach.held}: "All held", newest first. */
    public synchronized List<Map<String, Object>> held(String deskId, String kind, String contactId, int limit,
            long now) {
        load(now);
        List<Map<String, Object>> out = new ArrayList<>();
        List<Reach.Item> all = new ArrayList<>(live.values());
        all.sort(Comparator.comparingLong((Reach.Item i) -> items.containsKey(i.key()) ? items.get(i.key())
                .firstSeenAt : 0).reversed());
        Reach.Context ctx = context(now);
        boolean searched = deskId != null || kind != null || contactId != null;
        for (Reach.Item i : all) {
            ItemState is = items.get(i.key());
            if (is == null || "done".equals(is.state)) {
                continue;
            }
            if (deskId != null && !deskId.equals(i.deskId()) || kind != null && !kind.equals(i.kind())
                    || contactId != null && (i.sender().person() == null
                    || !contactId.equals(i.sender().person().contactId()))) {
                continue;
            }
            if (searched && is.held(now) && is.deliveredAt == 0) {
                // Searched for before it was offered: a hint it should have come sooner.
                Rhythm.Day day = Rhythm.day(now, zone.get(), settings, holdWorkUntil);
                classes.merge(Learn.driftClass(i, day.part()), Learn.Counts.ZERO.act(now), (a, b) -> a.act(now));
                dirty = true;
            }
            Reach.Score sc = scores.get(i.key());
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("itemId", i.id());
            v.put("kind", i.kind());
            v.put("deskId", i.deskId());
            v.put("deskName", i.deskName());
            v.put("title", i.title());
            v.put("level", is.level);
            v.put("state", is.held(now) ? "held" : "shown");
            v.put("reason", sc == null ? null : Reach.why(i, sc, ctx));
            v.put("at", is.firstSeenAt);
            v.put("go", i.go());
            // A person's message: who, for the row's quick reply (the browser draws the name; ids only here).
            if ("message".equals(i.kind()) && i.sender().direct() && i.sender().person() != null) {
                v.put("who", Map.of("deskId", i.sender().person().deskId(), "contactId",
                        i.sender().person().contactId()));
            }
            out.add(v);
            if (out.size() >= Math.min(limit, HELD_LIST_MAX)) {
                break;
            }
        }
        return out;
    }

    /** {@code agent.maia.reach.set}. */
    public synchronized Reach.Settings set(Map<String, Object> p, long now) throws RpcError {
        load(now);
        settings = Reach.set(p, settings, now, () -> "mr-" + token());
        store.putSettings(settings);
        dirty = true;
        save(now);
        return settings;
    }

    /** What I've learned, in lines; names are drawn from what the room knows now (never stored). */
    public synchronized List<Map<String, Object>> learnedView(long now) {
        load(now);
        List<Map<String, Object>> out = new ArrayList<>();
        ZoneId z = zone.get();
        for (Learn.Rule r : learned) {
            String who = null;
            if (r.source() != null && r.source().startsWith("agent:")) {
                String[] p = r.source().split(":", 3);
                who = p.length > 1 ? deskNames.get(p[1]) : null;
                who = who == null ? null : "agents on " + who;
            } else if (r.source() != null && r.source().startsWith("desk:")) {
                String n = deskNames.get(r.source().substring(5));
                who = n == null ? null : n;
            } else if (r.source() != null && r.source().startsWith("contact:")) {
                who = "{who}";
            }
            Map<String, Object> v = r.view(Learn.line(r, who, z));
            if (r.source() != null && r.source().startsWith("contact:")) {
                String[] p = r.source().split(":", 3);
                if (p.length == 3) {
                    v.put("who", Map.of("deskId", p[1], "contactId", p[2]));
                }
            }
            out.add(v);
        }
        return out;
    }

    public synchronized void undoLearned(String ruleId, long now) throws RpcError {
        load(now);
        Learn.Rule r = learned.stream().filter(x -> x.ruleId().equals(ruleId)).findFirst().orElse(null);
        if (r == null) {
            throw RpcError.notFound("rule");
        }
        learned.remove(r);
        if ("not_for_this".equals(r.effect())) {
            exceptions.remove(r.classKey());
        }
        dirty = true;
        save(now);
    }

    public synchronized void resetLearned(long now) {
        load(now);
        learned.clear();
        classes.clear();
        exceptions.clear();
        dirty = true;
        save(now);
    }

    /** Counts for {@code agent.maia.reach.get}. */
    public synchronized Map<String, Object> counts(long now) {
        load(now);
        ZoneId z = zone.get();
        String today = date(now, z);
        LocalDate d = LocalDate.parse(today);
        String monday = d.minusDays(d.getDayOfWeek().getValue() - 1).toString();
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("heldToday", store.sum(today, today, "arrived"));
        v.put("deliveredToday", store.sum(today, today, "delivered"));
        v.put("missedThisWeek", store.sum(monday, today, "missed"));
        return v;
    }

    /** The interrupt-level items held while the member is away, for the bell (fixed words, no content). */
    public synchronized int awayInterrupts() {
        return awayInterrupts;
    }

    /** How many times the shield has rung the bell for items it holds (deskd's "once per rise"). */
    public synchronized int ringReach() {
        return ringReach;
    }

    /**
     * The most the shield rings the bell in a day: the Platform's own day cap for the {@code maia.away} bell (ma-platform
     * {@code NOTES_PER_DAY}), kept here too so nothing of the shield's can flood it. The scenario-day evals show why it
     * isn't lower: at 6 a must-reach message on the designer's Monday never reached her.
     */
    public static final int BELLS_PER_DAY = 12;

    private int bellsToday(long now) {
        String today = date(now, zone.get());
        return store.sum(today, today, "bell");
    }

    /**
     * {@code agent.state}'s {@code maiaAway.ring}: what deskd's bell rings for while the shield is on, so Phase 2's
     * while-away questions and the shield's delivery rules agree. {@code asks} and {@code done} are Phase 2's counts
     * (they go back to 0 when the member is back); each rise rings once unless it's quiet hours (her question and her
     * finishing aren't "any time": they wait for the return catch-up) or the day's bells are used. Counts only, never
     * content. Null while the shield is off ("Show everything as it comes"): deskd then rings as Phase 2 did.
     */
    public synchronized Map<String, Object> ring(int asks, int done, long now) {
        load(now);
        if (!ringPrimed) {
            ringPrimed = true;
            seenAsks = asks;
            seenDone = done;
        }
        if (settings.showAll()) {
            seenAsks = asks;
            seenDone = done;
            return null;
        }
        Rhythm.Day day = Rhythm.day(now, zone.get(), settings, holdWorkUntil);
        if (asks < seenAsks) {
            seenAsks = asks;
        }
        if (done < seenDone) {
            seenDone = done;
        }
        if (asks > seenAsks) {
            seenAsks = asks;
            if (!day.quiet() && bellsToday(now) < BELLS_PER_DAY) {
                ringQuestion++;
                count(now, "bell", 1);
            }
        }
        if (done > seenDone) {
            seenDone = done;
            if (!day.quiet() && bellsToday(now) < BELLS_PER_DAY) {
                ringDone++;
                count(now, "bell", 1);
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("question", ringQuestion);
        out.put("done", ringDone);
        out.put("reach", ringReach);
        return out;
    }

    public synchronized boolean emailMe() {
        return emailMe;
    }

    /** "Delete Maia Mode history": items, counts and learned rules go; the settings and list stay. */
    public synchronized void forget(long now) {
        store.forget();
        items.clear();
        learned.clear();
        classes.clear();
        exceptions.clear();
        tags.clear();
        task = null;
        week.clear();
        questions.clear();
        card = null;
        catchup = null;
        back = null;
        backCardId = null;
        pickups.clear();
        dirty = true;
        save(now);
    }

    // ---------------------------------------------------------------- keeping it

    private void load(long now) {
        if (loaded) {
            return;
        }
        loaded = true;
        settings = store.settings(now);
        Map<String, Object> s = store.state();
        if (s == null) {
            return;
        }
        if (s.get("items") instanceof Map<?, ?> m) {
            for (Map.Entry<?, ?> e : m.entrySet()) {
                if (e.getKey() instanceof String k && items.size() < ITEMS_MAX) {
                    items.put(k, ItemState.parse(k, e.getValue()));
                }
            }
        }
        if (s.get("learned") instanceof List<?> l) {
            for (Object o : l) {
                Learn.Rule r = Learn.Rule.parse(o);
                if (r != null) {
                    learned.add(r);
                    if ("not_for_this".equals(r.effect())) {
                        exceptions.add(r.classKey());
                    }
                }
            }
        }
        if (s.get("classes") instanceof Map<?, ?> m) {
            for (Map.Entry<?, ?> e : m.entrySet()) {
                if (e.getKey() instanceof String k) {
                    classes.put(k, Learn.Counts.parse(e.getValue()));
                }
            }
        }
        if (s.get("tags") instanceof Map<?, ?> m) {
            for (Map.Entry<?, ?> e : m.entrySet()) {
                if (e.getKey() instanceof String k && e.getValue() instanceof String g
                        && (Reach.TAGS.contains(g) || "neither".equals(g))) {
                    tags.put(k, g);
                }
            }
        }
        lastInterruptAt = num(s.get("lastInterruptAt"));
        lastCatchUpAt = num(s.get("lastCatchUpAt"));
        offersToday = (int) num(s.get("offersToday"));
        offersDay = str(s.get("offersDay")) == null ? "" : str(s.get("offersDay"));
        briefDay = str(s.get("briefDay")) == null ? "" : str(s.get("briefDay"));
        weekAskedDay = str(s.get("weekAskedDay")) == null ? "" : str(s.get("weekAskedDay"));
        paceAskedDay = str(s.get("paceAskedDay")) == null ? "" : str(s.get("paceAskedDay"));
        tagAskedDay = str(s.get("tagAskedDay")) == null ? "" : str(s.get("tagAskedDay"));
        holdUntil = num(s.get("holdUntil"));
        holdWorkUntil = num(s.get("holdWorkUntil"));
        askedEmail = Boolean.TRUE.equals(s.get("askedEmail"));
        emailMe = Boolean.TRUE.equals(s.get("emailMe"));
        firstUseAt = num(s.get("firstUseAt"));
        if (s.get("firstShown") instanceof List<?> l) {
            for (Object o : l) {
                if (o instanceof String r) {
                    firstShown.add(r);
                }
            }
        }
        if (s.get("task") instanceof Map<?, ?> t && t.get("label") instanceof String label) {
            task = new Reach.Task(MaiaAgent.plain(label, Reach.LABEL_MAX), spheres(t.get("refs")), num(t.get("at")));
        }
        if (s.get("week") instanceof List<?> l) {
            for (Object o : l) {
                if (o instanceof Map<?, ?> w && w.get("pickId") instanceof String id) {
                    List<Focus.Sphere> sp = spheres(List.of(w.get("ref")));
                    if (!sp.isEmpty()) {
                        week.add(new Reach.Pick(id, sp.get(0), w.get("label") instanceof String lb
                                ? MaiaAgent.plain(lb, Reach.LABEL_MAX + 20) : ""));
                    }
                }
            }
        }
    }

    private static List<Focus.Sphere> spheres(Object raw) {
        List<Focus.Sphere> out = new ArrayList<>();
        if (raw instanceof List<?> l) {
            for (Object o : l) {
                if (o instanceof Map<?, ?> m && m.get("deskId") instanceof String d && Room.deskId(d)) {
                    Focus.Ref ref = null;
                    if (m.get("item") instanceof Map<?, ?> it && it.get("kind") instanceof String k
                            && it.get("id") instanceof String id) {
                        ref = new Focus.Ref(k, id);
                    }
                    out.add(new Focus.Sphere(d, Focus.app(m.get("app")), ref));
                }
            }
        }
        return out;
    }

    private static Map<String, Object> sphereView(Focus.Sphere s) {
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("deskId", s.deskId());
        v.put("app", s.app());
        v.put("item", s.item() == null ? null : Map.of("kind", s.item().kind(), "id", s.item().id()));
        return v;
    }

    /** Writes the shield's state now (also every 10 s while it changes, and on every answer). */
    public synchronized void save(long now) {
        if (!loaded) {
            return;
        }
        Map<String, Object> s = new LinkedHashMap<>();
        Map<String, Object> is = new LinkedHashMap<>();
        for (ItemState i : items.values()) {
            is.put(i.key, i.stored());
        }
        s.put("items", is);
        s.put("learned", learned.stream().map(Learn.Rule::stored).toList());
        Map<String, Object> cl = new LinkedHashMap<>();
        for (Map.Entry<String, Learn.Counts> e : classes.entrySet()) {
            cl.put(e.getKey(), e.getValue().view());
        }
        s.put("classes", cl);
        s.put("tags", new LinkedHashMap<>(tags));
        s.put("lastInterruptAt", lastInterruptAt);
        s.put("lastCatchUpAt", lastCatchUpAt);
        s.put("offersToday", offersToday);
        s.put("offersDay", offersDay);
        s.put("briefDay", briefDay);
        s.put("weekAskedDay", weekAskedDay);
        s.put("paceAskedDay", paceAskedDay);
        s.put("tagAskedDay", tagAskedDay);
        s.put("holdUntil", holdUntil);
        s.put("holdWorkUntil", holdWorkUntil);
        s.put("askedEmail", askedEmail);
        s.put("emailMe", emailMe);
        if (firstUseAt == 0) {
            firstUseAt = now;
        }
        s.put("firstUseAt", firstUseAt);
        s.put("firstShown", new ArrayList<>(firstShown));
        if (task != null) {
            Map<String, Object> t = new LinkedHashMap<>();
            t.put("label", task.label());
            t.put("refs", task.refs().stream().map(Shield::sphereView).toList());
            t.put("at", task.setAt());
            s.put("task", t);
        }
        List<Map<String, Object>> w = new ArrayList<>();
        for (Reach.Pick p : week) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("pickId", p.pickId());
            m.put("ref", sphereView(p.ref()));
            m.put("label", p.label());
            w.add(m);
        }
        s.put("week", w);
        store.putState(s);
        dirty = false;
        savedAt = now;
    }

    private void count(long now, String name, int n) {
        if (n != 0) {
            store.count(date(now, zone.get()), name, n);
        }
    }

    static String date(long at, ZoneId z) {
        return Instant.ofEpochMilli(at).atZone(z).toLocalDate().toString();
    }

    private static String token() {
        String alphabet = "abcdefghijklmnopqrstuvwxyz234567";
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < 12; i++) {
            b.append(alphabet.charAt(RANDOM.nextInt(32)));
        }
        return b.toString();
    }

    private static String str(Object o) {
        return o instanceof String s ? s : null;
    }

    private static long num(Object o) {
        return o instanceof Number n ? n.longValue() : 0;
    }
}
