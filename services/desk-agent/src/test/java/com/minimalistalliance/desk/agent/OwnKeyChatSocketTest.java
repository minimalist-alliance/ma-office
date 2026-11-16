package com.minimalistalliance.desk.agent;

import static com.minimalistalliance.desk.agent.testing.AgentSocketClient.ascii;
import static com.minimalistalliance.desk.agent.testing.AgentSocketClient.map;
import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.socket.PeerCheck;
import com.minimalistalliance.desk.agent.testing.AgentSocketClient;
import com.minimalistalliance.desk.agent.testing.FakeChatServer;
import com.minimalistalliance.desk.agent.testing.FakeOpenRouter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * Google's and Moonshot AI's own keys end to end, as deskd relays them: the real application, its agent socket and the
 * real Chat Completions adapter against local stand-ins. Each key comes in through {@code agent.key.add}, is checked by
 * the provider's model list, lists its chat models, binds and answers; the key-prefix check keeps each provider's key
 * from going to another's API.
 */
class OwnKeyChatSocketTest {

    @TempDir
    Path dir;

    private FakeChatServer gemini;
    private FakeChatServer kimi;
    private ConfigurableApplicationContext context;
    private AgentSocketClient desk;

    @BeforeEach
    void boot() throws Exception {
        gemini = new FakeChatServer("/v1beta/openai", FakeChatServer.GOOGLE_KEY);
        gemini.models = FakeChatServer.list("models/gemini-2.5-flash", "models/text-embedding-004",
                "models/gemini-4-argon");
        kimi = new FakeChatServer("/v1", FakeChatServer.MOONSHOT_KEY);
        kimi.models = FakeChatServer.list("moonshot-v1-8k", "kimi-k3.1-pro");
        Files.createDirectories(dir.resolve("data"));
        context = DeskAgentApplication.application().run(
                "--desk.agent.data.dir=" + dir.resolve("data"),
                "--desk.agent.admin.socket=" + dir.resolve("admin.sock"),
                "--desk.agent.socket=" + dir.resolve("agent.sock"),
                "--desk.agent.peer.uid=" + PeerCheck.ownUid(),
                "--desk.agent.anthropic.url=http://127.0.0.1:9",
                "--desk.agent.openai.url=http://127.0.0.1:9",
                "--desk.agent.xai.url=http://127.0.0.1:9",
                "--desk.agent.openrouter.url=http://127.0.0.1:9",
                "--desk.agent.google.url=" + gemini.url(),
                "--desk.agent.moonshot.url=" + kimi.url());
        desk = new AgentSocketClient(dir.resolve("agent.sock"));
    }

    @AfterEach
    void stop() throws Exception {
        desk.close();
        context.close();
        gemini.close();
        kimi.close();
    }

