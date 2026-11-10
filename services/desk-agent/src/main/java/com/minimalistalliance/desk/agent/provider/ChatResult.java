package com.minimalistalliance.desk.agent.provider;

import java.util.List;
import java.util.Objects;

/**
 * A finished call.
 *
 * @param model the model the provider says answered, which can differ from the one asked for (a dated version)
 * @param stopReason the provider's word for why it stopped, such as {@code end_turn} or {@code max_tokens}
 */
public record ChatResult(String text, Usage usage, String model, String stopReason, List<ToolCall> toolCalls) {

    public ChatResult {
        Objects.requireNonNull(text, "text");
        Objects.requireNonNull(usage, "usage");
        Objects.requireNonNull(model, "model");
        toolCalls = toolCalls == null ? List.of() : List.copyOf(toolCalls);
    }

    /** A call that ended with no tool calls. */
    public ChatResult(String text, Usage usage, String model, String stopReason) {
        this(text, usage, model, stopReason, List.of());
    }

    /** Whether the step stopped on the output cap (or the context's end), so any tool call in it may be cut short. */
    public boolean cutOff() {
        return switch (stopReason == null ? "" : stopReason) {
            case "max_tokens", "max_output_tokens", "incomplete", "model_context_window_exceeded" -> true;
            default -> false;
        };
    }

    /** Whether the model declined: Anthropic's {@code refusal}, or OpenAI's refusal or content filter. */
    public boolean refused() {
        return "refusal".equals(stopReason);
    }

    /** No content in logs or exceptions. */
    @Override
    public String toString() {
        return "ChatResult[" + model + ", " + text.length() + " chars, " + toolCalls.size() + " tool calls, " + usage
                + ", " + stopReason + "]";
    }
}
