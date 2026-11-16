package com.minimalistalliance.desk.agent.provider.chat;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.json.JsonFormatException;
import com.minimalistalliance.desk.agent.provider.Attachment;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.DeltaSink;
import com.minimalistalliance.desk.agent.provider.ProviderException;
import com.minimalistalliance.desk.agent.provider.Role;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.ToolSpec;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.provider.http.HttpTransport;
import com.minimalistalliance.desk.agent.provider.http.Messages;
import com.minimalistalliance.desk.agent.provider.http.SseReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.function.UnaryOperator;

/**
 * The OpenAI-compatible Chat Completions API, which OpenRouter, Google's Gemini ({@code /v1beta/openai}) and Moonshot AI
 * serve: a thread as its {@code messages}, and a streamed reply read back.
 *
 * <p><b>The thread:</b> the instructions as a {@code system} message, text as {@code {role, content}} (same-role text
 * turns joined by a blank line), a call's turn as an {@code assistant} message with {@code tool_calls}, and each result
 * as a {@code tool} message naming its call. A member's turn with files has content parts: {@code text}, and
 * {@code image_url} with the picture as a data URL. For a model that takes no tools, nothing about tools goes: a call's
 * turn keeps only its text, and a turn of results says they aren't available. The agent loop never makes tool turns for
 * such a model, as it can't call any, so this only keeps a request well formed.
 *
 * <p><b>What a provider needs sent back</b> ({@link Dialect}): Gemini signs its reasoning and puts the signature on a
 * call ({@code tool_calls[].extra_content.google.thought_signature}), and refuses the next step of the turn without it;
 * Moonshot's thinking models want the step's {@code reasoning_content} back on the call's turn. Both ride on the call,
 * in {@link ToolCall#reasoning} as one {@value #EXTRA} item tagged with the provider, so they go only to the provider
 * that sent them, and a run's checkpoint keeps them. The Responses API's adapter skips these items.
 *
 * <p><b>The stream:</b> {@code data:} chunks to {@code [DONE]}, each with a {@code delta} of text, tool-call parts by
 * {@code index}, a {@code finish_reason}, and at the end {@code usage}: top-level, or on the choice as Moonshot's older
 * streams had it.
 */
public final class ChatCompletions {

    /** What a turn of tool results says to a model that takes no tools. */
    public static final String NO_RESULTS = "(The results of an earlier step's tools aren't available to this model.)";

    /** The type of the item a call carries what its provider needs sent back in. */
    public static final String EXTRA = "chat_extra";

    /** A call's {@code extra_content} past this many bytes isn't kept: no signature is that big. */
    static final int MAX_EXTRA_BYTES = 64 << 10;
    /** A step's reasoning past this many characters isn't kept, rather than sent back cut. */
    static final int MAX_REASONING_CHARS = 512 << 10;
    static final int MAX_ERROR_BYTES = 64 << 10;
    /** A call's id and name past this many characters are cut: no real one is that long. */
    static final int MAX_CALL_CHARS = 128;
    /** A step's text past this many characters is a malformed reply, as no output cap allows it. */
    static final int MAX_TEXT_CHARS = 8 << 20;
    private static final int BYTES_PER_TOKEN = 3;

    /**
     * How one provider's Chat Completions differs from the plain shape.
     *
     * @param provider the id the kept items are tagged with
     * @param keepExtraContent keep each call's {@code extra_content} (Gemini's thought signature) and send it back on it
     * @param keepReasoning keep the step's {@code delta.reasoning_content} (Moonshot's thinking) and send it back on the
     *     call's turn
     * @param missingSignature Gemini's documented stand-in for a call that has no signature (one it didn't make, or one
     *     that lost it), sent on the first call of a step that has none; null sends nothing
     * @param emptyContent a call's turn with no text says {@code ""} rather than {@code null}
     * @param notStrict each tool says {@code strict: false}, as Moonshot checks a tool's schema strictly by default
     */
    public record Dialect(String provider, boolean keepExtraContent, boolean keepReasoning, String missingSignature,
            boolean emptyContent, boolean notStrict) {

        /** OpenRouter's: nothing kept, nothing added. */
        public static final Dialect PLAIN = new Dialect("", false, false, null, false, false);
    }

