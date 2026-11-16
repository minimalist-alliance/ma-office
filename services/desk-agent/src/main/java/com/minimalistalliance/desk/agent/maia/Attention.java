package com.minimalistalliance.desk.agent.maia;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * The attention rules, in code and never in the model (the concept's §3, "She guards your attention"; {@code API.md}
 * §23, topic {@code agent.maia}): what goes on the member's To-do short list in Maia Mode, how urgent each item is,
 * what waits, and when she may interrupt.
 *
 * <ul>
 *   <li>At most {@code visible} items (3), and at most one {@code now}. A second Now waits as Next and takes the Now
 *       place when the first resolves; anything past {@code visible} waits under Later.
 *   <li><b>Urgent only by the fixed rules:</b> an approval that expires within 60 minutes, a task stopped by a limit, a
 *       desk that failed, Maia's credits at 80% of the day cap the member set on her (none by default), and a to-do due
 *       within 2 hours, read from its due time. Never
 *       from text on a desk, and never from her: she has no tool that makes, raises or hides an item.
 *   <li>Items of one desk and kind merge, with a count. An item resolved anywhere leaves at the next observe.
 *   <li>New Next items are held and come together at the batch ({@code batchEveryMin}) or when the member is back; new
 *       Now items come at once. While the member types, nothing new comes ({@code quietWhileTyping}).
 *   <li>An interrupt (the room's {@code notice}) at most once every {@code interruptEveryMin}, only for a new Now, never
 *       while the member types, and never with a sound: there is no sound in the room at all.
 *   <li>Words come from the templates here. A desk's text (an agent's or desk's name, a to-do's title) is plain text cut
 *       to 60 characters ({@link MaiaAgent#plain}).
 * </ul>
 * This class is a pure function of its {@link Input}: {@link Room} keeps the state across calls (what was shown, when
 * the last notice and batch were) and passes it in.
 */
public final class Attention {

    public static final long MINUTE = 60_000L;
    /** An approval this close to expiring is Now. */
    static final long APPROVAL_NOW = 60 * MINUTE;
    /** "Expires in …" under this. */
    static final long APPROVAL_SHOW_EXPIRY = 6 * 60 * MINUTE;
    /** A to-do due this soon is Now. */
    static final long TODO_NOW = 2 * 60 * MINUTE;
    /** Her credits at this share of the member's own day cap on her is Now. */
    static final int CAP_NOW_PCT = 80;
    /** A desk's text in the list. */
    public static final int NAME_MAX = 60;

    private Attention() {}

    /** The member's attention settings ({@code maiaMode.attention}), already within their ranges. */
    public record Settings(int visible, int interruptEveryMin, int batchEveryMin, boolean quietWhileTyping,
            int todosVisible) {
        public static final Settings DEFAULT = new Settings(3, 15, 30, true, 1);
    }

    /**
     * One desk as the office saw it, names already plain and cut. {@code briefs}: what Desk Maia's briefs cost there
     * today and this month, from that desk's own ledger ({@link Wallet}), or null when the office didn't say.
     */
    public record Desk(String deskId, String name, String kind, String state, boolean linkOpen, List<Agent> agents,
            List<Approval> approvals, List<Stopped> stopped, int todosNew, List<DueSoon> dueSoon,
            Wallet.DeskBriefs briefs) {
        public Desk {
            agents = List.copyOf(agents);
            approvals = List.copyOf(approvals);
            stopped = List.copyOf(stopped);
            dueSoon = List.copyOf(dueSoon);
        }

        public Desk(String deskId, String name, String kind, String state, boolean linkOpen, List<Agent> agents,
                List<Approval> approvals, List<Stopped> stopped, int todosNew, List<DueSoon> dueSoon) {
            this(deskId, name, kind, state, linkOpen, agents, approvals, stopped, todosNew, dueSoon, null);
        }
    }

    /**
     * One agent on a desk. {@code headroom}: what's left of its limits and its usual task's cost, from that desk's own
     * team view ({@link Wallet}), or null when the office didn't say.
     */
    public record Agent(String agentId, String name, String status, String statusDetail, int approvalsPending,
            Wallet.Headroom headroom) {

        public Agent(String agentId, String name, String status, String statusDetail, int approvalsPending) {
            this(agentId, name, status, statusDetail, approvalsPending, null);
        }

        boolean working() {
            return "working".equals(status) && !"awaiting_approval".equals(statusDetail)
                    && !"waiting_desk".equals(statusDetail);
        }
    }

    /**
     * A pending approval as the office read it. {@code risk} ({@code write}, {@code own}, {@code send}, {@code spend},
     * {@code delete}, {@code egress}) and {@code untrusted} for the decision tray's confirm strip and its line; null and
     * false when an older office didn't say. Never the payload.
     */
    public record Approval(String approvalId, String agentId, long expiresAt, String risk, boolean untrusted) {
        public Approval(String approvalId, String agentId, long expiresAt) {
            this(approvalId, agentId, expiresAt, null, false);
        }
    }

    public record Stopped(String agentId, String messageId, String reason, long at) {}

    /**
     * A to-do due soon. {@code mine}: the member made it (not an agent, not after reading something untrusted); null
     * unknown. {@code from}: where it came from when that's someone (its source kind: {@code courier}, {@code desk},
     * {@code agent_chat}, …), null for the member's own or unknown: the decision tray's "came from someone".
     */
    public record DueSoon(String id, String title, long dueAt, Boolean mine, String from) {
        public DueSoon(String id, String title, long dueAt) {
            this(id, title, dueAt, null, null);
        }

        public DueSoon(String id, String title, long dueAt, Boolean mine) {
            this(id, title, dueAt, mine, null);
        }
    }

    /**
     * A brief of hers that was answered: a result to offer. {@code status}: the report's code-parsed status (Phase 2's
     * {@code done}, {@code needs_decision}, {@code blocked}, {@code unknown}, {@code failed}), or null when none was
     * read; the focus shield reads it ({@link ReachItems}), never its words.
     */
    public record Result(String messageId, String deskId, String deskName, String agentName, long at, String status) {
        public Result(String messageId, String deskId, String deskName, String agentName, long at) {
            this(messageId, deskId, deskName, agentName, at, null);
        }
    }

    /**
     * What one call is given. {@code shieldHeld}: with the focus shield on, the keys it holds (hold level: counted in
     * {@code held}, never a visible place); the shield then replaces the batch ({@link Shield}).
     */
    public record Input(long now, Settings settings, List<Desk> desks, boolean observed, boolean typing,
            long creditsCenti, Long capCredits, int notesToday, int notesHeld, int onIt, int doneToday,
            List<Result> results, Map<String, Map<String, Long>> choices, Set<String> shown, long lastNoticeAt,
            long lastBatchAt, boolean releaseAll, Set<String> shieldHeld) {
        public Input {
            desks = List.copyOf(desks);
            results = List.copyOf(results);
            choices = Map.copyOf(choices);
            shown = Set.copyOf(shown);
            shieldHeld = shieldHeld == null ? Set.of() : Set.copyOf(shieldHeld);
        }

        public Input(long now, Settings settings, List<Desk> desks, boolean observed, boolean typing,
                long creditsCenti, Long capCredits, int notesToday, int notesHeld, int onIt, int doneToday,
                List<Result> results, Map<String, Map<String, Long>> choices, Set<String> shown, long lastNoticeAt,
                long lastBatchAt, boolean releaseAll) {
            this(now, settings, desks, observed, typing, creditsCenti, capCredits, notesToday, notesHeld, onIt,
                    doneToday, results, choices, shown, lastNoticeAt, lastBatchAt, releaseAll, null);
        }
    }

    /** One item, as the room shows it. */
    public record Item(String key, String id, String kind, String urgency, String deskId, String deskName,
            String title, int count, Long expiresAt, String detail, Map<String, Object> action, long createdAt) {

        public Map<String, Object> view(String state) {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("id", id);
            v.put("kind", kind);
            v.put("urgency", urgency);
            v.put("deskId", deskId);
            v.put("deskName", deskName);
            v.put("title", title);
            v.put("count", count);
            v.put("expiresAt", expiresAt);
            v.put("detail", detail);
            v.put("action", action);
            v.put("createdAt", createdAt);
            v.put("state", state);
            return v;
        }
    }

    /**
     * What one call gives back: the room's {@code status}, {@code todo} and {@code foot}, her credits today (hundredths of
     * a credit, for the room's {@code allowance.today}), and its state. Never money.
     */
    public record Output(Map<String, Object> status, Map<String, Object> todo, long creditsCenti,
            Map<String, Object> foot, List<Item> visible, List<Item> all, Set<String> shown, String noticeItemId,
            boolean batchReleased, int held) {}

    /** Every item the rules make now, before the list's limits: one per desk and kind (the focus shield reads them). */
    public static List<Item> items(Input in, Map<String, Long> firstSeen) {
        List<Item> out = new ArrayList<>();
        long now = in.now();
        for (Desk desk : in.desks()) {
            if ("guild".equals(desk.kind())) {
                continue;
            }
            String d = desk.name();
            // Approvals waiting on that desk: Now if any expires within the hour.
            if (!desk.approvals().isEmpty()) {
                long soonest = desk.approvals().stream().mapToLong(Approval::expiresAt).min().orElse(Long.MAX_VALUE);
                int n = desk.approvals().size();
                String agentName = n == 1 ? agentName(desk, desk.approvals().get(0).agentId()) : null;
                String title = n == 1 ? agentName + " needs your OK on " + d : n + " things need your OK on " + d;
                String detail = soonest - now < APPROVAL_SHOW_EXPIRY ? "Expires in " + duration(soonest - now) : null;
                Map<String, Object> action = new LinkedHashMap<>();
                action.put("kind", "approvals");
                action.put("deskId", desk.deskId());
                action.put("approvalIds", desk.approvals().stream().map(Approval::approvalId).toList());
                out.add(item("approval:" + desk.deskId(), "approval", soonest - now <= APPROVAL_NOW ? "now" : "next",
                        desk, title, n, soonest, detail, action, firstSeen, now));
            }
            // A task stopped by a limit: Now.
            List<Stopped> limited = desk.stopped().stream().filter(s -> "limit_reached".equals(s.reason())).toList();
            if (!limited.isEmpty()) {
                int n = limited.size();
                String title = n == 1 ? agentName(desk, limited.get(0).agentId()) + " stopped at a limit on " + d
                        : n + " tasks stopped at a limit on " + d;
                Map<String, Object> action = new LinkedHashMap<>();
                action.put("kind", "show");
                action.put("deskId", desk.deskId());
                action.put("app", "agent");
                action.put("ref", limited.get(0).agentId());
                out.add(item("limit:" + desk.deskId(), "limit", "now", desk, title, n, null, null, action, firstSeen,
                        now));
            }
            // A desk that failed: Now.
            if ("failed".equals(desk.state())) {
                Map<String, Object> action = new LinkedHashMap<>();
                action.put("kind", "none");
                out.add(item("desk_failed:" + desk.deskId(), "desk_failed", "now", desk, d + " has a problem", 1,
                        null, null, action, firstSeen, now));
            }
            // To-dos: one item per desk. Now only when one is due within 2 hours, read from its due time.
            List<DueSoon> due = desk.dueSoon().stream().filter(t -> t.dueAt() - now <= TODO_NOW && t.dueAt() >= now
                    - 30 * MINUTE).sorted(Comparator.comparingLong(DueSoon::dueAt)).toList();
            if (!due.isEmpty()) {
                DueSoon first = due.get(0);
                Map<String, Object> action = new LinkedHashMap<>();
                action.put("kind", "show");
                action.put("deskId", desk.deskId());
                action.put("app", "todo");
                action.put("ref", "needs_you");
                out.add(item("todos_due:" + desk.deskId(), "todos", "now", desk, "Due soon on " + d + ": "
                        + MaiaAgent.plain(first.title(), NAME_MAX), due.size(), first.dueAt(),
                        first.dueAt() > now ? "Due in " + duration(first.dueAt() - now) : "Overdue", action, firstSeen, now));
            } else if (desk.todosNew() > 0) {
                int n = desk.todosNew();
                Map<String, Object> action = new LinkedHashMap<>();
                action.put("kind", "show");
                action.put("deskId", desk.deskId());
                action.put("app", "todo");
                action.put("ref", "needs_you");
                out.add(item("todos:" + desk.deskId(), "todos", "next", desk, n == 1 ? "1 new to-do on " + d
                        : n + " new to-dos on " + d, n, null, null, action, firstSeen, now));
            }
            // A desk asleep or stopped: Later.
            if ("asleep".equals(desk.state()) || "stopped".equals(desk.state())) {
                Map<String, Object> action = new LinkedHashMap<>();
                action.put("kind", "wake");
                action.put("deskId", desk.deskId());
                out.add(item("desk_asleep:" + desk.deskId(), "desk_asleep", "later", desk, d + " is asleep", 1,
                        null, null, action, firstSeen, now));
            }
        }
        // Her credits at 80% of the day cap the member set on her: Now. No cap of the member's, no item: her service's
        // day and week amounts only pace her (the owner, Nov 15).
        long capCenti = in.capCredits() == null ? 0 : in.capCredits() * 100;
        if (capCenti > 0 && in.creditsCenti() * 100 >= (long) CAP_NOW_PCT * capCenti) {
            Map<String, Object> action = new LinkedHashMap<>();
            action.put("kind", "none");
            int pct = (int) Math.min(100, in.creditsCenti() * 100 / capCenti);
            String cap = whole(in.capCredits()) + (in.capCredits() == 1 ? " credit" : " credits");
            String title = pct >= 100 ? "Maia has used the " + cap + " you set for today and paused"
                    : "Maia has used " + pct + "% of the " + cap + " you set for today";
            out.add(new Item("cap:maia", id("cap:maia"), "cap", "now", null, null, title, 1, null, null, action,
                    firstSeen.getOrDefault("cap:maia", now)));
        }
        // Results of her briefs: Next, merged per desk.
        Map<String, List<Result>> byDesk = new LinkedHashMap<>();
        for (Result r : in.results()) {
            byDesk.computeIfAbsent(r.deskId(), k -> new ArrayList<>()).add(r);
        }
        for (Map.Entry<String, List<Result>> e : byDesk.entrySet()) {
            List<Result> rs = e.getValue();
            Result last = rs.get(rs.size() - 1);
            String key = "result:" + e.getKey();
            Map<String, Object> action = new LinkedHashMap<>();
            action.put("kind", "result");
            action.put("messageId", last.messageId());
            String desk = MaiaAgent.plain(last.deskName(), NAME_MAX);
            String title = rs.size() == 1 ? MaiaAgent.plain(last.agentName(), NAME_MAX) + " on " + desk + " answered"
                    : rs.size() + " answers from " + desk;
            out.add(new Item(key, id(key), "result", "next", e.getKey(), desk, title, rs.size(), null, null, action,
                    firstSeen.getOrDefault(key, last.at())));
        }
        // Notes she couldn't place: Next, one line.
        if (in.notesHeld() > 0) {
            Map<String, Object> action = new LinkedHashMap<>();
            action.put("kind", "notes");
            action.put("day", null);
            String title = in.notesHeld() == 1 ? "A note could go either way" : in.notesHeld()
                    + " notes could go either way";
            out.add(new Item("notes_unsure", id("notes_unsure"), "notes_unsure", "next", null, null, title,
                    in.notesHeld(), null, null, action, firstSeen.getOrDefault("notes_unsure", now)));
        }
        // Notes filed today: Later, never Now or Next.
        if (in.notesToday() > 0) {
            Map<String, Object> action = new LinkedHashMap<>();
            action.put("kind", "notes");
            action.put("day", null);
            out.add(new Item("notes", id("notes"), "notes", "later", null, null, in.notesToday() == 1
                    ? "1 note today" : in.notesToday() + " notes today", in.notesToday(), null, null, action,
                    firstSeen.getOrDefault("notes", now)));
        }
        return out;
    }

    /** The whole list, under the rules. {@code firstSeen} is kept by {@link Room} and updated here. */
    public static Output build(Input in, Map<String, Long> firstSeen) {
        long now = in.now();
        List<Item> all = items(in, firstSeen);
        // First-seen times: kept while an item stays, forgotten when it goes.
        Set<String> present = new java.util.HashSet<>();
        for (Item item : all) {
            present.add(item.key());
            firstSeen.putIfAbsent(item.key(), item.createdAt());
        }
        firstSeen.keySet().retainAll(present);

        Set<String> shown = new java.util.HashSet<>(in.shown());
        shown.retainAll(present);
        boolean batch = in.releaseAll() || now - in.lastBatchAt() >= in.settings().batchEveryMin() * MINUTE;
        boolean quiet = in.typing() && in.settings().quietWhileTyping();

        List<Item> snoozed = new ArrayList<>();
        List<Item> active = new ArrayList<>();
        List<Item> later = new ArrayList<>();
        int held = 0;
        String noticeItem = null;
        for (Item item : all) {
            Map<String, Long> choice = in.choices().get(item.key());
            if (choice != null && choice.get("dismissedAt") != null && dismissable(item.kind())) {
                continue;
            }
            if (choice != null && choice.get("snoozedUntil") != null && choice.get("snoozedUntil") > now) {
                snoozed.add(item);
                continue;
            }
            if (in.shieldHeld().contains(item.key()) && !"now".equals(item.urgency())) {
                // The focus shield holds it for a catch-up: counted, never a visible place.
                held++;
                continue;
            }
            if ("later".equals(item.urgency())) {
                later.add(item);
                continue;
            }
            if (!shown.contains(item.key())) {
                // New: a Now comes at once, a Next at the batch or when the member is back; nothing while typing.
                boolean release = !quiet && ("now".equals(item.urgency()) || batch);
                if (!release) {
                    held++;
                    continue;
                }
                shown.add(item.key());
            }
            active.add(item);
        }
        // Order: Now first (the most urgent: soonest expiry), then Next by when it came.
        active.sort(Comparator.comparing((Item i) -> "now".equals(i.urgency()) ? 0 : 1)
                .thenComparing(i -> "now".equals(i.urgency()) && i.expiresAt() != null ? i.expiresAt() : Long.MAX_VALUE)
                .thenComparingLong(Item::createdAt).thenComparing(Item::key));
        List<Item> visible = new ArrayList<>();
        List<Item> overflow = new ArrayList<>();
        boolean nowTaken = false;
        for (Item item : active) {
            Item shownAs = item;
            if ("now".equals(item.urgency())) {
                if (nowTaken) {
                    shownAs = withUrgency(item, "next");
                } else {
                    nowTaken = true;
                }
            }
            if (visible.size() < in.settings().visible()) {
                visible.add(shownAs);
            } else {
                overflow.add(shownAs);
            }
        }
        // A new Now may interrupt: once every interruptEveryMin, never while typing.
        for (Item item : visible) {
            if ("now".equals(item.urgency()) && !in.shown().contains(item.key()) && !quiet
                    && now - in.lastNoticeAt() >= in.settings().interruptEveryMin() * MINUTE) {
                noticeItem = item.id();
            }
        }

        List<Map<String, Object>> items = new ArrayList<>();
        for (Item item : visible) {
            items.add(item.view(in.shown().contains(item.key()) ? "shown" : "new"));
        }
        List<String> lines = new ArrayList<>();
        if (!overflow.isEmpty()) {
            lines.add(overflow.size() == 1 ? "1 more to look at" : overflow.size() + " more to look at");
        }
        for (Item item : later) {
            lines.add(item.title());
        }
        for (Item item : snoozed) {
            lines.add("Snoozed: " + item.title());
        }
        Map<String, Object> laterView = new LinkedHashMap<>();
        laterView.put("count", overflow.size() + later.size() + snoozed.size());
        laterView.put("lines", lines.size() > 5 ? lines.subList(0, 5) : lines);
        Map<String, Object> todo = new LinkedHashMap<>();
        todo.put("items", items);
        todo.put("later", laterView);
        todo.put("open", visible.size());
        todo.put("now", nowTaken ? 1 : 0);
        todo.put("held", held);

        return new Output(status(in), todo, in.creditsCenti(), foot(in), visible, all, shown, noticeItem, batch, held);
    }

    static boolean dismissable(String kind) {
        return !Set.of("approval", "limit", "desk_failed", "cap").contains(kind);
    }

    private static Item withUrgency(Item i, String urgency) {
        return new Item(i.key(), i.id(), i.kind(), urgency, i.deskId(), i.deskName(), i.title(), i.count(),
                i.expiresAt(), i.detail(), i.action(), i.createdAt());
    }

    private static Item item(String key, String kind, String urgency, Desk desk, String title, int count,
            Long expiresAt, String detail, Map<String, Object> action, Map<String, Long> firstSeen, long now) {
        return new Item(key, id(key), kind, urgency, desk.deskId(), desk.name(), title, count, expiresAt, detail,
                action, firstSeen.getOrDefault(key, now));
    }

    private static String agentName(Desk desk, String agentId) {
        for (Agent a : desk.agents()) {
            if (a.agentId().equals(agentId)) {
                return a.name().isEmpty() ? "An agent" : a.name();
            }
        }
        return "An agent";
    }

    static Map<String, Object> status(Input in) {
        int desks = 0;
        int agents = 0;
        int working = 0;
        for (Desk d : in.desks()) {
            if ("guild".equals(d.kind()) || !d.linkOpen()) {
                continue;
            }
            desks++;
            for (Agent a : d.agents()) {
                if (MaiaAgent.is(a.agentId())) {
                    continue;
                }
                agents++;
                if (a.working()) {
                    working++;
                }
            }
        }
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("desks", desks);
        v.put("agents", agents);
        v.put("working", working);
        v.put("line", "Watching " + desks + (desks == 1 ? " desk" : " desks") + " · " + agents
                + (agents == 1 ? " agent" : " agents") + " · " + working + " working");
        return v;
    }

    static Map<String, Object> foot(Input in) {
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("onIt", in.onIt());
        v.put("doneToday", in.doneToday());
        v.put("line", "On it: " + in.onIt() + " · Done today: " + in.doneToday());
        return v;
    }

    /**
     * $0.84, $5, $12.50: cents only when there are some. For the member's own money only (her briefs' cost on their own
     * agents and keys, {@link Wallet}): never Maia's own usage, which is credits (the owner, Nov 15).
     */
    public static String dollars(long microUsd) {
        long cents = Math.round(microUsd / 10_000.0);
        if (cents % 100 == 0) {
            return "$" + cents / 100;
        }
        return String.format(Locale.ROOT, "$%d.%02d", cents / 100, cents % 100);
    }

    /** Hundredths of a credit as credits, to 2 decimals: 1250 is 12.5. */
    public static double credits2(long centi) {
        return centi / 100.0;
    }

    /** Hundredths of a credit as people read them, to 2 decimals at most: "12.5", "1,550". */
    public static String creditsText(long centi) {
        java.text.DecimalFormat f = new java.text.DecimalFormat("#,##0.##",
                java.text.DecimalFormatSymbols.getInstance(Locale.ENGLISH));
        return f.format(java.math.BigDecimal.valueOf(centi, 2));
    }

    /** Whole credits as people read them: "1,550". */
    public static String whole(long credits) {
        return String.format(Locale.ENGLISH, "%,d", credits);
    }

    /** "40 min", "2 h", "1 h 20 min". */
    static String duration(long ms) {
        long minutes = Math.max(1, (ms + MINUTE - 1) / MINUTE);
        if (minutes < 60) {
            return minutes + " min";
        }
        long h = minutes / 60;
        long m = minutes % 60;
        return m == 0 ? h + " h" : h + " h " + m + " min";
    }

    /** A stable item id from its key: {@code mi-} and 16 lowercase base32 characters of its SHA-256. */
    public static String id(String key) {
        try {
            byte[] h = MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.UTF_8));
            String alphabet = "abcdefghijklmnopqrstuvwxyz234567";
            StringBuilder out = new StringBuilder("mi-");
            for (int i = 0; i < 16; i++) {
                out.append(alphabet.charAt((h[i] & 0xff) % 32));
            }
            return out.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
