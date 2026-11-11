package com.minimalistalliance.desk.agent.tool;

import com.minimalistalliance.desk.agent.provider.ToolCall;
import java.util.Set;

/**
 * Classifies each call of a step before anything runs (draft ADR, section 1): its class, which can rise per call and
 * never fall below the declaration's, its context, target, payload and {@code before}. The tools builder owns the real
 * one, over the registry; {@link #DEFAULT} stands in until it lands.
 */
public interface ToolPolicy {

    Classified classify(ToolCall call, RunContext run);

    /** The memory runner's save: {@code own}, so a memory under U asks even under the stand-in. */
    String MEMORY_SAVE = "memory_save";

    /**
     * The stand-in: every call is the agent's own ({@code own}, in-process), in the agent's context, with its input as
     * the payload. That is what every tool built before the registry is, so nothing asks, except the memory runner's
     * {@code memory_save} ({@code memory:self}) in a run that has read untrusted content.
     */
    ToolPolicy DEFAULT = (call, run) -> new Classified(call,
            new ToolDecl(call.name(), MEMORY_SAVE.equals(call.name()) ? "Remember this" : call.name(), null,
                    MEMORY_SAVE.equals(call.name()) ? "memory:self" : "workspace:self", Risk.OWN, Set.of(),
                    ToolDecl.Host.DESK_AGENT),
            Risk.OWN, "agent", MEMORY_SAVE.equals(call.name()) ? java.util.Map.of("kind", "memory") : null,
            call.input(), null);

}
