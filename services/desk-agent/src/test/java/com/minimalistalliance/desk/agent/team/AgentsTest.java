package com.minimalistalliance.desk.agent.team;

import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.m;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Agents on a desk: the lead, the cap, create, change, delete and links ({@code docs/multi-agent.md} sections 1, 2). */
class AgentsTest {

    @TempDir
    Path data;

    private TeamDesk desk;

    @BeforeEach
    void start() throws Exception {
        desk = new TeamDesk(data);
    }

    @AfterEach
    void stop() {
        desk.close();
    }

    private static void assertRefused(RpcError e, String code, String key, String value) {
        assertThat(e.code()).isEqualTo(code);
        assertThat(e.details()).containsEntry(key, value);
    }

    // ---------------------------------------------------------------- the lead and the cap

    @Test
    void aNewDesksLeadIsNamedLeadAndMarked() throws Exception {
        List<Map<String, Object>> agents = list(desk.call("agent.list").get("agents"));

        assertThat(agents).singleElement().satisfies(lead -> {
            assertThat(lead).containsEntry("id", "manager").containsEntry("name", "Lead")
                    .containsEntry("role", "manager").containsEntry("lead", true).containsEntry("solo", true)
                    .containsEntry("purpose", "");
            assertThat(map(lead.get("look"))).containsEntry("icon", "spark").containsEntry("tone", "graphite")
                    .containsEntry("png", null);
            assertThat(lead.get("links")).isEqualTo(List.of());
            assertThat(lead.get("timers")).isEqualTo(0);
            assertThat(map(lead.get("workspace"))).containsEntry("quotaBytes", 50L * 1024 * 1024)
                    .containsEntry("usedBytes", 0L);
        });
    }

    @Test
    void theTiersAgentCapCountsTheLeadAndRefusesTheOneOverIt() throws Exception {
        desk.tier(m("agentCap", 3));

        String first = desk.agent("First");
        String second = desk.agent("Second");
        RpcError full = desk.refused("agent.create", "name", "Third");

        assertRefused(full, "precondition_failed", "reason", "agent_cap");
        assertThat(list(desk.call("agent.list").get("agents"))).hasSize(3);
        assertThat(desk.agentView(first)).containsEntry("role", "staff").containsEntry("lead", false)
                .containsEntry("solo", true);
        assertThat((String) desk.agentView(second).get("id")).matches("ag-[a-z2-7]{12}");

        desk.call("agent.delete", "agentId", first);
        assertThat(desk.agent("Third")).as("room again").startsWith("ag-");
    }

    @Test
    void theCapsAreAnsweredAndCarriedByTheStateSnapshot() throws Exception {
        desk.tier(m("agentCap", 3, "a2aPerHour", 7, "workspaceMb", 50, "timersPerAgent", 2));
        desk.agent("One");

        Map<String, Object> caps = map(desk.call("agent.caps").get("caps"));
        assertThat(caps).containsEntry("agentCap", 3).containsEntry("agents", 2).containsEntry("a2aPerHour", 7)
                .containsEntry("workspaceMb", 50).containsEntry("timersPerAgent", 2)
                .containsEntry("workspaceMaxMb", 200).containsEntry("a2aDepth", 3);

        Map<String, Object> state = desk.service.stateSnapshot();
        assertThat(map(state.get("caps"))).isEqualTo(caps);
        assertThat(list(state.get("agents"))).hasSize(2);
    }

    @Test
    void aTierWithOutOfRangeValuesFallsBackToTheDefaultsForThoseValues() throws Exception {
        desk.tier(m("agentCap", 9999, "a2aDepth", "deep", "timerMinMinutes", 10));

        Map<String, Object> caps = map(desk.call("agent.caps").get("caps"));
        assertThat(caps).containsEntry("agentCap", TierCaps.DEFAULTS.agentCap()).containsEntry("a2aDepth", 3).containsEntry("timerMinMinutes", 10);
    }

    // ---------------------------------------------------------------- create

