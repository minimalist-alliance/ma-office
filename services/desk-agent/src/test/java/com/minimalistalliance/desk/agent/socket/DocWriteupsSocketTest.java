package com.minimalistalliance.desk.agent.socket;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.DeskAgentApplication;
import com.minimalistalliance.desk.agent.maia.AwayStore;
import com.minimalistalliance.desk.agent.service.AgentService;
import com.minimalistalliance.desk.agent.store.AgentStore;
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
 * Documents' write-ups over the real application's agent socket (deskd API.md §25 "Intake"): {@code desk.docs.writeups} is
 * deskd's own, never relayed for a client, so a frame that carries a caller is refused whoever it names; deskd's own reads
 * the write-ups kept here after a cursor, one by its id, or the ids still kept, each saying whether it may be read.
 */
class DocWriteupsSocketTest {

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

    @Test
    void aFrameWithACallerIsRefusedWhoeverItNames() throws Exception {
        List<Map<String, Object>> callers = List.of(Map.of("kind", "owner"), Map.of("kind", "system"),
                Map.of("kind", "guild_member", "memberId", "gm-aaaa0001", "role", "officer", "grants", List.of(),
                        "teen", false));
        for (Map<String, Object> caller : callers) {
            Map<String, Object> refused = deskd.call(AgentService.DOCS_WRITEUPS, Map.of("kept", true), caller);
            assertThat(refused).as(caller.toString()).containsEntry("t", "err").containsEntry("code", "forbidden");
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void deskdReadsTheWriteUpsKeptHereByCursorByIdAndTheIdsKept() throws Exception {
        AwayStore kept = new AwayStore(context.getBean(AgentStore.class));
        String first = kept.saveWriteUp("env-1", "scout", "d-home", "Quotes compared: plan B is cheapest.", 1_000L);
        kept.markWriteUp(first, false);
        String second = kept.saveWriteUp("env-2", "keeper", "d-home", "x".repeat(250_000), 2_000L);

        Map<String, Object> all = deskd.call(AgentService.DOCS_WRITEUPS, Map.of());
        assertThat(all).containsEntry("t", "res");
        List<Map<String, Object>> items = (List<Map<String, Object>>) ((Map<String, Object>) all.get("r")).get("items");
        assertThat(items).extracting(i -> i.get("id")).containsExactly(first, second);
        assertThat(((Number) items.get(0).get("at")).longValue()).isEqualTo(1_000L);
        assertThat(items.get(0)).containsEntry("agentId", "scout").containsEntry("readable", true)
                .containsEntry("text", "Quotes compared: plan B is cheapest.");
        // Private until its answer's call says otherwise; cut to Documents' length.
        assertThat(items.get(1)).containsEntry("readable", false);
        assertThat((String) items.get(1).get("text")).hasSize(200_000);

        Map<String, Object> after = new LinkedHashMap<>();
        after.put("after", 1_000L);
        after.put("afterId", first);
        after.put("limit", 5);
        List<Map<String, Object>> rest = (List<Map<String, Object>>) ((Map<String, Object>) deskd
                .call(AgentService.DOCS_WRITEUPS, after).get("r")).get("items");
        assertThat(rest).extracting(i -> i.get("id")).containsExactly(second);

        List<Map<String, Object>> one = (List<Map<String, Object>>) ((Map<String, Object>) deskd
                .call(AgentService.DOCS_WRITEUPS, Map.of("id", first)).get("r")).get("items");
        assertThat(one).extracting(i -> i.get("id")).containsExactly(first);
        assertThat((Map<String, Object>) deskd.call(AgentService.DOCS_WRITEUPS, Map.of("id", "../etc"))).containsEntry("t", "err");

        Map<String, Object> ids = (Map<String, Object>) deskd.call(AgentService.DOCS_WRITEUPS, Map.of("kept", true)).get("r");
        assertThat((List<String>) ids.get("kept")).containsExactly(first, second);
        assertThat((List<String>) ids.get("readable")).containsExactly(first);
    }
}
