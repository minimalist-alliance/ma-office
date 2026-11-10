package com.minimalistalliance.desk.agent.provider.anthropic;

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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Anthropic's Messages API against the local stand-in, never the real one. */
class AnthropicProviderTest {

    private static final ChatRequest REQUEST = new ChatRequest("claude-sonnet-5-5", "Be brief.",
            List.of(ChatMessage.user("One"), ChatMessage.user("Two"), ChatMessage.assistant("Three"),
                    ChatMessage.user("Four")), 512);

    private FakeLlmServer server;
    private AnthropicProvider provider;
    private final KeyRing keys = new KeyRing((action, target, decision) -> {});

    @BeforeEach
    void setUp() throws Exception {
        server = new FakeLlmServer();
        HttpTransport http = new HttpTransport(
                new HttpTransport.Timeouts(Duration.ofSeconds(2), Duration.ofSeconds(5), Duration.ofMillis(400)), null);
        provider = new AnthropicProvider(http, HttpTransport.baseUri(server.url()));
        keys.put("k1", ProviderId.ANTHROPIC, FakeLlmServer.KEY.getBytes(StandardCharsets.US_ASCII));
    }

    @AfterEach
    void tearDown() {
        server.close();
        keys.dropAll();
    }

    @Test
    void itStreamsTheReplyAndReportsWhatAnthropicCounted() throws Exception {
        server.then(FakeLlmServer.anthropic("claude-sonnet-5-5-20261001", 1200, 37, "Hi", " there", "."));
        List<String> deltas = new ArrayList<>();
        ChatResult result;
        try (KeyLease key = keys.lend("k1")) {
            result = provider.chat(REQUEST, key, deltas::add);
        }
        assertThat(deltas).containsExactly("Hi", " there", ".");
        assertThat(result.text()).isEqualTo("Hi there.");
        assertThat(result.model()).isEqualTo("claude-sonnet-5-5-20261001");
        assertThat(result.stopReason()).isEqualTo("end_turn");
        assertThat(result.usage()).isEqualTo(new Usage(1200, 0, 0, 37, 0));

        FakeLlmServer.Request sent = server.requests.peek();
        assertThat(sent.path()).isEqualTo("/v1/messages");
        assertThat(sent.apiKey()).isEqualTo(FakeLlmServer.KEY);
        assertThat(sent.authorization()).isNull();
        assertThat(sent.version()).isEqualTo("2023-06-01");
        Map<String, Object> body = server.lastChatBody();
        assertThat(body).containsEntry("model", "claude-sonnet-5-5").containsEntry("max_tokens", 512)
                .containsEntry("system", List.of(Map.of("type", "text", "text", "Be brief.", "cache_control", Map.of("type", "ephemeral")))).containsEntry("stream", true);
        // Two user turns in a row go as one, as a failed reply leaves them.
        assertThat(body.get("messages")).isEqualTo(List.of(
                Map.of("role", "user", "content", "One\n\nTwo"),
                Map.of("role", "assistant", "content", "Three"),
                Map.of("role", "user", "content", "Four")));
    }

    @Test
    void cacheReadsAndWritesAreCountedApart() throws Exception {
        server.then(new FakeLlmServer.Reply(200, List.of(
                FakeLlmServer.sse("message_start", "{\"type\":\"message_start\",\"message\":{\"model\":\"m\","
                        + "\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":300,"
                        + "\"cache_read_input_tokens\":2000,\"output_tokens\":1}}}"),
                FakeLlmServer.sse("message_delta", "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":"
                        + "\"max_tokens\"},\"usage\":{\"output_tokens\":512}}"),
                FakeLlmServer.sse("message_stop", "{\"type\":\"message_stop\"}")), 0, -1, -1, null));
        try (KeyLease key = keys.lend("k1")) {
            ChatResult result = provider.chat(REQUEST, key, text -> {});
            assertThat(result.usage()).isEqualTo(new Usage(10, 2000, 300, 512, 0));
            assertThat(result.stopReason()).isEqualTo("max_tokens");
        }
    }

