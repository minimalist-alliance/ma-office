package com.minimalistalliance.desk.agent.team;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The tier's defaults for the desk's agents (ADR 0047): from the Platform's {@code agentDefaults.tier}, which deskd
 * hands over in {@code desk.account.set} as {@code tier}, set per tier in the Management Console. Without them (an
 * older Platform, a self-hosted desk) {@link #DEFAULTS} hold. A value that's missing or out of range takes its default
 * alone, so a bad field never stops an agent.
 *
 * <p>{@link #DEFAULTS} is the Alliance tier's, the most restrictive, so a desk that can't be told its tier never gets
 * more than the lowest tier allows. The last tier received is kept in {@code agent.db} and used until deskd sends one.
 * The caps come from the measurement in the README ("Footprint, many agents"): an idle agent costs a row and no
 * thread, so a cap is about what a member can follow and what the desk's runs at once ({@link #RUNS_AT_ONCE}) and
 * spending limits allow, not memory.
 */
public record TierCaps(int agentCap, int workspaceMb, int workspaceMaxMb, int timersPerAgent, int timerMinMinutes,
        int a2aPerHour, int a2aDepth, int a2aSpendPct) {

    public static final TierCaps DEFAULTS = new TierCaps(10, 50, 200, 5, 15, 20, 3, 25);

    /** Runs at once on the desk, every agent's together: what bounds desk-agent's memory, measured (README). */
    public static final int RUNS_AT_ONCE = 4;
    /** Of {@link #RUNS_AT_ONCE}, what runs a timer or another agent's message starts can take: one place stays for the member's. */
    public static final int UNATTENDED_RUNS = RUNS_AT_ONCE - 1;
    public static final int RULES_MAX = 500;
    public static final int PURPOSE_MAX = 4000;
    public static final int PROMPT_MAX = 2000;
    public static final int ICON_MAX_BYTES = 262_144;
    public static final int ICON_MAX_PX = 512;

    /** The tier's values from deskd, each checked on its own. Null or not an object is {@link #DEFAULTS}. */
    public static TierCaps from(Object value) {
        if (!(value instanceof Map<?, ?> map)) {
            return DEFAULTS;
        }
        int workspaceMax = field(map, "workspaceMaxMb", 1, 10_240, DEFAULTS.workspaceMaxMb);
        return new TierCaps(
                field(map, "agentCap", 1, 100, DEFAULTS.agentCap),
                Math.min(workspaceMax, field(map, "workspaceMb", 1, 10_240, DEFAULTS.workspaceMb)),
                workspaceMax,
                field(map, "timersPerAgent", 0, 100, DEFAULTS.timersPerAgent),
                field(map, "timerMinMinutes", 1, 1440, DEFAULTS.timerMinMinutes),
                field(map, "a2aPerHour", 0, 1000, DEFAULTS.a2aPerHour),
                field(map, "a2aDepth", 1, 10, DEFAULTS.a2aDepth),
                field(map, "a2aSpendPct", 0, 100, DEFAULTS.a2aSpendPct));
    }

    private static int field(Map<?, ?> map, String name, int min, int max, int fallback) {
        if (map.get(name) instanceof Number n) {
            double d = n.doubleValue();
            if (d == Math.rint(d) && d >= min && d <= max) {
                return (int) d;
            }
        }
        return fallback;
    }

    /** Agent messages an hour across the whole desk: four pairs' worth, so the total can't grow with every pair. */
    public int a2aDeskPerHour() {
        return 4 * a2aPerHour;
    }

    /** {@code agent.caps}, with how many agents the desk has now. */
    public Map<String, Object> toMap(int agents) {
        Map<String, Object> caps = new LinkedHashMap<>();
        caps.put("agentCap", agentCap);
        caps.put("agents", agents);
        caps.put("workspaceMb", workspaceMb);
        caps.put("workspaceMaxMb", workspaceMaxMb);
        caps.put("timersPerAgent", timersPerAgent);
        caps.put("timerMinMinutes", timerMinMinutes);
        caps.put("a2aPerHour", a2aPerHour);
        caps.put("a2aDeskPerHour", a2aDeskPerHour());
        caps.put("a2aDepth", a2aDepth);
        caps.put("a2aSpendPct", a2aSpendPct);
        caps.put("runsAtOnce", RUNS_AT_ONCE);
        caps.put("rulesMax", RULES_MAX);
        caps.put("purposeMax", PURPOSE_MAX);
        caps.put("promptMax", PROMPT_MAX);
        caps.put("iconMaxBytes", ICON_MAX_BYTES);
        caps.put("iconMaxPx", ICON_MAX_PX);
        return caps;
    }
}
