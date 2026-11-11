package com.minimalistalliance.desk.agent.approval;

import static com.minimalistalliance.desk.agent.testing.FakeProvider.Step.call;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.service.Caller;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import com.minimalistalliance.desk.agent.tool.Classified;
import com.minimalistalliance.desk.agent.tool.Risk;
import com.minimalistalliance.desk.agent.tool.Taint;
import com.minimalistalliance.desk.agent.tool.ToolDecl;
import com.minimalistalliance.desk.agent.tool.ToolPolicy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The approval gate end to end (draft ADR "the Agent's tools and approvals", deskd's {@code API.md} section 18): a real
 * {@code AgentService} on real files with the fake provider, and a test policy over the workspace tools, whose class a
 * path's first folder raises (classes can rise, never fall): {@code plans/} is {@code write}, {@code spend/}
 * {@code spend}, {@code send/} {@code send}, {@code egress/} {@code egress}, {@code memory/} a memory save; a read of
 * {@code u/} is untrusted content and of {@code s/} private.
 */
class ApprovalsTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);

    @TempDir
    Path data;

    private final MutableClock clock = new MutableClock(Rig.START);
    private TeamDesk desk;
    private String a;
    /** The class {@code message_agent} gets: its own ({@code own}), or {@code send} for a test that asks for it. */
    private volatile Risk messageRisk = Risk.OWN;

    private final ToolPolicy policy = (call, run) -> {
        String path = call.input().get("path") instanceof String p ? p : "";
        Risk risk = Risk.READ;
        String scope = "workspace:self";
        Set<Taint> taints = Set.of();
        switch (call.name()) {
            case "workspace_write" -> {
                risk = path.startsWith("spend/") ? Risk.SPEND : path.startsWith("send/") ? Risk.SEND
                        : path.startsWith("egress/") ? Risk.EGRESS : path.startsWith("memory/") ? Risk.OWN
                        : path.startsWith("own/") ? Risk.OWN : Risk.WRITE;
                scope = path.startsWith("memory/") ? "memory:self" : scope;
            }
            case "workspace_read" -> taints = path.startsWith("u/") ? Set.of(Taint.U)
                    : path.startsWith("s/") ? Set.of(Taint.S) : Set.of();
            case "message_agent" -> {
                risk = messageRisk;
                scope = "agents:linked";
            }
            case "browser_use_my_session" -> {
                risk = Risk.EGRESS;
                scope = "browser:agent";
            }
            default -> {
            }
        }
        ToolDecl decl = new ToolDecl(call.name(), "Save {path} in the workspace", null, scope, risk, taints,
                ToolDecl.Host.DESK_AGENT);
        Map<String, Object> target = path.isEmpty() ? Map.of() : Map.of("kind", "file", "path", path);
        return new Classified(call, decl, risk, "agent", target, call.input(), null);
    };

    @BeforeEach
    void start() throws Exception {
        open();
        a = desk.agent("Alice");
    }

    private void open() throws Exception {
        desk = new TeamDesk(data, clock);
        desk.service.toolPolicy(policy);
    }

    @AfterEach
    void stop() {
        desk.close();
    }

    // ---------------------------------------------------------------- helpers

    private static ToolCall write(String id, String path) {
        return call(id, "workspace_write", "path", path, "text", "hello " + path);
    }

    private void send(String agentId, String text) throws Exception {
        desk.call("agent.message.send", "agentId", agentId, "text", text);
    }

    private List<Map<String, Object>> pending(String agentId) throws Exception {
        return list(desk.call("agent.approvals.list", "agentId", agentId).get("approvals"));
    }

    private List<Map<String, Object>> all(String agentId) throws Exception {
        return list(desk.call("agent.approvals.list", "agentId", agentId, "state", "all").get("approvals"));
    }

    /** Waits for {@code n} pending cards of the agent, oldest first. */
    private List<Map<String, Object>> awaitPending(String agentId, int n) {
        AtomicReference<List<Map<String, Object>>> last = new AtomicReference<>();
        await().atMost(Duration.ofSeconds(15)).until(() -> {
            last.set(pending(agentId));
            return last.get().size() == n;
        });
        List<Map<String, Object>> oldestFirst = new ArrayList<>(last.get());
        java.util.Collections.reverse(oldestFirst);
        return oldestFirst;
    }

    /** The newest reply once its run has ended. */
    private Map<String, Object> ended(String agentId) {
        AtomicReference<Map<String, Object>> last = new AtomicReference<>();
        await().atMost(Duration.ofSeconds(15)).until(() -> {
            List<Map<String, Object>> thread = desk.thread(agentId);
            last.set(thread.get(thread.size() - 1));
            return "assistant".equals(last.get().get("role"))
                    && List.of("done", "stopped", "failed").contains(last.get().get("state"));
        });
        return last.get();
    }

    /** The hash the app computes from what the card shows. */
    private static String sha(Map<String, Object> card) {
        return Approvals.hash((String) card.get("agentId"), (String) card.get("runId"), (String) card.get("tool"),
                (String) card.get("context"), map(card.get("payload")));
    }

    private Map<String, Object> decide(Map<String, Object> card, boolean approve) throws Exception {
        return map(desk.call("agent.approval.decide", "approvalId", card.get("id"), "approve", approve, "sha256",
                sha(card)).get("approval"));
    }

    private Map<String, Object> get(Object id) throws Exception {
        return map(desk.call("agent.approval.get", "approvalId", id).get("approval"));
    }

    private Map<String, Object> agentState(String agentId) {
        for (Map<String, Object> agent : list(desk.service.stateSnapshot().get("agents"))) {
            if (agent.get("id").equals(agentId)) {
                return agent;
            }
        }
        throw new AssertionError("no agent " + agentId);
    }

    private List<ToolResult> results() {
        return TeamDesk.toolResults(desk.lastRequest());
    }

    private List<AuditLog.Row> audit() throws Exception {
        return desk.audit.readBefore(null, 500);
    }

    private String workspaceText(String agentId, String path) throws Exception {
        return (String) desk.call("agent.workspace.read", "agentId", agentId, "path", path).get("text");
    }

    // ---------------------------------------------------------------- approve, decline, expire

    @Test
    void aWriteWaitsForTheMembersYesThenRunsOnce() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(write("c1", "plans/trip.md")))).then(Step.answer(USAGE, "Saved."));
        send(a, "Save my plans.");
        Map<String, Object> card = awaitPending(a, 1).get(0);

        assertThat(card.get("tool")).isEqualTo("workspace_write");
        assertThat(card.get("risk")).isEqualTo("write");
        assertThat(card.get("title")).isEqualTo("Save “plans/trip.md” in the workspace");
        assertThat(card.get("context")).isEqualTo("agent");
        assertThat(map(card.get("target"))).containsEntry("kind", "file").containsEntry("path", "plans/trip.md");
        assertThat(map(card.get("payload"))).containsEntry("text", "hello plans/trip.md");
        assertThat(card.get("sha256")).isEqualTo(sha(card));
        assertThat(card.get("untrusted")).isEqualTo(false);
        assertThat(map(card.get("origin"))).containsEntry("kind", "member");
        assertThat(card.get("state")).isEqualTo("pending");
        assertThat((long) card.get("expiresAt") - (long) card.get("createdAt")).isEqualTo(Duration.ofHours(1).toMillis());
        assertThat(card.get("id").toString()).matches("ap-[a-z2-7]{20}");

        // The reply waits, the agent says so, and a new message is refused until the member answers.
        List<Map<String, Object>> thread = desk.thread(a);
        Map<String, Object> reply = thread.get(thread.size() - 1);
        assertThat(reply.get("state")).isEqualTo("awaiting_approval");
        assertThat(list(reply.get("pendingApprovals"))).isEqualTo(List.of(card.get("id")));
        assertThat(list(reply.get("approvals"))).hasSize(1);
        Map<String, Object> agent = agentState(a);
        assertThat(agent.get("status")).isEqualTo("working");
        assertThat(agent.get("statusDetail")).isEqualTo("awaiting_approval");
        assertThat(agent.get("approvalsPending")).isEqualTo(1);
        RpcError busy = desk.refused("agent.message.send", "agentId", a, "text", "Hurry up.");
        assertThat(busy.code()).isEqualTo("conflict");
        assertThat(busy.details()).containsEntry("reason", "awaiting_approval");
        assertThat(workspaceFiles(a)).isEmpty();

        Map<String, Object> decided = decide(card, true);
        assertThat(decided.get("state")).isIn("approved", "done");
        assertThat(decided.get("decidedBy")).isEqualTo("owner");

        Map<String, Object> done = ended(a);
        assertThat(done.get("state")).isEqualTo("done");
        assertThat(workspaceText(a, "plans/trip.md")).isEqualTo("hello plans/trip.md");
        assertThat(results().get(0).content()).startsWith("Approved by the member.\n");
        Map<String, Object> chip = list(done.get("tools")).get(0);
        assertThat(chip.get("risk")).isEqualTo("write");
        assertThat(map(chip.get("approval"))).containsEntry("id", card.get("id")).containsEntry("decision", "approved");
        assertThat(map(chip.get("target"))).containsEntry("path", "plans/trip.md");
        assertThat(get(card.get("id")).get("state")).isEqualTo("done");
        assertThat(map(get(card.get("id")).get("result"))).containsEntry("ok", true);
        assertThat(agentState(a).get("approvalsPending")).isEqualTo(0);

        // Answered once.
        RpcError again = desk.refused("agent.approval.decide", "approvalId", card.get("id"), "approve", true,
                "sha256", sha(card));
        assertThat(again.code()).isEqualTo("conflict");
        assertThat(again.details()).containsEntry("reason", "answered");
        assertThat(pending(a)).isEmpty();
    }

    @Test
    void aDeclineDoesNothingAndTheSameCallIsntAskedAgainInTheRun() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(write("c1", "plans/trip.md"))))
                .then(Step.calls(USAGE, List.of(write("c2", "plans/trip.md"))))
                .then(Step.answer(USAGE, "I won't."));
        send(a, "Save my plans.");
        Map<String, Object> card = awaitPending(a, 1).get(0);
        Map<String, Object> declined = map(desk.call("agent.approval.decide", "approvalId", card.get("id"),
                "approve", false, "sha256", sha(card), "note", "Not \"now\".\nLater").get("approval"));
        assertThat(declined.get("state")).isEqualTo("declined");
        assertThat(declined.get("note")).isEqualTo("Not \"now\".\nLater");

        ended(a);
        List<ToolResult> results = results();
        assertThat(results.get(0).content()).startsWith("The member declined this; nothing was done.")
                .endsWith("Their note:\n\"Not \\\"now\\\".\\nLater\"");
        assertThat(results.get(1).content()).isEqualTo("Not allowed: declined_before.");
        assertThat(all(a)).hasSize(1);
        assertThat(workspaceFiles(a)).isEmpty();
    }

    @Test
    void aCardNobodyAnswersExpiresAfterAnHourAndCountsAsADecline() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(write("c1", "plans/a.md")))).then(Step.answer(USAGE, "OK."));
        send(a, "Save.");
        Map<String, Object> card = awaitPending(a, 1).get(0);
        clock.advance(Duration.ofMinutes(59));
        desk.service.approvals().wake();
        assertThat(pending(a)).hasSize(1);
        clock.advance(Duration.ofMinutes(2));
        desk.service.approvals().wake();
        ended(a);
        Map<String, Object> expired = get(card.get("id"));
        assertThat(expired.get("state")).isEqualTo("expired");
        assertThat(expired.get("detail")).isEqualTo("timeout");
        assertThat(results().get(0).content()).startsWith("The member didn't answer by ")
                .endsWith("nothing was done. Say what you were going to do, so they can ask you again.");
        RpcError late = desk.refused("agent.approval.decide", "approvalId", card.get("id"), "approve", true,
                "sha256", sha(card));
        assertThat(late.code()).isEqualTo("conflict");
        assertThat(late.details()).containsEntry("reason", "expired");
    }

    @Test
    void afterThreeDeclinesARunAsksNothingMore() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(write("c1", "plans/1.md"), write("c2", "plans/2.md"),
                        write("c3", "plans/3.md"))))
                .then(Step.calls(USAGE, List.of(write("c4", "plans/4.md"))))
                .then(Step.answer(USAGE, "Stopping."));
        send(a, "Save four.");
        List<Map<String, Object>> cards = awaitPending(a, 3);
        decide(cards.get(0), false);
        decide(cards.get(1), false);
        // The third expires: an expiry counts as a decline.
        clock.advance(Duration.ofMinutes(61));
        desk.service.approvals().wake();
        assertThat(ended(a).get("state")).isEqualTo("done");
        assertThat(results().get(3).content()).isEqualTo("Not allowed: declined.");
        assertThat(all(a)).hasSize(3);
    }

    @Test
    void aWrongHashIsBadRequestAndChangesNothing() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(write("c1", "plans/a.md")))).then(Step.answer(USAGE, "OK."));
        send(a, "Save.");
        Map<String, Object> card = awaitPending(a, 1).get(0);
        Map<String, Object> shown = new java.util.LinkedHashMap<>(map(card.get("payload")));
        shown.put("text", "something else");
        String wrong = Approvals.hash(a, (String) card.get("runId"), "workspace_write", "agent", shown);
        RpcError refused = desk.refused("agent.approval.decide", "approvalId", card.get("id"), "approve", true,
                "sha256", wrong);
        assertThat(refused.code()).isEqualTo("bad_request");
        assertThat(refused.details()).containsEntry("detail", "sha256");
        assertThat(get(card.get("id")).get("state")).isEqualTo("pending");
        decide(card, false);
        ended(a);
    }

    @Test
    void aNoteIsOnlyForADeclineAndHasNoHiddenCharacters() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(write("c1", "plans/a.md")))).then(Step.answer(USAGE, "OK."));
        send(a, "Save.");
        Map<String, Object> card = awaitPending(a, 1).get(0);
        RpcError withYes = desk.refused("agent.approval.decide", "approvalId", card.get("id"), "approve", true,
                "sha256", sha(card), "note", "fine");
        assertThat(withYes.details()).containsEntry("detail", "note");
        RpcError hidden = desk.refused("agent.approval.decide", "approvalId", card.get("id"), "approve", false,
                "sha256", sha(card), "note", "no‮thanks");
        assertThat(hidden.details()).containsEntry("detail", "note").containsEntry("reason", "hidden_chars");
        RpcError tooLong = desk.refused("agent.approval.decide", "approvalId", card.get("id"), "approve", false,
                "sha256", sha(card), "note", "x".repeat(501));
        assertThat(tooLong.details()).containsEntry("detail", "note");
        assertThat(desk.refused("agent.approval.decide", "approvalId", "ap-aaaaaaaaaaaaaaaaaaaa", "approve", true,
                "sha256", sha(card)).code()).isEqualTo("not_found");
        decide(card, false);
        ended(a);
    }

    // ---------------------------------------------------------------- the caps

    @Test
    void anAgentHasAtMostFivePendingAndARunAsksAtMostTen() throws Exception {
        List<ToolCall> six = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            six.add(write("c" + i, "plans/" + i + ".md"));
        }
        desk.provider.then(Step.calls(USAGE, six)).then(Step.answer(USAGE, "OK."));
        send(a, "Save six.");
        List<Map<String, Object>> cards = awaitPending(a, 5);
        for (Map<String, Object> card : cards) {
            decide(card, true);
        }
        ended(a);
        List<ToolResult> results = results();
        assertThat(results.subList(0, 5)).allMatch(r -> r.content().startsWith("Approved by the member."));
        assertThat(results.get(5).content()).isEqualTo("Not allowed: ask_cap.");
    }

    @Test
    void aRunAsksAtMostTenTimes() throws Exception {
        for (int step = 0; step < 2; step++) {
            List<ToolCall> five = new ArrayList<>();
            for (int i = 0; i < 5; i++) {
                five.add(write("s" + step + "c" + i, "plans/" + step + "-" + i + ".md"));
            }
            desk.provider.then(Step.calls(USAGE, five));
        }
        desk.provider.then(Step.calls(USAGE, List.of(write("last", "plans/last.md")))).then(Step.answer(USAGE, "OK."));
        send(a, "Save eleven.");
        for (Map<String, Object> card : awaitPending(a, 5)) {
            decide(card, true);
        }
        await().atMost(Duration.ofSeconds(15)).until(() -> all(a).size() == 10 && pending(a).size() == 5);
        for (Map<String, Object> card : awaitPending(a, 5)) {
            decide(card, true);
        }
        ended(a);
        assertThat(TeamDesk.lastToolResult(desk.lastRequest()).content()).isEqualTo("Not allowed: ask_cap.");
        assertThat(all(a)).hasSize(10);
    }

    @Test
    void aRunAsksForAtMostTwoSignedInSites() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(call("g1", "browser_use_my_session", "site", "a.example"),
                call("g2", "browser_use_my_session", "site", "b.example"),
                call("g3", "browser_use_my_session", "site", "c.example")))).then(Step.answer(USAGE, "OK."));
        send(a, "Use my sites.");
        List<Map<String, Object>> cards = awaitPending(a, 2);
        assertThat(cards).allMatch(c -> c.get("risk").equals("egress"));
        for (Map<String, Object> card : cards) {
            decide(card, false);
        }
        ended(a);
        assertThat(results().get(2).content()).isEqualTo("Not allowed: ask_cap.");
    }

    @Test
    void aRunMakesAtMostAHundredToolCalls() throws Exception {
        for (int step = 0; step < 7; step++) {
            List<ToolCall> calls = new ArrayList<>();
            for (int i = 0; i < 16; i++) {
                calls.add(call("s" + step + "c" + i, "workspace_list"));
            }
            desk.provider.then(Step.calls(USAGE, calls));
        }
        desk.provider.then(Step.answer(USAGE, "Listed."));
        send(a, "List a lot.");
        assertThat(ended(a).get("state")).isEqualTo("done");
        List<ToolResult> results = results();
        assertThat(results).hasSize(112);
        assertThat(results.subList(0, 100)).noneMatch(r -> r.content().startsWith("Not allowed"));
        assertThat(results.subList(100, 112)).allMatch(r -> r.content().equals("Not allowed: tool_cap."));
    }

    @Test
    void spendIsAskedOneAtATime() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(write("c1", "spend/a"), write("c2", "spend/b"))))
                .then(Step.answer(USAGE, "OK."));
        send(a, "Buy two.");
        Map<String, Object> card = awaitPending(a, 1).get(0);
        assertThat(card.get("risk")).isEqualTo("spend");
        decide(card, false);
        ended(a);
        assertThat(results().get(1).content()).isEqualTo("Not allowed: ask_cap.");
    }

    // ---------------------------------------------------------------- unattended runs

    @Test
    void aRunAnotherAgentStartedWaitsADayIsUntrustedAndNeverSpends() throws Exception {
        String b = desk.agent("Bob");
        desk.link(a, b, "Bob saves notes.");
        desk.open(b);
        desk.provider.then(Step.calls(USAGE, List.of(call("m1", "message_agent", "to", "Bob", "text", "Save it."))))
                .then(Step.calls(USAGE, List.of(write("b1", "spend/x"), write("b2", "plans/b.md"))))
                .then(Step.answer(USAGE, "Bob gave up."))
                .then(Step.answer(USAGE, "Alice is done."));
        send(a, "Ask Bob to save it.");
        Map<String, Object> card = awaitPending(b, 1).get(0);
        assertThat(card.get("risk")).isEqualTo("write");
        assertThat(card.get("untrusted")).isEqualTo(true);
        assertThat(map(card.get("origin"))).containsEntry("kind", "agent").containsEntry("agentId", a)
                .containsEntry("name", "Alice");
        assertThat((long) card.get("expiresAt") - (long) card.get("createdAt")).isEqualTo(Duration.ofHours(24).toMillis());

        clock.advance(Duration.ofHours(2));
        desk.service.approvals().wake();
        assertThat(pending(b)).hasSize(1);
        clock.advance(Duration.ofHours(23));
        desk.service.approvals().wake();
        assertThat(ended(a).get("state")).isEqualTo("done");
        assertThat(get(card.get("id")).get("detail")).isEqualTo("timeout");
        Map<String, Object> bobs = ended(b);
        assertThat(bobs.get("untrusted")).isEqualTo(true);
        assertThat(all(b)).hasSize(1);
        // Bob's step: the spend refused without a card, the write expired.
        List<ToolResult> bobResults = TeamDesk.toolResults(desk.requests().get(2));
        assertThat(bobResults.get(0).content()).isEqualTo("Not allowed: unattended_spend.");
        assertThat(bobResults.get(1).content()).startsWith("The member didn't answer by ");
    }

    // ---------------------------------------------------------------- run marks

    @Test
    void untrustedContentMarksTheReplyAndTheNextRunAndAMemorySaveThenAsks() throws Exception {
        // Without U a memory save is the agent's own: no card.
        desk.provider.then(Step.calls(USAGE, List.of(write("c0", "memory/first.md")))).then(Step.answer(USAGE, "Noted."));
        send(a, "Remember this.");
        assertThat(ended(a).get("untrusted")).isNull();
        assertThat(all(a)).isEmpty();

        desk.provider.then(Step.calls(USAGE, List.of(call("r1", "workspace_read", "path", "u/page.md"))))
                .then(Step.calls(USAGE, List.of(write("c1", "memory/second.md"))))
                .then(Step.answer(USAGE, "Read it."));
        send(a, "Read the page and remember it.");
        Map<String, Object> card = awaitPending(a, 1).get(0);
        assertThat(card.get("risk")).isEqualTo("own");
        assertThat(card.get("untrusted")).isEqualTo(true);
        decide(card, false);
        Map<String, Object> reply = ended(a);
        assertThat(reply.get("untrusted")).isEqualTo(true);

        // The next run reads that reply again, so it starts untrusted.
        desk.provider.then(Step.calls(USAGE, List.of(write("c2", "plans/next.md")))).then(Step.answer(USAGE, "OK."));
        send(a, "Now save a plan.");
        Map<String, Object> next = awaitPending(a, 1).get(0);
        assertThat(next.get("untrusted")).isEqualTo(true);
        decide(next, false);
        ended(a);
    }

    @Test
    void egressCallsAreCountedOnTheReply() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(write("c1", "egress/a"))))
                .then(Step.answer(USAGE, "Sent."));
        send(a, "Send it.");
        Map<String, Object> card = awaitPending(a, 1).get(0);
        assertThat(card.get("risk")).isEqualTo("egress");
        decide(card, true);
        assertThat(ended(a).get("egressCount")).isEqualTo(1);
    }

    // ---------------------------------------------------------------- stops and restarts

    @Test
    void stoppingAWaitingRunExpiresItsCards() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(write("c1", "plans/a.md"))));
        send(a, "Save.");
        Map<String, Object> card = awaitPending(a, 1).get(0);
        desk.call("agent.run.stop", "runId", card.get("runId"));
        assertThat(ended(a).get("state")).isEqualTo("stopped");
        assertThat(get(card.get("id"))).containsEntry("state", "expired").containsEntry("detail", "stopped");
        assertThat(agentState(a).get("approvalsPending")).isEqualTo(0);
    }

    @Test
    void aRestartWhileWaitingExpiresTheCardAndNothingRuns() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(write("c1", "plans/a.md"))));
        send(a, "Save.");
        Map<String, Object> card = awaitPending(a, 1).get(0);
        desk.close();
        open();
        assertThat(get(card.get("id"))).containsEntry("state", "expired").containsEntry("detail", "restart");
        RpcError late = desk.refused("agent.approval.decide", "approvalId", card.get("id"), "approve", true,
                "sha256", sha(card));
        assertThat(late.details()).containsEntry("reason", "expired");
        List<Map<String, Object>> thread = desk.thread(a);
        assertThat(thread.get(thread.size() - 1).get("state")).isIn("stopped", "failed");
        assertThat(workspaceFiles(a)).isEmpty();
    }

    @Test
    void aRestartWhileAnApprovedCallRunsMakesItInterrupted() throws Exception {
        messageRisk = Risk.SEND;
        String b = desk.agent("Bob");
        desk.link(a, b, "Bob answers.");
        desk.open(b);
        CountDownLatch never = new CountDownLatch(1);
        desk.provider.then(Step.calls(USAGE, List.of(call("m1", "message_agent", "to", "Bob", "text", "Hi."))))
                .then(Step.answer(USAGE, "Hi back.").heldBy(never));
        send(a, "Say hi to Bob.");
        Map<String, Object> card = awaitPending(a, 1).get(0);
        assertThat(card.get("risk")).isEqualTo("send");
        decide(card, true);
        // Bob's run is under way, so Alice's approved call is running.
        await().atMost(Duration.ofSeconds(15)).until(() -> desk.requests().size() == 2);
        desk.close();
        never.countDown();
        open();
        assertThat(get(card.get("id")).get("state")).isEqualTo("interrupted");
    }

    // ---------------------------------------------------------------- who may see and decide

    @Test
    void aGuildMemberNeverSeesOrDecidesAnotherAgentsCard() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(write("c1", "plans/a.md")))).then(Step.answer(USAGE, "OK."));
        send(a, "Save.");
        Map<String, Object> card = awaitPending(a, 1).get(0);
        Caller member = new Caller(Caller.MEMBER_KIND, "gm-abcd1234", "member", List.of(), false);
        try {
            desk.service.call("agent.approval.decide", TeamDesk.m("approvalId", card.get("id"), "approve", true,
                    "sha256", sha(card)), member);
            throw new AssertionError("decided");
        } catch (RpcError e) {
            assertThat(e.code()).isEqualTo("not_found");
            assertThat(e.details()).containsEntry("detail", "approval");
        }
        Map<String, Object> theirs = desk.service.call("agent.approvals.list", TeamDesk.m(), member);
        assertThat(list(theirs.get("approvals"))).isEmpty();
        try {
            desk.service.call("agent.approval.get", TeamDesk.m("approvalId", card.get("id")), member);
            throw new AssertionError("seen");
        } catch (RpcError e) {
            assertThat(e.code()).isEqualTo("not_found");
        }
        assertThat(get(card.get("id")).get("state")).isEqualTo("pending");
        decide(card, false);
        ended(a);
    }

    // ---------------------------------------------------------------- events, sizes, audit

    @Test
    void aLargePayloadIsLeftOutOfListsButGetHasIt() throws Exception {
        String big = "x".repeat(40_000);
        desk.provider.then(Step.calls(USAGE, List.of(call("c1", "workspace_write", "path", "plans/big.md", "text",
                big)))).then(Step.answer(USAGE, "OK."));
        send(a, "Save a big one.");
        Map<String, Object> listed = awaitPending(a, 1).get(0);
        assertThat(listed.get("payloadOmitted")).isEqualTo(true);
        assertThat(listed.get("payload")).isNull();
        assertThat((int) listed.get("payloadBytes")).isGreaterThan(40_000);
        Map<String, Object> whole = get(listed.get("id"));
        assertThat(whole.get("payloadOmitted")).isEqualTo(false);
        assertThat(map(whole.get("payload"))).containsEntry("text", big);
        assertThat(sha(whole)).isEqualTo(whole.get("sha256"));
        decide(whole, false);
        ended(a);
    }

    @Test
    void everyAskDecisionAndCallIsAuditedWithIdsOnly() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(write("c1", "plans/secret-name.md"),
                call("r1", "workspace_list")))).then(Step.answer(USAGE, "OK."));
        send(a, "Save.");
        Map<String, Object> card = awaitPending(a, 1).get(0);
        decide(card, true);
        ended(a);
        List<AuditLog.Row> rows = audit();
        String id = (String) card.get("id");
        assertThat(rows).anySatisfy(r -> {
            assertThat(r.entry().action()).isEqualTo("approval.ask");
            assertThat(r.entry().actor()).isEqualTo("agent:" + a);
            assertThat(r.entry().target()).contains("approval:" + id).contains("tool:workspace_write");
            assertThat(r.entry().decision()).isEqualTo("ask:write");
            assertThat(r.entry().payloadSha256()).isNotNull();
        });
        assertThat(rows).anySatisfy(r -> {
            assertThat(r.entry().action()).isEqualTo("approval.decide");
            assertThat(r.entry().actor()).isEqualTo("user");
            assertThat(r.entry().decision()).isEqualTo("approved");
        });
        assertThat(rows).anySatisfy(r -> {
            assertThat(r.entry().action()).isEqualTo("tool.call");
            assertThat(r.entry().target()).contains("tool:workspace_write").contains("approval:" + id);
            assertThat(r.entry().decision()).isEqualTo("ok");
        });
        assertThat(rows).anySatisfy(r -> {
            assertThat(r.entry().action()).isEqualTo("tool.call");
            assertThat(r.entry().target()).contains("tool:workspace_list").doesNotContain("approval:");
        });
        for (AuditLog.Row r : rows) {
            assertThat(r.entry().target()).doesNotContain("secret-name").doesNotContain("hello");
        }
        assertThat(desk.audit.verify().intact()).isTrue();
    }

    @Test
    void theApprovalEventCarriesEachChange() throws Exception {
        List<String> states = java.util.Collections.synchronizedList(new ArrayList<>());
        desk.topics.subscribe(1, "agent.conversation:" + a, () -> Map.of("messages", List.of()),
                (topic, seq, type, payload) -> {
                    if ("approval".equals(type)) {
                        states.add((String) map(payload.get("approval")).get("state"));
                    }
                });
        desk.provider.then(Step.calls(USAGE, List.of(write("c1", "plans/a.md")))).then(Step.answer(USAGE, "OK."));
        send(a, "Save.");
        Map<String, Object> card = awaitPending(a, 1).get(0);
        decide(card, true);
        ended(a);
        await().atMost(Duration.ofSeconds(5)).until(() -> states.contains("done"));
        assertThat(states).containsSubsequence("pending", "approved", "done");
    }

    private List<String> workspaceFiles(String agentId) throws Exception {
        List<String> names = new ArrayList<>();
        for (Map<String, Object> entry : list(desk.call("agent.workspace.get", "agentId", agentId).get("entries"))) {
            names.add((String) entry.get("path"));
        }
        return names;
    }

    static String utf8(byte[] bytes) {
        return new String(bytes, StandardCharsets.UTF_8);
    }
}
