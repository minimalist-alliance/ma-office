package com.minimalistalliance.desk.agent.provider;

import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * A tool the model may call (ADR 0047): its name, what it does, and its input as a JSON Schema object. Every adapter
 * maps it to its provider's own shape: Anthropic's {@code tools[{name, description, input_schema}]}, the Responses
 * API's {@code tools[{type: "function", name, description, parameters}]}.
 */
public record ToolSpec(String name, String description, Map<String, Object> inputSchema) {

    /** What every provider accepts as a tool's name. */
    private static final Pattern NAME = Pattern.compile("[A-Za-z0-9_-]{1,64}");

    public ToolSpec {
        Objects.requireNonNull(name, "name");
        Objects.requireNonNull(description, "description");
        Objects.requireNonNull(inputSchema, "inputSchema");
        if (!NAME.matcher(name).matches()) {
            throw new IllegalArgumentException("bad tool name");
        }
        inputSchema = Map.copyOf(inputSchema);
    }
}
