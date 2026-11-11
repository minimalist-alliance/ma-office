package com.minimalistalliance.desk.agent.provider.openrouter;

import static com.minimalistalliance.desk.agent.testing.FakeOpenRouter.chunk;
import static com.minimalistalliance.desk.agent.testing.FakeOpenRouter.data;
import static com.minimalistalliance.desk.agent.testing.FakeOpenRouter.done;
import static com.minimalistalliance.desk.agent.testing.FakeOpenRouter.usage;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.key.KeyLease;
import com.minimalistalliance.desk.agent.key.KeyRing;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.ChatResult;
import com.minimalistalliance.desk.agent.provider.ModelInfo;
import com.minimalistalliance.desk.agent.provider.ProviderException;
import com.minimalistalliance.desk.agent.provider.ProviderId;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.ToolSpec;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.provider.http.HttpTransport;
import com.minimalistalliance.desk.agent.testing.FakeOpenRouter;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** OpenRouter's Chat Completions and its key check and catalog, against the local stand-in. */
class OpenRouterProviderTest {

    private static final String FREE = "nvidia/nemotron-3.5-super-vl:free";
    private static final ChatRequest REQUEST = new ChatRequest(FREE, "Be brief.", List.of(ChatMessage.user("Hello?")),
            256);
    private static final List<ToolSpec> TOOLS = List.of(new ToolSpec("read_file", "Reads a file.",
            Map.of("type", "object", "properties", Map.of("path", Map.of("type", "string")))));

    private FakeOpenRouter server;
    private OpenRouterProvider openrouter;
    private final KeyRing keys = new KeyRing((action, target, decision) -> {});

    @BeforeEach
    void setUp() throws Exception {
        server = new FakeOpenRouter();
        HttpTransport http = new HttpTransport(
                new HttpTransport.Timeouts(Duration.ofSeconds(2), Duration.ofSeconds(5), Duration.ofMillis(400)), null);
        openrouter = new OpenRouterProvider(http, HttpTransport.baseUri(server.url()));
        keys.put("k1", ProviderId.OPENROUTER, FakeOpenRouter.KEY.getBytes(StandardCharsets.US_ASCII));
    }

    @AfterEach
    void tearDown() {
        server.close();
        keys.dropAll();
    }

    private ChatResult chat(ChatRequest request, List<String> deltas) throws Exception {
        try (KeyLease key = keys.lend("k1")) {
            return openrouter.chat(request, key, deltas::add);
        }
    }

    private ProviderException failure(ChatRequest request) {
        try (KeyLease key = keys.lend("k1")) {
            openrouter.chat(request, key, text -> {});
        } catch (ProviderException e) {
            return e;
        }
        throw new AssertionError("the call didn't fail");
    }

    @Test
    void itIsOpenRoutersOwnProviderWithItsKeyShape() {
        assertThat(openrouter.id()).isEqualTo(ProviderId.OPENROUTER);
        assertThat(openrouter.id().displayName()).isEqualTo("OpenRouter");
        assertThat(openrouter.info().console()).isEqualTo("openrouter.ai");
        // Longer than OpenAI's sk-, so an OpenRouter key picked as OpenAI's is refused before it leaves the desk.
        assertThat(openrouter.info().keyPrefix()).isEqualTo("sk-or-");
        assertThat(FakeOpenRouter.KEY).startsWith(openrouter.info().keyPrefix());
    }

    @Test
    void itStreamsAndCountsCachedInputApartAndTheCost() throws Exception {
        server.then(FakeOpenRouter.answer(FREE, 1000, 400, 50, "0", "Hi", " there."));
        List<String> deltas = new ArrayList<>();
        ChatResult result = chat(REQUEST, deltas);

        assertThat(deltas).containsExactly("Hi", " there.");
        assertThat(result.text()).isEqualTo("Hi there.");
        assertThat(result.model()).isEqualTo(FREE);
        assertThat(result.stopReason()).isEqualTo("completed");
        assertThat(result.usage()).isEqualTo(new Usage(600, 400, 0, 50, 0));
        assertThat(result.providerMicroUsd()).isZero();
        assertThat(result.toolCalls()).isEmpty();

        FakeOpenRouter.Request sent = server.requests.peek();
        assertThat(sent.method()).isEqualTo("POST");
        assertThat(sent.path()).isEqualTo("/api/v1/chat/completions");
        assertThat(sent.authorization()).isEqualTo("Bearer " + FakeOpenRouter.KEY);
        Map<String, Object> body = server.chatBodies().getFirst();
        assertThat(body).containsEntry("model", FREE).containsEntry("max_tokens", 256).containsEntry("stream", true)
                .doesNotContainKey("tools");
        assertThat(body.get("messages")).isEqualTo(List.of(
                Map.of("role", "system", "content", "Be brief."), Map.of("role", "user", "content", "Hello?")));
        // No tools asked for, so no catalog was needed.
        assertThat(server.requests).extracting(FakeOpenRouter.Request::path)
                .containsExactly("/api/v1/chat/completions");
    }

