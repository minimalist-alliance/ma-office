package com.minimalistalliance.desk.agent.desks;

import java.time.Clock;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;

/**
 * {@code desk_message}'s 120 s wait for the other desk's answer (draft ADR "the Agent's tools and approvals", §14), behind
 * one small interface so durable runs can keep it (durable runs, Design 1: the resume's {@code run_waits}, keyed by the
 * run and its call's key, with {@code kind} {@code desk} and {@code ref} the message's envelope id, a deadline and the
 * answer once it comes). Today's {@link Memory} keeps waits in RAM: a restart of desk-agent ends the waiting run as any run
 * ends, and the answer that comes later goes to the thread, as one that comes after the wait does.
 *
 * <p><b>One answer goes to exactly one place.</b> {@link #answer} hands it to a call still waiting and says so, or says
 * no one took it, and then the answer goes to the agent's thread. A wait that runs out takes itself away under the same
 * lock first, so an answer that comes as the time runs out is either the tool's result or the thread's, never both and
 * never neither.
 */
public interface DeskWaits {

    /** The wait's kind in the resume's {@code run_waits}. */
    String KIND = "desk";

    /**
     * A wait for the answer to the envelope {@code ref}, kept from now on, before the message goes in the outbox: an
     * answer that comes back before {@link Wait#await} is called still goes to it.
     *
     * @param runId the waiting run
     * @param callKey its call's key (the durable seam's record key), or null
     * @param agentId the run's agent
     * @param ref the message's envelope id, which the answer's {@code replyTo} names
     * @param deadlineAt ms since the epoch
     */
    Wait expect(String runId, String callKey, String agentId, String ref, long deadlineAt);

    /** One wait. */
    interface Wait {
        /**
         * @return the answer as deskd opened it, or null when the time ran out
         * @throws InterruptedException the run was stopped while it waited: the answer, when it comes, goes to the thread
         */
        Map<String, Object> await() throws InterruptedException;

        /** Nothing to wait for after all (the message never went): the wait goes, and any answer to the thread. */
        void cancel();
    }

    /** An answer came for {@code ref}: true if a wait took it, false if it goes to the thread. */
    boolean answer(String ref, Map<String, Object> answer);

    /** Whether one of the agent's runs is waiting now: its status says {@code waiting_desk}. */
    boolean waiting(String agentId);

    /** The waits in RAM. */
    final class Memory implements DeskWaits {
        private final Clock clock;
        private final ReentrantLock lock = new ReentrantLock();
        private final Map<String, Slot> byRef = new ConcurrentHashMap<>();

        private static final class Slot {
            final String agentId;
            final Condition arrived;
            Map<String, Object> answer;

            Slot(String agentId, Condition arrived) {
                this.agentId = agentId;
                this.arrived = arrived;
            }
        }

        public Memory(Clock clock) {
            this.clock = Objects.requireNonNull(clock);
        }

        @Override
        public Wait expect(String runId, String callKey, String agentId, String ref, long deadlineAt) {
            lock.lock();
            Slot slot;
            try {
                slot = new Slot(agentId, lock.newCondition());
                byRef.put(ref, slot);
            } finally {
                lock.unlock();
            }
            return new Wait() {
                @Override
                public Map<String, Object> await() throws InterruptedException {
                    // What's left of the deadline, counted from here on the monotonic clock, so a clock set back or
                    // forward meanwhile can't stretch or cut the wait.
                    long end = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(Math.max(0, deadlineAt - clock.millis()));
                    lock.lock();
                    try {
                        while (slot.answer == null) {
                            long left = end - System.nanoTime();
                            if (left <= 0) {
                                return null;
                            }
                            slot.arrived.awaitNanos(left);
                        }
                        return slot.answer;
                    } finally {
                        // Out of the map under the lock: an answer from here on goes to the thread.
                        byRef.remove(ref, slot);
                        lock.unlock();
                    }
                }

                @Override
                public void cancel() {
                    lock.lock();
                    try {
                        byRef.remove(ref, slot);
                    } finally {
                        lock.unlock();
                    }
                }
            };
        }

        @Override
        public boolean answer(String ref, Map<String, Object> answer) {
            lock.lock();
            try {
                Slot slot = byRef.remove(ref);
                if (slot == null) {
                    return false;
                }
                slot.answer = answer;
                slot.arrived.signalAll();
                return true;
            } finally {
                lock.unlock();
            }
        }

        @Override
        public boolean waiting(String agentId) {
            for (Slot slot : byRef.values()) {
                if (slot.agentId.equals(agentId)) {
                    return true;
                }
            }
            return false;
        }
    }
}
