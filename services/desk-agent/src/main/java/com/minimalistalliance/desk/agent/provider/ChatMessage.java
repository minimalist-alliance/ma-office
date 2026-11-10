package com.minimalistalliance.desk.agent.provider;

import java.util.List;
import java.util.Objects;

/**
 * One turn of a thread: text, and with tools (ADR 0047) the model's tool calls on an assistant turn, or their results
 * on the user turn that follows. A tool call's turn may have no text; every other turn has some.
 */
public record ChatMessage(Role role, String text, List<ToolCall> toolCalls, List<ToolResult> toolResults,
        List<Attachment> attachments) {

    public ChatMessage {
        Objects.requireNonNull(role, "role");
        Objects.requireNonNull(text, "text");
        toolCalls = toolCalls == null ? List.of() : List.copyOf(toolCalls);
        toolResults = toolResults == null ? List.of() : List.copyOf(toolResults);
        attachments = attachments == null ? List.of() : List.copyOf(attachments);
        if (!attachments.isEmpty() && role != Role.USER) {
            throw new IllegalArgumentException("only the member attaches files");
        }
        if (!toolCalls.isEmpty() && role != Role.ASSISTANT) {
            throw new IllegalArgumentException("only the model calls tools");
        }
        if (!toolResults.isEmpty() && role != Role.USER) {
            throw new IllegalArgumentException("tool results go in a user turn");
        }
    }

    public ChatMessage(Role role, String text, List<ToolCall> toolCalls, List<ToolResult> toolResults) {
        this(role, text, toolCalls, toolResults, List.of());
    }

    public ChatMessage(Role role, String text) {
        this(role, text, List.of(), List.of(), List.of());
    }

    /** The member's turn with files attached for this run only (ADR 0049). */
    public static ChatMessage user(String text, List<Attachment> attachments) {
        return new ChatMessage(Role.USER, text, List.of(), List.of(), attachments);
    }

    /** The model's turn with its tool calls, and whatever text came before them. */
    public static ChatMessage toolCalls(String text, List<ToolCall> calls) {
        return new ChatMessage(Role.ASSISTANT, text, calls, List.of(), List.of());
    }

    /** The results of the turn before's tool calls, in its order. */
    public static ChatMessage toolResults(List<ToolResult> results) {
        return new ChatMessage(Role.USER, "", List.of(), results, List.of());
    }

    public boolean hasTools() {
        return !toolCalls.isEmpty() || !toolResults.isEmpty();
    }

    public static ChatMessage user(String text) {
        return new ChatMessage(Role.USER, text);
    }

    public static ChatMessage assistant(String text) {
        return new ChatMessage(Role.ASSISTANT, text);
    }

    /** No content in logs or exceptions. */
    @Override
    public String toString() {
        return "ChatMessage[" + role + ", " + text.length() + " chars, " + toolCalls.size() + " calls, "
                + toolResults.size() + " results, " + attachments.size() + " files]";
    }
}
