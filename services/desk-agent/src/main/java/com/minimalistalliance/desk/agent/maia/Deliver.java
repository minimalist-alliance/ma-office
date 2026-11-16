package com.minimalistalliance.desk.agent.maia;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The shield's delivery rules (the shield concept §5, §7): four levels, what each state lets through, the budgets and
 * caps, and a card's words. <b>Interrupt</b> is the gate only (a code-rule Now or a let-through match); <b>offer</b> is
 * distance 40 or less at a fine break, 60 or less at a coarse one, 20 or less in focus hours; <b>periphery</b> 61 to
 * 85 (counted, listed, at the next catch-up); <b>hold</b> over 85, anything learned "Not important" and Work or
 * Personal outside its hours (counted, in the catch-up's tail). Nothing appears while the member types or is on a call.
 * Pure: {@link Shield} keeps the state and calls these.
 */
public final class Deliver {

    public enum Level { INTERRUPT, OFFER, PERIPHERY, HOLD }

    public static final int OFFER_FINE = 40;
    public static final int OFFER_COARSE = 60;
    public static final int OFFER_DEEP = 20;
    public static final int PERIPHERY_MAX = 85;
    public static final long MINUTE = 60_000L;
    /** At most one interrupt every 15 minutes (built in {@link Attention}, kept). */
    public static final long INTERRUPT_EVERY = 15 * MINUTE;
    /**
     * The usual spacing between interrupts, tuned by the scenario-day evals (concept §13: every number is a starting
     * value): a card may carry what came meanwhile ({@link #MORE_MAX}), and an item whose deadline can't wait it out
     * still comes after {@link #INTERRUPT_EVERY}.
     */
    public static final long INTERRUPT_SPACING = 30 * MINUTE;
    /** A deadline item (not a person) waits for a coarse break until this close to its deadline (eval-tuned). */
    public static final long JUST_IN_TIME = 25 * MINUTE;
    /** The heads-up before a non-expiring interrupt: the interruption lag that lets people encode where they were. */
    public static final long HEADS_UP_MS = 8_000L;
    /** An untouched offer tucks back after this. */
    public static final long TUCK_MS = 20_000L;
    /** In steady work an interrupt waits this long for a fine break, then takes the next pause. */
    public static final long STEADY_WAIT = 10 * MINUTE;
    /** In focus hours or a hold, the same, longer (a default: the concept leaves it at "at a fine break"). */
    public static final long DEEP_WAIT = 30 * MINUTE;
    /** An item this close to its deadline skips the wait for a break (never typing or a call). */
    public static final long EXPIRING = 10 * MINUTE;
    /** The deadline floor: with no catch-up before its deadline, an item is offered once it's this close. */
    public static final long FLOOR = 3 * 60 * MINUTE;
    public static final int OFFERS_PER_HOUR = 3;
    public static final int OFFERS_PER_DAY = 10;
    /** Back shows this long after the one thing is done. */
    public static final long BACK_FOR = 60_000L;
    /** Not back on the task in this long: a pick-up. */
    public static final long PICKUP_AFTER = 2 * MINUTE;
    /** Other interrupt-level items that ride on one interrupt card. */
    public static final int MORE_MAX = 2;
    /** The card's shrink after Not now. */
    public static final long AFTER_FOR = 5_000L;

    private Deliver() {}

    /** The level an item's score and learned rules give it, before the moment decides. */
    public static Level level(Reach.Score s, Learn.Effect e) {
        if (s.gate()) {
            return Level.INTERRUPT;
        }
        if (s.partitioned() || e.hold()) {
            return Level.HOLD;
        }
        if (s.distance() <= OFFER_COARSE) {
            return e.catchupsOnly() ? Level.PERIPHERY : Level.OFFER;
        }
        if (s.distance() <= PERIPHERY_MAX) {
            return Level.PERIPHERY;
        }
        return Level.HOLD;
    }

    /** The largest distance an offer may have in this state and break, or -1 for no offers now. */
    public static int offerUpTo(Focus.State st, Focus.Kind brk) {
        return switch (st) {
            case FINE -> OFFER_FINE;
            case COARSE -> OFFER_COARSE;
            case DEEP -> brk == Focus.Kind.FINE || brk == Focus.Kind.COARSE ? OFFER_DEEP : -1;
            default -> -1;
        };
    }

    /**
     * Whether an interrupt may show now (concept §5.2): never while typing, on a call or away; in quiet hours only
     * code-rule Now and "any time" entries; one that would expire first skips the wait for a break; otherwise at a
     * break, or after waiting {@link #STEADY_WAIT} (steady work) or {@link #DEEP_WAIT} (focus hours, a hold).
     */
    public static boolean interruptMay(Focus.State st, Focus.Kind brk, Reach.Score s, Rhythm.Day day,
            boolean expiring, long waitedMs) {
        if (st == Focus.State.AWAY || st == Focus.State.CALL || st == Focus.State.TYPING) {
            return false;
        }
        if (day.quiet() && !s.anyTime()) {
            return false;
        }
        if (expiring) {
            return true;
        }
        return switch (st) {
            case FINE, COARSE -> true;
            case HOLD, DEEP -> brk != null || waitedMs >= DEEP_WAIT;
            case STEADY -> waitedMs >= STEADY_WAIT;
            default -> false;
        };
    }

    /** The choices beside the one thing: 1 to 3, time choices only when the deadline allows, Not now where allowed. */
    public static List<Map<String, Object>> choices(Reach.Item item, Level level, long now, Long nextCatchUp,
            java.time.ZoneId zone) {
        List<Map<String, Object>> out = new ArrayList<>();
        Long deadline = item.deadlineAt();
        long left = deadline == null ? Long.MAX_VALUE : deadline - now;
        if (left > 30 * MINUTE) {
            out.add(choice("after_this", "After this"));
        }
        if (left > 40 * MINUTE) {
            out.add(choice("in_20", "In 20 min"));
        }
        if (nextCatchUp != null && (deadline == null || nextCatchUp < deadline) && level != Level.INTERRUPT) {
            out.add(choice("at_catchup", "At " + Rhythm.clock(nextCatchUp, zone)));
        }
        if (item.dismissable() && Attention.dismissable(item.kind())) {
            out.add(choice("not_now", "Not now"));
        }
        // At most two beside the one thing, Not now kept last when there is one.
        if (out.size() > 2) {
            Map<String, Object> notNow = out.stream().filter(c -> "not_now".equals(c.get("id"))).findFirst()
                    .orElse(null);
            List<Map<String, Object>> keep = new ArrayList<>();
            for (Map<String, Object> c : out) {
                if (c != notNow && keep.size() < (notNow == null ? 2 : 1)) {
                    keep.add(c);
                }
            }
            if (notNow != null) {
                keep.add(notNow);
            }
            return keep;
        }
        return out;
    }

    static Map<String, Object> choice(String id, String label) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("label", label);
        return m;
    }

    /** The one thing's label, by kind: Review, Open, Reply, See result. */
    public static String goLabel(Reach.Item item) {
        if (item.goLabel() != null) {
            return item.goLabel();
        }
        return switch (item.kind()) {
            case "approval" -> "Review";
            case "message" -> "Reply";
            case "result" -> "See result";
            case "desk_asleep" -> "Wake";
            default -> "Open";
        };
    }

    /** The held line's words (concept §8). */
    public static String heldLine(int held, int waitingNow) {
        if (held <= 0 && waitingNow <= 0) {
            return "All clear";
        }
        String n = held + " held";
        return waitingNow > 0 ? n + " · " + waitingNow + " needs you soon" : n + " · nothing urgent";
    }
}
