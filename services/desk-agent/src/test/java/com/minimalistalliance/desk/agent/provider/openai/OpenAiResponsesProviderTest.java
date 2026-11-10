package com.minimalistalliance.desk.agent.provider.openai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.key.KeyLease;
import com.minimalistalliance.desk.agent.key.KeyRing;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.ChatResult;
import com.minimalistalliance.desk.agent.provider.ProviderException;
import com.minimalistalliance.desk.agent.provider.ProviderId;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.ToolSpec;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.provider.http.HttpTransport;
import com.minimalistalliance.desk.agent.testing.FakeLlmServer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** OpenAI's Responses API, which xAI also serves, against the local stand-in. */
class OpenAiResponsesProviderTest {

    private static final ChatRequest REQUEST = new ChatRequest("gpt-5.4-mini", "Be brief.",
            List.of(ChatMessage.user("Hello?")), 256);

    private FakeLlmServer server;
    private OpenAiResponsesProvider openai;
    private OpenAiResponsesProvider xai;
    private final KeyRing keys = new KeyRing((action, target, decision) -> {});

    @BeforeEach
    void setUp() throws Exception {
        server = new FakeLlmServer();
        HttpTransport http = new HttpTransport(
                new HttpTransport.Timeouts(Duration.ofSeconds(2), Duration.ofSeconds(5), Duration.ofMillis(400)), null);
        openai = new OpenAiResponsesProvider(OpenAiResponsesProvider.OPENAI, http, HttpTransport.baseUri(server.url()));
        xai = new OpenAiResponsesProvider(OpenAiResponsesProvider.XAI, http, HttpTransport.baseUri(server.url()));
        keys.put("k1", ProviderId.OPENAI, FakeLlmServer.KEY.getBytes(StandardCharsets.US_ASCII));
    }

    @AfterEach
    void tearDown() {
        server.close();
        keys.dropAll();
    }

    @Test
    void itStreamsAndTakesCachedInputOutOfTheInputCount() throws Exception {
        server.then(FakeLlmServer.openai("gpt-5.4-mini-2026-08-01", 1000, 400, 50, 12, "Hi", " there."));
        List<String> deltas = new ArrayList<>();
        ChatResult result;
        try (KeyLease key = keys.lend("k1")) {
            result = openai.chat(REQUEST, key, deltas::add);
        }
        assertThat(deltas).containsExactly("Hi", " there.");
        assertThat(result.text()).isEqualTo("Hi there.");
        assertThat(result.model()).isEqualTo("gpt-5.4-mini-2026-08-01");
        assertThat(result.stopReason()).isEqualTo("completed");
        assertThat(result.usage()).isEqualTo(new Usage(600, 400, 0, 50, 12));

        FakeLlmServer.Request sent = server.requests.peek();
        assertThat(sent.path()).isEqualTo("/v1/responses");
        assertThat(sent.authorization()).isEqualTo("Bearer " + FakeLlmServer.KEY);
        assertThat(sent.apiKey()).isNull();
        Map<String, Object> body = server.lastChatBody();
        assertThat(body).containsEntry("model", "gpt-5.4-mini").containsEntry("instructions", "Be brief.")
                .containsEntry("max_output_tokens", 256).containsEntry("stream", true)
                // The provider keeps no copy of the conversation.
                .containsEntry("store", false);
        assertThat(body.get("input")).isEqualTo(List.of(Map.of("role", "user", "content", "Hello?")));
    }

