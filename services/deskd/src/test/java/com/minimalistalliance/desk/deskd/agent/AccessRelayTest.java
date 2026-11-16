package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.session.SessionGrant;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
import com.minimalistalliance.desk.deskd.tools.ToolHost;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The relay of an agent's access (API.md section 18; draft ADR "the Agent's tools and approvals", section 16), on a real
 * session and a fake desk-agent on a real socket: who may change it, what deskd records of each change, that a refusal
 * records nothing, and the hello that names what deskd holds.
 */
class AccessRelayTest {

    @TempDir
    Path dir;

    private AgentRig rig;

    @BeforeEach
    void setUp() throws Exception {
        rig = new AgentRig(dir);
        rig.agent.snapshots.put("agent.state", () -> Map.of("agents", List.of()));
        rig.module.keepAccessIn(dir);
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    private static Map<String, Object> m(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }

    private static Map<String, Object> apps(boolean notebook, boolean files, boolean browser, boolean courier,
            boolean todos) {
        return m("notebook", notebook, "files", files, "browser", browser, "courier", courier, "todos", todos);
    }

    private static Map<String, Object> autoOff() {
        return m("notebook", null, "files", null, "todos", false);
    }

    private static Map<String, Object> save(String agentId, Map<String, Object> apps) {
        return m("agentId", agentId, "apps", apps, "auto", autoOff());
    }

    /** desk-agent answers each set with the apps it was sent (or these), and the desks it was sent as offered. */
    private void deskAgentApplies(Map<String, Object> holds) {
        rig.agent.handlers.put("agent.access.set", p -> {
            List<Map<String, Object>> halves = new java.util.ArrayList<>();
            if (p.get("desks") instanceof List<?> desks) {
                for (Object d : desks) {
                    Map<?, ?> desk = (Map<?, ?>) d;
                    if (Boolean.TRUE.equals(desk.get("on"))) {
                        halves.add(m("grantId", "dg-aaaaaaaaaaaaaaaaaaaa", "agentId", p.get("agentId"), "toDeskId",
                                desk.get("deskId"), "state", "offered"));
                    }
                }
            }
            return m("access", m("chosen", true, "setup", null, "apps", holds != null ? holds : p.get("apps"),
                    "auto", autoOff(), "desks", halves, "incoming", List.of()));
        });
    }

    private Map<String, Object> nextRequest(String method) throws InterruptedException {
        while (true) {
            Map<String, Object> m = rig.agent.next("req");
            if (method.equals(m.get("m"))) {
                return m;
            }
        }
    }

    private AccessRecord record() {
        return rig.module.accessRecord();
    }

    private SessionGrant viewer() {
        String fingerprint = String.format("%02x", 1 + 16).repeat(32);
        return new SessionGrant("user-1", "sid-v", "owner", fingerprint, true, false, Instant.now(),
                Instant.now().plus(Duration.ofHours(1)));
    }

    @Test
    void theMethodsAreRelayedWithTheCallerAndAreNotTeamMethods() throws Exception {
        assertThat(AgentMethods.READS).contains("agent.access.get");
        assertThat(AgentMethods.MUTATIONS).contains("agent.access.set", "agent.desks.revoke");
        assertThat(AgentMethods.TEAM_OWNER_ONLY).doesNotContain("agent.access.get", "agent.access.set",
                "agent.desks.revoke");
        rig.agent.handlers.put("agent.access.get", p -> m("access", m("chosen", false, "setup", "new")));
        TestClient owner = rig.connect("cs-1");
        Map<String, Object> got = rig.call(owner, "agent.access.get", m("agentId", "ag-1"));
        assertThat(got).containsEntry("_kind", "RES");
        Map<String, Object> sent = nextRequest("agent.access.get");
        assertThat(Json.object(sent, "caller")).containsEntry("kind", "owner");
        assertThat(Json.object(sent, "p")).containsEntry("agentId", "ag-1");
        // A read records nothing.
        assertThat(record().recorded()).isEmpty();
    }

    @Test
    void theOwnersSaveIsRelayedAndDeskdRecordsItsOwnCopyOnItsOwnFile() throws Exception {
        deskAgentApplies(null);
        TestClient owner = rig.connect("cs-1");
        assertThat(rig.call(owner, "agent.access.set", save("ag-1", apps(true, false, true, false, true))))
                .containsEntry("_kind", "RES");
        assertThat(Json.object(nextRequest("agent.access.set"), "p")).containsEntry("agentId", "ag-1");
        assertThat(record().refusal("ag-1", HostedDecls.NOTEBOOK)).isNull();
        assertThat(record().refusal("ag-1", HostedDecls.FILES)).isEqualTo("scope");
        assertThat(dir.resolve(AccessRecord.FILE)).exists();
        String file = Files.readString(dir.resolve(AccessRecord.FILE));
        assertThat(file).contains("ag-1").contains("\"mac\"");
        // A change from settings.
        rig.call(owner, "agent.access.set", m("agentId", "ag-1", "apps", m("files", true)));
        assertThat(record().refusal("ag-1", HostedDecls.FILES)).isNull();
        rig.call(owner, "agent.access.set", m("agentId", "ag-1", "apps", m("browser", false)));
        assertThat(record().refusal("ag-1", HostedDecls.BROWSER)).isEqualTo("scope");
    }

    @Test
    void deskdRecordsNoMoreThanDeskAgentSaysItHolds() throws Exception {
        deskAgentApplies(apps(true, false, false, false, false));
        TestClient owner = rig.connect("cs-1");
        rig.call(owner, "agent.access.set", save("ag-1", apps(true, true, true, true, true)));
        assertThat(record().entry("ag-1").apps()).containsExactly("notebook");
    }

    @Test
    void aSessionThatMayNotActCantChooseAndDeskAgentNeverHears() throws Exception {
        deskAgentApplies(null);
        TestClient client = rig.connect("cs-v", viewer());
        for (String method : List.of("agent.access.set", "agent.desks.revoke")) {
            Map<String, Object> refused = rig.call(client, method, method.equals("agent.access.set")
                    ? save("ag-1", apps(true, true, true, false, true)) : m("grantId", "dg-aaaaaaaaaaaaaaaaaaaa"));
            assertThat(refused).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
            assertThat(Json.object(refused, "details")).containsEntry("reason", "permission");
        }
        TestClient export = rig.connect("e", "export");
        Map<String, Object> scoped = rig.call(export, "agent.access.set", save("ag-1", apps(true, true, true, false,
                true)));
        assertThat(scoped).containsEntry("code", "forbidden");
        assertThat(Json.object(scoped, "details")).containsEntry("reason", "scope");
        assertThat(rig.agent.received).noneMatch(m -> "req".equals(m.get("t"))
                && String.valueOf(m.get("m")).startsWith("agent.access"));
        assertThat(record().recorded()).isEmpty();
    }

    @Test
    void aTeensDeskGetsNoneOfIt() throws Exception {
        deskAgentApplies(null);
        rig.band = AgeBand.Band.TEEN;
        TestClient owner = rig.connect("cs-1");
        Map<String, Object> refused = rig.call(owner, "agent.access.set", save("ag-1", apps(true, true, true, false,
                true)));
        assertThat(Json.object(refused, "details")).containsEntry("reason", "age_band");
        assertThat(record().recorded()).isEmpty();
    }

    @Test
    void deskAgentsRefusalRecordsNothing() throws Exception {
        TestClient owner = rig.connect("cs-1");
        long id = rig.send(owner, "agent.access.set", save("ag-1", apps(true, true, true, false, true)), "k-1");
        Map<String, Object> relayed = rig.agent.requests.poll(10, TimeUnit.SECONDS);
        assertThat(relayed).isNotNull();
        rig.agent.error(((Number) relayed.get("id")).longValue(), "bad_request", m("detail", "auto",
                "reason", "required"));
        Map<String, Object> reply = owner.nextReply();
        assertThat(reply).containsEntry("_id", id).containsEntry("_kind", "ERR").containsEntry("code", "bad_request");
        assertThat(record().recorded()).isEmpty();
    }

    /** The next request the fake desk-agent has no handler for, with this method. */
    private Map<String, Object> unanswered(String method) throws InterruptedException {
        while (true) {
            Map<String, Object> m = rig.agent.requests.poll(10, TimeUnit.SECONDS);
            assertThat(m).as(method).isNotNull();
            if (method.equals(m.get("m"))) {
                return m;
            }
        }
    }

    /** A save desk-agent is sent and refuses (as a wrong desk-agent may): the member's session gets its error. */
    private Map<String, Object> refusedSave(TestClient owner, Map<String, Object> params) throws Exception {
        rig.agent.handlers.remove("agent.access.set");
        long id = rig.send(owner, "agent.access.set", params, "k-" + System.nanoTime());
        Map<String, Object> relayed = unanswered("agent.access.set");
        rig.agent.error(((Number) relayed.get("id")).longValue(), "bad_request", m("detail", "auto"));
        Map<String, Object> reply = owner.nextReply();
        assertThat(reply).containsEntry("_id", id).containsEntry("_kind", "ERR");
        return reply;
    }

    /**
     * Security's AAB-L1: what the member's save takes away holds in deskd's own record whatever desk-agent answers, so a
     * wrong desk-agent refusing the save can't keep a "without asking" switch on there. What it adds still waits for
     * desk-agent's answer.
     */
    @Test
    void aSaveThatTakesAwayHoldsInDeskdsRecordEvenWhenDeskAgentRefusesIt() throws Exception {
        TestClient owner = rig.connect("cs-1");
        Map<String, Object> on = save("ag-1", apps(true, true, true, false, true));
        on.put("auto", m("notebook", m("tabId", "tab-1"), "files", m("folder", "Research"), "todos", false));
        rig.agent.handlers.put("agent.access.set", p -> m("access", m("chosen", true, "setup", null, "apps", p.get("apps"),
                "auto", p.get("auto"), "desks", List.of(), "incoming", List.of())));
        rig.call(owner, "agent.access.set", on);
        assertThat(record().place("ag-1", "files")).isEqualTo("Research");
        assertThat(record().place("ag-1", "notebook")).isEqualTo("tab-1");

        // The Files switch off, refused: off in deskd's record all the same. The Notebook's, untouched, stands.
        Map<String, Object> filesOff = save("ag-1", apps(true, true, true, false, true));
        filesOff.put("auto", m("notebook", m("tabId", "tab-1"), "files", null, "todos", false));
        refusedSave(owner, filesOff);
        assertThat(record().place("ag-1", "files")).isNull();
        assertThat(record().place("ag-1", "notebook")).isEqualTo("tab-1");

        // The Notebook's moved to another tab, refused: off, not on in the new tab, which waits for desk-agent's yes.
        Map<String, Object> moved = save("ag-1", apps(true, true, true, false, true));
        moved.put("auto", m("notebook", m("tabId", "tab-2"), "files", null, "todos", false));
        refusedSave(owner, moved);
        assertThat(record().place("ag-1", "notebook")).isNull();

        // An app off, refused: off. Turning one on, refused: still off.
        refusedSave(owner, save("ag-1", apps(true, false, true, false, true)));
        assertThat(record().refusal("ag-1", HostedDecls.FILES)).isNotNull();
        assertThat(record().refusal("ag-1", HostedDecls.NOTEBOOK)).isNull();
        refusedSave(owner, save("ag-1", apps(true, true, true, false, true)));
        assertThat(record().refusal("ag-1", HostedDecls.FILES)).isNotNull();
    }

    /** AAB-L1's other half: a delete desk-agent refuses still takes the agent out of deskd's record. */
    @Test
    void aDeleteDeskAgentRefusesStillTakesTheAgentOutOfDeskdsRecord() throws Exception {
        deskAgentApplies(null);
        TestClient owner = rig.connect("cs-1");
        rig.call(owner, "agent.access.set", save("ag-1", apps(true, true, true, false, true)));
        assertThat(record().recorded()).containsExactly("ag-1");
        long id = rig.send(owner, "agent.delete", m("agentId", "ag-1"), "k-del");
        Map<String, Object> relayed = unanswered("agent.delete");
        rig.agent.error(((Number) relayed.get("id")).longValue(), "internal", m());
        assertThat(owner.nextReply()).containsEntry("_id", id).containsEntry("_kind", "ERR");
        assertThat(record().recorded()).isEmpty();
        assertThat(record().refusal("ag-1", HostedDecls.FILES)).isNotNull();
    }

    @Test
    void aGrantToThisDeskItselfIsRefusedBeforeDeskAgentHears() throws Exception {
        deskAgentApplies(null);
        TestClient owner = rig.connect("cs-1");
        Map<String, Object> p = save("ag-1", apps(true, true, true, false, true));
        p.put("desks", List.of(m("deskId", "d-test", "deskName", "This one", "on", true)));
        Map<String, Object> refused = rig.call(owner, "agent.access.set", p);
        assertThat(refused).containsEntry("code", "bad_request");
        assertThat(Json.object(refused, "details")).containsEntry("detail", "desks").containsEntry("reason", "self");
        assertThat(rig.agent.received).noneMatch(m -> "agent.access.set".equals(m.get("m")));
    }

    @Test
    void aDeskSwitchedOnIsRecordedAndARevokeTakesItAway() throws Exception {
        deskAgentApplies(null);
        TestClient owner = rig.connect("cs-1");
        Map<String, Object> p = save("ag-1", apps(true, true, true, false, true));
        p.put("desks", List.of(m("deskId", "d-work", "deskName", "Work", "on", true)));
        rig.call(owner, "agent.access.set", p);
        assertThat(record().entry("ag-1").desks()).containsExactly("d-work");
        rig.agent.handlers.put("agent.desks.revoke", r -> m("agentId", "ag-1", "access", m("chosen", true, "desks",
                List.of())));
        assertThat(rig.call(owner, "agent.desks.revoke", m("grantId", "dg-aaaaaaaaaaaaaaaaaaaa")))
                .containsEntry("_kind", "RES");
        assertThat(record().entry("ag-1").desks()).isEmpty();
        assertThat(record().refusal("ag-1", HostedDecls.FILES)).as("the rest stands").isNull();
    }

    @Test
    void deletingAnAgentTakesItOutOfDeskdsRecord() throws Exception {
        deskAgentApplies(null);
        rig.agent.handlers.put("agent.delete", p -> Map.of());
        TestClient owner = rig.connect("cs-1");
        rig.call(owner, "agent.access.set", save("ag-1", apps(true, true, true, false, true)));
        assertThat(record().recorded()).containsExactly("ag-1");
        rig.call(owner, "agent.delete", m("agentId", "ag-1"));
        assertThat(record().recorded()).isEmpty();
    }

    @Test
    void aGuildMemberChoosesForTheirOwnAgentAlone() throws Exception {
        deskAgentApplies(null);
        TestClient member = rig.connect("cs-1", rig.member("gm-aaaa0001", "member", List.of(), false));
        Map<String, Object> own = rig.call(member, "agent.access.set", save("gm-aaaa0001", apps(true, false, false,
                false, false)));
        assertThat(own).containsEntry("_kind", "RES");
        assertThat(Json.object(nextRequest("agent.access.set"), "caller")).containsEntry("kind", "guild_member")
                .containsEntry("memberId", "gm-aaaa0001");
        assertThat(record().refusal("gm-aaaa0001", HostedDecls.NOTEBOOK)).isNull();
        // Even if desk-agent answered for another's, deskd records nothing for it.
        rig.call(member, "agent.access.set", save("gm-bbbb0001", apps(true, false, false, false, false)));
        rig.call(member, "agent.access.set", save("ag-1", apps(true, true, true, false, false)));
        assertThat(record().recorded()).containsExactly("gm-aaaa0001");
    }

    @Test
    void theHelloNamesWhatDeskdHoldsSoDeskAgentCanAskTheMemberAgainForTheRest() throws Exception {
        deskAgentApplies(null);
        TestClient owner = rig.connect("cs-1");
        rig.call(owner, "agent.access.set", save("manager", apps(true, true, true, false, true)));
        ToolHost host = new ToolHost(Clock.systemUTC(), ToolHost.ownerOnly(), () -> false, () -> true);
        host.agentApps(rig.module.accessRecord());
        rig.module.hostTools(host);
        rig.agent.drop();
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.agent.connections() >= 2
                && rig.module.link().isConnected());
        Map<String, Object> hello = nextRequest(ToolHost.HELLO);
        assertThat(Json.object(hello, "p")).containsEntry("access", Map.of("recorded", List.of("manager")));
    }

    @Test
    void whatDeskdRecordedSurvivesItsRestartAndATamperedFileIsNothing() throws Exception {
        deskAgentApplies(null);
        TestClient owner = rig.connect("cs-1");
        rig.call(owner, "agent.access.set", save("ag-1", apps(true, true, true, false, true)));
        AccessRecord after = new AccessRecord(Clock.systemUTC());
        after.keepIn(dir);
        assertThat(after.recorded()).containsExactly("ag-1");
        Path file = dir.resolve(AccessRecord.FILE);
        Files.writeString(file, Files.readString(file).replace("\"todos\":false", "\"todos\":true"));
        AccessRecord tampered = new AccessRecord(Clock.systemUTC());
        tampered.keepIn(dir);
        assertThat(tampered.recorded()).isEmpty();
        assertThat(tampered.refusal("ag-1", HostedDecls.FILES)).isEqualTo("setup");
    }
}