    @Test
    void googleAndMoonshotKeysAreListedCheckedAndAnswer() throws Exception {
        assertThat(result(desk.call("agent.providers", Map.of())).get("providers")).asList().contains(
                Map.of("id", "google", "name", "Google", "console", "aistudio.google.com", "keyPrefix", "AIza"),
                Map.of("id", "moonshot", "name", "Moonshot AI", "console", "platform.kimi.ai", "keyPrefix", "sk-"));

        // A Gemini key picked as OpenAI's, and OpenRouter's or Anthropic's picked as Moonshot's, never leave the desk.
        assertThat(desk.addKey("openai", "Wrong", ascii(FakeChatServer.GOOGLE_KEY)))
                .containsEntry("details", Map.of("reason", "key_malformed", "detail", "provider_mismatch"));
        for (String other : new String[] {FakeOpenRouter.KEY, "sk-ant-api03-fake-0123456789abcdef"}) {
            assertThat(desk.addKey("moonshot", "Wrong", ascii(other)))
                    .containsEntry("details", Map.of("reason", "key_malformed", "detail", "provider_mismatch"));
        }
        assertThat(desk.addKey("google", "Wrong", ascii(FakeChatServer.MOONSHOT_KEY)))
                .containsEntry("details", Map.of("reason", "key_malformed", "detail", "provider_mismatch"));
        // OpenAI's project, service-account and admin keys are its alone, though Moonshot AI shares its sk- (PC-L1).
        for (String openai : new String[] {"sk-proj-fake-0123456789abcdef", "sk-svcacct-fake-0123456789abcdef",
                "sk-admin-fake-0123456789abcdef"}) {
            assertThat(desk.addKey("moonshot", "Wrong", ascii(openai)))
                    .containsEntry("details", Map.of("reason", "key_malformed", "detail", "provider_mismatch"));
        }
        assertThat(gemini.requests).isEmpty();
        assertThat(kimi.requests).isEmpty();

        // A key the provider refuses is refused, and not kept.
        assertThat(desk.addKey("moonshot", "", ascii("sk-not-the-right-one-0123456789abcdef")))
                .containsEntry("details", Map.of("reason", "key_refused", "detail", "auth"));

        Map<String, Object> google = map(result(desk.addKey("google", "", ascii(FakeChatServer.GOOGLE_KEY))).get("key"));
        assertThat(google).containsEntry("provider", "google").containsEntry("providerName", "Google")
                .containsEntry("label", "Google").containsEntry("available", true);
        // Moonshot's sk- is OpenAI's too: the same length, so picking Moonshot is a match.
        Map<String, Object> moonshot =
                map(result(desk.addKey("moonshot", "", ascii(FakeChatServer.MOONSHOT_KEY))).get("key"));
        assertThat(moonshot).containsEntry("provider", "moonshot").containsEntry("providerName", "Moonshot AI");
        assertThat(gemini.requests).anySatisfy(r -> {
            assertThat(r.path()).isEqualTo("/v1beta/openai/models");
            assertThat(r.authorization()).isEqualTo("Bearer " + FakeChatServer.GOOGLE_KEY);
        });
        try (Stream<Path> files = Files.walk(dir.resolve("data"))) {
            for (Path file : files.filter(Files::isRegularFile).toList()) {
                String text = new String(Files.readAllBytes(file), java.nio.charset.StandardCharsets.ISO_8859_1);
                assertThat(text).as(file.toString()).doesNotContain(FakeChatServer.GOOGLE_KEY)
                        .doesNotContain(FakeChatServer.MOONSHOT_KEY);
            }
        }

        String googleKey = (String) google.get("keyId");
        List<?> models = (List<?>) result(desk.call("agent.key.models", Map.of("keyId", googleKey))).get("models");
        assertThat(models).extracting(m -> map(m).get("id")).containsExactly("gemini-4-argon", "gemini-2.5-flash");
        // Not in the price table yet: no listed price, so a call counts at the table's highest (ADR 0043).
        assertThat(map(models.getFirst())).containsEntry("inputMicroUsdPerMTok", null).containsEntry("free", false)
                .containsEntry("tools", true);
        List<?> kimiModels = (List<?>) result(desk.call("agent.key.models",
                Map.of("keyId", moonshot.get("keyId")))).get("models");
        assertThat(kimiModels).extracting(m -> map(m).get("id")).containsExactly("kimi-k3.1-pro", "moonshot-v1-8k");

        result(desk.call("agent.bind", Map.of("agentId", "manager", "keyId", googleKey, "model", "gemini-4-argon")));
        result(desk.call("agent.access.set", com.minimalistalliance.desk.agent.testing.Setups.defaults("manager")));
        desk.subscribe(2, "agent.conversation:manager");
        desk.event(2, "snapshot");
        gemini.then(FakeChatServer.answer("gemini-4-argon", 1200, 30, "Hello", " from Gemini."));
        result(desk.call("agent.message.send", Map.of("agentId", "manager", "text", "Hello?")));
        Map<String, Object> done = finalReply();
        assertThat(done).containsEntry("state", "done").containsEntry("text", "Hello from Gemini.")
                .containsEntry("error", null);
        assertThat(map(done.get("badge"))).isEqualTo(Map.of("provider", "google", "providerName", "Google",
                "model", "gemini-4-argon"));
        Map<String, Object> body = gemini.chatBodies().getLast();
        assertThat(body).containsKey("tools").containsEntry("stream_options", Map.of("include_usage", true));
    }

    private Map<String, Object> finalReply() throws Exception {
        while (true) {
            Map<String, Object> event = desk.event(2, "message");
            Map<String, Object> message = map(map(event.get("data")).get("message"));
            if ("assistant".equals(message.get("role")) && !"streaming".equals(message.get("state"))) {
                return message;
            }
        }
    }

    private static Map<String, Object> result(Map<String, Object> reply) {
        assertThat(reply).as("reply").containsEntry("t", "res");
        return map(reply.get("r"));
    }
}
