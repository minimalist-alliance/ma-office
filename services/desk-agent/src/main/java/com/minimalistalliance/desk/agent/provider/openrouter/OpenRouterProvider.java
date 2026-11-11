package com.minimalistalliance.desk.agent.provider.openrouter;

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
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.URI;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * OpenRouter's Chat Completions API, streamed: {@code POST /api/v1/chat/completions} on {@code openrouter.ai}, in the
 * OpenAI-compatible shape, with the member's own key, from OpenRouter's one-click connect in the member's browser or
 * pasted. Its point at launch is the free models: ids ending in {@code :free}, and the {@code openrouter/free} router,
 * which OpenRouter serves at $0 with no card, within its own limits (20 requests a minute, and 50 a day, or 1000 once
 * the account has ever bought 10 credits). They're priced $0 by their id ({@link ProviderId#servesFree}).
 *
 * <p><b>The key check</b> is {@code GET /api/v1/key}, as the model list is public and proves nothing of a key. A
 * management or provisioning key, which makes keys and can't chat, is refused as {@code AUTH}.
 *
 * <p><b>The model list</b> is the free models only, the {@link #PICKS} first, so a client's first entry is a good
 * default; free models come and go within days, so it's whatever is free now. Paid models aren't listed at launch: one
 * bound by id anyway counts at the price table's highest, as any unlisted model does (ADR 0043). The list comes from the
 * public catalog ({@code GET /api/v1/models}, no key), which also says which models take tools, and is kept an hour.
 *
 * <p><b>Without tools:</b> a model the catalog says takes none is sent no tools and no tool turns, and its instructions
 * end with {@link #NO_TOOLS}, so it still chats. A model the catalog says takes tools, but for which OpenRouter answers
 * that no endpoint does, is asked once more without them, and remembered.
 *
 * <p><b>Errors</b> are kinds, never OpenRouter's message: the free daily limit is {@code FREE_LIMIT}; the per-minute
 * limit and a 402 for credits are {@code RATE_LIMITED}; a 404 because the account's privacy settings allow no endpoint
 * for the model is {@code DATA_POLICY}. An error's body is read for that, at most 64 KiB, and kept nowhere.
 *
 * <p><b>Usage:</b> {@code prompt_tokens} includes cached and cache-write tokens, so both are taken out of the input
 * count, and output is the most of {@code completion_tokens} and {@code total_tokens} less the prompt. {@code usage.cost},
 * what OpenRouter billed in dollars, is the result's {@code providerMicroUsd}, which the gateway charges when it's more.
 * A stream with no usage counts as the gateway estimates: its bytes over 3.
 */
public final class OpenRouterProvider implements ChatProvider {

    public static final ProviderInfo INFO = new ProviderInfo(ProviderId.OPENROUTER, "openrouter.ai", "sk-or-");

    /** OpenRouter's router across its free models. */
    public static final String FREE_ROUTER = ProviderId.OPENROUTER_FREE_ROUTER;

    /**
     * The free models listed first, in this order, when the catalog has them. Picked on 2026-11-11 from a public run of
     * every free model with tool calls from Oct 28 to Nov 6: each of these answered all of its requests, passed every
     * tool call it was given, and was still free at the end. Nemotron 3.5 Super VL did best and fastest; North Mini
     * Code's free endpoint doesn't train on prompts; Nemotron 3 Ultra is the largest, and slower.
     */
    static final List<String> PICKS = List.of(
            "nvidia/nemotron-3.5-super-vl:free",
            "cohere/north-mini-code:free",
            "nvidia/nemotron-3-ultra-550b-a55b:free");

    /** Told to a model that takes no tools, after the agent's own instructions. */
    static final String NO_TOOLS = "This model can't use tools, so you have none in this conversation: you can't read,"
            + " save or change anything on the desk, remember anything new, or message other agents. Answer from the"
            + " conversation and your instructions alone. If the member asks for something that needs a tool, say"
            + " plainly that this model can't do it and a model with tools can.";

    static final Duration CATALOG_FRESH = Duration.ofHours(1);
    static final int MAX_CATALOG_BYTES = 16 << 20;
    static final int MAX_CATALOG_PAGES = 8;
    static final int MAX_ERROR_BYTES = 64 << 10;
    static final int MAX_LABEL = 96;
    static final int MAX_REMEMBERED = 256;
    /** Past any real call: a reported cost above it is ignored as nonsense, and the table's price stands. */
    static final long MAX_REPORTED_MICRO_USD = 10_000L * 1_000_000L;

    private static final Pattern MODEL = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}");
    private static final int BYTES_PER_TOKEN = 3;

    /** What the public catalog says of one model. */
    record Listed(String id, String label, boolean tools) {}

    private record Catalog(List<Listed> models, Map<String, Listed> byId, long fetchedAt) {}

    /** OpenRouter said no endpoint for the model takes tools. */
    private static final class ToolsRefused extends Exception {
        private static final long serialVersionUID = 1L;

        ToolsRefused() {
            super(null, null, false, false);
        }
    }

    private final HttpTransport http;
    private final URI base;
    private volatile Catalog catalog;
    private final Set<String> refusedTools = ConcurrentHashMap.newKeySet();

    public OpenRouterProvider(HttpTransport http, URI base) {
        this.http = http;
        this.base = base;
    }

    @Override
    public ProviderInfo info() {
        return INFO;
    }

    // ---------------------------------------------------------------- chat

    @Override
    public ChatResult chat(ChatRequest request, KeyLease key, DeltaSink sink) throws ProviderException {
        boolean tools = !request.tools().isEmpty() && takesTools(request.model());
        try {
            return send(request, key, sink, tools);
        } catch (ToolsRefused e) {
            if (refusedTools.size() < MAX_REMEMBERED) {
                refusedTools.add(request.model());
            }
            try {
                return send(request, key, sink, false);
            } catch (ToolsRefused again) {
                throw new ProviderException(ProviderException.Kind.BAD_REQUEST, false);
            }
        }
    }

    private ChatResult send(ChatRequest request, KeyLease key, DeltaSink sink, boolean tools)
            throws ProviderException, ToolsRefused {
        String system = request.system();
        if (!tools && !request.tools().isEmpty()) {
            system = system.isEmpty() ? NO_TOOLS : system + "\n\n" + NO_TOOLS;
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", request.model());
        body.put("messages", ChatCompletions.messages(system, request.messages(), tools));
        if (tools) {
            body.put("tools", ChatCompletions.tools(request.tools()));
        }
        body.put("max_tokens", request.maxOutputTokens());
        body.put("stream", true);
        HttpRequest httpRequest = http.request(api("/chat/completions"))
                .header("authorization", key.headerValue("Bearer "))
                .header("content-type", "application/json")
                .header("accept", "text/event-stream")
                .POST(HttpRequest.BodyPublishers.ofByteArray(Json.bytes(body)))
                .build();
        boolean free = ProviderId.OPENROUTER.servesFree(request.model());
        try (HttpTransport.Stream stream = http.open(httpRequest)) {
            if (stream.status() / 100 != 2) {
                Map<String, Object> error = errorBody(stream);
                String message = lower(error == null ? null : Json.string(error, "message"));
                if (tools && (stream.status() == 404 || stream.status() == 400) && toolsUnsupported(message)) {
                    throw new ToolsRefused();
                }
                throw refusal(stream.status(), message, errorType(error), stream.header("x-ratelimit-limit"),
                        stream.header("x-ratelimit-remaining"), free);
            }
            return read(stream, request, sink, tools, free);
        }
    }

    /** A call's turn being streamed: its id and name from the first delta, its arguments from all of them. */
    private static final class Parts {
        String id;
        String name;
        final StringBuilder arguments = new StringBuilder();
    }

    private static ChatResult read(HttpTransport.Stream stream, ChatRequest request, DeltaSink sink, boolean tools,
            boolean free) throws ProviderException {
        StringBuilder text = new StringBuilder();
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
                    throw streamError(error, free);
                }
                String named = Json.string(chunk, "model");
                if (named != null && MODEL.matcher(named).matches()) {
                    model = named;
                }
                Map<String, Object> reported = Json.object(chunk, "usage");
                if (reported != null) {
                    usage = reported;
                }
                Map<String, Object> choice = first(chunk.get("choices"));
                if (choice == null) {
                    continue;
                }
                Map<String, Object> delta = Json.object(choice, "delta");
                if (delta != null) {
                    String piece = Json.string(delta, "content");
                    if (piece != null && !piece.isEmpty()) {
                        text.append(piece);
                        sink.delta(piece);
                    }
                    if (tools && delta.get("tool_calls") instanceof List<?> parts) {
                        take(parts, calls);
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
        List<ToolCall> made = calls(calls);
        Usage used = usage != null ? usage(usage) : estimate(request, text, calls);
        Long billed = usage == null ? null : microUsd(usage.get("cost"));
        return new ChatResult(text.toString(), used, model,
                stopReason(finish, text.isEmpty() && made.isEmpty(), used.outputTokens(), request.maxOutputTokens()),
                made, billed);
    }

    /** Tool-call deltas: by {@code index}, or a new call when one comes without it and with a new id. */
    private static void take(List<?> parts, TreeMap<Integer, Parts> calls) throws ProviderException {
        for (Object item : parts) {
            if (!(item instanceof Map<?, ?> raw)) {
                continue;
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> part = (Map<String, Object>) raw;
            String id = Json.string(part, "id");
            int index;
            if (part.get("index") instanceof Number n && n.intValue() >= 0
                    && n.intValue() <= Messages.MAX_TOOL_CALLS) {
                index = n.intValue();
            } else if (calls.isEmpty() || (id != null && !id.equals(calls.lastEntry().getValue().id))) {
                index = calls.isEmpty() ? 0 : calls.lastKey() + 1;
            } else {
                index = calls.lastKey();
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
            Map<String, Object> function = Json.object(part, "function");
            if (function != null) {
                String name = Json.string(function, "name");
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

    private static List<ToolCall> calls(TreeMap<Integer, Parts> calls) throws ProviderException {
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
            out.add(Messages.toolCall(id, call.name, call.arguments.toString()));
        }
        return out;
    }

    /**
     * Why it stopped, in the words the loop reads: {@code max_tokens} for {@code length} or an empty reply that used its
     * whole cap, {@code refusal} for the content filter, {@code tool_calls}, else {@code completed}.
     */
    static String stopReason(String finish, boolean empty, long output, int cap) {
        return switch (finish == null ? "stop" : finish) {
            case "length" -> "max_tokens";
            case "content_filter" -> "refusal";
            case "tool_calls" -> "tool_calls";
            default -> empty && output >= cap ? "max_tokens" : "completed";
        };
    }

    static Usage usage(Map<String, Object> usage) {
        long prompt = Messages.number(usage, "prompt_tokens");
        Map<String, Object> details = Json.object(usage, "prompt_tokens_details");
        long cached = Math.min(prompt, details == null ? 0 : Messages.number(details, "cached_tokens"));
        long written = Math.min(prompt - cached, details == null ? 0 : Messages.number(details, "cache_write_tokens"));
        long completion = Messages.number(usage, "completion_tokens");
        Map<String, Object> out = Json.object(usage, "completion_tokens_details");
        long reasoning = out == null ? 0 : Messages.number(out, "reasoning_tokens");
        long total = Messages.number(usage, "total_tokens");
        long output = Math.max(completion, total > prompt ? total - prompt : 0);
        return new Usage(Math.max(0, prompt - cached - written), Math.max(0, cached), Math.max(0, written),
                Math.max(0, output), Math.max(0, Math.min(output, reasoning)));
    }

    /** No usage came: the input as the gateway estimates it, and the output's bytes over 3. */
    private static Usage estimate(ChatRequest request, CharSequence text, TreeMap<Integer, Parts> calls) {
        long bytes = text.toString().getBytes(StandardCharsets.UTF_8).length;
        for (Parts call : calls.values()) {
            bytes += call.arguments.toString().getBytes(StandardCharsets.UTF_8).length
                    + (call.name == null ? 0 : call.name.length());
        }
        return new Usage(Math.ceilDiv(request.inputBytes(), BYTES_PER_TOKEN) + request.extraInputTokens(), 0, 0,
                Math.ceilDiv(bytes, BYTES_PER_TOKEN), 0);
    }

    /** {@code usage.cost}, dollars, as µ$ rounded up; null when it's absent, negative or past any real call. */
    static Long microUsd(Object cost) {
        if (!(cost instanceof Number number)) {
            return null;
        }
        try {
            BigDecimal dollars = new BigDecimal(number.toString());
            if (dollars.signum() < 0) {
                return null;
            }
            BigDecimal micro = dollars.movePointRight(6).setScale(0, RoundingMode.CEILING);
            if (micro.compareTo(BigDecimal.valueOf(MAX_REPORTED_MICRO_USD)) > 0) {
                return null;
            }
            return micro.longValueExact();
        } catch (NumberFormatException | ArithmeticException e) {
            return null;
        }
    }

    // ---------------------------------------------------------------- errors

    /** An HTTP refusal, before anything was generated, so none is billed. */
    static ProviderException refusal(int status, String message, String type, String limit, String remaining,
            boolean free) {
        ProviderException.Kind kind = switch (status) {
            case 401 -> ProviderException.Kind.AUTH;
            // A guardrail or a moderation flag is about the request; anything else is the key.
            case 403 -> mentions(message, type, "moderation", "flagged", "guardrail")
                    ? ProviderException.Kind.BAD_REQUEST : ProviderException.Kind.AUTH;
            // Out of credits, or a balance below zero, which also stops free models.
            case 402 -> ProviderException.Kind.RATE_LIMITED;
            case 429 -> dailyFree(message, limit, remaining, free)
                    ? ProviderException.Kind.FREE_LIMIT : ProviderException.Kind.RATE_LIMITED;
            case 404 -> mentions(message, type, "data policy", "privacy")
                    ? ProviderException.Kind.DATA_POLICY : ProviderException.Kind.BAD_REQUEST;
            default -> HttpTransport.statusError(status).kind();
        };
        return new ProviderException(kind, false);
    }

    /** An error in a stream that had started, so the call may have been billed. */
    static ProviderException streamError(Map<String, Object> error, boolean free) {
        String message = lower(Json.string(error, "message"));
        String type = errorType(error);
        Object code = error.get("code");
        String word = lower(code instanceof String s ? s : null);
        int status = code instanceof Number n ? n.intValue() : 0;
        ProviderException.Kind kind;
        if (status == 429 || word.contains("rate_limit") || type.contains("rate_limit")) {
            kind = dailyFree(message, null, null, free)
                    ? ProviderException.Kind.FREE_LIMIT : ProviderException.Kind.RATE_LIMITED;
        } else if (status == 402 || type.contains("payment")) {
            kind = ProviderException.Kind.RATE_LIMITED;
        } else if (status == 401) {
            kind = ProviderException.Kind.AUTH;
        } else if (status == 400 || status == 404 || status == 413 || word.contains("invalid")) {
            kind = ProviderException.Kind.BAD_REQUEST;
        } else {
            kind = ProviderException.Kind.UNAVAILABLE;
        }
        return new ProviderException(kind, true);
    }

    /**
     * Whether a 429 is the free models' daily limit rather than the per-minute one: OpenRouter's message names it
     * ({@code free-models-per-day}), or, on a free model, the limit that ran out is 50 or more a window, which only the
     * daily one is (the minute's is 20).
     */
    static boolean dailyFree(String message, String limit, String remaining, boolean free) {
        String m = lower(message);
        if ((m.contains("per-day") || m.contains("per day") || m.contains("daily")) && (free || m.contains("free"))) {
            return true;
        }
        if (!free || !"0".equals(remaining == null ? null : remaining.strip())) {
            return false;
        }
        try {
            return limit != null && Long.parseLong(limit.strip()) >= 50;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    static boolean toolsUnsupported(String message) {
        String m = lower(message);
        return m.contains("tool use") || m.contains("support tool") || m.contains("tool calling")
                || m.contains("function calling");
    }

    private static boolean mentions(String message, String type, String... words) {
        String m = lower(message) + " " + lower(type);
        for (String word : words) {
            if (m.contains(word)) {
                return true;
            }
        }
        return false;
    }

    /** {@code {"error": {...}}} of a refusal, or null. Read to classify it, never kept. */
    private static Map<String, Object> errorBody(HttpTransport.Stream stream) {
        try {
            byte[] body = stream.readNBytes(MAX_ERROR_BYTES);
            stream.drain(8192);
            return Json.object(Json.parseObject(body), "error");
        } catch (IOException | JsonFormatException e) {
            return null;
        }
    }

    private static String errorType(Map<String, Object> error) {
        Map<String, Object> metadata = error == null ? null : Json.object(error, "metadata");
        return lower(metadata == null ? null : Json.string(metadata, "error_type"));
    }

    private static String lower(String text) {
        return text == null ? "" : text.toLowerCase(Locale.ROOT);
    }

    // ---------------------------------------------------------------- models and the key check

    @Override
    public List<ModelInfo> models(KeyLease key) throws ProviderException {
        checkKey(key);
        return freeModels(catalog(true).models());
    }

    private void checkKey(KeyLease key) throws ProviderException {
        HttpRequest request = http.request(api("/key"))
                .header("authorization", key.headerValue("Bearer "))
                .GET()
                .build();
        Map<String, Object> data;
        try (HttpTransport.Stream stream = http.open(request)) {
            if (stream.status() / 100 != 2) {
                stream.drain(8192);
                throw HttpTransport.statusError(stream.status());
            }
            data = Json.object(parse(stream.readNBytes(1 << 20), false), "data");
        } catch (IOException e) {
            throw new ProviderException(ProviderException.Kind.UNAVAILABLE, false);
        }
        if (data == null) {
            throw new ProviderException(ProviderException.Kind.UNAVAILABLE, false);
        }
        if (Boolean.TRUE.equals(data.get("is_management_key")) || Boolean.TRUE.equals(data.get("is_provisioning_key"))) {
            throw new ProviderException(ProviderException.Kind.AUTH, false);
        }
    }

    /**
     * The free models in the order a client shows them: the picks there are, then the free router, then the other
     * free models that take tools, then those that take none. With none at all, the router alone, which is always
     * there.
     */
    static List<ModelInfo> freeModels(List<Listed> catalog) {
        Map<String, Listed> free = new LinkedHashMap<>();
        for (Listed model : catalog) {
            if (ProviderId.OPENROUTER.servesFree(model.id())) {
                free.putIfAbsent(model.id(), model);
            }
        }
        List<ModelInfo> out = new ArrayList<>();
        for (String pick : PICKS) {
            Listed model = free.remove(pick);
            if (model != null) {
                out.add(new ModelInfo(model.id(), model.label(), model.tools()));
            }
        }
        Listed router = free.remove(FREE_ROUTER);
        if (router != null) {
            out.add(new ModelInfo(router.id(), router.label(), router.tools()));
        }
        for (boolean tools : new boolean[] {true, false}) {
            for (Listed model : free.values()) {
                if (model.tools() == tools) {
                    out.add(new ModelInfo(model.id(), model.label(), model.tools()));
                }
            }
        }
        if (out.isEmpty()) {
            out.add(new ModelInfo(FREE_ROUTER, "Free models, picked by OpenRouter", true));
        }
        return out;
    }

    /** Whether to send this model tools: unless OpenRouter refused them for it, or its catalog entry says it takes none. */
    private boolean takesTools(String model) {
        if (refusedTools.contains(model)) {
            return false;
        }
        Catalog known;
        try {
            known = catalog(false);
        } catch (ProviderException e) {
            // Unknown: send them, and if no endpoint takes them OpenRouter says so.
            return true;
        }
        Listed listed = known.byId().get(model);
        return listed == null || listed.tools();
    }

    /** The public catalog, fetched again when it's older than {@link #CATALOG_FRESH} or {@code fresh} is asked. */
    private Catalog catalog(boolean fresh) throws ProviderException {
        Catalog held = catalog;
        if (held != null && !fresh && System.nanoTime() - held.fetchedAt() < CATALOG_FRESH.toNanos()) {
            return held;
        }
        List<Listed> models = new ArrayList<>();
        Map<String, Listed> byId = new HashMap<>();
        URI next = api("/models");
        long bytes = 0;
        for (int page = 0; next != null && page < MAX_CATALOG_PAGES; page++) {
            Map<String, Object> body;
            try (HttpTransport.Stream stream = http.open(http.request(next).GET().build())) {
                if (stream.status() / 100 != 2) {
                    stream.drain(8192);
                    // The list is public: a refusal of it says nothing of the key.
                    throw new ProviderException(ProviderException.Kind.UNAVAILABLE, false);
                }
                int room = (int) (MAX_CATALOG_BYTES - bytes);
                byte[] read = stream.readNBytes(room + 1);
                if (read.length > room) {
                    throw new ProviderException(ProviderException.Kind.UNAVAILABLE, false);
                }
                bytes += read.length;
                body = parse(read, false);
            } catch (IOException e) {
                throw new ProviderException(ProviderException.Kind.UNAVAILABLE, false);
            }
            if (body.get("data") instanceof List<?> data) {
                for (Object item : data) {
                    Listed model = listed(item);
                    if (model != null && byId.putIfAbsent(model.id(), model) == null) {
                        models.add(model);
                    }
                }
            }
            next = nextPage(body);
        }
        Catalog fetched = new Catalog(List.copyOf(models), Map.copyOf(byId), System.nanoTime());
        catalog = fetched;
        return fetched;
    }

    /** One catalog entry that answers in text, or null. */
    private static Listed listed(Object item) {
        if (!(item instanceof Map<?, ?> raw)) {
            return null;
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> model = (Map<String, Object>) raw;
        String id = Json.string(model, "id");
        if (id == null || !MODEL.matcher(id).matches()) {
            return null;
        }
        Map<String, Object> architecture = Json.object(model, "architecture");
        if (architecture != null && architecture.get("output_modalities") instanceof List<?> out
                && !out.contains("text")) {
            return null;
        }
        boolean tools = model.get("supported_parameters") instanceof List<?> supported && supported.contains("tools");
        return new Listed(id, label(Json.string(model, "name"), id), tools);
    }

    /** The catalog's name, without control characters and at most {@link #MAX_LABEL} long, or the id. */
    static String label(String name, String id) {
        if (name == null) {
            return id;
        }
        String clean = name.codePoints().filter(c -> !Character.isISOControl(c) && Character.getType(c) != Character.FORMAT)
                .collect(StringBuilder::new, StringBuilder::appendCodePoint, StringBuilder::append).toString().strip();
        if (clean.isEmpty()) {
            return id;
        }
        return clean.length() <= MAX_LABEL ? clean : clean.substring(0, MAX_LABEL).strip();
    }

    /** {@code links.next}, only on this provider's own host and the same list. */
    private URI nextPage(Map<String, Object> body) {
        Map<String, Object> links = Json.object(body, "links");
        String next = links == null ? null : Json.string(links, "next");
        if (next == null || next.isEmpty()) {
            return null;
        }
        try {
            URI uri = base.resolve(next);
            URI list = api("/models");
            if (Objects.equals(uri.getScheme(), base.getScheme()) && Objects.equals(uri.getHost(), base.getHost())
                    && uri.getPort() == base.getPort() && Objects.equals(uri.getRawPath(), list.getRawPath())
                    && uri.getRawUserInfo() == null && uri.getRawFragment() == null) {
                return uri;
            }
        } catch (IllegalArgumentException e) {
            // Not a URL: there's no next page.
        }
        return null;
    }

    // ---------------------------------------------------------------- helpers

    private URI api(String path) {
        return base.resolve(base.getPath() + "/api/v1" + path);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> first(Object choices) {
        return choices instanceof List<?> list && !list.isEmpty() && list.getFirst() instanceof Map<?, ?> map
                ? (Map<String, Object>) map : null;
    }

    private static Map<String, Object> parse(byte[] json, boolean mayHaveBilled) throws ProviderException {
        try {
            return Json.parseObject(json);
        } catch (JsonFormatException e) {
            throw new ProviderException(ProviderException.Kind.UNAVAILABLE, mayHaveBilled);
        }
    }
}
