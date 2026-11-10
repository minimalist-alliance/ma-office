package com.minimalistalliance.desk.agent.store;

/**
 * One message of a thread as stored. The member's have only id, role, text and time; a reply adds its run, badge,
 * usage and cost (JSON), stop reason, state ({@code streaming}, {@code done}, {@code stopped} or {@code failed}) and,
 * when it failed, a reason word and a detail word.
 */
public record MessageRow(
        String id,
        String agentId,
        String role,
        String text,
        long at,
        String runId,
        String badge,
        String usage,
        Long costMicroUsd,
        String stopReason,
        String state,
        String error,
        String errorDetail,
        String origin,
        String tools) {

    /** A row from before task 49's {@code origin} and {@code tools}: the member wrote it, and no tool ran. */
    public MessageRow(String id, String agentId, String role, String text, long at, String runId, String badge,
            String usage, Long costMicroUsd, String stopReason, String state, String error, String errorDetail) {
        this(id, agentId, role, text, at, runId, badge, usage, costMicroUsd, stopReason, state, error, errorDetail,
                null, null);
    }

    public static MessageRow user(String id, String agentId, String text, long at) {
        return new MessageRow(id, agentId, "user", text, at, null, null, null, null, null, null, null, null);
    }

    /** A user turn the member didn't write: from another agent or a timer, {@code origin} as JSON (ADR 0047). */
    public static MessageRow from(String id, String agentId, String text, long at, String origin) {
        return new MessageRow(id, agentId, "user", text, at, null, null, null, null, null, null, null, null, origin,
                null);
    }

    /** The same reply with the tools its run called, as JSON chips. */
    public MessageRow withTools(String toolsJson) {
        return new MessageRow(id, agentId, role, text, at, runId, badge, usage, costMicroUsd, stopReason, state, error,
                errorDetail, origin, toolsJson);
    }

    /** No content in logs or exceptions. */
    @Override
    public String toString() {
        return "MessageRow[" + id + ", " + role + ", " + text.length() + " chars, " + state + "]";
    }
}