    @Test
    void aReportedCostIsKeptInMicroDollarsRoundedUp() throws Exception {
        server.then(FakeOpenRouter.answer("acme/paid-model", 10, 0, 5, "0.0000123", "ok"));
        assertThat(chat(new ChatRequest("acme/paid-model", "", List.of(ChatMessage.user("x")), 16), new ArrayList<>())
                .providerMicroUsd()).isEqualTo(13);
        assertThat(OpenRouterProvider.microUsd(0.5)).isEqualTo(500_000);
        assertThat(OpenRouterProvider.microUsd(-1)).isNull();
        assertThat(OpenRouterProvider.microUsd("1")).isNull();
        assertThat(OpenRouterProvider.microUsd(1e12)).isNull();
    }

    @Test
    void aStreamWithoutUsageCountsAsTheGatewayEstimates() throws Exception {
        server.then(FakeOpenRouter.Reply.events(chunk(FREE, "{\"content\":\"abcdef\"}", null),
                chunk(FREE, "{}", "stop"), done()));
        ChatResult result = chat(REQUEST, new ArrayList<>());
        assertThat(result.usage()).isEqualTo(new Usage(Math.ceilDiv(REQUEST.inputBytes(), 3), 0, 0, 2, 0));
        assertThat(result.providerMicroUsd()).isNull();
    }

    @Test
    void lengthIsTheOutputCap() throws Exception {
        server.then(FakeOpenRouter.Reply.events(chunk(FREE, "{\"content\":\"Cut\"}", null),
                usage(FREE, 5, 0, 256, "0", "length"), done()));
        assertThat(chat(REQUEST, new ArrayList<>()).stopReason()).isEqualTo("max_tokens");
        assertThat(OpenRouterProvider.stopReason("content_filter", false, 1, 10)).isEqualTo("refusal");
        assertThat(OpenRouterProvider.stopReason("stop", true, 10, 10)).isEqualTo("max_tokens");
        assertThat(OpenRouterProvider.stopReason(null, false, 1, 10)).isEqualTo("completed");
    }

    @Test
    void toolCallsStreamInPiecesAndTheirTurnsGoBack() throws Exception {
        server.then(FakeOpenRouter.Reply.events(
                chunk(FREE, "{\"content\":\"Let me look.\"}", null),
                chunk(FREE, "{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"type\":\"function\","
                        + "\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"pa\"}}]}", null),
                chunk(FREE, "{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"th\\\":\\\"a.txt\\\"}\"}}]}", null),
                chunk(FREE, "{\"tool_calls\":[{\"index\":1,\"id\":\"call_b\",\"function\":{\"name\":\"read_file\","
                        + "\"arguments\":\"\"}}]}", null),
                chunk(FREE, "{}", "tool_calls"), usage(FREE, 100, 0, 20, "0", "tool_calls"), done()));
        ChatRequest first = new ChatRequest(FREE, "", List.of(ChatMessage.user("Read a.txt")), 512, TOOLS);
        ChatResult result = chat(first, new ArrayList<>());

        assertThat(result.stopReason()).isEqualTo("tool_calls");
        assertThat(result.toolCalls()).extracting(ToolCall::id).containsExactly("call_a", "call_b");
        assertThat(result.toolCalls().get(0).input()).isEqualTo(Map.of("path", "a.txt"));
        assertThat(result.toolCalls().get(1).input()).isEmpty();
        Map<String, Object> body = server.chatBodies().getFirst();
        assertThat(body.get("tools")).isEqualTo(List.of(Map.of("type", "function", "function", Map.of(
                "name", "read_file", "description", "Reads a file.", "parameters", TOOLS.getFirst().inputSchema()))));

        ChatRequest next = new ChatRequest(FREE, "", List.of(ChatMessage.user("Read a.txt"),
                ChatMessage.toolCalls(result.text(), result.toolCalls()),
                ChatMessage.toolResults(List.of(new ToolResult("call_a", "hello", false),
                        new ToolResult("call_b", "no path", true)))), 512, TOOLS);
        chat(next, new ArrayList<>());
        List<?> messages = (List<?>) server.chatBodies().get(1).get("messages");
        assertThat(messages).hasSize(4);
        assertThat(messages.get(1)).isEqualTo(Map.of("role", "assistant", "content", "Let me look.", "tool_calls", List.of(
                Map.of("id", "call_a", "type", "function", "function", Map.of("name", "read_file",
                        "arguments", "{\"path\":\"a.txt\"}")),
                Map.of("id", "call_b", "type", "function", "function", Map.of("name", "read_file",
                        "arguments", "{}")))));
        assertThat(messages.get(2)).isEqualTo(Map.of("role", "tool", "tool_call_id", "call_a", "content", "hello"));
        assertThat(messages.get(3)).isEqualTo(Map.of("role", "tool", "tool_call_id", "call_b", "content", "no path"));
    }

