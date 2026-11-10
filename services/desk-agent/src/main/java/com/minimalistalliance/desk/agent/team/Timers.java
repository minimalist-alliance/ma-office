package com.minimalistalliance.desk.agent.team;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.manager.ManagerAgent;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.store.TeamStore;
import com.minimalistalliance.desk.agent.store.TeamStore.TimerRow;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.time.Duration;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Each agent's timers (ADR 0047, {@code docs/multi-agent.md} section 6): kept in {@code agent.db}, so they survive
 * restarts, and fired by one thread that sleeps until the soonest is due (at most a minute, so a changed zone or clock
 * is caught). A fire starts a run of the agent with the timer's prompt, as a message the member didn't write; the
 * run's cost counts toward every spending limit and is added to the timer's {@code spentMicroUsd}.
 */
public final class Timers implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(Timers.class);

    /** A one-shot timer missed while desk-agent was down runs at start if it's under this late. */
    static final Duration ONCE_GRACE = Duration.ofDays(1);
    static final Duration BUSY_RETRY = Duration.ofMinutes(1);
    static final int BUSY_RETRIES = 10;
    static final Duration MAX_SLEEP = Duration.ofMinutes(1);
    static final Duration MAX_AHEAD = Duration.ofDays(366);

    private final Team team;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition wake = lock.newCondition();
    /**
     * A fire, an end, a set and a delete write a timer's row one at a time, each reading it again under this lock, so a
     * disable or delete the member made just before a fire holds (the fire never writes from a stale row).
     */
    private final ReentrantLock writes = new ReentrantLock();
    private Thread thread;
    private boolean closed;

    Timers(Team team) {
        this.team = team;
    }

    private TeamStore store() {
        return team.teamStore();
    }

    // ---------------------------------------------------------------- the thread

    /** Starts firing timers. */
    public void start() {
        lock.lock();
        try {
            if (thread == null && !closed) {
                thread = Thread.ofVirtual().name("timers").start(this::loop);
            }
        } finally {
            lock.unlock();
        }
    }

    @Override
    public void close() {
        Thread running;
        lock.lock();
        try {
            closed = true;
            running = thread;
            wake.signalAll();
        } finally {
            lock.unlock();
        }
        if (running != null) {
            running.interrupt();
        }
    }

    /** A timer changed: the thread looks again. */
    void changed() {
        lock.lock();
        try {
            wake.signalAll();
        } finally {
            lock.unlock();
        }
    }

    private void loop() {
        while (true) {
            long sleepMs = MAX_SLEEP.toMillis();
            try {
                runDue();
                Long next = team.adult() ? store().nextTimerAt() : null;
                if (next != null) {
                    sleepMs = Math.max(0, Math.min(sleepMs, next - team.clock().millis()));
                }
            } catch (SQLException | RuntimeException e) {
                log.warn("timers: a pass failed ({})", e.getClass().getSimpleName());
            }
            lock.lock();
            try {
                if (closed) {
                    return;
                }
                if (sleepMs > 0) {
                    wake.await(sleepMs, TimeUnit.MILLISECONDS);
                }
                if (closed) {
                    return;
                }
            } catch (InterruptedException e) {
                return;
            } finally {
                lock.unlock();
            }
        }
    }

    /** Fires every timer due now. Tests call it with a moved clock. @return how many it tried */
    public int runDue() throws SQLException {
        followZone();
        long now = team.clock().millis();
        List<TimerRow> due = store().dueTimers(now);
        if (!team.adult()) {
            // Due timers wait: nothing fires or moves on until the owner's band is adult (Security T49K-2).
            for (TimerRow timer : due) {
                holdForBand(timer, now);
            }
            return 0;
        }
        for (TimerRow timer : due) {
            fire(timer, now);
        }
        return due.size();
    }

    private void holdForBand(TimerRow listed, long now) throws SQLException {
        writes.lock();
        try {
            TimerRow timer = store().timer(listed.id());
            if (timer != null && timer.enabled() && !"paused".equals(timer.lastState())) {
                store().timerFired(timer.id(), timer.lastMs() == null ? now : timer.lastMs(), "paused",
                        timer.nextMs(), true, timer.retries());
            }
        } finally {
            writes.unlock();
        }
    }

    private void fire(TimerRow listed, long now) throws SQLException {
        writes.lock();
        try {
            fireLocked(listed.id(), now);
        } finally {
            writes.unlock();
        }
    }

    private void fireLocked(String timerId, long now) throws SQLException {
        TimerRow timer = store().timer(timerId);
        if (timer == null || !timer.enabled() || timer.nextMs() == null || timer.nextMs() > now) {
            return; // changed since it was listed: the member's change holds
        }
        if (team.store().agent(timer.agentId()) == null) {
            store().deleteTimer(timer.agentId(), timer.id());
            return;
        }
        if ("paused".equals(timer.lastState())) {
            // It waited for the band: a one-shot less than a day late runs once, a repeat skips to its next time.
            long late = now - timer.nextMs();
            if ("once".equals(timer.kind())) {
                if (late > ONCE_GRACE.toMillis()) {
                    store().timerFired(timer.id(), now, "missed", null, false, 0);
                    return;
                }
            } else if (late > BUSY_RETRY.toMillis() * 2) {
                store().timerFired(timer.id(), now, "missed", next(timer, now), true, 0);
                return;
            }
        }
        if (overCap(timer)) {
            // Beyond the tier's timers per agent, oldest kept: it doesn't fire, and stays until the member removes it.
            Long next = next(timer, now);
            store().timerFired(timer.id(), now, "over_cap", next, next != null, 0);
            team.audit("system", "timer.fire", "agent:" + timer.agentId() + " timer:" + timer.id(), "over_cap");
            return;
        }
        int minimum = team.caps().timerMinMinutes();
        if (timer.everyMinutes() != null && timer.everyMinutes() < minimum && timer.lastMs() != null
                && timer.retries() == 0 && !"busy".equals(timer.lastState())
                && now < timer.lastMs() + minimum * 60_000L) {
            // An interval under the tier's minimum runs at the minimum: not before it has passed since the last fire.
            store().timerFired(timer.id(), timer.lastMs(), timer.lastState(), timer.lastMs() + minimum * 60_000L,
                    true, 0);
            return;
        }
        Map<String, Object> origin = new LinkedHashMap<>();
        origin.put("kind", "timer");
        origin.put("timerId", timer.id());
        origin.put("label", timer.label());
        // The fire is written before the run starts: a quick run's end ({@link #ended}) must come after it, never
        // be overwritten by it.
        Long next = next(timer, now);
        boolean enabled = next != null;
        store().timerFired(timer.id(), now, "running", next, enabled, 0);
        String state = "running";
        try {
            team.host().start(timer.agentId(), timer.prompt(), origin, Team.Chain.start(timer.agentId()));
        } catch (RpcError e) {
            state = e.details().get("reason") instanceof String r ? r : e.code();
            if ("busy".equals(state) && timer.retries() < BUSY_RETRIES) {
                store().timerFired(timer.id(), now, "busy", now + BUSY_RETRY.toMillis(), true, timer.retries() + 1);
                team.audit("system", "timer.fire", "agent:" + timer.agentId() + " timer:" + timer.id(), "busy");
                return;
            }
            store().timerFired(timer.id(), now, state, next, enabled, 0);
        }
        team.audit("system", "timer.fire", "agent:" + timer.agentId() + " timer:" + timer.id(), state);
        team.host().publishState();
    }

    /** Whether the timer is past the agent's {@code timersPerAgent}, counting oldest first. */
    private boolean overCap(TimerRow timer) throws SQLException {
        int cap = team.caps().timersPerAgent();
        List<TimerRow> mine = new ArrayList<>(store().timers(timer.agentId()));
        if (mine.size() <= cap) {
            return false;
        }
        mine.sort(Comparator.comparingLong(TimerRow::createdAt).thenComparing(TimerRow::id));
        for (int i = 0; i < cap; i++) {
            if (mine.get(i).id().equals(timer.id())) {
                return false;
            }
        }
        return true;
    }

    /** A timer's run ended: its outcome and cost. */
    void ended(String timerId, ManagerAgent.RunResult result) throws SQLException {
        writes.lock();
        try {
            endedLocked(timerId, result);
        } finally {
            writes.unlock();
        }
    }

    private void endedLocked(String timerId, ManagerAgent.RunResult result) throws SQLException {
        TimerRow timer = store().timer(timerId);
        if (timer == null) {
            return;
        }
        if (result.costMicroUsd() != null && result.costMicroUsd() > 0) {
            store().addTimerSpend(timerId, result.costMicroUsd());
        }
        String state = result.state() == ManagerAgent.RunState.DONE ? "ok"
                : result.error() != null && result.error().equals("limit_reached") ? "limit_reached" : "failed";
        store().timerFired(timerId, timer.lastMs() == null ? team.clock().millis() : timer.lastMs(), state,
                timer.nextMs(), timer.enabled(), timer.retries());
    }

    /**
     * The zone the stored {@code nextAt} of the repeating timers was last worked out in. When the member's zone
     * changes (the member's setting, or the account's, which deskd sends after desk-agent starts), the next fire of a
     * "weekdays at 08:00" timer moves to 08:00 in the new zone, at once and not only after its next fire.
     */
    private volatile ZoneId knownZone;

    private void followZone() throws SQLException {
        ZoneId zone = team.zone();
        ZoneId before = knownZone;
        if (zone.equals(before)) {
            return;
        }
        knownZone = zone;
        if (before == null) {
            return;
        }
        long now = team.clock().millis();
        for (TimerRow t : store().timers(null)) {
            if (!t.enabled() || !"repeat".equals(t.kind()) || t.days() == null || t.everyMinutes() != null) {
                continue;
            }
            Long next = next(t, now);
            if (next != null && !next.equals(t.nextMs()) && t.retries() == 0) {
                store().putTimer(new TimerRow(t.id(), t.agentId(), t.label(), t.kind(), t.days(), t.time(),
                        t.everyMinutes(), t.atMs(), t.prompt(), true, next, t.lastMs(), t.lastState(), 0,
                        t.spentMicroUsd(), t.createdAt()));
            }
        }
        changed();
    }

    /** The timer's next fire after {@code now}, in the member's zone, or null when it's done. */
    Long next(TimerRow timer, long now) {
        Integer every = timer.everyMinutes() == null ? null
                : Integer.valueOf(Math.max(timer.everyMinutes(), team.caps().timerMinMinutes()));
        return Schedule.next(timer.kind(), days(timer.days()), timer.time(), every, timer.atMs(),
                timer.createdAt(), now, team.zone());
    }

    /** At start: one-shot timers missed by under a day stay due; older ones end missed; repeating ones skip ahead. */
    void restore() throws SQLException {
        knownZone = team.zone();
        long now = team.clock().millis();
        for (TimerRow timer : store().timers(null)) {
            if (!timer.enabled() || timer.nextMs() == null || timer.nextMs() > now) {
                continue;
            }
            if ("once".equals(timer.kind())) {
                if (now - timer.nextMs() > ONCE_GRACE.toMillis()) {
                    store().timerFired(timer.id(), now, "missed", null, false, 0);
                }
            } else if (now - timer.nextMs() > BUSY_RETRY.toMillis() * 2) {
                store().timerFired(timer.id(), now, "missed", next(timer, now), true, 0);
            }
        }
    }

    // ---------------------------------------------------------------- RPCs

    Map<String, Object> list(String agentId) throws RpcError, SQLException {
        if (team.store().agent(agentId) == null) {
            throw RpcError.notFound("agent");
        }
        followZone();
        List<Map<String, Object>> timers = new ArrayList<>();
        for (TimerRow timer : store().timers(agentId)) {
            timers.add(view(timer));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("timers", timers);
        out.put("zone", team.limits().timeZone());
        return out;
    }

    /** {@code agent.timer.set}, by hand or from a confirmed proposal. */
    Map<String, Object> set(String agentId, Map<String, Object> input, String actor) throws RpcError, SQLException {
        writes.lock();
        try {
            return setLocked(agentId, input, actor);
        } finally {
            writes.unlock();
        }
    }

    private Map<String, Object> setLocked(String agentId, Map<String, Object> input, String actor)
            throws RpcError, SQLException {
        if (team.store().agent(agentId) == null) {
            throw RpcError.notFound("agent");
        }
        followZone();
        Map<String, Object> t = normalize(input, agentId);
        long now = team.clock().millis();
        String id = (String) t.get("id");
        TimerRow existing = id == null ? null : store().timer(id);
        if (id != null && (existing == null || !existing.agentId().equals(agentId))) {
            throw RpcError.notFound("timer");
        }
        if (existing == null && (store().timers(agentId).size() >= team.caps().timersPerAgent()
                || store().timers(null).size() >= (long) team.caps().agentCap() * team.caps().timersPerAgent())) {
            // Per agent, and across the desk (agents x timers per agent), so a pile of agents can't hold more.
            throw RpcError.of("precondition_failed", "reason", "timer_cap");
        }
        Long at = null;
        if ("once".equals(t.get("kind"))) {
            at = t.get("inMinutes") instanceof Number n ? now + n.longValue() * 60_000L
                    : ((Number) t.get("at")).longValue();
            if (at <= now || at > now + MAX_AHEAD.toMillis()) {
                throw RpcError.badRequest("at");
            }
        }
        List<Integer> days = intList(t.get("days"));
        Integer every = t.get("everyMinutes") instanceof Number n ? n.intValue() : null;
        boolean enabled = !Boolean.FALSE.equals(t.get("enabled"));
        TimerRow row = new TimerRow(existing == null ? Team.newId("tm") : existing.id(), agentId,
                (String) t.get("label"), (String) t.get("kind"), days == null ? null : json(days),
                (String) t.get("time"), every, at, (String) t.get("prompt"), enabled, null,
                existing == null ? null : existing.lastMs(), existing == null ? null : existing.lastState(), 0,
                existing == null ? 0 : existing.spentMicroUsd(), existing == null || every != null ? now
                        : existing.createdAt());
        Long next = enabled ? Schedule.next(row.kind(), days, row.time(), every, at, row.createdAt(), now,
                team.zone()) : null;
        row = new TimerRow(row.id(), row.agentId(), row.label(), row.kind(), row.days(), row.time(),
                row.everyMinutes(), row.atMs(), row.prompt(), row.enabled(), next, row.lastMs(), row.lastState(), 0,
                row.spentMicroUsd(), row.createdAt());
        store().putTimer(row);
        team.audit(actor, "timer.set", "agent:" + agentId + " timer:" + row.id(), row.kind());
        changed();
        team.host().publishState();
        return view(store().timer(row.id()));
    }

    Map<String, Object> delete(String agentId, String timerId, String actor) throws RpcError, SQLException {
        writes.lock();
        try {
            if (!store().deleteTimer(agentId, timerId)) {
                throw RpcError.notFound("timer");
            }
        } finally {
            writes.unlock();
        }
        team.audit(actor, "timer.delete", "agent:" + agentId + " timer:" + timerId, "ok");
        changed();
        team.host().publishState();
        return Map.of();
    }

    /**
     * A timer's input, checked and in a canonical shape (what a proposal carries and {@link #set} takes): one of
     * {@code at}/{@code inMinutes} for once, {@code days}+{@code time} or {@code everyMinutes} for repeat.
     */
    Map<String, Object> normalize(Map<String, Object> in, String agentId) throws RpcError, SQLException {
        Map<String, Object> t = new LinkedHashMap<>();
        if (in.get("id") != null) {
            if (!(in.get("id") instanceof String id) || !Team.ITEM_ID.matcher(id).matches()) {
                throw RpcError.badRequest("id");
            }
            if (agentId != null) {
                TimerRow existing = store().timer(id);
                if (existing == null || !existing.agentId().equals(agentId)) {
                    throw RpcError.notFound("timer");
                }
            }
            t.put("id", id);
        }
        String label = in.get("label") instanceof String l ? l.strip() : "";
        TextChecks.refuseHidden(label, "label");
        if (label.isEmpty() || label.codePointCount(0, label.length()) > Team.LABEL_MAX || hasControl(label)) {
            throw RpcError.badRequest("label");
        }
        t.put("label", label);
        String kind = in.get("kind") instanceof String k ? k : "";
        t.put("kind", kind);
        if (kind.equals("once")) {
            if (in.get("inMinutes") != null) {
                if (!(in.get("inMinutes") instanceof Number n) || n.doubleValue() != Math.rint(n.doubleValue())
                        || n.longValue() < 1 || n.longValue() > MAX_AHEAD.toMinutes()) {
                    throw RpcError.badRequest("inMinutes");
                }
                t.put("inMinutes", n.longValue());
            } else {
                Long at = Team.instant(in.get("at"), team.zone());
                if (at == null) {
                    throw RpcError.badRequest("at");
                }
                t.put("at", at);
            }
        } else if (kind.equals("repeat")) {
            if (in.get("everyMinutes") != null) {
                if (!(in.get("everyMinutes") instanceof Number n) || n.doubleValue() != Math.rint(n.doubleValue())
                        || n.longValue() < team.caps().timerMinMinutes() || n.longValue() > 366L * 24 * 60) {
                    throw RpcError.badRequest("everyMinutes");
                }
                t.put("everyMinutes", n.longValue());
            } else {
                List<Integer> days = intList(in.get("days"));
                if (days == null || days.isEmpty() || days.stream().anyMatch(d -> d < 1 || d > 7)) {
                    throw RpcError.badRequest("days");
                }
                if (!(in.get("time") instanceof String time) || !Schedule.TIME.matcher(time).matches()) {
                    throw RpcError.badRequest("time");
                }
                t.put("days", List.copyOf(new TreeSet<>(days)));
                t.put("time", in.get("time"));
            }
        } else {
            throw RpcError.badRequest("kind");
        }
        String prompt = in.get("prompt") instanceof String p ? p.strip() : "";
        TextChecks.refuseHidden(prompt, "prompt");
        if (prompt.isEmpty() || prompt.codePointCount(0, prompt.length()) > TierCaps.PROMPT_MAX
                || prompt.indexOf('\0') >= 0) {
            throw RpcError.badRequest("prompt");
        }
        t.put("prompt", prompt);
        if (in.get("enabled") != null) {
            if (!(in.get("enabled") instanceof Boolean on)) {
                throw RpcError.badRequest("enabled");
            }
            t.put("enabled", on);
        }
        return t;
    }

    Map<String, Object> view(TimerRow timer) {
        Map<String, Object> t = new LinkedHashMap<>();
        t.put("id", timer.id());
        t.put("label", timer.label());
        t.put("kind", timer.kind());
        t.put("days", days(timer.days()));
        t.put("time", timer.time());
        t.put("everyMinutes", timer.everyMinutes());
        t.put("at", timer.atMs());
        t.put("prompt", timer.prompt());
        t.put("enabled", timer.enabled());
        ZoneId zone = team.zone();
        t.put("zone", team.limits().timeZone() == null ? "UTC" : zone.getId());
        t.put("nextAt", timer.nextMs());
        t.put("lastAt", timer.lastMs());
        t.put("lastState", timer.lastState());
        t.put("spentMicroUsd", timer.spentMicroUsd());
        t.put("createdAt", timer.createdAt());
        return t;
    }

    static List<Integer> days(String json) {
        if (json == null) {
            return null;
        }
        List<Integer> days = new ArrayList<>();
        for (String s : json.replaceAll("[\\[\\] ]", "").split(",")) {
            if (!s.isEmpty()) {
                try {
                    days.add(Integer.parseInt(s));
                } catch (NumberFormatException e) {
                    return null;
                }
            }
        }
        return days;
    }

    private static List<Integer> intList(Object value) throws RpcError {
        if (value == null) {
            return null;
        }
        if (!(value instanceof List<?> list) || list.size() > 7) {
            throw RpcError.badRequest("days");
        }
        List<Integer> out = new ArrayList<>();
        for (Object item : list) {
            if (!(item instanceof Number n) || n.doubleValue() != Math.rint(n.doubleValue()) || n.longValue() < 1
                    || n.longValue() > 7) {
                throw RpcError.badRequest("days");
            }
            out.add(n.intValue());
        }
        return out;
    }

    private static boolean hasControl(String text) {
        return text.chars().anyMatch(Character::isISOControl);
    }

    private static String json(Object value) {
        return new String(Json.bytes(value), StandardCharsets.UTF_8);
    }
}
