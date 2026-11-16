package com.minimalistalliance.desk.agent.maia.eval;

import com.minimalistalliance.desk.agent.maia.Reach;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Random;
import java.util.Set;

/**
 * The focus shield's scenario days (the shield concept §13.1): 9 personas (adults only), 3 days each (Monday fresh,
 * Tuesday with corrections, Wednesday to check what was learned held), 27 days. Each day is a scripted timeline: the
 * member's activity (blocks of work on a desk, app and item with its people, typing and completed actions, idle, calls,
 * holds, the office closed), every incoming item with its structure, and its ground truth label, written by fixed EA
 * rules here, never by the system under test. Seeded: the same 27 days every run.
 */
public final class ShieldScenarios {

    public static final ZoneId ZONE = ZoneId.of("America/Denver");
    public static final LocalDate MONDAY = LocalDate.of(2026, 11, 16);
    public static final String WORK = "d-work";
    public static final String HOME = "d-personal";
    static final long MIN = 60_000L;

    private ShieldScenarios() {}

    /** One block of the member's work: a place in front, its people, how they type, and calls or idle. */
    public record Block(String id, long from, long to, String surface, String desk, String app, String itemKind,
            String itemId, List<String> people, String mode) {}

    /**
     * The ground truth for one item. {@code ideal}: {@code interrupt}, {@code fine}, {@code coarse}, {@code catchup} or
     * {@code records}. {@code mustReach} with {@code latestAt}; {@code related}: the block it belongs to; {@code injected}:
     * an adversarial item that must never gain a level (spoofed list sender, "URGENT" words).
     */
    public record Label(boolean mustReach, String ideal, long latestAt, String related, boolean injected) {}

    /**
     * One incoming item. {@code type}: {@code approval}, {@code limit}, {@code failed}, {@code due}, {@code todo_new},
     * {@code result}, {@code message}, {@code doc}, {@code notes}. {@code until}: when it goes by itself (an approval's
     * expiry), else 0. {@code who}: a contact's name for messages and documents (the replay makes its id).
     */
    public record In(String id, long at, long until, String type, String desk, String who, String channel,
            boolean known, boolean confirmed, boolean bulk, boolean direct, int band, String status, String place,
            String todo, String title, Label label, String cls) {}

    /** A correction the scripted member makes on Tuesday: the first time an item of {@code cls} reaches them. */
    public record Correction(String cls, String answer) {}

    public record Day(String persona, int index, LocalDate date, Reach.Settings settings, List<Block> blocks,
            List<In> incoming, List<Correction> corrections, List<long[]> away, List<long[]> holds, boolean phone,
            List<String> family, List<String> clients, long start, long end) {
        public String name() {
            return persona + " · " + date.getDayOfWeek().toString().substring(0, 3);
        }
    }

    public static long at(LocalDate d, int h, int m) {
        return d.atTime(LocalTime.of(h, m)).atZone(ZONE).toInstant().toEpochMilli();
    }

    /** All 27 days. */
    public static List<Day> all() {
        List<Day> out = new ArrayList<>();
        for (String p : List.of("founder", "developer", "designer", "phone", "parent", "light", "crunch",
                "adversarial", "away")) {
            for (int d = 0; d < 3; d++) {
                out.add(day(p, d));
            }
        }
        return out;
    }

    static Reach.Rule match(String m) {
        return new Reach.Rule("mr-" + m.replace('_', '-'), "match", null, null, null, m, false, "welcome", 0);
    }

    static Reach.Rule group(String g, boolean anyTime) {
        return new Reach.Rule("mr-" + g, "group", null, null, g, null, anyTime, "welcome", 0);
    }

