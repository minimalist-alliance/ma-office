package com.minimalistalliance.desk.agent.team;

import static com.minimalistalliance.desk.agent.testing.FakeProvider.Step.call;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.m;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Where a proposal came from, and how many there may be (AI M2, Security T49M-3, SET-L3): the lead keeps its tools in
 * a run another agent's message or a timer started, and every card says what started that run.
 */
class ProposalOriginTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);

    @TempDir
    Path data;

    private TeamDesk desk;
    private String researcher;

    @BeforeEach
    void start() throws Exception {
        desk = new TeamDesk(data);
        desk.bindLead();
        researcher = desk.agent("Researcher");
    }

    @AfterEach
    void stop() {
        desk.close();
    }

    private static ToolCall change(String id, String agentId, String purpose) {
        return call(id, "propose_agent_change", "agent", agentId, "purpose", purpose);
    }

    private static List<Map<String, Object>> proposals(Map<String, Object> reply) {
        return list(reply.get("proposals"));
    }

    @Test
    void theMembersOwnTurnMakesAMemberCard() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(change("t1", researcher, "Read.")))).then(Step.answer(USAGE,
                "Ok."));

        Map<String, Object> card = proposals(desk.ask(AgentStore.MANAGER, "Change it.")).getFirst();

        assertThat(map(card.get("origin"))).isEqualTo(Map.of("kind", "member"));
    }

    @Test
    void aTurnAnotherAgentsMessageStartedKeepsTheToolsAndItsCardsSaySo() throws Exception {
        desk.link(researcher, AgentStore.MANAGER, "Ask the lead for setup help.");
        desk.open(AgentStore.MANAGER);
        desk.provider.then(Step.calls(USAGE, List.of(call("m1", "message_agent", "to", AgentStore.MANAGER, "text",
                        "Please give me a timer."))))
                .then(Step.calls(USAGE, List.of(change("t1", researcher, "Read more."))))
                .then(Step.answer(USAGE, "I proposed it."))
                .then(Step.answer(USAGE, "The lead proposed it."));

        desk.ask(researcher, "Ask the lead.");

        Map<String, Object> leadReply = desk.lastReply(AgentStore.MANAGER);
        assertThat(proposals(leadReply)).singleElement().satisfies(card -> assertThat(map(card.get("origin")))
                .containsEntry("kind", "agent").containsEntry("agentId", researcher)
                .containsEntry("name", "Researcher"));
    }

    @Test
    void aTurnATimerStartedSaysWhichTimer() throws Exception {
        Map<String, Object> timer = map(desk.call("agent.timer.set", "agentId", AgentStore.MANAGER, "timer",
                m("label", "Weekly tidy", "kind", "once", "inMinutes", 30, "prompt", "Tidy the team.")).get("timer"));
        desk.clock.advance(Duration.ofMinutes(31));
        desk.provider.then(Step.calls(USAGE, List.of(change("t1", researcher, "Tidier."))))
                .then(Step.answer(USAGE, "Proposed."));

        assertThat(desk.team.timers().runDue()).isEqualTo(1);

        Map<String, Object> reply = desk.reply(AgentStore.MANAGER, 2);
        assertThat(proposals(reply)).singleElement().satisfies(card -> assertThat(map(card.get("origin")))
                .isEqualTo(Map.of("kind", "timer", "agentId", AgentStore.MANAGER, "timerId", timer.get("id"),
                        "label", "Weekly tidy")));
    }

    @Test
    void aRunMakesAtMostFiveAndTheDeskHoldsAtMostTenWaiting() throws Exception {
        List<ToolCall> six = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            six.add(change("a" + i, researcher, "Purpose " + i));
        }
        desk.provider.then(Step.calls(USAGE, six)).then(Step.answer(USAGE, "Five."));

        Map<String, Object> first = desk.ask(AgentStore.MANAGER, "Six changes.");

        assertThat(proposals(first)).hasSize(5);
        ToolResult sixth = TeamDesk.lastToolResult(desk.lastRequest());
        assertThat(sixth.error()).isTrue();
        assertThat(sixth.content()).contains("proposal_cap").contains("let the member answer these first");

        List<ToolCall> more = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            more.add(change("b" + i, researcher, "Again " + i));
        }
        desk.provider.then(Step.calls(USAGE, more)).then(Step.answer(USAGE, "Five more."));
        assertThat(proposals(desk.ask(AgentStore.MANAGER, "More."))).as("ten wait now").hasSize(5);

        Map<String, Object> answered = proposals(first).getFirst();
        desk.call("agent.proposal.answer", "proposalId", answered.get("id"), "accept", false, "sha256",
                answered.get("sha256"));
        desk.provider.then(Step.calls(USAGE, List.of(change("c1", researcher, "One more."), change("c2", researcher,
                "And another.")))).then(Step.answer(USAGE, "One."));
        assertThat(proposals(desk.ask(AgentStore.MANAGER, "One more."))).as("one answered, one place free")
                .hasSize(1);

        desk.clock.advance(Duration.ofHours(25));
        desk.provider.then(Step.calls(USAGE, List.of(change("d1", researcher, "Fresh.")))).then(Step.answer(USAGE,
                "Ok."));
        assertThat(proposals(desk.ask(AgentStore.MANAGER, "Later."))).as("expired ones don't wait").hasSize(1);
    }
}