    @Test
    void refusalsBeforeGeneratingAreNotBilled() {
        int[][] cases = {{401, 0}, {403, 0}, {429, 1}, {400, 2}, {404, 2}, {500, 3}, {529, 3}, {504, 4}};
        ProviderException.Kind[] kinds = {ProviderException.Kind.AUTH, ProviderException.Kind.RATE_LIMITED,
            ProviderException.Kind.BAD_REQUEST, ProviderException.Kind.UNAVAILABLE, ProviderException.Kind.TIMEOUT};
        for (int[] c : cases) {
            server.then(FakeLlmServer.Reply.status(c[0]));
            assertThatThrownBy(() -> {
                try (KeyLease key = keys.lend("k1")) {
                    provider.chat(REQUEST, key, text -> {});
                }
            }).as("HTTP " + c[0]).isInstanceOfSatisfying(ProviderException.class, e -> {
                assertThat(e.kind()).isEqualTo(kinds[c[1]]);
                assertThat(e.mayHaveBilled()).isFalse();
            });
        }
    }

    @Test
    void aWrongKeyIsAuth() {
        server.acceptedKey = "sk-ant-another-key-000000";
        assertThatThrownBy(() -> {
            try (KeyLease key = keys.lend("k1")) {
                provider.models(key);
            }
        }).isInstanceOfSatisfying(ProviderException.class,
                e -> assertThat(e.kind()).isEqualTo(ProviderException.Kind.AUTH));
    }

    @Test
    void anErrorInTheStreamMayHaveBeenBilled() {
        server.then(FakeLlmServer.Reply.events(
                FakeLlmServer.sse("message_start", "{\"type\":\"message_start\",\"message\":{\"model\":\"m\"}}"),
                FakeLlmServer.sse("error", "{\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}")));
        assertThatThrownBy(() -> {
            try (KeyLease key = keys.lend("k1")) {
                provider.chat(REQUEST, key, text -> {});
            }
        }).isInstanceOfSatisfying(ProviderException.class, e -> {
            assertThat(e.kind()).isEqualTo(ProviderException.Kind.UNAVAILABLE);
            assertThat(e.mayHaveBilled()).isTrue();
        });
    }

    @Test
    void aStreamCutShortIsUnavailableAndMayHaveBeenBilled() {
        server.then(FakeLlmServer.anthropic("m", 1, 1, "a", "b", "c").cutAfter(4));
        assertThatThrownBy(() -> {
            try (KeyLease key = keys.lend("k1")) {
                provider.chat(REQUEST, key, text -> {});
            }
        }).isInstanceOfSatisfying(ProviderException.class, e -> {
            assertThat(e.kind()).isEqualTo(ProviderException.Kind.UNAVAILABLE);
            assertThat(e.mayHaveBilled()).isTrue();
        });
    }

