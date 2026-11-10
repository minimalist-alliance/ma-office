package com.minimalistalliance.desk.agent.provider.anthropic;

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
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Anthropic's Messages API, streamed: {@code POST /v1/messages} with {@code stream: true}. About 150 lines where
 * Spring AI would bring the vendor's SDK (spikes/spring-ai-footprint). Usage maps one to one: {@code input_tokens}
 * excludes cache reads and writes, which come as their own counts, and {@code output_tokens} includes thinking.
 */
public final class AnthropicProvider implements ChatProvider {

    public static final ProviderInfo INFO = new ProviderInfo(ProviderId.ANTHROPIC, "console.anthropic.com", "sk-ant-");
    static final String VERSION = "2023-06-01";

    private final HttpTransport http;
    private final URI base;

    public AnthropicProvider(HttpTransport http, URI base) {
        this.http = http;
        this.base = base;
    }

    @Override
    public ProviderInfo info() {
        return INFO;
    }

    @Override
    public ChatResult chat(ChatRequest request, KeyLease key, DeltaSink sink) throws ProviderException {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", request.model());
        body.put("max_tokens", request.maxOutputTokens());
        // One cache breakpoint, on the last system block: the prefix it ends is the tools and then the system prompt,
        // which a 50-step run would otherwise resend at the full input price every step. With no system prompt it
        // goes on the last tool.
        Map<String, Object> breakpoint = Map.of("type", "ephemeral");
        if (!request.system().isEmpty()) {
            Map<String, Object> block = new LinkedHashMap<>();
            block.put("type", "text");
            block.put("text", request.system());
            block.put("cache_control", breakpoint);
            body.put("system", List.of(block));
        }
        body.put("messages", Messages.anthropic(request.messages()));
        if (!request.tools().isEmpty()) {
            List<Map<String, Object>> tools = Messages.anthropicTools(request.tools());
            if (request.system().isEmpty()) {
                tools.getLast().put("cache_control", breakpoint);
            }
            body.put("tools", tools);
        }
        body.put("stream", true);
        HttpRequest httpRequest = authorized(http.request(base.resolve(base.getPath() + "/v1/messages")), key)
                .header("content-type", "application/json")
                .header("accept", "text/event-stream")
                .POST(HttpRequest.BodyPublishers.ofByteArray(Json.bytes(body)))
                .build();
        try (HttpTransport.Stream stream = http.open(httpRequest)) {
            if (stream.status() / 100 != 2) {
                stream.drain(8192);
                throw HttpTransport.statusError(stream.status());
            }
            return read(stream, request.model(), sink);
        }
    }

