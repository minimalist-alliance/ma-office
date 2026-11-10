package com.minimalistalliance.desk.agent.limits;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.json.JsonFormatException;
import java.nio.charset.StandardCharsets;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The limits members set (design 9.9), split the way they apply: the agent scopes ({@code agentDay},
 * {@code agentWeek}, {@code agentMonth}, {@code run}, {@code runMaxSteps}) per agent, and {@code deskDay},
 * {@code deskMonth}, {@code keyMonth} and the time zone once for the whole desk, since every agent spends against them.
 * A client sees one {@link LimitPolicy} per agent, with the desk's values in it (task 07's ask 2).
 *
 * <p><b>Three values layer</b> (ADR 0043): {@code deskDay}, {@code deskMonth} and the time zone go desk, then account,
 * then default. A {@link Layer} holds one layer's, with null for "nothing here", which is apart from a {@link Limit}
 * with both caps null, "no limit, set here". Only what the member set is kept as the desk's, so a desk with nothing set
 * follows its account.
 *
 * <p>Held in memory, and saved in the agent store by whoever sets it ({@code agent.limits.set}); nothing an agent
 * proposes can reach it. The account's layer comes from deskd on each connection, and isn't saved.
 */
public final class LimitSettings {

    private static final Logger log = LoggerFactory.getLogger(LimitSettings.class);
    private static final String OWN = "own";
    private static final String UTC = "UTC";

    /** The scopes that belong to one agent. */
    public record AgentLimits(Limit day, Limit week, Limit month, Limit run, int runMaxSteps) {

        public AgentLimits {
            Objects.requireNonNull(day);
            Objects.requireNonNull(week);
            Objects.requireNonNull(month);
            Objects.requireNonNull(run);
            if (runMaxSteps < 1) {
                throw new IllegalArgumentException("runMaxSteps must be positive");
            }
        }

        public static AgentLimits of(LimitPolicy policy) {
            return new AgentLimits(policy.agentDay(), policy.agentWeek(), policy.agentMonth(), policy.run(),
                    policy.runMaxSteps());
        }

        public String toJson() {
            Map<String, Object> json = new LinkedHashMap<>();
            json.put("day", limitJson(day));
            json.put("week", limitJson(week));
            json.put("month", limitJson(month));
            json.put("run", limitJson(run));
            json.put("runMaxSteps", runMaxSteps);
            return new String(Json.bytes(json), StandardCharsets.UTF_8);
        }

        /** @throws IllegalArgumentException if it isn't what {@link #toJson} writes */
        public static AgentLimits fromJson(String text) {
            Map<String, Object> json = parse(text);
            if (!(json.get("runMaxSteps") instanceof Number steps)) {
                throw new IllegalArgumentException("bad agent limits");
            }
            return new AgentLimits(limit(json, "day"), limit(json, "week"), limit(json, "month"), limit(json, "run"),
                    steps.intValue());
        }
    }

    /** What one layer says of the values that layer: desk, then account, then default. Null says nothing. */
    public record Layer(Limit deskDay, Limit deskMonth, String timeZone) {
        public static final Layer EMPTY = new Layer(null, null, null);

        /** This layer as a client and the store see it, each field null when nothing is set. */
        public Map<String, Object> toMap() {
            Map<String, Object> json = new LinkedHashMap<>();
            json.put("deskDay", deskDay == null ? null : limitJson(deskDay));
            json.put("deskMonth", deskMonth == null ? null : limitJson(deskMonth));
            json.put("timeZone", timeZone);
            return json;
        }
    }

    /**
     * The scopes the whole desk shares, as this desk has them.
     *
     * <p><b>Stored</b> as setting {@code limits.desk}, read by this version and by an older desk-agent after a rollback:
     * <pre>{@code {"deskMonth": {...}, "keyMonth": {...}, "own": {"deskDay": ..., "deskMonth": ..., "timeZone": ...}}}</pre>
     * An older one requires the top-level {@code deskMonth} and {@code keyMonth}, fails to start without them, and
     * ignores {@code own}. So the top-level {@code deskMonth} is always there, holding the value in force when this was
     * saved, and {@code own} is what this desk has set. With no {@code own}, the row was written by an older one, and
     * its {@code deskMonth} counts as this desk's own.
     *
     * @param own this desk's layer
     */
    public record DeskLimits(Layer own, Limit keyMonth) {

        public DeskLimits {
            Objects.requireNonNull(own);
            Objects.requireNonNull(keyMonth);
        }

        /** @param deskMonthInForce what an older desk-agent should enforce after a rollback */
        public String toJson(Limit deskMonthInForce) {
            Map<String, Object> json = new LinkedHashMap<>();
            json.put("deskMonth", limitJson(deskMonthInForce));
            json.put("keyMonth", limitJson(keyMonth));
            json.put(OWN, own.toMap());
            return new String(Json.bytes(json), StandardCharsets.UTF_8);
        }

        /** @throws IllegalArgumentException if it isn't what {@link #toJson} or an older desk-agent writes */
        public static DeskLimits fromJson(String text) {
            Map<String, Object> json = parse(text);
            Limit keyMonth = limit(json, "keyMonth");
            Map<String, Object> own = Json.object(json, OWN);
            if (own == null) {
                return new DeskLimits(new Layer(null, limit(json, "deskMonth"), null), keyMonth);
            }
            return new DeskLimits(
                    new Layer(optionalLimit(own, "deskDay"), optionalLimit(own, "deskMonth"), storedZone(own)), keyMonth);
        }

