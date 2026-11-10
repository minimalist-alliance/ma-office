package com.minimalistalliance.desk.agent.provider.openai;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.json.JsonFormatException;
import com.minimalistalliance.desk.agent.key.KeyLease;
import com.minimalistalliance.desk.agent.provider.ChatProvider;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.ChatResult;
import com.minimalistalliance.desk.agent.provider.DeltaSink;
import com.minimalistalliance.desk.agent.provider.ModelInfo;
import com.minimalistalliance.desk.agent.provider.ProviderException;
import com.minimalistalliance.desk.agent.provider.ProviderId;
import com.minimalistalliance.desk.agent.provider.ProviderInfo;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.provider.http.HttpTransport;
import com.minimalistalliance.desk.agent.provider.http.Messages;
import com.minimalistalliance.desk.agent.provider.http.SseReader;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.time.Duration;
import java.util.regex.Pattern;

/**
 * OpenAI's Responses API, streamed: {@code POST /v1/responses} with {@code stream: true} and {@code store: false}, so
 * the provider keeps no copy of the conversation for later. Design 9.3 names it for OpenAI, and xAI serves the same
 * API, so one class covers both, with xAI's base URL and key prefix.
 *
 * <p>Reasoning follows Maia's adapter, which runs live on both: {@code include: ["reasoning.encrypted_content"]} brings
 * each reasoning item back encrypted, and the next step sends it again ahead of the call it led to, so a multi-step
 * run doesn't reason from scratch each time. The effort is set per model ({@link #effort}).
 *
 * <p>Usage: {@code input_tokens} includes cached input, so the cached count is taken out of it. Output is the most
 * of {@code output_tokens}, {@code total_tokens} less the input, and visible plus reasoning: xAI may count its
 * reasoning outside {@code output_tokens}, and a count that were short would settle the call too cheap.
 */
public final class OpenAiResponsesProvider implements ChatProvider {

    public static final ProviderInfo OPENAI = new ProviderInfo(ProviderId.OPENAI, "platform.openai.com", "sk-");
    public static final ProviderInfo XAI = new ProviderInfo(ProviderId.XAI, "console.x.ai", "xai-");

    /** The effort every call asks for: enough to plan a tool run, short of the cost of the top levels. */
    static final String DEFAULT_EFFORT = "medium";
    /** How long a reasoning step may stream nothing: the model is thinking, not stuck. */
    static final Duration REASONING_IDLE = Duration.ofMinutes(10);

    // GPT-6 Astra and Sol refuse "none"; GPT-5.x and the o series reason. Grok 4.7 goes up to xhigh, Grok 4.5 to high.
    private static final Pattern OPENAI_REASONS = Pattern.compile("^(gpt-5(?!.*chat)|gpt-6|o[1-9]).*");
    private static final Pattern GROK_REASONS = Pattern.compile("^grok-4\\.\\d.*(?<!non-reasoning)$");
    private static final Pattern GROK_XHIGH = Pattern.compile("^grok-4\\.7\\b.*");
    private static final Pattern OPENAI_NO_NONE = Pattern.compile("^gpt-6(?:\\.\\d+)?-(?:astra|sol)\\b.*");
    private static final List<String> LEVELS = List.of("none", "low", "medium", "high", "xhigh");

    private final ProviderInfo info;
    private final HttpTransport http;
    private final URI base;

    public OpenAiResponsesProvider(ProviderInfo info, HttpTransport http, URI base) {
        this.info = info;
        this.http = http;
        this.base = base;
    }

    @Override
    public ProviderInfo info() {
        return info;
    }

    @Override
    public ChatResult chat(ChatRequest request, KeyLease key, DeltaSink sink) throws ProviderException {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", request.model());
        if (!request.system().isEmpty()) {
            body.put("instructions", request.system());
        }
        body.put("input", Messages.responses(request.messages()));
        if (!request.tools().isEmpty()) {
            body.put("tools", Messages.responsesTools(request.tools()));
        }
        body.put("max_output_tokens", request.maxOutputTokens());
        String effort = effort(info.id(), request.model(), DEFAULT_EFFORT);
        if (effort != null) {
            body.put("reasoning", Map.of("effort", effort));
        }
        body.put("store", false);
        body.put("include", List.of("reasoning.encrypted_content"));
        body.put("stream", true);
        HttpRequest httpRequest = http.request(base.resolve(base.getPath() + "/v1/responses"))
                .header("authorization", key.headerValue("Bearer "))
                .header("content-type", "application/json")
                .header("accept", "text/event-stream")
                .POST(HttpRequest.BodyPublishers.ofByteArray(Json.bytes(body)))
                .build();
        try (HttpTransport.Stream stream = http.open(httpRequest)) {
            if (stream.status() / 100 != 2) {
                stream.drain(8192);
                throw HttpTransport.statusError(stream.status());
            }
            if (effort != null) {
                stream.idle(REASONING_IDLE);
            }
            return read(stream, request.model(), request.maxOutputTokens(), sink);
        }
    }