    private static ChatResult read(HttpTransport.Stream stream, String asked, DeltaSink sink)
            throws ProviderException {
        StringBuilder text = new StringBuilder();
        List<ToolCall> calls = new ArrayList<>();
        Map<Integer, PendingCall> open = new HashMap<>();
        String model = asked;
        String stopReason = null;
        long input = 0;
        long cacheRead = 0;
        long cacheWrite = 0;
        long output = 0;
        SseReader events = new SseReader(stream);
        try {
            SseReader.Event event;
            while ((event = events.next()) != null) {
                Map<String, Object> data = parse(event.data());
                switch (String.valueOf(data.get("type"))) {
                    case "message_start" -> {
                        Map<String, Object> message = Json.object(data, "message");
                        if (Json.string(message, "model") != null) {
                            model = Json.string(message, "model");
                        }
                        Map<String, Object> usage = Json.object(message, "usage");
                        input = Messages.number(usage, "input_tokens");
                        cacheRead = Messages.number(usage, "cache_read_input_tokens");
                        cacheWrite = Messages.number(usage, "cache_creation_input_tokens");
                        output = Messages.number(usage, "output_tokens");
                    }
                    case "content_block_start" -> {
                        Map<String, Object> block = Json.object(data, "content_block");
                        if (block != null && "tool_use".equals(Json.string(block, "type"))
                                && data.get("index") instanceof Number index) {
                            Messages.checkCount(calls.size() + open.size() + 1);
                            String id = Json.string(block, "id");
                            String name = Json.string(block, "name");
                            if (id == null || name == null) {
                                throw new ProviderException(ProviderException.Kind.UNAVAILABLE, true);
                            }
                            open.put(index.intValue(), new PendingCall(id, name));
                        }
                    }
                    case "content_block_stop" -> {
                        if (data.get("index") instanceof Number index) {
                            PendingCall done = open.remove(index.intValue());
                            if (done != null) {
                                calls.add(Messages.toolCall(done.id, done.name, done.arguments.toString()));
                            }
                        }
                    }
                    case "content_block_delta" -> {
                        Map<String, Object> delta = Json.object(data, "delta");
                        if (delta != null && "input_json_delta".equals(Json.string(delta, "type"))
                                && data.get("index") instanceof Number index
                                && Json.string(delta, "partial_json") != null) {
                            PendingCall pending = open.get(index.intValue());
                            if (pending != null) {
                                pending.arguments.append(Json.string(delta, "partial_json"));
                                Messages.checkArguments(pending.arguments);
                            }
                        }
                        if ("text_delta".equals(Json.string(delta, "type")) && Json.string(delta, "text") != null) {
                            String piece = Json.string(delta, "text");
                            text.append(piece);
                            sink.delta(piece);
                        }
                    }
                    case "message_delta" -> {
                        Map<String, Object> delta = Json.object(data, "delta");
                        if (Json.string(delta, "stop_reason") != null) {
                            stopReason = Json.string(delta, "stop_reason");
                        }
                        Map<String, Object> usage = Json.object(data, "usage");
                        if (usage != null && usage.get("output_tokens") instanceof Number n) {
                            output = n.longValue();
                        }
                    }
                    case "message_stop" -> {
                        return new ChatResult(text.toString(), new Usage(input, cacheRead, cacheWrite, output, 0),
                                model, stopReason, calls);
                    }
                    case "error" -> throw streamError(Json.string(Json.object(data, "error"), "type"));
                    default -> {
                        // ping and thinking, which isn't shown.
                    }
                }
            }
        } catch (IOException e) {
            throw HttpTransport.readError(stream);
        }
        throw new ProviderException(ProviderException.Kind.UNAVAILABLE, true);
    }

    /** A tool_use block still streaming its input. */
    private record PendingCall(String id, String name, StringBuilder arguments) {
        PendingCall(String id, String name) {
            this(id, name, new StringBuilder());
        }
    }

    @Override
    public List<ModelInfo> models(KeyLease key) throws ProviderException {
        HttpRequest request = authorized(http.request(base.resolve(base.getPath() + "/v1/models?limit=1000")), key)
                .GET()
                .build();
        try (HttpTransport.Stream stream = http.open(request)) {
            if (stream.status() / 100 != 2) {
                stream.drain(8192);
                throw HttpTransport.statusError(stream.status());
            }
            Map<String, Object> list =
                    parse(new String(stream.readNBytes(4 << 20), java.nio.charset.StandardCharsets.UTF_8));
            List<ModelInfo> models = new ArrayList<>();
            if (list.get("data") instanceof List<?> data) {
                for (Object item : data) {
                    if (item instanceof Map<?, ?> model && model.get("id") instanceof String id) {
                        Object label = model.get("display_name");
                        models.add(new ModelInfo(id, label instanceof String name ? name : id));
                    }
                }
            }
            return models;
        } catch (IOException e) {
            throw new ProviderException(ProviderException.Kind.UNAVAILABLE, false);
        }
    }

    private static HttpRequest.Builder authorized(HttpRequest.Builder builder, KeyLease key) {
        return builder.header("x-api-key", key.headerValue("")).header("anthropic-version", VERSION);
    }

    private static Map<String, Object> parse(String json) throws ProviderException {
        try {
            return Json.parseObject(json.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (JsonFormatException e) {
            throw new ProviderException(ProviderException.Kind.UNAVAILABLE, true);
        }
    }

    /** Anthropic's error types, sent in the stream after it started, so the call may have been billed. */
    static ProviderException streamError(String type) {
        ProviderException.Kind kind = switch (type == null ? "" : type) {
            case "authentication_error", "permission_error" -> ProviderException.Kind.AUTH;
            case "rate_limit_error" -> ProviderException.Kind.RATE_LIMITED;
            case "invalid_request_error", "not_found_error", "request_too_large" -> ProviderException.Kind.BAD_REQUEST;
            case "timeout_error" -> ProviderException.Kind.TIMEOUT;
            default -> ProviderException.Kind.UNAVAILABLE;
        };
        return new ProviderException(kind, true);
    }
}
