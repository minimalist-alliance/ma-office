package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The relay of agent.* for guild members (API.md section 14): the caller on every frame, and deskd's own refusals. */
class GuildAgentRelayTest {

    @TempDir
    Path dir;

    private AgentRig rig;

    @BeforeEach
    void setUp() throws Exception {
        rig = new AgentRig(dir);
        rig.agent.handlers.put("agent.list", p -> Map.of("agents", List.of()));
        rig.agent.handlers.put("agent.key.list", p -> Map.of("keys", List.of()));
        rig.agent.handlers.put("agent.limits.set", p -> Map.of());
        rig.agent.handlers.put("agent.guild.usage", p -> Map.of("members", List.of(
                Map.of("memberId", "gm-aaaa0001", "today", Map.of("runs", 1)),
                Map.of("memberId", "gm-zzzz0009", "today", Map.of("runs", 2)))));
        rig.agent.snapshots.put("agent.state", () -> Map.of("agents", List.of()));
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    private Map<String, Object> nextRequest(String method) throws InterruptedException {
        while (true) {
            Map<String, Object> m = rig.agent.next("req");
            if (method.equals(m.get("m"))) {
                return m;
            }
        }
    }

    @Test
    void everyRequestCarriesTheVerifiedCaller() throws Exception {
        TestClient member = rig.connect("cs-1", rig.member("gm-aaaa0001", "officer", List.of("moderate"), false));
        assertThat(rig.call(member, "agent.list", Map.of("caller", Map.of("kind", "owner")))).containsEntry("_kind", "RES");
        Map<String, Object> request = nextRequest("agent.list");
        assertThat(Json.object(request, "caller"))
                .containsEntry("kind", "guild_member").containsEntry("memberId", "gm-aaaa0001")
                .containsEntry("role", "officer").containsEntry("grants", List.of("moderate")).containsEntry("teen", false);
        TestClient owner = rig.connect("cs-2");
        rig.call(owner, "agent.list", Map.of());
        assertThat(Json.object(nextRequest("agent.list"), "caller")).containsEntry("kind", "owner");
    }

    @Test
    void aTeenMemberIsRefusedBeforeAnythingReachesDeskAgent() throws Exception {
        TestClient teen = rig.connect("cs-1", rig.member("gm-aaaa0001", "member", List.of(), true));
        for (String method : List.of("agent.list", "agent.message.send", "agent.thread.get")) {
            Map<String, Object> reply = rig.call(teen, method, Map.of("agentId", "gm-aaaa0001", "text", "hi"));
            assertThat(reply).as(method).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
            assertThat(Json.object(reply, "details")).as(method).containsEntry("reason", "age_band");
        }
        Map<String, Object> sub = teen.subscribe("agent.state", null);
        assertThat(sub).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
        assertThat(rig.agent.requests.poll(200, TimeUnit.MILLISECONDS)).isNull();
    }

    @Test
    void aGuildMemberIsRefusedEveryTeamMethodButAgentGet() throws Exception {
        TestClient member = rig.connect("cs-1", rig.member("gm-aaaa0001", "officer", List.of("manage_agents"), false));
        assertThat(AgentMethods.TEAM_OWNER_ONLY).contains("agent.create", "agent.timer.set", "agent.proposal.answer", "agent.attach.caps.set")
                .doesNotContain("agent.get");
        for (String method : AgentMethods.TEAM_OWNER_ONLY) {
            Map<String, Object> reply = rig.call(member, method, Map.of("agentId", "gm-aaaa0001"));
            assertThat(reply).as(method).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
            assertThat(Json.object(reply, "details")).as(method).containsEntry("reason", "permission");
        }
        assertThat(rig.agent.requests.poll(200, TimeUnit.MILLISECONDS)).as("nothing reached desk-agent").isNull();
        rig.call(member, "agent.get", Map.of("agentId", "gm-aaaa0001"));
        assertThat(nextRequest("agent.get")).containsEntry("m", "agent.get");
    }

    @Test
    void aMemberSeesAndDeletesTheirOwnAgentsMemory() throws Exception {
        rig.agent.handlers.put("agent.memory.list", p -> Map.of("memories", List.of()));
        rig.agent.handlers.put("agent.memory.delete", p -> Map.of("deleted", true));
        rig.agent.handlers.put("agent.memory.clear", p -> Map.of("deleted", 0));
        assertThat(AgentMethods.TEAM_OWNER_ONLY).doesNotContain("agent.memory.list", "agent.memory.delete",
                "agent.memory.clear");
        assertThat(AgentMethods.MANAGERS_ONLY).doesNotContain("agent.memory.list", "agent.memory.delete",
                "agent.memory.clear");
        TestClient member = rig.connect("cs-1", rig.member("gm-aaaa0001", "member", List.of(), false));
        for (String method : List.of("agent.memory.list", "agent.memory.delete", "agent.memory.clear")) {
            Map<String, Object> reply = rig.call(member, method, Map.of("agentId", "gm-aaaa0001", "memoryId", "mem-x"));
            assertThat(reply).as(method).containsEntry("_kind", "RES");
            assertThat(Json.object(nextRequest(method), "caller")).as(method)
                    .containsEntry("kind", "guild_member").containsEntry("memberId", "gm-aaaa0001");
        }
        TestClient teen = rig.connect("cs-2", rig.member("gm-bbbb0001", "member", List.of(), true));
        Map<String, Object> refused = rig.call(teen, "agent.memory.list", Map.of("agentId", "gm-bbbb0001"));
        assertThat(refused).containsEntry("code", "forbidden");
        assertThat(Json.object(refused, "details")).containsEntry("reason", "age_band");
    }

    @Test
    void theGuildsKeysLimitsAndAuditNeedManageAgents() throws Exception {
        TestClient member = rig.connect("cs-1", rig.member("gm-aaaa0001", "member", List.of(), false));
        TestClient officer = rig.connect("cs-2", rig.member("gm-bbbb0001", "officer", List.of("moderate"), false));
        for (TestClient client : List.of(member, officer)) {
            for (String method : AgentMethods.MANAGERS_ONLY) {
                Map<String, Object> reply = rig.call(client, method,
                        Map.of("provider", "anthropic", "label", "x", "secret", "sk-ant-abcdefghij", "keyId", "k-1", "agentId", "gm-aaaa0001"));
                assertThat(reply).as(method).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
                assertThat(Json.object(reply, "details")).as(method).containsEntry("reason", "grant");
            }
        }
        assertThat(rig.agent.keys).isEmpty();
        TestClient manager = rig.connect("cs-3", rig.member("gm-cccc0001", "officer", List.of("manage_agents"), false));
        assertThat(rig.call(manager, "agent.limits.set", Map.of("agentId", "gm-cccc0001", "timeZone", "UTC")))
                .containsEntry("_kind", "RES");
        assertThat(Json.object(nextRequest("agent.limits.set"), "caller")).containsEntry("memberId", "gm-cccc0001");
    }

    @Test
    void usageIsTheFoundersAndOfficersAndOnlyAMembersOnAGuildDesk() throws Exception {
        TestClient member = rig.connect("cs-1", rig.member("gm-aaaa0001", "member", List.of(), false));
        Map<String, Object> refused = rig.call(member, "guild.usage.get", Map.of());
        assertThat(refused).containsEntry("code", "forbidden");
        assertThat(Json.object(refused, "details")).containsEntry("reason", "grant");
        TestClient officer = rig.connect("cs-2", rig.member("gm-bbbb0001", "officer", List.of(), false));
        assertThat(rig.call(officer, "guild.usage.get", Map.of())).containsEntry("_kind", "RES");
        assertThat(Json.object(nextRequest("agent.guild.usage"), "caller")).containsEntry("role", "officer");
        rig.module.memberNames(id -> "gm-aaaa0001".equals(id) ? "Ana" : null);
        Map<String, Object> usage = rig.call(officer, "guild.usage.get", Map.of());
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> rows = (List<Map<String, Object>>) usage.get("members");
        assertThat(rows.get(0)).containsEntry("name", "Ana").containsEntry("memberId", "gm-aaaa0001").containsKey("today");
        assertThat(rows.get(1)).containsEntry("name", null).containsEntry("memberId", "gm-zzzz0009");
        // desk-agent's name for it is no client's to call.
        Map<String, Object> direct = rig.call(officer, "agent.guild.usage", Map.of());
        assertThat(direct).containsEntry("code", "forbidden");
        TestClient owner = rig.connect("cs-3");
        assertThat(rig.call(owner, "guild.usage.get", Map.of())).containsEntry("code", "forbidden");
    }

    @Test
    void eachMemberHasTheirOwnSubscriptionOnDeskAgent() throws Exception {
        TestClient a = rig.connect("cs-1", rig.member("gm-aaaa0001", "member", List.of(), false));
        TestClient b = rig.connect("cs-2", rig.member("gm-bbbb0001", "member", List.of(), false));
        assertThat(a.subscribe("agent.state", null)).containsEntry("_kind", "RES");
        assertThat(b.subscribe("agent.state", null)).containsEntry("_kind", "RES");
        await().until(() -> rig.module.relayedForTest().size() == 2);
        // A subscribe that comes before the link to desk-agent is up answers at once and goes out when the link connects,
        // so the topics being held doesn't mean their frames have arrived: wait for the frames themselves.
        await().until(() -> memberSubscribers().containsAll(List.of("gm-aaaa0001", "gm-bbbb0001")));
        List<Object> callers = memberSubscribers();
        assertThat(callers).containsExactlyInAnyOrder("gm-aaaa0001", "gm-bbbb0001");
        // deskd's own, for the heartbeat, is the system's.
        await().until(() -> List.copyOf(rig.agent.received).stream().anyMatch(m -> "sub".equals(m.get("t")) && m.get("caller") instanceof Map<?, ?> c && "system".equals(c.get("kind"))));
        assertThat(List.copyOf(rig.agent.received)).anySatisfy(m -> {
            assertThat(m).containsEntry("t", "sub");
            assertThat(Json.object(m, "caller")).containsEntry("kind", "system");
        });
    }

    /** The distinct member ids of the {@code agent.state} subscriptions that have reached desk-agent. */
    private List<Object> memberSubscribers() {
        List<Object> callers = new java.util.ArrayList<>();
        for (Map<String, Object> m : List.copyOf(rig.agent.received)) {
            if ("sub".equals(m.get("t")) && "agent.state".equals(m.get("topic")) && m.get("caller") instanceof Map<?, ?> caller
                    && "guild_member".equals(caller.get("kind"))) {
                callers.add(caller.get("memberId"));
            }
        }
        return callers.stream().distinct().toList();
    }

    @Test
    void theGuildsSettingsGoToDeskAgentOnEveryConnection() throws Exception {
        Map<String, Object> settings = Map.of("agents", Map.of("perGuild", Map.of("runsAtOnce", 3)));
        rig.agent.handlers.put("desk.guild.set", p -> Map.of());
        rig.module.guildSettings(settings);
        assertThat(nextRequest("desk.guild.set")).containsEntry("p", settings).doesNotContainKey("caller");
        rig.agent.drop();
        assertThat(nextRequest("desk.guild.set")).containsEntry("p", settings);
    }

    @Test
    void aMembersCallerNeverListsAnotherGrantThanTheirRoles() {
        assertThat(Caller.effectiveGrants("member", List.of("manage_agents"))).isEmpty();
        assertThat(Caller.effectiveGrants("lead", List.of())).isEqualTo(Caller.GRANTS);
    }
}
