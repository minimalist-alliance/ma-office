package com.minimalistalliance.desk.agent.provider;

import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * One tool call the model made: the provider's own id for it (Anthropic's {@code tool_use.id}, the Responses API's
 * {@code call_id}), which its result must name, the tool's name and its input, parsed. An input that wasn't a JSON
 * object comes as an empty map with {@code malformed} set, so the loop can answer it with an error result.
 * {@code reasoning} is what the Responses API's reasoning items before this call said, encrypted, to be sent back
 * ahead of it on the next step; Anthropic's adapter ignores it.
 */
public record ToolCall(String id, String name, Map<String, Object> input, boolean malformed,
        List<Map<String, Object>> reasoning) {

    public ToolCall {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(name, "name");
        reasoning = reasoning == null ? List.of() : List.copyOf(reasoning);
        input = input == null ? Map.of() : java.util.Collections.unmodifiableMap(new java.util.LinkedHashMap<>(input));
    }

    public ToolCall(String id, String name, Map<String, Object> input, boolean malformed) {
        this(id, name, input, malformed, List.of());
    }

    public ToolCall(String id, String name, Map<String, Object> input) {
        this(id, name, input, false, List.of());
    }

    /** This call, behind the reasoning that led to it. */
    public ToolCall withReasoning(List<Map<String, Object>> items) {
        return new ToolCall(id, name, input, malformed, items);
    }

    /** No content in logs or exceptions. */
    @Override
    public String toString() {
        return "ToolCall[" + name + ", " + input.size() + " fields" + (malformed ? ", malformed" : "") + "]";
    }
}
