package com.minimalistalliance.desk.agent.maia;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * The focus shield's model of now (the shield concept §2; deskd {@code API.md} §23 "What reaches the member"): what the
 * member is doing, as structure only, from the office's {@code focus} block in {@code agent.maia.observe}: the desk and
 * app in front, the item's id, the people of the open thread, and input timing. <b>Ids and times only</b>: never a URL,
 * a title, a key or text; kept in memory on the home desk, never sent anywhere.
 *
 * <p>From it code computes one {@link State} at a time and the <b>breaks</b> (fine: one completed action and 5 s
 * without
 * input, the office's own check; coarse: between tasks), the moments the shield may deliver. Every break is an explicit
 * office event or a change of focus, never inferred from content. Pure functions over a {@link Tracker} the caller
 * keeps
 * ({@link Shield}), the way {@link Attention} is.
 */
public final class Focus {

    public static final long MINUTE = 60_000L;
    /** A key in this long is typing (today's {@code quietWhileTyping}). */
    public static final long TYPING_MS = 20_000L;
    /** No observe for this long: away (Phase 2's {@code Away.PRESENT_MS}). */
    public static final long AWAY_MS = 120_000L;
    /** A break stays open this long; then the shield delivers at most one card. */
    public static final long BREAK_MS = 20_000L;
    /** Back from at least this much idle or hidden time is a coarse break. */
    public static final long IDLE_MS = 2 * MINUTE;
    /** No break in the first minutes of a hold or a focus stretch. */
    public static final long SETTLE_MS = 10 * MINUTE;
    /** The working sphere: what the member dwelt on this long, in the last {@link #SPHERE_WINDOW_MS}. */
    public static final long DWELL_MS = 3 * MINUTE;
    public static final long SPHERE_WINDOW_MS = 30 * MINUTE;
    /** People of a thread or page in front this recently are "who you're working with". */
    public static final long PEOPLE_MS = 10 * MINUTE;
    /** Capacity is low after this much input with no 5-minute pause. */
    public static final long FLOW_LOW_MS = 90 * MINUTE;
    /** The phone stays quiet while an office device had input this recently (concept §2.5). */
    public static final long PHONE_QUIET_MS = 10 * MINUTE;
    static final int MAX_PEOPLE = 8;
    static final int MAX_EVENTS = 10;
    static final int MAX_DWELL = 200;
    static final int MAX_DEVICES = 8;

    static final Set<String> SURFACES = Set.of("room", "desk", "overview", "phone");
    static final Set<String> SCOPES = Set.of("personal", "work", "guild", "all");
    static final Set<String> APPS = Set.of("notebook", "courier", "todo", "files", "browser", "agent", "commons",
            "maia");
    static final Set<String> ITEM_KINDS = Set.of("page", "thread", "channel", "todo", "folder", "run");
    /** Completed actions: a fine break once 5 s pass with no input (the office checks the 5 s). */
    static final Set<String> FINE_EVENTS = Set.of("sent", "todo_checked", "approval_decided", "saved", "page_left");
    static final Set<String> COARSE_EVENTS = Set.of("window_closed");

    private Focus() {}

    /**
     * An item's id in an app: {@code page}, {@code thread}, {@code channel}, {@code todo}, {@code folder}, {@code
     * run}.
     */
    public record Ref(String kind, String id) {
        String key() {
            return kind + ":" + id;
        }
    }

    /** A person, as one desk's Courier knows them: never a name. */
    public record Person(String deskId, String contactId) {}

    /** A completed action the office saw. */
    public record Event(String kind, long at) {}

    /** The office's {@code focus} block, checked. */
    public record Now(String surface, String deskId, String scope, String app, Ref item, List<Person> people,
            boolean typing, boolean idle, long lastAt, long flowSince, boolean call, boolean share, boolean visible,
            String device, List<Event> events) {
        public Now {
            people = List.copyOf(people);
            events = List.copyOf(events);
        }

        /** Where the member's eyes are, for the working sphere: desk, app and item. */
        String place() {
            return deskId + "|" + app + "|" + (item == null ? "" : item.key());
        }

        boolean onPhone() {
            return "phone".equals(surface);
        }
    }

    public enum State { AWAY, CALL, TYPING, HOLD, DEEP, FINE, COARSE, STEADY }

    public enum Kind { FINE, COARSE }

    /** One stretch of looking at one place. */
    record Dwell(String deskId, String app, Ref item, long from, long to) {
        long length() {
            return to - from;
        }
    }

    /** The (desk, app, item) the member dwelt on for 3 minutes or more in the last 30, or null. */
    public record Sphere(String deskId, String app, Ref item) {}

    /**
     * What the shield keeps between observes, in memory only. Owned by {@link Shield} under its lock.
     */
    public static final class Tracker {
        Now now;
        /** Each device's latest picture and its last input: the member is where the latest input was. */
        final Map<String, Now> devices = new HashMap<>();
        final Map<String, Long> deviceInputAt = new HashMap<>();
        long observedAt;
        long typingAt;
        long idleSince = -1;
        long hiddenSince = -1;
        long breakUntil;
        Kind breakKind;
        String breakCause;
        long settleUntil;
        boolean wasDeep;
        boolean wasHold;
        boolean wasAway = true;
        boolean wasCall;
        long awaySince = -1;
        /** The place in front and since when. */
        String place;
        long placeSince;
        String placeDesk;
        String placeApp;
        Ref placeItem;
        final Deque<Dwell> dwell = new ArrayDeque<>();
        /** People of the places in front, and when they were last there. */
        final Map<Person, Long> peopleSeen = new HashMap<>();
        /** The member's last real input, from {@code lastAt} and the edges. */
        long lastInputAt;
        long flowSince;

        public Now now() {
            return now;
        }

        public String device() {
            return now == null ? null : now.device();
        }
    }

    // ---------------------------------------------------------------- parsing

    /**
     * The office's {@code focus} block, read leniently: a field out of shape is dropped (no item, no people), never an
     * error, so the rest of the observe still counts. Null when there's no block.
     */
    public static Now parse(Object raw, long now) {
        if (!(raw instanceof Map<?, ?> m)) {
            return null;
        }
        String surface = word(m.get("surface"), SURFACES, "desk");
        String scope = word(m.get("scope"), SCOPES, "all");
        boolean guild = "guild".equals(scope);
        String deskId = !guild && m.get("deskId") instanceof String d && Room.deskId(d) ? d : null;
        String app = guild ? null : app(m.get("app"));
        Ref item = null;
        if (!guild && !"browser".equals(app) && m.get("item") instanceof Map<?, ?> it
                && it.get("kind") instanceof String k && ITEM_KINDS.contains(k)
                && it.get("id") instanceof String id && id.matches("[A-Za-z0-9_:-]{1,80}")) {
            item = new Ref(k, id);
        }
        List<Person> people = new ArrayList<>();
        if (!guild && m.get("people") instanceof List<?> ps) {
            for (Object o : ps) {
                if (people.size() >= MAX_PEOPLE) {
                    break;
                }
                Person p = person(o);
                if (p != null && !people.contains(p)) {
                    people.add(p);
                }
            }
        }
        boolean typing = false;
        boolean idle = false;
        long lastAt = 0;
        long flowSince = 0;
        if (m.get("input") instanceof Map<?, ?> in) {
            typing = Boolean.TRUE.equals(in.get("typing"));
            idle = Boolean.TRUE.equals(in.get("idle"));
            lastAt = time(in.get("lastAt"), now);
            flowSince = time(in.get("flowSince"), now);
        }
        String device = m.get("device") instanceof String dv && dv.matches("dv-[a-z0-9]{8,32}") ? dv : "dv-unknown";
        List<Event> events = new ArrayList<>();
        if (m.get("events") instanceof List<?> es) {
            for (Object o : es) {
                if (events.size() >= MAX_EVENTS) {
                    break;
                }
                if (o instanceof Map<?, ?> e && e.get("kind") instanceof String k
                        && (FINE_EVENTS.contains(k) || COARSE_EVENTS.contains(k))) {
                    long at = time(e.get("at"), now);
                    events.add(new Event(k, at == 0 ? now : at));
                }
            }
        }
        return new Now(surface, deskId, scope, app, item, people, typing, idle, lastAt, flowSince,
                Boolean.TRUE.equals(m.get("call")), Boolean.TRUE.equals(m.get("share")),
                !Boolean.FALSE.equals(m.get("visible")), device, events);
    }

    static Person person(Object o) {
        if (o instanceof Map<?, ?> p && p.get("deskId") instanceof String d && Room.deskId(d)
                && p.get("contactId") instanceof String c && contactId(c)) {
            return new Person(d, c);
        }
        return null;
    }

    /** Courier's contact ids: 26-character ULIDs. */
    static boolean contactId(String s) {
        return s.matches("[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}");
    }

    static String app(Object o) {
        if (!(o instanceof String s)) {
            return null;
        }
        if (APPS.contains(s)) {
            return s;
        }
        if (s.matches("(agent|app):[A-Za-z0-9_.-]{1,64}")) {
            return s;
        }
        return null;
    }

    /** A time in ms, within a day of now (a clock far off is no time), else 0. */
    private static long time(Object o, long now) {
        if (o instanceof Number n) {
            long t = n.longValue();
            return Math.abs(t - now) <= 86_400_000L ? Math.min(t, now) : 0;
        }
        return 0;
    }

    private static String word(Object o, Set<String> allowed, String fallback) {
        return o instanceof String s && allowed.contains(s) ? s : fallback;
    }

    // ---------------------------------------------------------------- one observe

    /**
     * One picture from the office. Updates the tracker and returns the break it opened, if any. {@code deep} and
     * {@code hold} are whether the member's focus hours or a hold are on now (from {@link Rhythm} and the hold).
     */
    public static Kind observe(Tracker t, Now next, long now, boolean deep, boolean hold) {
        if (next == null) {
            t.observedAt = now;
            return null;
        }
        boolean wasAway = t.wasAway || (t.observedAt > 0 && now - t.observedAt >= AWAY_MS);
        long input = Math.max(next.lastAt(), next.typing() ? now : 0);
        t.deviceInputAt.merge(next.device(), Math.max(input, next.events().stream().mapToLong(Event::at).max()
                .orElse(0)), Math::max);
        t.devices.put(next.device(), next);
        if (t.devices.size() > MAX_DEVICES) {
            // At most a few devices: the one with the oldest input goes (Security's FS-L3).
            String oldest = null;
            for (String d : t.devices.keySet()) {
                if (oldest == null || t.deviceInputAt.getOrDefault(d, 0L) < t.deviceInputAt.getOrDefault(oldest, 0L)) {
                    oldest = d;
                }
            }
            t.devices.remove(oldest);
            t.deviceInputAt.remove(oldest);
        }
        // The member is where the latest input was; the phone only while no office device had input lately.
        Now front = front(t, now);
        Now before = t.now;
        t.observedAt = now;
        if (front != next) {
            // Another device is in front: this picture is kept, but breaks come only from where the member is.
            return null;
        }
        t.now = next;
        Kind opened = null;
        String cause = null;

        // Typing, as edges: a key in the last 20 s.
        if (next.typing()) {
            t.typingAt = now;
        }
        if (input > t.lastInputAt) {
            t.lastInputAt = input;
        }
        t.flowSince = next.flowSince();

        // Back from away, from idle, or from hidden: coarse.
        if (wasAway && t.observedAt > 0) {
            opened = Kind.COARSE;
            cause = "back";
        }
        if (next.idle()) {
            if (t.idleSince < 0) {
                t.idleSince = now;
            }
        } else if (t.idleSince >= 0) {
            // The office says idle only after 2 minutes without input: any return from it is a coarse break.
            opened = Kind.COARSE;
            cause = "idle_back";
            t.idleSince = -1;
        }
        if (!next.visible()) {
            if (t.hiddenSince < 0) {
                t.hiddenSince = now;
            }
        } else if (t.hiddenSince >= 0) {
            if (now - t.hiddenSince >= IDLE_MS) {
                opened = Kind.COARSE;
                cause = "visible";
            }
            t.hiddenSince = -1;
        }
        boolean callNow = next.call() || next.share();
        if (t.wasCall && !callNow) {
            opened = Kind.COARSE;
            cause = "call_ended";
        }
        t.wasCall = callNow;

        // A change of focus: the desk in front, the overview, the app or its item, her room.
        if (before != null && !wasAway) {
            if (!Objects.equals(before.deskId(), next.deskId()) && next.deskId() != null) {
                opened = Kind.COARSE;
                cause = "desk";
            } else if (!"overview".equals(before.surface()) && "overview".equals(next.surface())) {
                opened = Kind.COARSE;
                cause = "overview";
            } else if (!"room".equals(before.surface()) && "room".equals(next.surface())) {
                opened = Kind.COARSE;
                cause = "room";
            } else if (!Objects.equals(before.app(), next.app())
                    || (!Objects.equals(before.item(), next.item()) && before.item() != null)) {
                opened = Kind.COARSE;
                cause = "app";
            }
        }
        // The office's events: a window closed (coarse), a completed action with 5 s quiet after it (fine).
        for (Event e : next.events()) {
            if (COARSE_EVENTS.contains(e.kind())) {
                opened = Kind.COARSE;
                cause = e.kind();
            } else if (FINE_EVENTS.contains(e.kind()) && opened == null) {
                opened = Kind.FINE;
                cause = e.kind();
            }
        }
        // A hold or the focus hours ending is a coarse break too.
        String edge = edges(t, now, deep, hold);
        if (edge != null && opened == null) {
            opened = Kind.COARSE;
            cause = edge;
        }
        // The people the member works with: those of the places in front lately, for closeness by person.
        for (Person p : next.people()) {
            t.peopleSeen.put(p, now);
        }
        t.peopleSeen.values().removeIf(at -> now - at > PEOPLE_MS);
        // The working sphere: close the last stretch, start a new one.
        dwellTo(t, next, now);
        if (wasAway) {
            t.wasAway = false;
            t.awaySince = -1;
        }
        return open(t, opened, cause, now, deep, hold);
    }

    /** The clock moved with no observe: away after 2 minutes; a hold or the focus hours ending is a coarse break. */
    public static Kind tick(Tracker t, long now, boolean deep, boolean hold) {
        Kind opened = null;
        String cause = null;
        if (t.observedAt > 0 && now - t.observedAt >= AWAY_MS && !t.wasAway) {
            t.wasAway = true;
            t.awaySince = t.observedAt + AWAY_MS;
        }
        String edge = edges(t, now, deep, hold);
        if (edge != null) {
            opened = Kind.COARSE;
            cause = edge;
        }
        if (opened != null && !t.wasAway) {
            return open(t, opened, cause, now, deep, hold);
        }
        return null;
    }

    /**
     * A hold or the focus hours starting (10 minutes with no break) or ending (a coarse break): the edge's cause, or
     * null. Both {@link #observe} and {@link #tick} see edges, whichever comes first.
     */
    private static String edges(Tracker t, long now, boolean deep, boolean hold) {
        String cause = null;
        if (t.wasDeep && !deep) {
            cause = "deep_ended";
        }
        if (t.wasHold && !hold) {
            cause = "hold_ended";
        }
        if (!t.wasDeep && deep || !t.wasHold && hold) {
            t.settleUntil = Math.max(t.settleUntil, now + SETTLE_MS);
        }
        t.wasDeep = deep;
        t.wasHold = hold;
        return cause;
    }

    private static Kind open(Tracker t, Kind kind, String cause, long now, boolean deep, boolean hold) {
        if (kind == null || now < t.settleUntil) {
            return null;
        }
        // A coarse break never shrinks to a fine one while it's open.
        if (t.breakKind == Kind.COARSE && now < t.breakUntil && kind == Kind.FINE) {
            return null;
        }
        t.breakKind = kind;
        t.breakCause = cause;
        t.breakUntil = now + BREAK_MS;
        return kind;
    }

    /** The device the member is at: the latest input, the phone only while no office device had input in 10 min. */
    static Now front(Tracker t, long now) {
        Now best = null;
        long bestAt = Long.MIN_VALUE;
        long officeAt = Long.MIN_VALUE;
        for (Map.Entry<String, Now> e : t.devices.entrySet()) {
            long at = t.deviceInputAt.getOrDefault(e.getKey(), 0L);
            if (!e.getValue().onPhone()) {
                officeAt = Math.max(officeAt, at);
            }
        }
        for (Map.Entry<String, Now> e : t.devices.entrySet()) {
            long at = t.deviceInputAt.getOrDefault(e.getKey(), 0L);
            if (e.getValue().onPhone() && officeAt != Long.MIN_VALUE && now - officeAt < PHONE_QUIET_MS) {
                continue;
            }
            if (best == null || at > bestAt || (at == bestAt && e.getKey().compareTo(best.device()) < 0)) {
                best = e.getValue();
                bestAt = at;
            }
        }
        return best;
    }

    private static void dwellTo(Tracker t, Now next, long now) {
        String place = next.deskId() == null || next.app() == null ? null : next.place();
        if (Objects.equals(place, t.place)) {
            return;
        }
        if (t.place != null) {
            // The stretch just ended goes into the record.
            t.dwell.addLast(new Dwell(t.placeDesk, t.placeApp, t.placeItem, t.placeSince, now));
            while (t.dwell.size() > MAX_DWELL) {
                t.dwell.removeFirst();
            }
        }
        t.place = place;
        t.placeSince = now;
        t.placeDesk = next.deskId();
        t.placeApp = next.app();
        t.placeItem = next.item();
    }

    // ---------------------------------------------------------------- reading the tracker

    /** The one state now, first match wins (concept §2.2). */
    public static State state(Tracker t, long now, boolean deep, boolean hold) {
        if (t.now == null || t.observedAt == 0 || now - t.observedAt >= AWAY_MS || t.wasAway) {
            return State.AWAY;
        }
        if (t.now.call() || t.now.share()) {
            return State.CALL;
        }
        if (typing(t, now)) {
            return State.TYPING;
        }
        if (t.now.onPhone()) {
            // The phone is opened to look: while it's in front and nobody's typing, it's a moment between tasks.
            return hold ? State.HOLD : State.FINE;
        }
        if (hold) {
            return State.HOLD;
        }
        if (deep) {
            return State.DEEP;
        }
        Kind b = breakOpen(t, now);
        if (b == Kind.FINE) {
            return State.FINE;
        }
        if (b == Kind.COARSE) {
            return State.COARSE;
        }
        return State.STEADY;
    }

    public static boolean typing(Tracker t, long now) {
        return t.now != null && t.now.typing() && now - t.typingAt < TYPING_MS;
    }

    /** The break open now, or null. */
    public static Kind breakOpen(Tracker t, long now) {
        if (t.now != null && t.now.onPhone() && !typing(t, now) && now - t.observedAt < AWAY_MS) {
            return t.breakKind != null && now < t.breakUntil ? t.breakKind : Kind.FINE;
        }
        return t.breakKind != null && now < t.breakUntil && now >= t.settleUntil ? t.breakKind : null;
    }

    /** The break is used: at most one card a break. */
    public static void closeBreak(Tracker t) {
        t.breakUntil = 0;
        t.breakKind = null;
    }

    /** The working sphere now: the place dwelt on 3 minutes or more in the last 30 (the current stretch counts). */
    public static Sphere sphere(Tracker t, long now) {
        Map<String, Long> totals = new LinkedHashMap<>();
        Map<String, Sphere> spheres = new HashMap<>();
        long since = now - SPHERE_WINDOW_MS;
        for (Dwell d : t.dwell) {
            if (d.to() < since || d.deskId() == null || d.app() == null) {
                continue;
            }
            String key = d.deskId() + "|" + d.app() + "|" + (d.item() == null ? "" : d.item().key());
            totals.merge(key, d.to() - Math.max(d.from(), since), Long::sum);
            spheres.put(key, new Sphere(d.deskId(), d.app(), d.item()));
        }
        if (t.place != null && t.now != null && t.now.deskId() != null && t.now.app() != null) {
            totals.merge(t.place, now - Math.max(t.placeSince, since), Long::sum);
            spheres.put(t.place, new Sphere(t.now.deskId(), t.now.app(), t.now.item()));
        }
        String best = null;
        long bestMs = DWELL_MS - 1;
        for (Map.Entry<String, Long> e : totals.entrySet()) {
            // Ties go to the current place, then the latest.
            if (e.getValue() > bestMs || (e.getValue() == bestMs && e.getKey().equals(t.place))) {
                best = e.getKey();
                bestMs = e.getValue();
            }
        }
        return best == null ? null : spheres.get(best);
    }

    /**
     * Up to {@code max} item refs the member dwelt on most in the last {@code windowMs}, for {@code working_on}: code
     * picks them, so her model never sees an id.
     */
    public static List<Sphere> recent(Tracker t, long now, long windowMs, int max) {
        Map<String, Long> totals = new LinkedHashMap<>();
        Map<String, Sphere> spheres = new HashMap<>();
        long since = now - windowMs;
        List<Dwell> all = new ArrayList<>(t.dwell);
        if (t.place != null && t.now != null && t.now.deskId() != null && t.now.app() != null) {
            all.add(new Dwell(t.now.deskId(), t.now.app(), t.now.item(), t.placeSince, now));
        }
        for (Dwell d : all) {
            if (d.to() < since || d.item() == null || d.deskId() == null) {
                continue;
            }
            String key = d.deskId() + "|" + d.app() + "|" + d.item().key();
            totals.merge(key, d.to() - Math.max(d.from(), since), Long::sum);
            spheres.put(key, new Sphere(d.deskId(), d.app(), d.item()));
        }
        return totals.entrySet().stream().sorted(Map.Entry.<String, Long>comparingByValue().reversed()).limit(max)
                .map(e -> spheres.get(e.getKey())).toList();
    }

    /** The people the member has worked with in the last 10 minutes (the place in front's, and the ones before). */
    public static List<Person> people(Tracker t, long now) {
        List<Person> out = new ArrayList<>();
        for (Map.Entry<Person, Long> e : t.peopleSeen.entrySet()) {
            if (now - e.getValue() <= PEOPLE_MS) {
                out.add(e.getKey());
            }
        }
        return out;
    }

    /** Minutes the member has had input with no 5-minute pause (0 when unknown). */
    static long flowMs(Tracker t, long now) {
        return t.flowSince > 0 ? Math.max(0, now - t.flowSince) : 0;
    }

    /** The place in front's start: "last change" for the ready-to-resume line. */
    static long placeSince(Tracker t) {
        return t.placeSince;
    }
}