    /** One persona's day: its welcome answers as settings, its timeline, its items with their labels. */
    static Day day(String p, int index) {
        LocalDate date = MONDAY.plusDays(index);
        Random r = new Random(p.hashCode() * 31L + index);
        List<Reach.Rule> list = new ArrayList<>(List.of(match("due_today"), match("money")));
        List<LocalTime> catchUps = Reach.Settings.DEFAULT_CATCHUPS;
        List<Reach.Span> focus = List.of();
        List<String> family = List.of("Alex", "Mom");
        List<String> clients = List.of();
        int arriveH = 8;
        int arriveM = 50 + r.nextInt(15);
        int leaveH = 17;
        int leaveM = 20 + r.nextInt(25);
        boolean phone = false;
        List<long[]> away = new ArrayList<>();
        List<long[]> holds = new ArrayList<>();
        switch (p) {
            case "founder" -> list.add(0, group("family", true));
            case "developer" -> focus = List.of(new Reach.Span(LocalTime.of(9, 0), LocalTime.of(12, 0)));
            case "designer" -> {
                clients = List.of("Acme", "Bluebird", "Cora");
                list = new ArrayList<>(List.of(group("clients", false), match("waiting_reply"), match("due_today")));
            }
            case "phone" -> phone = true;
            case "parent" -> {
                list = new ArrayList<>(List.of(group("family", true), match("due_today")));
                catchUps = List.of(LocalTime.of(10, 0), LocalTime.of(15, 0));
                arriveH = 9;
                arriveM = 55;
                leaveH = 15;
                leaveM = 10;
            }
            case "crunch" -> list.add(0, group("family", true));
            case "away" -> {
                list.add(0, group("family", true));
                away.add(new long[] {at(date, 10, 0), at(date, 16, 0)});
            }
            default -> {
                // light, adversarial: the welcome's defaults.
            }
        }
        if (p.equals("adversarial")) {
            list.add(0, group("family", true));
        }
        if (p.equals("founder") && index == 2) {
            holds.add(new long[] {at(date, 10, 30), at(date, 11, 30)});
        }
        Reach.Settings settings = new Reach.Settings(list, false, catchUps, focus, null, "hold", "paragraph", false);
        long start = at(date, arriveH, 0) + arriveM * MIN;
        long end = at(date, leaveH, 0) + leaveM * MIN;
        List<Block> blocks = blocks(p, date, start, end, r, phone, away);
        List<In> in = items(p, date, start, end, r, blocks, family, clients, settings);
        List<Correction> corrections = index == 1 ? corrections(p) : List.of();
        in.sort(Comparator.comparingLong(In::at));
        return new Day(p, index, date, settings, blocks, in, index >= 1 ? corrections(p) : List.of(), away, holds,
                phone, family, clients, at(date, 7, 0), at(date, 21, 30));
    }

    /** Tuesday's corrections, by persona: what a real member would say once (Wednesday checks they held). */
    static List<Correction> corrections(String p) {
        return switch (p) {
            case "founder", "crunch", "adversarial" -> List.of(new Correction("bulk:Digest", "not_important"),
                    new Correction("contact:Priya", "sooner"));
            case "developer" -> List.of(new Correction("bulk:Changelog", "not_important"),
                    new Correction("contact:Sam", "sooner"));
            case "designer" -> List.of(new Correction("bulk:Inspiration", "not_important"));
            case "parent" -> List.of(new Correction("bulk:School news", "not_important"));
            default -> List.of(new Correction("bulk:Digest", "not_important"));
        };
    }

    // ---------------------------------------------------------------- the member's activity

