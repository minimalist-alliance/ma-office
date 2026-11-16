package com.minimalistalliance.desk.agent.maia;

import java.util.Map;

/**
 * The small model each provider has for Maia Mode's small jobs (her note-taker, the to-do reader: the concept's
 * "Haiku-class, thinking off"), on the agent's same key. A provider with none listed here uses the agent's own model.
 * Desk Maia's own service ({@code ma}) takes a task, never a model: her small job is the task {@code notes}, and the
 * Platform picks its model.
 */
public final class SmallModels {

    private static final Map<String, String> SMALL = Map.of(
            "anthropic", "claude-haiku-5-5",
            "openai", "gpt-5.4-mini",
            "ma", "notes",
            // Helpers on the member's MA credits: the task `small`, whose model the Platform picks.
            "ma-credits", "small");

    private SmallModels() {}

    /** The small model for this provider, or {@code bound} (the agent's own) when there's none. */
    public static String of(String provider, String bound) {
        return SMALL.getOrDefault(provider, bound);
    }
}
