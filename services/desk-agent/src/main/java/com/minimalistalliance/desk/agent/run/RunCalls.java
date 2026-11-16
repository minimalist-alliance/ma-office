package com.minimalistalliance.desk.agent.run;

import com.minimalistalliance.desk.agent.approval.Approvals;
import com.minimalistalliance.desk.agent.approval.Verdict;
import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.manager.RunIds;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.store.RunCallStore;
import com.minimalistalliance.desk.agent.tool.Classified;
import com.minimalistalliance.desk.agent.tool.Restart;
import com.minimalistalliance.desk.agent.tool.RunContext;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The desk's {@link RunRecords} (durable runs, Design 1's seam; the draft ADR "the Agent's tools and approvals", §3,
 * "Restarts"): each call that runs has a {@code run_calls} row before it's sent, keyed by a new UUIDv7 that a call
 * deskd runs carries as its {@code tcall} key, and each step writes its reply's text and chips so far.
 *
 * <p><b>At open</b> ({@link #restore}, before {@link Approvals#restore}): a call that came back but whose approval
 * never settled settles it from its record ({@code done} or {@code failed}, audited {@code tool.call}); a call still
 * {@code started} ends {@code interrupted} (or {@code failed}, a {@link Restart#SAFE} one), {@code detail: "restart"},
 * audited {@code tool.interrupt}, so an unasked or {@code own} call in flight at a kill leaves a trace; except a call of
 * a run that resumes, which its run asks deskd again by its key ({@link Restart#RETRY_BY_KEY}: deskd's kept result,
 * exactly once) or ends by its rule as it picks up ({@link Resume}).
 *
 * <p>Records hold ids, names, classes and one-word states, never arguments or results. They go with their agent, and a
 * week after they settle.
 */
public final class RunCalls implements RunRecords {

    private static final Logger log = LoggerFactory.getLogger(RunCalls.class);

    /** How long a settled record is kept. */
    static final Duration KEEP = Duration.ofDays(7);
    private static final Duration PRUNE_EVERY = Duration.ofHours(6);

    private final AgentStore agents;
    private final RunCallStore calls;
    /** Each run's checkpoints, which a restart picks it up from (durable runs' resume). */
    private final RunCheckpoints checkpoints;
    /** Keys of calls a restart left in flight, being asked again now with {@code retry: true}. */
    private final java.util.Set<String> retrying = ConcurrentHashMap.newKeySet();
    private final AuditLog audit;
    private final Clock clock;
    /** The step each run is on. */
    private final Map<String, Integer> steps = new ConcurrentHashMap<>();
    /** Each run's call in flight, by its key: one at a time, as a run's calls run in order. */
    private final Map<String, String> current = new ConcurrentHashMap<>();
    private volatile long prunedAt;
    /**
     * The reply's marks so far, written before its text at each step ({@code Approvals.stepMarks}): false when they
     * couldn't be, and then the text isn't written either, so no text is ever down without its marks.
     */
    private volatile java.util.function.Predicate<RunContext> marks = run -> true;
    private volatile java.util.function.Consumer<String> afterStarted = key -> {};
    /** For tests only: runs on the run's thread just after a call's record settles, before its approval does. */
    private volatile java.util.function.Consumer<String> afterSettled = key -> {};

    public RunCalls(AgentStore agents, AuditLog audit, Clock clock) {
        this.agents = agents;
        this.calls = new RunCallStore(agents);
        this.checkpoints = new RunCheckpoints(new com.minimalistalliance.desk.agent.store.RunStore(agents), clock);
        this.audit = audit;
        this.clock = clock;
    }

    public RunCallStore store() {
        return calls;
    }

    /** The runs' checkpoints. */
    public RunCheckpoints checkpoints() {
        return checkpoints;
    }

    /** Whether the call with this key is one a restart left in flight, asked again now: deskd hears {@code retry}. */
    public boolean retrying(String key) {
        return key != null && retrying.contains(key);
    }

    /** Where each step's marks go before its text: the approvals' run marks. Null writes none. */
    public void marks(java.util.function.Predicate<RunContext> stepMarks) {
        this.marks = stepMarks == null ? run -> true : stepMarks;
    }

    /** The key of the run's call in flight, or null: what {@code AgentTools} sends a call to deskd with. */
    public String current(String runId) {
        return runId == null ? null : current.get(runId);
    }

    @Override
    public void step(RunContext run, int step, String text, List<Map<String, Object>> chips) {
        steps.put(run.runId(), step);
        if (run.messageId() == null) {
            return;
        }
        try {
            // Its marks first (U, S, egress), so a later run never reads this text unmarked (Security's DS-M1).
            if (!marks.test(run)) {
                return;
            }
            String tools = chips == null || chips.isEmpty() ? null
                    : new String(Json.bytes(chips), StandardCharsets.UTF_8);
            agents.stepped(run.messageId(), text == null ? "" : text, tools);
        } catch (SQLException | RuntimeException e) {
            log.warn("a reply's step wasn't recorded: {}", e.getClass().getSimpleName());
        }
    }

    @Override
    public String started(RunContext run, Classified call, Verdict verdict) {
        String key = RunIds.next(clock).toString();
        Restart restart = call.decl().restart().forCall(call.risk(), call.decl().host());
        String approvalId = switch (verdict) {
            case Verdict.Approved a -> a.approvalId();
            case Verdict.Allowed a -> a.approvalId();
            default -> null;
        };
        String auto = verdict instanceof Verdict.Allowed allowed ? allowed.group() : null;
        RunCallStore.Call row = new RunCallStore.Call(key, run.runId(), run.agentId(),
                run.messageId() == null ? "" : run.messageId(), steps.getOrDefault(run.runId(), 0), call.call().id(),
                call.decl().name(), call.risk().wireName(), call.decl().host().name().toLowerCase(Locale.ROOT),
                restart.wireName(), approvalId, auto, "started", null, clock.millis(), null);
        try {
            calls.started(row);
        } catch (SQLException | RuntimeException e) {
            // As an approval's start: the call still goes, with its key (the seam's question 1, on its default), and a
            // restart then can't see it, so the run can't resume past it either (Security's DR-L5).
            log.warn("a call's record wasn't written: {}", e.getClass().getSimpleName());
            checkpoints.unresumable(run.runId(), "storage");
        }
        current.put(run.runId(), key);
        afterStarted.accept(key);
        return key;
    }

    /** For tests only: runs on the run's thread just after a call's record is down, before it's sent. */
    public void afterStartedForTest(java.util.function.Consumer<String> hook) {
        this.afterStarted = hook == null ? key -> {} : hook;
    }

    @Override
    public void settled(RunContext run, String key, ToolResult result) {
        if (key == null) {
            return;
        }
        current.remove(run.runId(), key);
        retrying.remove(key);
        String state = !result.error() ? "done" : Restart.interrupted(result) ? "interrupted" : "failed";
        try {
            calls.settle(key, state, result.error() ? Restart.word(result) : null, clock.millis());
        } catch (SQLException | RuntimeException e) {
            log.warn("a call's outcome wasn't recorded: {}", e.getClass().getSimpleName());
        }
        afterSettled.accept(key);
    }

    @Override
    public void planned(RunContext run, Resume.Plan plan) {
        checkpoints.planned(run, plan);
    }

    @Override
    public void admitted(RunContext run, int step, List<com.minimalistalliance.desk.agent.approval.Verdict> verdicts) {
        checkpoints.admitted(run, step, verdicts);
    }

    /** The record's outcome and the checkpoint's result in one transaction (durable runs' checkpoint 3). */
    @Override
    public void settled(RunContext run, String key, ToolResult result, int step, int index, ToolResult forModel,
            Map<String, Object> fields) {
        if (key != null) {
            current.remove(run.runId(), key);
            retrying.remove(key);
        }
        String state = !result.error() ? "done" : Restart.interrupted(result) ? "interrupted" : "failed";
        try {
            checkpoints.result(run, step, index, forModel, fields, key, state,
                    result.error() ? Restart.word(result) : null);
        } catch (SQLException | RuntimeException e) {
            // The checkpoint can't hold it: the record still settles alone, and the run can't resume from here.
            log.warn("a call's outcome wasn't checkpointed: {}", e.getClass().getSimpleName());
            checkpoints.unresumable(run.runId(), "storage");
            if (key != null) {
                try {
                    calls.settle(key, state, result.error() ? Restart.word(result) : null, clock.millis());
                } catch (SQLException | RuntimeException again) {
                    log.warn("a call's outcome wasn't recorded: {}", again.getClass().getSimpleName());
                }
            }
        }
        if (key != null) {
            onSettled.accept(run.runId(), key);
            afterSettled.accept(key);
        }
    }

    /** Told, with the run and the call's key, as a call settles: a wait the call kept and never read ends with it. */
    private volatile java.util.function.BiConsumer<String, String> onSettled = (runId, key) -> {};

    /** Where a settled call's kept wait is ended (durable runs' waits; Security's DR-L10). */
    public void onSettled(java.util.function.BiConsumer<String, String> hook) {
        this.onSettled = hook == null ? (runId, key) -> {} : hook;
    }

    @Override
    public void resending(RunContext run, String key) {
        current.put(run.runId(), key);
        retrying.add(key);
    }

    /** For tests only: runs on the run's thread at each checkpoint, with its name, so a test can kill there. */
    public void atCheckpointForTest(java.util.function.Consumer<String> hook) {
        checkpoints.hook(hook);
    }

    /** For tests only: a kill between a call's record and its approval's outcome waits here. Null is nothing. */
    public void afterSettledForTest(java.util.function.Consumer<String> hook) {
        this.afterSettled = hook == null ? key -> {} : hook;
    }

    /**
     * A run ended, however: a call it left {@code started} (a stop while it waited, or a failure) is {@code
     * interrupted}, {@code detail: "ended"}, and audited, as it may have happened.
     */
    public void ended(String runId) {
        steps.remove(runId);
        String left = current.remove(runId);
        if (left != null) {
            retrying.remove(left);
        }
        try {
            for (RunCallStore.Call c : calls.startedOf(runId)) {
                boolean safe = Restart.SAFE.wireName().equals(c.restart());
                if (calls.settle(c.key(), safe ? "failed" : "interrupted", "ended", clock.millis())) {
                    trace(c, "ended", safe);
                }
            }
        } catch (SQLException | RuntimeException e) {
            log.warn("a run's calls weren't ended: {}", e.getClass().getSimpleName());
        }
        long now = clock.millis();
        if (now - prunedAt >= PRUNE_EVERY.toMillis()) {
            prune(now);
        }
    }

    /**
     * After {@code agent.db} opens, with no run going, and before {@link Approvals#restore}: what a kill left of calls.
     * A call that came back settles its approval from its record; a call still {@code started} ends {@code interrupted}
     * ({@code failed} if {@link Restart#SAFE}), {@code restart}, and is audited. Nothing runs again.
     */
    public void restore(Approvals approvals) throws SQLException {
        restore(approvals, java.util.Set.of());
    }

    /**
     * {@link #restore(Approvals)}, leaving the calls of runs that resume ({@code resuming}) {@code started}: each is
     * asked again by its key, or follows its rule, as its run picks up (durable runs' resume).
     */
    public void restore(Approvals approvals, java.util.Set<String> resuming) throws SQLException {
        for (RunCallStore.Call c : calls.settledWithApprovalOpen()) {
            boolean ok = "done".equals(c.state());
            if (approvals.settledFromRecord(c.approvalId(), ok, c.detail())) {
                audit(c.agentId(), "tool.call", target(c), ok ? "ok" : "error:" + word(c.detail()));
            }
        }
        long now = clock.millis();
        for (RunCallStore.Call c : calls.started()) {
            if (resuming.contains(c.runId())) {
                continue;
            }
            boolean safe = Restart.SAFE.wireName().equals(c.restart());
            if (calls.settle(c.key(), safe ? "failed" : "interrupted", "restart", now)) {
                trace(c, "restart", safe);
            }
        }
        prune(now);
    }

    private void trace(RunCallStore.Call c, String why, boolean safe) {
        if (safe) {
            audit(c.agentId(), "tool.call", target(c), "error:" + why);
        } else {
            audit(c.agentId(), "tool.interrupt", target(c), why);
        }
    }

    private void prune(long now) {
        prunedAt = now;
        try {
            calls.prune(now - KEEP.toMillis());
            checkpoints.store().prune(now - KEEP.toMillis());
        } catch (SQLException | RuntimeException e) {
            log.warn("old call records weren't pruned: {}", e.getClass().getSimpleName());
        }
    }

    /** {@code tool:<name> run:<id> call:<key>}, and the approval or the switch's group: ids only. */
    static String target(RunCallStore.Call c) {
        StringBuilder t = new StringBuilder("tool:").append(clip(c.tool(), 64)).append(" run:")
                .append(clip(c.runId(), 64)).append(" call:").append(clip(c.key(), 40));
        if (c.approvalId() != null) {
            t.append(" approval:").append(clip(c.approvalId(), 40));
        }
        if (c.auto() != null) {
            t.append(" auto:").append(word(c.auto()));
        }
        return t.toString();
    }

    private void audit(String agentId, String action, String target, String decision) {
        try {
            audit.append(new AuditLog.Entry("agent:" + agentId, action, target, null, word(decision), null));
        } catch (SQLException | RuntimeException e) {
            log.warn("an audit row wasn't written: {} {}", action, e.getClass().getSimpleName());
        }
    }

    private static String clip(String text, int max) {
        String plain = text == null ? "" : text.replaceAll("[^A-Za-z0-9_.:-]", "_");
        return plain.length() > max ? plain.substring(0, max) : plain;
    }

    private static String word(String text) {
        String w = text == null ? "none" : text.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9_.:-]", "_");
        if (w.isEmpty() || !Character.isLetter(w.charAt(0))) {
            w = "x" + w;
        }
        return w.length() > 64 ? w.substring(0, 64) : w;
    }
}
