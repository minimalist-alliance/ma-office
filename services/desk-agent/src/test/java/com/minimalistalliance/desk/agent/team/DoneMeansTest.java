package com.minimalistalliance.desk.agent.team;

import static com.minimalistalliance.desk.agent.testing.FakeProvider.Step.call;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.m;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The spec's "done means" for task 49, as one story on the real {@code AgentService} and {@code Team}: the member asks
 * the lead for two agents; each appears as its own app with a chosen icon and tone; one is solo, the other may message
 * it under a written rule; one runs on a timer; each stays within its workspace limit.
 *
 * <p>The model is scripted ({@code FakeProvider}), so the lead's, the agents' and the timer's tool calls all go through
 * the real tool loop, the real tools and the real stores. The clock is the test's.
 */
class DoneMeansTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);
    private static final String RULES = "Ask only for sources. Never send the member's notes.";
    private static final String CHUNK = "z".repeat(600_000);

    @TempDir
    Path data;

    private TeamDesk desk;
    private String researcher;
    private String writer;
    private String writerTimer;

    @BeforeEach
    void start() throws Exception {
        desk = new TeamDesk(data);
        desk.bindLead();
    }

    @AfterEach
    void stop() {
        desk.close();
    }

    @Test
    void theMemberSetsUpTwoAgentsAndEachDoesItsJobWithinItsLimits() throws Exception {
        theLeadProposesTheResearcherAndTheMemberConfirms();
        theLeadProposesTheWriterWithALinkAndATimerAndTheMemberConfirms();
        eachAgentIsItsOwnApp();
        theTimerRunsTheWriterWhichMessagesTheResearcherUnderTheWrittenRule();
        theSoloResearcherCannotMessageTheWriter();
        eachAgentStaysWithinItsWorkspaceQuota();
    }

    // ---------------------------------------------------------------- setting up

    private Map<String, Object> answer(Map<String, Object> proposal) throws Exception {
        return map(desk.call("agent.proposal.answer", "proposalId", proposal.get("id"), "accept", true, "sha256",
                proposal.get("sha256")).get("proposal"));
    }

    private void theLeadProposesTheResearcherAndTheMemberConfirms() throws Exception {
        desk.provider
                .then(Step.calls(USAGE, List.of(call("a1", "desk_agents"), call("a2", "desk_choices"))))
                .then(Step.calls(USAGE, List.of(call("a3", "propose_agent", "name", "Researcher", "purpose",
                        "Find sources and summarise them.", "icon", "compass", "tone", "teal", "workspaceMb", 1))))
                .then(Step.answer(USAGE, "I proposed the Researcher; the Writer comes next."));

        Map<String, Object> reply = desk.ask(AgentStore.MANAGER, "Set up a Researcher and a Writer.");

        assertThat(reply).containsEntry("state", "done");
        List<ToolResult> read = TeamDesk.toolResults(desk.lastRequest());
        assertThat(read).hasSize(3).noneMatch(ToolResult::error);
        assertThat(read.get(1).content()).contains("compass").contains("teal");
        Map<String, Object> proposal = list(reply.get("proposals")).getFirst();
        assertThat(proposal).containsEntry("action", "agent.create").containsEntry("state", "pending");
        assertThat(list(desk.call("agent.list").get("agents"))).as("a proposal changes nothing").hasSize(1);

        Map<String, Object> applied = answer(proposal);

        assertThat(applied).containsEntry("state", "applied");
        researcher = (String) map(applied.get("result")).get("agentId");
    }

    private void theLeadProposesTheWriterWithALinkAndATimerAndTheMemberConfirms() throws Exception {
        // A link names an agent that exists, so the Writer is proposed once the Researcher is there.
        desk.provider
                .then(Step.calls(USAGE, List.of(call("b1", "desk_agents"))))
                .then(Step.calls(USAGE, List.of(call("b2", "propose_agent", "name", "Writer", "purpose",
                        "Write the weekday brief from what the Researcher finds.", "icon", "pen", "tone", "plum",
                        "workspaceMb", 2, "links", List.of(m("to", researcher, "rules", RULES)), "timers",
                        List.of(m("label", "Brief", "kind", "repeat", "everyMinutes", 15, "prompt",
                                "Ask the Researcher for sources, then write the brief."))))))
                .then(Step.answer(USAGE, "I proposed the Writer."));

        Map<String, Object> reply = desk.ask(AgentStore.MANAGER, "Now the Writer, who may ask the Researcher.");

        assertThat(TeamDesk.toolResults(desk.lastRequest()).getFirst().content()).contains(researcher);
        Map<String, Object> proposal = list(reply.get("proposals")).getFirst();
        assertThat(map(proposal.get("payload"))).containsEntry("solo", false).containsKey("timers");

        Map<String, Object> applied = answer(proposal);

        assertThat(applied).containsEntry("state", "applied");
        writer = (String) map(applied.get("result")).get("agentId");
        writerTimer = (String) list(desk.call("agent.timer.list", "agentId", writer).get("timers")).getFirst().get("id");
    }

    // ---------------------------------------------------------------- each its own app

    private void eachAgentIsItsOwnApp() throws Exception {
        List<Map<String, Object>> staff = list(desk.service.stateSnapshot().get("agents")).stream()
                .filter(a -> "staff".equals(a.get("role"))).toList();

        assertThat(staff).extracting(a -> a.get("id")).containsExactlyInAnyOrder(researcher, writer);
        assertThat(researcher).isNotEqualTo(writer);
        Map<String, Object> r = byId(staff, researcher);
        Map<String, Object> w = byId(staff, writer);
        assertThat(r).containsEntry("name", "Researcher").containsEntry("solo", true);
        assertThat(map(r.get("look"))).containsEntry("icon", "compass").containsEntry("tone", "teal");
        assertThat(w).containsEntry("name", "Writer").containsEntry("solo", false);
        assertThat(map(w.get("look"))).containsEntry("icon", "pen").containsEntry("tone", "plum");

        Map<String, Object> full = desk.agentView(writer);
        assertThat(list(full.get("links"))).containsExactly(m("to", researcher, "rules", RULES));
        assertThat(list(map(desk.agentView(researcher)).get("incoming"))).containsExactly(m("from", writer, "rules", RULES));
        assertThat(full).containsEntry("timers", 1);
    }

    private static Map<String, Object> byId(List<Map<String, Object>> agents, String id) {
        return agents.stream().filter(a -> id.equals(a.get("id"))).findFirst().orElseThrow();
    }

    // ---------------------------------------------------------------- the timer and the message

    private void theTimerRunsTheWriterWhichMessagesTheResearcherUnderTheWrittenRule() throws Exception {
        int seen = desk.requests().size();
        desk.provider
                .then(Step.calls(USAGE, List.of(call("w1", "message_agent", "to", researcher, "text",
                        "Send me three sources."))))
                .then(Step.answer(USAGE, "Three sources: A, B, C."))
                .then(Step.answer(USAGE, "Brief written from A, B, C."));

        desk.clock.advance(Duration.ofMinutes(16));
        assertThat(desk.team.timers().runDue()).isEqualTo(1);

        await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> assertThat(timer()).containsEntry("lastState", "ok"));
        Map<String, Object> timer = timer();
        assertThat(((Number) timer.get("spentMicroUsd")).longValue()).isPositive();
        assertThat(((Number) timer.get("lastAt")).longValue()).isEqualTo(desk.clock.millis());

        List<ChatRequest> requests = desk.requests().subList(seen, desk.requests().size());
        assertThat(requests).hasSize(3);
        assertThat(TeamDesk.allText(requests.get(0))).contains("Ask the Researcher for sources");
        ChatRequest researchers = requests.get(1);
        assertThat(researchers.system()).as("the written rule is in the system part").contains(RULES);
        assertThat(TeamDesk.allText(researchers)).contains("Send me three sources.");
        assertThat(TeamDesk.lastToolResult(requests.get(2)).error()).isFalse();
        assertThat(TeamDesk.lastToolResult(requests.get(2)).content()).contains("Three sources: A, B, C.");

        List<Map<String, Object>> log = list(desk.call("agent.a2a.list", "agentId", writer).get("messages"));
        assertThat(log).singleElement().satisfies(row -> assertThat(row).containsEntry("from", writer)
                .containsEntry("to", researcher).containsEntry("state", "replied").containsEntry("rules", RULES)
                .containsEntry("text", "Send me three sources.").containsEntry("reply", "Three sources: A, B, C."));
    }

    private Map<String, Object> timer() throws Exception {
        return list(desk.call("agent.timer.list", "agentId", writer).get("timers")).stream()
                .filter(t -> writerTimer.equals(t.get("id"))).findFirst().orElseThrow();
    }

    // ---------------------------------------------------------------- solo

    private void theSoloResearcherCannotMessageTheWriter() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(call("s1", "message_agent", "to", writer, "text", "Hello?"))))
                .then(Step.answer(USAGE, "I can't message anyone."));

        desk.ask(researcher, "Tell the Writer hello.");

        ToolResult result = TeamDesk.lastToolResult(desk.requests().get(desk.requests().size() - 1));
        assertThat(result.error()).isTrue();
        assertThat(result.content()).startsWith("Not sent: ");
        List<Map<String, Object>> refused = list(desk.call("agent.a2a.list", "agentId", researcher).get("messages"))
                .stream().filter(r -> researcher.equals(r.get("from"))).toList();
        assertThat(refused).singleElement().satisfies(row -> assertThat(row).containsEntry("state", "refused")
                .containsEntry("reply", null).extracting("reason").isIn("solo", "no_tool"));
        assertThat(desk.audit.readBefore(null, 300)).anyMatch(r -> r.entry().action().equals("a2a.send")
                && r.entry().decision().startsWith("refused:") && r.entry().actor().equals("agent:" + researcher));
    }

    // ---------------------------------------------------------------- workspaces

    private Map<String, Object> workspace(String agentId) throws Exception {
        return map(desk.agentView(agentId).get("workspace"));
    }

    private List<ToolResult> writes(String agentId, int count) throws Exception {
        ToolResultsOf script = new ToolResultsOf();
        for (int i = 0; i < count; i++) {
            script.add(call("q" + i, "workspace_write", "path", "file" + i + ".txt", "text", CHUNK));
        }
        desk.provider.then(Step.calls(USAGE, script.calls)).then(Step.answer(USAGE, "Done."));
        desk.ask(agentId, "Save your notes.");
        return TeamDesk.toolResults(desk.lastRequest());
    }

    private static final class ToolResultsOf {
        final List<com.minimalistalliance.desk.agent.provider.ToolCall> calls = new java.util.ArrayList<>();

        void add(com.minimalistalliance.desk.agent.provider.ToolCall call) {
            calls.add(call);
        }
    }

    private void eachAgentStaysWithinItsWorkspaceQuota() throws Exception {
        // Researcher: 1 MB, so one 600 KB file fits and the second doesn't.
        List<ToolResult> r = writes(researcher, 2);
        assertThat(r.get(0).error()).as(r.get(0).content()).isFalse();
        assertThat(r.get(1).error()).as(r.get(1).content()).isTrue();
        assertThat(r.get(1).content()).contains("quota");
        assertThat(workspace(researcher)).containsEntry("quotaBytes", 1L << 20).containsEntry("usedBytes", 600_000L);

        // Writer: 2 MB, so three fit and the fourth doesn't.
        List<ToolResult> w = writes(writer, 4);
        assertThat(w.subList(0, 3)).noneMatch(ToolResult::error);
        assertThat(w.get(3).error()).as(w.get(3).content()).isTrue();
        assertThat(w.get(3).content()).contains("quota");
        assertThat(workspace(writer)).containsEntry("quotaBytes", 2L << 20).containsEntry("usedBytes", 1_800_000L);

        for (String id : List.of(researcher, writer)) {
            Map<String, Object> ws = workspace(id);
            assertThat(((Number) ws.get("usedBytes")).longValue()).isLessThanOrEqualTo(((Number) ws.get("quotaBytes")).longValue());
        }
    }
}