    /** JDK 21's request timeout ends at the headers; the transport's watchdog is what ends a stalled body. */
    @Test
    void aStreamThatStallsTimesOut() {
        CountDownLatch never = new CountDownLatch(1);
        server.then(FakeLlmServer.anthropic("m", 1, 1, "a", "b").holdAfter(3, never));
        long started = System.nanoTime();
        assertThatThrownBy(() -> {
            try (KeyLease key = keys.lend("k1")) {
                provider.chat(REQUEST, key, text -> {});
            }
        }).isInstanceOfSatisfying(ProviderException.class, e -> {
            assertThat(e.kind()).isEqualTo(ProviderException.Kind.TIMEOUT);
            assertThat(e.mayHaveBilled()).isTrue();
        });
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(4));
        assertThat(Thread.currentThread().isInterrupted()).isFalse();
        never.countDown();
    }

    /** A run being stopped interrupts its thread, which ends the read as cancelled. */
    @Test
    void anInterruptCancelsTheCall() throws Exception {
        CountDownLatch never = new CountDownLatch(1);
        server.then(FakeLlmServer.anthropic("m", 1, 1, "a", "b").holdAfter(3, never));
        AtomicReference<Throwable> thrown = new AtomicReference<>();
        Thread call = Thread.ofVirtual().start(() -> {
            try (KeyLease key = keys.lend("k1")) {
                provider.chat(REQUEST, key, text -> {});
            } catch (ProviderException e) {
                thrown.set(e);
            }
        });
        assertThat(server.streaming.await(5, TimeUnit.SECONDS)).isTrue();
        Thread.sleep(100);
        call.interrupt();
        call.join(Duration.ofSeconds(5));
        assertThat(thrown.get()).isInstanceOfSatisfying(ProviderException.class,
                e -> assertThat(e.kind()).isEqualTo(ProviderException.Kind.CANCELLED));
        never.countDown();
    }

    @Test
    void theModelListIsTheKeyCheck() throws Exception {
        try (KeyLease key = keys.lend("k1")) {
            assertThat(provider.models(key)).extracting("id", "label").contains(
                    org.assertj.core.groups.Tuple.tuple("claude-sonnet-5-5", "Claude Sonnet 5.5"),
                    org.assertj.core.groups.Tuple.tuple("some-new-model", "some-new-model"));
        }
        assertThat(server.requests.peek().path()).isEqualTo("/v1/models");
        assertThat(server.requests.peek().apiKey()).isEqualTo(FakeLlmServer.KEY);
    }

    private static final List<ToolSpec> TOOLS = List.of(new ToolSpec("read_file", "Reads a file.",
            Map.of("type", "object", "properties", Map.of("path", Map.of("type", "string")))));

    private static ChatRequest withTools(ChatMessage... thread) {
        return new ChatRequest("claude-sonnet-5-5", "", List.of(thread), 512, TOOLS);
    }

    private ChatResult chat(ChatRequest request) throws Exception {
        try (KeyLease key = keys.lend("k1")) {
            return provider.chat(request, key, text -> {});
        }
    }

    @Test
    void toolsGoInTheRequestOnlyWhenThereAreSome() throws Exception {
        chat(withTools(ChatMessage.user("Hi")));
        assertThat(server.lastChatBody().get("tools")).isEqualTo(List.of(Map.of("name", "read_file",
                "description", "Reads a file.", "input_schema", TOOLS.getFirst().inputSchema(),
                // No system prompt, so the cache breakpoint is on the last tool.
                "cache_control", Map.of("type", "ephemeral"))));
        chat(REQUEST);
        assertThat(server.lastChatBody()).doesNotContainKey("tools");
    }

    @Test
    void itParsesOneToolCallWithItsInputFromPieces() throws Exception {
        server.then(FakeLlmServer.anthropicTools("m", 10, 5, null, 4,
                new FakeLlmServer.Call("toolu_1", "read_file", "{\"path\":\"/a/b.txt\"}")));
        ChatResult result = chat(withTools(ChatMessage.user("Hi")));
        assertThat(result.text()).isEmpty();
        assertThat(result.stopReason()).isEqualTo("tool_use");
        assertThat(result.toolCalls()).containsExactly(
                new ToolCall("toolu_1", "read_file", Map.of("path", "/a/b.txt")));
    }

    @Test
    void textThenSeveralCallsComeInOrderAndTheTextStillStreams() throws Exception {
        server.then(FakeLlmServer.anthropicTools("m", 10, 5, "Looking.", 100,
                new FakeLlmServer.Call("toolu_1", "read_file", "{\"path\":\"a\"}"),
                new FakeLlmServer.Call("toolu_2", "read_file", ""),
                new FakeLlmServer.Call("toolu_3", "read_file", "{\"path\":\"c\"}")));
        List<String> deltas = new ArrayList<>();
        ChatResult result;
        try (KeyLease key = keys.lend("k1")) {
            result = provider.chat(withTools(ChatMessage.user("Hi")), key, deltas::add);
        }
        assertThat(deltas).containsExactly("Looking.");
        assertThat(result.text()).isEqualTo("Looking.");
        assertThat(result.toolCalls()).containsExactly(
                new ToolCall("toolu_1", "read_file", Map.of("path", "a")),
                new ToolCall("toolu_2", "read_file", Map.of()),
                new ToolCall("toolu_3", "read_file", Map.of("path", "c")));
    }

    @Test
    void argumentsThatAreNotAnObjectAreMalformedWithAnEmptyInput() throws Exception {
        server.then(FakeLlmServer.anthropicTools("m", 10, 5, null, 100,
                new FakeLlmServer.Call("t1", "read_file", "{\"path\":"),
                new FakeLlmServer.Call("t2", "read_file", "[1,2]"),
                new FakeLlmServer.Call("t3", "read_file", "null")));
        assertThat(chat(withTools(ChatMessage.user("Hi"))).toolCalls()).containsExactly(
                new ToolCall("t1", "read_file", Map.of(), true), new ToolCall("t2", "read_file", Map.of(), true),
                new ToolCall("t3", "read_file", Map.of(), true));
    }

    @Test
    void theFollowUpCarriesTheCallsAndTheirResultsInOrder() throws Exception {
        ChatRequest request = withTools(ChatMessage.user("Look"),
                ChatMessage.toolCalls("Checking.", List.of(new ToolCall("t1", "read_file", Map.of("path", "a")),
                        new ToolCall("t2", "read_file", Map.of("path", "b")))),
                ChatMessage.toolResults(List.of(new ToolResult("t1", "contents", false),
                        new ToolResult("t2", "no such file", true))));
        chat(request);
        assertThat(server.lastChatBody().get("messages")).isEqualTo(List.of(
                Map.of("role", "user", "content", "Look"),
                Map.of("role", "assistant", "content", List.of(
                        Map.of("type", "text", "text", "Checking."),
                        Map.of("type", "tool_use", "id", "t1", "name", "read_file", "input", Map.of("path", "a")),
                        Map.of("type", "tool_use", "id", "t2", "name", "read_file", "input", Map.of("path", "b")))),
                Map.of("role", "user", "content", List.of(
                        Map.of("type", "tool_result", "tool_use_id", "t1", "content", "contents"),
                        Map.of("type", "tool_result", "tool_use_id", "t2", "content", "no such file",
                                "is_error", true)))));
    }

    @Test
    void aCallWithNoTextHasNoEmptyTextBlockAndALaterUserTextJoinsTheResults() throws Exception {
        chat(withTools(ChatMessage.user("Look"),
                ChatMessage.toolCalls("", List.of(new ToolCall("t1", "read_file", Map.of()))),
                ChatMessage.toolResults(List.of(new ToolResult("t1", "ok", false))),
                ChatMessage.user("And?")));
        assertThat(server.lastChatBody().get("messages")).isEqualTo(List.of(
                Map.of("role", "user", "content", "Look"),
                Map.of("role", "assistant", "content", List.of(
                        Map.of("type", "tool_use", "id", "t1", "name", "read_file", "input", Map.of()))),
                Map.of("role", "user", "content", List.of(
                        Map.of("type", "tool_result", "tool_use_id", "t1", "content", "ok"),
                        Map.of("type", "text", "text", "And?")))));
    }

    @Test
    void aWhitespaceOnlyTextBeforeACallIsLeftOutAndTrailingWhitespaceIsTrimmed() throws Exception {
        chat(withTools(ChatMessage.user("Look"),
                ChatMessage.toolCalls("\n\n", List.of(new ToolCall("t1", "read_file", Map.of()))),
                ChatMessage.toolResults(List.of(new ToolResult("t1", "ok", false))),
                ChatMessage.toolCalls("Checking.\n ", List.of(new ToolCall("t2", "read_file", Map.of()))),
                ChatMessage.toolResults(List.of(new ToolResult("t2", "ok", false)))));
        assertThat(server.lastChatBody().get("messages")).isEqualTo(List.of(
                Map.of("role", "user", "content", "Look"),
                Map.of("role", "assistant", "content", List.of(
                        Map.of("type", "tool_use", "id", "t1", "name", "read_file", "input", Map.of()))),
                Map.of("role", "user", "content", List.of(
                        Map.of("type", "tool_result", "tool_use_id", "t1", "content", "ok"))),
                Map.of("role", "assistant", "content", List.of(
                        Map.of("type", "text", "text", "Checking."),
                        Map.of("type", "tool_use", "id", "t2", "name", "read_file", "input", Map.of()))),
                Map.of("role", "user", "content", List.of(
                        Map.of("type", "tool_result", "tool_use_id", "t2", "content", "ok")))));
    }

    @Test
    void oneCacheBreakpointSitsOnTheSystemPromptOrElseTheLastTool() throws Exception {
        List<ToolSpec> two = List.of(new ToolSpec("a", "A.", Map.of("type", "object")),
                new ToolSpec("b", "B.", Map.of("type", "object")));
        chat(new ChatRequest("claude-sonnet-5-5", "Be brief.", List.of(ChatMessage.user("Hi")), 100, two));
        Map<String, Object> body = server.lastChatBody();
        assertThat(body.get("system")).isEqualTo(List.of(Map.of("type", "text", "text", "Be brief.",
                "cache_control", Map.of("type", "ephemeral"))));
        assertThat(body.get("tools").toString()).doesNotContain("cache_control");

        chat(new ChatRequest("claude-sonnet-5-5", "", List.of(ChatMessage.user("Hi")), 100, two));
        body = server.lastChatBody();
        assertThat(body).doesNotContainKey("system");
        assertThat(body.get("tools").toString()).contains("cache_control");
        assertThat(((List<?>) body.get("tools")).getLast().toString()).contains("cache_control");
    }

    @Test
    void moreThan64CallsInOneTurnIsAMalformedReply() {
        FakeLlmServer.Call[] calls = new FakeLlmServer.Call[65];
        for (int i = 0; i < calls.length; i++) {
            calls[i] = new FakeLlmServer.Call("t" + i, "read_file", "{}");
        }
        server.then(FakeLlmServer.anthropicTools("m", 10, 5, null, 100, calls));
        assertMalformedReply();
    }

    @Test
    void sixtyFourCallsAreFine() throws Exception {
        FakeLlmServer.Call[] calls = new FakeLlmServer.Call[64];
        for (int i = 0; i < calls.length; i++) {
            calls[i] = new FakeLlmServer.Call("t" + i, "read_file", "{}");
        }
        server.then(FakeLlmServer.anthropicTools("m", 10, 5, null, 100, calls));
        assertThat(chat(withTools(ChatMessage.user("Hi"))).toolCalls()).hasSize(64);
    }

    @Test
    void argumentsOver256KiBAreAMalformedReply() {
        String big = "{\"path\":\"" + "x".repeat(256 * 1024) + "\"}";
        server.then(FakeLlmServer.anthropicTools("m", 10, 5, null, 16384,
                new FakeLlmServer.Call("t1", "read_file", big)));
        assertMalformedReply();
    }

    private void assertMalformedReply() {
        assertThatThrownBy(() -> chat(withTools(ChatMessage.user("Hi")))).isInstanceOfSatisfying(
                ProviderException.class, e -> {
                    assertThat(e.kind()).isEqualTo(ProviderException.Kind.UNAVAILABLE);
                    assertThat(e.mayHaveBilled()).isTrue();
                });
    }
}
