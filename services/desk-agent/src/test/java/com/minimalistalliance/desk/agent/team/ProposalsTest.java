package com.minimalistalliance.desk.agent.team;

import static com.minimalistalliance.desk.agent.testing.FakeProvider.Step.call;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.m;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The lead's proposals: a card the member confirms, hash and all, before anything changes ({@code multi-agent.md} 3). */
class ProposalsTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);
    private static final String ZERO_HASH = "0".repeat(64);

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

    private void proposeScout() {
        desk.provider
                .then(Step.calls(USAGE, List.of(call("t1", "propose_agent", "name", "Scout", "purpose",
                        "Watch the news and keep a digest.", "icon", "compass", "tone", "teal", "links",
                        List.of(m("to", researcher, "rules", "Ask only for summaries."))))))
                .then(Step.answer(USAGE, "I proposed Scout."));
    }

    private List<Map<String, Object>> proposalsOf(Map<String, Object> reply) {
        return list(reply.get("proposals"));
    }

    private Map<String, Object> answer(Map<String, Object> proposal, boolean accept) throws Exception {
        return map(desk.call("agent.proposal.answer", "proposalId", proposal.get("id"), "accept", accept, "sha256",
                proposal.get("sha256")).get("proposal"));
    }

    private int agentCount() throws Exception {
        return list(desk.call("agent.list").get("agents")).size();
    }

    private RpcError wrongAnswer(Map<String, Object> proposal, String sha) {
        return desk.refused("agent.proposal.answer", "proposalId", proposal.get("id"), "accept", true, "sha256", sha);
    }

    @Test
    void aProposalIsACardWithTheHashOfItsPayloadAndNothingIsCreatedYet() throws Exception {
        proposeScout();
        String keyId = desk.key();

        Map<String, Object> reply = desk.ask(AgentStore.MANAGER, "Add a scout who watches the news.");

        assertThat(reply).containsEntry("state", "done").containsEntry("text", "I proposed Scout.");
        assertThat(proposalsOf(reply)).singleElement().satisfies(proposal -> {
            assertThat(proposal).containsEntry("action", "agent.create").containsEntry("state", "pending")
                    .containsEntry("detail", null).containsEntry("answeredAt", null).containsEntry("result", null);
            assertThat((String) proposal.get("id")).matches("pr-[a-z2-7]{12}");
            assertThat((String) proposal.get("summary")).contains("Scout").contains("compass");
            Map<String, Object> payload = map(proposal.get("payload"));
            assertThat(proposal.get("sha256")).isEqualTo(Canonical.sha256(payload));
            assertThat(payload).containsEntry("name", "Scout").containsEntry("icon", "compass")
                    .containsEntry("tone", "teal").containsEntry("keyId", keyId).containsEntry("model", Rig.MODEL)
                    .containsEntry("solo", false)
                    .containsEntry("links", List.of(m("to", researcher, "rules", "Ask only for summaries.")));
            assertThat((long) proposal.get("expiresAt")).isEqualTo(desk.clock.millis() + Duration.ofHours(24).toMillis());
        });
        assertThat(agentCount()).as("a proposal changes nothing").isEqualTo(2);
        assertThat(desk.audit.readBefore(null, 100)).anyMatch(row -> row.entry().action().equals("proposal.make"));
    }

    @Test
    void theMembersYesAppliesItOnlyWithTheRightHashAndOnlyOnce() throws Exception {
        proposeScout();
        Map<String, Object> proposal = proposalsOf(desk.ask(AgentStore.MANAGER, "Add a scout.")).getFirst();

        RpcError wrong = wrongAnswer(proposal, ZERO_HASH);
        assertThat(wrong.code()).isEqualTo("bad_request");
        assertThat(wrong.details()).containsEntry("detail", "sha256");
        assertThat(wrongAnswer(proposal, ((String) proposal.get("sha256")).substring(1)).details())
                .containsEntry("detail", "sha256");
        assertThat(agentCount()).isEqualTo(2);

        Map<String, Object> applied = answer(proposal, true);

        assertThat(applied).containsEntry("state", "applied").containsEntry("detail", null);
        String newId = (String) map(applied.get("result")).get("agentId");
        assertThat(newId).matches("ag-[a-z2-7]{12}");
        assertThat((Long) applied.get("answeredAt")).isNotNull();
        Map<String, Object> scout = desk.agentView(newId);
        assertThat(scout).containsEntry("name", "Scout").containsEntry("purpose", "Watch the news and keep a digest.")
                .containsEntry("solo", false).containsEntry("role", "staff");
        assertThat(map(scout.get("look"))).containsEntry("icon", "compass").containsEntry("tone", "teal");
        assertThat(map(scout.get("binding"))).containsEntry("keyId", desk.key()).containsEntry("model", Rig.MODEL);
        assertThat(list(scout.get("links"))).containsExactly(m("to", researcher, "rules", "Ask only for summaries."));
        assertThat(agentCount()).isEqualTo(3);

        RpcError again = desk.refused("agent.proposal.answer", "proposalId", proposal.get("id"), "accept", true,
                "sha256", proposal.get("sha256"));
        assertThat(again.code()).isEqualTo("conflict");
        assertThat(again.details()).containsEntry("reason", "answered");
        assertThat(desk.refused("agent.proposal.answer", "proposalId", proposal.get("id"), "accept", false, "sha256",
                proposal.get("sha256")).details()).containsEntry("reason", "answered");
        assertThat(agentCount()).as("not created twice").isEqualTo(3);

        List<Map<String, Object>> thread = desk.thread(AgentStore.MANAGER);
        assertThat(proposalsOf(thread.getLast())).singleElement().satisfies(p -> assertThat(p)
                .containsEntry("state", "applied"));
        assertThat(desk.audit.readBefore(null, 200)).anyMatch(row -> row.entry().action().equals("proposal.answer")
                && row.entry().decision().equals("applied"));
    }

    @Test
    void aDeclinedProposalStaysUndone() throws Exception {
        proposeScout();
        Map<String, Object> proposal = proposalsOf(desk.ask(AgentStore.MANAGER, "Add a scout.")).getFirst();

        Map<String, Object> declined = answer(proposal, false);

        assertThat(declined).containsEntry("state", "declined").containsEntry("result", null);
        assertThat(agentCount()).isEqualTo(2);
        assertThat(desk.refused("agent.proposal.answer", "proposalId", proposal.get("id"), "accept", true, "sha256",
                proposal.get("sha256")).details()).containsEntry("reason", "answered");
        assertThat(agentCount()).as("a yes after a no doesn't apply it").isEqualTo(2);
    }

    @Test
    void aProposalExpiresAfterADay() throws Exception {
        proposeScout();
        Map<String, Object> proposal = proposalsOf(desk.ask(AgentStore.MANAGER, "Add a scout.")).getFirst();

        desk.clock.advance(Duration.ofHours(25));

        assertThat(proposalsOf(desk.thread(AgentStore.MANAGER).getLast())).singleElement()
                .satisfies(p -> assertThat(p).containsEntry("state", "expired"));
        RpcError expired = wrongAnswer(proposal, (String) proposal.get("sha256"));
        assertThat(expired.code()).isEqualTo("conflict");
        assertThat(expired.details()).containsEntry("reason", "expired");
        assertThat(agentCount()).isEqualTo(2);
        assertThat(desk.team.teamStore().proposal((String) proposal.get("id")).state()).isEqualTo("expired");
    }

    @Test
    void anAnswerForAnUnknownProposalIsNotFound() {
        RpcError e = desk.refused("agent.proposal.answer", "proposalId", "pr-aaaaaaaaaaaa", "accept", true, "sha256",
                ZERO_HASH);
        assertThat(e.code()).isEqualTo("not_found");
        assertThat(e.details()).containsEntry("detail", "proposal");
    }

    @Test
    void theLeadsNextTurnReadsWhatBecameOfItsProposals() throws Exception {
        proposeScout();
        Map<String, Object> proposal = proposalsOf(desk.ask(AgentStore.MANAGER, "Add a scout.")).getFirst();
        String id = (String) proposal.get("id");

        desk.ask(AgentStore.MANAGER, "Thanks. Anything pending?");
        assertThat(TeamDesk.allText(desk.lastRequest())).contains("[Proposal " + id + " (agent.create): pending]");

        answer(proposal, true);
        desk.ask(AgentStore.MANAGER, "And now?");
        String seen = TeamDesk.allText(desk.lastRequest());
        assertThat(seen).contains("[Proposal " + id + " (agent.create): applied").contains("agentId");
    }

    @Test
    void aDeclinedOutcomeIsToldToo() throws Exception {
        proposeScout();
        Map<String, Object> proposal = proposalsOf(desk.ask(AgentStore.MANAGER, "Add a scout.")).getFirst();
        answer(proposal, false);

        desk.ask(AgentStore.MANAGER, "Ok?");

        assertThat(TeamDesk.allText(desk.lastRequest())).contains("(agent.create): declined]");
    }

    @Test
    void aProposalTheCapNowRefusesFailsWithItsReason() throws Exception {
        desk.tier(m("agentCap", 3));
        proposeScout();
        Map<String, Object> proposal = proposalsOf(desk.ask(AgentStore.MANAGER, "Add a scout.")).getFirst();
        desk.agent("Filler");

        Map<String, Object> failed = answer(proposal, true);

        assertThat(failed).containsEntry("state", "failed").containsEntry("detail", "agent_cap");
        assertThat(agentCount()).isEqualTo(3);
    }

    // ---------------------------------------------------------------- names, ids and looks (Design H5, AI M5)

    @Test
    void theLeadIsToldNamesAndLooksAreUniqueAndToUseIds() throws Exception {
        desk.ask(AgentStore.MANAGER, "Hello");

        String system = desk.lastRequest().system();
        assertThat(system).contains("Give each agent a name, and an icon and tone pair, that no other agent on this"
                + " desk has.").contains("name agents by the ids desk_agents lists")
                .contains("an AI agent on the member's desk at Minimalist Alliance.")
                .contains("Spending limits, workspace sharing and uploaded icons are the member\u2019s to set in each"
                        + " agent\u2019s settings; tell them where.")
                .doesNotContain("private cloud desk");
    }

    @Test
    void aTakenNameIsRefusedWhenTheLeadProposesIt() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(
                call("t1", "propose_agent", "name", "researcher", "purpose", "x", "icon", "nodes", "tone", "teal"),
                call("t2", "propose_agent_change", "agent", researcher, "name", "Lead"),
                call("t3", "propose_agent_change", "agent", researcher, "name", "RESEARCHER")))).then(Step.answer(USAGE,
                "Ok."));

        Map<String, Object> reply = desk.ask(AgentStore.MANAGER, "Another researcher.");

        List<ToolResult> results = TeamDesk.toolResults(desk.lastRequest());
        assertThat(results.get(0).error()).isTrue();
        assertThat(results.get(0).content()).contains("name_taken").contains("Pick another.");
        assertThat(results.get(1).content()).contains("name_taken");
        assertThat(results.get(2).error()).as("its own name in capitals").isFalse();
        assertThat(proposalsOf(reply)).singleElement().satisfies(p -> assertThat(p).containsEntry("action",
                "agent.update"));
    }

    @Test
    void aNameTwoOldAgentsShareIsRefusedAndTheirIdsWork() throws Exception {
        String twin = "ag-twin00000000";
        desk.team.teamStore().createAgent(twin, "researcher", desk.clock.millis(), new com.minimalistalliance.desk
                .agent.store.TeamStore.Extras(twin, "", "nodes", "rose", null, true, null, List.of()));
        desk.provider.then(Step.calls(USAGE, List.of(call("t1", "propose_agent_removal", "agent", "Researcher"),
                call("t2", "propose_agent_removal", "agent", twin)))).then(Step.answer(USAGE, "Ok."));

        Map<String, Object> reply = desk.ask(AgentStore.MANAGER, "Remove the old researcher.");

        List<ToolResult> results = TeamDesk.toolResults(desk.lastRequest());
        assertThat(results.get(0).error()).isTrue();
        assertThat(results.get(0).content()).contains("ambiguous").contains("use its id from desk_agents");
        assertThat(results.get(1).error()).isFalse();
        assertThat(proposalsOf(reply)).singleElement().satisfies(p -> assertThat(map(p.get("payload")))
                .containsEntry("agentId", twin));
    }

    @Test
    void aProposedAgentWithoutAToneGetsOneNoAgentHas() throws Exception {
        desk.call("agent.update", "agentId", researcher, "tone", "rose");
        desk.provider.then(Step.calls(USAGE, List.of(call("t1", "propose_agent", "name", "Scout", "purpose", "x",
                "icon", "compass")))).then(Step.answer(USAGE, "Ok."));

        Map<String, Object> reply = desk.ask(AgentStore.MANAGER, "A scout.");

        assertThat(map(proposalsOf(reply).getFirst().get("payload"))).containsEntry("tone", "clay");
    }

    @Test
    void aRetiredIconOrToneInAProposalIsTheOneThatTookItsPlace() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(call("t1", "propose_agent", "name", "Scout", "purpose", "x",
                "icon", "globe", "tone", "sky")))).then(Step.answer(USAGE, "Ok."));

        Map<String, Object> reply = desk.ask(AgentStore.MANAGER, "A scout.");

        assertThat(map(proposalsOf(reply).getFirst().get("payload"))).containsEntry("icon", "plane")
                .containsEntry("tone", "blue");
    }

    // ---------------------------------------------------------------- keys and models (AI M6)

    private String workKey() throws Exception {
        byte[] bytes = "sk-fake-teamdesk-work-0123456789ab".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        Map<String, Object> added = desk.service.keyAdd(m("provider", com.minimalistalliance.desk.agent.testing
                .FakeProvider.ID.id(), "label", "Work", "deskId", "d-test"),
                java.nio.ByteBuffer.allocateDirect(bytes.length).put(bytes).flip());
        return (String) map(added.get("key")).get("keyId");
    }

    @Test
    void aModelChangeKeepsTheAgentsOwnKey() throws Exception {
        String work = workKey();
        desk.call("agent.bind", "agentId", researcher, "keyId", work, "model", Rig.MODEL);
        desk.provider.then(Step.calls(USAGE, List.of(
                call("t1", "propose_agent_change", "agent", researcher, "model", Rig.UNPRICED_MODEL),
                call("t2", "propose_agent_change", "agent", researcher, "keyId", desk.key()))))
                .then(Step.answer(USAGE, "Two."));

        List<Map<String, Object>> cards = proposalsOf(desk.ask(AgentStore.MANAGER, "A cheaper model for Researcher."));

        assertThat(map(cards.get(0).get("payload"))).containsEntry("keyId", work)
                .containsEntry("model", Rig.UNPRICED_MODEL);
        assertThat(map(cards.get(1).get("payload"))).as("a new key keeps the agent's model")
                .containsEntry("keyId", desk.key()).containsEntry("model", Rig.MODEL);
        assertThat(answer(cards.get(0), true)).containsEntry("state", "applied");
        assertThat(map(desk.agentView(researcher).get("binding"))).containsEntry("keyId", work)
                .containsEntry("model", Rig.UNPRICED_MODEL);
    }

    @Test
    void aModelTheKeysProviderDoesntListIsRefusedWhenProposed() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(
                call("t1", "propose_agent_change", "agent", researcher, "model", "gpt-6-luna"),
                call("t2", "propose_agent", "name", "Scout", "purpose", "x", "icon", "nodes", "tone", "teal", "model",
                        "fake-modle")))).then(Step.answer(USAGE, "None."));

        Map<String, Object> reply = desk.ask(AgentStore.MANAGER, "Switch models.");

        assertThat(reply.get("proposals")).isNull();
        assertThat(TeamDesk.toolResults(desk.lastRequest())).allSatisfy(result -> {
            assertThat(result.error()).isTrue();
            assertThat(result.content()).contains("unknown_model").contains("Use a model desk_choices lists");
        });
    }

    // ---------------------------------------------------------------- what a card changes (AI M17, Design M4)

    @Test
    void eachCardCarriesWhatItChangesAsItWasWhenMadeOutsideTheHash() throws Exception {
        String other = desk.agent("Other");
        desk.call("agent.update", "agentId", researcher, "purpose", "Old purpose.", "tone", "teal", "workspaceMb", 5);
        desk.team.workspaces().write(researcher, "notes.txt", "hello", false, 5L << 20);
        desk.link(researcher, other, "Ask Other.");
        desk.link(other, researcher, "Ask Researcher.");
        Map<String, Object> timer = map(desk.call("agent.timer.set", "agentId", researcher, "timer", m("label",
                "Nightly", "kind", "repeat", "everyMinutes", 60, "prompt", "Research.", "enabled", false))
                .get("timer"));
        desk.provider.then(Step.calls(USAGE, List.of(
                call("c1", "propose_agent_change", "agent", researcher, "name", "Reader", "purpose", "New purpose.",
                        "workspaceMb", 8),
                call("c2", "propose_links", "agent", researcher, "links", List.of()),
                call("c3", "propose_timer", "agent", researcher, "timer", m("id", timer.get("id"), "label",
                        "Morning brief", "kind", "repeat", "days", List.of(1, 2, 3, 4, 5), "time", "08:00", "prompt",
                        "Brief me.")),
                call("c4", "propose_agent_removal", "agent", researcher),
                call("c5", "propose_agent", "name", "Scout", "purpose", "x", "icon", "nodes", "tone", "rose"))))
                .then(Step.answer(USAGE, "Five."));

        List<Map<String, Object>> cards = proposalsOf(desk.ask(AgentStore.MANAGER, "Rework Researcher."));

        assertThat(cards).hasSize(5).allSatisfy(card -> assertThat(card.get("sha256"))
                .as("the hash is the payload's alone").isEqualTo(Canonical.sha256(card.get("payload"))));
        Map<String, Object> change = map(cards.get(0).get("before"));
        assertThat(change).containsOnlyKeys("name", "purpose", "workspaceMb", "usedBytes")
                .containsEntry("name", "Researcher").containsEntry("purpose", "Old purpose.");
        assertThat(((Number) change.get("workspaceMb")).intValue()).isEqualTo(5);
        assertThat(((Number) change.get("usedBytes")).longValue()).isPositive();
        assertThat(map(cards.get(1).get("before"))).isEqualTo(Map.of("solo", false, "links",
                List.of(m("to", other, "rules", "Ask Other."))));
        assertThat(map(map(cards.get(2).get("before")).get("timer"))).containsEntry("id", timer.get("id"))
                .containsEntry("label", "Nightly").containsEntry("enabled", false);
        Map<String, Object> removal = map(cards.get(3).get("before"));
        assertThat(((Number) removal.get("usedBytes")).longValue()).isPositive();
        assertThat(removal).containsEntry("name", "Researcher")
                .containsEntry("look", m("icon", "nodes", "tone", "teal", "png", null))
                .containsEntry("links", List.of(m("to", other, "rules", "Ask Other.")))
                .containsEntry("incoming", List.of(m("from", other, "rules", "Ask Researcher.")));
        assertThat(list(removal.get("timers"))).singleElement().satisfies(t -> assertThat(t)
                .containsEntry("label", "Nightly"));
        assertThat(cards.get(4)).containsEntry("before", null);
    }

    @Test
    void theLeadIsToldWhenAnotherAgentAlreadyLooksLikeThat() throws Exception {
        desk.call("agent.update", "agentId", researcher, "icon", "compass", "tone", "teal");
        desk.provider.then(Step.calls(USAGE, List.of(
                call("t1", "propose_agent", "name", "Scout", "purpose", "x", "icon", "compass", "tone", "teal"),
                call("t2", "propose_agent", "name", "Other", "purpose", "x", "icon", "compass", "tone", "plum"),
                call("t3", "propose_agent_change", "agent", researcher, "tone", "teal"))))
                .then(Step.answer(USAGE, "Ok."));

        desk.ask(AgentStore.MANAGER, "Two agents.");

        List<ToolResult> results = TeamDesk.toolResults(desk.lastRequest());
        assertThat(results).noneMatch(ToolResult::error);
        assertThat(results.get(0).content()).contains("already has that icon on that tone");
        assertThat(results.get(1).content()).doesNotContain("already has that icon");
        assertThat(results.get(2).content()).as("its own look").doesNotContain("already has that icon");
    }

    // ---------------------------------------------------------------- who has the tools

    @Test
    void theLeadIsOfferedTheProposeToolsAndAStaffAgentIsNot() throws Exception {
        desk.ask(AgentStore.MANAGER, "Hello");
        List<String> lead = TeamDesk.toolNames(desk.lastRequest());
        desk.ask(researcher, "Hello");
        List<String> staff = TeamDesk.toolNames(desk.lastRequest());

        assertThat(lead).contains("propose_agent", "propose_agent_change", "propose_agent_removal", "propose_links",
                "propose_timer", "propose_timer_removal", "desk_agents", "desk_choices", "workspace_list",
                "workspace_read", "workspace_write");
        // With no deskd here, the Agent's own tools (the tools and approvals draft) but none of deskd's.
        assertThat(staff).containsExactly("workspace_list", "workspace_read", "workspace_write", "plan_update",
                "follow_up", "workspace_delete", "memory_save", "memory_forget");
    }

    @Test
    void aStaffAgentThatCallsAProposeToolAnywayIsRefused() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(call("t1", "propose_agent", "name", "Sneak", "purpose", "x",
                "icon", "nodes", "tone", "teal"), call("t2", "desk_agents")))).then(Step.answer(USAGE, "Ok."));

        Map<String, Object> reply = desk.ask(researcher, "Make a new agent.");

        List<ToolResult> results = TeamDesk.toolResults(desk.lastRequest());
        assertThat(results).hasSize(2).allMatch(ToolResult::error);
        assertThat(results.getFirst().content()).contains("no tool named propose_agent");
        assertThat(reply.get("proposals")).isNull();
        assertThat(agentCount()).isEqualTo(2);
        assertThat(desk.team.teamStore().hasProposals()).isFalse();
    }

    // ---------------------------------------------------------------- bad proposals reach the model as errors

    @Test
    void badProposalsComeBackAsErrorResultsNotAsRpcErrors() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(
                call("t1", "propose_agent", "name", "A", "purpose", "x", "icon", "nope", "tone", "teal"),
                call("t2", "propose_agent", "name", "A", "purpose", "x", "icon", "nodes", "tone", "nope"),
                call("t3", "propose_agent", "name", "A", "purpose", "x", "icon", "nodes", "tone", "teal", "links",
                        List.of(m("to", "Nobody", "rules", "Hi."))),
                call("t4", "propose_agent", "name", "A", "purpose", "x", "icon", "nodes", "tone", "teal", "links",
                        List.of(m("to", researcher, "rules", "r".repeat(501)))),
                call("t5", "propose_agent", "name", "", "purpose", "x", "icon", "nodes", "tone", "teal"),
                call("t6", "propose_agent_removal", "agent", "manager"),
                call("t7", "propose_agent_change", "agent", researcher),
                call("t8", "propose_nothing"),
                call("t9", "propose_timer", "agent", researcher, "timer", m("label", "T", "kind", "repeat",
                        "everyMinutes", 1, "prompt", "Too often.")),
                call("t10", "propose_links", "agent", "Nobody", "links", List.of())))).then(Step.answer(USAGE, "Sorry."));

        Map<String, Object> reply = desk.ask(AgentStore.MANAGER, "Do a lot of wrong things.");

        assertThat(reply).containsEntry("state", "done").containsEntry("text", "Sorry.");
        assertThat(reply.get("proposals")).isNull();
        List<ToolResult> results = TeamDesk.toolResults(desk.lastRequest());
        assertThat(results).hasSize(10).allMatch(ToolResult::error);
        assertThat(results).extracting(ToolResult::content).satisfiesExactly(
                c -> assertThat(c).contains("bad_request").contains("(icon)"),
                c -> assertThat(c).contains("bad_request").contains("(tone)"),
                c -> assertThat(c).contains("not_found").contains("(agent)"),
                c -> assertThat(c).contains("bad_request").contains("(links)"),
                c -> assertThat(c).contains("bad_request").contains("(name)"),
                c -> assertThat(c).contains("(lead)"),
                c -> assertThat(c).contains("bad_request"),
                c -> assertThat(c).contains("no tool named"),
                c -> assertThat(c).contains("(everyMinutes)"),
                c -> assertThat(c).contains("not_found"));
        assertThat(desk.team.teamStore().hasProposals()).isFalse();
        assertThat(agentCount()).isEqualTo(2);
    }

    @Test
    void aProposalToCreateOverTheCapIsAnErrorResult() throws Exception {
        desk.tier(m("agentCap", 2));
        desk.provider.then(Step.calls(USAGE, List.of(call("t1", "propose_agent", "name", "Third", "purpose", "x",
                "icon", "nodes", "tone", "teal")))).then(Step.answer(USAGE, "Full."));

        Map<String, Object> reply = desk.ask(AgentStore.MANAGER, "One more agent.");

        assertThat(reply.get("proposals")).isNull();
        ToolResult result = TeamDesk.lastToolResult(desk.lastRequest());
        assertThat(result.error()).isTrue();
        assertThat(result.content()).contains("precondition_failed").contains("agent_cap");
    }

    // ---------------------------------------------------------------- every action applies as the member's change

    @Test
    void changeLinksTimerAndRemovalProposalsApplyAsTheMembersOwnChanges() throws Exception {
        String other = desk.agent("Other");
        desk.provider.then(Step.calls(USAGE, List.of(
                call("c1", "propose_agent_change", "agent", "Researcher", "name", "Reader", "purpose", "Read more.",
                        "icon", "book", "tone", "plum", "workspaceMb", 7),
                call("c2", "propose_links", "agent", researcher, "links",
                        List.of(m("to", "Other", "rules", "Ask Other for facts."))),
                call("c3", "propose_timer", "agent", researcher, "timer", m("label", "Nudge", "kind", "once",
                        "inMinutes", 30, "prompt", "Nudge.")),
                call("c4", "propose_agent_removal", "agent", other)))).then(Step.answer(USAGE, "Four cards."));

        List<Map<String, Object>> cards = proposalsOf(desk.ask(AgentStore.MANAGER, "Tidy up."));

        assertThat(cards).extracting(c -> c.get("action")).containsExactly("agent.update", "agent.links", "timer.set",
                "agent.delete");
        assertThat(cards).allSatisfy(c -> assertThat(c.get("sha256")).isEqualTo(Canonical.sha256(c.get("payload"))));
        assertThat(map(desk.agentView(researcher))).containsEntry("name", "Researcher");

        assertThat(answer(cards.get(0), true)).containsEntry("state", "applied");
        Map<String, Object> changed = desk.agentView(researcher);
        assertThat(changed).containsEntry("name", "Reader").containsEntry("purpose", "Read more.");
        assertThat(map(changed.get("look"))).containsEntry("icon", "book").containsEntry("tone", "plum");
        assertThat(map(changed.get("workspace"))).containsEntry("quotaBytes", 7L << 20);

        assertThat(answer(cards.get(1), true)).containsEntry("state", "applied");
        assertThat(list(desk.agentView(researcher).get("links"))).containsExactly(m("to", other, "rules",
                "Ask Other for facts."));
        assertThat(desk.agentView(researcher)).containsEntry("solo", false);

        Map<String, Object> timer = answer(cards.get(2), true);
        assertThat(timer).containsEntry("state", "applied");
        List<Map<String, Object>> timers = list(desk.call("agent.timer.list", "agentId", researcher).get("timers"));
        assertThat(timers).singleElement().satisfies(t -> {
            assertThat(t).containsEntry("label", "Nudge").containsEntry("kind", "once").containsEntry("enabled", true);
            assertThat(map(timer.get("result"))).containsEntry("timerId", t.get("id"));
        });

        assertThat(answer(cards.get(3), true)).containsEntry("state", "applied");
        assertThat(desk.refused("agent.get", "agentId", other).code()).isEqualTo("not_found");
        assertThat(list(desk.agentView(researcher).get("links"))).as("its link to the removed agent went with it")
                .isEmpty();

        String timerId = (String) timers.getFirst().get("id");
        desk.provider.then(Step.calls(USAGE, List.of(call("r1", "propose_timer_removal", "agent", researcher,
                "timerId", timerId)))).then(Step.answer(USAGE, "Remove it?"));
        Map<String, Object> removal = proposalsOf(desk.ask(AgentStore.MANAGER, "Drop the nudge.")).getFirst();
        assertThat(removal).containsEntry("action", "timer.delete");
        assertThat(answer(removal, true)).containsEntry("state", "applied");
        assertThat(list(desk.call("agent.timer.list", "agentId", researcher).get("timers"))).isEmpty();
    }

    @Test
    void theLeadSeesTheDeskButNoKeys() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(call("a", "desk_agents"), call("b", "desk_choices"))))
                .then(Step.answer(USAGE, "Seen."));

        desk.ask(AgentStore.MANAGER, "What do we have?");

        List<ToolResult> results = TeamDesk.toolResults(desk.lastRequest());
        assertThat(results).hasSize(2).noneMatch(ToolResult::error);
        assertThat(results.get(0).content()).contains("Researcher").contains(researcher).contains("\"lead\":true");
        assertThat(results.get(1).content()).contains("compass").contains("teal").contains("agentCap")
                .contains(desk.key());
        assertThat(results.get(0).content() + results.get(1).content()).doesNotContain(TeamDesk.KEY);
    }
}
