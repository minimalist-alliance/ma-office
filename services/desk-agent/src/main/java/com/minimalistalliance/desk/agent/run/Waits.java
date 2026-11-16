package com.minimalistalliance.desk.agent.run;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.json.JsonFormatException;
import com.minimalistalliance.desk.agent.store.RunStore;
import com.minimalistalliance.desk.agent.tool.RunContext;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** The desk's {@link RunWaits}, on {@code run_waits} in {@code agent.db}. */
public final class Waits implements RunWaits {

    private static final Logger log = LoggerFactory.getLogger(Waits.class);

    /** The longest one sleep before it looks again. */
    static final Duration SLICE = Duration.ofSeconds(5);
    /** The longest wait any call may ask for. */
    public static final Duration MAX = Duration.ofMinutes(10);
    private static final Pattern WORD = Pattern.compile("[a-z][a-z0-9_]{0,31}");

    private final RunStore store;
    private final Clock clock;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition changed = lock.newCondition();
    private final Map<String, String> waitingOn = new ConcurrentHashMap<>();
    /** The agent of each run waiting now. */
    private final Map<String, String> waitingAgents = new ConcurrentHashMap<>();
    private volatile BiConsumer<String, String> onChange = (agentId, runId) -> {};
    private volatile Consumer<Untaken> untaken = u -> {};

    public Waits(RunStore store, Clock clock) {
        this.store = store;
        this.clock = clock;
    }

    /** Told when a run starts or stops waiting: its agent's {@code statusDetail} changed. */
    public void onChange(BiConsumer<String, String> agentAndRun) {
        this.onChange = agentAndRun == null ? (a, r) -> {} : agentAndRun;
    }

    @Override
    public void untaken(Consumer<Untaken> sink) {
        this.untaken = sink == null ? u -> {} : sink;
    }

    @Override
    public Outcome await(RunContext run, String callKey, String kind, String ref, Duration max)
            throws InterruptedException {
        if (callKey == null || !WORD.matcher(kind).matches() || ref == null || max.isNegative()) {
            throw new IllegalArgumentException("a wait needs its call's key, a kind and a ref");
        }
        RunStore.Wait kept = keep(run.runId(), run.agentId(), callKey, kind, ref,
                clock.millis() + Math.min(max.toMillis(), MAX.toMillis()));
        if (kept == null) {
            return Outcome.TIMED_OUT;
        }
        Map<String, Object> answer = awaitKept(run.runId(), run.agentId(), callKey);
        return answer == null ? Outcome.TIMED_OUT : new Outcome(true, answer);
    }

    /**
     * A wait kept from now, before what it waits for goes out (so an answer that comes back first still finds it), or
     * the one kept for this call before a restart, with its first deadline. @return the kept wait, or null if it can't be
     * kept, or a kept one is for another kind or ref
     */
    public RunStore.Wait keep(String runId, String agentId, String callKey, String kind, String ref, long deadlineAt) {
        long now = clock.millis();
        try {
            RunStore.Wait kept = store.await(new RunStore.Wait(runId, callKey, agentId, kind, ref, "waiting",
                    deadlineAt, null, now));
            return kept == null || !kind.equals(kept.kind()) || !ref.equals(kept.ref())
                    || !agentId.equals(kept.agentId()) ? null : kept;
        } catch (SQLException e) {
            log.warn("a wait wasn't kept: {}", e.getClass().getSimpleName());
            return null;
        }
    }

