package com.minimalistalliance.desk.agent.tool;

import java.util.List;
import java.util.Map;

/**
 * A check on a deskd-hosted call that only one agent's runtime needs (Desk Maia's grants, deskd {@code API.md} §23),
 * run by {@link RegistryPolicy} before deskd's look and by {@link AgentTools} again as the call goes. It can refuse a
 * call before anyone is asked, raise its class, and add flags for deskd: it can never lower a class or lift a refusal.
 */
public interface HostedGuard {

    HostedGuard NONE = new HostedGuard() {};

    /** @return a refusal word, decided before asking; null to let the call on */
    default String refusal(RunContext run, String tool, Map<String, Object> args) {
        return null;
    }

    /** @return the least class this call takes: the declaration's and deskd's still apply above it */
    default Risk floor(RunContext run, String tool, Map<String, Object> args) {
        return Risk.READ;
    }

    /** @return extra flags deskd gets with the run's {@code U} and {@code S}: only ever more, never fewer */
    default List<String> flags(RunContext run) {
        return List.of();
    }

    /**
     * The run's {@code origin} for deskd when the run has none of its own (a run another desk's message started has
     * {@code {kind: "desk", envelopeId}}): Desk Maia's {@code {kind: "maia", answers: [envelopeId, …]}}, the answers in
     * her thread, oldest first, so her {@code todo_add} may name one as its {@code desk} source. deskd gives only what
     * its own record says it opened for her (API.md §22, "To-do's source kind desk"); naming one never lifts a refusal.
     *
     * @return the origin, or null for none
     */
    default Map<String, Object> origin(RunContext run) {
        return null;
    }

    /** The call ran and deskd answered it ({@code ok}); its result as the model reads it. */
    default void ran(RunContext run, String tool, Map<String, Object> args, boolean ok) {}
}