    @Test
    void aCallWithoutAnIdGetsOneOfItsOwn() throws Exception {
        server.then(FakeOpenRouter.Reply.events(
                chunk(FREE, "{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]}",
                        null),
                usage(FREE, 1, 0, 1, "0", "tool_calls"), done()));
        ChatResult result = chat(new ChatRequest(FREE, "", List.of(ChatMessage.user("x")), 64, TOOLS),
                new ArrayList<>());
        assertThat(result.toolCalls()).extracting(ToolCall::id).containsExactly("call_0");
    }

    @Test
    void aModelWithoutToolsStillChatsAndIsToldItHasNone() throws Exception {
        String chatty = "acme/chatty:free";
        server.then(FakeOpenRouter.answer(chatty, 10, 0, 3, "0", "Just words."));
        ChatResult result = chat(new ChatRequest(chatty, "You are the lead.", List.of(ChatMessage.user("Hi")), 64,
                TOOLS), new ArrayList<>());

        assertThat(result.text()).isEqualTo("Just words.");
        Map<String, Object> body = server.chatBodies().getFirst();
        assertThat(body).doesNotContainKey("tools");
        assertThat(((List<?>) body.get("messages")).getFirst()).isEqualTo(Map.of("role", "system",
                "content", "You are the lead.\n\n" + OpenRouterProvider.NO_TOOLS));
        // The catalog said so, read once without the key.
        assertThat(server.requests).filteredOn(r -> r.path().equals("/api/v1/models")).singleElement()
                .satisfies(r -> assertThat(r.authorization()).isNull());
    }

    @Test
    void noToolTurnsGoToAModelWithoutTools() {
        List<Map<String, Object>> messages = ChatCompletions.messages("", List.of(ChatMessage.user("Read it"),
                ChatMessage.toolCalls("Looking.", List.of(new ToolCall("c1", "read_file", Map.of("path", "a")))),
                ChatMessage.toolResults(List.of(new ToolResult("c1", "secret", false)))), false);
        assertThat(messages).isEqualTo(List.of(Map.of("role", "user", "content", "Read it"),
                Map.of("role", "assistant", "content", "Looking."),
                Map.of("role", "user", "content", ChatCompletions.NO_RESULTS)));
    }

    @Test
    void toolsRefusedByEveryEndpointAreDroppedOnceAndRemembered() throws Exception {
        String tooly = "acme/tooly:free";
        server.then(FakeOpenRouter.Reply.error(404, "No endpoints found that support tool use. To learn more about"
                + " provider routing, visit: https://openrouter.ai/docs/provider-routing", Map.of()));
        server.then(FakeOpenRouter.answer(tooly, 10, 0, 3, "0", "Fine."));
        ChatRequest request = new ChatRequest(tooly, "", List.of(ChatMessage.user("Hi")), 64, TOOLS);
        assertThat(chat(request, new ArrayList<>()).text()).isEqualTo("Fine.");
        chat(request, new ArrayList<>());

        List<Map<String, Object>> bodies = server.chatBodies();
        assertThat(bodies).hasSize(3);
        assertThat(bodies.get(0)).containsKey("tools");
        assertThat(bodies.get(1)).doesNotContainKey("tools");
        assertThat(bodies.get(2)).doesNotContainKey("tools");
    }