    /**
     * Waits on a kept wait until its answer or its deadline: the answer (now taken), or null when its time ran out. A
     * stop or a pause interrupts it; the wait stays kept for a resume.
     */
    public Map<String, Object> awaitKept(String runId, String agentId, String callKey) throws InterruptedException {
        waitingOn.put(runId, kindOf(runId, callKey));
        waitingAgents.put(runId, agentId);
        onChange.accept(agentId, runId);
        try {
            // What's left of the kept deadline, counted from here on the monotonic clock too (as DeskWaits.Memory did):
            // whichever runs out first ends the wait, so a clock set back can't stretch it.
            long monotonicEnd = Long.MIN_VALUE;
            while (true) {
                RunStore.Wait w = store.wait(runId, callKey);
                if (w == null || !"waiting".equals(w.state()) && w.answer() == null) {
                    return null;
                }
                if (w.answer() != null) {
                    // Kept only if it came in its time (RunStore.answer), so it's this call's result.
                    store.waitState(runId, callKey, w.state(), "taken");
                    return parse(w.answer());
                }
                if (monotonicEnd == Long.MIN_VALUE) {
                    monotonicEnd = System.nanoTime()
                            + TimeUnit.MILLISECONDS.toNanos(Math.max(0, w.deadlineAt() - clock.millis()));
                }
                long left = Math.min(w.deadlineAt() - clock.millis(),
                        TimeUnit.NANOSECONDS.toMillis(monotonicEnd - System.nanoTime()));
                if (left <= 0) {
                    if (store.waitState(runId, callKey, "waiting", "timed_out")) {
                        return null;
                    }
                    // An answer took it just now: it's this call's, read it on the next turn.
                    continue;
                }
                lock.lockInterruptibly();
                try {
                    changed.await(Math.max(1, Math.min(left, SLICE.toMillis())), TimeUnit.MILLISECONDS);
                } finally {
                    lock.unlock();
                }
            }
        } catch (SQLException e) {
            log.warn("a wait wasn't read: {}", e.getClass().getSimpleName());
            return null;
        } finally {
            waitingOn.remove(runId);
            waitingAgents.remove(runId);
            onChange.accept(agentId, runId);
        }
    }

    /** Nothing to wait for after all (what it waited for never went): an answer, if one comes, isn't taken. */
    public void cancel(String runId, String callKey) {
        try {
            store.waitState(runId, callKey, "waiting", "cancelled");
        } catch (SQLException e) {
            log.warn("a wait wasn't cancelled: {}", e.getClass().getSimpleName());
        }
    }

    /** A call settled: any wait it kept still {@code waiting} is cancelled (it never read it). */
    public void cancelAny(String runId, String callKey) {
        cancel(runId, callKey);
    }

    /** Whether one of the agent's runs waits now. */
    public boolean waitingAgent(String agentId) {
        return waitingAgents.containsValue(agentId);
    }

    private String kindOf(String runId, String callKey) {
        try {
            RunStore.Wait w = store.wait(runId, callKey);
            return w == null ? "desk" : w.kind();
        } catch (SQLException e) {
            return "desk";
        }
    }

    @Override
    public boolean answer(String agentId, String kind, String ref, Map<String, Object> answer) {
        try {
            boolean took = !store.answer(agentId, kind, ref, new String(Json.bytes(answer), StandardCharsets.UTF_8),
                    clock.millis()).isEmpty();
            wake();
            return took;
        } catch (SQLException | RuntimeException e) {
            log.warn("an answer wasn't kept: {}", e.getClass().getSimpleName());
            return false;
        }
    }

    @Override
    public String waitingOn(String runId) {
        return runId == null ? null : waitingOn.get(runId);
    }

    /**
     * The run ended: an answer one of its waits took and it never read goes to {@link #untaken}, before the run's
     * checkpoint (and its waits) go.
     */
    public void ended(String runId) {
        ended(runId, false);
    }

    /**
     * {@link #ended(String)}; {@code cutOff} for a run a restart ended without resuming: an answer its call had taken
     * goes to the thread too, as the run's reply never said it (one answer, one place, never neither).
     */
    public void ended(String runId, boolean cutOff) {
        try {
            for (RunStore.Wait w : store.waitsOf(runId)) {
                if (("answered".equals(w.state()) || cutOff && "taken".equals(w.state())) && w.answer() != null) {
                    untaken.accept(new Untaken(runId, w.agentId(), w.kind(), w.ref(), parse(w.answer())));
                }
            }
        } catch (SQLException | RuntimeException e) {
            log.warn("a run's waits weren't read: {}", e.getClass().getSimpleName());
        }
    }

    /** Every wait looks again now: an answer came, or a test's clock moved. */
    public void wake() {
        lock.lock();
        try {
            changed.signalAll();
        } finally {
            lock.unlock();
        }
    }

    private static Map<String, Object> parse(String json) {
        try {
            return Json.parseObject(json.getBytes(StandardCharsets.UTF_8));
        } catch (JsonFormatException e) {
            return Map.of();
        }
    }
}