    @Test
    void createTakesPurposeIconToneAndWorkspaceSize() throws Exception {
        Map<String, Object> agent = map(desk.call("agent.create", "name", "Researcher", "purpose",
                "Find sources and keep notes.", "icon", "compass", "tone", "teal", "workspaceMb", 5).get("agent"));

        assertThat(agent).containsEntry("name", "Researcher").containsEntry("purpose", "Find sources and keep notes.")
                .containsEntry("solo", true).containsEntry("binding", null).containsEntry("status", "no_key")
                .containsEntry("lead", false);
        assertThat(map(agent.get("look"))).containsEntry("icon", "compass").containsEntry("tone", "teal")
                .containsEntry("png", null);
        assertThat(map(agent.get("workspace"))).containsEntry("quotaBytes", 5L * 1024 * 1024)
                .containsEntry("usedBytes", 0L).containsEntry("sharedWith", List.of());
        assertThat(data.resolve("workspaces").resolve((String) agent.get("id"))).isDirectory();
    }

    @Test
    void createCanBindAKeyAtOnceAndOpenTheAgentToMessages() throws Exception {
        String id = desk.agent("Bound", "solo", false);

        Map<String, Object> agent = desk.agentView(id);
        assertThat(map(agent.get("binding"))).containsEntry("model", Rig.MODEL).containsEntry("provider", "fake");
        assertThat(agent).containsEntry("status", "online").containsEntry("solo", false);
    }

    @Test
    void createRefusesWhatIsBad() throws Exception {
        for (String name : new String[] {"", "   ", "a/b", "x".repeat(41), "<script>"}) {
            assertRefused(desk.refused("agent.create", "name", name), "bad_request", "detail", "name");
        }
        assertRefused(desk.refused("agent.create", "name", "Ok", "icon", "PNG!"), "bad_request", "detail", "icon");
        assertRefused(desk.refused("agent.create", "name", "Ok", "tone", "Not A Tone"), "bad_request", "detail", "tone");
        assertRefused(desk.refused("agent.create", "name", "Ok", "workspaceMb", 2000), "bad_request", "detail",
                "workspaceMb");
        assertRefused(desk.refused("agent.create", "name", "Ok", "workspaceMb", 0), "bad_request", "detail",
                "workspaceMb");
        assertRefused(desk.refused("agent.create", "name", "Ok", "workspaceMb", 1.5), "bad_request", "detail",
                "workspaceMb");
        assertRefused(desk.refused("agent.create", "name", "Ok", "purpose", "p".repeat(4001)), "bad_request",
                "detail", "purpose");
        assertRefused(desk.refused("agent.create", "name", "Ok", "keyId", desk.key()), "bad_request", "detail",
                "model");
        assertRefused(desk.refused("agent.create", "name", "Ok", "keyId", "k-nope", "model", Rig.MODEL), "not_found",
                "detail", "key");
        assertThat(list(desk.call("agent.list").get("agents"))).as("none of them was made").hasSize(1);
    }

    @Test
    void theWorkspaceMaximumIsTheTiers() throws Exception {
        desk.tier(m("workspaceMaxMb", 10));

        assertRefused(desk.refused("agent.create", "name", "Big", "workspaceMb", 11), "bad_request", "detail",
                "workspaceMb");
        assertThat(map(map(desk.call("agent.create", "name", "Fits", "workspaceMb", 10).get("agent"))
                .get("workspace"))).containsEntry("quotaBytes", 10L * 1024 * 1024);
    }

    // ---------------------------------------------------------------- names and looks (Design H5, AI M5)

    private static void assertNameTaken(RpcError e) {
        assertRefused(e, "bad_request", "detail", "name");
        assertThat(e.details()).containsEntry("reason", "name_taken");
    }

    @Test
    void namesAreUniquePerDeskHoweverTheyAreWritten() throws Exception {
        String notes = desk.agent("Notes");
        for (String twin : new String[] {"Notes", "notes", "  NOTES ", "N\u043etes", "\uff2eotes", "Lead", "manager",
                notes}) {
            assertNameTaken(desk.refused("agent.create", "name", twin));
        }
        String other = desk.agent("Other");

        assertNameTaken(desk.refused("agent.update", "agentId", other, "name", "n\u03bftes", "purpose", "Changed"));
        assertThat(desk.agentView(other)).as("nothing changed").containsEntry("name", "Other")
                .containsEntry("purpose", "");
        assertThat(map(desk.call("agent.update", "agentId", notes, "name", "NOTES").get("agent")))
                .as("its own name, written another way, is fine").containsEntry("name", "NOTES");
        assertThat(list(desk.call("agent.list").get("agents"))).hasSize(3);
    }