    @Test
    void theFreeDailyLimitIsItsOwnKindAndCostsNothing() {
        ProviderException e = failure(scripted(FakeOpenRouter.Reply.error(429,
                "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
                Map.of("X-RateLimit-Limit", "50", "X-RateLimit-Remaining", "0"))));
        assertThat(e.kind()).isEqualTo(ProviderException.Kind.FREE_LIMIT);
        assertThat(e.mayHaveBilled()).isFalse();
        // Never OpenRouter's words.
        assertThat(e.getMessage()).isEqualTo("free_limit");
    }

    @Test
    void theDailyLimitIsKnownByItsHeadersTooButTheMinutesIsARateLimit() {
        assertThat(failure(scripted(FakeOpenRouter.Reply.error(429, "Rate limit exceeded",
                Map.of("X-RateLimit-Limit", "1000", "X-RateLimit-Remaining", "0")))).kind())
                .isEqualTo(ProviderException.Kind.FREE_LIMIT);
        assertThat(failure(scripted(FakeOpenRouter.Reply.error(429, "Rate limit exceeded: free-models-per-min.",
                Map.of("X-RateLimit-Limit", "20", "X-RateLimit-Remaining", "0")))).kind())
                .isEqualTo(ProviderException.Kind.RATE_LIMITED);
        // A paid model's 429 is a rate limit, whatever its headers.
        server.then(FakeOpenRouter.Reply.error(429, "Rate limit exceeded",
                Map.of("X-RateLimit-Limit", "1000", "X-RateLimit-Remaining", "0")));
        assertThat(failure(new ChatRequest("acme/paid-model", "", List.of(ChatMessage.user("x")), 16)).kind())
                .isEqualTo(ProviderException.Kind.RATE_LIMITED);
    }

    @Test
    void refusalsBeforeStreamingAreKindsAndNeverBilled() {
        Object[][] cases = {
                {401, "No auth credentials found", ProviderException.Kind.AUTH},
                {403, "Key disabled", ProviderException.Kind.AUTH},
                {403, "Your input was flagged by moderation", ProviderException.Kind.BAD_REQUEST},
                {402, "Insufficient credits", ProviderException.Kind.RATE_LIMITED},
                {404, "No endpoints found matching your data policy (Free model training). Configure:"
                        + " https://openrouter.ai/settings/privacy", ProviderException.Kind.DATA_POLICY},
                {404, "No endpoints found for acme/gone:free.", ProviderException.Kind.BAD_REQUEST},
                {400, "acme/x is not a valid model ID", ProviderException.Kind.BAD_REQUEST},
                {502, "Provider returned error", ProviderException.Kind.UNAVAILABLE},
                {503, "No available model provider", ProviderException.Kind.UNAVAILABLE},
                {408, "Timed out", ProviderException.Kind.TIMEOUT}};
        for (Object[] c : cases) {
            ProviderException e = failure(scripted(FakeOpenRouter.Reply.error((int) c[0], (String) c[1], Map.of())));
            assertThat(e.kind()).as(c[0] + " " + c[1]).isEqualTo(c[2]);
            assertThat(e.mayHaveBilled()).isFalse();
        }
    }

    @Test
    void anErrorInAStreamMayHaveBeenBilled() {
        ProviderException limit = failure(scripted(FakeOpenRouter.Reply.events(
                chunk(FREE, "{\"content\":\"Hi\"}", null),
                data("{\"error\":{\"code\":429,\"message\":\"Rate limit exceeded: free-models-per-day\"},"
                        + "\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"error\"}]}"))));
        assertThat(limit.kind()).isEqualTo(ProviderException.Kind.FREE_LIMIT);
        assertThat(limit.mayHaveBilled()).isTrue();

        ProviderException gone = failure(scripted(FakeOpenRouter.Reply.events(data(
                "{\"error\":{\"code\":\"server_error\",\"message\":\"Provider disconnected unexpectedly\"},"
                        + "\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"error\"}]}"))));
        assertThat(gone.kind()).isEqualTo(ProviderException.Kind.UNAVAILABLE);
        assertThat(gone.mayHaveBilled()).isTrue();
    }

    @Test
    void aStreamCutBeforeItsFinishIsUnavailableAndMayHaveBeenBilled() {
        ProviderException e = failure(scripted(FakeOpenRouter.answer(FREE, 1, 0, 1, "0", "a", "b").cutAfter(2)));
        assertThat(e.kind()).isEqualTo(ProviderException.Kind.UNAVAILABLE);
        assertThat(e.mayHaveBilled()).isTrue();
    }

