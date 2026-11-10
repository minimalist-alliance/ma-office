package com.minimalistalliance.desk.agent.provider;

import java.util.Objects;

/** What a tool call came to, sent back in the next user turn: the call's id, text, and whether it failed. */
public record ToolResult(String callId, String content, boolean error) {

    public ToolResult {
        Objects.requireNonNull(callId, "callId");
        Objects.requireNonNull(content, "content");
    }

    /** No content in logs or exceptions. */
    @Override
    public String toString() {
        return "ToolResult[" + content.length() + " chars" + (error ? ", error" : "") + "]";
    }
}
