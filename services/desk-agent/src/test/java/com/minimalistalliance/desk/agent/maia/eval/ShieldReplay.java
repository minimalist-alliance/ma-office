package com.minimalistalliance.desk.agent.maia.eval;

import com.minimalistalliance.desk.agent.maia.Attention;
import com.minimalistalliance.desk.agent.maia.Focus;
import com.minimalistalliance.desk.agent.maia.Reach;
import com.minimalistalliance.desk.agent.maia.ReachItems;
import com.minimalistalliance.desk.agent.maia.Shield;
import com.minimalistalliance.desk.agent.maia.eval.ShieldScenarios.Block;
import com.minimalistalliance.desk.agent.maia.eval.ShieldScenarios.Day;
import com.minimalistalliance.desk.agent.maia.eval.ShieldScenarios.In;
import com.minimalistalliance.desk.agent.service.RpcError;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * Replays one scenario day against the real code with a virtual clock (the shield concept §13.1): every 15 s the office's
 * focus block goes to {@link Shield#observe} and the items of the moment, made by the real {@link Attention#items} and
 * {@link ReachItems#all}, go to {@link Shield#update}. A scripted member answers cards and catch-ups by fixed rules. The
 * result is the delivery log the rubric scores. Four arms (§13.4): A everything at once, B today's list as built
 * (room-only, the 30-minute batch), C the shield with a 30-minute batch in place of catch-ups, D the shield's default.
 * No model, no credits.
 */
public final class ShieldReplay {

    public enum Arm { A, B, C, D }

    static final long TICK = 15_000L;
    /** Debugging: "HH:MM-HH:MM" prints every delivery and the line in that window (ShieldTraceTest). */
    static String TRACE = null;
    static final long MIN = 60_000L;

    private ShieldReplay() {}

    /** A 26-character Courier-style id from a seed, deterministic. */
    public static String ulid(String seed) {
        try {
            byte[] h = MessageDigest.getInstance("SHA-256").digest(seed.getBytes(StandardCharsets.UTF_8));
            String a = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
            StringBuilder b = new StringBuilder("01J");
            for (int i = 0; b.length() < 26; i++) {
                b.append(a.charAt((h[i] & 0xff) % 32));
            }
            return b.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    static boolean coin(String seed, int percent) {
        return Math.floorMod(seed.hashCode(), 100) < percent;
    }

    /** What happened, for the rubric. */
    public static final class Log {
        public final Day day;
        public final Arm arm;
        /** First time each item reached the member, and how ({@code interrupt}, {@code offer}, {@code catchup}, …). */
        public final Map<String, Long> reached = new HashMap<>();
        public final Map<String, String> how = new HashMap<>();
        /** Every visual event: a card or a catch-up panel, with the member's true state then. */
        public final List<Visual> visuals = new ArrayList<>();
        public final List<Map<String, Object>> cards = new ArrayList<>();
        public final List<Map<String, Object>> catchups = new ArrayList<>();
        public final List<Long> catchupAt = new ArrayList<>();
        public int headsUps;
        public int interruptsTaken;
        public int backsOffered;
        public int backsGood;
        public int pickupsShown;
        public final Map<String, Integer> pickupSeen = new HashMap<>();
        public long presentMs;
        public boolean lineAlways = true;
        public int emptyCatchups;
        public final List<String> violations = new ArrayList<>();
        /** Wednesday's check: cards for a class the member said Not important to on Tuesday. */
        public int cardsForHeldClass;
        public final Map<String, List<Long>> latencyByClass = new HashMap<>();
        /** Every bell: {@code [at, 1 when an approval (rung by its own desk's deskd), else 0]}. */
        public final List<long[]> bells = new ArrayList<>();

        Log(Day day, Arm arm) {
            this.day = day;
            this.arm = arm;
        }
    }

    /** One visual event and the member's true state at that moment. */
    public record Visual(String what, String itemKey, long at, boolean typing, boolean call, boolean settling,
            boolean atBreak, boolean expiring, boolean headsUp, String level) {}

    /** The world while a day plays: what has arrived and not gone. */
    static final class World {
        final Day day;
        final Map<String, In> active = new LinkedHashMap<>();
        final Set<String> gone = new HashSet<>();
        final Map<String, Long> resultAt = new HashMap<>();
        Log log;

        World(Day day) {
            this.day = day;
        }

        String channel(In i) {
            return i.channel() != null ? ulid("ch-" + i.channel()) : ulid("ch-" + i.desk() + i.who());
        }

        /** The shield's key an item of the day shows under. */
        String key(In i, long now) {
            return switch (i.type()) {
                case "approval" -> "approval:" + i.desk();
                case "limit" -> "limit:" + i.desk();
                case "failed" -> "desk_failed:" + i.desk();
                case "due" -> i.until() - 30 * MIN - now <= 2 * 60 * MIN ? "todos_due:" + i.desk()
                        : "todo:" + i.desk() + ":" + i.todo();
                case "todo_new" -> "todos:" + i.desk();
                case "result" -> "result:" + i.desk();
                case "message" -> "message:" + i.desk() + ":" + channel(i);
                case "doc" -> "doc:" + i.desk() + ":" + i.id();
                default -> "notes";
            };
        }

        List<Attention.Desk> desks(long now) {
            List<Attention.Desk> out = new ArrayList<>();
            for (String d : List.of(ShieldScenarios.WORK, ShieldScenarios.HOME)) {
                List<Attention.Approval> aps = new ArrayList<>();
                List<Attention.Stopped> stopped = new ArrayList<>();
                List<Attention.DueSoon> due = new ArrayList<>();
                int todos = 0;
                String state = "running";
                for (In i : active.values()) {
                    if (!d.equals(i.desk())) {
                        continue;
                    }
                    switch (i.type()) {
                        case "approval" -> aps.add(new Attention.Approval(i.id(), "ag-scout", i.until()));
                        case "limit" -> stopped.add(new Attention.Stopped("ag-scout", "m-" + i.id(), "limit_reached",
                                i.at()));
                        case "failed" -> state = "failed";
                        case "due" -> due.add(new Attention.DueSoon(i.todo(), "A to-do", i.until() - 30 * MIN));
                        case "todo_new" -> todos++;
                        default -> {
                            // Others come as extras or results.
                        }
                    }
                }
                out.add(new Attention.Desk(d, d.equals(ShieldScenarios.WORK) ? "Work" : "Personal",
                        d.equals(ShieldScenarios.WORK) ? "work" : "personal", state, true,
                        List.of(new Attention.Agent("ag-scout", "Scout", "working", null, aps.size())), aps, stopped,
                        todos, due));
            }
            return out;
        }

        List<Attention.Result> results() {
            List<Attention.Result> out = new ArrayList<>();
            for (In i : active.values()) {
                if ("result".equals(i.type())) {
                    out.add(new Attention.Result("m-" + i.id(), i.desk(), i.desk().equals(ShieldScenarios.WORK)
                            ? "Work" : "Personal", i.who(), i.at(), i.status()));
                }
            }
            return out;
        }

        int notes() {
            return (int) active.values().stream().filter(i -> "notes".equals(i.type())).count() * 4;
        }

        /**
         * Each desk's {@code courier} and {@code docs} as the office sends them in {@code agent.maia.observe} (deskd's
         * {@code courier.attention} and `desks[].docs`'s shape), read by the desk's own parser: the wire path, not
         * hand-made records.
         */
        Map<String, ReachItems.Extras> extras(long now) {
            Map<String, List<Map<String, Object>>> threads = new HashMap<>();
            Map<String, Integer> unread = new HashMap<>();
            Map<String, In> firstOf = new LinkedHashMap<>();
            Map<String, List<Map<String, Object>>> docs = new HashMap<>();
            for (In i : active.values()) {
                if ("message".equals(i.type())) {
                    String k = i.desk() + "|" + channel(i);
                    unread.merge(k, 1, Integer::sum);
                    firstOf.putIfAbsent(k, i);
                } else if ("doc".equals(i.type())) {
                    Map<String, Object> d = new LinkedHashMap<>();
                    d.put("docId", i.id());
                    d.put("place", i.place());
                    if (i.who() != null) {
                        d.put("contactIds", List.of(ulid(i.who())));
                    }
                    if (i.todo() != null) {
                        d.put("todoId", i.todo());
                    }
                    d.put("at", i.at());
                    docs.computeIfAbsent(i.desk(), x -> new ArrayList<>()).add(d);
                }
            }
            for (Map.Entry<String, In> e : firstOf.entrySet()) {
                In i = e.getValue();
                Long wrote = i.direct() ? ("they_wrote_last_yesterday".equals(i.status()) ? i.at() - 26 * 60 * MIN
                        : i.at()) : null;
                Map<String, Object> t = new LinkedHashMap<>();
                t.put("channelId", channel(i));
                t.put("kind", i.direct() ? "direct" : "group");
                t.put("contactIds", List.of(ulid(i.who())));
                t.put("known", i.known());
                t.put("confirmed", i.confirmed());
                t.put("bulk", i.bulk());
                t.put("theyWroteLastAt", wrote);
                t.put("replyBand", i.band());
                t.put("unread", unread.get(e.getKey()));
                t.put("newestAt", i.at());
                threads.computeIfAbsent(i.desk(), x -> new ArrayList<>()).add(t);
            }
            Map<String, ReachItems.Extras> out = new HashMap<>();
            for (String d : List.of(ShieldScenarios.WORK, ShieldScenarios.HOME)) {
                out.put(d, ReachItems.parse(d, Map.of("threads", threads.getOrDefault(d, List.of())),
                        docs.getOrDefault(d, List.of())));
            }
            return out;
        }
    }

    /** The member's true state at a moment of the day: present, on a call, typing, idle, settling into focus. */
    record Truth(boolean present, boolean typing, boolean call, boolean idle, Block block, boolean phone) {}

    static Truth truth(Day day, long t, List<long[]> extraOpen) {
        for (long[] a : day.away()) {
            if (t >= a[0] && t < a[1]) {
                for (long[] o : extraOpen) {
                    if (t >= o[0] && t < o[1]) {
                        return new Truth(true, false, false, false, null, true);
                    }
                }
                return new Truth(false, false, false, false, null, false);
            }
        }
        Block b = ShieldScenarios.blockAt(day.blocks(), t);
        if (b == null) {
            for (long[] o : extraOpen) {
                if (t >= o[0] && t < o[1]) {
                    return new Truth(true, false, false, false, null, true);
                }
            }
            return new Truth(false, false, false, false, null, false);
        }
        if ("phone".equals(b.surface())) {
            return new Truth(true, false, false, false, b, true);
        }
        long m = (t - b.from()) / MIN;
        boolean call = "call".equals(b.mode()) && t - b.from() < 30 * MIN;
        boolean idle = "idle".equals(b.mode()) && t - b.from() >= 2 * MIN;
        long inCycle = (t - b.from()) % (5 * MIN);
        boolean typing = "work".equals(b.mode()) && inCycle < 3 * MIN + 20_000L && !call;
        return new Truth(true, typing, call, idle, b, false);
    }

    /** The office's focus block for the member's true state (none when the office is closed). */
    static Map<String, Object> focus(Day day, Truth tr, long t, List<Map<String, Object>> events) {
        Map<String, Object> f = new LinkedHashMap<>();
        Block b = tr.block();
        f.put("surface", tr.phone() ? "phone" : "desk");
        if (b != null && !tr.phone()) {
            f.put("deskId", b.desk());
            f.put("scope", "all");
            f.put("app", b.app());
            if (b.itemKind() != null) {
                f.put("item", Map.of("kind", b.itemKind(), "id", b.itemId()));
            }
            List<Map<String, Object>> people = new ArrayList<>();
            for (String p : b.people()) {
                people.add(Map.of("deskId", b.desk(), "contactId", ulid(p)));
            }
            f.put("people", people);
        } else {
            f.put("scope", "all");
            f.put("app", "maia");
        }
        f.put("input", Map.of("typing", tr.typing(), "idle", tr.idle(), "lastAt", t));
        // Tuesday's calls are screen shares (the Privacy shield, a presentation): the same "do not disturb" to the shield.
        f.put("call", tr.call() && day.index() != 1);
        f.put("share", tr.call() && day.index() == 1);
        f.put("visible", true);
        f.put("device", tr.phone() ? "dv-phone00001" : "dv-office0001");
        if (!events.isEmpty()) {
            f.put("events", events);
        }
        return f;
    }

    /** One persona's three days in a row against one arm (Tuesday's corrections carry into Wednesday). */
    public static List<Log> runPersona(List<Day> days, Arm arm) {
        Reach.Settings s0 = days.get(0).settings();
        Reach.Settings s = arm == Arm.C ? halfHourly(s0) : s0;
        Shield.Memory store = new Shield.Memory(s);
        List<Log> out = new ArrayList<>();
        Map<String, List<Long>> mondayLatency = null;
        for (Day d : days) {
            Shield shield = new Shield(store, () -> ShieldScenarios.ZONE);
            Log log = run(d, arm, shield);
            if (d.index() == 0) {
                mondayLatency = log.latencyByClass;
            }
            out.add(log);
        }
        return out;
    }

    /** The shield's settings with a 30-minute batch in place of catch-ups (arm C). */
    static Reach.Settings halfHourly(Reach.Settings s) {
        List<LocalTime> t = new ArrayList<>();
        for (LocalTime x = LocalTime.of(9, 0); !x.isAfter(LocalTime.of(17, 0)); x = x.plusMinutes(30)) {
            t.add(x);
        }
        return new Reach.Settings(s.letThrough(), s.holdAll(), t, s.focusHours(), s.quietHours(), s.evenings(),
                s.detail(), s.showAll());
    }

    @SuppressWarnings("unchecked")
    static Log run(Day day, Arm arm, Shield shield) {
        Log log = new Log(day, arm);
        World w = new World(day);
        w.log = log;
        int next = 0;
        List<In> incoming = day.incoming();
        TreeMap<Long, List<Runnable>> actions = new TreeMap<>();
        List<Map<String, Object>> pendingEvents = new ArrayList<>();
        List<long[]> extraOpen = new ArrayList<>();
        Map<String, Long> deliveredKeys = new HashMap<>();
        String lastCardId = null;
        String lastCatchupId = null;
        String lastBackCard = null;
        Set<String> corrected = new HashSet<>();
        Set<String> heldClasses = new HashSet<>();
        for (ShieldScenarios.Correction c : day.corrections()) {
            if ("not_important".equals(c.answer()) && day.index() == 2) {
                heldClasses.add(c.cls());
            }
        }
        // Attention's own state for arm B.
        Set<String> bShown = new HashSet<>();
        Map<String, Long> bFirst = new HashMap<>();
        long bLastNotice = 0;
        long bLastBatch = 0;
        long lastInterrupt = 0;
        boolean holding = false;
        if (arm == Arm.C || arm == Arm.D) {
            for (String c : day.clients()) {
                shield.tag(new Focus.Person(ShieldScenarios.WORK, ulid(c)), "clients");
            }
            for (String f : day.family()) {
                shield.tag(new Focus.Person(ShieldScenarios.HOME, ulid(f)), "family");
            }
        }
        for (long t = day.start(); t <= day.end(); t += TICK) {
            final long now = t;
            // Items arrive.
            while (next < incoming.size() && incoming.get(next).at() <= t) {
                In i = incoming.get(next++);
                if (!w.gone.contains(i.id())) {
                    w.active.put(i.id(), i);
                }
                if (arm == Arm.A) {
                    Truth tr = truth(day, t, extraOpen);
                    reach(log, i.id(), t, "interrupt");
                    log.visuals.add(new Visual("interrupt", w.key(i, t), t, tr.typing(), tr.call(), false, false,
                            false, false, "interrupt"));
                }
            }
            // Items go by themselves (an approval's expiry, a to-do's due time).
            for (var it = w.active.values().iterator(); it.hasNext();) {
                In i = it.next();
                if (i.until() > 0 && t >= i.until()) {
                    it.remove();
                    w.gone.add(i.id());
                }
            }
            // The scripted member's actions due now.
            while (!actions.isEmpty() && actions.firstKey() <= t) {
                for (Runnable r : actions.pollFirstEntry().getValue()) {
                    r.run();
                }
            }
            Truth tr = truth(day, t, extraOpen);
            if (tr.present()) {
                log.presentMs += TICK;
            }
            // The office's events: the end of a typing burst, 5 s later, is a completed action.
            Block b = tr.block();
            if (b != null && "work".equals(b.mode()) && !tr.phone()) {
                long inCycle = (t - b.from()) % (5 * MIN);
                if (inCycle >= 3 * MIN + 20_000L && inCycle < 3 * MIN + 20_000L + TICK) {
                    String kind = switch (b.app()) {
                        case "courier", "agent" -> "sent";
                        case "todo" -> "todo_checked";
                        default -> "saved";
                    };
                    pendingEvents.add(Map.of("kind", kind, "at", t - 15_000L));
                }
            }
            for (long[] h : day.holds()) {
                if (!holding && t >= h[0] && t < h[1] && (arm == Arm.C || arm == Arm.D)) {
                    holding = true;
                    try {
                        shield.hold(Map.of("minutes", (int) ((h[1] - h[0]) / MIN)), t);
                    } catch (RpcError e) {
                        throw new IllegalStateException(e);
                    }
                }
            }
            List<Attention.Desk> desks = w.desks(t);
            Attention.Input in = new Attention.Input(t, Attention.Settings.DEFAULT, desks, true, false, 0, null,
                    w.notes(), 0, 0, 0, w.results(), Map.of(), bShown, bLastNotice, bLastBatch, false);
            List<Attention.Item> listItems = Attention.items(in, new HashMap<>(bFirst));
            if (arm == Arm.B) {
                // Today's list as built: the room's notice for a new Now, the 30-minute batch for the rest.
                Attention.Output o = Attention.build(in, bFirst);
                bShown.clear();
                bShown.addAll(o.shown());
                if (o.batchReleased()) {
                    bLastBatch = t;
                }
                if (o.noticeItemId() != null) {
                    bLastNotice = t;
                    for (Attention.Item item : o.visible()) {
                        if (item.id().equals(o.noticeItemId())) {
                            reachKey(log, w, item.key(), t, "interrupt");
                            log.visuals.add(new Visual("interrupt", item.key(), t, tr.typing(), tr.call(), false,
                                    false, false, false, "interrupt"));
                        }
                    }
                }
                for (Attention.Item item : o.visible()) {
                    if (tr.present()) {
                        reachKey(log, w, item.key(), t, "list");
                    }
                }
                continue;
            }
            if (arm == Arm.A) {
                continue;
            }
            // Arms C and D: the shield.
            if (tr.present()) {
                shield.observe(Focus.parse(focus(day, tr, t, pendingEvents), t), t);
                pendingEvents.clear();
            }
            List<Reach.Item> items = ReachItems.all(listItems, desks, w.extras(t), statusByDesk(w), t,
                    ShieldScenarios.ZONE);
            Shield.Output o = shield.update(t, items, Map.of(ShieldScenarios.WORK, "work", ShieldScenarios.HOME,
                    "personal"), Map.of(ShieldScenarios.WORK, "Work", ShieldScenarios.HOME, "Personal"));
            Map<String, Object> view = o.view();
            if (TRACE != null && !TRACE.isEmpty() && d0(day, t)) {
                String[] w2 = TRACE.split("-");
                String c = clock(t);
                String lt = String.valueOf(((Map<String, Object>) view.get("line")).get("text"));
                boolean changed = !lt.equals(traceLine) || !o.deliveries().isEmpty();
                traceLine = lt;
                if (changed && c.compareTo(w2[0]) >= 0 && c.compareTo(w2[1]) <= 0) {
                    System.out.println("TRACE " + c + " typing=" + tr.typing() + " call=" + tr.call() + " block="
                            + (tr.block() == null ? null : tr.block().id() + "/" + tr.block().mode() + "/"
                            + tr.block().app()) + " line=" + ((Map<String, Object>) view.get("line")).get("text")
                            + " card=" + (view.get("card") == null ? null : ((Map<String, Object>) view.get("card"))
                            .get("kind")) + " deliveries=" + o.deliveries() + " items=" + items.stream()
                            .map(x -> x.key().substring(0, Math.min(14, x.key().length()))).toList());
                }
            }
            if (o.on() && view.get("line") == null) {
                log.lineAlways = false;
            }
            for (Shield.Delivery dv : o.deliveries()) {
                switch (dv.what()) {
                    case "heads_up" -> log.headsUps++;
                    case "interrupt", "offer" -> {
                        reachKey(log, w, dv.itemKey(), t, dv.what());
                        boolean exp = expiring(w, dv.itemKey(), t);
                        log.visuals.add(new Visual(dv.what(), dv.itemKey(), t, tr.typing(), tr.call(),
                                settling(day, t), dv.atBreak(), exp, false, dv.level()));
                        if (dv.what().equals("interrupt")) {
                            if (lastInterrupt > 0 && t - lastInterrupt < 15 * MIN && !exp) {
                                log.violations.add("interrupt within 15 min at " + clock(t));
                            }
                            lastInterrupt = t;
                        }
                        if (day.index() == 2 && heldClasses.contains(clsOf(w, dv.itemKey(), t))) {
                            log.cardsForHeldClass++;
                        }
                    }
                    case "catchup_item", "seen" -> reachKey(log, w, dv.itemKey(), t, dv.what().equals("seen")
                            ? "seen" : "catchup");
                    case "interrupt_more" -> reachKey(log, w, dv.itemKey(), t, "interrupt");
                    case "bell" -> {
                        log.bells.add(new long[] {t, "approval".equals(dv.kind()) ? 1 : 0});
                        reachKey(log, w, dv.itemKey(), t, "bell");
                        // The member opens their phone a few minutes after the bell.
                        extraOpen.add(new long[] {t + 3 * MIN, t + 8 * MIN});
                    }
                    case "brief", "catchup", "return" -> {
                        log.catchupAt.add(t);
                        log.visuals.add(new Visual("catchup", null, t, tr.typing(), tr.call(), settling(day, t), true,
                                false, false, "catchup"));
                    }
                    default -> {
                        // missed, catchup_ready: in the line only.
                    }
                }
            }
            // A new heads-up line: mark the next interrupt as announced.
            Map<String, Object> line = (Map<String, Object>) view.get("line");
            if (line != null && "heads_up".equals(line.get("kind")) && !log.visuals.isEmpty()) {
                // counted above with headsUps
            }
            Map<String, Object> card = (Map<String, Object>) view.get("card");
            if (card != null && !card.get("cardId").equals(lastCardId) && card.get("after") == null) {
                lastCardId = (String) card.get("cardId");
                log.cards.add(card);
                answerCard(day, w, shield, card, t, tr, actions, pendingEvents, log, corrected);
            }
            Map<String, Object> cu = (Map<String, Object>) view.get("catchup");
            if (cu != null && !cu.get("catchupId").equals(lastCatchupId)) {
                lastCatchupId = (String) cu.get("catchupId");
                if (Boolean.TRUE.equals(cu.get("waiting"))) {
                    // The line says it's ready: the member taps it a couple of minutes later.
                    String id = lastCatchupId;
                    at(actions, t + 2 * MIN, () -> {
                        try {
                            shield.answer(Map.of("catchupId", id, "answer", "open"), now + 2 * MIN);
                        } catch (RpcError e) {
                            // Replaced meanwhile.
                        }
                    });
                } else {
                    log.catchups.add(cu);
                    answerCatchup(day, w, shield, cu, t, actions, log, corrected);
                }
            }
            Map<String, Object> back = (Map<String, Object>) view.get("back");
            if (back != null && !back.get("cardId").equals(lastBackCard)) {
                lastBackCard = (String) back.get("cardId");
                log.backsOffered++;
                if (String.valueOf(back.get("resume")).startsWith("You were ")) {
                    log.backsGood++;
                }
                String cid = lastBackCard;
                if (coin(cid, 70)) {
                    at(actions, t + 10_000L, () -> {
                        try {
                            shield.back(cid, true, now + 10_000L);
                        } catch (RpcError e) {
                            // Gone.
                        }
                    });
                }
            }
            if (line != null && "pickup".equals(line.get("kind"))) {
                String text = String.valueOf(line.get("text"));
                log.pickupSeen.merge(text + "@" + ((Map<String, Object>) line.get("action")).get("itemId"), 1,
                        Integer::sum);
            }
            // Tuesday's corrections on items present now, as the member would from a catch-up or All held.
            if (day.index() == 1) {
                for (ShieldScenarios.Correction c : day.corrections()) {
                    if (corrected.contains(c.cls())) {
                        continue;
                    }
                    for (In i : w.active.values()) {
                        if (c.cls().equals(i.cls())) {
                            try {
                                shield.answer(Map.of("itemId", Attention.id(w.key(i, t)), "answer", c.answer()), t);
                                corrected.add(c.cls());
                            } catch (RpcError e) {
                                // Not live yet.
                            }
                            break;
                        }
                    }
                }
            }
        }
        // Latency by class, for the learning check.
        for (In i : incoming) {
            Long r = log.reached.get(i.id());
            if (r != null) {
                log.latencyByClass.computeIfAbsent(i.cls(), k -> new ArrayList<>()).add(r - i.at());
            }
        }
        for (Map.Entry<String, Integer> e : log.pickupSeen.entrySet()) {
            log.pickupsShown++;
        }
        return log;
    }

    static Map<String, String> statusByDesk(World w) {
        Map<String, String> m = new HashMap<>();
        for (In i : w.active.values()) {
            if ("result".equals(i.type()) && i.status() != null && !"done".equals(i.status())) {
                m.put(i.desk(), i.status());
            }
        }
        return m;
    }

    static int TRACE_DAY = -1;
    static String traceLine = "";

    static boolean d0(Day day, long t) {
        return TRACE_DAY < 0 || day.index() == TRACE_DAY;
    }

    static boolean expiring(World w, String key, long t) {
        for (In i : w.active.values()) {
            if (w.key(i, t).equals(key) && i.until() > 0 && i.until() - t <= 10 * MIN && !"due".equals(i.type())) {
                return true;
            }
        }
        return false;
    }

    static String clsOf(World w, String key, long t) {
        for (In i : w.active.values()) {
            if (w.key(i, t).equals(key)) {
                return i.cls();
            }
        }
        return "";
    }

    /** In the first 10 minutes of a hold or a focus stretch (no visual event allowed then). */
    static boolean settling(Day day, long t) {
        for (long[] h : day.holds()) {
            if (t >= h[0] && t < h[0] + 10 * MIN) {
                return true;
            }
        }
        for (Reach.Span s : day.settings().focusHours()) {
            long from = ShieldScenarios.at(day.date(), s.from().getHour(), s.from().getMinute());
            long start = Math.max(from, firstPresence(day));
            if (t >= start && t < start + 10 * MIN) {
                return true;
            }
        }
        return false;
    }

    static long firstPresence(Day day) {
        return day.blocks().isEmpty() ? day.start() : day.blocks().get(0).from();
    }

    static void reach(Log log, String inId, long t, String how) {
        if (!log.reached.containsKey(inId)) {
            log.reached.put(inId, t);
            log.how.put(inId, how);
        }
    }

    static void reachKey(Log log, World w, String key, long t, String how) {
        if (key == null) {
            return;
        }
        for (In i : w.active.values()) {
            if (w.key(i, t).equals(key)) {
                reach(log, i.id(), t, how);
            }
        }
    }

    static void at(TreeMap<Long, List<Runnable>> actions, long t, Runnable r) {
        actions.computeIfAbsent(t, k -> new ArrayList<>()).add(r);
    }

    /** Resolve every item under a key: the member did the thing (an approval decided, a reply sent). */
    static void resolve(World w, String key, long t) {
        for (var it = w.active.values().iterator(); it.hasNext();) {
            In i = it.next();
            if (w.key(i, t).equals(key) && !"notes".equals(i.type()) && !"doc".equals(i.type())
                    || w.key(i, t).equals(key) && "doc".equals(i.type()) && !"records".equals(i.place())) {
                it.remove();
                w.gone.add(i.id());
                // Acting on the item (the desk's approval cards, the thread) shows the member everything under it.
                if (w.log != null) {
                    reach(w.log, i.id(), t, "acted");
                }
            }
        }
    }

    @SuppressWarnings("unchecked")
    static void answerCard(Day day, World w, Shield shield, Map<String, Object> card, long t, Truth tr,
            TreeMap<Long, List<Runnable>> actions, List<Map<String, Object>> events, Log log, Set<String> corrected) {
        String cardId = (String) card.get("cardId");
        String level = (String) card.get("level");
        String key = keyOf(w, (String) card.get("itemId"), t);
        boolean related = false;
        for (In i : w.active.values()) {
            if (w.key(i, t).equals(key) && i.label().related() != null && tr.block() != null
                    && i.label().related().equals(tr.block().id())) {
                related = true;
            }
        }
        String kind = (String) card.get("kind");
        // The member takes interrupts, offers that go with what they're on, and offers of things that need them.
        boolean actionable = java.util.Set.of("approval", "todos", "todo", "limit").contains(kind)
                && coin(cardId, 80);
        if ("interrupt".equals(level) || related || actionable) {
            log.interruptsTaken += "interrupt".equals(level) ? 1 : 0;
            at(actions, t + 10_000L, () -> {
                try {
                    shield.answer(Map.of("cardId", cardId, "answer", "go"), t + 10_000L);
                } catch (RpcError e) {
                    return;
                }
                // Whatever rode on the card, the member handles too.
                for (Map<String, Object> m : (List<Map<String, Object>>) card.getOrDefault("more", List.of())) {
                    String k2 = keyOf(w, (String) m.get("itemId"), t);
                    if (k2 != null) {
                        at(actions, t + 100_000L, () -> resolve(w, k2, t + 100_000L));
                    }
                }
                at(actions, t + 70_000L, () -> {
                    resolve(w, key, t + 70_000L);
                    events.add(Map.of("kind", "approval".equals(kind) ? "approval_decided" : "todos".equals(kind)
                            || "todo".equals(kind) ? "todo_checked" : "sent", "at", t + 70_000L));
                });
            });
        } else if (coin(cardId, 50) && ((List<Map<String, Object>>) card.get("choices")).stream()
                .anyMatch(c -> "not_now".equals(c.get("id")))) {
            at(actions, t + 5_000L, () -> {
                try {
                    shield.answer(Map.of("cardId", cardId, "answer", "not_now"), t + 5_000L);
                } catch (RpcError e) {
                    // Tucked meanwhile.
                }
            });
        }
    }

    @SuppressWarnings("unchecked")
    static void answerCatchup(Day day, World w, Shield shield, Map<String, Object> cu, long t,
            TreeMap<Long, List<Runnable>> actions, Log log, Set<String> corrected) {
        String id = (String) cu.get("catchupId");
        int lines = 0;
        boolean any = false;
        for (Map<String, Object> g : (List<Map<String, Object>>) cu.get("groups")) {
            List<Map<String, Object>> items = (List<Map<String, Object>>) g.get("items");
            lines += items.size() + (g.get("summary") == null ? 0 : 1);
            any = true;
            if ("needs_you".equals(g.get("id"))) {
                int n = 0;
                for (Map<String, Object> item : items) {
                    String key = keyOf(w, (String) item.get("itemId"), t);
                    if (key != null && coin(key + day.index(), 60)) {
                        long when = t + (2 + n++ * 2) * MIN;
                        at(actions, when, () -> resolve(w, key, when));
                    }
                }
            }
        }
        if (!any && cu.get("question") == null && ((List<?>) cu.get("lines")).isEmpty()) {
            log.emptyCatchups++;
        }
        if (lines > 7) {
            log.violations.add("catch-up of " + lines + " lines");
        }
        Map<String, Object> q = (Map<String, Object>) cu.get("question");
        if (q != null) {
            String qid = (String) q.get("questionId");
            String answer = switch (qid) {
                case "keep_for_catchups", "add_to_list" -> "yes";
                case "hold_work_tonight" -> "not_today";
                case "pace" -> "ok";
                case "tag_contact" -> "neither";
                default -> "no";
            };
            at(actions, t + 30_000L, () -> {
                try {
                    shield.answer(Map.of("catchupId", id, "questionId", qid, "answer", answer), t + 30_000L);
                } catch (RpcError e) {
                    // Replaced meanwhile.
                }
            });
        }
        at(actions, t + 90_000L, () -> {
            try {
                shield.answer(Map.of("catchupId", id, "answer", "dismiss"), t + 90_000L);
            } catch (RpcError e) {
                // Replaced meanwhile.
            }
        });
    }

    static String keyOf(World w, String itemId, long t) {
        for (In i : w.active.values()) {
            String k = w.key(i, t);
            if (Attention.id(k).equals(itemId)) {
                return k;
            }
        }
        return null;
    }

    static String clock(long t) {
        return java.time.Instant.ofEpochMilli(t).atZone(ShieldScenarios.ZONE).toLocalTime().toString();
    }
}
