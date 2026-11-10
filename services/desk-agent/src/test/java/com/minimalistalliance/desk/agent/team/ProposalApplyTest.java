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
import com.minimalistalliance.desk.agent.store.TeamStore.ProposalRow;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.file.Path;
import java.time.Duration;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * A confirmed proposal applies whole or not at all (AI M1, CC-L4, Design M1): every check runs before anything is
 * written, and whatever happens the proposal settles.
 */
class ProposalApplyTest {

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

    private List<Map<String, Object>> propose(ToolCall... calls) throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(calls))).then(Step.answer(USAGE, "Done."));
        return list(desk.ask(AgentStore.MANAGER, "Set it up.").get("proposals"));
    }

    private Map<String, Object> confirm(Map<String, Object> proposal) throws Exception {
        return map(desk.call("agent.proposal.answer", "proposalId", proposal.get("id"), "accept", true, "sha256",
                proposal.get("sha256")).get("proposal"));
    }

    private int agentCount() throws Exception {
        return list(desk.call("agent.list").get("agents")).size();
    }

    private boolean audited(String decision) throws Exception {
        return desk.audit.readBefore(null, 200).stream().anyMatch(row -> row.entry().action()
                .equals("proposal.answer") && row.entry().decision().equals(decision));
    }

    @Test
    void aCreatesTimerWithAnIdOrALinkGivenTwiceIsRefusedWhenProposed() throws Exception {
        List<Map<String, Object>> cards = propose(
                call("t1", "propose_agent", "name", "Planner", "purpose", "x", "icon", "pen", "tone", "teal",
                        "timers", List.of(m("label", "Digest", "kind", "repeat", "everyMinutes", 60, "prompt", "Go."),
                                m("id", "tm-aaaaaaaaaaaa", "label", "x", "kind", "once", "inMinutes", 5, "prompt",
                                        "Go."))),
                call("t2", "propose_agent", "name", "Planner", "purpose", "x", "icon", "pen", "tone", "teal",
                        "links", List.of(m("to", "Researcher", "rules", "Ask."), m("to", researcher, "rules",
                                "Ask again."))));

        assertThat(cards).isNull();
        List<ToolResult> results = TeamDesk.toolResults(desk.lastRequest());
        assertThat(results).allMatch(ToolResult::error);
        assertThat(results.get(0).content()).contains("(timers)");
        assertThat(results.get(1).content()).contains("(links)");
    }

    @Test
    void aCreateWithLinksAndTimersAppliesWhole() throws Exception {
        Map<String, Object> card = propose(call("t1", "propose_agent", "name", "Planner", "purpose", "Plan.",
                "icon", "pen", "tone", "teal", "links", List.of(m("to", researcher, "rules", "Ask for sources.")),
                "timers", List.of(m("label", "Digest", "kind", "repeat", "days", List.of(1, 2, 3, 4, 5), "time",
                        "08:00", "prompt", "Plan the day."), m("label", "Once", "kind", "once", "inMinutes", 60,
                        "prompt", "Check in.")))).getFirst();

        Map<String, Object> applied = confirm(card);

        assertThat(applied).containsEntry("state", "applied").containsEntry("detail", null);
        String id = (String) map(applied.get("result")).get("agentId");
        assertThat(desk.agentView(id)).containsEntry("solo", false).containsEntry("timers", 2);
        assertThat(list(desk.agentView(id).get("links"))).containsExactly(m("to", researcher, "rules",
                "Ask for sources."));
        assertThat(audited("applied")).isTrue();
    }

    @Test
    void aOneShotWhoseTimeHasPassedFailsTheCreateAndNothingIsMade() throws Exception {
        String at = LocalDateTime.ofInstant(desk.clock.instant().plus(Duration.ofMinutes(30)), ZoneOffset.UTC)
                .withNano(0).toString();
        Map<String, Object> card = propose(call("t1", "propose_agent", "name", "Planner", "purpose", "x", "icon",
                "pen", "tone", "teal", "links", List.of(m("to", researcher, "rules", "Ask.")), "timers",
                List.of(m("label", "Soon", "kind", "once", "at", at, "prompt", "Go.")))).getFirst();
        int before = agentCount();

        desk.clock.advance(Duration.ofHours(1));
        Map<String, Object> failed = confirm(card);

        assertThat(failed).containsEntry("state", "failed").containsEntry("detail", "at").containsEntry("result",
                null);
        assertThat(agentCount()).as("no agent, no links, no timer").isEqualTo(before);
        assertThat(desk.team.teamStore().links()).isEmpty();
        assertThat(desk.team.teamStore().timers(null)).isEmpty();
        assertThat(audited("failed:at")).isTrue();
    }

    @Test
    void aLinkTargetDeletedBeforeTheYesFailsTheCreateWhole() throws Exception {
        String other = desk.agent("Other");
        Map<String, Object> card = propose(call("t1", "propose_agent", "name", "Planner", "purpose", "x", "icon",
                "pen", "tone", "teal", "links", List.of(m("to", other, "rules", "Ask.")))).getFirst();
        desk.call("agent.delete", "agentId", other);
        int before = agentCount();

        assertThat(confirm(card)).containsEntry("state", "failed").containsEntry("detail", "links");
        assertThat(agentCount()).isEqualTo(before);
    }

    @Test
    void aKeyDeletedBeforeTheYesFailsTheCreateAndTheChangeAndChangesNothing() throws Exception {
        List<Map<String, Object>> cards = propose(
                call("t1", "propose_agent", "name", "Planner", "purpose", "x", "icon", "pen", "tone", "teal"),
                call("t2", "propose_agent_change", "agent", researcher, "purpose", "New.", "model",
                        "fake-unpriced"));
        int before = agentCount();
        desk.call("agent.key.delete", "keyId", desk.key());

        assertThat(confirm(cards.get(0))).containsEntry("state", "failed").containsEntry("detail", "key");
        assertThat(confirm(cards.get(1))).containsEntry("state", "failed").containsEntry("detail", "key");
        assertThat(agentCount()).isEqualTo(before);
        assertThat(desk.agentView(researcher)).as("the purpose wasn't written before the key was checked")
                .containsEntry("purpose", "");
    }

    @Test
    void aProposalForAnAgentThatIsGoneFailsAsNotFound() throws Exception {
        List<Map<String, Object>> cards = propose(
                call("t1", "propose_agent_change", "agent", researcher, "purpose", "New."),
                call("t2", "propose_timer", "agent", researcher, "timer", m("label", "Tick", "kind", "once",
                        "inMinutes", 30, "prompt", "Tick.")),
                call("t3", "propose_links", "agent", researcher, "links", List.of()),
                call("t4", "propose_agent_removal", "agent", researcher));
        desk.call("agent.delete", "agentId", researcher);

        for (Map<String, Object> card : cards) {
            assertThat(confirm(card)).containsEntry("state", "failed").containsEntry("detail", "not_found");
        }
        assertThat(audited("failed:not_found")).isTrue();
    }

    @Test
    void aProposalLeftApplyingIsFailedAtTheNextStart() throws Exception {
        Map<String, Object> card = propose(call("t1", "propose_agent_change", "agent", researcher, "purpose",
                "New."))
                .getFirst();
        String id = (String) card.get("id");
        assertThat(desk.team.teamStore().answerProposal(id, "applying", null, null, desk.clock.millis())).isTrue();
        assertThat(map(desk.thread(AgentStore.MANAGER).getLast()).get("proposals")).asList().singleElement()
                .satisfies(p -> assertThat(map(p)).containsEntry("state", "pending"));
        desk.close();

        desk = new TeamDesk(data, desk.clock);

        ProposalRow row = desk.team.teamStore().proposal(id);
        assertThat(row.state()).isEqualTo("failed");
        assertThat(row.detail()).isEqualTo("internal");
        assertThat(audited("failed:internal")).isTrue();
    }

    @Test
    void aStoppedRunsProposalsExpireAndCantBeConfirmed() throws Exception {
        java.util.concurrent.CountDownLatch hold = new java.util.concurrent.CountDownLatch(1);
        desk.provider.then(Step.calls(USAGE, List.of(call("t1", "propose_agent_change", "agent", researcher,
                "purpose", "Off the rails.")))).then(Step.answer(USAGE, "More.").heldBy(hold));
        String runId = (String) desk.call("agent.message.send", "agentId", AgentStore.MANAGER, "text", "Go.")
                .get("runId");
        org.awaitility.Awaitility.await().atMost(Duration.ofSeconds(10))
                .until(() -> desk.team.teamStore().hasProposals());

        desk.call("agent.run.stop", "runId", runId);
        hold.countDown();

        Map<String, Object> reply = desk.lastReply(AgentStore.MANAGER);
        assertThat(reply).containsEntry("state", "stopped");
        Map<String, Object> card = list(reply.get("proposals")).getFirst();
        assertThat(card).containsEntry("state", "expired").containsEntry("detail", "stopped");
        assertThat(desk.refused("agent.proposal.answer", "proposalId", card.get("id"), "accept", true, "sha256",
                card.get("sha256")).details()).containsEntry("reason", "expired");
        assertThat(desk.agentView(researcher)).containsEntry("purpose", "");
    }
}
