package com.minimalistalliance.desk.agent.maia;

import com.minimalistalliance.desk.agent.key.KeyRing;
import com.minimalistalliance.desk.agent.limits.Limit;
import com.minimalistalliance.desk.agent.limits.LimitPolicy;
import com.minimalistalliance.desk.agent.limits.Scope;
import com.minimalistalliance.desk.agent.limits.UsageLedger;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.store.AgentStore;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.Supplier;

/**
 * The team view's numbers on one desk, {@code agent.usage.summary} (the concept's §7; deskd {@code API.md} §23): per
 * agent per day of the desk's zone, its spend, calls and tokens from the usage ledger (ADR 0043), its tasks from its
 * replies' ends, and its approvals asked, approved, declined and undone. Counts and dollars only: never a word of a
 * thread, and nothing goes to the Platform; the office reads each desk over its own channel and sums them.
 */
public final class TeamView {

    static final int MAX_DAYS = 7;

    private final AgentStore store;
    private final UsageLedger ledger;
    private final Clock clock;
    private final Supplier<ZoneId> zone;

    public TeamView(AgentStore store, UsageLedger ledger, Clock clock, Supplier<ZoneId> zone) {
        this.store = store;
        this.ledger = ledger;
        this.clock = clock;
        this.zone = zone;
    }

    /** What an agent's headroom needs of the service: its limits in force, and what a brief from another desk may spend. */
    public interface Limits {
        LimitPolicy policy(String agentId);

        /** What a run answering another desk's message may spend now, µ$ (its share for messages, its run limit). */
        long briefCap(String agentId);
    }

    /** Desk Maia's briefs a run of them may be told apart by: the opening message's origin names her agent. */
    static final String MAIA_ORIGIN = "%\"agentId\":\"maia\"%";
    /** How far back an agent's cost per brief of hers is averaged. */
    static final int BRIEF_DAYS = 30;

    private volatile Limits limits;
    private volatile Supplier<Map<String, Object>> home;
    /** Each agent's calls on MA's credits a day from a day on, in hundredths ({@code CreditDays#since}), or null. */
    private volatile CreditsSince credits;

    /** What each agent's calls on MA's credits drew a day, from {@code fromDay} on: agent id, then day, in hundredths. */
    @FunctionalInterface
    public interface CreditsSince {
        Map<String, Map<String, Long>> since(String fromDay) throws SQLException;
    }

    /** Each agent's headroom in the summary ({@code headroom}), for Desk Maia's planning on the member's home desk. */
    public TeamView limits(Limits l) {
        this.limits = l;
        return this;
    }

    /** On the home desk: what her briefs cost across the member's desks, and the day's budget ({@code maia}). */
    public TeamView home(Supplier<Map<String, Object>> briefs) {
        this.home = briefs;
        return this;
    }

    /**
     * Usage per source in credits (the coordinator's decision of Nov 15, one wallet): what Desk Maia's calls and each agent's
     * on the member's MA credits drew a day here. Those rows carry {@code spendCredits} and never dollars for that usage; an
     * agent on the member's own keys keeps its own provider's dollars, which are the member's.
     */
    public TeamView credits(CreditsSince perAgent) {
        this.credits = perAgent;
        return this;
    }

    public static final String METHOD = "agent.usage.summary";

