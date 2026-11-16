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
import com.minimalistalliance.desk.agent.store.RunCallStore;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The four restart defects (durable runs' SIZING §1), each with a kill: desk-agent killed mid-call and at settle, and
 * deskd's link dropped mid-call. A real {@code AgentService} on real SQLite, the fake provider and a scripted deskd; a
 * kill closes the files under the run ({@link TeamDesk#kill}) and a new desk opens on them.
 * <ol>
 *   <li>After a kill, the reply keeps its text and chips so far: they're written at each step.
 *   <li>An unasked or {@code own} call in flight at a kill leaves a trace: its record and a {@code tool.interrupt} row.
 *   <li>A lost deskd link no longer settles an approved call {@code failed}: asked again by its key it gets deskd's real
 *       result, or ends {@code interrupted}, and is never run twice.
 *   <li>A killed timer run no longer stays {@code running}: it ends {@code interrupted} at open.
 * </ol>
 */
class DurableSeamKillTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);

    @TempDir
    Path data;

    private final MutableClock clock = new MutableClock(Rig.START);
    private final FakeDeskLink deskd = new FakeDeskLink();
    /** What a restarted desk's deskd hears: never the call again. */
    private final FakeDeskLink after = new FakeDeskLink();
    /** Lets go of whatever the killed process's run waits on, once the test is done with it. */
    private final CountDownLatch release = new CountDownLatch(1);
    private TeamDesk desk;
    private String a;

    @BeforeEach
    void start() throws Exception {
        desk = new TeamDesk(data, clock);
        desk.service.deskLink(deskd);
        a = desk.agent("Alice");
    }

    @AfterEach
    void stop() {
        release.countDown();
        desk.close();
    }

    // ---------------------------------------------------------------- helpers

    private static ToolCall call(String id, String name, Object... pairs) {
        return Step.call(id, name, pairs);
    }

    /**
     * A kill, and a new start on the same files, whose deskd is {@link #after}, with durable runs' kill switch off: these
     * are the seam's cases, a run that can't resume. The resume's own are {@code run.ResumeKillTest}.
     */
    private void killAndRestart() throws Exception {
        desk.kill();
        TeamDesk.resumesOff(data);
        desk = new TeamDesk(data, clock);
        desk.service.deskLink(after);
    }

    private DeskLink.Reply waitThen(CountDownLatch entered, DeskLink.Reply reply) {
        entered.countDown();
        try {
            release.await(30, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return reply;
    }

    private Map<String, Object> awaitCard() {
        AtomicReference<List<Map<String, Object>>> last = new AtomicReference<>();
        await().atMost(Duration.ofSeconds(15)).until(() -> {
            last.set(list(desk.call("agent.approvals.list", "agentId", a).get("approvals")));
            return last.get().size() == 1;
        });
        return last.get().get(0);
    }

    private void approve(Map<String, Object> card) throws Exception {
        String sha = Approvals.hash((String) card.get("agentId"), (String) card.get("runId"),
                (String) card.get("tool"), (String) card.get("context"), map(card.get("payload")));
        desk.call("agent.approval.decide", "approvalId", card.get("id"), "approve", true, "sha256", sha);
    }

    private Map<String, Object> approval(Object id) throws Exception {
        return map(desk.call("agent.approval.get", "approvalId", id).get("approval"));
    }

    private void lookWrite(String path) {
        deskd.looks.put("files_write", c -> FakeDeskLink.look("write", "agent",
                Map.of("path", path, "text", "x", "replace", false), null));
    }

    private List<RunCallStore.Call> records() throws Exception {
        List<RunCallStore.Call> all = new ArrayList<>();
        for (Map<String, Object> m : desk.thread(a)) {
            if (m.get("runId") instanceof String runId) {
                all.addAll(desk.service.runCalls().store().ofRun(runId));
            }
        }
        return all;
    }

    private RunCallStore.Call record(String tool) throws Exception {
        return records().stream().filter(c -> c.tool().equals(tool)).findFirst().orElseThrow();
    }

    private List<AuditLog.Row> audited(String action) throws Exception {
        return desk.audit.readBefore(null, 1000).stream().filter(r -> r.entry().action().equals(action)).toList();
    }

    private List<ToolResult> results() {
        return TeamDesk.toolResults(desk.lastRequest());
    }

    // ---------------------------------------------------------------- 1, 2: killed mid-call

    @Test
    void killedMidCallTheReplyKeepsItsTextAndChipsAndTheApprovedWriteIsInterruptedNeverRunAgain() throws Exception {
        deskd.runs.put("files_list", c -> FakeDeskLink.ok(Map.of("content", Map.of("entries", List.of())), List.of()));
        lookWrite("a.md");
        CountDownLatch entered = new CountDownLatch(1);
        deskd.runs.put("files_write", c -> waitThen(entered, FakeDeskLink.ok(Map.of("content", "saved"), List.of())));
        desk.provider.then(Step.calls(USAGE, List.of(call("c1", "files_list", "path", "")), "Looking first."))
                .then(Step.calls(USAGE, List.of(call("c2", "files_write", "path", "a.md", "text", "x")),
                        "Saving it now."));
        desk.call("agent.message.send", "agentId", a, "text", "Save it.");
        Map<String, Object> card = awaitCard();
        approve(card);
        assertThat(entered.await(15, TimeUnit.SECONDS)).isTrue();
        String key = (String) deskd.runsOf("files_write").get(0).get("key");

        killAndRestart();

        // 1. The reply ended interrupted with what its steps wrote: both steps' text and the first step's chip.
        Map<String, Object> reply = desk.lastReply(a);
        assertThat(reply).containsEntry("state", "failed").containsEntry("error", "unavailable")
                .containsEntry("errorDetail", "interrupted");
        assertThat((String) reply.get("text")).contains("Looking first.").contains("Saving it now.");
        assertThat(list(reply.get("tools"))).singleElement().satisfies(chip -> assertThat(chip)
                .containsEntry("name", "files_list").containsEntry("ok", true));
        // The approved write: interrupted ("may have happened"), its record too, keyed as deskd heard it.
        assertThat(approval(card.get("id"))).containsEntry("state", "interrupted");
        RunCallStore.Call write = record("files_write");
        assertThat(write.key()).isEqualTo(key);
        assertThat(write.state()).isEqualTo("interrupted");
        assertThat(write.detail()).isEqualTo("restart");
        assertThat(write.approvalId()).isEqualTo(card.get("id"));
        assertThat(write.step()).isEqualTo(2);
        assertThat(record("files_list").state()).isEqualTo("done");
        assertThat(audited("tool.interrupt")).singleElement().satisfies(r -> assertThat(r.entry().target())
                .isEqualTo("tool:files_write run:" + write.runId() + " call:" + key + " approval:" + card.get("id")));
        // Nothing ran it again: the old deskd heard it once, the new one never.
        assertThat(deskd.runsOf("files_write")).hasSize(1);
        assertThat(after.runsOf("files_write")).isEmpty();
        assertThat(desk.audit.verify().intact()).isTrue();
    }

    @Test
    void aKilledReplyThatReadUntrustedContentKeepsItsMarkWithItsText() throws Exception {
        lookWrite("a.md");
        CountDownLatch entered = new CountDownLatch(1);
        deskd.runs.put("files_write", c -> waitThen(entered, FakeDeskLink.ok(Map.of("content", "saved"), List.of())));
        desk.provider.then(Step.calls(USAGE, List.of(call("c1", "browser_read", "tabId", "t1")), "Reading the page."))
                .then(Step.calls(USAGE, List.of(call("c2", "files_write", "path", "a.md", "text", "x")),
                        "Saving what it says."));
        desk.call("agent.message.send", "agentId", a, "text", "Save the page.");
        approve(awaitCard());
        assertThat(entered.await(15, TimeUnit.SECONDS)).isTrue();

        killAndRestart();

        // Security's DS-M1: the text a kill kept was written after its run's marks, so it never reads unmarked.
        Map<String, Object> reply = desk.lastReply(a);
        assertThat((String) reply.get("text")).contains("Reading the page.").contains("Saving what it says.");
        assertThat(reply).containsEntry("untrusted", true);
        assertThat(desk.service.approvals().carried(desk.store.messages(a, 10))).contains(Taint.U);
    }

    /** The member's Files switch for Alice, in the folder Notes (auto-approve, W3). */
    private void filesSwitch() throws Exception {
        desk.call("agent.access.set", "agentId", a, "auto", Map.of("files", Map.of("folder", "Notes")));
    }

    @Test
    void anUnaskedCallInFlightAtAKillLeavesATrace() throws Exception {
        filesSwitch();
        lookWrite("Notes/notes.md");
        CountDownLatch entered = new CountDownLatch(1);
        deskd.runs.put("files_write", c -> waitThen(entered, FakeDeskLink.ok(Map.of("content", "saved"), List.of())));
        desk.provider.then(Step.calls(USAGE, List.of(call("c1", "files_write", "path", "Notes/notes.md", "text", "x")),
                "Noting it."));
        desk.call("agent.message.send", "agentId", a, "text", "Note it.");
        assertThat(entered.await(15, TimeUnit.SECONDS)).isTrue();
        String autoId = (String) deskd.runsOf("files_write").get(0).get("autoApprovalId");

        killAndRestart();

        RunCallStore.Call write = record("files_write");
        assertThat(write.state()).isEqualTo("interrupted");
        assertThat(write.auto()).isEqualTo("files");
        assertThat(write.approvalId()).isEqualTo(autoId);
        assertThat(audited("tool.interrupt")).singleElement().satisfies(r -> {
            assertThat(r.entry().target()).contains("tool:files_write").contains("approval:" + autoId)
                    .endsWith(" auto:files");
            assertThat(r.entry().decision()).isEqualTo("restart");
        });
        // Its own approval row, decided by auto (W3), ends interrupted as a card's would: it may have happened.
        assertThat(list(desk.call("agent.approvals.list", "agentId", a, "state", "all").get("approvals")))
                .singleElement().satisfies(row -> assertThat(row).containsEntry("id", autoId)
                        .containsEntry("decidedBy", "auto").containsEntry("state", "interrupted"));
        assertThat(desk.lastReply(a).get("text")).isEqualTo("Noting it.");
        assertThat(after.runsOf("files_write")).isEmpty();
    }

    @Test
    void anUnaskedCallKilledAtSettleTakesWhatItCameToFromItsRecord() throws Exception {
        // The call records fit the rows of calls done without asking (W3): the record's approval id is the row's.
        filesSwitch();
        lookWrite("Notes/a.md");
        CountDownLatch atSettle = new CountDownLatch(1);
        desk.service.runCalls().afterSettledForTest(key -> {
            atSettle.countDown();
            try {
                release.await(30, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        desk.provider.then(Step.calls(USAGE, List.of(call("c1", "files_write", "path", "Notes/a.md", "text", "x"))));
        desk.call("agent.message.send", "agentId", a, "text", "Save it.");
        assertThat(atSettle.await(15, TimeUnit.SECONDS)).isTrue();
        String autoId = (String) deskd.runsOf("files_write").get(0).get("autoApprovalId");

        killAndRestart();

        Map<String, Object> row = approval(autoId);
        assertThat(row).containsEntry("decidedBy", "auto").containsEntry("state", "done");
        assertThat(map(row.get("result"))).containsEntry("ok", true);
        assertThat(record("files_write").approvalId()).isEqualTo(autoId);
        assertThat(audited("tool.interrupt")).isEmpty();
        assertThat(after.runsOf("files_write")).isEmpty();
    }

    @Test
    void anOwnCallInFlightAtAKillLeavesATrace() throws Exception {
        String b = desk.agent("Bob");
        desk.link(a, b, "Anything.");
        // Alice messages Bob, and Bob's answer is still coming when the process dies.
        desk.provider.then(Step.calls(USAGE, List.of(call("m1", "message_agent", "to", b, "text", "Hello?")),
                "Asking Bob.")).then(Step.answer(USAGE, "Hello back.").heldBy(release));
        desk.call("agent.message.send", "agentId", a, "text", "Ask Bob.");
        await().atMost(Duration.ofSeconds(15)).until(() -> !desk.service.runCalls().store().started().isEmpty());

        killAndRestart();

        RunCallStore.Call message = record("message_agent");
        assertThat(message.state()).isEqualTo("interrupted");
        assertThat(message.risk()).isEqualTo("own");
        assertThat(message.restart()).isEqualTo("interrupt");
        assertThat(message.host()).isEqualTo("desk_agent");
        assertThat(audited("tool.interrupt")).singleElement().satisfies(r -> assertThat(r.entry().target())
                .isEqualTo("tool:message_agent run:" + message.runId() + " call:" + message.key()));
        assertThat(desk.lastReply(a).get("text")).isEqualTo("Asking Bob.");
    }

    // ---------------------------------------------------------------- killed at settle

    @Test
    void killedAtSettleTheApprovalTakesWhatTheCallCameToNotInterrupted() throws Exception {
        lookWrite("a.md");
        deskd.runs.put("files_write", c -> FakeDeskLink.refused("conflict", "changed"));
        CountDownLatch atSettle = new CountDownLatch(1);
        desk.service.runCalls().afterSettledForTest(key -> {
            atSettle.countDown();
            try {
                release.await(30, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        desk.provider.then(Step.calls(USAGE, List.of(call("c1", "files_write", "path", "a.md", "text", "x"))));
        desk.call("agent.message.send", "agentId", a, "text", "Save it.");
        Map<String, Object> card = awaitCard();
        approve(card);
        assertThat(atSettle.await(15, TimeUnit.SECONDS)).isTrue();

        killAndRestart();

        Map<String, Object> settled = approval(card.get("id"));
        assertThat(settled).containsEntry("state", "failed");
        assertThat(map(settled.get("result"))).containsEntry("ok", false).containsEntry("error", "changed");
        RunCallStore.Call write = record("files_write");
        assertThat(write.state()).isEqualTo("failed");
        assertThat(audited("tool.interrupt")).isEmpty();
        assertThat(audited("tool.call")).singleElement().satisfies(r -> {
            assertThat(r.entry().target()).contains("call:" + write.key()).contains("approval:" + card.get("id"));
            assertThat(r.entry().decision()).isEqualTo("error:changed");
        });
    }

    @Test
    void killedAtSettleAfterAWriteThatWorkedTheApprovalIsDone() throws Exception {
        lookWrite("a.md");
        CountDownLatch atSettle = new CountDownLatch(1);
        desk.service.runCalls().afterSettledForTest(key -> {
            atSettle.countDown();
            try {
                release.await(30, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        desk.provider.then(Step.calls(USAGE, List.of(call("c1", "files_write", "path", "a.md", "text", "x"))));
        desk.call("agent.message.send", "agentId", a, "text", "Save it.");
        Map<String, Object> card = awaitCard();
        approve(card);
        assertThat(atSettle.await(15, TimeUnit.SECONDS)).isTrue();

        killAndRestart();

        assertThat(approval(card.get("id"))).containsEntry("state", "done");
        assertThat(map(approval(card.get("id")).get("result"))).containsEntry("ok", true);
        assertThat(deskd.runsOf("files_write")).hasSize(1);
        assertThat(after.runsOf("files_write")).isEmpty();
    }

    // ---------------------------------------------------------------- 3: deskd's link dropped

    private Map<String, Object> approvedWrite() throws Exception {
        lookWrite("a.md");
        desk.provider.then(Step.calls(USAGE, List.of(call("c1", "files_write", "path", "a.md", "text", "x"))))
                .then(Step.answer(USAGE, "Done."));
        desk.call("agent.message.send", "agentId", a, "text", "Save it.");
        Map<String, Object> card = awaitCard();
        approve(card);
        desk.reply(a, 2);
        return card;
    }

    @Test
    void aDroppedLinkAskedAgainByItsKeyGetsDeskdsRealResultAndRunsOnce() throws Exception {
        deskd.keyed = true;
        AtomicInteger heard = new AtomicInteger();
        deskd.runs.put("files_write", c -> heard.incrementAndGet() == 1 ? DeskLink.Reply.noAnswer()
                : FakeDeskLink.ok(Map.of("content", "saved"), List.of()));
        Map<String, Object> card = approvedWrite();

        assertThat(approval(card.get("id"))).containsEntry("state", "done");
        assertThat(results().get(0).content()).isEqualTo("Approved by the member.\nsaved");
        List<Map<String, Object>> sent = deskd.runsOf("files_write");
        assertThat(sent).hasSize(2);
        assertThat(sent.get(1).get("key")).isEqualTo(sent.get(0).get("key")).isNotNull();
        assertThat(sent.get(0)).doesNotContainKey("retry");
        assertThat(sent.get(1)).containsEntry("retry", true);
        assertThat(record("files_write").state()).isEqualTo("done");
    }

    @Test
    void aDroppedLinkDeskdNoLongerHoldsTheKeyForEndsInterruptedNotFailed() throws Exception {
        deskd.keyed = true;
        deskd.runs.put("files_write", c -> Boolean.TRUE.equals(c.get("retry"))
                ? FakeDeskLink.refused("conflict", "key_unknown") : DeskLink.Reply.noAnswer());
        Map<String, Object> card = approvedWrite();

        assertThat(approval(card.get("id"))).containsEntry("state", "interrupted");
        assertThat(results().get(0).content()).startsWith(
                "Approved by the member, but it failed: Interrupted: key_unknown. It may or may not have happened");
        assertThat(deskd.runsOf("files_write")).hasSize(2);
        RunCallStore.Call write = record("files_write");
        assertThat(write.state()).isEqualTo("interrupted");
        assertThat(write.detail()).isEqualTo("key_unknown");
        assertThat(audited("tool.call")).filteredOn(r -> r.entry().target().contains("files_write"))
                .singleElement().satisfies(r -> assertThat(r.entry().decision()).isEqualTo("interrupted:key_unknown"));
        Map<String, Object> chip = list(desk.lastReply(a).get("tools")).get(0);
        assertThat(chip).containsEntry("ok", false);
    }

    @Test
    void aBusyDeskdIsAskedAgainNotTakenAsTheCallsOutcome() throws Exception {
        deskd.keyed = true;
        AtomicInteger heard = new AtomicInteger();
        // Security's DS-L1: deskd's calls at once full when the call is asked again says nothing of the call.
        deskd.runs.put("files_write", c -> switch (heard.incrementAndGet()) {
            case 1 -> DeskLink.Reply.noAnswer();
            case 2 -> FakeDeskLink.refused("rate_limited", "tools");
            default -> FakeDeskLink.ok(Map.of("content", "saved"), List.of());
        });
        Map<String, Object> card = approvedWrite();

        assertThat(approval(card.get("id"))).containsEntry("state", "done");
        assertThat(deskd.runsOf("files_write")).hasSize(3);
        assertThat(results().get(0).content()).isEqualTo("Approved by the member.\nsaved");
    }

    @Test
    void anOlderDeskdThatKeepsNoKeysIsNeverAskedTwice() throws Exception {
        deskd.runs.put("files_write", c -> DeskLink.Reply.noAnswer());
        Map<String, Object> card = approvedWrite();

        assertThat(approval(card.get("id"))).containsEntry("state", "interrupted");
        assertThat(deskd.runsOf("files_write")).hasSize(1);
        assertThat(record("files_write").detail()).isEqualTo("lost");
    }

    @Test
    void aLinkThatNeverComesBackEndsInterruptedOnceTheWaitIsOver() throws Exception {
        deskd.keyed = true;
        desk.service.agentTools().confirmFor(Duration.ofMillis(400));
        deskd.runs.put("files_write", c -> {
            deskd.offered = Set.of();
            return DeskLink.Reply.noAnswer();
        });
        Map<String, Object> card = approvedWrite();

        assertThat(approval(card.get("id"))).containsEntry("state", "interrupted");
        assertThat(deskd.runsOf("files_write")).hasSize(1);
    }

    @Test
    void aReadWithNoAnswerFailsAsBeforeAndIsntAskedAgain() throws Exception {
        deskd.keyed = true;
        deskd.runs.put("files_list", c -> DeskLink.Reply.noAnswer());
        desk.provider.then(Step.calls(USAGE, List.of(call("c1", "files_list", "path", ""))))
                .then(Step.answer(USAGE, "Couldn't look."));
        desk.ask(a, "Look.");
        assertThat(results().get(0).content()).isEqualTo("Failed: unavailable.");
        assertThat(deskd.runsOf("files_list")).hasSize(1);
        assertThat(record("files_list").state()).isEqualTo("failed");
    }

    // ---------------------------------------------------------------- 4: a timer's run

    @Test
    void aKilledTimerRunEndsInterruptedAtOpenNotRunning() throws Exception {
        desk.zone("America/Denver");
        Map<String, Object> timer = map(desk.call("agent.timer.set", "agentId", a, "timer", TeamDesk.m("label",
                "Later", "kind", "once", "inMinutes", 30, "prompt", "Do the later thing.")).get("timer"));
        clock.advance(Duration.ofMinutes(31));
        desk.provider.then(Step.answer(USAGE, "Did it.").heldBy(release));
        assertThat(desk.team.timers().runDue()).isEqualTo(1);
        assertThat(only().get("lastState")).isEqualTo("running");

        killAndRestart();

        Map<String, Object> after = only();
        assertThat(after).containsEntry("lastState", "interrupted").containsEntry("id", timer.get("id"));
        assertThat(audited("timer.fire")).filteredOn(r -> r.entry().decision().equals("interrupted")).hasSize(1);
        assertThat(desk.lastReply(a)).containsEntry("state", "failed").containsEntry("errorDetail", "interrupted");
    }

    private Map<String, Object> only() throws Exception {
        List<Map<String, Object>> timers = list(desk.call("agent.timer.list", "agentId", a).get("timers"));
        assertThat(timers).hasSize(1);
        return timers.get(0);
    }
}
