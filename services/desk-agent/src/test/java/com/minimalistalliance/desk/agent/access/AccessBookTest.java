package com.minimalistalliance.desk.agent.access;

import static com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.m;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.service.Caller;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.Setups;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.file.Path;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Each agent's access and the setup gate (draft ADR "the Agent's tools and approvals", sections 14 to 16), through a
 * real {@code AgentService} on real SQLite: every state of a choice, who may make it, the upgrade of agents made before,
 * a record that doesn't read back whole, grants to other desks, and what's audited.
 */
class AccessBookTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);

    @TempDir
    Path data;

    private final MutableClock clock = new MutableClock(Rig.START);
    private TeamDesk desk;

    @BeforeEach
    void start() throws Exception {
        desk = new TeamDesk(data, clock);
    }

    @AfterEach
    void stop() {
        desk.close();
    }

    /** A staff agent on the desk's key whose setup screen hasn't been saved. */
    private String unsetAgent(String name) throws Exception {
        Map<String, Object> p = m("name", name, "keyId", desk.key(), "model", Rig.MODEL);
        return (String) map(desk.service.call("agent.create", p).get("agent")).get("id");
    }

    private Map<String, Object> access(String agentId) throws Exception {
        return map(desk.call("agent.access.get", "agentId", agentId).get("access"));
    }

    private Map<String, Object> set(String agentId, Object... pairs) throws Exception {
        Map<String, Object> p = m(pairs);
        p.put("agentId", agentId);
        return map(desk.service.call("agent.access.set", p).get("access"));
    }

    private RpcError setRefused(String agentId, Object... pairs) {
        Map<String, Object> p = m(pairs);
        p.put("agentId", agentId);
        try {
            desk.service.call("agent.access.set", p);
        } catch (RpcError e) {
            return e;
        } catch (Exception e) {
            throw new AssertionError(e);
        }
        throw new AssertionError("not refused");
    }

    private static Map<String, Object> apps(boolean notebook, boolean files, boolean browser, boolean courier,
            boolean todos) {
        return m("notebook", notebook, "files", files, "browser", browser, "courier", courier, "todos", todos);
    }

    private static Map<String, Object> autoOff() {
        return m("notebook", null, "files", null, "todos", false);
    }

    private List<AuditLog.Row> audited(String action) throws Exception {
        return desk.audit.readBefore(null, 500).stream().filter(row -> row.entry().action().equals(action)).toList();
    }

    private void sql(String statement, Object... args) throws Exception {
        desk.store.database().transaction(connection -> {
            try (PreparedStatement s = connection.prepareStatement(statement)) {
                for (int i = 0; i < args.length; i++) {
                    s.setObject(i + 1, args[i]);
                }
                s.executeUpdate();
            }
            return null;
        });
    }

    // ---------------------------------------------------------------- the gate

    @Test
    void aNewAgentWaitsForItsSetupScreenAndNothingReachesItsThread() throws Exception {
        String a = unsetAgent("Alice");
        assertThat(desk.agentView(a)).containsEntry("setup", "new");
        Map<String, Object> access = access(a);
        assertThat(access).containsEntry("chosen", false).containsEntry("setup", "new");
        // The screen's defaults: Notebook, Files, the Browser and To-dos on; Courier, every switch and every desk off.
        assertThat(map(access.get("apps"))).isEqualTo(apps(true, true, true, false, true));
        assertThat(map(access.get("auto"))).isEqualTo(autoOff());
        assertThat(list(access.get("desks"))).isEmpty();
        assertThat(list(access.get("incoming"))).isEmpty();

        RpcError refused = desk.refused("agent.message.send", "agentId", a, "text", "Hello");
        assertThat(refused.code()).isEqualTo("precondition_failed");
        assertThat(refused.details()).containsEntry("reason", "setup");
        assertThat(desk.thread(a)).isEmpty();
        assertThat(desk.requests()).isEmpty();
    }

    @Test
    void theLeadOnANewDeskWaitsForItsScreenToo() throws Exception {
        desk.call("agent.bind", "agentId", AgentStore.MANAGER, "keyId", desk.key(), "model", Rig.MODEL);
        assertThat(desk.agentView(AgentStore.MANAGER)).containsEntry("setup", "new");
        assertThat(desk.refused("agent.message.send", "agentId", AgentStore.MANAGER, "text", "Hi").details())
                .containsEntry("reason", "setup");
        desk.setUp(AgentStore.MANAGER);
        assertThat(desk.ask(AgentStore.MANAGER, "Hi")).containsEntry("state", "done");
    }

    @Test
    void savingTheScreenSetsItUpAndRunsGo() throws Exception {
        String a = unsetAgent("Alice");
        Map<String, Object> saved = set(a, "apps", apps(true, false, true, false, true), "auto", autoOff());
        assertThat(saved).containsEntry("chosen", true).containsEntry("setup", null);
        assertThat(saved.get("updatedAt")).isEqualTo(clock.millis());
        assertThat(map(saved.get("apps"))).isEqualTo(apps(true, false, true, false, true));
        assertThat(desk.agentView(a)).containsEntry("setup", null);
        assertThat(desk.ask(a, "Hello")).containsEntry("state", "done");

        AuditLog.Row row = audited("access.set").getFirst();
        assertThat(row.entry().actor()).isEqualTo("user");
        assertThat(row.entry().decision()).isEqualTo("setup");
        // The first save lists what was switched on; never a place or a desk's name.
        assertThat(row.entry().target()).isEqualTo("agent:" + a + " browser:on notebook:on todos:on");
    }

    @Test
    void theFirstSaveNeedsEveryAppAndEverySwitchAndNothingElse() throws Exception {
        String a = unsetAgent("Alice");
        assertThat(setRefused(a, "apps", apps(true, true, true, false, true)).details())
                .containsEntry("detail", "auto").containsEntry("reason", "required");
        assertThat(setRefused(a, "auto", autoOff()).details()).containsEntry("detail", "apps");
        assertThat(setRefused(a, "apps", m("notebook", true), "auto", autoOff()).details())
                .containsEntry("reason", "required");
        assertThat(setRefused(a, "apps", apps(true, true, true, false, true), "auto", m("todos", false)).details())
                .containsEntry("reason", "required");
        assertThat(setRefused(a, "apps", apps(true, true, true, false, true), "auto", autoOff(), "chosen", true)
                .details()).containsEntry("detail", "chosen");
        Map<String, Object> badApps = apps(true, true, true, false, true);
        badApps.put("shell", true);
        assertThat(setRefused(a, "apps", badApps, "auto", autoOff()).details()).containsEntry("detail", "apps.shell");
        Map<String, Object> notBool = apps(true, true, true, false, true);
        notBool.put("files", "yes");
        assertThat(setRefused(a, "apps", notBool, "auto", autoOff()).details()).containsEntry("detail", "apps.files");
        // Nothing of any of those applied.
        assertThat(access(a)).containsEntry("chosen", false);
        assertThat(audited("access.set")).isEmpty();
    }

    @Test
    void laterChangesNameOnlyWhatChangesAndAreAudited() throws Exception {
        String a = desk.agent("Alice");
        clock.advance(java.time.Duration.ofMinutes(5));
        Map<String, Object> changed = set(a, "apps", m("courier", true, "browser", false));
        assertThat(map(changed.get("apps"))).isEqualTo(apps(true, true, false, true, true));
        assertThat(changed.get("updatedAt")).isEqualTo(clock.millis());
        AuditLog.Row row = audited("access.set").getFirst();
        assertThat(row.entry().decision()).isEqualTo("ok");
        assertThat(row.entry().target()).isEqualTo("agent:" + a + " browser:off courier:on");
    }

    @Test
    void aTimersRunAndAnotherAgentsMessageWaitForTheScreenToo() throws Exception {
        desk.bindLead();
        String b = unsetAgent("Bob");
        desk.link(AgentStore.MANAGER, b, "Ask Bob.");
        desk.open(b);
        // The lead's message to an agent not set up is refused, and the lead reads why.
        desk.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "message_agent", "to", "Bob", "text",
                "Hello Bob")))).then(Step.answer(USAGE, "Bob isn't set up yet."));
        desk.ask(AgentStore.MANAGER, "Ask Bob.");
        ToolResult result = TeamDesk.lastToolResult(desk.lastRequest());
        assertThat(result.error()).isTrue();
        assertThat(result.content()).contains("waiting for the member to set it up");
        assertThat(desk.thread(b)).isEmpty();

        // A timer on an agent not set up: its run is refused, and the timer says why.
        desk.call("agent.timer.set", "agentId", b, "timer", m("label", "Soon", "kind", "once", "inMinutes", 1,
                "prompt", "Check."));
        clock.advance(java.time.Duration.ofMinutes(2));
        desk.team.timers().runDue();
        Map<String, Object> timer = list(desk.call("agent.timer.list", "agentId", b).get("timers")).getFirst();
        assertThat(timer.get("lastState")).isEqualTo("setup");
        assertThat(desk.thread(b)).isEmpty();
    }

    // ---------------------------------------------------------------- the upgrade

    @Test
    void agentsMadeBeforeTheScreenGetItOnTheirNextRunStartingFromWhatTheyHad() throws Exception {
        desk.bindLead();
        String old = desk.agent("Old");
        desk.ask(old, "Before the upgrade.");
        desk.close();
        // As a desk-agent from before left the file: no access tables at all.
        try (TeamDesk raw = new TeamDesk(data, clock)) {
            raw.store.database().transaction(connection -> {
                try (Statement s = connection.createStatement()) {
                    s.execute("DROP TABLE agent_access");
                    s.execute("DROP TABLE desk_grants");
                }
                return null;
            });
        }
        desk = new TeamDesk(data, clock);

        for (String id : List.of(AgentStore.MANAGER, old)) {
            assertThat(desk.agentView(id)).containsEntry("setup", "upgrade");
            Map<String, Object> access = access(id);
            assertThat(access).containsEntry("chosen", false).containsEntry("setup", "upgrade");
            // What it could use until now: Notebook, Files and the Browser; Courier and To-dos off.
            assertThat(map(access.get("apps"))).isEqualTo(apps(true, true, true, false, false));
            assertThat(desk.refused("agent.message.send", "agentId", id, "text", "After").details())
                    .containsEntry("reason", "setup");
        }
        // Its thread is all still there, and nothing was added.
        assertThat(desk.thread(old)).hasSize(2);
        // A new agent made after the upgrade is new, not an upgrade.
        assertThat(desk.agentView(unsetAgent("New"))).containsEntry("setup", "new");

        set(old, "apps", apps(true, true, true, false, false), "auto", autoOff());
        assertThat(desk.ask(old, "After the upgrade.")).containsEntry("state", "done");
        // Opening again doesn't make it an upgrade again.
        desk.close();
        desk = new TeamDesk(data, clock);
        assertThat(desk.agentView(old)).containsEntry("setup", null);
        assertThat(desk.agentView(AgentStore.MANAGER)).containsEntry("setup", "upgrade");
    }

    // ---------------------------------------------------------------- lasting, and failing closed

    @Test
    void aChoiceLastsAcrossARestart() throws Exception {
        String a = desk.agent("Alice");
        set(a, "apps", m("files", false));
        desk.close();
        desk = new TeamDesk(data, clock);
        Map<String, Object> access = access(a);
        assertThat(access).containsEntry("chosen", true);
        assertThat(map(access.get("apps"))).isEqualTo(apps(true, false, true, false, true));
    }

    @Test
    void aRowEditedByHandReadsAsNothingChosenOnceAudited() throws Exception {
        String a = desk.agent("Alice");
        // Courier switched on in the row without its hash, as a hand edit or a torn write would leave it.
        sql("UPDATE agent_access SET body = replace(body, '\"courier\":false', '\"courier\":true') WHERE agent_id = ?",
                a);
        desk.service.access().forget(a);
        Map<String, Object> access = access(a);
        assertThat(access).containsEntry("chosen", false).containsEntry("setup", "confirm");
        assertThat(map(access.get("apps")).get("courier")).isEqualTo(false);
        assertThat(desk.refused("agent.message.send", "agentId", a, "text", "Hi").details())
                .containsEntry("reason", "setup");
        assertThat(desk.service.access().allows(a, "files_list")).isFalse();
        // Read again and again, it's audited once.
        desk.service.access().forget(a);
        access(a);
        assertThat(audited("access.tampered")).hasSize(1);
        assertThat(audited("access.tampered").getFirst().entry().target()).isEqualTo("agent:" + a);
        // The member's save mends it.
        set(a, "apps", apps(true, true, true, false, true), "auto", autoOff());
        assertThat(desk.ask(a, "Hi")).containsEntry("state", "done");
    }

    @Test
    void aRowWhoseHashWasRecomputedForAnotherAgentOrThatDoesntParseFailsClosed() throws Exception {
        String a = desk.agent("Alice");
        String b = desk.agent("Bob");
        // Bob's row copied onto Alice's: its hash binds Bob's id, so it doesn't match.
        sql("UPDATE agent_access SET body = (SELECT body FROM agent_access WHERE agent_id = ?2), sha256 = (SELECT"
                + " sha256 FROM agent_access WHERE agent_id = ?2) WHERE agent_id = ?1", a, b);
        desk.service.access().forget(a);
        assertThat(access(a)).containsEntry("chosen", false).containsEntry("setup", "confirm");
        // Not JSON at all.
        sql("UPDATE agent_access SET body = 'not json' WHERE agent_id = ?", b);
        desk.service.access().forget(b);
        assertThat(access(b)).containsEntry("chosen", false);
        // A row with no body that isn't the upgrade's.
        String c = desk.agent("Carol");
        sql("UPDATE agent_access SET body = NULL, legacy = 0 WHERE agent_id = ?", c);
        desk.service.access().forget(c);
        assertThat(access(c)).containsEntry("setup", "confirm");
    }

    @Test
    void deskdHoldingNoRecordOfAnAgentMakesItWaitForTheMemberToConfirmWithItsChoicesKept() throws Exception {
        String a = desk.agent("Alice");
        String b = desk.agent("Bob");
        set(b, "apps", m("files", false));
        desk.service.deskdHoldsAccess(List.of(a));
        assertThat(access(a)).containsEntry("chosen", true);
        Map<String, Object> bob = access(b);
        assertThat(bob).containsEntry("chosen", false).containsEntry("setup", "confirm");
        // Kept, so the screen starts from what the member chose; never more than it was.
        assertThat(map(bob.get("apps"))).isEqualTo(apps(true, false, true, false, true));
        assertThat(audited("access.confirm")).singleElement().satisfies(row -> {
            assertThat(row.entry().actor()).isEqualTo("system");
            assertThat(row.entry().target()).isEqualTo("agent:" + b);
            assertThat(row.entry().decision()).isEqualTo("hello");
        });
        assertThat(desk.refused("agent.message.send", "agentId", b, "text", "Hi").details())
                .containsEntry("reason", "setup");
        // Confirming it again sets it up; a later save is a change, not a first save.
        set(b, "apps", apps(true, false, true, false, true), "auto", autoOff());
        assertThat(access(b)).containsEntry("chosen", true);
        // And a tool refusal saying deskd holds none does the same.
        desk.service.access().deskdHasNoRecord(a);
        assertThat(access(a)).containsEntry("setup", "confirm");
    }

    // ---------------------------------------------------------------- the switches

    @Test
    void aSwitchNeedsItsAppAndAnAppSwitchedOffTakesItsSwitch() throws Exception {
        String a = unsetAgent("Alice");
        assertThat(setRefused(a, "apps", apps(false, true, true, false, true), "auto", m("notebook",
                m("tabId", "tab-1"), "files", null, "todos", false)).details()).containsEntry("detail",
                "auto.notebook").containsEntry("reason", "app_off");
        Map<String, Object> on = set(a, "apps", apps(true, true, true, false, true), "auto", m("notebook",
                m("tabId", "tab-1"), "files", m("folder", "Alice"), "todos", true));
        assertThat(map(on.get("auto"))).isEqualTo(m("notebook", m("tabId", "tab-1"), "files", m("folder", "Alice"),
                "todos", true));
        assertThat(desk.service.access().switchedOn(a)).containsExactlyInAnyOrder("notebook", "files", "todos");
        Map<String, Object> off = set(a, "apps", m("notebook", false, "files", false));
        assertThat(desk.service.access().switchedOn(a)).containsExactly("todos");
        assertThat(map(off.get("auto"))).isEqualTo(m("notebook", null, "files", null, "todos", true));
        assertThat(audited("access.set").getFirst().entry().target())
                .contains("notebook:off", "files:off", "auto.notebook:off", "auto.files:off");
        set(a, "auto", m("todos", false));
        assertThat(desk.service.access().switchedOn(a)).isEmpty();
        // Waiting for the member to confirm, nothing is on, whatever the record held.
        set(a, "auto", m("todos", true));
        desk.service.access().deskdHasNoRecord(a);
        assertThat(desk.service.access().switchedOn(a)).isEmpty();
    }

    @Test
    void aSwitchsPlaceIsNeverTheWholeNotebookOrAllOfFilesOrAPlaceOutsideIt() throws Exception {
        String a = desk.agent("Alice");
        for (String folder : List.of("", "/", "../x", "a/../b", ".trash", "a/.uploads/b", "a\\b", "a‎b",
                "a\nb")) {
            assertThat(setRefused(a, "auto", m("files", m("folder", folder))).details())
                    .as(folder).containsEntry("detail", "auto.files");
        }
        assertThat(setRefused(a, "auto", m("notebook", m("tabId", "a/b"))).details())
                .containsEntry("detail", "auto.notebook");
        assertThat(setRefused(a, "auto", m("notebook", m("tabId", "t", "extra", 1))).details())
                .containsEntry("detail", "auto.notebook");
        assertThat(map(set(a, "auto", m("files", m("folder", "/Research/Alice/"))).get("auto")).get("files"))
                .isEqualTo(m("folder", "Research/Alice"));
    }

    // ---------------------------------------------------------------- other desks

    @Test
    void anotherDeskIsAnExplicitGrantOffByDefaultOfferedRevocableAndAudited() throws Exception {
        String a = desk.agent("Alice");
        assertThat(desk.service.access().allows(a, "desk_message")).isFalse();
        assertThat(setRefused(a, "desks", List.of(m("deskId", "d-work", "on", true))).details())
                .containsEntry("reason", "name");
        Map<String, Object> offered = set(a, "desks", List.of(m("deskId", "d-work", "deskName", " Work ", "on",
                true)));
        Map<String, Object> half = list(offered.get("desks")).getFirst();
        assertThat(half).containsEntry("agentId", a).containsEntry("toDeskId", "d-work")
                .containsEntry("toDeskName", "Work").containsEntry("state", "offered").containsEntry("toKey", null)
                .containsEntry("count", 0).containsEntry("lastUsedAt", null);
        assertThat((String) half.get("grantId")).matches("dg-[a-z2-7]{20}");
        // Offered is not yet a grant: the other desk hasn't allowed it, so no tool.
        assertThat(desk.service.access().allows(a, "desk_message")).isFalse();
        assertThat(desk.service.access().activeGrants(a)).isEmpty();
        assertThat(audited("desks.offer")).singleElement().satisfies(row -> assertThat(row.entry().target())
                .isEqualTo("agent:" + a + " grant:" + half.get("grantId") + " desk:d-work"));
        // Saying on again keeps the one half.
        assertThat(list(set(a, "desks", List.of(m("deskId", "d-work", "on", true))).get("desks"))).hasSize(1);

        // Off revokes it at once.
        assertThat(list(set(a, "desks", List.of(m("deskId", "d-work", "on", false))).get("desks"))).isEmpty();
        assertThat(audited("desks.revoke")).singleElement().satisfies(row -> assertThat(row.entry().decision())
                .isEqualTo("ok"));

        // agent.desks.revoke by its id, from the settings' Stop.
        Map<String, Object> again = list(set(a, "desks", List.of(m("deskId", "d-home", "deskName", "Home", "on",
                true))).get("desks")).getFirst();
        Map<String, Object> revoked = desk.service.call("agent.desks.revoke", m("grantId", again.get("grantId")));
        assertThat(revoked).containsEntry("agentId", a);
        assertThat(list(map(revoked.get("access")).get("desks"))).isEmpty();
        assertThat(desk.refused("agent.desks.revoke", "grantId", again.get("grantId")).code()).isEqualTo("not_found");
        assertThat(desk.refused("agent.desks.revoke", "grantId", "dg-nope").code()).isEqualTo("not_found");
        assertThat(desk.refused("agent.desks.revoke", "grantId", 5).code()).isEqualTo("bad_request");
        assertThat(audited("desks.revoke")).hasSize(2);
    }

    @Test
    void anActiveGrantIsTheOnlyOneDeskMessageMayUseAndAGrantRowEditedByHandIsNone() throws Exception {
        String a = desk.agent("Alice");
        String grantId = (String) list(set(a, "desks", List.of(m("deskId", "d-work", "deskName", "Work", "on",
                true))).get("desks")).getFirst().get("grantId");
        // The other desk's Allow (messages between desks, W6) makes the half active, with its hash.
        sql("UPDATE desk_grants SET state = 'active', sha256 = ? WHERE grant_id = ?",
                AccessBook.halfHash(grantId, a, "d-work", "active"), grantId);
        desk.service.access().forget(a);
        assertThat(desk.service.access().allows(a, "desk_message")).isTrue();
        assertThat(desk.service.access().activeGrants(a)).hasSize(1);
        // Made active by hand, without its hash: no grant at all, and audited.
        sql("UPDATE desk_grants SET state = 'active', to_desk_id = 'd-other' WHERE grant_id = ?", grantId);
        assertThat(desk.service.access().allows(a, "desk_message")).isFalse();
        assertThat(list(access(a).get("desks"))).isEmpty();
        assertThat(audited("access.tampered")).hasSize(1);
    }

    @Test
    void deskNamesAndIdsAreChecked() throws Exception {
        String a = desk.agent("Alice");
        assertThat(setRefused(a, "desks", List.of(m("deskId", "D WORK", "deskName", "Work", "on", true))).code())
                .isEqualTo("bad_request");
        assertThat(setRefused(a, "desks", List.of(m("deskId", "d-w", "deskName", "x".repeat(61), "on", true)))
                .details()).containsEntry("reason", "name");
        assertThat(setRefused(a, "desks", List.of(m("deskId", "d-w", "deskName", "Wo‮k", "on", true))).code())
                .isEqualTo("bad_request");
        assertThat(setRefused(a, "desks", List.of(m("deskId", "d-w", "deskName", "W", "on", true),
                m("deskId", "d-w", "deskName", "W", "on", false))).code()).isEqualTo("bad_request");
        assertThat(setRefused(a, "desks", List.of(m("deskId", "d-w", "on", true, "key", "x"))).code())
                .isEqualTo("bad_request");
    }

    @Test
    void deletingAnAgentRevokesItsGrantsAndItsChoicesGo() throws Exception {
        String a = desk.agent("Alice");
        set(a, "desks", List.of(m("deskId", "d-work", "deskName", "Work", "on", true)));
        desk.call("agent.delete", "agentId", a);
        assertThat(audited("desks.revoke")).singleElement().satisfies(row -> assertThat(row.entry().decision())
                .isEqualTo("deleted"));
        Integer rows = desk.store.database().call(connection -> {
            try (Statement s = connection.createStatement();
                    var r = s.executeQuery("SELECT (SELECT count(*) FROM agent_access WHERE agent_id = '" + a
                            + "') + (SELECT count(*) FROM desk_grants WHERE agent_id = '" + a + "')")) {
                r.next();
                return r.getInt(1);
            }
        });
        assertThat(rows).isZero();
    }

    // ---------------------------------------------------------------- who may choose

    @Test
    void aLeadsProposalCantCarryAccessAndTheAgentItMakesWaitsForItsScreen() throws Exception {
        desk.bindLead();
        desk.provider.then(Step.calls(USAGE, List.of(Step.call("t1", "propose_agent", "name", "Planner", "purpose",
                "Plan.", "icon", "pen", "tone", "harbor", "access", m("apps", apps(true, true, true, true, true))))))
                .then(Step.answer(USAGE, "Proposed."));
        desk.ask(AgentStore.MANAGER, "Make a planner with Courier.");
        // The schema takes no access: the proposal is refused as input, and nothing is made.
        assertThat(list(desk.call("agent.list").get("agents"))).hasSize(1);
        desk.provider.then(Step.calls(USAGE, List.of(Step.call("t2", "propose_agent", "name", "Planner", "purpose",
                "Plan.", "icon", "pen", "tone", "harbor")))).then(Step.answer(USAGE, "Proposed."));
        Map<String, Object> card = list(desk.ask(AgentStore.MANAGER, "Make a planner.").get("proposals")).getFirst();
        assertThat(map(card.get("payload"))).doesNotContainKeys("access", "apps", "auto", "desks");
        Map<String, Object> applied = map(desk.call("agent.proposal.answer", "proposalId", card.get("id"), "accept",
                true, "sha256", card.get("sha256")).get("proposal"));
        String planner = (String) map(applied.get("result")).get("agentId");
        assertThat(desk.agentView(planner)).containsEntry("setup", "new");
        assertThat(desk.refused("agent.message.send", "agentId", planner, "text", "Hi").details())
                .containsEntry("reason", "setup");
        // agent.create by hand with access in it chooses nothing either.
        String byHand = (String) map(desk.service.call("agent.create", m("name", "Hand", "access", m("apps",
                apps(true, true, true, true, true)))).get("agent")).get("id");
        assertThat(access(byHand)).containsEntry("chosen", false);
    }

    @Test
    void aGuildMembersOwnAgentMayHaveOnlyWhatAGuildDeskGivesItAndOnlyTheyChooseIt() throws Exception {
        Caller member = new Caller(Caller.MEMBER_KIND, "gm-abcd1234", "member", List.of(), false);
        Caller other = new Caller(Caller.MEMBER_KIND, "gm-wxyz9876", "member", List.of(), false);
        desk.service.call("agent.list", Map.of(), member);
        Map<String, Object> fresh = map(desk.service.call("agent.access.get", m("agentId", member.memberId()), member)
                .get("access"));
        assertThat(map(fresh.get("apps"))).isEqualTo(apps(true, false, false, false, false));
        for (String app : List.of("files", "browser", "courier", "todos")) {
            Map<String, Object> p = Setups.guildDefaults(member.memberId());
            map(p.get("apps")).put(app, true);
            try {
                desk.service.call("agent.access.set", p, member);
                throw new AssertionError(app);
            } catch (RpcError e) {
                assertThat(e.details()).containsEntry("detail", "apps." + app).containsEntry("reason", "guild");
            }
        }
        Map<String, Object> withDesk = Setups.guildDefaults(member.memberId());
        withDesk.put("desks", List.of(m("deskId", "d-x", "deskName", "X", "on", true)));
        try {
            desk.service.call("agent.access.set", withDesk, member);
            throw new AssertionError("desks");
        } catch (RpcError e) {
            assertThat(e.details()).containsEntry("reason", "guild");
        }
        // Another member can't see it, let alone choose for it; nor reach the owner's agents.
        try {
            desk.service.call("agent.access.set", Setups.guildDefaults(member.memberId()), other);
            throw new AssertionError("other");
        } catch (RpcError e) {
            assertThat(e.code()).isEqualTo("not_found");
        }
        try {
            desk.service.call("agent.access.get", m("agentId", AgentStore.MANAGER), member);
            throw new AssertionError("owner's");
        } catch (RpcError e) {
            assertThat(e.code()).isEqualTo("not_found");
        }
        Setups.setUpMember(desk.service, member);
        Map<String, Object> chosen = map(desk.service.call("agent.access.get", m("agentId", member.memberId()),
                member).get("access"));
        assertThat(chosen).containsEntry("chosen", true);
        assertThat(audited("access.set").getFirst().entry().actor()).isEqualTo("member");
        // Whatever a row says, a member's agent gets Notebook alone.
        assertThat(desk.service.access().allows(member.memberId(), "files_list")).isFalse();
        assertThat(desk.service.access().allows(member.memberId(), "notebook_read")).isTrue();
    }

    @Test
    void theAppsGateTheirToolsAndNothingElse() throws Exception {
        String a = desk.agent("Alice");
        AccessBook book = desk.service.access();
        set(a, "apps", m("files", false, "courier", true));
        assertThat(book.allows(a, "files_read")).isFalse();
        assertThat(book.allows(a, "browser_open")).isTrue();
        assertThat(book.allows(a, "notebook_write")).isTrue();
        assertThat(book.allows(a, "courier_new")).isTrue();
        assertThat(book.allows(a, "todo_create")).isTrue();
        set(a, "apps", m("browser", false, "notebook", false, "courier", false, "todos", false));
        for (String tool : List.of("browser_open", "browser_use_my_session", "notebook_read", "courier_list",
                "todo_list", "files_list")) {
            assertThat(book.allows(a, tool)).as(tool).isFalse();
        }
        // The agent's own workspace, plan, memory and team tools aren't any app's.
        for (String tool : List.of("workspace_write", "plan_update", "memory_save", "message_agent", "follow_up")) {
            assertThat(book.allows(a, tool)).as(tool).isTrue();
        }
        // An agent not set up has no app at all.
        String b = unsetAgent("Bob");
        assertThat(book.allows(b, "notebook_read")).isFalse();
    }
}
