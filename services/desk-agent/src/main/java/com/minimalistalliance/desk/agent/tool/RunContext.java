package com.minimalistalliance.desk.agent.tool;

import com.minimalistalliance.desk.agent.service.Caller;
import java.util.Collections;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * One run, as the policy and the gate see it (draft ADR, section 11).
 *
 * @param runId the run
 * @param agentId the agent that runs it
 * @param owner who owns the agent, so who alone may approve: {@link Caller#OWNER} for the desk's agents, the member
 *     for a guild member's own agent
 * @param origin what started the run, as a proposal's: {@code {kind: "member"}}, {@code {kind: "timer", agentId,
 *     timerId, label}}, {@code {kind: "agent", agentId, name}}
 * @param taint the run's flags; only ever added to, through {@link #add}
 * @param messageId the reply this run writes, which its approvals name (an addition to the ADR's shape)
 */
public record RunContext(String runId, String agentId, Caller owner, Map<String, Object> origin, Set<Taint> taint,
        String messageId) {

    public RunContext {
        Objects.requireNonNull(runId, "runId");
        Objects.requireNonNull(agentId, "agentId");
        Objects.requireNonNull(owner, "owner");
        origin = origin == null || origin.isEmpty() ? Map.of("kind", "member")
                : Collections.unmodifiableMap(new LinkedHashMap<>(origin));
        // Kept by reference when it is already the run's own set, so adds through any copy reach the one run.
        if (!(taint instanceof Flags)) {
            Flags flags = new Flags();
            if (taint != null) {
                flags.addAll(taint);
            }
            taint = flags;
        }
    }

    /** A run with no flags yet. */
    public static RunContext of(String runId, String agentId, Caller owner, Map<String, Object> origin,
            String messageId) {
        return new RunContext(runId, agentId, owner, origin, null, messageId);
    }

    /**
     * A run with these flags from the start (its thread's, its attachments', its origin's), whose flags also reach
     * {@code upstream} as they're added: the run of the agent whose message started this one, which reads this run's
     * reply as its tool's result. Null for none.
     */
    public static RunContext of(String runId, String agentId, Caller owner, Map<String, Object> origin,
            String messageId, Set<Taint> start, RunContext upstream) {
        // A run's own set (a RunSetup's taint) is kept by reference, so what memory or a tool adds there is the run's.
        Flags flags = start instanceof Flags own ? own : new Flags();
        if (start != null && flags != start) {
            flags.addAll(start);
        }
        if (upstream != null) {
            flags.forwardTo((Flags) upstream.taint());
        }
        return new RunContext(runId, agentId, owner, origin, flags, messageId);
    }

    /** Adds what a result declared. Never removes. */
    public void add(Set<Taint> more) {
        if (more != null) {
            taint.addAll(more);
        }
    }

    public boolean untrusted() {
        return taint.contains(Taint.U);
    }

    public boolean privateData() {
        return taint.contains(Taint.S);
    }

    /** A run the member didn't start themselves: a timer's or another agent's. */
    public boolean unattended() {
        return !"member".equals(origin.get("kind"));
    }

    /**
     * The run's flag set: thread-safe, only ever added to ({@code remove}, {@code clear}, {@code retainAll} and the
     * iterator's {@code remove} are refused), each add passed on to the run upstream, if any.
     */
    static final class Flags extends java.util.AbstractSet<Taint> {
        private final Set<Taint> set = Collections.synchronizedSet(EnumSet.noneOf(Taint.class));
        private volatile Flags upstream;

        /** From now on every add here reaches {@code up} too, and what this set holds already goes now. */
        void forwardTo(Flags up) {
            if (up == this) {
                return;
            }
            upstream = up;
            for (Taint t : this) {
                up.add(t);
            }
        }

        @Override
        public boolean add(Taint t) {
            boolean added = set.add(Objects.requireNonNull(t));
            Flags up = upstream;
            if (up != null) {
                up.add(t);
            }
            return added;
        }

        @Override
        public boolean retainAll(java.util.Collection<?> c) {
            throw new UnsupportedOperationException("a run's taint is never cleared");
        }

        @Override
        public boolean removeAll(java.util.Collection<?> c) {
            throw new UnsupportedOperationException("a run's taint is never cleared");
        }

        @Override
        public boolean contains(Object o) {
            return set.contains(o);
        }

        @Override
        public java.util.Iterator<Taint> iterator() {
            Set<Taint> copy;
            synchronized (set) {
                copy = set.isEmpty() ? EnumSet.noneOf(Taint.class) : EnumSet.copyOf(set);
            }
            return Collections.unmodifiableSet(copy).iterator();
        }

        @Override
        public int size() {
            return set.size();
        }

        @Override
        public boolean remove(Object o) {
            throw new UnsupportedOperationException("a run's taint is never cleared");
        }

        @Override
        public void clear() {
            throw new UnsupportedOperationException("a run's taint is never cleared");
        }
    }

    /** No ids beyond the run's in logs. */
    @Override
    public String toString() {
        return "RunContext[" + runId + ", " + taint + "]";
    }
}
