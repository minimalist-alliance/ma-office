package com.minimalistalliance.desk.agent.socket;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.DeskAgentApplication;
import com.minimalistalliance.desk.agent.maia.DocReader;
import com.minimalistalliance.desk.agent.testing.AgentSocketClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * Documents' reader request over the real application's agent socket (deskd API.md §25): {@code desk.docs.read} is
 * deskd's own, never relayed for a client, so a frame that carries a caller is refused whoever it names; deskd's own
 * reaches the reader, which skips while Desk Maia isn't active on the desk (as on a fresh one).
 */
class DocReadSocketTest {

    @TempDir
    Path dir;

    private ConfigurableApplicationContext context;
    private AgentSocketClient deskd;

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
        deskd = new AgentSocketClient(dir.resolve("agent.sock"));
    }

    @AfterEach
    void stop() throws Exception {
        deskd.close();
        context.close();
    }

    private static Map<String, Object> request() {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("docId", "d_01JC8Z3K4M5N6P7Q8R9S0T1V2W");
        p.put("versionSha256", "0123456789abcdef".repeat(4));
        p.put("title", "12 Nov · Rosa Ortiz · Contract");
        p.put("pages", List.of(Map.of("n", 1, "text", "Services agreement. Sign on page 1.")));
        return p;
    }

    @Test
    void aFrameWithACallerIsRefusedWhoeverItNames() throws Exception {
        List<Map<String, Object>> callers = List.of(Map.of("kind", "owner"), Map.of("kind", "system"),
                Map.of("kind", "guild_member", "memberId", "gm-aaaa0001", "role", "member", "grants", List.of(),
                        "teen", false),
                Map.of("kind", "guild_member", "memberId", "gm-bbbb0001", "role", "officer", "grants", List.of(),
                        "teen", false));
        for (Map<String, Object> caller : callers) {
            Map<String, Object> refused = deskd.call(DocReader.METHOD, request(), caller);
            assertThat(refused).as(caller.toString()).containsEntry("t", "err").containsEntry("code", "forbidden");
            assertThat(refused.get("details")).as(caller.toString()).isEqualTo(Map.of("reason", "permission"));
        }
        // A malformed caller is refused too, never read as no caller.
        Map<String, Object> odd = deskd.call(DocReader.METHOD, request(), Map.of("kind", "nobody"));
        assertThat(odd).containsEntry("t", "err").containsEntry("code", "forbidden");
    }

    @Test
    void deskdsOwnRequestReachesTheReaderWhichSkipsWhileMaiaIsOff() throws Exception {
        Map<String, Object> got = deskd.call(DocReader.METHOD, request());
        assertThat(got).containsEntry("t", "res");
        assertThat(got.get("r")).isEqualTo(Map.of("skipped", "maia_off"));
        // Whatever the request holds: with her off, nothing is read and nothing is checked further.
        Map<String, Object> bad = request();
        bad.put("pages", "not pages");
        assertThat(deskd.call(DocReader.METHOD, bad).get("r")).isEqualTo(Map.of("skipped", "maia_off"));
    }
}
