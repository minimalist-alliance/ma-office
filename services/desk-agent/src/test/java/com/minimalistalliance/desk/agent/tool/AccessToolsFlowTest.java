package com.minimalistalliance.desk.agent.tool;

import static com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.m;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.approval.Approvals;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The member's choices of apps through a real run (draft ADR "the Agent's tools and approvals", section 16): only the
 * apps on are offered, a switch turned off mid-run takes the app's tools from the very next step and refuses a call to
 * one before anything is asked or reaches deskd, a card already asked can't run after its app went, and deskd saying it
 * holds no record makes the agent wait for the member.
 */
class AccessToolsFlowTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);

    @TempDir
    Path data;

    private final MutableClock clock = new MutableClock(Rig.START);
    private final FakeDeskLink deskd = new FakeDeskLink();
    private TeamDesk desk;
    private String a;

    @BeforeEach
    void start() throws Exception {
        desk = new TeamDesk(data, clock);
        desk.service.deskLink(deskd);
        a = desk.agent("Alice");
    }

    @AfterEach
    void stop() {
        desk.close();
    }

    private void apps(Object... pairs) throws Exception {
        Map<String, Object> p = m("agentId", a, "apps", m(pairs));
        desk.service.call("agent.access.set", p);
    }

    private static boolean anyOf(List<String> names, String prefix) {
        return names.stream().anyMatch(name -> name.startsWith(prefix));
    }

    @Test
    void onlyTheAppsTheMemberLetsItUseAreOffered() throws Exception {
        apps("files", false, "browser", false);
        desk.ask(a, "Hello");
        List<String> names = TeamDesk.toolNames(desk.lastRequest());
        assertThat(anyOf(names, "files_")).isFalse();
        assertThat(anyOf(names, "browser_")).isFalse();
        assertThat(names).contains("notebook_read", "notebook_write", "plan_update", "follow_up");
        // The run's instructions don't offer what it hasn't got.
        assertThat(desk.lastRequest().system()).doesNotContain("the member's Files").doesNotContain("a web browser");
    }

    @Test
    void switchingAnAppOffMidRunTakesItsToolsFromTheNextStepAndRefusesACallBeforeAnythingIsAsked() throws Exception {
        // The first files_list runs; while it does, the member switches Files off in the agent's settings.
        deskd.runs.put("files_list", call -> {
            try {
                apps("files", false);
            } catch (Exception e) {
                throw new AssertionError(e);
            }
            return FakeDeskLink.ok(Map.of("content", "a.txt"), List.of("S"));
        });
        desk.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "files_list", "path", ""))))
                .then(Step.calls(USAGE, List.of(Step.call("c2", "files_list", "path", ""),
                        Step.call("c3", "files_write", "path", "x.md", "text", "x"))))
                .then(Step.answer(USAGE, "Files is off now."));
        Map<String, Object> reply = desk.ask(a, "Look in my Files twice.");
        assertThat(reply.get("state")).isEqualTo("done");

        List<ChatRequest> requests = desk.requests();
        assertThat(anyOf(TeamDesk.toolNames(requests.get(0)), "files_")).isTrue();
        // The very next step has no Files tools.
        assertThat(anyOf(TeamDesk.toolNames(requests.get(1)), "files_")).isFalse();
        assertThat(anyOf(TeamDesk.toolNames(requests.get(1)), "notebook_")).isTrue();
        List<ToolResult> results = TeamDesk.toolResults(requests.get(2));
        assertThat(results.get(1).content()).isEqualTo("Not allowed: scope.");
        assertThat(results.get(2).content()).isEqualTo("Not allowed: scope.");
        // Refused before anything: no look at deskd, no card, one run of the first call only.
        assertThat(deskd.runsOf("files_list")).hasSize(1);
        assertThat(deskd.calls.stream().filter(c -> "files_write".equals(c.get("tool")))).isEmpty();
        assertThat(list(desk.call("agent.approvals.list", "agentId", a, "state", "all").get("approvals"))).isEmpty();
        assertThat(desk.audit.readBefore(null, 200).stream().filter(row -> row.entry().action().equals("tool.call")
                && row.entry().decision().equals("refused:scope"))).hasSize(2);
    }

    @Test
    void aCardAskedBeforeItsAppWentOffNeverRuns() throws Exception {
        deskd.looks.put("files_write", c -> FakeDeskLink.look("write", "agent",
                Map.of("path", "Plans/trip.md", "text", "Lisbon", "replace", false), null));
        desk.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "files_write", "path", "Plans/trip.md", "text",
                "Lisbon")))).then(Step.answer(USAGE, "Couldn't."));
        desk.call("agent.message.send", "agentId", a, "text", "Save my plan.");
        AtomicReference<Map<String, Object>> card = new AtomicReference<>();
        await().atMost(Duration.ofSeconds(15)).until(() -> {
            List<Map<String, Object>> pending = list(desk.call("agent.approvals.list", "agentId", a)
                    .get("approvals"));
            card.set(pending.isEmpty() ? null : pending.getFirst());
            return card.get() != null;
        });
        apps("files", false);
        Map<String, Object> c = card.get();
        String sha = Approvals.hash(a, (String) c.get("runId"), "files_write", "agent", map(c.get("payload")));
        desk.call("agent.approval.decide", "approvalId", c.get("id"), "approve", true, "sha256", sha);
        Map<String, Object> reply = desk.reply(a, 2);
        assertThat(reply.get("state")).isEqualTo("done");
        assertThat(deskd.runsOf("files_write")).isEmpty();
        ToolResult result = TeamDesk.lastToolResult(desk.lastRequest());
        assertThat(result.content()).contains("scope");
    }

    @Test
    void deskdRefusingSetupMakesTheAgentWaitForTheMemberToConfirm() throws Exception {
        deskd.looks.put("notebook_read", c -> FakeDeskLink.refused("forbidden", "setup"));
        desk.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "notebook_read", "pageId", "p1"))))
                .then(Step.answer(USAGE, "I can't."));
        desk.ask(a, "Read my page.");
        assertThat(TeamDesk.lastToolResult(desk.lastRequest()).content()).isEqualTo("Not allowed: setup.");
        assertThat(desk.agentView(a)).containsEntry("setup", "confirm");
        assertThat(desk.refused("agent.message.send", "agentId", a, "text", "Again").details())
                .containsEntry("reason", "setup");
    }

    @Test
    void aRunsCallOfAToolDeskdRefusesAsScopeIsRefusedAndChangesNothingHere() throws Exception {
        deskd.looks.put("browser_open", c -> FakeDeskLink.refused("forbidden", "scope"));
        desk.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "browser_open", "url", "https://example.com"))))
                .then(Step.answer(USAGE, "No."));
        desk.ask(a, "Open it.");
        assertThat(TeamDesk.lastToolResult(desk.lastRequest()).content()).isEqualTo("Not allowed: scope.");
        // deskd's word can only take away: it doesn't make the agent wait, and the choice here stands.
        assertThat(desk.agentView(a)).containsEntry("setup", null);
    }
}