    public Map<String, Object> summary(Map<String, Object> p) throws RpcError, SQLException {
        int days = MAX_DAYS;
        if (p.get("days") != null) {
            if (!(p.get("days") instanceof Number n) || n.doubleValue() != Math.rint(n.doubleValue())
                    || n.intValue() < 1 || n.intValue() > MAX_DAYS) {
                throw RpcError.badRequest("days");
            }
            days = n.intValue();
        }
        ZoneId z = zone.get();
        LocalDate today = LocalDate.ofInstant(Instant.ofEpochMilli(clock.millis()), z);
        long since = today.minusDays(days - 1).atStartOfDay(z).toInstant().toEpochMilli();
        // agent -> day -> columns
        Map<String, Map<String, long[]>> by = new TreeMap<>();
        for (UsageLedger.DayUse u : ledger.daily(days)) {
            long[] c = cell(by, u.agentId(), u.day());
            c[SPEND] += u.microUsd();
            c[CALLS] += u.calls();
            c[IN] += u.inputTokens();
            c[CACHED] += u.cachedInputTokens();
            c[OUT] += u.outputTokens();
        }
        Map<String, String[]> agents = new LinkedHashMap<>();
        long monthStart = today.withDayOfMonth(1).atStartOfDay(z).toInstant().toEpochMilli();
        long dayStart = today.atStartOfDay(z).toInstant().toEpochMilli();
        long briefsSince = Math.min(monthStart, today.minusDays(BRIEF_DAYS - 1).atStartOfDay(z).toInstant()
                .toEpochMilli());
        // Runs her briefs started here: [agentId, runId, startedAt].
        List<Object[]> briefRuns = new ArrayList<>();
        store.database().call(connection -> {
            try (PreparedStatement q = connection.prepareStatement("SELECT a.id, a.name, k.last4, a.key_id FROM agents a"
                    + " LEFT JOIN keys k ON k.key_id = a.key_id ORDER BY a.created_at")) {
                try (ResultSet r = q.executeQuery()) {
                    while (r.next()) {
                        agents.put(r.getString(1), new String[] {r.getString(2), r.getString(3), r.getString(4)});
                    }
                }
            }
            try (PreparedStatement q = connection.prepareStatement("SELECT u.agent_id, u.origin, r.run_id, u.at_ms"
                    + " FROM messages u JOIN messages r ON r.agent_id = u.agent_id AND r.ord = u.ord + 1"
                    + " AND r.role = 'assistant' AND r.run_id IS NOT NULL WHERE u.role = 'user' AND u.at_ms >= ?"
                    + " AND u.origin LIKE ?")) {
                q.setLong(1, briefsSince);
                q.setString(2, MAIA_ORIGIN);
                try (ResultSet r = q.executeQuery()) {
                    while (r.next()) {
                        Map<String, Object> origin = MaiaStore.parse(r.getString(2));
                        if ("desk".equals(origin.get("kind")) && MaiaAgent.ID.equals(origin.get("agentId"))
                                && "message".equals(origin.get("role"))) {
                            briefRuns.add(new Object[] {r.getString(1), r.getString(3), r.getLong(4)});
                        }
                    }
                }
            }
            try (PreparedStatement q = connection.prepareStatement("SELECT agent_id, at_ms, state FROM messages"
                    + " WHERE role = 'assistant' AND run_id IS NOT NULL AND at_ms >= ?")) {
                q.setLong(1, since);
                try (ResultSet r = q.executeQuery()) {
                    while (r.next()) {
                        String day = day(r.getLong(2), z);
                        String state = r.getString(3);
                        long[] c = cell(by, r.getString(1), day);
                        if ("done".equals(state)) {
                            c[DONE]++;
                        } else if ("failed".equals(state)) {
                            c[FAILED]++;
                        } else if ("stopped".equals(state)) {
                            c[STOPPED]++;
                        }
                    }
                }
            }
            try (PreparedStatement q = connection.prepareStatement("SELECT agent_id, created_at, state, decided_by,"
                    + " undone_at FROM approvals WHERE created_at >= ?")) {
                q.setLong(1, since);
                try (ResultSet r = q.executeQuery()) {
                    while (r.next()) {
                        long[] c = cell(by, r.getString(1), day(r.getLong(2), z));
                        String state = r.getString(3);
                        boolean auto = "auto".equals(r.getString(4));
                        r.getLong(5);
                        boolean undone = !r.wasNull();
                        if (!auto) {
                            c[ASKED]++;
                            if ("declined".equals(state)) {
                                c[DECLINED]++;
                            } else if ("approved".equals(state) || "done".equals(state) || "failed".equals(state)
                                    || "interrupted".equals(state)) {
                                c[APPROVED]++;
                            }
                        }
                        if (undone) {
                            c[UNDONE]++;
                        }
                    }
                }
            }
            return null;
        });
        List<String> runIds = new ArrayList<>();
        for (Object[] b : briefRuns) {
            runIds.add((String) b[1]);
        }
        Map<String, Long> runSpend = ledger.spendOfRuns(runIds);
        Map<String, Map<String, Long>> onCredits = creditsSince(today.minusDays(days - 1).toString());
        List<Map<String, Object>> list = new ArrayList<>();
        for (Map.Entry<String, String[]> a : agents.entrySet()) {
            if (a.getKey().startsWith("gm-")) {
                continue;
            }
            Map<String, long[]> days0 = by.getOrDefault(a.getKey(), Map.of());
            Map<String, Long> credited = onCredits.getOrDefault(a.getKey(), Map.of());
            boolean maia = MaiaAgent.is(a.getKey());
            // On MA's credits: Desk Maia always, an agent bound to the member's credits, or one that drew some in these days.
            boolean bound = KeyRing.CREDITS.equals(a.getValue()[2]);
            boolean inCredits = maia || bound || !credited.isEmpty();
            List<Map<String, Object>> dayList = new ArrayList<>();
            for (int i = days - 1; i >= 0; i--) {
                String d = today.minusDays(i).toString();
                long[] c = days0.getOrDefault(d, new long[COLUMNS]);
                Map<String, Object> v = new LinkedHashMap<>();
                v.put("date", d);
                // Desk Maia's own calls are the company's: no dollars of hers (the ledger counts them as none), her
                // credits instead.
                v.put("spendMicroUsd", maia ? 0L : c[SPEND]);
                if (inCredits) {
                    v.put("spendCredits", credited.getOrDefault(d, 0L) / 100.0);
                }
                v.put("calls", c[CALLS]);
                v.put("inputTokens", c[IN]);
                v.put("outputTokens", c[OUT]);
                v.put("cacheReadTokens", c[CACHED]);
                v.put("tasksDone", c[DONE]);
                v.put("tasksFailed", c[FAILED]);
                v.put("tasksStopped", c[STOPPED]);
                v.put("approvalsAsked", c[ASKED]);
                v.put("approvalsApproved", c[APPROVED]);
                v.put("approvalsDeclined", c[DECLINED]);
                v.put("undone", c[UNDONE]);
                dayList.add(v);
            }
            Map<String, Object> agent = new LinkedHashMap<>();
            agent.put("agentId", a.getKey());
            agent.put("name", a.getValue()[0]);
            agent.put("keyLast4", a.getValue()[1]);
            if (inCredits) {
                // Its usage's source: MA's credits (the member's one wallet), never a dollar figure for it.
                agent.put("source", maia || bound ? "credits" : "credits_and_key");
            }
            agent.put("days", dayList);
            if (!MaiaAgent.is(a.getKey())) {
                Map<String, Object> room = headroom(a.getKey(), a.getValue()[2], days0, runSpend, briefRuns);
                if (room != null) {
                    agent.put("headroom", room);
                }
            }
            list.add(agent);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("zone", z.getId());
        out.put("today", today.toString());
        out.put("agents", list);
        out.put("maiaBriefs", briefsHere(briefRuns, runSpend, dayStart, monthStart));
        Supplier<Map<String, Object>> h = home;
        Map<String, Object> mine = h == null ? null : h.get();
        if (mine != null) {
            out.put("maia", mine);
        }
        return out;
    }

    /**
     * One agent's headroom, µ$, null where there's no cap: what's left before its day or week limit or the desk's day
     * limit ({@code dayLeftMicroUsd}), before its month, the desk's month or its key's month ({@code monthLeftMicroUsd}),
     * its run limit, what a run answering another desk may spend now ({@code briefMaxMicroUsd}), and its usual task's
     * cost: over its tasks in these days ({@code perTaskMicroUsd}, {@code tasks}) and over runs Desk Maia's briefs
     * started here in {@link #BRIEF_DAYS} days ({@code perBriefMicroUsd}, {@code briefs}).
     */
    private Map<String, Object> headroom(String agentId, String keyId, Map<String, long[]> days,
            Map<String, Long> runSpend, List<Object[]> briefRuns) throws SQLException {
        Limits l = limits;
        Map<String, Object> v = new LinkedHashMap<>();
        Long dayLeft = null;
        Long monthLeft = null;
        Long runMax = null;
        Long briefMax = null;
        if (l != null) {
            LimitPolicy policy = l.policy(agentId);
            Map<Scope, Long> spent = new java.util.EnumMap<>(Scope.class);
            for (UsageLedger.ScopeUsage u : ledger.usage(agentId, keyId)) {
                spent.put(u.scope(), u.spent().microUsd());
            }
            dayLeft = least(left(policy.agentDay(), spent.get(Scope.AGENT_DAY)),
                    least(left(policy.agentWeek(), spent.get(Scope.AGENT_WEEK)),
                            left(policy.deskDay(), spent.get(Scope.DESK_DAY))));
            monthLeft = least(left(policy.agentMonth(), spent.get(Scope.AGENT_MONTH)),
                    least(left(policy.deskMonth(), spent.get(Scope.DESK_MONTH)),
                            keyId == null ? null : left(policy.keyMonth(), spent.get(Scope.KEY_MONTH))));
            runMax = policy.run().maxMicroUsd();
            briefMax = Math.max(0, l.briefCap(agentId));
        }
        long spend = 0;
        long tasks = 0;
        for (long[] c : days.values()) {
            spend += c[SPEND];
            tasks += c[DONE] + c[FAILED] + c[STOPPED];
        }
        long briefSpend = 0;
        int briefs = 0;
        for (Object[] b : briefRuns) {
            if (agentId.equals(b[0]) && runSpend.containsKey((String) b[1])) {
                briefSpend += runSpend.get((String) b[1]);
                briefs++;
            }
        }
        v.put("dayLeftMicroUsd", dayLeft);
        v.put("monthLeftMicroUsd", monthLeft);
        v.put("runMaxMicroUsd", runMax);
        v.put("briefMaxMicroUsd", briefMax);
        v.put("perTaskMicroUsd", tasks == 0 ? null : spend / tasks);
        v.put("tasks", tasks);
        v.put("perBriefMicroUsd", briefs == 0 ? null : briefSpend / briefs);
        v.put("briefs", briefs);
        return v;
    }

    /** Runs Desk Maia's briefs started on this desk, and what they spent: today and this month (counts and dollars). */
    private static Map<String, Object> briefsHere(List<Object[]> briefRuns, Map<String, Long> runSpend, long dayStart,
            long monthStart) {
        long today = 0;
        long month = 0;
        int nToday = 0;
        int nMonth = 0;
        for (Object[] b : briefRuns) {
            long at = (Long) b[2];
            long spent = runSpend.getOrDefault((String) b[1], 0L);
            if (at >= monthStart) {
                month += spent;
                nMonth++;
            }
            if (at >= dayStart) {
                today += spent;
                nToday++;
            }
        }
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("todayMicroUsd", today);
        v.put("monthMicroUsd", month);
        v.put("today", nToday);
        v.put("month", nMonth);
        return v;
    }

    private static Long left(Limit limit, Long spent) {
        if (limit == null || limit.maxMicroUsd() == null) {
            return null;
        }
        return Math.max(0, limit.maxMicroUsd() - (spent == null ? 0 : spent));
    }

    private static Long least(Long a, Long b) {
        if (a == null) {
            return b;
        }
        return b == null ? a : Long.valueOf(Math.min(a, b));
    }

    /** Each agent's credits a day from {@code fromDay}; empty when not wired or when they can't be read. */
    private Map<String, Map<String, Long>> creditsSince(String fromDay) {
        CreditsSince c = credits;
        if (c == null) {
            return Map.of();
        }
        try {
            return c.since(fromDay);
        } catch (SQLException | RuntimeException e) {
            return Map.of();
        }
    }

    private static final int SPEND = 0;
    private static final int CALLS = 1;
    private static final int IN = 2;
    private static final int CACHED = 3;
    private static final int OUT = 4;
    private static final int DONE = 5;
    private static final int FAILED = 6;
    private static final int STOPPED = 7;
    private static final int ASKED = 8;
    private static final int APPROVED = 9;
    private static final int DECLINED = 10;
    private static final int UNDONE = 11;
    private static final int COLUMNS = 12;

    private static long[] cell(Map<String, Map<String, long[]>> by, String agent, String day) {
        return by.computeIfAbsent(agent, k -> new TreeMap<>()).computeIfAbsent(day, k -> new long[COLUMNS]);
    }

    private static String day(long at, ZoneId z) {
        return LocalDate.ofInstant(Instant.ofEpochMilli(at), z).toString();
    }
}
