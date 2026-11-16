package com.minimalistalliance.desk.agent.tool;

import static com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.approval.Approvals;
import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Auto-approve from desk-agent's side, through the real wiring (the draft ADR's §15, built as W3): the member's switches
 * from {@code agent.access.set}, the gate's place check, its counts, the run's declines (Security's AAW-L1), deskd's
 * refusal making the same call ask, the approval row decided by {@code auto}, the chip and the reply's {@code auto}, the
 * undo as deskd relays it, and a Guild Desk. deskd is {@link FakeDeskLink}; its own checks are deskd's tests.
 */
class AutoApproveFlowTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);
    private static final String UNASKED = "Done without asking, under the member's setting for this agent.";

    @org.junit.jupiter.api.io.TempDir
    Path data;

    private final MutableClock clock = new MutableClock(Rig.START);
    private final FakeDeskLink deskd = new FakeDeskLink();
    private TeamDesk desk;
    private String a;

    @BeforeEach
    void start() throws Exception {
        desk = open();
        a = desk.agent("Alice");
        switches("Research", "tab-1");
    }

    private TeamDesk open() throws Exception {
        TeamDesk d = new TeamDesk(data, clock);
        d.service.deskLink(deskd);
        return d;
    }

    @AfterEach
    void stop() {
        desk.close();
    }

    /** The member's "without asking" switches for Alice: Files in {@code folder}, Notebook in {@code tab} (null: off). */
    private void switches(String folder, String tab) throws Exception {
        Map<String, Object> auto = new HashMap<>();
        auto.put("files", folder == null ? null : Map.of("folder", folder));
        auto.put("notebook", tab == null ? null : Map.of("tabId", tab));
        desk.call("agent.access.set", "agentId", a, "auto", auto);
    }

    private static ToolCall write(String id, String path) {
        return Step.call(id, "files_write", "path", path, "text", "notes for " + path);
    }

    private List<ToolResult> results() {
        return TeamDesk.toolResults(desk.lastRequest());
    }

    private List<Map<String, Object>> rows() throws Exception {
        return list(desk.call("agent.approvals.list", "agentId", a, "state", "all").get("approvals"));
    }

    private List<Map<String, Object>> pending() throws Exception {
        return list(desk.call("agent.approvals.list", "agentId", a).get("approvals"));
    }

    private Map<String, Object> awaitCard() {
        AtomicReference<List<Map<String, Object>>> last = new AtomicReference<>();
        await().atMost(Duration.ofSeconds(15)).until(() -> {
            last.set(pending());
            return last.get().size() == 1;
        });
        return last.get().get(0);
    }

    private void decide(Map<String, Object> card, boolean approve) throws Exception {
        String sha = Approvals.hash((String) card.get("agentId"), (String) card.get("runId"), (String) card.get("tool"),
                (String) card.get("context"), map(card.get("payload")));
        desk.call("agent.approval.decide", "approvalId", card.get("id"), "approve", approve, "sha256", sha);
    }

    private List<AuditLog.Row> audit(String action) throws Exception {
        return desk.audit.readBefore(null, 5000).stream().filter(r -> r.entry().action().equals(action)).toList();
    }

    @Test
    void aNewFileInTheSwitchsFolderIsDoneWithoutAskingAndShowsAsSuch() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(write("c1", "Research/notes.md"))))
                .then(Step.answer(USAGE, "Saved it in Research."));
        Map<String, Object> reply = desk.ask(a, "Save my notes.");
        assertThat(results().get(0).content()).startsWith(UNASKED);
        // deskd heard it with its group and its own approval id, no approval.
        Map<String, Object> ran = deskd.runsOf("files_write").get(0);
        assertThat(ran).containsEntry("auto", "files").doesNotContainKey("approval");
        String id = (String) ran.get("autoApprovalId");
        assertThat(id).matches("ap-[a-z2-7]{20}");
        // Its row: decided by auto, done, its switch's group and place; never pending, never a card.
        assertThat(rows()).singleElement().satisfies(row -> assertThat(row).containsEntry("id", id)
                .containsEntry("decidedBy", "auto").containsEntry("state", "done").containsEntry("risk", "write")
                .containsEntry("auto", Map.of("group", "files", "folder", "Research")).containsEntry("undoneAt", null)
                .containsEntry("result", Map.of("ok", true)));
        assertThat(pending()).isEmpty();
        // The chip and the reply's line.
        assertThat(list(reply.get("tools")).get(0)).containsEntry("auto", "files")
                .containsEntry("approval", Map.of("id", id, "decision", "auto"));
        assertThat(list(reply.get("approvals"))).singleElement().satisfies(r -> assertThat(r)
                .containsEntry("decidedBy", "auto").containsEntry("auto", Map.of("group", "files", "folder", "Research")));
        assertThat(list(reply.get("auto"))).singleElement().satisfies(line -> assertThat(line)
                .containsEntry("approvalId", id).containsEntry("tool", "files_write").containsEntry("group", "files")
                .containsEntry("state", "done").containsEntry("undoneAt", null));
        // Audited with ids and the payload's hash only.
        assertThat(audit("approval.auto")).singleElement().satisfies(r -> assertThat(r.entry().target())
                .contains("approval:" + id).contains("group:files").doesNotContain("notes"));
    }

    @Test
    void outsideTheSwitchsPlaceItAsks() throws Exception {
        // Lookalikes, case, a folder that only starts with the name, the folder itself, the top: each a card.
        List<String> outside = List.of("Research2/a.md", "research/a.md", "Reѕearch/a.md", "Research", "a.md",
                "Research/../a.md", "/Research2/a.md");
        List<ToolCall> calls = new ArrayList<>();
        for (int i = 0; i < outside.size(); i++) {
            calls.add(write("c" + i, outside.get(i)));
        }
        desk.provider.then(Step.calls(USAGE, calls)).then(Step.answer(USAGE, "Asked."));
        desk.call("agent.message.send", "agentId", a, "text", "Save them.");
        await().atMost(Duration.ofSeconds(15)).until(() -> pending().size() == Math.min(outside.size(), 5));
        // The pending cap is 5 an agent: the rest are refused ask_cap, never done unasked.
        for (Map<String, Object> card : pending()) {
            decide(card, false);
        }
        desk.reply(a, 2);
        assertThat(deskd.runsOf("files_write")).isEmpty();
        assertThat(audit("approval.auto")).isEmpty();
    }

    @Test
    void aNotebookAdditionMustBeInTheSwitchsTabByDeskdsLook() throws Exception {
        // An append whose page deskd's look finds in another tab asks; one in the switch's tab doesn't.
        deskd.looks.put("notebook_write", c -> {
            Map<String, Object> args = map(c.get("args"));
            String tab = "p-in".equals(args.get("pageId")) ? "tab-1" : "tab-2";
            Map<String, Object> r = new HashMap<>();
            r.put("risk", "write");
            r.put("context", "agent");
            Map<String, Object> target = new HashMap<>();
            target.put("kind", "page");
            target.put("pageId", args.get("pageId"));
            target.put("title", "Plan");
            if (args.get("pageId") != null) {
                target.put("tabId", tab);
            }
            r.put("target", target);
            r.put("payload", args);
            return FakeDeskLink.ok(r, List.of());
        });
        desk.provider.then(Step.calls(USAGE, List.of(
                Step.call("c1", "notebook_write", "pageId", "p-in", "op", "append", "markdown", "a line"))))
                .then(Step.answer(USAGE, "Added."));
        desk.ask(a, "Add a line.");
        assertThat(deskd.runsOf("notebook_write")).singleElement().satisfies(r -> assertThat(r)
                .containsEntry("auto", "notebook"));
        desk.provider.then(Step.calls(USAGE, List.of(
                Step.call("c2", "notebook_write", "pageId", "p-out", "op", "append", "markdown", "a line"))))
                .then(Step.answer(USAGE, "Asked."));
        desk.call("agent.message.send", "agentId", a, "text", "Add a line there.");
        decide(awaitCard(), false);
        desk.reply(a, 4);
        // A new page only in the switch's tab; a replace never.
        desk.provider.then(Step.calls(USAGE, List.of(
                Step.call("c3", "notebook_write", "new", Map.of("tabId", "tab-1", "title", "Trip"), "op", "create",
                        "markdown", "plan"))))
                .then(Step.answer(USAGE, "Made."));
        desk.ask(a, "Start a page.");
        assertThat(deskd.runsOf("notebook_write")).hasSize(2);
        desk.provider.then(Step.calls(USAGE, List.of(
                Step.call("c4", "notebook_write", "new", Map.of("tabId", "tab-9", "title", "Trip"), "op", "create",
                        "markdown", "plan"))))
                .then(Step.answer(USAGE, "Asked."));
        desk.call("agent.message.send", "agentId", a, "text", "Start one there.");
        decide(awaitCard(), false);
        desk.reply(a, 8);
        assertThat(deskd.runsOf("notebook_write")).hasSize(2);
    }

    @Test
    void aPayloadTheMemberDeclinedIsNeverDoneUnaskedInThatRun() throws Exception {
        // Security's AAW-L1: the switch is off when it asks; the member turns it on while the card waits, then declines.
        switches(null, null);
        desk.provider.then(Step.calls(USAGE, List.of(write("c1", "Research/plan.md"))))
                .then(Step.calls(USAGE, List.of(write("c2", "Research/plan.md"))))
                .then(Step.answer(USAGE, "OK."));
        desk.call("agent.message.send", "agentId", a, "text", "Save the plan.");
        Map<String, Object> card = awaitCard();
        switches("Research", null);
        decide(card, false);
        desk.reply(a, 2);
        // The model tried the same payload again: refused, not done unasked.
        assertThat(results().get(results().size() - 1).content()).isEqualTo("Not allowed: declined_before.");
        assertThat(deskd.runsOf("files_write")).isEmpty();
    }

    @Test
    void deskdRefusingAnUnaskedCallMakesTheSameCallAskInThatRun() throws Exception {
        deskd.runs.put("files_write", c -> c.containsKey("auto") ? FakeDeskLink.refused("forbidden", "approval_unknown")
                : FakeDeskLink.ok(Map.of("content", "saved"), List.of()));
        desk.provider.then(Step.calls(USAGE, List.of(write("c1", "Research/a.md"))))
                .then(Step.calls(USAGE, List.of(write("c2", "Research/a.md"))))
                .then(Step.answer(USAGE, "Saved."));
        desk.call("agent.message.send", "agentId", a, "text", "Save it.");
        Map<String, Object> card = awaitCard();
        assertThat(card.get("tool")).isEqualTo("files_write");
        decide(card, true);
        desk.reply(a, 2);
        // The unasked try failed with deskd's word, its row failed; the card's yes ran it.
        assertThat(rows()).filteredOn(r -> "auto".equals(r.get("decidedBy"))).singleElement().satisfies(row ->
                assertThat(row).containsEntry("state", "failed").containsEntry("result", Map.of("ok", false, "error",
                        "approval_unknown")));
        assertThat(deskd.runsOf("files_write")).hasSize(2);
        assertThat(deskd.runsOf("files_write").get(1)).containsKey("approval").doesNotContainKey("auto");
    }

    @Test
    void twentyARunAndAHundredAnAgentADayAcrossARestart() throws Exception {
        // One run: 16 calls in a step (the step's cap), then 5: the 21st asks.
        List<ToolCall> first = new ArrayList<>();
        for (int i = 0; i < 16; i++) {
            first.add(write("a" + i, "Research/a" + i + ".md"));
        }
        List<ToolCall> second = new ArrayList<>();
        for (int i = 16; i < 21; i++) {
            second.add(write("a" + i, "Research/a" + i + ".md"));
        }
        desk.provider.then(Step.calls(USAGE, first)).then(Step.calls(USAGE, second)).then(Step.answer(USAGE, "Done."));
        desk.call("agent.message.send", "agentId", a, "text", "Save 21 files.");
        decide(awaitCard(), false);
        desk.reply(a, 2);
        assertThat(deskd.runsOf("files_write")).hasSize(20);
        // Four more runs of 20: 100 today. A restart in the middle keeps the day's count.
        for (int run = 1; run <= 4; run++) {
            if (run == 3) {
                desk.close();
                desk = open();
            }
            List<ToolCall> calls = new ArrayList<>();
            for (int i = 0; i < 16; i++) {
                calls.add(write("r" + run + "-" + i, "Research/r" + run + "-" + i + ".md"));
            }
            List<ToolCall> more = new ArrayList<>();
            for (int i = 16; i < 20; i++) {
                more.add(write("r" + run + "-" + i, "Research/r" + run + "-" + i + ".md"));
            }
            desk.provider.then(Step.calls(USAGE, calls)).then(Step.calls(USAGE, more)).then(Step.answer(USAGE, "OK."));
            desk.ask(a, "Save 20 more.");
        }
        assertThat(deskd.runsOf("files_write")).hasSize(100);
        // The 101st asks.
        desk.provider.then(Step.calls(USAGE, List.of(write("z", "Research/z.md")))).then(Step.answer(USAGE, "Asked."));
        desk.call("agent.message.send", "agentId", a, "text", "One more.");
        decide(awaitCard(), false);
        assertThat(deskd.runsOf("files_write")).hasSize(100);
        // The member's next day starts again.
        desk.reply(a, desk.thread(a).size());
        clock.advance(Duration.ofDays(1));
        desk.provider.then(Step.calls(USAGE, List.of(write("y", "Research/y.md")))).then(Step.answer(USAGE, "OK."));
        desk.ask(a, "And tomorrow.");
        assertThat(deskd.runsOf("files_write")).hasSize(101);
    }

    @Test
    void aSwitchTurnedOffHoldsForTheVeryNextCallOfARunGoing() throws Exception {
        CountDownLatch held = new CountDownLatch(1);
        desk.provider.then(Step.calls(USAGE, List.of(write("c1", "Research/one.md"))))
                .then(Step.calls(USAGE, List.of(write("c2", "Research/two.md"))).heldBy(held))
                .then(Step.answer(USAGE, "OK."));
        desk.call("agent.message.send", "agentId", a, "text", "Save two.");
        await().atMost(Duration.ofSeconds(15)).until(() -> deskd.runsOf("files_write").size() == 1);
        switches(null, "tab-1");
        held.countDown();
        decide(awaitCard(), false);
        desk.reply(a, 2);
        assertThat(deskd.runsOf("files_write")).hasSize(1);
    }

    @Test
    void theUndoAsDeskdRelaysItStampsTheRowOnceAndIsAudited() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(write("c1", "Research/a.md")))).then(Step.answer(USAGE, "OK."));
        desk.ask(a, "Save it.");
        String id = (String) rows().get(0).get("id");
        // deskd's refusal (the file changed since): audited, the row unchanged.
        Map<String, Object> refused = map(desk.call("agent.approval.undo", "approvalId", id, "outcome", "changed")
                .get("approval"));
        assertThat(refused).containsEntry("undoneAt", null);
        assertThat(audit("approval.undo")).singleElement().satisfies(r -> assertThat(r.entry().decision())
                .isEqualTo("refused:changed"));
        // deskd took it back: stamped, audited, and the reply's line says so.
        Map<String, Object> undone = map(desk.call("agent.approval.undo", "approvalId", id, "outcome", "ok")
                .get("approval"));
        assertThat(undone.get("undoneAt")).isNotNull();
        assertThat(undone).containsEntry("undoneBy", "owner").containsEntry("state", "done");
        assertThat(audit("approval.undo")).extracting(r -> r.entry().decision())
                .containsExactlyInAnyOrder("refused:changed", "ok");
        assertThat(list(desk.lastReply(a).get("auto")).get(0).get("undoneAt")).isNotNull();
        // Once.
        RpcError again = desk.refused("agent.approval.undo", "approvalId", id, "outcome", "ok");
        assertThat(again.code()).isEqualTo("conflict");
        // Only a call done without asking: a card's id, an unknown one or no outcome is nothing.
        desk.provider.then(Step.calls(USAGE, List.of(write("c2", "Elsewhere/b.md")))).then(Step.answer(USAGE, "OK."));
        desk.call("agent.message.send", "agentId", a, "text", "Save that.");
        Map<String, Object> card = awaitCard();
        assertThat(desk.refused("agent.approval.undo", "approvalId", card.get("id"), "outcome", "ok").code())
                .isEqualTo("not_found");
        assertThat(desk.refused("agent.approval.undo", "approvalId", "ap-zzzzzzzzzzzzzzzzzzzz", "outcome", "ok").code())
                .isEqualTo("not_found");
        assertThat(desk.refused("agent.approval.undo", "approvalId", id).code()).isEqualTo("bad_request");
        decide(card, false);
    }

    @Test
    void whatATimersRunDidWithoutAskingCountsOnTheTileUntilTheMemberLooks() throws Exception {
        desk.call("agent.timer.set", "agentId", a, "timer", Map.of("label", "Notes", "kind", "once", "inMinutes", 5,
                "prompt", "Save the notes."));
        desk.provider.then(Step.calls(USAGE, List.of(write("c1", "Research/t1.md"), write("c2", "Research/t2.md"))))
                .then(Step.answer(USAGE, "Saved two."));
        clock.advance(Duration.ofMinutes(6));
        assertThat(desk.team.timers().runDue()).isEqualTo(1);
        await().atMost(Duration.ofSeconds(15)).until(() -> deskd.runsOf("files_write").size() == 2);
        await().atMost(Duration.ofSeconds(15)).until(() -> Integer.valueOf(2).equals(desk.agentView(a).get("autoUnseen")));
        // One undone: it isn't counted any more.
        String id = (String) rows().get(0).get("id");
        desk.call("agent.approval.undo", "approvalId", id, "outcome", "ok");
        assertThat(desk.agentView(a).get("autoUnseen")).isEqualTo(1);
        // The member looks: none, and after a restart still none.
        desk.call("agent.seen", "agentId", a);
        assertThat(desk.agentView(a).get("autoUnseen")).isEqualTo(0);
        desk.close();
        desk = open();
        assertThat(desk.agentView(a).get("autoUnseen")).isEqualTo(0);
        // A run the member started never counts there: they're looking at it.
        desk.provider.then(Step.calls(USAGE, List.of(write("c3", "Research/t3.md")))).then(Step.answer(USAGE, "OK."));
        desk.ask(a, "Save one more.");
        assertThat(desk.agentView(a).get("autoUnseen")).isEqualTo(0);
    }

    @Test
    void nothingIsDoneUnaskedOnAGuildDesk() throws Exception {
        desk.service.guildDesk();
        desk.provider.then(Step.calls(USAGE, List.of(write("c1", "Research/a.md")))).then(Step.answer(USAGE, "Asked."));
        desk.call("agent.message.send", "agentId", a, "text", "Save it.");
        decide(awaitCard(), false);
        desk.reply(a, 2);
        assertThat(deskd.runsOf("files_write")).isEmpty();
    }
}