    @Test
    void aNewAgentWithoutAToneGetsOneNoOtherAgentHasThenTheLeastUsed() throws Exception {
        desk.tier(m("agentCap", 30));
        desk.agent("Picked", "tone", "clay");
        List<String> tones = new java.util.ArrayList<>();
        for (int i = 0; i < 12; i++) {
            tones.add((String) map(desk.agentView(desk.agent("Agent " + i)).get("look")).get("tone"));
        }

        assertThat(tones).as("graphite is the lead's and never a default; clay was picked").containsExactly("rose",
                "amber", "olive", "green", "teal", "cyan", "blue", "indigo", "violet", "plum", "rose", "clay");
        assertThat(map(desk.agentView(desk.agent("Own", "tone", "rose")).get("look"))).as("a pick is kept")
                .containsEntry("tone", "rose");
    }

    @Test
    void aRetiredIconOrToneComesInAsTheOneThatTookItsPlace() throws Exception {
        Map<String, Object> made = map(desk.call("agent.create", "name", "Old", "icon", "globe", "tone", "moss")
                .get("agent"));
        assertThat(map(made.get("look"))).containsEntry("icon", "plane").containsEntry("tone", "green");

        Map<String, Object> changed = map(desk.call("agent.update", "agentId", made.get("id"), "icon", "briefcase",
                "tone", "sky").get("agent"));
        assertThat(map(changed.get("look"))).containsEntry("icon", "document").containsEntry("tone", "blue");
    }

    // ---------------------------------------------------------------- update

    @Test
    void updateChangesPurposeIconToneAndSolo() throws Exception {
        String id = desk.agent("Changer");

        Map<String, Object> agent = map(desk.call("agent.update", "agentId", id, "purpose", "New purpose",
                "icon", "leaf", "tone", "plum", "solo", false, "name", "Renamed").get("agent"));

        assertThat(agent).containsEntry("purpose", "New purpose").containsEntry("solo", false)
                .containsEntry("name", "Renamed");
        assertThat(map(agent.get("look"))).containsEntry("icon", "leaf").containsEntry("tone", "plum");

        Map<String, Object> again = map(desk.call("agent.update", "agentId", id, "tone", "rose").get("agent"));
        assertThat(map(again.get("look"))).as("the others stay").containsEntry("icon", "leaf")
                .containsEntry("tone", "rose");
        assertThat(again).containsEntry("purpose", "New purpose").containsEntry("solo", false);
    }

    @Test
    void updateRefusesWhatIsBadAndChangesNothing() throws Exception {
        String id = desk.agent("Steady", "purpose", "Keep");

        assertRefused(desk.refused("agent.update", "agentId", id, "purpose", "Changed", "icon", "PNG!"), "bad_request",
                "detail", "icon");
        assertRefused(desk.refused("agent.update", "agentId", id, "icon", "png"), "bad_request", "detail", "icon");
        assertRefused(desk.refused("agent.update", "agentId", id, "solo", "no"), "bad_request", "detail", "solo");
        assertRefused(desk.refused("agent.update", "agentId", id, "workspaceMb", 5000), "bad_request", "detail",
                "workspaceMb");
        assertRefused(desk.refused("agent.update", "agentId", "ag-nope"), "not_found", "detail", "agent");
        assertThat(desk.agentView(id)).containsEntry("purpose", "Keep");
    }

    @Test
    void aSmallerQuotaUnderTheWorkspacesUseIsRefused() throws Exception {
        String id = desk.agent("Full");
        desk.team.workspaces().write(id, "big.txt", "x".repeat(900_000), false, 10L << 20);
        desk.team.workspaces().write(id, "bigger.txt", "x".repeat(900_000), false, 10L << 20);

        assertRefused(desk.refused("agent.update", "agentId", id, "workspaceMb", 1), "precondition_failed", "reason",
                "workspace_full");
        assertThat(map(map(desk.call("agent.update", "agentId", id, "workspaceMb", 2).get("agent"))
                .get("workspace"))).containsEntry("quotaBytes", 2L << 20);
    }

    // ---------------------------------------------------------------- delete

    @Test
    void theLeadCantBeDeleted() throws Exception {
        assertRefused(desk.refused("agent.delete", "agentId", AgentStore.MANAGER), "bad_request", "detail", "lead");
        assertRefused(desk.refused("agent.delete", "agentId", "ag-nope"), "not_found", "detail", "agent");
        assertThat(list(desk.call("agent.list").get("agents"))).hasSize(1);
    }

