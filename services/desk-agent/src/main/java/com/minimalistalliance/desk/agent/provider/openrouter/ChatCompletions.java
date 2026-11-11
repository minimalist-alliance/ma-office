package com.minimalistalliance.desk.agent.provider.openrouter;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.provider.Attachment;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.Role;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.ToolSpec;
import com.minimalistalliance.desk.agent.provider.http.Messages;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A thread as the Chat Completions API's {@code messages}, which OpenRouter serves: the instructions as a
 * {@code system} message, text as {@code {role, content}} (same-role text turns joined by a blank line), a call's turn as
 * an {@code assistant} message with {@code tool_calls}, and each result as a {@code tool} message naming its call. A
 * member's turn with files has content parts: {@code text}, and {@code image_url} with the picture as a data URL.
 *
 * <p>For a model that takes no tools, nothing about tools goes: a call's turn keeps only its text, and a turn of results
 * says they aren't available. The agent loop never makes tool turns for such a model, as it can't call any, so this only
 * keeps a request well formed.
 */
final class ChatCompletions {

    /** What a turn of tool results says to a model that takes no tools. */
    static final String NO_RESULTS = "(The results of an earlier step's tools aren't available to this model.)";

    private ChatCompletions() {}

    static List<Map<String, Object>> messages(String system, List<ChatMessage> thread, boolean tools) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (!system.isEmpty()) {
            out.add(turn("system", system));
        }
        for (ChatMessage message : thread) {
            String role = message.role() == Role.ASSISTANT ? "assistant" : "user";
            if (!message.toolResults().isEmpty()) {
                if (!tools) {
                    text(out, "user", NO_RESULTS);
                } else {
                    for (ToolResult result : message.toolResults()) {
                        Map<String, Object> m = new LinkedHashMap<>();
                        m.put("role", "tool");
                        m.put("tool_call_id", result.callId());
                        m.put("content", result.content());
                        out.add(m);
                    }
                }
            }
            if (!message.attachments().isEmpty()) {
                out.add(turn(role, parts(message)));
                continue;
            }
            if (tools && !message.toolCalls().isEmpty()) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("role", "assistant");
                m.put("content", message.text().isBlank() ? null : message.text());
                List<Map<String, Object>> calls = new ArrayList<>();
                for (ToolCall call : message.toolCalls()) {
                    Map<String, Object> function = new LinkedHashMap<>();
                    function.put("name", call.name());
                    function.put("arguments", new String(Json.bytes(call.input()), StandardCharsets.UTF_8));
                    Map<String, Object> c = new LinkedHashMap<>();
                    c.put("id", call.id());
                    c.put("type", "function");
                    c.put("function", function);
                    calls.add(c);
                }
                m.put("tool_calls", calls);
                out.add(m);
                continue;
            }
            // A model may stream only whitespace before a call; a plain turn keeps its text as it was.
            if (message.hasTools() ? !message.text().isBlank() : !message.text().isEmpty()) {
                text(out, role, message.text());
            }
        }
        return out;
    }

    /** {@code tools}: {@code [{type: "function", function: {name, description, parameters}}]}. */
    static List<Map<String, Object>> tools(List<ToolSpec> tools) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (ToolSpec tool : tools) {
            Map<String, Object> function = new LinkedHashMap<>();
            function.put("name", tool.name());
            function.put("description", tool.description());
            function.put("parameters", tool.inputSchema());
            Map<String, Object> spec = new LinkedHashMap<>();
            spec.put("type", "function");
            spec.put("function", function);
            out.add(spec);
        }
        return out;
    }

    /** Text after a plain text turn of the same role joins it; anything else starts a turn. */
    private static void text(List<Map<String, Object>> out, String role, String text) {
        if (!out.isEmpty()) {
            Map<String, Object> last = out.getLast();
            if (role.equals(last.get("role")) && last.get("content") instanceof String said
                    && !last.containsKey("tool_calls")) {
                last.put("content", said + "\n\n" + text);
                return;
            }
        }
        out.add(turn(role, text));
    }

    private static List<Object> parts(ChatMessage message) {
        List<Object> parts = new ArrayList<>();
        if (!message.text().isEmpty()) {
            parts.add(part("text", message.text()));
        }
        for (Attachment attachment : message.attachments()) {
            if (attachment.wiped()) {
                continue;
            }
            if (attachment.kind() == Attachment.Kind.IMAGE) {
                byte[] image = attachment.image();
                if (image == null) {
                    continue;
                }
                Map<String, Object> part = new LinkedHashMap<>();
                part.put("type", "image_url");
                part.put("image_url", Map.of("url",
                        "data:" + attachment.mime() + ";base64," + Base64.getEncoder().encodeToString(image)));
                parts.add(part);
            } else {
                parts.add(part("text", Messages.fenced(attachment)));
            }
        }
        return parts;
    }

    private static Map<String, Object> part(String type, String text) {
        Map<String, Object> part = new LinkedHashMap<>();
        part.put("type", type);
        part.put("text", text);
        return part;
    }

    private static Map<String, Object> turn(String role, Object content) {
        Map<String, Object> turn = new LinkedHashMap<>();
        turn.put("role", role);
        turn.put("content", content);
        return turn;
    }
}
