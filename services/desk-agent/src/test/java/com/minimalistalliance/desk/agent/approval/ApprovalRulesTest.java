package com.minimalistalliance.desk.agent.approval;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.service.Caller;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.team.Canonical;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.tool.Classified;
import com.minimalistalliance.desk.agent.tool.Risk;
import com.minimalistalliance.desk.agent.tool.RunContext;
import com.minimalistalliance.desk.agent.tool.Taint;
import com.minimalistalliance.desk.agent.tool.ToolDecl;
import com.minimalistalliance.desk.agent.tool.ToolPolicy;
import java.nio.file.Path;
import java.time.Duration;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The shared interface's rules, the hash, and what a restart leaves, on the store alone. */
class ApprovalRulesTest {

    @TempDir
    Path data;

    private static ToolDecl decl(String name, Risk risk, String scope) {
        return new ToolDecl(name, "Save {path} in your Files", null, scope, risk, Set.of(), ToolDecl.Host.DESKD);
    }

    @Test
    void aCallsClassRisesNeverFalls() {
        ToolCall call = new ToolCall("c1", "files_write", Map.of("path", "a.md"));
        Classified lowered = new Classified(call, decl("files_write", Risk.WRITE, "files:write"), Risk.READ, null,
                null, call.input(), null);
        assertThat(lowered.risk()).isEqualTo(Risk.WRITE);
        Classified raised = new Classified(call, decl("files_write", Risk.WRITE, "files:write"), Risk.SPEND, null,
                null, call.input(), null);
        assertThat(raised.risk()).isEqualTo(Risk.SPEND);
        assertThat(Risk.READ.alwaysAsks()).isFalse();
        assertThat(Risk.OWN.alwaysAsks()).isFalse();
        assertThat(EnumSet.range(Risk.WRITE, Risk.EGRESS)).allMatch(Risk::alwaysAsks);
        assertThatThrownBy(() -> decl("x", Risk.READ, "files:everything")).isInstanceOf(IllegalArgumentException.class);
        assertThat(decl("x", Risk.EGRESS, "browser:member:example.com").scope()).isEqualTo("browser:member:example.com");
    }

    private static Classified browser(String tool, Risk risk, String context) {
        ToolCall call = new ToolCall("c-" + tool, tool, Map.of("tabId", "t1"));
        return new Classified(call, decl(tool, Risk.READ, "browser:agent"), risk, context, null, call.input(), null);
    }

    @Test
    void untrustedAndPrivateMakeEveryBrowseActionEgressAndTheMembersSessionAtLeastWrite() {
        // Browse actions: egress under U and S, and only under both.
        for (String action : List.of("browser_open", "browser_click", "browser_type", "browser_press", "browser_back")) {
            Classified own = browser(action, Risk.READ, "agent");
            assertThat(own.backstopped(true, false, false).risk()).as(action).isEqualTo(Risk.READ);
            assertThat(own.backstopped(false, true, false).risk()).as(action).isEqualTo(Risk.READ);
            assertThat(own.backstopped(true, true, false).risk()).as(action).isEqualTo(Risk.EGRESS);
        }
        // In the member's session: a click, typing and a key are at least write; a navigation is egress, whatever the taint.
        for (String action : List.of("browser_click", "browser_type", "browser_press")) {
            assertThat(browser(action, Risk.READ, "member:example.com").backstopped(false, false, false).risk()).as(action)
                    .isEqualTo(Risk.WRITE);
            assertThat(browser(action, Risk.SEND, "member:example.com").backstopped(false, false, false).risk()).as(action)
                    .isEqualTo(Risk.SEND);
        }
        for (String navigation : List.of("browser_open", "browser_back")) {
            assertThat(browser(navigation, Risk.READ, "member:example.com").backstopped(false, false, false).risk())
                    .as(navigation).isEqualTo(Risk.EGRESS);
        }
        // A spend stays a spend: one at a time, never unattended.
        assertThat(browser("browser_click", Risk.SPEND, "member:example.com").backstopped(true, true, false).risk())
                .isEqualTo(Risk.SPEND);
        assertThat(browser("browser_press", Risk.SPEND, "agent").backstopped(true, true, false).risk())
                .isEqualTo(Risk.SPEND);
        ToolCall file = new ToolCall("c4", "files_read", Map.of("path", "a"));
        Classified files = new Classified(file, decl("files_read", Risk.READ, "files:read"), Risk.READ, "agent",
                null, file.input(), null);
        assertThat(files.backstopped(true, true, true).risk()).isEqualTo(Risk.READ);
    }

