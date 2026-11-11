package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.tools.HostedCall;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
import com.minimalistalliance.desk.deskd.tools.HostedTool;
import com.minimalistalliance.desk.deskd.tools.RunLedger;
import com.minimalistalliance.desk.deskd.tools.ToolHost;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Tool calls on the agent socket, deskd's side (services/desk-agent/docs/proposals.md section 5, "Tool calls"): the hello
 * on each connection, a {@code tcall} answered {@code tres} or {@code terr}, and a deskd with no tools refusing one rather
 * than leaving it waiting.
 */
class AgentToolLinkTest {

    @TempDir
    Path dir;

    private AgentRig rig;

    @BeforeEach
    void start() throws Exception {
        rig = new AgentRig(dir);
    }

    @AfterEach
    void stop() throws Exception {
        rig.close();
    }

    private static Map<String, Object> tcall(long id, String tool) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "tcall");
        m.put("id", id);
        m.put("runId", "run-1");
        m.put("agentId", "manager");
        m.put("tool", tool);
        m.put("args", Map.of("path", ""));
        m.put("taint", List.of());
        return m;
    }

    @Test
    void withoutToolsACallIsRefusedAndTheLinkStays() throws Exception {
        rig.agent.sendJson(tcall(1, "files_list"));
        Map<String, Object> answer = rig.agent.next("terr");
        assertThat(answer).containsEntry("code", "unavailable");
        assertThat(rig.module.link().isConnected()).isTrue();
    }

    @Test
    void theHelloSaysWhichToolsAndACallIsAnswered() throws Exception {
        ToolHost host = new ToolHost(Clock.systemUTC(), ToolHost.ownerOnly(), () -> false, () -> true);
        host.area(HostedDecls.FILES, new HostedTool() {
            @Override
            public Look look(HostedCall call, RunLedger.Run run) {
                assertThat(call.caller()).isEqualTo(Caller.THE_OWNER);
                return Look.plain(call.args(), Map.of("kind", "file", "path", ""));
            }

            @Override
            public Result run(HostedCall call, RunLedger.Run run) {
                return Result.of(Map.of("entries", List.of()));
            }
        });
        rig.module.hostTools(host);
        rig.agent.drop();
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.agent.connections() >= 2 && rig.module.link().isConnected());
        Map<String, Object> hello;
        do {
            hello = rig.agent.next("req");
        } while (!ToolHost.HELLO.equals(hello.get("m")));
        assertThat(hello).doesNotContainKey("caller");
        @SuppressWarnings("unchecked")
        Map<String, Object> p = (Map<String, Object>) hello.get("p");
        assertThat(p.get("v")).isEqualTo(1);
        assertThat((List<Object>) (List<?>) p.get("tools")).containsExactly("files_list", "files_search", "files_read", "files_write",
                "files_mkdir", "files_move", "files_trash");

        rig.agent.sendJson(tcall(42, "files_list"));
        Map<String, Object> answer = rig.agent.next("tres");
        assertThat(answer.get("id")).isEqualTo(42);
        @SuppressWarnings("unchecked")
        Map<String, Object> r = (Map<String, Object>) answer.get("r");
        assertThat(r.get("content")).isEqualTo(Map.of("entries", List.of()));
        assertThat(r.get("risk")).isEqualTo("read");

        rig.agent.sendJson(tcall(43, "files_write"));
        Map<String, Object> refused = rig.agent.next("terr");
        assertThat(refused.get("id")).isEqualTo(43);
        assertThat(refused.get("code")).isEqualTo("forbidden");
        assertThat(refused.get("details")).isEqualTo(Map.of("reason", "approval_required"));
        assertThat(rig.module.link().isConnected()).isTrue();
    }
}
