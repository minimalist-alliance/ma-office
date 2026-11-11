package com.minimalistalliance.desk.deskd.tools;

import java.util.Map;

/**
 * deskd's own record of the approvals it relayed (draft ADR, section 3, "deskd checks again"): the approvals builder's
 * {@code ApprovalTickets}, which keeps {@code {approvalId, sha256, agentId, caller}} for each {@code agent.approval.decide}
 * that desk-agent answered {@code approved}, from a session of the agent's owner, for 10 minutes. {@link ToolHost} calls
 * {@link #redeem} before it runs any call whose class asks.
 */
@FunctionalInterface
public interface Tickets {

    /**
     * Spends one relayed approval. The ledger recomputes the hash itself from what deskd received.
     *
     * @param sha256 the hash deskd computed over the arguments it received ({@link ToolHost#hash}), never desk-agent's
     * @param context deskd's own context for the call: {@code agent} or {@code member:<site>}
     * @param args the arguments deskd received, which run as they are
     * @return null once, for an approval deskd relayed for this agent with this hash, within its time; otherwise the
     *     refusal: {@code approval_unknown}, {@code approval_used} or {@code approval_mismatch}
     */
    String redeem(String approvalId, String sha256, String agentId, String runId, String tool, String context,
            Map<String, Object> args);

    /** Until the ledger is wired: no approval redeems, so nothing that asks can run. */
    Tickets NONE = (approvalId, sha256, agentId, runId, tool, context, args) -> "approval_unknown";
}