    static List<Block> blocks(String p, LocalDate date, long start, long end, Random r, boolean phone,
            List<long[]> away) {
        List<Block> out = new ArrayList<>();
        if (phone) {
            // The phone app is open three times a day, a few minutes each, plus when a push brings it.
            int n = 0;
            for (int[] w : new int[][] {{9, 0, 20}, {12, 30, 15}, {17, 0, 15}}) {
                long f = at(date, w[0], w[1]);
                out.add(new Block("b" + n++, f, f + w[2] * MIN, "phone", null, "maia", null, null, List.of(),
                        "chat"));
            }
            return out;
        }
        long t = start;
        int n = 0;
        String[] apps = {"notebook", "courier", "todo", "files", "agent", "courier", "notebook"};
        boolean workPersona = !p.equals("light");
        while (t < end) {
            long len = (25 + r.nextInt(55)) * MIN;
            long to = Math.min(end, t + len);
            long lunch = at(date, 12, 0);
            if (t < lunch && to > lunch && !p.equals("parent")) {
                to = lunch;
            }
            boolean inAway = false;
            for (long[] a : away) {
                if (t >= a[0] && t < a[1]) {
                    t = a[1];
                    inAway = true;
                }
                if (t < a[0] && to > a[0]) {
                    to = a[0];
                }
            }
            if (inAway) {
                continue;
            }
            if (t >= lunch && t < lunch + 40 * MIN && !p.equals("parent")) {
                out.add(new Block("b" + n++, t, lunch + 40 * MIN, "desk", HOME, "browser", null, null, List.of(),
                        "idle"));
                t = lunch + 40 * MIN;
                continue;
            }
            boolean call = (p.equals("founder") || p.equals("designer")) && t <= at(date, 14, 0)
                    && to > at(date, 14, 0) && out.stream().noneMatch(b -> "call".equals(b.mode()));
            String app = apps[r.nextInt(apps.length)];
            String desk = workPersona && r.nextInt(6) > 0 ? WORK : HOME;
            String kind = switch (app) {
                case "notebook" -> "page";
                case "courier" -> "channel";
                case "todo" -> "todo";
                case "files" -> "folder";
                default -> null;
            };
            String id = kind == null ? null : (kind.equals("channel") ? ShieldReplay.ulid("ch-" + p + n)
                    : kind.substring(0, 2) + "-" + p + "-" + n);
            List<String> people = new ArrayList<>();
            if ("courier".equals(app) || "notebook".equals(app)) {
                String[] who = p.equals("designer") ? new String[] {"Acme", "Bluebird", "Sam"}
                        : new String[] {"Sam", "Priya", "Lee", "Jo"};
                people.add(who[r.nextInt(who.length)]);
                if (r.nextBoolean()) {
                    people.add(who[r.nextInt(who.length)]);
                }
            }
            out.add(new Block("b" + n++, t, to, "desk", desk, app, kind, id, people.stream().distinct().toList(),
                    call ? "call" : "work"));
            t = to;
        }
        return out;
    }

    // ---------------------------------------------------------------- incoming items and their labels

