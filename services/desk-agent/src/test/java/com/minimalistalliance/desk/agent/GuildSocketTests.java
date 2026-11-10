package com.minimalistalliance.desk.agent;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.socket.PeerCheck;
import com.minimalistalliance.desk.agent.testing.AgentSocketClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.context.ConfigurableApplicationContext;

/** The caller deskd adds, through the real application's agent socket: requests, subscriptions, and a bad one. */
class GuildSocketTests {

    private static final Map<String, Object> A =
            Map.of("kind", "guild_member", "memberId", "gm-aaaa0001", "role", "member", "grants", List.of(), "teen", false);
    private static final Map<String, Object> B =
            Map.of("kind", "guild_member", "memberId", "gm-bbbb0001", "role", "member", "grants", List.of(), "teen", false);

    @TempDir
    Path dir;

    private ConfigurableApplicationContext context;
    private AgentSocketClient desk;

    @BeforeEach
    void boot() throws Exception {
        Files.createDirectories(dir.resolve("data"));
        context = DeskAgentApplication.application().run(
                "--desk.agent.data.dir=" + dir.resolve("data"),
                "--desk.agent.admin.socket=" + dir.resolve("admin.sock"),
                "--desk.agent.socket=" + dir.resolve("agent.sock"),
                "--desk.agent.peer.uid=" + PeerCheck.ownUid(),
                "--desk.agent.anthropic.url=http://127.0.0.1:9",
                "--desk.agent.openai.url=http://127.0.0.1:9",
                "--desk.agent.xai.url=http://127.0.0.1:9");
        desk = new AgentSocketClient(dir.resolve("agent.sock"));
    }

    @AfterEach
    void stop() throws Exception {
        desk.close();
        context.close();
    }

    @Test
    void eachMemberGetsTheirOwnAgentOverTheSocket() throws Exception {
        Map<String, Object> a = desk.call("agent.list", Map.of(), A);
        assertThat(a.toString()).contains("gm-aaaa0001").doesNotContain("gm-bbbb0001").doesNotContain("id=manager");
        Map<String, Object> b = desk.call("agent.list", Map.of(), B);
        assertThat(b.toString()).contains("gm-bbbb0001").doesNotContain("gm-aaaa0001");
        Map<String, Object> peek = desk.call("agent.thread.get", Map.of("agentId", "gm-aaaa0001"), B);
        assertThat(peek).containsEntry("t", "err").containsEntry("code", "not_found");
        // With no caller it's the owner, as from a deskd before guilds: the owner's view has no member in it.
        assertThat(desk.call("agent.list", Map.of()).toString()).contains("id=manager").doesNotContain("gm-");
    }

    @Test
    void subscriptionsAreForTheirCaller() throws Exception {
        desk.call("agent.list", Map.of(), A);
        desk.call("agent.list", Map.of(), B);
        desk.subscribe(1, "agent.state", A);
        Map<String, Object> snapshot = desk.event(1, "snapshot");
        assertThat(snapshot.toString()).contains("gm-aaaa0001").doesNotContain("gm-bbbb0001");
        desk.subscribe(2, "agent.conversation:gm-aaaa0001", B);
        assertThat(desk.event(2, "error").toString()).contains("not_found");
        desk.subscribe(3, "agent.state", Map.of("kind", "system"));
        assertThat(desk.event(3, "snapshot").toString()).contains("gm-aaaa0001").contains("gm-bbbb0001");
        desk.subscribe(4, "agent.state", Map.of("kind", "guild_member", "memberId", "gm-cccc0001", "teen", true));
        assertThat(desk.event(4, "error").toString()).contains("age_band");
    }

    @Test
    void aMalformedCallerIsRefusedNeverReadAsTheOwner() throws Exception {
        Map<String, Object> reply = desk.call("agent.list", Map.of(), Map.of("kind", "guild_member", "memberId", "nobody"));
        assertThat(reply).containsEntry("t", "err").containsEntry("code", "forbidden");
        assertThat(reply.get("details").toString()).contains("caller");
    }
}
