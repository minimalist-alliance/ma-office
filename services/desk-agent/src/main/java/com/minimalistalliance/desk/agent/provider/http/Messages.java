package com.minimalistalliance.desk.agent.provider.http;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.json.JsonFormatException;
import com.minimalistalliance.desk.agent.provider.Attachment;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.ProviderException;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.ToolSpec;
import com.minimalistalliance.desk.agent.provider.Role;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.nio.charset.StandardCharsets;

/** Helpers the adapters use to turn a thread into a request body. */
public final class Messages {

    /** Tool calls one model turn may make, and the bytes of arguments one call may stream. Past either, the reply is refused. */
    public static final int MAX_TOOL_CALLS = 64;
    public static final int MAX_ARGUMENT_BYTES = 256 * 1024;

    private Messages() {}

    /** The model's streamed arguments as a call: empty is {@code {}}, anything but a JSON object is malformed. */
    public static ToolCall toolCall(String id, String name, String arguments) {
        if (arguments == null || arguments.isBlank()) {
            return new ToolCall(id, name, Map.of(), false);
        }
        try {
            return new ToolCall(id, name, Json.parseObject(arguments.getBytes(StandardCharsets.UTF_8)), false);
        } catch (JsonFormatException e) {
            return new ToolCall(id, name, Map.of(), true);
        }
    }

    /** Refuses a stream that makes too many calls: the provider's reply is malformed. */
    public static void checkCount(int calls) throws ProviderException {
        if (calls > MAX_TOOL_CALLS) {
            throw new ProviderException(ProviderException.Kind.UNAVAILABLE, true);
        }
    }

    /** Refuses a call whose arguments are too big. */
    public static void checkArguments(CharSequence arguments) throws ProviderException {
        // UTF-8 is at most 3 bytes a char, so a short string is surely small enough; measure only the long ones.
        if (arguments.length() > MAX_ARGUMENT_BYTES
                || (arguments.length() * 3L > MAX_ARGUMENT_BYTES
                        && arguments.toString().getBytes(StandardCharsets.UTF_8).length > MAX_ARGUMENT_BYTES)) {
            throw new ProviderException(ProviderException.Kind.UNAVAILABLE, true);
        }
    }

