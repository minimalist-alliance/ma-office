package com.minimalistalliance.desk.agent.provider.chat;

import static com.minimalistalliance.desk.agent.testing.FakeOpenRouter.chunk;
import static com.minimalistalliance.desk.agent.testing.FakeOpenRouter.data;
import static com.minimalistalliance.desk.agent.testing.FakeOpenRouter.done;
import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.attach.Vision;
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
import com.minimalistalliance.desk.agent.provider.http.Messages;
import com.minimalistalliance.desk.agent.testing.FakeChatServer;
import com.minimalistalliance.desk.agent.testing.FakeOpenRouter;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/** Gemini's and Moonshot's own Chat Completions, their key check and their model lists, against a local stand-in. */
class ChatCompletionsProviderTest {

    private static final List<ToolSpec> TOOLS = List.of(new ToolSpec("read_file", "Reads a file.",
            Map.of("type", "object", "properties", Map.of("path", Map.of("type", "string")))));
    private static final String SIGNATURE = "c2lnbmVkLXJlYXNvbmluZw==";

    private final KeyRing keys = new KeyRing((action, target, decision) -> {});
    private final HttpTransport http = new HttpTransport(
            new HttpTransport.Timeouts(Duration.ofSeconds(2), Duration.ofSeconds(5), Duration.ofMillis(400)), null);
    private FakeChatServer server;
    private ChatCompletionsProvider provider;

    private void google() throws Exception {
        server = new FakeChatServer("/v1beta/openai", FakeChatServer.GOOGLE_KEY);
        provider = ChatCompletionsProvider.google(http, HttpTransport.baseUri(server.url()));
        keys.put("k1", ProviderId.GOOGLE, FakeChatServer.GOOGLE_KEY.getBytes(StandardCharsets.US_ASCII));
    }

    private void moonshot() throws Exception {
        server = new FakeChatServer("/v1", FakeChatServer.MOONSHOT_KEY);
        provider = ChatCompletionsProvider.moonshot(http, HttpTransport.baseUri(server.url()));
        keys.put("k1", ProviderId.MOONSHOT, FakeChatServer.MOONSHOT_KEY.getBytes(StandardCharsets.US_ASCII));
    }

    @AfterEach
    void tearDown() {
        if (server != null) {
            server.close();
        }
        keys.dropAll();
    }

    private ChatResult chat(ChatRequest request, List<String> deltas) throws Exception {
        try (KeyLease key = keys.lend("k1")) {
            return provider.chat(request, key, deltas::add);
        }
    }

    private ProviderException chatFailure(ChatRequest request) {
        try (KeyLease key = keys.lend("k1")) {
            provider.chat(request, key, text -> {});
        } catch (ProviderException e) {
            return e;
        }
        throw new AssertionError("the call didn't fail");
    }

    private ProviderException modelsFailure() {
        try (KeyLease key = keys.lend("k1")) {
            provider.models(key);
        } catch (ProviderException e) {
            return e;
        }
        throw new AssertionError("the key check didn't fail");
    }