    @Test
    void anIncompleteResponseIsAnAnswerWithItsReason() throws Exception {
        server.then(FakeLlmServer.Reply.events(
                FakeLlmServer.sse("response.output_text.delta", "{\"type\":\"response.output_text.delta\","
                        + "\"delta\":\"Cut\"}"),
                FakeLlmServer.sse("response.incomplete", "{\"type\":\"response.incomplete\",\"response\":{"
                        + "\"model\":\"gpt-x\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"},"
                        + "\"usage\":{\"input_tokens\":5,\"output_tokens\":256}}}")));
        try (KeyLease key = keys.lend("k1")) {
            ChatResult result = openai.chat(REQUEST, key, text -> {});
            assertThat(result.stopReason()).isEqualTo("max_output_tokens");
            assertThat(result.usage()).isEqualTo(new Usage(5, 0, 0, 256, 0));
        }
    }

    @Test
    void aFailedResponseMayHaveBeenBilled() {
        server.then(FakeLlmServer.Reply.events(FakeLlmServer.sse("response.failed",
                "{\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"rate_limit_exceeded\"}}}")));
        assertThatThrownBy(() -> {
            try (KeyLease key = keys.lend("k1")) {
                openai.chat(REQUEST, key, text -> {});
            }
        }).isInstanceOfSatisfying(ProviderException.class, e -> {
            assertThat(e.kind()).isEqualTo(ProviderException.Kind.RATE_LIMITED);
            assertThat(e.mayHaveBilled()).isTrue();
        });
    }

    @Test
    void aStreamThatEndsWithoutCompletingIsUnavailable() {
        server.then(FakeLlmServer.Reply.events(FakeLlmServer.sse("response.output_text.delta",
                "{\"type\":\"response.output_text.delta\",\"delta\":\"x\"}")));
        assertThatThrownBy(() -> {
            try (KeyLease key = keys.lend("k1")) {
                openai.chat(REQUEST, key, text -> {});
            }
        }).isInstanceOfSatisfying(ProviderException.class,
                e -> assertThat(e.kind()).isEqualTo(ProviderException.Kind.UNAVAILABLE));
    }

    @Test
    void xaiIsTheSameApiWithItsOwnIdentity() throws Exception {
        assertThat(xai.id()).isEqualTo(ProviderId.XAI);
        assertThat(xai.info().keyPrefix()).isEqualTo("xai-");
        try (KeyLease key = keys.lend("k1")) {
            assertThat(xai.models(key)).extracting("id").contains("gpt-5.4-mini");
            assertThat(xai.chat(REQUEST, key, text -> {}).text()).isEqualTo("Hello from the stand-in.");
        }
    }

    private static final List<ToolSpec> TOOLS = List.of(new ToolSpec("read_file", "Reads a file.",
            Map.of("type", "object", "properties", Map.of("path", Map.of("type", "string")))));

    private static ChatRequest withTools(ChatMessage... thread) {
        return new ChatRequest("gpt-5.4-mini", "", List.of(thread), 512, TOOLS);
    }

    private ChatResult chat(OpenAiResponsesProvider which, ChatRequest request) throws Exception {
        try (KeyLease key = keys.lend("k1")) {
            return which.chat(request, key, text -> {});
        }
    }

    @Test
    void toolsGoInTheRequestOnlyWhenThereAreSome() throws Exception {
        chat(openai, withTools(ChatMessage.user("Hi")));
        Map<String, Object> body = server.lastChatBody();
        assertThat(body.get("tools")).isEqualTo(List.of(Map.of("type", "function", "name", "read_file",
                "description", "Reads a file.", "parameters", TOOLS.getFirst().inputSchema(), "strict", false)));
        assertThat(body).containsEntry("store", false);
        chat(openai, REQUEST);
        assertThat(server.lastChatBody()).doesNotContainKey("tools");
    }

    @Test
    void itParsesOneToolCallFromTheDoneItem() throws Exception {
        server.then(FakeLlmServer.openaiTools("m", null, false,
                new FakeLlmServer.Call("call_1", "read_file", "{\"path\":\"/a/b.txt\"}")));
        ChatResult result = chat(openai, withTools(ChatMessage.user("Hi")));
        assertThat(result.toolCalls()).containsExactly(
                new ToolCall("call_1", "read_file", Map.of("path", "/a/b.txt")));
    }

    @Test
    void textThenSeveralCallsComeInOrderOnceEach() throws Exception {
        server.then(FakeLlmServer.openaiTools("m", "Looking.", false,
                new FakeLlmServer.Call("c1", "read_file", "{\"path\":\"a\"}"),
                new FakeLlmServer.Call("c2", "read_file", ""),
                new FakeLlmServer.Call("c3", "read_file", "{\"path\":\"c\"}")));
        List<String> deltas = new ArrayList<>();
        ChatResult result;
        try (KeyLease key = keys.lend("k1")) {
            result = openai.chat(withTools(ChatMessage.user("Hi")), key, deltas::add);
        }
        assertThat(deltas).containsExactly("Looking.");
        assertThat(result.toolCalls()).containsExactly(
                new ToolCall("c1", "read_file", Map.of("path", "a")),
                new ToolCall("c2", "read_file", Map.of()),
                new ToolCall("c3", "read_file", Map.of("path", "c")));
    }

    @Test
    void aCallSeenOnlyInTheCompletedOutputIsStillTaken() throws Exception {
        server.then(FakeLlmServer.openaiTools("m", null, true,
                new FakeLlmServer.Call("c1", "read_file", "{\"path\":\"a\"}")));
        assertThat(chat(xai, withTools(ChatMessage.user("Hi"))).toolCalls()).containsExactly(
                new ToolCall("c1", "read_file", Map.of("path", "a")));
    }

    @Test
    void argumentsThatAreNotAnObjectAreMalformedWithAnEmptyInput() throws Exception {
        server.then(FakeLlmServer.openaiTools("m", null, false,
                new FakeLlmServer.Call("c1", "read_file", "{\"path\":"),
                new FakeLlmServer.Call("c2", "read_file", "\"str\"")));
        assertThat(chat(openai, withTools(ChatMessage.user("Hi"))).toolCalls()).containsExactly(
                new ToolCall("c1", "read_file", Map.of(), true), new ToolCall("c2", "read_file", Map.of(), true));
    }

    @Test
    void theFollowUpCarriesTheCallsAndTheirResultsInOrderForOpenAiAndXai() throws Exception {
        ChatRequest request = withTools(ChatMessage.user("Look"),
                ChatMessage.toolCalls("Checking.", List.of(new ToolCall("c1", "read_file", Map.of("path", "a")),
                        new ToolCall("c2", "read_file", Map.of()))),
                ChatMessage.toolResults(List.of(new ToolResult("c1", "contents", false),
                        new ToolResult("c2", "no such file", true))));
        List<Object> expected = List.of(
                Map.of("role", "user", "content", "Look"),
                Map.of("role", "assistant", "content", "Checking."),
                Map.of("type", "function_call", "call_id", "c1", "name", "read_file", "arguments", "{\"path\":\"a\"}"),
                Map.of("type", "function_call", "call_id", "c2", "name", "read_file", "arguments", "{}"),
                Map.of("type", "function_call_output", "call_id", "c1", "output", "contents"),
                Map.of("type", "function_call_output", "call_id", "c2", "output", "no such file"));
        chat(openai, request);
        assertThat(server.lastChatBody().get("input")).isEqualTo(expected);
        chat(xai, request);
        assertThat(server.lastChatBody().get("input")).isEqualTo(expected);
    }

    @Test
    void aCallWithNoTextHasNoEmptyTextItem() throws Exception {
        chat(openai, withTools(ChatMessage.user("Look"),
                ChatMessage.toolCalls("", List.of(new ToolCall("c1", "read_file", Map.of()))),
                ChatMessage.toolResults(List.of(new ToolResult("c1", "ok", false)))));
        assertThat(server.lastChatBody().get("input")).isEqualTo(List.of(
                Map.of("role", "user", "content", "Look"),
                Map.of("type", "function_call", "call_id", "c1", "name", "read_file", "arguments", "{}"),
                Map.of("type", "function_call_output", "call_id", "c1", "output", "ok")));
    }

    @Test
    void moreThan64CallsInOneTurnIsAMalformedReply() {
        FakeLlmServer.Call[] calls = new FakeLlmServer.Call[65];
        for (int i = 0; i < calls.length; i++) {
            calls[i] = new FakeLlmServer.Call("c" + i, "read_file", "{}");
        }
        server.then(FakeLlmServer.openaiTools("m", null, false, calls));
        assertMalformedReply();
    }

    @Test
    void argumentsOver256KiBAreAMalformedReply() {
        String big = "{\"path\":\"" + "x".repeat(256 * 1024) + "\"}";
        server.then(FakeLlmServer.openaiTools("m", null, false, new FakeLlmServer.Call("c1", "read_file", big)));
        assertMalformedReply();
    }

    private static String ev(String type, String json) {
        return FakeLlmServer.sse(type, "{\"type\":\"" + type + "\"," + json + "}");
    }

    private static final String REASONING = "{\"type\":\"reasoning\",\"id\":\"rs_1\",\"summary\":[],"
            + "\"encrypted_content\":\"enc-1\"}";
    private static final String CALL = "{\"type\":\"function_call\",\"call_id\":\"c1\",\"name\":\"read_file\","
            + "\"arguments\":\"{}\"}";

    @Test
    void itAsksForEncryptedReasoningAndSetsEffortPerModel() throws Exception {
        chat(openai, withTools(ChatMessage.user("Hi")));
        Map<String, Object> body = server.lastChatBody();
        assertThat(body).containsEntry("store", false).containsEntry("reasoning", Map.of("effort", "medium"));
        assertThat(body.get("include")).isEqualTo(List.of("reasoning.encrypted_content"));
        // A model that doesn't reason would refuse the field.
        chat(openai, new ChatRequest("gpt-4.1", "", List.of(ChatMessage.user("Hi")), 100));
        assertThat(server.lastChatBody()).doesNotContainKey("reasoning");
    }

    @Test
    void effortIsHeldToWhatEachModelTakes() {
        assertThat(OpenAiResponsesProvider.effort(ProviderId.OPENAI, "gpt-6-astra", "none")).isEqualTo("low");
        assertThat(OpenAiResponsesProvider.effort(ProviderId.OPENAI, "gpt-6.1-sol", "none")).isEqualTo("low");
        assertThat(OpenAiResponsesProvider.effort(ProviderId.OPENAI, "gpt-5.5", "none")).isEqualTo("none");
        assertThat(OpenAiResponsesProvider.effort(ProviderId.XAI, "grok-4.7", "xhigh")).isEqualTo("xhigh");
        assertThat(OpenAiResponsesProvider.effort(ProviderId.XAI, "grok-4.5", "xhigh")).isEqualTo("high");
        assertThat(OpenAiResponsesProvider.effort(ProviderId.XAI, "grok-4.5", "none")).isEqualTo("low");
        assertThat(OpenAiResponsesProvider.effort(ProviderId.XAI, "grok-4.5-non-reasoning", "high")).isNull();
        assertThat(OpenAiResponsesProvider.effort(ProviderId.OPENAI, "gpt-5-chat-latest", "high")).isNull();
    }

    @Test
    void reasoningComesBackWithTheCallItLedToAndGoesOutAheadOfIt() throws Exception {
        server.then(FakeLlmServer.Reply.events(
                ev("response.output_item.done", "\"item\":" + REASONING),
                ev("response.output_item.done", "\"item\":" + CALL),
                ev("response.completed", "\"response\":{\"model\":\"m\",\"status\":\"completed\",\"output\":["
                        + REASONING + "," + CALL + "],\"usage\":{\"input_tokens\":5,\"output_tokens\":9}}")));
        ChatResult result = chat(openai, withTools(ChatMessage.user("Hi")));
        assertThat(result.toolCalls()).hasSize(1);
        ToolCall call = result.toolCalls().getFirst();
        assertThat(call.reasoning()).containsExactly(Map.of("type", "reasoning", "id", "rs_1", "summary", List.of(),
                "encrypted_content", "enc-1"));

        chat(openai, withTools(ChatMessage.user("Hi"), ChatMessage.toolCalls("Checking.", result.toolCalls()),
                ChatMessage.toolResults(List.of(new ToolResult("c1", "ok", false)))));
        assertThat(server.lastChatBody().get("input")).isEqualTo(List.of(
                Map.of("role", "user", "content", "Hi"),
                Map.of("type", "reasoning", "id", "rs_1", "summary", List.of(), "encrypted_content", "enc-1"),
                Map.of("role", "assistant", "content", "Checking."),
                Map.of("type", "function_call", "call_id", "c1", "name", "read_file", "arguments", "{}"),
                Map.of("type", "function_call_output", "call_id", "c1", "output", "ok")));
    }

    @Test
    void aRefusalIsAStopReasonNotAnEmptyAnswer() throws Exception {
        server.then(FakeLlmServer.Reply.events(
                ev("response.refusal.delta", "\"delta\":\"I can't\""),
                ev("response.completed", "\"response\":{\"model\":\"m\",\"status\":\"completed\",\"output\":[],"
                        + "\"usage\":{\"input_tokens\":5,\"output_tokens\":3}}")));
        ChatResult result = chat(openai, REQUEST);
        assertThat(result.stopReason()).isEqualTo("refusal");
        assertThat(result.refused()).isTrue();

        server.then(FakeLlmServer.Reply.events(ev("response.completed", "\"response\":{\"model\":\"m\","
                + "\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"refusal\","
                + "\"refusal\":\"no\"}]}],\"usage\":{\"input_tokens\":5,\"output_tokens\":3}}")));
        assertThat(chat(openai, REQUEST).refused()).isTrue();

        server.then(FakeLlmServer.Reply.events(ev("response.incomplete", "\"response\":{\"model\":\"m\","
                + "\"incomplete_details\":{\"reason\":\"content_filter\"},\"usage\":{\"input_tokens\":5,"
                + "\"output_tokens\":0}}")));
        assertThat(chat(openai, REQUEST).refused()).isTrue();
    }

    @Test
    void anEmptyReplyThatUsedItsWholeCapIsCutOff() throws Exception {
        server.then(FakeLlmServer.Reply.events(ev("response.completed", "\"response\":{\"model\":\"m\","
                + "\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":5,"
                + "\"output_tokens\":256,\"output_tokens_details\":{\"reasoning_tokens\":256}}}")));
        ChatResult result = chat(openai, REQUEST);
        assertThat(result.cutOff()).isTrue();
        // An empty reply that stopped early is not cut off.
        server.then(FakeLlmServer.Reply.events(ev("response.completed", "\"response\":{\"model\":\"m\","
                + "\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":5,\"output_tokens\":20}}")));
        assertThat(chat(openai, REQUEST).cutOff()).isFalse();
    }

    @Test
    void usageTakesTheMostOfOutputTotalLessInputAndReasoningWithoutClampingReasoning() {
        // xAI counts reasoning outside output_tokens.
        Map<String, Object> raw = Map.of("input_tokens", 100, "output_tokens", 50, "total_tokens", 1100,
                "output_tokens_details", Map.of("reasoning_tokens", 900));
        assertThat(OpenAiResponsesProvider.usage(raw)).isEqualTo(new Usage(100, 0, 0, 1000, 900));
        // Without a total, visible plus reasoning when reasoning is the larger.
        Map<String, Object> noTotal = Map.of("input_tokens", 100, "output_tokens", 50,
                "output_tokens_details", Map.of("reasoning_tokens", 900));
        assertThat(OpenAiResponsesProvider.usage(noTotal).outputTokens()).isEqualTo(950);
        // Reasoning inside output_tokens stays as reported.
        Map<String, Object> inside = Map.of("input_tokens", 100, "output_tokens", 500, "total_tokens", 600,
                "output_tokens_details", Map.of("reasoning_tokens", 400));
        assertThat(OpenAiResponsesProvider.usage(inside)).isEqualTo(new Usage(100, 0, 0, 500, 400));
    }

    @Test
    void aReasoningStepThatStreamsNothingForAWhileIsNotKilled() throws Exception {
        String created = ev("response.created", "\"response\":{\"model\":\"m\"}");
        String done = ev("response.completed", "\"response\":{\"model\":\"m\",\"status\":\"completed\",\"output\":[],"
                + "\"usage\":{\"input_tokens\":5,\"output_tokens\":9}}");
        // The transport allows 400 ms of silence; this model thinks for 700.
        server.then(FakeLlmServer.Reply.events(created, done).paced(700));
        assertThat(chat(openai, REQUEST).stopReason()).isEqualTo("completed");
        // The same silence from a model that doesn't reason is still a stall.
        server.then(FakeLlmServer.Reply.events(created, done).paced(700));
        assertThatThrownBy(() -> chat(openai, new ChatRequest("gpt-4.1", "", List.of(ChatMessage.user("Hi")), 100)))
                .isInstanceOfSatisfying(ProviderException.class,
                        e -> assertThat(e.kind()).isEqualTo(ProviderException.Kind.TIMEOUT));
    }

    private void assertMalformedReply() {
        assertThatThrownBy(() -> chat(openai, withTools(ChatMessage.user("Hi")))).isInstanceOfSatisfying(
                ProviderException.class, e -> {
                    assertThat(e.kind()).isEqualTo(ProviderException.Kind.UNAVAILABLE);
                    assertThat(e.mayHaveBilled()).isTrue();
                });
    }
}
