package com.minimalistalliance.desk.deskd.tools;

import com.minimalistalliance.desk.deskd.rpc.Caller;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Consumer;

/**
 * deskd's own copy of each run's taint (draft ADR, section 6): from desk-agent's flags on every call plus the taints of
 * deskd's own results, and only ever added to. A run is known from its first call to {@code run_end}, or until it has
 * been idle for {@link #IDLE}, longer than an approval can wait. In RAM only: a deskd restart forgets it, and desk-agent's
 * flags on the next call bring it back.
 *
 * <p>A run belongs to one agent: a call naming a known run with another agent is refused.
 */
public final class RunLedger {

    /** Longer than the longest an approval waits (24 hours), so a waiting run keeps its taint. */
    static final Duration IDLE = Duration.ofHours(25);
    /** Runs known at once. Past this, the one idle longest goes first: a desk runs at most a few at a time. */
    static final int MAX_RUNS = 256;

    /** The two flags, by their wire names. */
    public enum Flag {
        U,
        S;

        /** @return the flag, or null for a name that isn't one */
        static Flag of(Object name) {
            return "U".equals(name) ? U : "S".equals(name) ? S : null;
        }
    }

    /** One run. Its flags only grow. */
    public static final class Run {
        private final String runId;
        private final String agentId;
        private final Caller caller;
        private final Set<Flag> flags = EnumSet.noneOf(Flag.class);
        private Instant lastUsed;

        Run(String runId, String agentId, Caller caller, Instant now) {
            this.runId = runId;
            this.agentId = agentId;
            this.caller = caller;
            this.lastUsed = now;
        }

        public String runId() {
            return runId;
        }

        public String agentId() {
            return agentId;
        }

        public Caller caller() {
            return caller;
        }

        public synchronized boolean untrusted() {
            return flags.contains(Flag.U);
        }

        public synchronized boolean privateData() {
            return flags.contains(Flag.S);
        }

        /** Adds flags by wire name; anything else is ignored. Never removes. */
        public synchronized void add(Collection<?> names) {
            if (names == null) {
                return;
            }
            for (Object name : names) {
                Flag flag = Flag.of(name);
                if (flag != null) {
                    flags.add(flag);
                }
            }
        }

        /** The flags now, as wire names in order. */
        public synchronized List<String> flags() {
            List<String> out = new ArrayList<>();
            for (Flag flag : flags) {
                out.add(flag.name());
            }
            return out;
        }

        @Override
        public String toString() {
            return "Run[" + runId + ", " + flags() + "]";
        }
    }

    private final Clock clock;
    private final Map<String, Run> runs = new LinkedHashMap<>(16, 0.75f, true);
    private final Consumer<String> ended;

    /** @param ended told of each run that ends or is forgotten, outside the ledger's lock */
    public RunLedger(Clock clock, Consumer<String> ended) {
        this.clock = clock;
        this.ended = ended;
    }

    /**
     * The run, made at its first call, with desk-agent's flags added.
     *
     * @throws ToolFailure {@code forbidden} {@code run} for a run of another agent
     */
    public Run join(String runId, String agentId, Caller caller, Collection<?> flags) throws ToolFailure {
        List<String> gone = new ArrayList<>();
        Run run;
        try {
            synchronized (this) {
                Instant now = clock.instant();
                expire(now, gone);
                run = runs.get(runId);
                if (run == null) {
                    while (runs.size() >= MAX_RUNS) {
                        String oldest = runs.keySet().iterator().next();
                        runs.remove(oldest);
                        gone.add(oldest);
                    }
                    run = new Run(runId, agentId, caller, now);
                    runs.put(runId, run);
                } else if (!run.agentId.equals(agentId) || !run.caller.samePerson(caller)) {
                    throw ToolFailure.forbidden("run");
                }
                run.lastUsed = now;
            }
        } finally {
            gone.forEach(ended);
        }
        run.add(flags);
        return run;
    }

    /** The run ended: forgotten, and its areas told. Harmless for a run deskd never saw. */
    public void end(String runId) {
        synchronized (this) {
            runs.remove(runId);
        }
        ended.accept(runId);
    }

    /** Every run ends, as at deskd's shutdown. */
    public void endAll() {
        List<String> all;
        synchronized (this) {
            all = new ArrayList<>(runs.keySet());
            runs.clear();
        }
        all.forEach(ended);
    }

    /** For tests and /health: how many runs are known. */
    public synchronized int size() {
        return runs.size();
    }

    /** For tests: the runs known now, by id. */
    synchronized Set<String> runIds() {
        return Collections.unmodifiableSet(new TreeSet<>(runs.keySet()));
    }

    private void expire(Instant now, List<String> gone) {
        var it = runs.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, Run> entry = it.next();
            if (Duration.between(entry.getValue().lastUsed, now).compareTo(IDLE) < 0) {
                break; // access order: the rest are newer
            }
            it.remove();
            gone.add(entry.getKey());
        }
    }
}
