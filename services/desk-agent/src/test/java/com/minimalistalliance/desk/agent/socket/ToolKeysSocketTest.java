package com.minimalistalliance.desk.agent.socket;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.DeskAgentApplication;
import com.minimalistalliance.desk.agent.approval.Approvals;
import com.minimalistalliance.desk.agent.approval.Verdict;
import com.minimalistalliance.desk.agent.manager.ManagerAgent;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.service.AgentService;
import com.minimalistalliance.desk.agent.service.Caller;
import com.minimalistalliance.desk.agent.testing.AgentSocketClient;
import com.minimalistalliance.desk.agent.tool.RunContext;
import com.minimalistalliance.desk.agent.tool.ToolAccess;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * deskd's link dropped while an approved write runs, over the real agent socket of the real application (durable runs'
 * seam; the draft ADR's §3, "Restarts"): desk-agent asks again on the next link with the same key and {@code retry},
 * and takes deskd's answer: the real result, or {@code interrupted} for a key deskd no longer holds. Never failed, never
 * run twice by desk-agent.
 */
class ToolKeysSocketTest {

    private static final String KEY = "0190d3c0-1234-7abc-9def-0123456789ab";

    @TempDir
    Path dir;

    private ConfigurableApplicationContext context;
    private AgentSocketClient deskd;
    private ManagerAgent.Tools tools;

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
        AgentService service = context.getBean(AgentService.class);
        // The call as a run makes it, past the gate: every app allowed, and the run's call in flight under this key.
        service.agentTools().access(ToolAccess.ALL);
        service.agentTools().keys(runId -> KEY);
        tools = service.agentTools().wrap(new ManagerAgent.RunSetup("x", ManagerAgent.Tools.NONE), "manager", false)
                .tools();
        deskd = hello(new AgentSocketClient(dir.resolve("agent.sock")));
    }

    @AfterEach
    void stop() throws Exception {
        deskd.close();
        context.close();
    }

    private static AgentSocketClient hello(AgentSocketClient client) throws Exception {
        client.call(AgentSocketServer.TOOLS_HELLO, Map.of("v", 1, "tools", List.of("files_write"), "keys",
                Map.of("ttlSec", 600)));
        return client;
    }

    private CompletableFuture<ToolResult> write() {
        Map<String, Object> args = Map.of("path", "a.md", "text", "x");
        RunContext run = RunContext.of("run-1", "manager", Caller.OWNER, null, "m-1");
        Verdict approved = new Verdict.Approved("ap-aaaaaaaaaaaaaaaaaaaa",
                Approvals.hash("manager", "run-1", "files_write", "agent", args));
        return CompletableFuture.supplyAsync(() -> {
            try {
                return tools.call(new ToolCall("c1", "files_write", args), run, approved);
            } catch (InterruptedException e) {
                throw new IllegalStateException(e);
            }
        });
    }

    /** The call goes out with its key; the link drops before deskd answers; deskd comes back. */
    private Map<String, Object> dropAndAskedAgain() throws Exception {
        Map<String, Object> first = deskd.await(m -> "tcall".equals(m.get("t")) && "files_write".equals(m.get("tool")));
        assertThat(first).containsEntry("key", KEY).doesNotContainKey("retry");
        deskd.close();
        deskd = hello(new AgentSocketClient(dir.resolve("agent.sock")));
        Map<String, Object> again = deskd.await(m -> "tcall".equals(m.get("t")) && "files_write".equals(m.get("tool")));
        assertThat(again).containsEntry("key", KEY).containsEntry("retry", true)
                .containsEntry("args", first.get("args")).containsEntry("approval", first.get("approval"));
        return again;
    }

    @Test
    void aWriteWhoseLinkDroppedGetsDeskdsResultOnTheNextLink() throws Exception {
        CompletableFuture<ToolResult> result = write();
        Map<String, Object> again = dropAndAskedAgain();
        deskd.sendJson(Map.of("t", "tres", "id", again.get("id"), "r", Map.of("content", "Saved.", "taints", List.of()),
                "taint", List.of()));
        ToolResult done = result.get(30, TimeUnit.SECONDS);
        assertThat(done.error()).isFalse();
        assertThat(done.content()).isEqualTo("Saved.");
    }

    @Test
    void aWriteWhoseKeyDeskdNoLongerHoldsIsInterruptedNotFailed() throws Exception {
        CompletableFuture<ToolResult> result = write();
        Map<String, Object> again = dropAndAskedAgain();
        deskd.sendJson(Map.of("t", "terr", "id", again.get("id"), "code", "conflict", "details",
                Map.of("reason", "key_unknown")));
        ToolResult interrupted = result.get(30, TimeUnit.SECONDS);
        assertThat(interrupted.error()).isTrue();
        assertThat(interrupted.content()).startsWith("Interrupted: key_unknown. It may or may not have happened");
    }
}