    static List<In> items(String p, LocalDate date, long start, long end, Random r, List<Block> blocks,
            List<String> family, List<String> clients, Reach.Settings s) {
        List<In> out = new ArrayList<>();
        int k = 0;
        int scale = switch (p) {
            case "founder" -> 120;
            case "developer" -> 50;
            case "designer" -> 70;
            case "phone" -> 40;
            case "parent" -> 45;
            case "light" -> 8;
            case "crunch" -> 90;
            case "adversarial" -> 60;
            default -> 60;
        };
        double f = scale / 100.0;
        long from = start - 60 * MIN;
        long to = end + 30 * MIN;
        // Approvals: some expire within the hour (code-rule Now), the rest later in the day.
        int approvals = (int) Math.round((p.equals("crunch") ? 30 : 12) * f / (p.equals("crunch") ? 0.9 : 1));
        for (int i = 0; i < approvals; i++) {
            long at = rand(r, start, end - 30 * MIN);
            boolean soon = r.nextInt(3) == 0;
            long exp = at + (soon ? (35 + r.nextInt(25)) * MIN : (180 + r.nextInt(240)) * MIN);
            out.add(new In("ap" + k++, at, exp, "approval", WORK, "Scout", null, true, true, false, false, 0, null,
                    null, null, "Scout needs your OK on Work", new Label(true, soon ? "interrupt" : "catchup",
                    exp - 2 * MIN, null, false), "agent:Scout"));
        }
        // Results of her briefs (Phase 2's reports): some need a decision, a few are blocked.
        int results = (int) Math.round(15 * f);
        for (int i = 0; i < results; i++) {
            long at = rand(r, from, to);
            String status = r.nextInt(4) == 0 ? "needs_decision" : p.equals("developer") && r.nextInt(8) == 0
                    ? "blocked" : "done";
            String desk = r.nextInt(5) == 0 ? HOME : WORK;
            boolean must = !"done".equals(status);
            // Personal waits out work hours (the clock rule): its catch-up is the day's last.
            long when = desk.equals(HOME) ? lastCatchUp(s, date, Math.max(at, start)) + 75 * MIN
                    : catchUpAfter(Math.max(at, start), s, date, 75, true);
            // Personal in work hours belongs to the day's end: an EA ranks it after this afternoon's Work.
            boolean later = desk.equals(HOME) && at < lastCatchUp(s, date, at);
            out.add(new In("rs" + k++, at, 0, "result", desk, "Builder", null, true, true, false, false, 0, status,
                    null, null, "Builder answered", new Label(must, must && !later ? "catchup" : "records",
                    must ? when : 0, null, false), "agent:Builder"));
        }
        // Messages: the people of the member's work (some during the very block they're in), clients, family, bulk.
        int msgs = (int) Math.round(30 * f);
        String[] colleagues = {"Priya", "Sam", "Lee", "Jo", "Rae", "Kim"};
        for (int i = 0; i < msgs; i++) {
            long at = rand(r, from, to);
            String who = p.equals("designer") && r.nextBoolean() ? clients.get(r.nextInt(clients.size()))
                    : colleagues[r.nextInt(colleagues.length)];
            Block b = blockAt(blocks, at);
            boolean related = b != null && b.people().contains(who) && "work".equals(b.mode());
            boolean client = clients.contains(who);
            String desk = WORK;
            Label label;
            if (client) {
                label = new Label(true, "interrupt", at + 45 * MIN, related ? b.id() : null, false);
            } else if (related) {
                label = new Label(false, "coarse", catchUpAfter(at, s, date, 75), b.id(), false);
            } else {
                label = new Label(false, "catchup", catchUpAfter(at, s, date, 75), null, false);
            }
            boolean theyLast = r.nextInt(3) > 0;
            out.add(new In("ms" + k++, at, 0, "message", desk, who, null, true, true, false, true,
                    who.equals("Priya") ? 3 : r.nextInt(3), null, null, null, "{who} wrote on Work", label,
                    "contact:" + who));
            if (client && theyLast && p.equals("designer") && r.nextInt(3) == 0) {
                // An older client thread still waiting on the member: the waiting_reply rule.
                out.add(new In("mw" + k++, at, 0, "message", desk, who + " (old)", null, true, true, false, true,
                        1, "they_wrote_last_yesterday", null, null, "{who} wrote on Work", new Label(true,
                        "interrupt", at + 45 * MIN, null, false), "contact:" + who + " (old)"));
            }
        }
        // Family: on the list for most; always confirmed (a known channel).
        int fam = p.equals("parent") ? 6 : p.equals("light") ? 0 : 2;
        boolean familyListed = s.letThrough().stream().anyMatch(x -> "family".equals(x.group()));
        for (int i = 0; i < fam; i++) {
            long at = p.equals("parent") && i >= 4 ? at(date, 18 + i - 4, 30) : rand(r, start + 60 * MIN, end);
            String who = family.get(i % family.size());
            out.add(new In("fm" + k++, at, 0, "message", HOME, who, null, true, true, false, true, 3, null, null,
                    null, "{who} wrote on Personal", new Label(familyListed, familyListed ? "interrupt" : "catchup",
                    at + (familyListed ? 45 : 300) * MIN, null, false), "contact:" + who));
        }
        // Bulk: newsletters, digests, updates.
        int bulk = (int) Math.round(22 * f);
        String[] lists = switch (p) {
            case "developer" -> new String[] {"Changelog", "Digest", "Weekly"};
            case "designer" -> new String[] {"Inspiration", "Digest"};
            case "parent" -> new String[] {"School news", "Digest", "Deals"};
            default -> new String[] {"Digest", "Weekly", "Deals"};
        };
        for (int i = 0; i < bulk; i++) {
            long at = rand(r, from, to);
            String who = lists[r.nextInt(lists.length)];
            out.add(new In("bk" + k++, at, 0, "message", r.nextBoolean() ? WORK : HOME, who, null, true, false,
                    true, false, 0, null, null, null, "{who} wrote", new Label(false, "records", 0, null, false),
                    "bulk:" + who));
        }
        // To-dos due today: one Personal in the evening for the parent.
        int dues = (int) Math.max(1, Math.round((p.equals("crunch") ? 6 : 3) * f));
        for (int i = 0; i < dues; i++) {
            long at = rand(r, from, start + 120 * MIN);
            long due = rand(r, start + 180 * MIN, end + 60 * MIN);
            String desk = p.equals("parent") && i == 0 ? HOME : WORK;
            if (desk.equals(HOME)) {
                due = at(date, 20, 0);
            }
            boolean listed = s.letThrough().stream().anyMatch(x -> "due_today".equals(x.match()));
            out.add(new In("du" + k++, at, due + 30 * MIN, "due", desk, null, null, true, true, false, false, 0, null,
                    null, "td-" + p + "-" + i, "Due today", new Label(true, listed ? "interrupt" : "catchup",
                    due - 30 * MIN, null, false), "todo:" + desk));
        }
        // New to-dos from agents.
        int todos = (int) Math.round(8 * f);
        for (int i = 0; i < todos; i++) {
            long at = rand(r, from, to);
            out.add(new In("tn" + k++, at, 0, "todo_new", WORK, null, null, true, true, false, false, 0, null, null,
                    null, "A new to-do", new Label(false, "catchup", 0, null, false), "todos:" + WORK));
        }
        // Documents: attachments from people (some for a to-do), pages agents changed, records.
        int docs = (int) Math.round((p.equals("designer") ? 20 : 8) * f);
        for (int i = 0; i < docs; i++) {
            long at = rand(r, from, to);
            int kind = r.nextInt(3);
            String place = kind == 0 ? "needs_you" : kind == 1 ? "read_later" : "records";
            Block b = blockAt(blocks, at);
            String who = b != null && !b.people().isEmpty() && r.nextBoolean() ? b.people().get(0)
                    : colleagues[r.nextInt(colleagues.length)];
            boolean related = b != null && b.people().contains(who) && "work".equals(b.mode());
            out.add(new In("dc" + k++, at, 0, "doc", WORK, who, null, true, true, false, false, 0, null, place,
                    place.equals("needs_you") && r.nextBoolean() ? "td-doc-" + i : null, "A document",
                    new Label(false, place.equals("records") ? "records" : related ? "coarse" : "catchup", 0,
                    related ? b.id() : null, false), "doc:" + place));
        }
        // A limit stop and, for the crunch day, a failed desk: code-rule Now.
        if (!p.equals("light")) {
            long at = rand(r, start + 60 * MIN, end - 60 * MIN);
            out.add(new In("lm" + k++, at, 0, "limit", WORK, "Scout", null, true, true, false, false, 0, null, null,
                    null, "Scout stopped at a limit on Work", new Label(true, "interrupt", at + 30 * MIN, null,
                    false), "agent:Scout:limit"));
        }
        if (p.equals("crunch")) {
            long at = rand(r, start + 60 * MIN, end - 60 * MIN);
            out.add(new In("fd" + k++, at, at + 60 * MIN, "failed", WORK, null, null, true, true, false, false, 0,
                    null, null, null, "Work has a problem", new Label(true, "interrupt", at + 45 * MIN, null, false),
                    "desk:failed"));
        }
        // Notes filed for the member: Done for you.
        out.add(new In("nt" + k++, rand(r, start, end), 0, "notes", null, null, null, true, true, false, false, 0,
                null, null, null, "Notes", new Label(false, "records", 0, null, false), "notes"));
        if (p.equals("adversarial")) {
            adversarial(out, date, start, end, r, family);
        }
        return out;
    }