    @Test
    void readingTheTabListAndClosingStayReadsUnderUAndSAndInTheMembersSession() {
        for (String look : List.of("browser_read", "browser_tabs", "browser_close")) {
            for (String context : List.of("agent", "member:example.com")) {
                Classified c = browser(look, Risk.READ, context).backstopped(true, true, true);
                assertThat(c.risk()).as(look + " " + context).isEqualTo(Risk.READ);
                assertThat(c.refusal()).isNull();
            }
        }
    }

    @Test
    void securityFiveTheSessionGrantIsOnlyEverForARunTheMemberStarted() {
        ToolCall grant = new ToolCall("c5", "browser_use_my_session", Map.of("site", "example.com"));
        Classified asked = new Classified(grant, decl("browser_use_my_session", Risk.EGRESS, "browser:member:*"),
                Risk.EGRESS, "member:example.com", null, grant.input(), null);
        Classified member = asked.backstopped(false, false, false);
        assertThat(member.refusal()).isNull();
        assertThat(member.risk()).isEqualTo(Risk.EGRESS);
        assertThat(asked.backstopped(false, false, true).refusal()).isEqualTo("origin");
        assertThat(asked.backstopped(true, true, true).refusal()).isEqualTo("origin");
        // The run's own origin decides: a timer's or another agent's message's run is refused.
        for (Map<String, Object> origin : List.<Map<String, Object>>of(Map.of("kind", "timer", "agentId", "a", "timerId", "t"),
                Map.of("kind", "agent", "agentId", "b", "name", "Bee"))) {
            RunContext run = RunContext.of("r9", "a", Caller.OWNER, origin, "m9");
            assertThat(asked.backstopped(run).refusal()).as(origin.get("kind").toString()).isEqualTo("origin");
        }
        assertThat(asked.backstopped(RunContext.of("r9", "a", Caller.OWNER, null, "m9")).refusal()).isNull();
    }

    @Test
    void theTitleIsTheDesksWordsWithTheArgumentsQuotedAndCleaned() {
        ToolCall call = new ToolCall("c1", "files_write", Map.of("path", "Plans/‮trip​.md\n"));
        Classified c = new Classified(call, decl("files_write", Risk.WRITE, "files:write"), Risk.WRITE, null,
                Map.of("kind", "file", "path", "Plans/‮trip​.md\n"), call.input(), null);
        assertThat(c.title()).isEqualTo("Save “Plans/trip.md” in your Files");
        Classified longOne = new Classified(call, decl("files_write", Risk.WRITE, "files:write"), Risk.WRITE, null,
                Map.of("path", "p".repeat(500)), call.input(), null);
        assertThat(longOne.title()).hasSizeLessThan(160).contains("…");
        assertThat(c.refused("sensitive").refusal()).isEqualTo("sensitive");
        assertThat(c.refusal()).isNull();
    }

