package com.minimalistalliance.desk.agent.socket;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.DeskAgentApplication;
import com.minimalistalliance.desk.agent.service.AgentService;
import com.minimalistalliance.desk.agent.testing.AgentSocketClient;
import com.minimalistalliance.desk.agent.tool.DeskLink;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * Tool calls the other way on the agent socket ({@code docs/proposals.md} section 5, "Tool calls"): nothing before
 * deskd's hello, then {@code tcall} answered {@code tres} or {@code terr}, through the real application as it's wired.
 */
class ToolCallSocketTest {

    @TempDir
    Path dir;

    private ConfigurableApplicationContext context;
    private AgentSocketClient deskd;
    private AgentSocketServer server;

    @BeforeEach
    void boot() throws Exception {
        Files.createDirectories(dir.resolve("data"));
        context = DeskAgentApplication.application().run(
                "--desk.agent.data.dir=" + dir.resolve("data"),
                "--desk.agent.admin.socket=" + dir.resolve("admin.sock"),
                "--desk.agent.socket=" + dir.resolve("agent.sock"),
                "--desk.agent.peer.uid=" + PeerCheck.ownUid(),
                "--desk.agent.tools.off=browser_type",
                "--desk.agent.anthropic.url=http://127.0.0.1:9",
                "--desk.agent.openai.url=http://127.0.0.1:9",
                "--desk.agent.xai.url=http://127.0.0.1:9");
        server = context.getBean(AgentSocketServer.class);
        deskd = new AgentSocketClient(dir.resolve("agent.sock"));
    }

    @AfterEach
    void stop() throws Exception {
        deskd.close();
        context.close();
    }

    private static Map<String, Object> tcall(String tool) {
        Map<String, Object> call = new LinkedHashMap<>();
        call.put("runId", "run-1");
        call.put("agentId", "manager");
        call.put("tool", tool);
        call.put("args", Map.of("path", ""));
        call.put("taint", List.of("S"));
        return call;
    }

    @Test
    void nothingGoesBeforeTheHelloThenACallIsAnsweredInTurn() throws Exception {
        // An older deskd says no hello, and drops the link on a t it doesn't know: none is sent.
        assertThat(server.offered()).isEmpty();
        assertThat(server.call(tcall("files_list"), Duration.ofSeconds(1))).isEqualTo(DeskLink.Reply.unavailable());

        Map<String, Object> hello = deskd.call(AgentSocketServer.TOOLS_HELLO, Map.of("v", 1, "tools",
                List.of("files_list", "files_write", "Not A Name", "browser_type")));
        assertThat(hello.get("t")).isEqualTo("res");
        assertThat(server.offered()).containsExactlyInAnyOrder("files_list", "files_write", "browser_type");
        // The service sees it, and the setting switched one off: offered, never in a run's tools.
        AgentService service = context.getBean(AgentService.class);
        assertThat(service.agentTools().registry().switchedOff("browser_type")).isTrue();

        CompletableFuture<DeskLink.Reply> answer = CompletableFuture.supplyAsync(() -> {
            try {
                return server.call(tcall("files_list"), Duration.ofSeconds(10));
            } catch (InterruptedException e) {
                throw new IllegalStateException(e);
            }
        });
        Map<String, Object> frame = deskd.await(m -> "tcall".equals(m.get("t")));
        assertThat(frame).containsEntry("tool", "files_list").containsEntry("runId", "run-1")
                .containsEntry("agentId", "manager").containsEntry("taint", List.of("S"));
        deskd.sendJson(Map.of("t", "tres", "id", frame.get("id"), "r", Map.of("content", Map.of("entries", List.of()),
                "taints", List.of("S")), "taint", List.of("S")));
        DeskLink.Reply reply = answer.get(10, TimeUnit.SECONDS);
        assertThat(reply.ok()).isTrue();
        assertThat(reply.taint()).containsExactly("S");

        CompletableFuture<DeskLink.Reply> refused = CompletableFuture.supplyAsync(() -> {
            try {
                return server.call(tcall("files_write"), Duration.ofSeconds(10));
            } catch (InterruptedException e) {
                throw new IllegalStateException(e);
            }
        });
        Map<String, Object> second = deskd.await(m -> "tcall".equals(m.get("t")) && "files_write".equals(m.get("tool")));
        deskd.sendJson(Map.of("t", "terr", "id", second.get("id"), "code", "forbidden", "details",
                Map.of("reason", "approval_required")));
        DeskLink.Reply no = refused.get(10, TimeUnit.SECONDS);
        assertThat(no.ok()).isFalse();
        assertThat(no.code()).isEqualTo("forbidden");
        assertThat(no.reason()).isEqualTo("approval_required");
    }

    @Test
    void aHelloWithACallerIsRefusedAndACallWaitingWhenDeskdGoesFails() throws Exception {
        Map<String, Object> forged = deskd.call(AgentSocketServer.TOOLS_HELLO, Map.of("tools", List.of("files_list")),
                Map.of("kind", "owner"));
        assertThat(forged.get("t")).isEqualTo("err");
        assertThat(server.offered()).isEmpty();

        deskd.call(AgentSocketServer.TOOLS_HELLO, Map.of("v", 1, "tools", List.of("files_list")));
        CompletableFuture<DeskLink.Reply> waiting = CompletableFuture.supplyAsync(() -> {
            try {
                return server.call(tcall("files_list"), Duration.ofSeconds(30));
            } catch (InterruptedException e) {
                throw new IllegalStateException(e);
            }
        });
        deskd.await(m -> "tcall".equals(m.get("t")));
        deskd.close();
        assertThat(waiting.get(10, TimeUnit.SECONDS)).isEqualTo(DeskLink.Reply.unavailable());
        assertThat(server.offered()).isEqualTo(Set.of());
    }
}
