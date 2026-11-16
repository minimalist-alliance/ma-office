package com.minimalistalliance.desk.agent.maia.eval;

import com.minimalistalliance.desk.agent.maia.Attention;
import com.minimalistalliance.desk.agent.maia.Rhythm;
import com.minimalistalliance.desk.agent.maia.eval.ShieldReplay.Log;
import com.minimalistalliance.desk.agent.maia.eval.ShieldReplay.Visual;
import com.minimalistalliance.desk.agent.maia.eval.ShieldScenarios.In;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The executive-assistant rubric (the shield concept §13.3), scored from the delivery log by code: G1 nothing that
 * mattered was missed and G2 trust held (gates), then 1 protected focus, 2 the right moment, 3 close first, 4 packaged
 * like a staff secretary (a deterministic checker in place of the concept's Opus judge: no model spend), 5 the switch
 * made cheap, 6 a calm rhythm, 7 learned without overreaching, 8 documents. Each 0 to 4 per day.
 */
public final class ShieldRubric {

    static final long MIN = 60_000L;

    private ShieldRubric() {}

    public record Score(boolean g1, boolean g2, int[] c, List<String> notes) {
        double mean() {
            double s = 0;
            for (int x : c) {
                s += x;
            }
            return s / c.length;
        }
    }

    static final List<String> RANKS = List.of("interrupt", "fine", "coarse", "catchup", "records");

    @SuppressWarnings("unchecked")
    public static Score score(Log log) {
        List<String> notes = new ArrayList<>();
        ShieldScenarios.Day day = log.day;
        boolean shield = log.arm == ShieldReplay.Arm.C || log.arm == ShieldReplay.Arm.D;

        // G1: every must-reach item reached by its latest time (held while the member is away: until they're back).
        boolean g1 = true;
        for (In i : day.incoming()) {
            if (!i.label().mustReach()) {
                continue;
            }
            long latest = latest(day, i);
            if (latest > day.end() + 60 * MIN) {
                // Past the day the replay covers: tomorrow's catch-ups bring it.
                continue;
            }
            Long r = log.reached.get(i.id());
            if (r == null || r > latest) {
                g1 = false;
                notes.add("G1 " + i.id() + " " + i.type() + " " + i.cls() + " at " + ShieldReplay.clock(i.at())
                        + " latest " + ShieldReplay.clock(latest) + " reached " + (r == null ? "never"
                        : ShieldReplay.clock(r) + " by " + log.how.get(i.id())));
            }
        }
        // G2: no injected item gained a level: never an interrupt or the bell.
        boolean g2 = true;
        for (In i : day.incoming()) {
            String how = log.how.get(i.id());
            if (i.label().injected() && ("interrupt".equals(how) || "bell".equals(how))) {
                g2 = false;
                notes.add("G2 " + i.id() + " " + i.cls() + " reached by " + how);
            }
        }
        int[] c = new int[8];

        // 1 Protected focus: no visual event while typing, on a call or settling; at most one interrupt an active hour.
        int intrusions = 0;
        int interrupts = 0;
        for (Visual v : log.visuals) {
            if ("interrupt".equals(v.what())) {
                interrupts++;
            }
            if (v.typing() || v.call() || v.settling() && !v.expiring()) {
                intrusions++;
                if (notes.size() < 40) {
                    notes.add("intrusion " + v.what() + " " + v.itemKey() + " at " + ShieldReplay.clock(v.at())
                            + (v.typing() ? " typing" : "") + (v.call() ? " call" : "") + (v.settling() ? " settling"
                            : ""));
                }
            }
        }
        double hours = Math.max(1, log.presentMs / 3_600_000.0);
        double rate = interrupts / hours;
        c[0] = intrusions == 0 && rate <= 1 ? 4 : intrusions == 0 && rate <= 1.5 ? 3 : intrusions <= 1 && rate <= 2
                ? 2 : intrusions <= 3 ? 1 : 0;

        // 2 The right moment: 90% of cards at a break (or about to expire), a heads-up on every non-expiring interrupt.
        int cards = 0;
        int good = 0;
        int needHeads = 0;
        for (Visual v : log.visuals) {
            if ("interrupt".equals(v.what()) || "offer".equals(v.what())) {
                cards++;
                if (v.atBreak() || v.expiring()) {
                    good++;
                }
                if ("interrupt".equals(v.what()) && !v.expiring()) {
                    needHeads++;
                }
            }
        }
        double share = cards == 0 ? 1 : good / (double) cards;
        boolean heads = !shield ? needHeads == 0 : log.headsUps >= needHeads;
        c[1] = share >= 0.9 && heads ? 4 : share >= 0.75 ? 3 : share >= 0.5 ? 2 : share >= 0.25 ? 1 : 0;

        // 3 Close first: of two things waiting at the same time, the one an EA would bring sooner comes first
        // (Kendall's tau over pairs whose waits overlap; arrivals while the member couldn't be reached start at their
        // return).
        List<long[]> waits = new ArrayList<>();
        List<In> waitIn = new ArrayList<>();
        for (In i : day.incoming()) {
            Long r = log.reached.get(i.id());
            if (r != null && !"acted".equals(log.how.get(i.id()))) {
                waits.add(new long[] {RANKS.indexOf(i.label().ideal()), effective(day, i), r});
                waitIn.add(i);
            }
        }
        List<String> discordant = new ArrayList<>();
        long conc = 0;
        long disc = 0;
        for (int a = 0; a < waits.size(); a++) {
            for (int b = a + 1; b < waits.size(); b++) {
                long[] x = waits.get(a);
                long[] y = waits.get(b);
                if (x[0] == y[0] || Math.abs(x[2] - y[2]) < MIN) {
                    continue;
                }
                // Both waiting at once: each arrived before the other was reached.
                if (x[1] > y[2] || y[1] > x[2]) {
                    continue;
                }
                long[] hi = x[0] < y[0] ? x : y;
                long[] lo = hi == x ? y : x;
                if (hi[2] < lo[2]) {
                    conc++;
                } else {
                    disc++;
                    if (discordant.size() < 4) {
                        In hiIn = hi == x ? waitIn.get(a) : waitIn.get(b);
                        In loIn = hi == x ? waitIn.get(b) : waitIn.get(a);
                        discordant.add(hiIn.id() + "/" + hiIn.label().ideal() + "@" + ShieldReplay.clock(hi[2]) + " by "
                                + log.how.get(hiIn.id()) + " after " + loIn.id() + "/" + loIn.label().ideal() + "@"
                                + ShieldReplay.clock(lo[2]) + " by " + log.how.get(loIn.id()));
                    }
                }
            }
        }
        double tau = conc + disc == 0 ? 1 : (conc - disc) / (double) (conc + disc);
        c[2] = tau >= 0.6 ? 4 : tau >= 0.4 ? 3 : tau >= 0.2 ? 2 : tau >= 0 ? 1 : 0;
        notes.add(String.format(Locale.ROOT, "tau %.2f over %d pairs", tau, conc + disc));
        if (tau < 0.6) {
            notes.add("discordant " + discordant);
        }
        notes.add(String.format(Locale.ROOT, "%d interrupts, %.2f an hour, %d intrusions", interrupts, rate,
                intrusions));

        // 4 Packaged like a staff secretary: what, why now under 10 words, the one thing first, the source; calm words.
        int bad = 0;
        if (shield) {
            for (Map<String, Object> card : log.cards) {
                String what = str(card.get("what"));
                String why = str(card.get("why"));
                if (what.isBlank() || why.isBlank() || str(card.get("goLabel")).isBlank()
                        || str(card.get("source")).isBlank() || why.split("\\s+").length >= 10
                        || ((List<?>) card.get("choices")).size() > 3 || noisy(what) || noisy(why)
                        || noisy(str(card.get("source")))) {
                    bad++;
                    notes.add("packaging " + card);
                }
            }
            for (Map<String, Object> cu : log.catchups) {
                if (!Rhythm.END.equals(cu.get("end")) || noisy(str(cu.get("head")).replace("nothing urgent", ""))) {
                    bad++;
                }
                for (Map<String, Object> g : (List<Map<String, Object>>) cu.get("groups")) {
                    for (Map<String, Object> item : (List<Map<String, Object>>) g.get("items")) {
                        if (noisy(str(item.get("line")))) {
                            bad++;
                        }
                    }
                }
            }
            c[3] = bad == 0 ? 4 : bad <= 2 ? 3 : bad <= 5 ? 2 : bad <= 10 ? 1 : 0;
        }

        // 5 The switch made cheap: every interrupt the member took offers Back with a ready-to-resume line.
        if (shield) {
            double backs = log.interruptsTaken == 0 ? 1 : Math.min(1, log.backsGood / (double) log.interruptsTaken);
            c[4] = backs >= 0.9 ? 4 : backs >= 0.75 ? 3 : backs >= 0.5 ? 2 : 1;
            if (backs < 0.9) {
                notes.add("backs " + log.backsGood + " of " + log.interruptsTaken);
            }
        }

        // 6 A calm rhythm: catch-ups at most 7 lines ending "That's all for now.", empty ones silent, the line always.
        if (shield) {
            int v = log.emptyCatchups + (log.lineAlways ? 0 : 1);
            for (String s : log.violations) {
                if (s.startsWith("catch-up")) {
                    v++;
                }
            }
            c[5] = v == 0 ? 4 : v == 1 ? 3 : v <= 3 ? 2 : 0;
        } else {
            c[5] = 0;
        }

        // 7 Learned without overreaching: Tuesday's corrections hold on Wednesday; nothing learned crossed the gate.
        if (shield) {
            if (day.index() < 2) {
                c[6] = 4;
            } else {
                c[6] = log.cardsForHeldClass == 0 ? (g1 ? 4 : 1) : 1;
                if (log.cardsForHeldClass > 0) {
                    notes.add("held class carded " + log.cardsForHeldClass);
                }
            }
        }

        // 8 Documents: only linked documents offered at breaks, records never on a card, at most 3 per catch-up.
        if (shield) {
            int dv = 0;
            for (Map<String, Object> card : log.cards) {
                if ("doc".equals(card.get("kind"))) {
                    In i = byItemId(day, (String) card.get("itemId"));
                    if (i == null || "records".equals(i.place())
                            || "offer".equals(card.get("level")) && i.label().related() == null) {
                        dv++;
                        notes.add("doc card " + (i == null ? card.get("itemId") : i.id() + " " + i.place()));
                    }
                }
            }
            for (Map<String, Object> cu : log.catchups) {
                int docs = 0;
                for (Map<String, Object> g : (List<Map<String, Object>>) cu.get("groups")) {
                    for (Map<String, Object> item : (List<Map<String, Object>>) g.get("items")) {
                        In i = byItemId(day, (String) item.get("itemId"));
                        if (i != null && "doc".equals(i.type())) {
                            docs++;
                        }
                    }
                }
                if (docs > 3) {
                    dv++;
                }
            }
            c[7] = dv == 0 ? 4 : dv == 1 ? 3 : dv <= 3 ? 2 : 0;
        }
        return new Score(g1, g2, c, notes);
    }

    /**
     * When an item could first reach the member: its arrival, or their next presence when they weren't there and the
     * bell can't bring it (quiet hours for anything not "any time"): the fair start for "how soon".
     */
    static long effective(ShieldScenarios.Day day, In i) {
        if (present(day, i.at()) || "interrupt".equals(i.label().ideal()) && !quietAt(day, i.at())) {
            return i.at();
        }
        for (long x = i.at(); x < i.at() + 20 * 60 * MIN; x += MIN) {
            if (present(day, x)) {
                return x;
            }
        }
        return i.at();
    }

    static boolean quietAt(ShieldScenarios.Day day, long t) {
        java.time.LocalTime lt = java.time.Instant.ofEpochMilli(t).atZone(ShieldScenarios.ZONE).toLocalTime();
        java.util.List<java.time.LocalTime> c = day.settings().catchUps();
        java.time.LocalTime first = c.size() < 2 ? java.time.LocalTime.of(9, 0) : c.get(0);
        java.time.LocalTime last = c.size() < 2 ? java.time.LocalTime.of(17, 0) : c.get(c.size() - 1);
        java.time.LocalTime from = last.plusHours(2);
        return from.isBefore(first) ? !lt.isBefore(from) && lt.isBefore(first) : !lt.isBefore(from)
                || lt.isBefore(first);
    }

    /** An item's latest time; one held while the member was away (or in quiet hours) may wait for their return. */
    static long latest(ShieldScenarios.Day day, In i) {
        long latest = i.label().latestAt();
        boolean bellable = "interrupt".equals(i.label().ideal()) && !quietAt(day, i.at());
        if (!present(day, i.at()) && !bellable) {
            long back = effective(day, i);
            if (back > i.at()) {
                latest = Math.max(latest, back + (latest - i.at()));
            }
        }
        if ("interrupt".equals(i.label().ideal())) {
            // Nothing reaches the member during a call, and a second interrupt waits out the 15 minutes (concept §5.3):
            // an EA's latest moves by the call and that one wait. Never past the item's own deadline.
            long hard = i.until() > 0 && !"failed".equals(i.type()) ? i.until() - 2 * MIN : Long.MAX_VALUE;
            return Math.min(hard, latest + callOverlap(day, i.at(), latest) + 15 * MIN);
        }
        // The member isn't there at the latest time: until 30 minutes after they're next present.
        long t = latest;
        if (!present(day, t)) {
            for (long x = t; x < t + 20 * 60 * MIN; x += 5 * MIN) {
                if (present(day, x)) {
                    return Math.max(latest, x + 30 * MIN);
                }
            }
            return Long.MAX_VALUE;
        }
        return latest;
    }

    static long callOverlap(ShieldScenarios.Day day, long from, long to) {
        long n = 0;
        for (ShieldScenarios.Block b : day.blocks()) {
            if ("call".equals(b.mode())) {
                long a = Math.max(from, b.from());
                long z = Math.min(to + 30 * MIN, Math.min(b.to(), b.from() + 30 * MIN));
                n += Math.max(0, z - a);
            }
        }
        return n;
    }

    static boolean present(ShieldScenarios.Day day, long t) {
        return ShieldReplay.truth(day, t, List.of()).present();
    }

    static In byItemId(ShieldScenarios.Day day, String itemId) {
        ShieldReplay.World w = new ShieldReplay.World(day);
        for (In i : day.incoming()) {
            for (long t : new long[] {i.at(), i.at() + 3 * 60 * MIN}) {
                if (Attention.id(w.key(i, t)).equals(itemId)) {
                    return i;
                }
            }
        }
        return null;
    }

    /** Words the shield never uses: "urgent", "important!", "don't miss", an exclamation mark, "Maia Mode", "shield". */
    static boolean noisy(String s) {
        String l = s.toLowerCase(Locale.ROOT);
        return l.contains("urgent") || l.contains("important!") || l.contains("don't miss") || l.contains("!")
                || l.contains("maia mode") || l.contains("shield");
    }

    static String str(Object o) {
        return o == null ? "" : String.valueOf(o);
    }
}
