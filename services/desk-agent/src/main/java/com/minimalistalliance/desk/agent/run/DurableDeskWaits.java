package com.minimalistalliance.desk.agent.run;

import com.minimalistalliance.desk.agent.desks.DeskWaits;
import java.util.Map;
import java.util.function.Function;

/**
 * Desk messages' 120 s wait (draft ADR §14, {@code desks.DeskWaits}) kept durable (durable runs, {@link Waits} on
 * {@code run_waits}): {@code expect} keeps the wait before the message goes in the outbox, with its deadline; after a
 * restart the run asks deskd again by its key, {@code desk_message} expects again with the same key, and gets the kept
 * wait, its first deadline and any answer that came meanwhile. An answer goes to the waiting call only if it's that
 * agent's wait and in its time (Security's DR-L9); otherwise, or once the wait ran out or was cancelled, it goes to the
 * thread. One answer, one place.
 */
public final class DurableDeskWaits implements DeskWaits {

    private final Waits waits;
    /** The agent whose message an envelope id is: the outbox row's ({@code DeskBook.out}). */
    private final Function<String, String> agentOf;

    public DurableDeskWaits(Waits waits, Function<String, String> agentOf) {
        this.waits = waits;
        this.agentOf = agentOf;
    }

    @Override
    public Wait expect(String runId, String callKey, String agentId, String ref, long deadlineAt) {
        // A call with no key (a deskd that keeps none) still waits, kept under the envelope's own id.
        String key = callKey == null ? "env:" + ref : callKey;
        boolean kept = waits.keep(runId, agentId, key, KIND, ref, deadlineAt) != null;
        return new Wait() {
            @Override
            public Map<String, Object> await() throws InterruptedException {
                return kept ? waits.awaitKept(runId, agentId, key) : null;
            }

            @Override
            public void cancel() {
                waits.cancel(runId, key);
            }
        };
    }

    @Override
    public boolean answer(String ref, Map<String, Object> answer) {
        String agentId = agentOf.apply(ref);
        return agentId != null && waits.answer(agentId, KIND, ref, answer);
    }

    @Override
    public boolean waiting(String agentId) {
        return waits.waitingAgent(agentId);
    }
}