    /** Anthropic's {@code tools}: {@code [{name, description, input_schema}]}. */
    public static List<Map<String, Object>> anthropicTools(List<ToolSpec> tools) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (ToolSpec tool : tools) {
            Map<String, Object> spec = new LinkedHashMap<>();
            spec.put("name", tool.name());
            spec.put("description", tool.description());
            spec.put("input_schema", tool.inputSchema());
            out.add(spec);
        }
        return out;
    }

    /** The Responses API's {@code tools}: {@code [{type: "function", name, description, parameters, strict}]}. */
    public static List<Map<String, Object>> responsesTools(List<ToolSpec> tools) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (ToolSpec tool : tools) {
            Map<String, Object> spec = new LinkedHashMap<>();
            spec.put("type", "function");
            spec.put("name", tool.name());
            spec.put("description", tool.description());
            spec.put("parameters", tool.inputSchema());
            spec.put("strict", false);
            out.add(spec);
        }
        return out;
    }

    /**
     * The thread as Anthropic's messages. Same-role turns merge their content blocks; a call is a {@code tool_use}
     * block, a result a {@code tool_result} block (before any text of its turn). A turn that is one text block stays
     * a plain string.
     */
    public static List<Map<String, Object>> anthropic(List<ChatMessage> thread) {
        List<Role> roles = new ArrayList<>();
        List<List<Object>> turns = new ArrayList<>();
        for (ChatMessage message : thread) {
            if (roles.isEmpty() || roles.getLast() != message.role()) {
                roles.add(message.role());
                turns.add(new ArrayList<>());
            }
            List<Object> blocks = turns.getLast();
            for (ToolResult result : message.toolResults()) {
                Map<String, Object> block = new LinkedHashMap<>();
                block.put("type", "tool_result");
                block.put("tool_use_id", result.callId());
                block.put("content", result.content());
                if (result.error()) {
                    block.put("is_error", true);
                }
                blocks.add(block);
            }
            // Anthropic refuses a text block of only whitespace, which a model may stream before a tool call.
            String said = message.hasTools() && message.role() == Role.ASSISTANT ? message.text().stripTrailing()
                    : message.text();
            if (!said.isEmpty() && !(message.hasTools() && said.isBlank())) {
                if (!blocks.isEmpty() && blocks.getLast() instanceof Map<?, ?> last
                        && "text".equals(last.get("type"))) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> block = (Map<String, Object>) last;
                    block.put("text", block.get("text") + "\n\n" + said);
                } else {
                    Map<String, Object> block = new LinkedHashMap<>();
                    block.put("type", "text");
                    block.put("text", said);
                    blocks.add(block);
                }
            }
            for (Attachment attachment : message.attachments()) {
                if (attachment.wiped()) {
                    continue;
                }
                Map<String, Object> block = new LinkedHashMap<>();
                if (attachment.kind() == Attachment.Kind.IMAGE) {
                    byte[] image = attachment.image();
                    if (image == null) {
                        continue;
                    }
                    Map<String, Object> source = new LinkedHashMap<>();
                    source.put("type", "base64");
                    source.put("media_type", attachment.mime());
                    source.put("data", java.util.Base64.getEncoder().encodeToString(image));
                    block.put("type", "image");
                    block.put("source", source);
                } else {
                    block.put("type", "text");
                    block.put("text", fenced(attachment));
                }
                blocks.add(block);
            }
            for (ToolCall call : message.toolCalls()) {
                Map<String, Object> block = new LinkedHashMap<>();
                block.put("type", "tool_use");
                block.put("id", call.id());
                block.put("name", call.name());
                block.put("input", call.input());
                blocks.add(block);
            }
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (int i = 0; i < turns.size(); i++) {
            List<Object> blocks = turns.get(i);
            Object content = blocks.size() == 1 && blocks.getFirst() instanceof Map<?, ?> only
                    && "text".equals(only.get("type")) ? only.get("text") : blocks;
            out.add(turn(roles.get(i), content));
        }
        return out;
    }

    /**
     * The thread as the Responses API's {@code input} items: text as {@code {role, content}} (same-role text turns
     * joined, as {@link #alternating} does), each call as a {@code function_call} and each result as a
     * {@code function_call_output}. No item ids, as {@code store: false} means the provider kept nothing. A call's
     * reasoning items go in just before it (the first call's before the step's text), as they came.
     */
    public static List<Map<String, Object>> responses(List<ChatMessage> thread) {
        List<Map<String, Object>> out = new ArrayList<>();
        Role last = null;
        StringBuilder text = null;
        for (ChatMessage message : thread) {
            boolean textOnly = !message.hasTools();
            if (!message.attachments().isEmpty()) {
                if (last != null) {
                    out.add(turn(last, text.toString()));
                    last = null;
                    text = null;
                }
                out.add(turn(message.role(), responsesParts(message)));
                continue;
            }
            if (textOnly && message.role() == last) {
                text.append("\n\n").append(message.text());
                continue;
            }
            if (last != null) {
                out.add(turn(last, text.toString()));
                last = null;
                text = null;
            }
            if (textOnly) {
                last = message.role();
                text = new StringBuilder(message.text());
                continue;
            }
            for (ToolResult result : message.toolResults()) {
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("type", "function_call_output");
                item.put("call_id", result.callId());
                item.put("output", result.content());
                out.add(item);
            }
            List<ToolCall> calls = message.toolCalls();
            // The first call's reasoning came first, ahead of any text the step said.
            if (!calls.isEmpty()) {
                out.addAll(calls.getFirst().reasoning());
            }
            if (!message.text().isBlank()) {
                out.add(turn(message.role(), message.text()));
            }
            for (int i = 0; i < calls.size(); i++) {
                ToolCall call = calls.get(i);
                if (i > 0) {
                    out.addAll(call.reasoning());
                }
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("type", "function_call");
                item.put("call_id", call.id());
                item.put("name", call.name());
                item.put("arguments", new String(Json.bytes(call.input()), StandardCharsets.UTF_8));
                out.add(item);
            }
        }
        if (last != null) {
            out.add(turn(last, text.toString()));
        }
        return out;
    }

    /**
     * A member's turn with files for the Responses API: {@code input_text} parts and {@code input_image} parts with the
     * picture as a data URL. A file read to text is its own part, inside its fence.
     */
    static List<Object> responsesParts(ChatMessage message) {
        List<Object> parts = new ArrayList<>();
        if (!message.text().isEmpty()) {
            parts.add(Map.of("type", "input_text", "text", message.text()));
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
                part.put("type", "input_image");
                part.put("image_url", "data:" + attachment.mime() + ";base64,"
                        + java.util.Base64.getEncoder().encodeToString(image));
                parts.add(part);
            } else {
                parts.add(Map.of("type", "input_text", "text", fenced(attachment)));
            }
        }
        return parts;
    }

    /**
     * A file read to text, between lines the file can't forge: the boundary code is random per file and appears only
     * here. The notice in the system part tells the model what the lines mean.
     */
    public static String fenced(Attachment attachment) {
        String text = attachment.text();
        StringBuilder out = new StringBuilder();
        out.append("<<<file ").append(attachment.fence()).append(" name=\"").append(attachment.name())
                .append("\" type=\"").append(attachment.type()).append("\">>>\n");
        out.append(text == null ? "" : text);
        out.append("\n<<<end file ").append(attachment.fence()).append(">>>");
        return out.toString();
    }

    /**
     * The thread as {@code [{role, content}]}, with turns of the same role joined by a blank line. A reply that
     * failed leaves two user turns in a row, which some APIs refuse.
     */
    public static List<Map<String, Object>> alternating(List<ChatMessage> thread) {
        List<Map<String, Object>> out = new ArrayList<>();
        Role last = null;
        StringBuilder text = null;
        for (ChatMessage message : thread) {
            if (message.role() == last) {
                text.append("\n\n").append(message.text());
                continue;
            }
            if (last != null) {
                out.add(turn(last, text.toString()));
            }
            last = message.role();
            text = new StringBuilder(message.text());
        }
        if (last != null) {
            out.add(turn(last, text.toString()));
        }
        return out;
    }

    private static Map<String, Object> turn(Role role, Object text) {
        Map<String, Object> turn = new LinkedHashMap<>();
        turn.put("role", role.name().toLowerCase(Locale.ROOT));
        turn.put("content", text);
        return turn;
    }

    /** A JSON number as a long, or 0 when absent or not a number. */
    public static long number(Map<String, Object> object, String key) {
        return object != null && object.get(key) instanceof Number n ? n.longValue() : 0;
    }
}