    /** What a stream gave: the text, the calls, the model that answered, why it stopped, its usage and its size. */
    public record Streamed(String text, List<ToolCall> calls, String model, String finish, Map<String, Object> usage,
            long outputBytes) {}

    /** An {@code error} object in a stream that had started, as the provider's kind. */
    @FunctionalInterface
    public interface StreamErrors {
        ProviderException of(Map<String, Object> error);
    }

    private ChatCompletions() {}

    // ---------------------------------------------------------------- the thread

    public static List<Map<String, Object>> messages(String system, List<ChatMessage> thread, boolean tools) {
        return messages(system, thread, tools, Dialect.PLAIN);
    }

    public static List<Map<String, Object>> messages(String system, List<ChatMessage> thread, boolean tools,
            Dialect dialect) {
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
                out.add(callTurn(message, dialect));
                continue;
            }
            // A model may stream only whitespace before a call; a plain turn keeps its text as it was.
            if (message.hasTools() ? !message.text().isBlank() : !message.text().isEmpty()) {
                text(out, role, message.text());
            }
        }
        return out;
    }

    private static Map<String, Object> callTurn(ChatMessage message, Dialect dialect) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("role", "assistant");
        m.put("content", message.text().isBlank() ? (dialect.emptyContent() ? "" : null) : message.text());
        List<Map<String, Object>> calls = new ArrayList<>();
        boolean signed = false;
        for (ToolCall call : message.toolCalls()) {
            Map<String, Object> function = new LinkedHashMap<>();
            function.put("name", call.name());
            function.put("arguments", new String(Json.bytes(call.input()), StandardCharsets.UTF_8));
            Map<String, Object> c = new LinkedHashMap<>();
            c.put("id", call.id());
            c.put("type", "function");
            c.put("function", function);
            Map<String, Object> extra = extra(call, dialect);
            if (extra != null && dialect.keepExtraContent() && extra.get("extra_content") instanceof Map<?, ?> content) {
                c.put("extra_content", content);
                signed = true;
            }
            if (extra != null && dialect.keepReasoning() && calls.isEmpty()
                    && extra.get("reasoning_content") instanceof String reasoning) {
                m.put("reasoning_content", reasoning);
            }
            calls.add(c);
        }
        if (!signed && dialect.missingSignature() != null && !calls.isEmpty()) {
            calls.getFirst().put("extra_content",
                    Map.of("google", Map.of("thought_signature", dialect.missingSignature())));
        }
        m.put("tool_calls", calls);
        return m;
    }

    /** The item this provider's stream left on the call, or null. */
    private static Map<String, Object> extra(ToolCall call, Dialect dialect) {
        if (dialect.provider().isEmpty()) {
            return null;
        }
        for (Map<String, Object> item : call.reasoning()) {
            if (EXTRA.equals(item.get("type")) && dialect.provider().equals(item.get("provider"))) {
                return item;
            }
        }
        return null;
    }

    /** {@code tools}: {@code [{type: "function", function: {name, description, parameters}}]}. */
    public static List<Map<String, Object>> tools(List<ToolSpec> tools) {
        return tools(tools, Dialect.PLAIN);
    }

    public static List<Map<String, Object>> tools(List<ToolSpec> tools, Dialect dialect) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (ToolSpec tool : tools) {
            Map<String, Object> function = new LinkedHashMap<>();
            function.put("name", tool.name());
            function.put("description", tool.description());
            function.put("parameters", tool.inputSchema());
            if (dialect.notStrict()) {
                function.put("strict", false);
            }
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

    // ---------------------------------------------------------------- the stream

    /** A call's turn being streamed: its id and name from the first delta, its arguments from all of them. */
    private static final class Parts {
        String id;
        String name;
        Map<String, Object> extra;
        final StringBuilder arguments = new StringBuilder();
    }

    /**
     * Reads a stream to its end, sending text to {@code sink} as it comes.
     *
     * @param tools whether tool calls are read; without, any are ignored
     * @param named the model a chunk names as the one to show, or null to keep the one asked for
     * @throws ProviderException {@code errors}' kind for an error chunk; {@code UNAVAILABLE} for a stream cut before the
     *     model said it was done, a finish of {@code error} or a call with no name; a read's own kind
     */
    public static Streamed read(HttpTransport.Stream stream, ChatRequest request, DeltaSink sink, boolean tools,
            Dialect dialect, StreamErrors errors, UnaryOperator<String> named) throws ProviderException {
        StringBuilder text = new StringBuilder();
        StringBuilder reasoning = dialect.keepReasoning() ? new StringBuilder() : null;
        TreeMap<Integer, Parts> calls = new TreeMap<>();
        String model = request.model();
        String finish = null;
        Map<String, Object> usage = null;
        boolean done = false;
        SseReader events = new SseReader(stream);
        try {
            SseReader.Event event;
            while ((event = events.next()) != null) {
                if (event.data().equals("[DONE]")) {
                    done = true;
                    break;
                }
                Map<String, Object> chunk = parse(event.data().getBytes(StandardCharsets.UTF_8), true);
                Map<String, Object> error = Json.object(chunk, "error");
                if (error != null) {
                    throw errors.of(error);
                }
                String shown = named.apply(Json.string(chunk, "model"));
                if (shown != null) {
                    model = shown;
                }
                Map<String, Object> reported = Json.object(chunk, "usage");
                if (reported != null) {
                    usage = reported;
                }
                Map<String, Object> choice = first(chunk.get("choices"));
                if (choice == null) {
                    continue;
                }
                if (reported == null && Json.object(choice, "usage") != null) {
                    usage = Json.object(choice, "usage");
                }
                Map<String, Object> delta = Json.object(choice, "delta");
                if (delta != null) {
                    String piece = Json.string(delta, "content");
                    if (piece != null && !piece.isEmpty()) {
                        if (text.length() + piece.length() > MAX_TEXT_CHARS) {
                            throw new ProviderException(ProviderException.Kind.UNAVAILABLE, true);
                        }
                        text.append(piece);
                        sink.delta(piece);
                    }
                    String thought = reasoning == null ? null : Json.string(delta, "reasoning_content");
                    if (thought != null && reasoning.length() <= MAX_REASONING_CHARS) {
                        reasoning.append(thought);
                    }
                    if (tools && delta.get("tool_calls") instanceof List<?> parts) {
                        take(parts, calls, dialect.keepExtraContent());
                    }
                }
                String reason = Json.string(choice, "finish_reason");
                if ("error".equals(reason)) {
                    throw new ProviderException(ProviderException.Kind.UNAVAILABLE, true);
                }
                if (reason != null) {
                    finish = reason;
                }
            }
        } catch (IOException e) {
            throw HttpTransport.readError(stream);
        }
        if (!done && finish == null) {
            // Cut before the model said it was done.
            throw new ProviderException(ProviderException.Kind.UNAVAILABLE, true);
        }
        String thought = reasoning == null || reasoning.isEmpty() || reasoning.length() > MAX_REASONING_CHARS
                ? null : reasoning.toString();
        long bytes = text.toString().getBytes(StandardCharsets.UTF_8).length;
        for (Parts call : calls.values()) {
            bytes += call.arguments.toString().getBytes(StandardCharsets.UTF_8).length
                    + (call.name == null ? 0 : call.name.length());
        }
        return new Streamed(text.toString(), calls(calls, dialect, thought), model, finish, usage, bytes);
    }

    /**
     * Tool-call deltas: by {@code index}; without one, a new call when it comes with a new id, or with a name while the
     * last call has one already (a provider that sends each call whole, and no ids), else more of the last call.
     */
    private static void take(List<?> parts, TreeMap<Integer, Parts> calls, boolean keepExtra) throws ProviderException {
        for (Object item : parts) {
            if (!(item instanceof Map<?, ?> raw)) {
                continue;
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> part = (Map<String, Object>) raw;
            String id = cut(Json.string(part, "id"));
            Map<String, Object> function = Json.object(part, "function");
            String name = function == null ? null : cut(Json.string(function, "name"));
            int index;
            if (part.get("index") instanceof Number n && n.intValue() >= 0
                    && n.intValue() <= Messages.MAX_TOOL_CALLS) {
                index = n.intValue();
            } else if (calls.isEmpty()) {
                index = 0;
            } else {
                Parts last = calls.lastEntry().getValue();
                boolean newId = id != null && !id.isEmpty() && !id.equals(last.id);
                boolean newName = (id == null || id.isEmpty()) && name != null && !name.isEmpty() && last.name != null;
                index = newId || newName ? calls.lastKey() + 1 : calls.lastKey();
            }
            Parts call = calls.get(index);
            if (call == null) {
                Messages.checkCount(calls.size() + 1);
                call = new Parts();
                calls.put(index, call);
            }
            if (call.id == null && id != null && !id.isEmpty()) {
                call.id = id;
            }
            if (keepExtra && call.extra == null && part.get("extra_content") instanceof Map<?, ?> extra
                    && !extra.isEmpty() && Json.bytes(extra).length <= MAX_EXTRA_BYTES) {
                @SuppressWarnings("unchecked")
                Map<String, Object> kept = (Map<String, Object>) extra;
                call.extra = kept;
            }
            if (function != null) {
                if (call.name == null && name != null && !name.isEmpty()) {
                    call.name = name;
                }
                String arguments = Json.string(function, "arguments");
                if (arguments != null) {
                    call.arguments.append(arguments);
                    Messages.checkArguments(call.arguments);
                }
            }
        }
    }

    private static List<ToolCall> calls(TreeMap<Integer, Parts> calls, Dialect dialect, String reasoning)
            throws ProviderException {
        List<ToolCall> out = new ArrayList<>();
        Set<String> ids = new HashSet<>();
        for (Map.Entry<Integer, Parts> entry : calls.entrySet()) {
            Parts call = entry.getValue();
            if (call.name == null) {
                throw new ProviderException(ProviderException.Kind.UNAVAILABLE, true);
            }
            // Its result names it, so it needs one, and one no other call of the turn has.
            String id = call.id != null ? call.id : "call_" + entry.getKey();
            while (!ids.add(id)) {
                id = id + "_" + entry.getKey();
            }
            ToolCall made = Messages.toolCall(id, call.name, call.arguments.toString());
            Map<String, Object> item = new LinkedHashMap<>();
            if (call.extra != null) {
                item.put("extra_content", call.extra);
            }
            if (reasoning != null && out.isEmpty()) {
                item.put("reasoning_content", reasoning);
            }
            if (!item.isEmpty()) {
                item.put("type", EXTRA);
                item.put("provider", dialect.provider());
                made = made.withReasoning(List.of(item));
            }
            out.add(made);
        }
        return out;
    }

    /**
     * Why it stopped, in the words the loop reads: {@code max_tokens} for {@code length} or an empty reply that used its
     * whole cap, {@code refusal} for the content filter, {@code tool_calls}, else {@code completed}.
     */
    public static String stopReason(String finish, boolean empty, long output, int cap) {
        return switch (finish == null ? "stop" : finish) {
            case "length" -> "max_tokens";
            case "content_filter" -> "refusal";
            case "tool_calls" -> "tool_calls";
            default -> empty && output >= cap ? "max_tokens" : "completed";
        };
    }

    /**
     * {@code usage} as billed: {@code prompt_tokens} includes cached and cache-write tokens, so both are taken out of
     * the input count; the cached count is {@code prompt_tokens_details.cached_tokens}, or Moonshot's top-level
     * {@code cached_tokens}, whichever is more. Output is the most of {@code completion_tokens} and {@code total_tokens}
     * less the prompt, as Gemini counts its thinking in the total and not in the completion.
     */
    public static Usage usage(Map<String, Object> usage) {
        long prompt = Messages.number(usage, "prompt_tokens");
        Map<String, Object> details = Json.object(usage, "prompt_tokens_details");
        long cached = Math.min(prompt,
                Math.max(Messages.number(details, "cached_tokens"), Messages.number(usage, "cached_tokens")));
        long written = Math.min(prompt - cached, Messages.number(details, "cache_write_tokens"));
        long completion = Messages.number(usage, "completion_tokens");
        long reasoning = Messages.number(Json.object(usage, "completion_tokens_details"), "reasoning_tokens");
        long total = Messages.number(usage, "total_tokens");
        long output = Math.max(completion, total > prompt ? total - prompt : 0);
        return new Usage(Math.max(0, prompt - cached - written), Math.max(0, cached), Math.max(0, written),
                Math.max(0, output), Math.max(0, Math.min(output, reasoning)));
    }

    /** No usage came: the input as the gateway estimates it, and the output's bytes over 3. */
    public static Usage estimate(ChatRequest request, long outputBytes) {
        return new Usage(Math.ceilDiv(request.inputBytes(), BYTES_PER_TOKEN) + request.extraInputTokens(), 0, 0,
                Math.ceilDiv(outputBytes, BYTES_PER_TOKEN), 0);
    }

    // ---------------------------------------------------------------- errors

    /**
     * An error object in a stream that had started, so the call may have been billed: by its numeric {@code code} or
     * HTTP status, or the words of its code, type or status ({@code rate_limit}, {@code RESOURCE_EXHAUSTED}, ...). Read
     * for that and kept nowhere.
     */
    public static ProviderException streamError(Map<String, Object> error) {
        Object code = error.get("code");
        int status = code instanceof Number n ? n.intValue() : 0;
        String words = lower(code instanceof String s ? s : null) + " " + lower(Json.string(error, "type")) + " "
                + lower(Json.string(error, "status"));
        ProviderException.Kind kind;
        if (status == 429 || words.contains("rate_limit") || words.contains("quota")
                || words.contains("resource_exhausted")) {
            kind = ProviderException.Kind.RATE_LIMITED;
        } else if (status == 402 || words.contains("payment") || words.contains("balance")) {
            kind = ProviderException.Kind.RATE_LIMITED;
        } else if (status == 401 || status == 403 || words.contains("auth") || words.contains("permission")
                || words.contains("api_key")) {
            kind = ProviderException.Kind.AUTH;
        } else if (status == 400 || status == 404 || status == 413 || words.contains("invalid")
                || words.contains("not_found")) {
            kind = ProviderException.Kind.BAD_REQUEST;
        } else {
            kind = ProviderException.Kind.UNAVAILABLE;
        }
        return new ProviderException(kind, true);
    }

    /**
     * {@code {"error": {...}}} of a refusal, or the first of Gemini's {@code [{"error": {...}}]}, or null. At most
     * {@link #MAX_ERROR_BYTES} are read, to classify it, and kept nowhere.
     */
    public static Map<String, Object> errorBody(HttpTransport.Stream stream) {
        try {
            byte[] body = stream.readNBytes(MAX_ERROR_BYTES);
            stream.drain(8192);
            int start = 0;
            while (start < body.length && Character.isWhitespace(body[start])) {
                start++;
            }
            if (start < body.length && body[start] == '[') {
                // Wrapped, as the parser takes objects only.
                byte[] wrapped = new byte[body.length - start + 6];
                System.arraycopy("{\"a\":".getBytes(StandardCharsets.US_ASCII), 0, wrapped, 0, 5);
                System.arraycopy(body, start, wrapped, 5, body.length - start);
                wrapped[wrapped.length - 1] = '}';
                Object list = Json.parseObject(wrapped).get("a");
                Map<String, Object> first = first(list);
                return first == null ? null : Json.object(first, "error");
            }
            return Json.object(Json.parseObject(body), "error");
        } catch (IOException | JsonFormatException e) {
            return null;
        }
    }

    /** Whether an error's own words say it's about the API key: Gemini refuses a bad key with a 400. */
    public static boolean aboutKey(Map<String, Object> error) {
        if (error == null) {
            return false;
        }
        String words = lower(Json.string(error, "message")) + " " + lower(Json.string(error, "status")) + " "
                + lower(Json.string(error, "type"));
        if (error.get("details") instanceof List<?> details) {
            for (Object detail : details) {
                if (detail instanceof Map<?, ?> d && d.get("reason") instanceof String reason) {
                    words += " " + lower(reason);
                }
            }
        }
        return words.contains("api key") || words.contains("api_key");
    }

    private static String cut(String text) {
        return text == null || text.length() <= MAX_CALL_CHARS ? text : text.substring(0, MAX_CALL_CHARS);
    }

    static String lower(String text) {
        return text == null ? "" : text.toLowerCase(Locale.ROOT);
    }

    // ---------------------------------------------------------------- helpers

    @SuppressWarnings("unchecked")
    static Map<String, Object> first(Object choices) {
        return choices instanceof List<?> list && !list.isEmpty() && list.getFirst() instanceof Map<?, ?> map
                ? (Map<String, Object>) map : null;
    }

    public static Map<String, Object> parse(byte[] json, boolean mayHaveBilled) throws ProviderException {
        try {
            return Json.parseObject(json);
        } catch (JsonFormatException e) {
            throw new ProviderException(ProviderException.Kind.UNAVAILABLE, mayHaveBilled);
        }
    }
}
