package com.minimalistalliance.desk.agent.provider.http;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.key.KeyLease;
import com.minimalistalliance.desk.agent.key.KeyRing;
import com.minimalistalliance.desk.agent.limits.Limit;
import com.minimalistalliance.desk.agent.limits.LimitPolicy;
import com.minimalistalliance.desk.agent.limits.LimitReachedException;
import com.minimalistalliance.desk.agent.llm.LlmGateway;
import com.minimalistalliance.desk.agent.provider.Attachment;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.DeltaSink;
import com.minimalistalliance.desk.agent.provider.ProviderId;
import com.minimalistalliance.desk.agent.provider.anthropic.AnthropicProvider;
import com.minimalistalliance.desk.agent.provider.openai.OpenAiResponsesProvider;
import com.minimalistalliance.desk.agent.testing.FakeLlmServer;
import com.minimalistalliance.desk.agent.testing.FakeProvider;
import com.minimalistalliance.desk.agent.testing.Rig;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** What a request with files looks like on the wire for each provider, and that the limits count it (ADR 0049). */
class AttachmentBodiesTest {

    private static final byte[] PIXELS = {1, 2, 3, 4, 5, 6, 7, 8};
    private static final String PIXELS_B64 = Base64.getEncoder().encodeToString(PIXELS);

    @TempDir
    Path dir;

    private FakeLlmServer server;
    private HttpTransport http;
    private final KeyRing keys = new KeyRing((action, target, decision) -> {});

    @BeforeEach
    void setUp() throws Exception {
        server = new FakeLlmServer();
        http = new HttpTransport(
                new HttpTransport.Timeouts(Duration.ofSeconds(2), Duration.ofSeconds(5), Duration.ofMillis(400)), null);
        keys.put("a", ProviderId.ANTHROPIC, FakeLlmServer.KEY.getBytes(StandardCharsets.US_ASCII));
        keys.put("o", ProviderId.OPENAI, FakeLlmServer.KEY.getBytes(StandardCharsets.US_ASCII));
        keys.put("x", ProviderId.XAI, FakeLlmServer.KEY.getBytes(StandardCharsets.US_ASCII));
    }

    @AfterEach
    void tearDown() {
        server.close();
        keys.dropAll();
    }

    private static ChatMessage withFiles(String text) {
        Attachment doc = Attachment.text("report.pdf", "PDF", 2048, "Revenue was up.\nCosts were flat.", "cut");
        Attachment picture = Attachment.image("chart.png", "PNG", "image/png", PIXELS.length, PIXELS.clone(), 1500);
        return ChatMessage.user(text, List.of(doc, picture));
    }

    /** A turn's blocks; a turn of one plain text is a string on the wire. */
    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> contentOf(Map<String, Object> message) {
        Object content = message.get("content");
        return content instanceof String text ? List.of(Map.of("type", "text", "text", text))
                : (List<Map<String, Object>>) content;
    }

    @Test
    void anthropicGetsTheWordsTheFencedFileAndThePicture() throws Exception {
        ChatRequest request = new ChatRequest("claude-sonnet-5-5", "Be brief.", List.of(withFiles("Summarise.")), 256);
        server.then(FakeLlmServer.anthropic("claude-sonnet-5-5", 10, 2, "ok"));
        try (KeyLease key = keys.lend("a")) {
            new AnthropicProvider(http, HttpTransport.baseUri(server.url())).chat(request, key, text -> {});
        }
        Map<String, Object> body = server.lastChatBody();
        // The standing notice rides in the system part.
        assertThat(String.valueOf(body.get("system"))).contains("Be brief.").contains(ChatRequest.FILES_NOTICE);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> messages = (List<Map<String, Object>>) body.get("messages");
        assertThat(messages).hasSize(1).first().satisfies(message -> assertThat(message).containsEntry("role", "user"));
        List<Map<String, Object>> blocks = contentOf(messages.getFirst());
        assertThat(blocks).hasSize(3);
        assertThat(blocks.get(0)).containsEntry("type", "text").containsEntry("text", "Summarise.");
        String fenced = (String) blocks.get(1).get("text");
        assertThat(blocks.get(1)).containsEntry("type", "text");
        assertThat(fenced).startsWith("<<<file ").contains("name=\"report.pdf\"").contains("Revenue was up.")
                .endsWith(">>>").contains("\n<<<end file ");
        assertThat(blocks.get(2)).containsEntry("type", "image");
        @SuppressWarnings("unchecked")
        Map<String, Object> source = (Map<String, Object>) blocks.get(2).get("source");
        assertThat(source).containsEntry("type", "base64").containsEntry("media_type", "image/png")
                .containsEntry("data", PIXELS_B64);
    }