        /** A zone this JDK no longer knows is as good as none. */
        private static String storedZone(Map<String, Object> own) {
            String zone = Json.string(own, "timeZone");
            if (zone != null && !knownZone(zone)) {
                log.warn("the stored time zone isn't one this JDK knows, so it's ignored");
                return null;
            }
            return zone;
        }
    }

    private static Map<String, Object> limitJson(Limit limit) {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("maxMicroUsd", limit.maxMicroUsd());
        json.put("maxTokens", limit.maxTokens());
        return json;
    }

    private static Map<String, Object> parse(String text) {
        try {
            return Json.parseObject(text.getBytes(StandardCharsets.UTF_8));
        } catch (JsonFormatException e) {
            throw new IllegalArgumentException("bad limits");
        }
    }

    private static Limit limit(Map<String, Object> json, String name) {
        Limit limit = optionalLimit(json, name);
        if (limit == null) {
            throw new IllegalArgumentException("bad limits");
        }
        return limit;
    }

    private static Limit optionalLimit(Map<String, Object> json, String name) {
        Map<String, Object> limit = Json.object(json, name);
        return limit == null ? null : new Limit(amount(limit.get("maxMicroUsd")), amount(limit.get("maxTokens")));
    }

    private static Long amount(Object value) {
        return value instanceof Number n ? n.longValue() : null;
    }

    /**
     * Whether a time zone can be set: {@code UTC}, or a region the JDK knows whose offset has ever changed. So a fixed
     * offset is refused in every spelling: {@code +05:00} and {@code UTC+5} aren't listed, and {@code Etc/GMT+5},
     * {@code Etc/UTC} and {@code GMT} are listed and fixed.
     */
    public static boolean knownZone(String name) {
        if (UTC.equals(name)) {
            return true;
        }
        return ZoneId.getAvailableZoneIds().contains(name) && !ZoneId.of(name).getRules().isFixedOffset();
    }

    /** The layers, and what they come to, swapped whole so one read sees one consistent set. */
    private record State(
            DeskLimits desk, Layer account, Limit deskDay, Limit deskMonth, String timeZone, ZoneId zone) {}

    private final LimitPolicy defaults;
    private final AgentLimits agentDefaults;
    private final Map<String, AgentLimits> agents = new ConcurrentHashMap<>();
    private final ReentrantLock lock = new ReentrantLock();
    private volatile State state;

    public LimitSettings() {
        this(LimitPolicy.DEFAULTS);
    }

    public LimitSettings(LimitPolicy defaults) {
        this.defaults = defaults;
        agentDefaults = AgentLimits.of(defaults);
        state = resolve(new DeskLimits(Layer.EMPTY, defaults.keyMonth()), Layer.EMPTY);
    }

    private State resolve(DeskLimits desk, Layer account) {
        String timeZone = first(desk.own().timeZone(), account.timeZone(), null);
        return new State(
                desk,
                account,
                first(desk.own().deskDay(), account.deskDay(), defaults.deskDay()),
                first(desk.own().deskMonth(), account.deskMonth(), defaults.deskMonth()),
                timeZone,
                timeZone == null ? ZoneOffset.UTC : ZoneId.of(timeZone));
    }

    private static <T> T first(T desk, T account, T fallback) {
        return desk != null ? desk : account != null ? account : fallback;
    }

    /** One agent's policy, with the desk's scopes in force in it, as the ledger checks it and a client shows it. */
    public LimitPolicy policyFor(String agentId) {
        AgentLimits agent = agents.getOrDefault(agentId, agentDefaults);
        State now = state;
        return new LimitPolicy(agent.day(), agent.week(), agent.month(), now.deskDay(), now.deskMonth(),
                now.desk().keyMonth(), agent.run(), agent.runMaxSteps());
    }

    /**
     * Sets the agent's scopes for that agent, and every desk scope in the policy as this desk's own, keeping its time
     * zone.
     */
    public void set(String agentId, LimitPolicy policy) {
        agents.put(agentId, AgentLimits.of(policy));
        lock.lock();
        try {
            State now = state;
            state = resolve(new DeskLimits(new Layer(policy.deskDay(), policy.deskMonth(), now.desk().own().timeZone()),
                    policy.keyMonth()), now.account());
        } finally {
            lock.unlock();
        }
    }

    public DeskLimits desk() {
        return state.desk();
    }

    /** What the account has set, as deskd last said. */
    public Layer account() {
        return state.account();
    }

    /** The zone name in force, or null for none, which means periods run in UTC. */
    public String timeZone() {
        return state.timeZone();
    }

    /** The zone periods run in now. One volatile read. */
    public ZoneId zone() {
        return state.zone();
    }

    /** The {@code deskMonth} that would be in force with this desk layer. */
    public Limit deskMonthWith(DeskLimits desk) {
        return first(desk.own().deskMonth(), state.account().deskMonth(), defaults.deskMonth());
    }

    /** Forgets a deleted agent's scopes. */
    public void removeAgent(String agentId) {
        agents.remove(agentId);
    }

    /** Restores one agent's scopes, as the store kept them. */
    public void setAgent(String agentId, AgentLimits limits) {
        agents.put(agentId, limits);
    }

    /** Sets the desk's scopes, or restores them as the store kept them. */
    public void setDesk(DeskLimits limits) {
        lock.lock();
        try {
            state = resolve(limits, state.account());
        } finally {
            lock.unlock();
        }
    }

    /** The account's layer, from deskd. @return whether it changed */
    public boolean setAccount(Layer account) {
        lock.lock();
        try {
            State now = state;
            if (now.account().equals(account)) {
                return false;
            }
            state = resolve(now.desk(), account);
            return true;
        } finally {
            lock.unlock();
        }
    }
}
