package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.session.SessionGrant;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The relay of the Agent's approvals (API.md section 18): the three methods with the caller, the input check, deskd's
 * own ticket of each yes and its single use, and a waiting agent not keeping the desk busy.
 */
class ApprovalRelayTest {

    private static final String ID = "ap-abcdefghijklmnopqrst";

    @TempDir
    Path dir;

    private AgentRig rig;

    @BeforeEach
    void setUp() throws Exception {
        rig = new AgentRig(dir);
        rig.agent.snapshots.put("agent.state", () -> Map.of("agents", List.of()));
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    private static Map<String, Object> payload() {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("path", "Plans/trip.md");
        payload.put("text", "Pack the tent");
        payload.put("replace", false);
        return payload;
    }

    private static String sha(String agentId) {
        return ApprovalTickets.hash(agentId, "run-1", "files_write", "agent", payload());
    }

    private Map<String, Object> nextRequest(String method) throws InterruptedException {
        while (true) {
            Map<String, Object> m = rig.agent.next("req");
            if (method.equals(m.get("m"))) {
                return m;
            }
        }
    }

    private void answers(String state) {
        rig.agent.handlers.put("agent.approval.decide", p -> Map.of("approval", Map.of("id", p.get("approvalId"),
                "state", state)));
    }

    private Map<String, Object> decide(TestClient client, String agentId, boolean approve) throws Exception {
        return rig.call(client, "agent.approval.decide", Map.of("approvalId", ID, "approve", approve, "sha256",
                sha(agentId)));
    }

    private ApprovalTickets.Redeemed redeem(String agentId, Map<String, Object> args) {
        return rig.module.approvalTickets().redeem(ID, sha(agentId), agentId, "run-1", "files_write", "agent", args);
    }

    @Test
    void theApprovalMethodsAreRelayedWithTheCaller() throws Exception {
        rig.agent.handlers.put("agent.approvals.list", p -> Map.of("approvals", List.of(), "older", false));
        rig.agent.handlers.put("agent.approval.get", p -> Map.of("approval", Map.of("id", ID)));
        answers("declined");
        assertThat(AgentMethods.READS).contains("agent.approvals.list", "agent.approval.get");
        assertThat(AgentMethods.MUTATIONS).contains("agent.approval.decide");
        assertThat(AgentMethods.TEAM_OWNER_ONLY).doesNotContain("agent.approvals.list", "agent.approval.get",
                "agent.approval.decide");
        TestClient owner = rig.connect("cs-1");
        assertThat(rig.call(owner, "agent.approvals.list", Map.of())).containsEntry("_kind", "RES");
        assertThat(Json.object(nextRequest("agent.approvals.list"), "caller")).containsEntry("kind", "owner");
        assertThat(rig.call(owner, "agent.approval.get", Map.of("approvalId", ID))).containsEntry("_kind", "RES");
        Map<String, Object> declined = rig.call(owner, "agent.approval.decide", Map.of("approvalId", ID,
                "approve", false, "sha256", sha("ag-1"), "note", "No."));
        assertThat(declined).containsEntry("_kind", "RES");
        Map<String, Object> sent = nextRequest("agent.approval.decide");
        assertThat(Json.object(sent, "p")).containsEntry("note", "No.").containsEntry("approve", false);
        // A no makes no ticket.
        assertThat(redeem("ag-1", payload()).refusal()).isEqualTo(ApprovalTickets.Refusal.APPROVAL_UNKNOWN);
    }

    @Test
    void aTokenWithoutInputCantDecideAndDeskAgentNeverHears() throws Exception {
        answers("approved");
        // The rig's first session's tab, as its connect would give it, without input.
        String fingerprint = String.format("%02x", 1 + 16).repeat(32);
        SessionGrant viewer = new SessionGrant("user-1", "sid-v", "owner", fingerprint, true, false, Instant.now(),
                Instant.now().plus(Duration.ofHours(1)));
        TestClient client = rig.connect("cs-v", viewer);
        Map<String, Object> refused = decide(client, "ag-1", true);
        assertThat(refused).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
        assertThat(Json.object(refused, "details")).containsEntry("reason", "permission");
        assertThat(rig.agent.received).noneMatch(m -> "req".equals(m.get("t")));
        assertThat(redeem("ag-1", payload()).ok()).isFalse();
    }

    @Test
    void aYesMakesATicketThatRunsExactlyThatCallOnce() throws Exception {
        answers("approved");
        TestClient owner = rig.connect("cs-1");
        assertThat(decide(owner, "ag-1", true)).containsEntry("_kind", "RES");

        // Other arguments, another agent, run, tool or context, or a wrong claimed hash: refused, and the yes is kept.
        Map<String, Object> changed = payload();
        changed.put("text", "Pack the tent and the stove");
        ApprovalTickets tickets = rig.module.approvalTickets();
        assertThat(tickets.redeem(ID, sha("ag-1"), "ag-1", "run-1", "files_write", "agent", changed).refusal())
                .isEqualTo(ApprovalTickets.Refusal.APPROVAL_MISMATCH);
        assertThat(tickets.redeem(ID, sha("ag-1"), "ag-1", "run-2", "files_write", "agent", payload()).ok()).isFalse();
        assertThat(tickets.redeem(ID, sha("ag-1"), "ag-1", "run-1", "files_trash", "agent", payload()).ok()).isFalse();
        assertThat(tickets.redeem(ID, sha("ag-1"), "ag-1", "run-1", "files_write", "member:example.com", payload())
                .ok()).isFalse();
        assertThat(tickets.redeem(ID, sha("ag-2"), "ag-2", "run-1", "files_write", "agent", payload()).ok()).isFalse();
        assertThat(tickets.redeem(ID, "0".repeat(64), "ag-1", "run-1", "files_write", "agent", payload()).ok())
                .isFalse();

        assertThat(redeem("ag-1", payload()).ok()).isTrue();
        assertThat(redeem("ag-1", payload()).refusal()).isEqualTo(ApprovalTickets.Refusal.APPROVAL_USED);
        // A retry of the same yes never re-arms it.
        assertThat(rig.call(owner, "agent.approval.decide", Map.of("approvalId", ID, "approve", true, "sha256",
                sha("ag-1")), UUID.randomUUID().toString())).containsEntry("_kind", "RES");
        assertThat(redeem("ag-1", payload()).refusal()).isEqualTo(ApprovalTickets.Refusal.APPROVAL_USED);
    }

    @Test
    void aYesDeskAgentRefusesLeavesNoTicket() throws Exception {
        TestClient owner = rig.connect("cs-1");
        long id = rig.send(owner, "agent.approval.decide", Map.of("approvalId", ID, "approve", true, "sha256",
                sha("ag-1")), UUID.randomUUID().toString());
        Map<String, Object> request = nextRequest("agent.approval.decide");
        rig.agent.error(((Number) request.get("id")).longValue(), "bad_request", Map.of("detail", "sha256"));
        Map<String, Object> reply = owner.nextReply();
        assertThat(reply).containsEntry("_id", id).containsEntry("code", "bad_request");
        assertThat(redeem("ag-1", payload()).refusal()).isEqualTo(ApprovalTickets.Refusal.APPROVAL_UNKNOWN);
    }

    @Test
    void aSecondYesDeskAgentRefusesNeverTakesAwayTheFirst() throws Exception {
        answers("approved");
        TestClient owner = rig.connect("cs-1");
        decide(owner, "ag-1", true);
        nextRequest("agent.approval.decide");
        rig.agent.handlers.remove("agent.approval.decide");
        long id = rig.send(owner, "agent.approval.decide", Map.of("approvalId", ID, "approve", true, "sha256",
                sha("ag-1")), UUID.randomUUID().toString());
        Map<String, Object> request = nextRequest("agent.approval.decide");
        rig.agent.error(((Number) request.get("id")).longValue(), "conflict", Map.of("reason", "answered"));
        assertThat(owner.nextReply()).containsEntry("_id", id).containsEntry("code", "conflict");
        assertThat(redeem("ag-1", payload()).ok()).isTrue();
    }

    @Test
    void aTicketLastsTenMinutes() throws Exception {
        answers("approved");
        TestClient owner = rig.connect("cs-1");
        decide(owner, "ag-1", true);
        rig.clock.advance(ApprovalTickets.LIFE);
        assertThat(redeem("ag-1", payload()).refusal()).isEqualTo(ApprovalTickets.Refusal.APPROVAL_UNKNOWN);
    }

    @Test
    void aGuildMembersYesRunsOnlyTheirOwnAgentsCall() throws Exception {
        answers("approved");
        TestClient member = rig.connect("cs-1", rig.member("gm-aaaa0001", "member", List.of(), false));
        // A member's token has no input (no Browser on a guild desk), and still decides for their own agent.
        assertThat(decide(member, "gm-aaaa0001", true)).containsEntry("_kind", "RES");
        assertThat(Json.object(nextRequest("agent.approval.decide"), "caller")).containsEntry("memberId", "gm-aaaa0001");
        ApprovalTickets tickets = rig.module.approvalTickets();
        for (String other : List.of("gm-bbbb0002", "manager", "ag-1")) {
            assertThat(tickets.redeem(ID, sha(other), other, "run-1", "files_write", "agent", payload()).refusal())
                    .as(other).isEqualTo(ApprovalTickets.Refusal.APPROVAL_MISMATCH);
        }
        assertThat(redeem("gm-aaaa0001", payload()).ok()).isTrue();

        TestClient teen = rig.connect("cs-2", rig.member("gm-cccc0003", "member", List.of(), true));
        Map<String, Object> refused = decide(teen, "gm-cccc0003", true);
        assertThat(refused).containsEntry("code", "forbidden");
        assertThat(Json.object(refused, "details")).containsEntry("reason", "age_band");
    }

    @Test
    void theHashIsDeskAgentsByteForByte() {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("text", "hi");
        payload.put("path", "a.md");
        // The same vector as desk-agent's ApprovalRulesTest.theHashIsTheCanonicalJsonOfTheBoundFields.
        assertThat(Canonical.json(Map.of("v", 1, "agentId", "ag-1", "runId", "run-1", "tool", "files_write",
                "context", "agent", "payload", payload))).isEqualTo("{\"agentId\":\"ag-1\",\"context\":\"agent\","
                        + "\"payload\":{\"path\":\"a.md\",\"text\":\"hi\"},\"runId\":\"run-1\","
                        + "\"tool\":\"files_write\",\"v\":1}");
        assertThat(ApprovalTickets.hash("ag-1", "run-1", "files_write", "agent", payload)).isEqualTo(Canonical.sha256(
                Map.of("v", 1, "agentId", "ag-1", "runId", "run-1", "tool", "files_write", "context", "agent",
                        "payload", payload)));
    }

    @Test
    void anOwnersYesNeverRunsAMembersAgent() {
        ApprovalTickets tickets = new ApprovalTickets(rig.clock);
        tickets.record(ID, sha("gm-aaaa0001"), Caller.THE_OWNER);
        assertThat(tickets.redeem(ID, sha("gm-aaaa0001"), "gm-aaaa0001", "run-1", "files_write", "agent", payload())
                .refusal()).isEqualTo(ApprovalTickets.Refusal.APPROVAL_MISMATCH);
        // Malformed ids and hashes make no ticket.
        tickets.record("ap-short", sha("ag-1"), Caller.THE_OWNER);
        tickets.record("ap-bcdefghijklmnopqrstu", "xyz", Caller.THE_OWNER);
        assertThat(tickets.size()).isEqualTo(1);
    }

    @Test
    void anAgentWaitingForTheMemberDoesntKeepTheDeskBusy() throws Exception {
        rig.agent.drop();
        await().until(() -> rig.agent.subscribers("agent.state") == 1);
        rig.agent.publish("agent.state", "snapshot", Map.of("agents", List.of(Map.of("id", "manager", "status",
                "working", "statusDetail", "awaiting_approval", "approvalsPending", 1))));
        await().atMost(5, TimeUnit.SECONDS).until(() -> "online".equals(rig.module.heartbeatFields().get("status")));
        assertThat(rig.module.heartbeatFields()).containsEntry("activeTasks", 0).containsEntry("busyUntil", null);
        rig.agent.publish("agent.state", "snapshot", Map.of("agents", List.of(Map.of("id", "manager", "status",
                "working"))));
        await().atMost(5, TimeUnit.SECONDS).until(() -> "busy".equals(rig.module.heartbeatFields().get("status")));
    }
}
