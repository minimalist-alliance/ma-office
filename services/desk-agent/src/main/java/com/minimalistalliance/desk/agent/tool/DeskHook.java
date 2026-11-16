package com.minimalistalliance.desk.agent.tool;

import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import java.util.List;
import java.util.Map;

/**
 * Where messages between the member's desks (draft ADR "the Agent's tools and approvals", §14) meet the tools: deskd
 * runs {@code desk_message} and {@code desk_answer} and makes their sealed envelopes, and desk-agent's {@code desks}
 * package names the desks, puts the envelopes in its outbox and waits for the answer. Kept to this one seam so the tool
 * code doesn't know the outbox. {@link #NONE} until it's wired.
 */
public interface DeskHook {

    /**
     * The call's arguments for deskd's look: {@code desk_message}'s {@code desk}, a name or an id, as the id of a desk the
     * agent has an active grant to. Null when it has none there: refused {@code no_grant} before anyone is asked.
     */
    Map<String, Object> args(String agentId, String tool, Map<String, Object> input);

    /** The card's target with the desk's and the other agent's names, which deskd doesn't know. */
    Map<String, Object> target(String agentId, String tool, Map<String, Object> target);

    /**
     * What the model reads once deskd made the envelope ({@code made}: {@code {id, grantId, toDeskId, kind, seq,
     * envelope}}): the envelope goes in the outbox, and {@code desk_message} waits up to 120 s for the answer.
     *
     * @param key the call's key (the durable seam's record key), or null
     * @throws InterruptedException the run was stopped while it waited
     */
    ToolResult after(ToolCall call, RunContext run, String key, Map<String, Object> made) throws InterruptedException;

    /** The desks the agent may message now, for its instructions: {@code "Work" (d-…)} each. */
    List<String> desks(String agentId);

    /**
     * Whether the call is a run's own closing call ({@link com.minimalistalliance.desk.agent.manager.ManagerAgent.Closing}),
     * made by desk-agent and never by a model: a tool no model is offered ({@link ToolRegistry#NOT_OFFERED}) runs only so.
     */
    default boolean closing(ToolCall call) {
        return false;
    }

    DeskHook NONE = new DeskHook() {
        @Override
        public Map<String, Object> args(String agentId, String tool, Map<String, Object> input) {
            return null;
        }

        @Override
        public Map<String, Object> target(String agentId, String tool, Map<String, Object> target) {
            return target;
        }

        @Override
        public ToolResult after(ToolCall call, RunContext run, String key, Map<String, Object> made) {
            return new ToolResult(call.id(), "Failed: unavailable.", true);
        }

        @Override
        public List<String> desks(String agentId) {
            return List.of();
        }
    };
}