    @Test
    void deletingAnAgentRemovesWhatWasItsAndKeepsTheLogs() throws Exception {
        desk.tier(m("timersPerAgent", 5));
        String a = desk.agent("Alpha");
        String b = desk.agent("Beta");
        String c = desk.agent("Gamma");
        desk.link(a, b, "Alpha may ask Beta.", c, "Alpha may ask Gamma.");
        desk.link(b, a, "Beta may ask Alpha.");
        desk.link(c, b, "Gamma may ask Beta.");
        desk.call("agent.timer.set", "agentId", b, "timer",
                m("label", "Tick", "kind", "once", "inMinutes", 30, "prompt", "Tick."));
        desk.team.workspaces().write(b, "notes/n.txt", "hello", false, 1 << 20);
        desk.call("agent.icon.upload", "agentId", b, "png", java.util.Base64.getEncoder().encodeToString(
                IconsTest.png(8, 8, true)));
        desk.call("agent.limits.set", "agentId", b, "policy", IconsTest.policy(7));
        assertThat(desk.limits.policyFor(b).runMaxSteps()).isEqualTo(7);
        desk.provider.then(Step.answer(new com.minimalistalliance.desk.agent.provider.Usage(10, 0, 0, 5, 0), "Hi."));
        desk.ask(b, "Hello Beta");
        desk.team.teamStore().addA2a(new com.minimalistalliance.desk.agent.store.TeamStore.A2aRow("am-aaaaaaaaaaaa", a,
                b, "ch-x", 1, "hi", "r", desk.clock.millis(), "replied", null, "ok", 5L, null));

        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> desk.call("agent.delete", "agentId", b));