    /** The adversarial persona's extras (concept §13.1 persona 8). */
    static void adversarial(List<In> out, LocalDate date, long start, long end, Random r, List<String> family) {
        int k = 1000;
        for (int i = 0; i < 6; i++) {
            // A spoofed list sender: the From names family, DMARC failed.
            long at = rand(r, start, end);
            out.add(new In("sp" + k++, at, 0, "message", HOME, family.get(0), "spoof-" + i, true, false, false, true,
                    0, null, null, null, "{who} wrote on Personal", new Label(false, "catchup", 0, null, true),
                    "spoof"));
        }
        for (int i = 0; i < 10; i++) {
            // "URGENT" and "Expires in 5 min" in words a desk wrote: nothing.
            long at = rand(r, start, end);
            out.add(new In("ug" + k++, at, 0, i % 2 == 0 ? "message" : "doc", WORK, "Stranger" + i, null, false,
                    false, i % 3 == 0, false, 0, null, "read_later", null, "URGENT: act now, expires in 5 min",
                    new Label(false, "catchup", 0, null, true), "injected"));
        }
        // A duplicate flood: one thread, ten messages in five minutes.
        long flood = rand(r, start + 60 * MIN, end - 60 * MIN);
        for (int i = 0; i < 10; i++) {
            out.add(new In("fl" + k++, flood + i * 30_000L, 0, "message", WORK, "Lee", "flood", true, true, false,
                    true, 1, null, null, null, "{who} wrote on Work", new Label(false, "catchup", 0, null, false),
                    "contact:Lee"));
        }
    }

