package com.minimalistalliance.desk.agent.run;

import com.minimalistalliance.desk.agent.tool.RunContext;
import java.time.Duration;
import java.util.Map;

/**
 * A call's wait for something outside its run, kept in {@code agent.db} so a restart picks it up with what's left of its
 * time (durable runs; the draft ADR's §14, "The wait"): an answer from an agent on the member's other desk, 120 s at
 * most. The approvals' own wait ({@code awaiting_approval}) and timers are durable on their own; this is the interface
 * every other wait uses.
 *
 * <p><b>How a tool uses it.</b> The call that starts the wait is keyed (its record's key, which deskd keeps it by), and
 * once what it waits for is on its way (an envelope in the outbox), it calls {@link #await} with that key, a
 * {@code kind} and the {@code ref} the answer will name (the envelope's id). A restart while it waits leaves the call
 * {@code started}; its run picks up, asks deskd again by the key (the same envelope, sent once), and the tool calls
 * {@link #await} again with the same key: the kept wait, with its first deadline, or the answer that came meanwhile. So
 * the tool's code is the same either way. Its declaration's {@code restart} must be {@code retry_by_key} (deskd keeps
 * its reply), or a restart ends it {@code interrupted} instead.
 *
 * <p><b>While it waits</b> the agent is {@code working} with {@code statusDetail: "waiting_<kind>"} ({@code waiting_desk})
 * and its run's state is that too; like {@code awaiting_approval}, it doesn't keep the desk awake (deskd's agent
 * status). A stop ends the wait; a pause (SIGTERM) keeps it.
 *
 * <p><b>An answer</b> goes to {@link #answer}. When a wait (live, or kept for a run that resumes) takes it, it's that
 * call's result. When none does (its time ran out, or nothing waited), {@code answer} says so and the caller puts it in
 * the thread instead. An answer a kept wait took whose run then ends without picking it up is handed to
 * {@link #untaken} as its run ends, so it's never lost.
 */
public interface RunWaits {

    /** What a wait came to: the answer, or none when its time ran out. */
    record Outcome(boolean answered, Map<String, Object> answer) {
        public static final Outcome TIMED_OUT = new Outcome(false, null);
    }

    /** An answer a kept wait took whose run ended without it: for the thread. */
    record Untaken(String runId, String agentId, String kind, String ref, Map<String, Object> answer) {}

    /**
     * Waits, at most {@code max} from the first time this call waited, for an answer of {@code kind} naming
     * {@code ref}. Called again with the same {@code callKey} after a restart, it picks the same wait up.
     *
     * @param kind one word: {@code desk}
     * @throws InterruptedException the run stops (the wait ends) or pauses (the wait is kept)
     */
    Outcome await(RunContext run, String callKey, String kind, String ref, Duration max) throws InterruptedException;

    /**
     * An answer came, for {@code agentId}'s wait on {@code kind} and {@code ref}: only that agent's wait, and only while
     * it's in its time (a late one takes none). The caller checks the answer is the one this wait was for (the grant, the
     * envelope it replies to) before it calls this. @return whether a wait took it
     */
    boolean answer(String agentId, String kind, String ref, Map<String, Object> answer);

    /** The kind the run waits on now, or null: {@code agent.state}'s {@code statusDetail} is {@code waiting_<kind>}. */
    String waitingOn(String runId);

    /** Where answers no run will take go, as their run ends. */
    void untaken(java.util.function.Consumer<Untaken> sink);
}
