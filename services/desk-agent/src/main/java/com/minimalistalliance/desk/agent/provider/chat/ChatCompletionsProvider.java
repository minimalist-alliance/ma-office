package com.minimalistalliance.desk.agent.provider.chat;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.key.KeyLease;
import com.minimalistalliance.desk.agent.provider.ChatProvider;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.ChatResult;
import com.minimalistalliance.desk.agent.provider.DeltaSink;
import com.minimalistalliance.desk.agent.provider.ModelInfo;
import com.minimalistalliance.desk.agent.provider.ProviderException;
import com.minimalistalliance.desk.agent.provider.ProviderId;
import com.minimalistalliance.desk.agent.provider.ProviderInfo;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.provider.http.HttpTransport;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpRequest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A provider's own OpenAI-compatible Chat Completions API, streamed, with the member's own key: Google's Gemini
 * ({@code https://generativelanguage.googleapis.com/v1beta/openai}, keys from AI Studio, {@code AIza...}) and Moonshot
 * AI's Kimi ({@code https://api.moonshot.ai/v1}, keys from the Kimi API Platform, {@code sk-...}). One class, with each
 * provider's base URL, key prefix and {@link ChatCompletions.Dialect}; the thread and the stream are
 * {@link ChatCompletions}', which OpenRouter's adapter shares.
 *
 * <p><b>Chat:</b> {@code POST {base}/chat/completions} with {@code stream: true} and
 * {@code stream_options: {include_usage: true}}, so usage comes in the last chunk. The output cap is {@code max_tokens}
 * for Gemini and {@code max_completion_tokens} for Moonshot, whose {@code max_tokens} is deprecated. No reasoning effort
 * is sent: both providers' current models think by default, at their own default, and some refuse a level they don't
 * have. As a step may think for minutes before its first byte, the stream may be quiet for {@link #THINKING_IDLE}.
 * Gemini's thought signatures and Moonshot's {@code reasoning_content} go back on the next step ({@link
 * ChatCompletions.Dialect}). Moonshot checks a tool's schema strictly by default, so each tool says {@code strict:
 * false}.
 *
 * <p><b>The key check and the model list</b> are {@code GET {base}/models} with the key, which both providers answer only
 * for a good key: 401 or 403 is {@code AUTH}, and so is Gemini's 400 for a key it doesn't know. Gemini may name a model
 * {@code models/gemini-...}; the chat endpoint takes it without {@code models/}, so it's listed so. Models that don't
 * chat (embeddings, speech, live audio, pictures, video) are left out, and the provider's newest family is listed first
 * ({@code gemini-4...}, {@code kimi-k3.1...}), previews after, so a client's first entry is a sensible default. None is
 * in the price table yet, so each counts at the table's highest price (ADR 0043).
 *
 * <p><b>Errors</b> are kinds, never the provider's words: an error body is read only to classify it, at most 64 KiB,
 * and kept nowhere. The key is in the {@code authorization} header only, never in a URL, a log or an exception.
 */
public final class ChatCompletionsProvider implements ChatProvider {

    public static final ProviderInfo GOOGLE = new ProviderInfo(ProviderId.GOOGLE, "aistudio.google.com", "AIza");
    public static final ProviderInfo MOONSHOT = new ProviderInfo(ProviderId.MOONSHOT, "platform.kimi.ai", "sk-");

    /** Google's documented stand-in signature, for a call in the turn that has none of its own. */
    static final String SKIP_SIGNATURE = "skip_thought_signature_validator";

    static final ChatCompletions.Dialect GOOGLE_DIALECT =
            new ChatCompletions.Dialect(ProviderId.GOOGLE.id(), true, false, SKIP_SIGNATURE, false, false);
    static final ChatCompletions.Dialect MOONSHOT_DIALECT =
            new ChatCompletions.Dialect(ProviderId.MOONSHOT.id(), false, true, null, true, true);

    /** How long a step may stream nothing: the model is thinking, not stuck. */
    static final Duration THINKING_IDLE = Duration.ofMinutes(10);
    static final int MAX_LIST_BYTES = 4 << 20;
    static final int MAX_MODELS = 512;

    private static final Pattern MODEL = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}");
    /** A word in a model's id that says it doesn't chat. */
    private static final Pattern NOT_CHAT = Pattern.compile(
            "(?:^|[-/._])(?:embedding|embed|tts|audio|live|imagen|image|veo|aqa|robotics|computer-use|lyria)(?:[-/._]|$)");
    private static final Pattern PREVIEW = Pattern.compile("(?:^|[-._])(?:preview|exp|experimental)(?:[-._]|$)");

    /** One provider's settings: its info, its dialect, its output cap's field, and its families' ids by version. */
    record Config(ProviderInfo info, ChatCompletions.Dialect dialect, String maxTokens, Pattern family) {}

    static final Config GOOGLE_CONFIG =
            new Config(GOOGLE, GOOGLE_DIALECT, "max_tokens", Pattern.compile("^gemini-(\\d+(?:\\.\\d+)*)"));
    static final Config MOONSHOT_CONFIG =
            new Config(MOONSHOT, MOONSHOT_DIALECT, "max_completion_tokens", Pattern.compile("^kimi-k(\\d+(?:\\.\\d+)*)"));

    private final Config config;
    private final HttpTransport http;
    private final URI base;

    ChatCompletionsProvider(Config config, HttpTransport http, URI base) {
        this.config = config;
        this.http = http;
        this.base = base;
    }

    /** Google's Gemini, on its OpenAI-compatible endpoint; {@code base} is that endpoint, {@code .../v1beta/openai}. */
    public static ChatCompletionsProvider google(HttpTransport http, URI base) {
        return new ChatCompletionsProvider(GOOGLE_CONFIG, http, base);
    }

    /** Moonshot AI's Kimi; {@code base} is {@code https://api.moonshot.ai/v1}. */
    public static ChatCompletionsProvider moonshot(HttpTransport http, URI base) {
        return new ChatCompletionsProvider(MOONSHOT_CONFIG, http, base);
    }

    @Override
    public ProviderInfo info() {
        return config.info();
    }

    // ---------------------------------------------------------------- chat

    @Override
    public ChatResult chat(ChatRequest request, KeyLease key, DeltaSink sink) throws ProviderException {
        boolean tools = !request.tools().isEmpty();
        ChatCompletions.Dialect dialect = config.dialect();
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("model", request.model());
        body.put("messages", ChatCompletions.messages(request.system(), request.messagesWithNote(), tools, dialect));
        if (tools) {
            body.put("tools", ChatCompletions.tools(request.tools(), dialect));
        }
        body.put(config.maxTokens(), request.maxOutputTokens());
        body.put("stream", true);
        body.put("stream_options", Map.of("include_usage", true));
        HttpRequest httpRequest = http.request(api("/chat/completions"))
                .header("authorization", key.headerValue("Bearer "))
                .header("content-type", "application/json")
                .header("accept", "text/event-stream")
                .POST(HttpRequest.BodyPublishers.ofByteArray(Json.bytes(body)))
                .build();
        try (HttpTransport.Stream stream = http.open(httpRequest)) {
            if (stream.status() / 100 != 2) {
                throw refusal(stream.status(), ChatCompletions.errorBody(stream));
            }
            stream.idle(THINKING_IDLE);
            ChatCompletions.Streamed read = ChatCompletions.read(stream, request, sink, tools, dialect,
                    ChatCompletions::streamError, ChatCompletionsProvider::shown);
            Usage used = read.usage() != null ? ChatCompletions.usage(read.usage())
                    : ChatCompletions.estimate(request, read.outputBytes());
            // Gemini may finish a step of calls with "stop".
            String finish = !read.calls().isEmpty() && (read.finish() == null || read.finish().equals("stop"))
                    ? "tool_calls" : read.finish();
            return new ChatResult(read.text(), used, read.model(), ChatCompletions.stopReason(finish,
                    read.text().isEmpty() && read.calls().isEmpty(), used.outputTokens(), request.maxOutputTokens()),
                    read.calls());
        }
    }

    /**
     * An HTTP refusal, before anything was generated, so none is billed: 401 and 403 are the key, and so is a 400 whose
     * words say so (Gemini's {@code API_KEY_INVALID}); 402, out of credit, is {@code RATE_LIMITED}; the rest by status.
     */
    static ProviderException refusal(int status, Map<String, Object> error) {
        ProviderException.Kind kind;
        if (status == 401 || status == 403 || (status == 400 && ChatCompletions.aboutKey(error))) {
            kind = ProviderException.Kind.AUTH;
        } else if (status == 402) {
            kind = ProviderException.Kind.RATE_LIMITED;
        } else {
            kind = HttpTransport.statusError(status).kind();
        }
        return new ProviderException(kind, false);
    }

    /** The model a chunk names, as the chat endpoint takes it, or null to keep the one asked for. */
    static String shown(String named) {
        String id = named != null && named.startsWith("models/") ? named.substring(7) : named;
        return id != null && MODEL.matcher(id).matches() ? id : null;
    }

    // ---------------------------------------------------------------- models and the key check

    @Override
    public List<ModelInfo> models(KeyLease key) throws ProviderException {
        HttpRequest request = http.request(api("/models"))
                .header("authorization", key.headerValue("Bearer "))
                .GET()
                .build();
        Map<String, Object> list;
        try (HttpTransport.Stream stream = http.open(request)) {
            if (stream.status() / 100 != 2) {
                throw refusal(stream.status(), ChatCompletions.errorBody(stream));
            }
            byte[] read = stream.readNBytes(MAX_LIST_BYTES + 1);
            if (read.length > MAX_LIST_BYTES) {
                throw new ProviderException(ProviderException.Kind.UNAVAILABLE, false);
            }
            list = ChatCompletions.parse(read, false);
        } catch (IOException e) {
            throw new ProviderException(ProviderException.Kind.UNAVAILABLE, false);
        }
        Set<String> ids = new LinkedHashSet<>();
        if (list.get("data") instanceof List<?> data) {
            for (Object item : data) {
                if (item instanceof Map<?, ?> model && model.get("id") instanceof String named) {
                    String id = shown(named);
                    if (id != null && !NOT_CHAT.matcher(id.toLowerCase(java.util.Locale.ROOT)).find()
                            && ids.size() < MAX_MODELS) {
                        ids.add(id);
                    }
                }
            }
        }
        List<String> ordered = new ArrayList<>(ids);
        ordered.sort(byFamily(config.family()));
        List<ModelInfo> models = new ArrayList<>();
        for (String id : ordered) {
            models.add(new ModelInfo(id, id));
        }
        return models;
    }

    /**
     * The provider's family first, newest version first, a preview after the release of its version; then the rest in
     * the provider's own order. The sort is stable, so ties keep the provider's order.
     */
    static Comparator<String> byFamily(Pattern family) {
        return (a, b) -> {
            int[] va = version(family, a);
            int[] vb = version(family, b);
            if (va == null || vb == null) {
                return va == null ? (vb == null ? 0 : 1) : -1;
            }
            for (int i = 0; i < Math.max(va.length, vb.length); i++) {
                int x = i < va.length ? va[i] : 0;
                int y = i < vb.length ? vb[i] : 0;
                if (x != y) {
                    return Integer.compare(y, x);
                }
            }
            return Boolean.compare(PREVIEW.matcher(a).find(), PREVIEW.matcher(b).find());
        };
    }

    private static int[] version(Pattern family, String id) {
        Matcher m = family.matcher(id);
        if (!m.find()) {
            return null;
        }
        String[] parts = m.group(1).split("\\.");
        int[] out = new int[Math.min(parts.length, 4)];
        for (int i = 0; i < out.length; i++) {
            try {
                out[i] = Integer.parseInt(parts[i].length() > 6 ? parts[i].substring(0, 6) : parts[i]);
            } catch (NumberFormatException e) {
                out[i] = 0;
            }
        }
        return out;
    }

    private URI api(String path) {
        return base.resolve(base.getPath() + path);
    }
}