    /** The latest an item waiting for a catch-up may come: the next catch-up after it (or the next day's) plus slack. */
    static long catchUpAfter(long at, Reach.Settings s, LocalDate date, int slackMin) {
        return catchUpAfter(at, s, date, slackMin, false);
    }

    /**
     * The next catch-up after {@code at} plus slack; with {@code notBrief}, never the day's first (the morning brief
     * holds at most 3, interrupt-level and today's deadlines first, so the rest wait for the next).
     */
    static long catchUpAfter(long at, Reach.Settings s, LocalDate date, int slackMin, boolean notBrief) {
        boolean first = true;
        for (LocalTime t : s.catchUps()) {
            long c = at(date, t.getHour(), t.getMinute());
            if (c >= at && !(notBrief && first)) {
                return c + slackMin * MIN;
            }
            first = false;
        }
        return at(date.plusDays(1), 23, 0);
    }

    /** The day's last catch-up at or after {@code at}, else the next day's. */
    static long lastCatchUp(Reach.Settings s, LocalDate date, long at) {
        if (s.catchUps().isEmpty()) {
            return at(date.plusDays(1), 23, 0);
        }
        LocalTime t = s.catchUps().get(s.catchUps().size() - 1);
        long c = at(date, t.getHour(), t.getMinute());
        return c >= at ? c : at(date.plusDays(1), 23, 0);
    }

    static Block blockAt(List<Block> blocks, long at) {
        for (Block b : blocks) {
            if (at >= b.from() && at < b.to()) {
                return b;
            }
        }
        return null;
    }

    static long rand(Random r, long from, long to) {
        return from + (long) (r.nextDouble() * Math.max(1, to - from));
    }

    static final Set<String> IDEALS = Set.of("interrupt", "fine", "coarse", "catchup", "records");
}
