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
        // It went, and no answer came: it may have run, which a call never sent can't have (durable runs' seam).
        DeskLink.Reply lost = waiting.get(10, TimeUnit.SECONDS);
        assertThat(lost).isEqualTo(DeskLink.Reply.noAnswer());
        assertThat(lost.lost()).isTrue();
        assertThat(DeskLink.Reply.unavailable().lost()).isFalse();
        assertThat(server.offered()).isEqualTo(Set.of());
    }

    /**
     * deskd's hello says whether it keeps calls' replies by their key; only then may a call with no answer be asked
     * again. A call whose wait runs out got no answer either; a hello from an older deskd keeps nothing.
     */
    @Test
    void aHelloWithKeysLetsACallBeAskedAgainAndAWaitThatRunsOutIsNoAnswer() throws Exception {
        deskd.call(AgentSocketServer.TOOLS_HELLO, Map.of("v", 1, "tools", List.of("files_write")));
        assertThat(server.keyed()).isFalse();
        deskd.call(AgentSocketServer.TOOLS_HELLO, Map.of("v", 1, "tools", List.of("files_write"), "keys",
                Map.of("ttlSec", 600)));
        assertThat(server.keyed()).isTrue();

        Map<String, Object> call = tcall("files_write");
        call.put("key", "0190d3c0-0000-7000-8000-000000000001");
        CompletableFuture<DeskLink.Reply> unanswered = CompletableFuture.supplyAsync(() -> {
            try {
                return server.call(call, Duration.ofMillis(300));
            } catch (InterruptedException e) {
                throw new IllegalStateException(e);
            }
        });
        Map<String, Object> frame = deskd.await(m -> "tcall".equals(m.get("t")));
        assertThat(frame).containsEntry("key", "0190d3c0-0000-7000-8000-000000000001");
        assertThat(unanswered.get(10, TimeUnit.SECONDS).lost()).isTrue();
        // deskd's own frames can't pass for a lost call: a t it doesn't know drops the link.
        assertThat(AgentSocketServer.replyOf(Map.of("t", "terr", "code", "unavailable", "details",
                Map.of("reason", "unavailable"))).lost()).isFalse();
        deskd.close();
        org.awaitility.Awaitility.await().atMost(Duration.ofSeconds(10)).until(() -> !server.keyed());
    }

    /**
     * deskd's hello offers Desk Maia's model ({@code maia: {model: true}}, API.md §23, "Her model"): only then does a
     * {@code maia_model} call go, even with no other tool offered; its refusal's details come back in their shape only.
     */
    @Test
    void aHelloOfferingHerModelLetsHerCallsGoAndTheirRefusalsCarryTheirDetails() throws Exception {
        Map<String, Object> call = new LinkedHashMap<>();
        call.put("agentId", "maia");
        call.put("tool", "maia_model");
        call.put("args", Map.of("task", "turn"));
        call.put("taint", List.of());
        deskd.call(AgentSocketServer.TOOLS_HELLO, Map.of("v", 1, "tools", List.of()));
        assertThat(server.maiaModel()).isFalse();
        assertThat(server.call(call, Duration.ofSeconds(1))).isEqualTo(DeskLink.Reply.unavailable());
        // An older desk-agent ignores the field; this one hears it, and other tools still need their own offer.
        deskd.call(AgentSocketServer.TOOLS_HELLO, Map.of("v", 1, "tools", List.of(), "maia", Map.of("model", true)));
        assertThat(server.maiaModel()).isTrue();
        assertThat(server.call(tcall("files_list"), Duration.ofSeconds(1))).isEqualTo(DeskLink.Reply.unavailable());
        CompletableFuture<DeskLink.Reply> answer = CompletableFuture.supplyAsync(() -> {
            try {
                return server.call(call, Duration.ofSeconds(10));
            } catch (InterruptedException e) {
                throw new IllegalStateException(e);
            }
        });
        Map<String, Object> frame = deskd.await(m -> "tcall".equals(m.get("t")) && "maia_model".equals(m.get("tool")));
        assertThat(frame).containsEntry("agentId", "maia");
        deskd.sendJson(Map.of("t", "terr", "id", frame.get("id"), "code", "limit", "details", Map.of("reason",
                "limit_personal", "window", "week", "resetsAt", "2026-11-16T07:00:00.000Z", "retryAfterSec", 3.5,
                "spent", 99)));
        DeskLink.Reply reply = answer.get(10, TimeUnit.SECONDS);
        assertThat(reply.code()).isEqualTo("limit");
        assertThat(reply.reason()).isEqualTo("limit_personal");
        assertThat(reply.details()).containsOnlyKeys("window", "resetsAt", "retryAfterSec")
                .containsEntry("window", "week").containsEntry("resetsAt", "2026-11-16T07:00:00.000Z")
                .containsEntry("retryAfterSec", 4L);
        assertThat(AgentSocketServer.moreDetails(Map.of("window", "year", "resetsAt", "soon", "retryAfterSec", -1)))
                .isEmpty();
        // A hello without it takes it back.
        deskd.call(AgentSocketServer.TOOLS_HELLO, Map.of("v", 1, "tools", List.of("files_list")));
        assertThat(server.maiaModel()).isFalse();
        deskd.call(AgentSocketServer.TOOLS_HELLO, Map.of("v", 1, "tools", List.of(), "maia", Map.of("model", true)));
        deskd.close();
        org.awaitility.Awaitility.await().atMost(Duration.ofSeconds(10)).until(() -> !server.maiaModel());
    }
}
