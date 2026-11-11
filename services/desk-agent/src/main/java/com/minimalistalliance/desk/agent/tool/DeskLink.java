package com.minimalistalliance.desk.agent.tool;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * desk-agent's way to the tools deskd runs (draft ADR "the Agent's tools and approvals", section 11;
 * {@code docs/proposals.md} section 5, "Tool calls"): a {@code tcall} on the agent socket, answered {@code tres} or
 * {@code terr}. deskd says which tools it runs in its hello on each connection; until it has, none is offered, so an
 * older deskd, which drops the link on a {@code t} it doesn't know, never gets one.
 */
public interface DeskLink {

    /** The tools deskd said it runs, on the connection now; empty without one. */
    Set<String> offered();

    /**
     * One {@code tcall}, waiting for its answer.
     *
     * @param call the frame's fields but {@code t} and {@code id}: {@code runId}, {@code agentId}, {@code tool},
     *     {@code args}, {@code taint}, and {@code phase}, {@code approval}, {@code context} as needed
     * @return deskd's answer; {@link Reply#unavailable} when there's no connection, it went, or no answer came in time
     */
    Reply call(Map<String, Object> call, Duration wait) throws InterruptedException;

    /**
     * deskd's answer.
     *
     * @param ok {@code tres}
     * @param r the result ({@code tres})
     * @param code deskd's error code ({@code terr})
     * @param reason {@code details.reason}, one word
     * @param taint the run's flags as deskd holds them now
     */
    record Reply(boolean ok, Map<String, Object> r, String code, String reason, List<String> taint) {
        public Reply {
            r = r == null ? Map.of() : r;
            taint = taint == null ? List.of() : List.copyOf(taint);
        }

        public static Reply unavailable() {
            return new Reply(false, null, "unavailable", "unavailable", null);
        }
    }

    /** No deskd tools: what tests and a desk-agent with no socket have. */
    DeskLink NONE = new DeskLink() {
        @Override
        public Set<String> offered() {
            return Set.of();
        }

        @Override
        public Reply call(Map<String, Object> call, Duration wait) {
            return Reply.unavailable();
        }
    };
}