    @Test
    void openAiAndXaiGetInputTextAndInputImageParts() throws Exception {
        for (OpenAiResponsesProvider provider : List.of(
                new OpenAiResponsesProvider(OpenAiResponsesProvider.OPENAI, http, HttpTransport.baseUri(server.url())),
                new OpenAiResponsesProvider(OpenAiResponsesProvider.XAI, http, HttpTransport.baseUri(server.url())))) {
            String keyId = provider.id().equals(ProviderId.XAI) ? "x" : "o";
            ChatRequest request = new ChatRequest(provider.id().equals(ProviderId.XAI) ? "grok-4" : "gpt-5.4",
                    "Be brief.", List.of(withFiles("Summarise.")), 256);
            server.then(FakeLlmServer.openai("gpt-x", 10, 0, 2, 0, "ok"));
            try (KeyLease key = keys.lend(keyId)) {
                provider.chat(request, key, text -> {});
            }
            Map<String, Object> body = server.lastChatBody();
            assertThat((String) body.get("instructions")).contains(ChatRequest.FILES_NOTICE);
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> input = (List<Map<String, Object>>) body.get("input");
            assertThat(input).hasSize(1);
            List<Map<String, Object>> parts = contentOf(input.getFirst());
            assertThat(parts).hasSize(3);
            assertThat(parts.get(0)).containsEntry("type", "input_text").containsEntry("text", "Summarise.");
            assertThat(parts.get(1)).containsEntry("type", "input_text");
            assertThat((String) parts.get(1).get("text")).startsWith("<<<file ").contains("Costs were flat.");
            assertThat(parts.get(2)).containsEntry("type", "input_image")
                    .containsEntry("image_url", "data:image/png;base64," + PIXELS_B64);
        }
    }

    @Test
    void aWipedFileGoesOutAsNothing() {
        ChatMessage message = withFiles("Summarise.");
        message.attachments().forEach(Attachment::wipe);
        List<Map<String, Object>> anthropic = Messages.anthropic(List.of(message));
        assertThat(contentOf(anthropic.getFirst())).hasSize(1);
        assertThat(Messages.responses(List.of(message)).toString()).doesNotContain("input_image")
                .doesNotContain("<<<file");
    }

    @Test
    void aFileOnlyMessageHasNoEmptyTextBlock() {
        ChatMessage message = ChatMessage.user("", List.of(Attachment.text("a.txt", "Text", 5, "hello", null)));
        assertThat(contentOf(Messages.anthropic(List.of(message)).getFirst())).hasSize(1);
        assertThat(contentOf(Messages.responses(List.of(message)).getFirst())).hasSize(1);
    }

    @Test
    void eachFileHasItsOwnBoundaryAndTheNameCarriesNoMarkup() {
        Attachment a = Attachment.text("a.txt", "Text", 1, "one", null);
        Attachment b = Attachment.text("b.txt", "Text", 1, "two", null);
        assertThat(a.fence()).isNotEqualTo(b.fence()).hasSize(16);
        assertThat(Messages.fenced(a)).contains("<<<file " + a.fence()).contains("<<<end file " + a.fence() + ">>>");
        assertThat(a.toString()).doesNotContain("one");
    }

    // ---------------------------------------------------------------- limits

    @Test
    void theLimitsCountWhatTheFilesAdd(@TempDir Path rigDir) throws Exception {
        try (Rig rig = new Rig(rigDir)) {
            // Each call here is 300 bytes and 100 tokens out: worst case 200 tokens and 300 µ$ (LlmGatewayTest). A day
            // limit of 500 µ$ allows that.
            LimitPolicy policy = new LimitPolicy(Limit.usd("0.0005"), Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE,
                    Limit.NONE, 1000);
            LlmGateway.Call call = new LlmGateway.Call("manager", "r1", Rig.KEY_ID, FakeProvider.ID);
            String plain = "x".repeat(300);
            rig.gateway.call(call, new ChatRequest(Rig.MODEL, "", List.of(ChatMessage.user(plain)), 100), policy,
                    DeltaSink.NONE);

            // The same words with 3,000 bytes of file are 1,000 tokens more in: refused, and nothing is sent.
            ChatMessage withText = ChatMessage.user(plain,
                    List.of(Attachment.text("a.txt", "Text", 3000, "y".repeat(3000), null)));
            org.assertj.core.api.Assertions.assertThatThrownBy(() -> rig.gateway.call(
                    new LlmGateway.Call("manager", "r2", Rig.KEY_ID, FakeProvider.ID),
                    new ChatRequest(Rig.MODEL, "", List.of(withText), 100), policy, DeltaSink.NONE))
                    .isInstanceOf(LimitReachedException.class);

            // A picture counts by its reserve, which bytes can't say.
            ChatMessage withPicture = ChatMessage.user(plain,
                    List.of(Attachment.image("p.png", "PNG", "image/png", 8, PIXELS.clone(), 2000)));
            org.assertj.core.api.Assertions.assertThatThrownBy(() -> rig.gateway.call(
                    new LlmGateway.Call("manager", "r3", Rig.KEY_ID, FakeProvider.ID),
                    new ChatRequest(Rig.MODEL, "", List.of(withPicture), 100), policy, DeltaSink.NONE))
                    .isInstanceOf(LimitReachedException.class);
            assertThat(rig.provider.requests()).hasSize(1);
        }
    }
}
