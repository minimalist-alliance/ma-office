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
     * Whether deskd said, on the connection now, that it keeps calls' results by their key ({@code keys} in its hello):
     * only then may a call that got no answer be asked again with {@code retry: true}, as an older deskd would run it
     * twice.
     */
    default boolean keyed() {
        return false;
    }

    /**
     * Whether deskd said, on the connection now, that it relays Desk Maia's model to her service on Minimalist Alliance's
     * AI account ({@code maia: {model: true}} in its hello; deskd {@code API.md} §23, "Her model"). Until it has, her calls
     * are {@code unavailable} {@code no_service} and no {@code maia_model} call is sent.
     */
    default boolean maiaModel() {
        return false;
    }

    /**
     * Whether deskd said, on the connection now, that it relays helpers' model calls on the member's MA credits ({@code
     * helpers: {model: true}} in its hello; deskd {@code API.md} §24). Until it has, MA's credits aren't offered and no {@code
     * helpers_model} or {@code helpers_credits} call is sent.
     */
    default boolean helpersModel() {
        return false;
    }

    /**
     * One {@code tcall}, waiting for its answer.
     *
     * @param call the frame's fields but {@code t} and {@code id}: {@code runId}, {@code agentId}, {@code tool},
     *     {@code args}, {@code taint}, and {@code phase}, {@code approval}, {@code context}, {@code key},
     *     {@code retry} as needed
     * @return deskd's answer; {@link Reply#unavailable} when it wasn't sent (no connection, too many waiting), and
     *     {@link Reply#noAnswer} when it was and no answer came: the connection went, or the wait ran out, so it may have
     * run
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
     * @param lost the call went and no answer came: it may or may not have run
     * @param details {@code terr}'s other details deskd passed on, each checked for its shape: {@code resetsAt},
     *     {@code window} and {@code retryAfterSec} (Desk Maia's model's refusals); empty otherwise
     */
    record Reply(boolean ok, Map<String, Object> r, String code, String reason, List<String> taint, boolean lost,
            Map<String, Object> details) {
        public Reply {
            r = r == null ? Map.of() : r;
            taint = taint == null ? List.of() : List.copyOf(taint);
            details = details == null ? Map.of() : Map.copyOf(details);
        }

        public Reply(boolean ok, Map<String, Object> r, String code, String reason, List<String> taint, boolean lost) {
            this(ok, r, code, reason, taint, lost, null);
        }

        public Reply(boolean ok, Map<String, Object> r, String code, String reason, List<String> taint) {
            this(ok, r, code, reason, taint, false, null);
        }

        /** Not sent: nothing happened. */
        public static Reply unavailable() {
            return new Reply(false, null, "unavailable", "unavailable", null);
        }

        /** Sent, and no answer came: it may have run. */
        public static Reply noAnswer() {
            return new Reply(false, null, "unavailable", "unavailable", null, true);
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