    @Test
    void aRunsTaintOnlyGrowsAndReachesTheRunUpstream() {
        RunContext sender = RunContext.of("r1", "a", Caller.OWNER, null, "m1");
        RunContext receiver = RunContext.of("r2", "b", Caller.OWNER, Map.of("kind", "agent", "agentId", "a"), "m2",
                Set.of(Taint.U), sender);
        assertThat(receiver.untrusted()).isTrue();
        assertThat(receiver.unattended()).isTrue();
        // What the receiver holds reaches the sender, which reads its reply: from the start, and every add after.
        assertThat(sender.untrusted()).isTrue();
        assertThat(sender.privateData()).isFalse();
        receiver.add(Set.of(Taint.S));
        assertThat(sender.privateData()).isTrue();
        assertThat(sender.unattended()).isFalse();
        assertThatThrownBy(() -> receiver.taint().clear()).isInstanceOf(UnsupportedOperationException.class);
        assertThatThrownBy(() -> receiver.taint().remove(Taint.U)).isInstanceOf(UnsupportedOperationException.class);
        assertThatThrownBy(() -> receiver.taint().retainAll(Set.of())).isInstanceOf(UnsupportedOperationException.class);
        assertThat(receiver.untrusted()).isTrue();
    }

    @Test
    void theStandInsAskNothingAndRefuseWhatWouldAsk() throws Exception {
        RunContext run = RunContext.of("r1", "a", Caller.OWNER, null, "m1");
        ToolCall call = new ToolCall("c1", "workspace_write", Map.of("path", "a"));
        Classified own = ToolPolicy.DEFAULT.classify(call, run);
        assertThat(own.risk()).isEqualTo(Risk.OWN);
        Classified write = new Classified(call, decl("files_write", Risk.WRITE, "files:write"), Risk.WRITE, null, null,
                call.input(), null);
        List<Verdict> verdicts = ApprovalGate.NONE.admit(run, List.of(own, write, write.refused("sensitive")));
        assertThat(verdicts.get(0)).isInstanceOf(Verdict.Auto.class);
        assertThat(verdicts.get(1)).isEqualTo(new Verdict.Refused("not_built"));
        assertThat(verdicts.get(2)).isEqualTo(new Verdict.Refused("sensitive"));
    }

    @Test
    void theHashIsTheCanonicalJsonOfTheBoundFields() {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("text", "hi");
        payload.put("path", "a.md");
        String sha = Approvals.hash("ag-1", "run-1", "files_write", "agent", payload);
        assertThat(Canonical.json(Map.of("v", 1, "agentId", "ag-1", "runId", "run-1", "tool", "files_write",
                "context", "agent", "payload", payload))).isEqualTo("{\"agentId\":\"ag-1\",\"context\":\"agent\","
                        + "\"payload\":{\"path\":\"a.md\",\"text\":\"hi\"},\"runId\":\"run-1\","
                        + "\"tool\":\"files_write\",\"v\":1}");
        assertThat(sha).hasSize(64).isEqualTo(Canonical.sha256(Map.of("v", 1, "agentId", "ag-1", "runId", "run-1",
                "tool", "files_write", "context", "agent", "payload", payload)));
        assertThat(Approvals.hash("ag-1", "run-1", "files_write", "member:example.com", payload)).isNotEqualTo(sha);
    }

    @Test
    void aFailedToolsWordIsReadFromItsTextNeverItsContent() {
        assertThat(Approvals.errorWord(new ToolResult("c", "Refused: changed.", true))).isEqualTo("changed");
        assertThat(Approvals.errorWord(new ToolResult("c", "Failed: no_space. More text", true))).isEqualTo("no_space");
        assertThat(Approvals.errorWord(new ToolResult("c", "The page said: Refused: x.", true))).isEqualTo("failed");
    }