    private List<ModelInfo> models() throws Exception {
        try (KeyLease key = keys.lend("k1")) {
            return provider.models(key);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        return (Map<String, Object>) value;
    }

    @Test
    void eachIsItsOwnProviderWithItsKeyShape() throws Exception {
        google();
        assertThat(provider.id()).isEqualTo(ProviderId.GOOGLE);
        assertThat(provider.id().displayName()).isEqualTo("Google");
        assertThat(provider.info().console()).isEqualTo("aistudio.google.com");
        assertThat(provider.info().keyPrefix()).isEqualTo("AIza");
        assertThat(FakeChatServer.GOOGLE_KEY).startsWith(provider.info().keyPrefix());
        ChatCompletionsProvider kimi = ChatCompletionsProvider.moonshot(http, HttpTransport.baseUri(server.url()));
        assertThat(kimi.id()).isEqualTo(ProviderId.MOONSHOT);
        assertThat(kimi.id().id()).isEqualTo("moonshot");
        assertThat(kimi.id().displayName()).isEqualTo("Moonshot AI");
        assertThat(kimi.info().console()).isEqualTo("platform.kimi.ai");
        assertThat(kimi.info().keyPrefix()).isEqualTo("sk-");
    }

    @Test
    void geminiStreamsAsksForUsageAndCountsItsThinkingAsOutput() throws Exception {
        google();
        String model = "gemini-3.8-flash";
        // Gemini counts its thinking in total_tokens and not in completion_tokens.
        server.then(new FakeOpenRouter.Reply(200, Map.of(), null, List.of(
                chunk(model, "{\"role\":\"assistant\",\"content\":\"Hi\"}", null),
                chunk(model, "{\"content\":\" there.\"}", "stop"),
                FakeChatServer.usage(model, "\"prompt_tokens\":1000,\"completion_tokens\":50,\"total_tokens\":1130,"
                        + "\"prompt_tokens_details\":{\"cached_tokens\":400}"),
                done()), -1));
        List<String> deltas = new ArrayList<>();
        ChatResult result = chat(new ChatRequest(model, "Be brief.", List.of(ChatMessage.user("Hello?")), 256), deltas);

        assertThat(deltas).containsExactly("Hi", " there.");
        assertThat(result.text()).isEqualTo("Hi there.");
        assertThat(result.model()).isEqualTo(model);
        assertThat(result.stopReason()).isEqualTo("completed");
        assertThat(result.usage()).isEqualTo(new Usage(600, 400, 0, 130, 0));
        assertThat(result.providerMicroUsd()).isNull();

        FakeOpenRouter.Request sent = server.requests.peek();
        assertThat(sent.method()).isEqualTo("POST");
        assertThat(sent.path()).isEqualTo("/v1beta/openai/chat/completions");
        assertThat(sent.authorization()).isEqualTo("Bearer " + FakeChatServer.GOOGLE_KEY);
        Map<String, Object> body = server.chatBodies().getFirst();
        assertThat(body).containsEntry("model", model).containsEntry("max_tokens", 256).containsEntry("stream", true)
                .containsEntry("stream_options", Map.of("include_usage", true))
                .doesNotContainKeys("tools", "max_completion_tokens", "reasoning_effort");
        assertThat(body.get("messages")).isEqualTo(List.of(
                Map.of("role", "system", "content", "Be brief."), Map.of("role", "user", "content", "Hello?")));
    }

    @Test
    void geminiCallsComeWholeWithoutIndexAndTheirSignatureGoesBackOnTheNextStep() throws Exception {
        google();
        String model = "gemini-4-argon";
        // Two calls in one chunk, no index and no ids, the signature on the first only, and the step says "stop".
        server.then(new FakeOpenRouter.Reply(200, Map.of(), null, List.of(
                chunk("models/" + model, "{\"role\":\"assistant\",\"tool_calls\":["
                        + "{\"id\":\"\",\"type\":\"function\",\"function\":{\"name\":\"read_file\","
                        + "\"arguments\":\"{\\\"path\\\":\\\"a.txt\\\"}\"},\"extra_content\":{\"google\":"
                        + "{\"thought_signature\":\"" + SIGNATURE + "\"}}},"
                        + "{\"id\":\"\",\"type\":\"function\",\"function\":{\"name\":\"read_file\","
                        + "\"arguments\":\"{\\\"path\\\":\\\"b.txt\\\"}\"}}]}", "stop"),
                FakeChatServer.usage(model, "\"prompt_tokens\":20,\"completion_tokens\":12,\"total_tokens\":40,"
                        + "\"completion_tokens_details\":{\"reasoning_tokens\":8}"),
                done()), -1));
        ChatRequest first = new ChatRequest(model, "", List.of(ChatMessage.user("Read both")), 512, TOOLS);
        ChatResult result = chat(first, new ArrayList<>());

        assertThat(result.stopReason()).isEqualTo("tool_calls");
        assertThat(result.model()).isEqualTo(model);
        assertThat(result.usage()).isEqualTo(new Usage(20, 0, 0, 20, 8));
        assertThat(result.toolCalls()).extracting(ToolCall::id).containsExactly("call_0", "call_1");
        assertThat(result.toolCalls()).extracting(ToolCall::input)
                .containsExactly(Map.of("path", "a.txt"), Map.of("path", "b.txt"));
        assertThat(result.toolCalls().get(0).reasoning()).singleElement().satisfies(item -> assertThat(item)
                .containsEntry("type", ChatCompletions.EXTRA).containsEntry("provider", "google")
                .containsEntry("extra_content", Map.of("google", Map.of("thought_signature", SIGNATURE))));
        assertThat(result.toolCalls().get(1).reasoning()).isEmpty();
        Map<String, Object> body = server.chatBodies().getFirst();
        assertThat(body.get("tools")).isEqualTo(List.of(Map.of("type", "function", "function", Map.of(
                "name", "read_file", "description", "Reads a file.", "parameters", TOOLS.getFirst().inputSchema()))));

        // The next step sends the signature back on the call it came with, and nothing on the other.
        server.then(FakeChatServer.answer(model, 30, 3, "Done."));
        ChatRequest second = new ChatRequest(model, "", List.of(ChatMessage.user("Read both"),
                ChatMessage.toolCalls("", result.toolCalls()),
                ChatMessage.toolResults(List.of(new ToolResult("call_0", "A", false),
                        new ToolResult("call_1", "B", false)))), 512, TOOLS);
        assertThat(chat(second, new ArrayList<>()).text()).isEqualTo("Done.");
        List<?> messages = (List<?>) server.chatBodies().getLast().get("messages");
        Map<?, ?> turn = (Map<?, ?>) messages.get(1);
        assertThat(turn.get("role")).isEqualTo("assistant");
        assertThat(turn.containsKey("content")).isTrue();
        assertThat(turn.get("content")).isNull();
        List<?> calls = (List<?>) turn.get("tool_calls");
        assertThat(((Map<?, ?>) calls.get(0)).get("extra_content"))
                .isEqualTo(Map.of("google", Map.of("thought_signature", SIGNATURE)));
        assertThat(map(calls.get(1))).doesNotContainKey("extra_content");
        assertThat(messages.get(2)).isEqualTo(Map.of("role", "tool", "tool_call_id", "call_0", "content", "A"));
    }

    @Test
    void aGeminiCallWithNoSignatureOfItsOwnGetsGooglesStandIn() throws Exception {
        google();
        server.then(FakeChatServer.answer("gemini-4-argon", 30, 3, "Ok."));
        chat(new ChatRequest("gemini-4-argon", "", List.of(ChatMessage.user("Go"),
                ChatMessage.toolCalls("Reading.", List.of(new ToolCall("c1", "read_file", Map.of("path", "a")),
                        new ToolCall("c2", "read_file", Map.of("path", "b")))),
                ChatMessage.toolResults(List.of(new ToolResult("c1", "A", false), new ToolResult("c2", "B", false)))),
                64, TOOLS), new ArrayList<>());
        Map<?, ?> turn = (Map<?, ?>) ((List<?>) server.chatBodies().getLast().get("messages")).get(1);
        assertThat(turn.get("content")).isEqualTo("Reading.");
        List<?> calls = (List<?>) turn.get("tool_calls");
        assertThat(((Map<?, ?>) calls.get(0)).get("extra_content")).isEqualTo(
                Map.of("google", Map.of("thought_signature", ChatCompletionsProvider.SKIP_SIGNATURE)));
        assertThat(map(calls.get(1))).doesNotContainKey("extra_content");
    }

    @Test
    void moonshotKeepsItsReasoningForTheNextStepAndCountsTopLevelCachedTokens() throws Exception {
        moonshot();
        String model = "kimi-k3.1-pro";
        server.then(new FakeOpenRouter.Reply(200, Map.of(), null, List.of(
                chunk(model, "{\"role\":\"assistant\",\"reasoning_content\":\"Need the \"}", null),
                chunk(model, "{\"reasoning_content\":\"file.\"}", null),
                chunk(model, "{\"tool_calls\":[{\"index\":0,\"id\":\"read_file:0\",\"type\":\"function\","
                        + "\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"pa\"}}]}", null),
                chunk(model, "{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"th\\\":\\\"a\\\"}\"}}]}",
                        "tool_calls"),
                FakeChatServer.usage(model, "\"prompt_tokens\":900,\"completion_tokens\":40,\"total_tokens\":940,"
                        + "\"cached_tokens\":512"),
                done()), -1));
        ChatResult result = chat(new ChatRequest(model, "Lead.", List.of(ChatMessage.user("Read a")), 1024, TOOLS),
                new ArrayList<>());

        assertThat(result.text()).isEmpty();
        assertThat(result.stopReason()).isEqualTo("tool_calls");
        assertThat(result.usage()).isEqualTo(new Usage(388, 512, 0, 40, 0));
        ToolCall call = result.toolCalls().getFirst();
        assertThat(call.id()).isEqualTo("read_file:0");
        assertThat(call.input()).isEqualTo(Map.of("path", "a"));
        assertThat(call.reasoning()).singleElement().satisfies(item -> assertThat(item)
                .containsEntry("provider", "moonshot").containsEntry("reasoning_content", "Need the file.")
                .doesNotContainKey("extra_content"));
        Map<String, Object> body = server.chatBodies().getFirst();
        assertThat(server.requests.peek().path()).isEqualTo("/v1/chat/completions");
        assertThat(body).containsEntry("max_completion_tokens", 1024).doesNotContainKey("max_tokens")
                .containsEntry("stream_options", Map.of("include_usage", true));
        assertThat(body.get("tools")).isEqualTo(List.of(Map.of("type", "function", "function", Map.of(
                "name", "read_file", "description", "Reads a file.", "parameters", TOOLS.getFirst().inputSchema(),
                "strict", false))));

        server.then(FakeChatServer.answer(model, 950, 5, "It says A."));
        chat(new ChatRequest(model, "Lead.", List.of(ChatMessage.user("Read a"), ChatMessage.toolCalls("",
                result.toolCalls()), ChatMessage.toolResults(List.of(new ToolResult("read_file:0", "A", false)))),
                1024, TOOLS), new ArrayList<>());
        Map<?, ?> turn = (Map<?, ?>) ((List<?>) server.chatBodies().getLast().get("messages")).get(2);
        assertThat(turn.get("role")).isEqualTo("assistant");
        // Moonshot's own examples send "" with calls, and its reasoning back as it came.
        assertThat(turn.get("content")).isEqualTo("");
        assertThat(turn.get("reasoning_content")).isEqualTo("Need the file.");
        assertThat(map(((List<?>) turn.get("tool_calls")).getFirst())).doesNotContainKey("extra_content");
    }

    @Test
    void whatOneProviderKeptGoesToNoOther() throws Exception {
        moonshot();
        ToolCall signed = new ToolCall("c1", "read_file", Map.of()).withReasoning(List.of(Map.of(
                "type", ChatCompletions.EXTRA, "provider", "google",
                "extra_content", Map.of("google", Map.of("thought_signature", SIGNATURE)),
                "reasoning_content", "secret thoughts")));
        List<ChatMessage> thread = List.of(ChatMessage.user("Go"), ChatMessage.toolCalls("", List.of(signed)),
                ChatMessage.toolResults(List.of(new ToolResult("c1", "A", false))));
        Map<String, Object> turn = ChatCompletions.messages("", thread, true, ChatCompletionsProvider.MOONSHOT_DIALECT)
                .get(1);
        assertThat(turn).doesNotContainKey("reasoning_content");
        assertThat(map(((List<?>) turn.get("tool_calls")).getFirst())).doesNotContainKey("extra_content");
        // OpenRouter's plain dialect sends none of it either, and the Responses API's adapter skips the item.
        Map<String, Object> plain = ChatCompletions.messages("", thread, true).get(1);
        assertThat(map(((List<?>) plain.get("tool_calls")).getFirst())).doesNotContainKey("extra_content");
        assertThat(Messages.responses(thread)).noneSatisfy(item -> assertThat(item.get("type"))
                .isEqualTo(ChatCompletions.EXTRA));
        assertThat(Messages.responses(thread).toString()).doesNotContain("secret thoughts");
    }

    @Test
    void moonshotsOlderStreamsPutUsageOnTheChoice() throws Exception {
        moonshot();
        server.then(new FakeOpenRouter.Reply(200, Map.of(), null, List.of(
                chunk("kimi-k3", "{\"content\":\"Ok\"}", null),
                data("{\"id\":\"c\",\"model\":\"kimi-k3\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":"
                        + "\"stop\",\"usage\":{\"prompt_tokens\":19,\"completion_tokens\":13,\"total_tokens\":32}}]}"),
                done()), -1));
        assertThat(chat(new ChatRequest("kimi-k3", "", List.of(ChatMessage.user("x")), 64), new ArrayList<>()).usage())
                .isEqualTo(new Usage(19, 0, 0, 13, 0));
    }

    @Test
    void theKeyCheckListsGeminisChatModelsNewestFirstWithoutTheirModelsPrefix() throws Exception {
        google();
        server.models = FakeChatServer.list("models/embedding-001", "models/gemini-2.5-flash",
                "models/gemini-3.8-flash", "models/gemini-4-carbon-preview", "models/gemini-embedding-001",
                "models/gemini-4-argon", "models/imagen-4.0-generate-001", "models/veo-3.0-generate-001",
                "models/gemini-2.5-flash-preview-tts", "models/gemini-2.5-flash-image", "models/gemini-live-2.5-flash",
                "models/gemma-3-27b-it", "models/aqa", "models/gemini-4-argon", "models/bad id");
        List<ModelInfo> models = models();
        assertThat(models).extracting(ModelInfo::id).containsExactly("gemini-4-argon", "gemini-4-carbon-preview",
                "gemini-3.8-flash", "gemini-2.5-flash", "gemma-3-27b-it");
        assertThat(models).allSatisfy(m -> {
            assertThat(m.label()).isEqualTo(m.id());
            assertThat(m.tools()).isTrue();
        });
        FakeOpenRouter.Request sent = server.requests.peek();
        assertThat(sent.method()).isEqualTo("GET");
        assertThat(sent.path()).isEqualTo("/v1beta/openai/models");
        assertThat(sent.authorization()).isEqualTo("Bearer " + FakeChatServer.GOOGLE_KEY);
        assertThat(sent.query()).isNull();
    }

    @Test
    void theKeyCheckListsKimiFirst() throws Exception {
        moonshot();
        server.models = FakeChatServer.list("moonshot-v1-8k", "kimi-k2.6", "kimi-k3", "kimi-k3.1-pro",
                "kimi-k3.1-pro-highspeed");
        assertThat(models()).extracting(ModelInfo::id).containsExactly("kimi-k3.1-pro", "kimi-k3.1-pro-highspeed",
                "kimi-k3", "kimi-k2.6", "moonshot-v1-8k");
        assertThat(server.requests.peek().path()).isEqualTo("/v1/models");
    }

    @Test
    void aRefusedKeyIsAuthAndNeverInTheError() throws Exception {
        moonshot();
        server.acceptedKey = "sk-someone-else-entirely-0123456789";
        ProviderException refused = modelsFailure();
        assertThat(refused.kind()).isEqualTo(ProviderException.Kind.AUTH);
        assertThat(refused.mayHaveBilled()).isFalse();
        assertThat(String.valueOf(refused.getMessage())).doesNotContain(FakeChatServer.MOONSHOT_KEY)
                .doesNotContain("Invalid Authentication");
        ProviderException chat = chatFailure(new ChatRequest("kimi-k3", "", List.of(ChatMessage.user("x")), 16));
        assertThat(chat.kind()).isEqualTo(ProviderException.Kind.AUTH);
        assertThat(chat.mayHaveBilled()).isFalse();
    }

    @Test
    void geminisFourHundredForABadKeyIsAuthAndOtherFourHundredsAreNot() throws Exception {
        google();
        server.acceptedKey = "AIzaSomeoneElse0123456789";
        server.refusedStatus = 400;
        server.refusedBody = "[{\"error\":{\"code\":400,\"message\":\"API key not valid. Please pass a valid API key.\","
                + "\"status\":\"INVALID_ARGUMENT\",\"details\":[{\"@type\":\"type.googleapis.com/google.rpc.ErrorInfo\","
                + "\"reason\":\"API_KEY_INVALID\"}]}}]";
        assertThat(modelsFailure().kind()).isEqualTo(ProviderException.Kind.AUTH);
        server.refusedBody = "{\"error\":{\"code\":400,\"message\":\"x\",\"status\":\"INVALID_ARGUMENT\","
                + "\"details\":[{\"reason\":\"API_KEY_INVALID\"}]}}";
        assertThat(modelsFailure().kind()).isEqualTo(ProviderException.Kind.AUTH);
        server.refusedBody = "{\"error\":{\"code\":400,\"message\":\"User location is not supported for the API use.\","
                + "\"status\":\"FAILED_PRECONDITION\"}}";
        assertThat(modelsFailure().kind()).isEqualTo(ProviderException.Kind.BAD_REQUEST);
        server.refusedStatus = 403;
        server.refusedBody = "{\"error\":{\"code\":403,\"status\":\"PERMISSION_DENIED\"}}";
        assertThat(modelsFailure().kind()).isEqualTo(ProviderException.Kind.AUTH);
        server.refusedStatus = 503;
        server.refusedBody = "not json";
        assertThat(modelsFailure().kind()).isEqualTo(ProviderException.Kind.UNAVAILABLE);
    }

    @Test
    void refusalsAndStreamErrorsAreKindsAndACutStreamIsUnavailable() throws Exception {
        google();
        ChatRequest request = new ChatRequest("gemini-4-argon", "", List.of(ChatMessage.user("x")), 16);
        server.then(new FakeOpenRouter.Reply(429, Map.of(), "{\"error\":{\"code\":429,\"message\":\"Resource has been"
                + " exhausted\",\"status\":\"RESOURCE_EXHAUSTED\"}}", List.of(), -1));
        ProviderException limited = chatFailure(request);
        assertThat(limited.kind()).isEqualTo(ProviderException.Kind.RATE_LIMITED);
        assertThat(limited.mayHaveBilled()).isFalse();

        server.then(new FakeOpenRouter.Reply(402, Map.of(), "{}", List.of(), -1));
        assertThat(chatFailure(request).kind()).isEqualTo(ProviderException.Kind.RATE_LIMITED);

        server.then(new FakeOpenRouter.Reply(404, Map.of(), "{\"error\":{\"code\":404,\"message\":\"models/x is not"
                + " found\",\"status\":\"NOT_FOUND\"}}", List.of(), -1));
        assertThat(chatFailure(request).kind()).isEqualTo(ProviderException.Kind.BAD_REQUEST);

        server.then(FakeOpenRouter.Reply.events(chunk("gemini-4-argon", "{\"content\":\"Par\"}", null),
                data("{\"error\":{\"code\":503,\"message\":\"The model is overloaded.\",\"status\":\"UNAVAILABLE\"}}")));
        ProviderException overloaded = chatFailure(request);
        assertThat(overloaded.kind()).isEqualTo(ProviderException.Kind.UNAVAILABLE);
        assertThat(overloaded.mayHaveBilled()).isTrue();
        assertThat(String.valueOf(overloaded.getMessage())).doesNotContain("overloaded");

        server.then(FakeOpenRouter.Reply.events(chunk("gemini-4-argon", "{\"content\":\"Par\"}", null),
                data("{\"error\":{\"message\":\"slow down\",\"type\":\"rate_limit_reached_error\"}}")));
        assertThat(chatFailure(request).kind()).isEqualTo(ProviderException.Kind.RATE_LIMITED);

        server.then(FakeChatServer.answer("gemini-4-argon", 1, 1, "Hello", " there").cutAfter(1));
        ProviderException cut = chatFailure(request);
        assertThat(cut.kind()).isEqualTo(ProviderException.Kind.UNAVAILABLE);
        assertThat(cut.mayHaveBilled()).isTrue();
    }

    @Test
    void aCallsIdAndNameAreCutAt128() throws Exception {
        google();
        String id = "i".repeat(300);
        String name = "n".repeat(300);
        server.then(new FakeOpenRouter.Reply(200, Map.of(), null, List.of(
                chunk("gemini-4-argon", "{\"tool_calls\":[{\"index\":0,\"id\":\"" + id + "\",\"type\":\"function\","
                        + "\"function\":{\"name\":\"" + name + "\",\"arguments\":\"{}\"}}]}", "tool_calls"),
                done()), -1));
        ToolCall call = chat(new ChatRequest("gemini-4-argon", "", List.of(ChatMessage.user("x")), 16, TOOLS),
                new ArrayList<>()).toolCalls().getFirst();
        assertThat(call.id()).hasSize(128);
        assertThat(call.name()).hasSize(128);
    }

    @Test
    void noUsageCountsAsTheGatewayEstimates() throws Exception {
        moonshot();
        ChatRequest request = new ChatRequest("kimi-k3", "", List.of(ChatMessage.user("Hello there")), 16);
        server.then(FakeOpenRouter.Reply.events(chunk("kimi-k3", "{\"content\":\"Hey\"}", "stop"), done()));
        ChatResult result = chat(request, new ArrayList<>());
        assertThat(result.usage()).isEqualTo(new Usage(Math.ceilDiv(request.inputBytes(), 3), 0, 0, 1, 0));
    }

    @Test
    void usageTakesTheMostCachedCountAndCacheWrites() {
        assertThat(ChatCompletions.usage(Map.of("prompt_tokens", 1000, "completion_tokens", 10, "total_tokens", 1010,
                "cached_tokens", 100, "prompt_tokens_details", Map.of("cached_tokens", 300, "cache_write_tokens", 200))))
                .isEqualTo(new Usage(500, 300, 200, 10, 0));
        assertThat(ChatCompletions.usage(Map.of("prompt_tokens", 10, "cached_tokens", 50)))
                .isEqualTo(new Usage(0, 10, 0, 0, 0));
    }

    @Test
    void geminisChatModelsTakePictures() {
        assertThat(Vision.supports(ProviderId.GOOGLE, "gemini-4-argon")).isTrue();
        assertThat(Vision.supports(ProviderId.GOOGLE, "gemini-2.5-flash")).isTrue();
        assertThat(Vision.supports(ProviderId.GOOGLE, "gemini-1.0-pro")).isFalse();
        assertThat(Vision.supports(ProviderId.GOOGLE, "gemma-3-27b-it")).isFalse();
        assertThat(Vision.supports(ProviderId.MOONSHOT, "kimi-k3")).isFalse();
    }
}
