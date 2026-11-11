package com.minimalistalliance.desk.agent;

import static com.minimalistalliance.desk.agent.testing.AgentSocketClient.ascii;
import static com.minimalistalliance.desk.agent.testing.AgentSocketClient.map;
import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.socket.PeerCheck;
import com.minimalistalliance.desk.agent.testing.AgentSocketClient;
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
 * The "$0 first Agent run" end to end, as deskd relays it: the real application, its agent socket and the real
 * OpenRouter adapter against a local stand-in. An OpenRouter key comes in through {@code agent.key.add} like any
 * other, lists the free models with the best first, and its first run costs $0; today's free limit ends a reply with
 * its own word.
 */
class OpenRouterSocketTest {

    @TempDir
    Path dir;

    private FakeOpenRouter openrouter;
    private ConfigurableApplicationContext context;
    private AgentSocketClient desk;

    @BeforeEach
    void boot() throws Exception {
        openrouter = new FakeOpenRouter();
        Files.createDirectories(dir.resolve("data"));
        context = DeskAgentApplication.application().run(
                "--desk.agent.data.dir=" + dir.resolve("data"),
                "--desk.agent.admin.socket=" + dir.resolve("admin.sock"),
                "--desk.agent.socket=" + dir.resolve("agent.sock"),
                "--desk.agent.peer.uid=" + PeerCheck.ownUid(),
                "--desk.agent.anthropic.url=http://127.0.0.1:9",
                "--desk.agent.openai.url=http://127.0.0.1:9",
                "--desk.agent.xai.url=http://127.0.0.1:9",
                "--desk.agent.openrouter.url=" + openrouter.url());
        desk = new AgentSocketClient(dir.resolve("agent.sock"));
    }

    @AfterEach
    void stop() throws Exception {
        desk.close();
        context.close();
        openrouter.close();
    }

    @Test
    void anOpenRouterKeysFirstRunIsFree() throws Exception {
        assertThat(result(desk.call("agent.providers", Map.of())).get("providers")).asList()
                .contains(Map.of("id", "openrouter", "name", "OpenRouter", "console", "openrouter.ai",
                        "keyPrefix", "sk-or-"));

        // An OpenRouter key picked as OpenAI's never leaves the desk: sk-or- is longer than sk-.
        assertThat(desk.addKey("openai", "Wrong", ascii(FakeOpenRouter.KEY)))
                .containsEntry("details", Map.of("reason", "key_malformed", "detail", "provider_mismatch"));
        // Nor do OpenAI's and Anthropic's picked as OpenRouter's.
        for (String other : new String[] {"sk-proj-fake-0123456789abcdef", "sk-ant-api03-fake-0123456789abcdef"}) {
            assertThat(desk.addKey("openrouter", "Wrong", ascii(other)))
                    .containsEntry("details", Map.of("reason", "key_malformed", "detail", "provider_mismatch"));
        }
        assertThat(openrouter.requests).isEmpty();

        Map<String, Object> key = map(result(desk.addKey("openrouter", "", ascii(FakeOpenRouter.KEY))).get("key"));
        assertThat(key).containsEntry("provider", "openrouter").containsEntry("providerName", "OpenRouter")
                .containsEntry("label", "OpenRouter").containsEntry("available", true);
        String keyId = (String) key.get("keyId");
        assertThat(openrouter.requests).anySatisfy(r -> {
            assertThat(r.path()).isEqualTo("/api/v1/key");
            assertThat(r.authorization()).isEqualTo("Bearer " + FakeOpenRouter.KEY);
        });
        try (Stream<Path> files = Files.walk(dir.resolve("data"))) {
            for (Path file : files.filter(Files::isRegularFile).toList()) {
                assertThat(new String(Files.readAllBytes(file), java.nio.charset.StandardCharsets.ISO_8859_1))
                        .as(file.toString()).doesNotContain(FakeOpenRouter.KEY);
            }
        }

        List<?> models = (List<?>) result(desk.call("agent.key.models", Map.of("keyId", keyId))).get("models");
        assertThat(map(models.getFirst())).containsEntry("id", "nvidia/nemotron-3.5-super-vl:free")
                .containsEntry("free", true).containsEntry("tools", true)
                .containsEntry("inputMicroUsdPerMTok", 0).containsEntry("outputMicroUsdPerMTok", 0);
        assertThat(models).filteredOn(m -> "acme/chatty:free".equals(map(m).get("id"))).singleElement()
                .satisfies(m -> assertThat(map(m)).containsEntry("tools", false).containsEntry("free", true));
        assertThat(models).noneSatisfy(m -> assertThat(map(m).get("id")).isEqualTo("acme/paid-model"));

        result(desk.call("agent.bind", Map.of("agentId", "manager", "keyId", keyId,
                "model", "nvidia/nemotron-3.5-super-vl:free")));
        desk.subscribe(2, "agent.conversation:manager");
        desk.event(2, "snapshot");

        result(desk.call("agent.message.send", Map.of("agentId", "manager", "text", "Hello?")));
        Map<String, Object> done = finalReply();
        assertThat(done).containsEntry("state", "done").containsEntry("text", "Hello from the stand-in.")
                .containsEntry("costMicroUsd", 0).containsEntry("error", null);
        assertThat(map(done.get("badge"))).isEqualTo(Map.of("provider", "openrouter", "providerName", "OpenRouter",
                "model", "nvidia/nemotron-3.5-super-vl:free"));
        // The run had tools and the model takes them, so they went.
        assertThat(openrouter.chatBodies().getLast()).containsKey("tools");

        openrouter.then(FakeOpenRouter.Reply.error(429, "Rate limit exceeded: free-models-per-day",
                Map.of("X-RateLimit-Limit", "50", "X-RateLimit-Remaining", "0")));
        result(desk.call("agent.message.send", Map.of("agentId", "manager", "text", "Again?")));
        Map<String, Object> failed = finalReply();
        assertThat(failed).containsEntry("state", "failed").containsEntry("error", "provider_error")
                .containsEntry("errorDetail", "free_limit");
        Map<String, Object> agent = map(((List<?>) result(desk.call("agent.list", Map.of())).get("agents")).get(0));
        assertThat(agent.get("status")).isEqualTo("online");
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
