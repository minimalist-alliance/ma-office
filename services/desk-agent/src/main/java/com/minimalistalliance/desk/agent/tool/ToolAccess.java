package com.minimalistalliance.desk.agent.tool;

/**
 * Which of the tools an agent may have now, by the member's choice on its setup screen and in its settings (draft ADR
 * "the Agent's tools and approvals", section 16): an app switched off takes its tools away from the next step, and a
 * call to one is refused {@code scope} before anything is asked. {@code access.AccessBook} is the real one. It's read
 * at every step and every call, never cached by a run, so a change applies to a run already going.
 */
public interface ToolAccess {

    /** Whether the agent may have this tool now. A tool no app gates (its own workspace, plan, memory) is always true. */
    boolean allows(String agentId, String tool);

    /**
     * deskd refused a call of this agent's {@code setup}: it holds no copy of the member's choice for it (lost with its
     * file, or a file that didn't verify). The agent then waits for the member to confirm its screen again; this can
     * only take access away, never give it.
     */
    default void deskdHasNoRecord(String agentId) {}

    /** Every tool, for tests and a desk-agent wired without a book. */
    ToolAccess ALL = (agentId, tool) -> true;
}
