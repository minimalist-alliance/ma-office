package com.minimalistalliance.desk.agent.maia;

import com.minimalistalliance.desk.agent.tool.Taint;
import java.util.Map;
import java.util.Set;

/**
 * What Maia Mode's code needs of the agent service to act without a model (deskd {@code API.md} §23): a call to one of
 * deskd's tools for an agent, through the same policy, gate and deskd checks as a run's call, that never asks the
 * member ({@code Approvals.admitUnasked}), and one model call with no tools: Desk Maia's on Minimalist Alliance's
 * service (task {@code notes}), another agent's on its own key.
 */
public interface CodeCalls {

    /** What a call came to. {@code approvalId} is the row of a call done without asking (its Undo), else null. */
    record Result(boolean ok, String approvalId, Object content, String refusal) {
        public static Result refusedWith(String why) {
            return new Result(false, null, null, why);
        }
    }

    /**
     * One deskd-hosted call by code, in run {@code runId} of {@code agentId}, whose reply is {@code replyId} (null for
     * none), with these flags from the start. Never asks: a call that would ask is refused {@code would_ask}.
     */
    Result call(String agentId, String runId, Map<String, Object> origin, String replyId, Set<Taint> taint,
            String tool, Map<String, Object> input) throws InterruptedException;

    /** The code's run is over: deskd and the gate forget it. {@code done} as a run's end says it. */
    void ended(String agentId, String runId, boolean done);

    /**
     * One model call with no tools, on {@code agentId}'s binding (Desk Maia's: her service, task {@code notes}; another
     * agent's: its own key), under its limits, for a small job ({@code purpose}: a word for the audit), on the provider's
     * small model where there is one. @return its text, or null when it couldn't run (no key, a limit, the provider)
     */
    String complete(String agentId, String purpose, String system, String user, int maxOutputTokens)
            throws InterruptedException;
}