    @Test
    void theModelListIsTheFreeModelsWithThePicksFirst() throws Exception {
        List<ModelInfo> models;
        try (KeyLease key = keys.lend("k1")) {
            models = openrouter.models(key);
        }
        assertThat(models).extracting(ModelInfo::id).containsExactly(
                "nvidia/nemotron-3.5-super-vl:free", "cohere/north-mini-code:free", "openrouter/free",
                "acme/tooly:free", "acme/chatty:free");
        assertThat(models.getFirst()).isEqualTo(new ModelInfo("nvidia/nemotron-3.5-super-vl:free",
                "NVIDIA: Nemotron 3.5 Super VL (free)", true));
        assertThat(models).filteredOn(m -> m.id().equals("acme/chatty:free")).singleElement()
                .satisfies(m -> assertThat(m.tools()).isFalse());
        // The key was checked on its own endpoint; the catalog is public and went without it.
        assertThat(server.requests).extracting(FakeOpenRouter.Request::path)
                .containsExactly("/api/v1/key", "/api/v1/models");
        assertThat(server.requests.peek().authorization()).isEqualTo("Bearer " + FakeOpenRouter.KEY);
    }

    @Test
    void theCatalogFollowsItsPagesOnItsOwnHostOnly() throws Exception {
        server.catalog.set(0, FakeOpenRouter.catalog("/api/v1/models?offset=1",
                FakeOpenRouter.model("acme/one:free", "One", true)));
        server.catalog.add(FakeOpenRouter.catalog("https://elsewhere.example/api/v1/models?offset=2",
                FakeOpenRouter.model("acme/two:free", "Two", false)));
        try (KeyLease key = keys.lend("k1")) {
            assertThat(openrouter.models(key)).extracting(ModelInfo::id).containsExactly("acme/one:free",
                    "acme/two:free");
        }
        assertThat(server.requests).filteredOn(r -> r.path().equals("/api/v1/models")).hasSize(2);
    }

    @Test
    void anEmptyCatalogStillListsTheFreeRouter() throws Exception {
        server.catalog.set(0, FakeOpenRouter.catalog(null, FakeOpenRouter.model("acme/paid", "Paid", true)));
        try (KeyLease key = keys.lend("k1")) {
            assertThat(openrouter.models(key)).extracting(ModelInfo::id).containsExactly("openrouter/free");
        }
    }

    @Test
    void aRefusedKeyAManagementKeyAndADownCatalog() throws Exception {
        server.acceptedKey = "sk-or-v1-someone-else";
        assertThatThrownBy(this::models).isInstanceOfSatisfying(ProviderException.class,
                e -> assertThat(e.kind()).isEqualTo(ProviderException.Kind.AUTH));

        server.acceptedKey = FakeOpenRouter.KEY;
        server.keyData = "{\"label\":\"admin\",\"is_management_key\":true}";
        assertThatThrownBy(this::models).isInstanceOfSatisfying(ProviderException.class,
                e -> assertThat(e.kind()).isEqualTo(ProviderException.Kind.AUTH));

        server.keyData = "{\"label\":\"fine\",\"is_management_key\":false}";
        server.catalogStatus = 401;
        // A public list's refusal says nothing about the key.
        assertThatThrownBy(this::models).isInstanceOfSatisfying(ProviderException.class, e -> {
            assertThat(e.kind()).isEqualTo(ProviderException.Kind.UNAVAILABLE);
            assertThat(e.mayHaveBilled()).isFalse();
        });
    }

    @Test
    void labelsAreCleanedAndCapped() {
        assertThat(OpenRouterProvider.label("Acme‮: Odd\u0007", "acme/odd")).isEqualTo("Acme: Odd");
        assertThat(OpenRouterProvider.label(null, "acme/odd")).isEqualTo("acme/odd");
        assertThat(OpenRouterProvider.label("x".repeat(200), "acme/odd")).hasSize(OpenRouterProvider.MAX_LABEL);
    }

    private List<ModelInfo> models() throws ProviderException {
        try (KeyLease key = keys.lend("k1")) {
            return openrouter.models(key);
        }
    }

    /** {@link #REQUEST}, after scripting the stand-in's answer to it. */
    private ChatRequest scripted(FakeOpenRouter.Reply reply) {
        server.then(reply);
        return REQUEST;
    }
}