    @Test
    void aRestartExpiresWhatWaitedAndInterruptsWhatRan() throws Exception {
        MutableClock clock = new MutableClock(Rig.START);
        AgentStore store = new AgentStore(data.resolve("agent.db"), clock);
        AuditLog audit = new AuditLog(data.resolve("audit.db"), clock);
        store.open();
        audit.open();
        ApprovalStore rows = new ApprovalStore(store);
        long now = clock.millis();
        rows.insert(List.of(row("ap-aaaaaaaaaaaaaaaaaaaa", "pending", null, now),
                row("ap-bbbbbbbbbbbbbbbbbbbb", "approved", null, now),
                row("ap-cccccccccccccccccccc", "approved", now, now),
                row("ap-dddddddddddddddddddd", "done", now, now)));
        new Approvals(store, audit, clock).restore();
        assertThat(rows.get("ap-aaaaaaaaaaaaaaaaaaaa").state()).isEqualTo("expired");
        assertThat(rows.get("ap-aaaaaaaaaaaaaaaaaaaa").detail()).isEqualTo("restart");
        assertThat(rows.get("ap-bbbbbbbbbbbbbbbbbbbb").state()).isEqualTo("expired");
        assertThat(rows.get("ap-cccccccccccccccccccc").state()).isEqualTo("interrupted");
        assertThat(rows.get("ap-dddddddddddddddddddd").state()).isEqualTo("done");
        assertThat(audit.readBefore(null, 10)).filteredOn(r -> r.entry().decision().equals("restart")).hasSize(3);
        store.close();
        audit.close();
    }

    @Test
    void aMembersCardIsTheirsAloneAndItsAgentsDeleteTakesIt() throws Exception {
        MutableClock clock = new MutableClock(Rig.START);
        AgentStore store = new AgentStore(data.resolve("agent.db"), clock);
        AuditLog audit = new AuditLog(data.resolve("audit.db"), clock);
        store.open();
        audit.open();
        store.ensureAgent("gm-member1", "Agent");
        ApprovalStore rows = new ApprovalStore(store);
        ApprovalStore.Row mine = new ApprovalStore.Row("ap-eeeeeeeeeeeeeeeeeeee", "gm-member1", "run-1", "msg-1",
                "notebook_write", "write", "t", "agent", "{}", "{}", null, "0".repeat(64), true,
                "{\"kind\":\"member\"}", "pending", null, clock.millis(), clock.millis() + 1000, null, null, null,
                null, null);
        rows.insert(List.of(mine));
        Approvals approvals = new Approvals(store, audit, clock);
        Caller owner = Caller.OWNER;
        Caller other = new Caller(Caller.MEMBER_KIND, "gm-member2", "member", List.of(), false);
        Caller self = new Caller(Caller.MEMBER_KIND, "gm-member1", "member", List.of(), false);
        Map<String, Object> decide = Map.of("approvalId", mine.id(), "approve", true, "sha256", "0".repeat(64));
        for (Caller notTheirs : List.of(owner, other)) {
            assertThatThrownBy(() -> approvals.call("agent.approval.decide", decide, notTheirs))
                    .isInstanceOfSatisfying(RpcError.class, e -> assertThat(e.code()).isEqualTo("not_found"));
            assertThatThrownBy(() -> approvals.call("agent.approvals.list", Map.of("agentId", "gm-member1"), notTheirs))
                    .isInstanceOfSatisfying(RpcError.class, e -> assertThat(e.code()).isEqualTo("not_found"));
        }
        assertThat((List<?>) approvals.call("agent.approvals.list", Map.of(), self).get("approvals")).hasSize(1);
        // No run waits on it (as after a crash with no sweep yet): the member's yes finds it expired, nothing runs.
        assertThatThrownBy(() -> approvals.call("agent.approval.decide", decide, self))
                .isInstanceOfSatisfying(RpcError.class, e -> assertThat(e.details()).containsEntry("reason", "expired"));
        store.purgeMember("gm-member1");
        assertThat(rows.get(mine.id())).isNull();
        store.close();
        audit.close();
    }

    private static ApprovalStore.Row row(String id, String state, Long startedAt, long now) {
        return new ApprovalStore.Row(id, "ag-x", "run-1", "msg-1", "files_write", "write", "t", "agent", "{}", "{}",
                null, "0".repeat(64), false, "{\"kind\":\"member\"}", state, null, now, now + Duration.ofHours(1)
                        .toMillis(), null, null, null, startedAt, null);
    }
}