        assertThat(desk.refused("agent.get", "agentId", b).code()).isEqualTo("not_found");
        assertThat(desk.refused("agent.thread.get", "agentId", b).code()).isEqualTo("not_found");
        assertThat(desk.refused("agent.timer.list", "agentId", b).code()).isEqualTo("not_found");
        assertThat(data.resolve("workspaces").resolve(b)).doesNotExist();
        assertThat(data.resolve("icons").resolve(b + ".png")).doesNotExist();
        assertThat(desk.limits.policyFor(b).runMaxSteps()).as("its limits are gone").isEqualTo(50);
        assertThat(map(desk.agentView(a)).get("links")).as("A's link to B is gone, the one to C stays")
                .isEqualTo(List.of(m("to", c, "rules", "Alpha may ask Gamma.")));
        assertThat(desk.agentView(c).get("links")).as("C's only link was to B").isEqualTo(List.of());
        assertThat(desk.team.teamStore().timers(null)).isEmpty();
        assertThat(list(desk.call("agent.a2a.list").get("messages"))).as("the message log keeps its rows")
                .hasSize(1);
        assertThat(desk.audit.readBefore(null, 200)).anyMatch(row -> row.entry().action().equals("agent.delete"));
    }

    @Test
    void anAgentThatIsRunningCantBeDeleted() throws Exception {
        String id = desk.agent("Busy");
        java.util.concurrent.CountDownLatch hold = new java.util.concurrent.CountDownLatch(1);
        desk.provider.then(Step.answer(new com.minimalistalliance.desk.agent.provider.Usage(10, 0, 0, 5, 0), "Done.")
                .heldBy(hold));
        desk.call("agent.message.send", "agentId", id, "text", "Go");
        await().atMost(Duration.ofSeconds(5)).until(() -> desk.provider.started.getCount() == 0);

        assertRefused(desk.refused("agent.delete", "agentId", id), "conflict", "reason", "busy");

        hold.countDown();
        desk.settled(id);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> desk.call("agent.delete", "agentId", id));
        assertThat(Files.exists(data.resolve("workspaces").resolve(id))).isFalse();
    }

    // ---------------------------------------------------------------- links

    @Test
    void aGoodSetOfLinksShowsWithRulesInGetAndWithoutThemInTheState() throws Exception {
        String a = desk.agent("A");
        String b = desk.agent("B");
        String c = desk.agent("C");

        Map<String, Object> view = map(desk.call("agent.links.set", "agentId", a, "solo", false, "links",
                List.of(m("to", b, "rules", "Only ask for summaries."), m("to", c, "rules", "  Be brief.  ")))
                .get("agent"));

        assertThat(view).containsEntry("solo", false);
        List<Map<String, Object>> links = list(desk.agentView(a).get("links"));
        assertThat(links).as("in the order the member gave them").containsExactly(
                m("to", b, "rules", "Only ask for summaries."), m("to", c, "rules", "Be brief."));
        assertThat(list(view.get("links"))).isEqualTo(links);

        Map<String, Object> inState = list(desk.service.stateSnapshot().get("agents")).stream()
                .filter(agent -> agent.get("id").equals(a)).findFirst().orElseThrow();
        assertThat(list(inState.get("links"))).as("only who, never the rules")
                .containsExactly(m("to", b), m("to", c));
        assertThat(inState).containsEntry("solo", false).doesNotContainKeys("purpose", "workspace");

        desk.call("agent.links.set", "agentId", a, "solo", true, "links", List.of());
        assertThat(desk.agentView(a)).containsEntry("solo", true).containsEntry("links", List.of());
    }

    @Test
    void rulesOfExactlyFiveHundredCharactersAreFine() throws Exception {
        String a = desk.agent("A");
        String b = desk.agent("B");

        desk.link(a, b, "r".repeat(500));

        assertThat(list(desk.agentView(a).get("links")).getFirst().get("rules")).isEqualTo("r".repeat(500));
    }

    @Test
    void badLinksAreRefusedAndChangeNothing() throws Exception {
        String a = desk.agent("A");
        String b = desk.agent("B");
        desk.link(a, b, "Keep me.");

        List<List<Map<String, Object>>> bad = List.of(
                List.of(m("to", b, "rules", "r".repeat(501))),
                List.of(m("to", b, "rules", "")),
                List.of(m("to", b, "rules", "   ")),
                List.of(m("to", a, "rules", "Myself.")),
                List.of(m("to", "ag-nobody0000", "rules", "Nobody.")),
                List.of(m("to", b, "rules", "One."), m("to", b, "rules", "Two.")),
                List.of(m("to", b)),
                List.of(m("rules", "No target.")));
        for (List<Map<String, Object>> links : bad) {
            assertRefused(desk.refused("agent.links.set", "agentId", a, "solo", false, "links", links), "bad_request",
                    "detail", "links");
        }
        assertRefused(desk.refused("agent.links.set", "agentId", a, "solo", false, "links", "b"), "bad_request",
                "detail", "links");
        assertRefused(desk.refused("agent.links.set", "agentId", "ag-nope", "solo", false, "links", List.of()),
                "not_found", "detail", "agent");
        assertThat(list(desk.agentView(a).get("links"))).containsExactly(m("to", b, "rules", "Keep me."));
    }

    @Test
    void theLeadCanBeLinkedTooAndThePurposeIsKept() throws Exception {
        String a = desk.agent("A", "purpose", "Mine.");

        desk.link(AgentStore.MANAGER, a, "Lead may ask A.");

        assertThat(list(desk.agentView(AgentStore.MANAGER).get("links"))).hasSize(1);
        assertThat(desk.agentView(a)).containsEntry("purpose", "Mine.");
    }

    @Test
    void aGuildMembersAgentIdIsRefusedByEveryTeamMethod() throws Exception {
        String member = "gm-member01";
        desk.team.teamStore().createAgent(member, "Theirs", desk.clock.millis(), new com.minimalistalliance.desk.agent
                .store.TeamStore.Extras(member, "", "spark", "rose", null, true, null, List.of()));
        String a = desk.agent("Mine");

        for (String method : List.of("agent.delete", "agent.timer.list", "agent.workspace.get", "agent.icon.get",
                "agent.a2a.list")) {
            assertRefused(desk.refused(method, "agentId", member), "not_found", "detail", "agent");
        }
        assertRefused(desk.refused("agent.links.set", "agentId", member, "solo", false, "links", List.of()),
                "not_found", "detail", "agent");
        assertRefused(desk.refused("agent.timer.set", "agentId", member, "timer", m("label", "T", "kind", "once",
                "inMinutes", 5, "prompt", "Go.")), "not_found", "detail", "agent");
        assertRefused(desk.refused("agent.links.set", "agentId", a, "solo", false, "links",
                List.of(m("to", member, "rules", "Hi."))), "bad_request", "detail", "links");
        assertRefused(desk.refused("agent.workspace.share", "agentId", a, "with", List.of(member)), "bad_request",
                "detail", "with");
    }
}
