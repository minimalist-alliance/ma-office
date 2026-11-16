package com.minimalistalliance.desk.agent.provider.ma;

import java.time.Clock;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * The member's one credits wallet, as the last answer from either of MA's services said it (the coordinator's decision of
 * Nov 15: one wallet per member for Desk Maia and their agents on MA's credits; ma-platform {@code desk-maia.md} 0.4.10 and
 * {@code desk-helpers.md}). The tier's monthly Maia allowance (it renews each billing month and doesn't roll over), the
 * one-time starting credits and any top-ups land in one balance, spent month first, then starting, then top-ups; the day and
 * week amounts pace the whole wallet and never lock it; past everything, the lighter model on one daily share for the tier.
 *
 * <p>Desk Maia's answers ({@link MaiaServiceProvider}) and her agents' ({@link HelperServiceProvider}) both report here; the
 * newest wins. The room, her note and the team view read {@link #latest()}. Whole credits, never money: the credit's
 * dollar value is the Platform's setting and never reaches a desk. A view whose month has renewed is stale (what's left is
 * unknown until the next answer) and isn't returned.
 */
public final class CreditsWallet {

    /**
     * Where an answer drew from: the month's, the starting credits, top-ups, the lighter model past them all, or {@code none}
     * (nothing left and no lighter share for the tier: Free, unpaid).
     */
    public static final Set<String> DRAWING = Set.of("day", "week", "month", "starting", "topUp", "lighter", "none");
    /** The most one count may say: past it, the answer is out of its shape. */
    static final long MAX = 1_000_000_000L;

    /**
     * The wallet, whole credits. {@code left}: everything usable now. {@code month}/{@code monthLeft}: the monthly part (0
     * for a tier without one). {@code week}/{@code weekUsed}, {@code day}/{@code dayUsed}: the pace amounts. {@code
     * starting}, {@code topUp}: what's left of each. {@code drawingFrom}: {@link #DRAWING}, or null for a word this desk
     * doesn't know. {@code lighter}: everything is used and the lighter model answers, {@code lighterLeft} of today's share
     * left. {@code renewsAt}: when the monthly part renews (null for a tier without one, when not said). {@code source}:
     * {@code maia} or {@code helpers}; {@code at}: when the desk heard it.
     */
    public record View(long left, long month, long monthLeft, long week, long weekUsed, long day, long dayUsed,
            long starting, long topUp, String drawingFrom, boolean lighter, Long lighterLeft, Instant renewsAt,
            String source, Instant at) {

        /** Nothing left and no lighter share for the tier: a plain "used up", never the lighter model. */
        public boolean usedUp() {
            return "none".equals(drawingFrom);
        }

        /** The room's and the Keys list's shape: whole credits, never money. */
        public Map<String, Object> view() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("left", left);
            m.put("month", month);
            m.put("monthLeft", monthLeft);
            m.put("week", week);
            m.put("weekUsed", weekUsed);
            m.put("day", day);
            m.put("dayUsed", dayUsed);
            m.put("starting", starting);
            m.put("topUpLeft", topUp);
            m.put("drawingFrom", drawingFrom);
            m.put("lighter", lighter);
            if (lighterLeft != null) {
                m.put("lighterLeft", lighterLeft);
            }
            if (renewsAt != null) {
                m.put("renewsAt", renewsAt.toString());
            }
            return m;
        }
    }

    private final Clock clock;
    private volatile View latest;

    public CreditsWallet(Clock clock) {
        this.clock = clock;
    }

    /** A service's answer said this: kept unless a newer one is already held. */
    public void report(View v) {
        if (v == null) {
            return;
        }
        synchronized (this) {
            View held = latest;
            if (held == null || !v.at().isBefore(held.at())) {
                latest = v;
            }
        }
    }

    /** The newest view from either service, or null before any and once its month has renewed. */
    public View latest() {
        View v = latest;
        if (v != null && v.renewsAt() != null && !clock.instant().isBefore(v.renewsAt())) {
            return null;
        }
        return v;
    }

    /**
     * A wallet from a service's {@code credits} object (contract 0.4.10: {@code {left, month, monthLeft, starting, topUp,
     * topUpLeft, day, dayUsed, week, weekUsed, drawingFrom, lighter, lighterLeft?, renewsAt}}, the same object from both
     * services), read leniently: {@code left} is needed, and a wallet's own field ({@code month} or {@code drawingFrom}) or a
     * renewal given (Desk Maia's {@code allowance.resetsAt}), so an older helpers' answer (0.4.9: left, starting, topUp) isn't
     * taken for the wallet. The renewal is the object's {@code renewsAt}, else the one given. The rest default to 0. Null out
     * of shape.
     */
    public static View parse(Object raw, Instant renewsAt, boolean lighter, Long lighterLeft, String source, Instant at) {
        if (!(raw instanceof Map<?, ?> c)) {
            return null;
        }
        Long left = whole(c.get("left"));
        Instant renews = c.get("renewsAt") instanceof String s ? instant(s) : renewsAt;
        boolean walletShape = c.containsKey("month") || c.containsKey("drawingFrom") || renewsAt != null;
        if (left == null || !walletShape) {
            return null;
        }
        long month = orZero(c.get("month"));
        String drawing = c.get("drawingFrom") instanceof String d && DRAWING.contains(d) ? d : null;
        Long lighterHere = c.get("lighterLeft") instanceof Number ? whole(c.get("lighterLeft")) : lighterLeft;
        boolean light = !"none".equals(drawing)
                && (lighter || Boolean.TRUE.equals(c.get("lighter")) || "lighter".equals(drawing));
        long topUp = c.containsKey("topUpLeft") ? orZero(c.get("topUpLeft")) : orZero(c.get("topUp"));
        return new View(left, month, Math.min(orZero(c.get("monthLeft")), month), orZero(c.get("week")),
                orZero(c.get("weekUsed")), orZero(c.get("day")), orZero(c.get("dayUsed")), orZero(c.get("starting")),
                topUp, drawing, light, light ? lighterHere : null, renews, source, at);
    }

    static Long whole(Object raw) {
        if (!(raw instanceof Number n)) {
            return null;
        }
        double v = n.doubleValue();
        return v >= 0 && v <= MAX ? (long) Math.floor(v) : null;
    }

    static long orZero(Object raw) {
        Long v = whole(raw);
        return v == null ? 0 : v;
    }

    static Instant instant(String at) {
        if (at == null || at.length() > 40) {
            return null;
        }
        try {
            return Instant.parse(at);
        } catch (DateTimeParseException e) {
            return null;
        }
    }
}