    /**
     * The reasoning effort to send for {@code model}, or null for a model that doesn't reason (it would refuse the
     * field). {@code want} is held to what the model takes: GPT-6 Astra and Sol have no {@code none}, Grok 4.5 stops
     * at {@code high} and Grok 4.7 goes to {@code xhigh}.
     */
    static String effort(ProviderId provider, String model, String want) {
        boolean reasons = provider == ProviderId.XAI ? GROK_REASONS.matcher(model).matches()
                : OPENAI_REASONS.matcher(model).matches();
        if (!reasons) {
            return null;
        }
        int level = Math.max(0, LEVELS.indexOf(want));
        if (provider == ProviderId.XAI) {
            level = Math.max(level, 1);
            level = Math.min(level, GROK_XHIGH.matcher(model).matches() ? 4 : 3);
        } else if (OPENAI_NO_NONE.matcher(model).matches()) {
            level = Math.max(level, 1);
        }
        return LEVELS.get(level);
    }

    /** What a stream has produced so far: the calls, the reasoning waiting for the call it led to, and a refusal. */
    private static final class Seen {
        final List<ToolCall> calls = new ArrayList<>();
        final Set<String> ids = new HashSet<>();
        final List<Map<String, Object>> reasoning = new ArrayList<>();
        boolean refused;
    }

    private static ChatResult read(HttpTransport.Stream stream, String asked, int cap, DeltaSink sink)
            throws ProviderException {
        StringBuilder text = new StringBuilder();
        Seen seen = new Seen();
        List<ToolCall> calls = seen.calls;
        String model = asked;
        SseReader events = new SseReader(stream);
        try {
            SseReader.Event event;
            while ((event = events.next()) != null) {
                if (event.data().equals("[DONE]")) {
                    break;
                }
                Map<String, Object> data = parse(event.data());
                switch (String.valueOf(data.get("type"))) {
                    case "response.created", "response.in_progress" -> {
                        String named = Json.string(Json.object(data, "response"), "model");
                        model = named == null ? model : named;
                    }
                    case "response.output_text.delta" -> {
                        String piece = Json.string(data, "delta");
                        if (piece != null) {
                            text.append(piece);
                            sink.delta(piece);
                            stream.idle(HttpTransport.Timeouts.DEFAULT.idle());
                        }
                    }
                    case "response.output_item.added" -> {
                        Map<String, Object> item = Json.object(data, "item");
                        if (item != null && !"reasoning".equals(Json.string(item, "type"))) {
                            // Thinking is over: text or a call is coming, so the usual wait applies again.
                            stream.idle(HttpTransport.Timeouts.DEFAULT.idle());
                        }
                    }
                    case "response.refusal.delta", "response.refusal.done" -> seen.refused = true;
                    case "response.output_item.done" -> take(Json.object(data, "item"), seen);
                    case "response.completed", "response.incomplete" -> {
                        Map<String, Object> response = Json.object(data, "response");
                        if (response != null && response.get("output") instanceof List<?> output) {
                            for (Object item : output) {
                                if (item instanceof Map<?, ?> map) {
                                    @SuppressWarnings("unchecked")
                                    Map<String, Object> typed = (Map<String, Object>) map;
                                    take(typed, seen);
                                }
                            }
                        }
                        String named = Json.string(response, "model");
                        Usage used = usage(Json.object(response, "usage"));
                        return new ChatResult(text.toString(), used, named == null ? model : named,
                                stopReason(Json.string(response, "status"),
                                        Json.object(response, "incomplete_details"), seen.refused,
                                        text.isEmpty() && calls.isEmpty(), used.outputTokens(), cap),
                                calls);
                    }
                    case "response.failed" -> throw streamError(
                            Json.string(Json.object(Json.object(data, "response"), "error"), "code"));
                    case "error" -> throw streamError(Json.string(data, "code"));
                    default -> {
                        // Output items, content parts, reasoning summaries: nothing a thread shows.
                    }
                }
            }
        } catch (IOException e) {
            throw HttpTransport.readError(stream);
        }
        throw new ProviderException(ProviderException.Kind.UNAVAILABLE, true);
    }

    /**
     * Why it stopped, in the words the loop reads: {@code refusal} for a refusal or the content filter, the provider's
     * reason for an incomplete reply ({@code max_output_tokens}), and {@code max_output_tokens} too for a reply that
     * is empty and used its whole cap, which the API calls completed: the cap went on reasoning.
     */
    static String stopReason(String status, Map<String, Object> incomplete, boolean refused, boolean empty,
            long output, int cap) {
        String reason = incomplete == null ? null : Json.string(incomplete, "reason");
        if (refused || "content_filter".equals(reason)) {
            return "refusal";
        }
        if ("incomplete".equals(status) || reason != null) {
            return reason == null ? "incomplete" : reason;
        }
        if (empty && output >= cap) {
            return "max_output_tokens";
        }
        return "completed";
    }

    /**
     * An output item: a function_call becomes a call, once (the done event and the final output list can both carry
     * it), with the reasoning items since the last call ahead of it; a reasoning item waits for its call; a message
     * with a refusal part marks the reply refused.
     */
    private static void take(Map<String, Object> item, Seen seen) throws ProviderException {
        if (item == null) {
            return;
        }
        String type = Json.string(item, "type");
        if ("reasoning".equals(type)) {
            String encrypted = Json.string(item, "encrypted_content");
            String key = "r:" + (Json.string(item, "id") != null ? Json.string(item, "id") : encrypted);
            if (encrypted != null && seen.ids.add(key)) {
                Map<String, Object> kept = new LinkedHashMap<>();
                kept.put("type", "reasoning");
                if (Json.string(item, "id") != null) {
                    kept.put("id", Json.string(item, "id"));
                }
                kept.put("summary", List.of());
                kept.put("encrypted_content", encrypted);
                seen.reasoning.add(kept);
            }
            return;
        }
        if ("message".equals(type) && item.get("content") instanceof List<?> parts) {
            for (Object part : parts) {
                if (part instanceof Map<?, ?> map && "refusal".equals(map.get("type"))) {
                    seen.refused = true;
                }
            }
            return;
        }
        if (!"function_call".equals(type)) {
            return;
        }
        String id = Json.string(item, "call_id");
        String name = Json.string(item, "name");
        if (id == null || name == null) {
            throw new ProviderException(ProviderException.Kind.UNAVAILABLE, true);
        }
        if (!seen.ids.add(id)) {
            return;
        }
        Messages.checkCount(seen.calls.size() + 1);
        String arguments = Json.string(item, "arguments");
        if (arguments != null) {
            Messages.checkArguments(arguments);
        }
        ToolCall call = Messages.toolCall(id, name, arguments).withReasoning(seen.reasoning);
        seen.reasoning.clear();
        seen.calls.add(call);
    }

    static Usage usage(Map<String, Object> usage) {
        long input = Messages.number(usage, "input_tokens");
        long cached = Math.min(input, Messages.number(Json.object(usage, "input_tokens_details"), "cached_tokens"));
        long visible = Messages.number(usage, "output_tokens");
        long reasoning = Messages.number(Json.object(usage, "output_tokens_details"), "reasoning_tokens");
        long total = Messages.number(usage, "total_tokens");
        // The most the provider's own figures say: reasoning is never clamped to the visible output.
        long output = Math.max(visible,
                Math.max(total > input ? total - input : 0, reasoning > visible ? visible + reasoning : 0));
        return new Usage(input - cached, cached, 0, output, Math.min(output, reasoning));
    }

    @Override
    public List<ModelInfo> models(KeyLease key) throws ProviderException {
        HttpRequest request = http.request(base.resolve(base.getPath() + "/v1/models"))
                .header("authorization", key.headerValue("Bearer "))
                .GET()
                .build();
        try (HttpTransport.Stream stream = http.open(request)) {
            if (stream.status() / 100 != 2) {
                stream.drain(8192);
                throw HttpTransport.statusError(stream.status());
            }
            Map<String, Object> list = parse(new String(stream.readNBytes(4 << 20), StandardCharsets.UTF_8));
            List<ModelInfo> models = new ArrayList<>();
            if (list.get("data") instanceof List<?> data) {
                for (Object item : data) {
                    if (item instanceof Map<?, ?> model && model.get("id") instanceof String id) {
                        models.add(new ModelInfo(id, id));
                    }
                }
            }
            return models;
        } catch (IOException e) {
            throw new ProviderException(ProviderException.Kind.UNAVAILABLE, false);
        }
    }

    private static Map<String, Object> parse(String json) throws ProviderException {
        try {
            return Json.parseObject(json.getBytes(StandardCharsets.UTF_8));
        } catch (JsonFormatException e) {
            throw new ProviderException(ProviderException.Kind.UNAVAILABLE, true);
        }
    }

    /** OpenAI's error codes in a stream that had started, so the call may have been billed. */
    static ProviderException streamError(String code) {
        String c = code == null ? "" : code;
        ProviderException.Kind kind;
        if (c.contains("rate_limit") || c.contains("quota")) {
            kind = ProviderException.Kind.RATE_LIMITED;
        } else if (c.contains("invalid") || c.contains("not_found") || c.contains("context_length")) {
            kind = ProviderException.Kind.BAD_REQUEST;
        } else if (c.contains("auth") || c.contains("api_key")) {
            kind = ProviderException.Kind.AUTH;
        } else {
            kind = ProviderException.Kind.UNAVAILABLE;
        }
        return new ProviderException(kind, true);
    }
}
