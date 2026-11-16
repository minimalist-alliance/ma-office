package com.minimalistalliance.desk.agent.tool;

import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.run.RunWaits;
import com.minimalistalliance.desk.agent.run.Waits;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.store.RunStore;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import com.minimalistalliance.desk.agent.tool.ResumeRig.Decision;
import com.minimalistalliance.desk.agent.tool.ResumeRig.Fault;
import com.minimalistalliance.desk.agent.tool.ResumeRig.Kind;
import com.minimalistalliance.desk.agent.tool.ResumeRig.Point;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Durable runs' resume, case by case (the draft ADR's §3, "Restarts"): what the kill matrix and the property test
 * don't single out. A card's own time still applies across a restart; a run past its checkpoint's cap, or whose
 * checkpoint doesn't read whole, ends {@code interrupted} as before; a timer's run resumes and settles its timer; a
 * wait outlives a kill with its first deadline; a rollback's leftovers are dropped.
 */
class ResumeTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);

    @TempDir
    Path root;

    private ResumeRig rig(String name) throws Exception {
        return new ResumeRig(Files.createDirectories(root.resolve(name)), new MutableClock(Rig.START));
    }

    @Test
    void aCardWhoseTimePassesWhileTheDeskIsDownExpiresAndNothingRuns() throws Exception {
        try (ResumeRig rig = rig("expiry")) {
            rig.step(Kind.WRITE).decide(1, 0, Decision.APPROVE).fault(Point.CARD, 1, Fault.STOP_DESK);
            rig.downtime = Duration.ofHours(2);
            rig.send("Save it.");
            Map<String, Object> reply = rig.drive();

            assertThat(rig.check(reply)).isEmpty();
            assertThat(reply).containsEntry("state", "done").containsEntry("resumed", 1);
            Map<String, Object> card = list(rig.desk.call("agent.approvals.list", "agentId", rig.agent, "state", "all")
                    .get("approvals")).get(0);
            assertThat(card).containsEntry("state", "expired").containsEntry("detail", "timeout");
            assertThat(rig.deskd.executed).isEmpty();
            assertThat(rig.resultFor("s1c0.md")).startsWith("The member didn't answer by ");
        }
    }

    @Test
    void aRunPastItsCheckpointsCapEndsInterruptedAtTheRestartAsBefore() throws Exception {
        try (ResumeRig rig = rig("cap")) {
            rig.desk.service.runCalls().checkpoints().capForTest(2_000);
            rig.step(Kind.READ).step(Kind.READ).fault(Point.MODEL, 2, Fault.KILL);
            rig.send("Look twice, " + "and say so in many words. ".repeat(100));
            Map<String, Object> reply = rig.drive();

            assertThat(reply).containsEntry("state", "failed").containsEntry("errorDetail", "interrupted");
            assertThat(reply.get("resumed")).isNull();
            assertThat(rig.deskd.executed).hasSize(1);
            RunStore.Run row = rig.desk.service.runCalls().checkpoints().store().run(rig.runId);
            assertThat(row.state()).isEqualTo("interrupted");
            assertThat(row.start()).isNull();
        }
    }

    @Test
    void aCheckpointThatDoesntReadWholeEndsTheRunInterruptedWithATrace() throws Exception {
        try (ResumeRig rig = rig("broken")) {
            rig.step(Kind.WRITE).fault(Point.ADMITTED, 1, Fault.KILL);
            rig.whileDown = () -> {
                try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + rig.data.resolve("agent.db"));
                        Statement s = c.createStatement()) {
                    s.executeUpdate("UPDATE run_steps SET plan = '{'");
                }
            };
            rig.send("Save it.");
            Map<String, Object> reply = rig.drive();

            assertThat(reply).containsEntry("state", "failed").containsEntry("errorDetail", "interrupted");
            assertThat(rig.deskd.executed).isEmpty();
            Map<String, Object> card = list(rig.desk.call("agent.approvals.list", "agentId", rig.agent, "state", "all")
                    .get("approvals")).get(0);
            assertThat(card).containsEntry("state", "expired").containsEntry("detail", "restart");
            assertThat(rig.desk.audit.verify().intact()).isTrue();
        }
    }

    @Test
    void aTimersRunResumesAndSettlesItsTimer() throws Exception {
        Path data = Files.createDirectories(root.resolve("timer"));
        MutableClock clock = new MutableClock(Rig.START);
        TeamDesk desk = new TeamDesk(data, clock);
        try {
            String a = desk.agent("Alice");
            desk.zone("America/Denver");
            desk.call("agent.timer.set", "agentId", a, "timer", TeamDesk.m("label", "Later", "kind", "once",
                    "inMinutes", 30, "prompt", "Do the later thing."));
            clock.advance(Duration.ofMinutes(31));
            CountDownLatch never = new CountDownLatch(1);
            desk.provider.then(Step.answer(USAGE, "Half").heldBy(never));
            assertThat(desk.team.timers().runDue()).isEqualTo(1);
            TeamDesk first = desk;
            org.awaitility.Awaitility.await().until(() -> first.requests().size() == 1);
            Object runId = desk.thread(a).getLast().get("runId");
            desk.kill();
            desk.service.call("agent.run.stop", TeamDesk.m("runId", runId));

            desk = new TeamDesk(data, clock);
            assertThat(timer(desk, a)).containsEntry("lastState", "running");
            desk.provider.then(Step.answer(USAGE, "Did the later thing."));
            desk.resume();
            Map<String, Object> reply = desk.lastReply(a);
            assertThat(reply).containsEntry("state", "done").containsEntry("text", "Did the later thing.")
                    .containsEntry("resumed", 1);
            TeamDesk now = desk;
            org.awaitility.Awaitility.await().until(() -> "ok".equals(timer(now, a).get("lastState")));
        } finally {
            desk.close();
        }
    }

    private static Map<String, Object> timer(TeamDesk desk, String agentId) throws Exception {
        return list(desk.call("agent.timer.list", "agentId", agentId).get("timers")).get(0);
    }

    @Test
    void aWaitOutlivesAKillWithItsFirstDeadlineAndTakesAnAnswerThatCameMeanwhile() throws Exception {
        Path data = Files.createDirectories(root.resolve("waits"));
        MutableClock clock = new MutableClock(Rig.START);
        AgentStore store = new AgentStore(data.resolve("agent.db"), clock);
        store.open();
        RunStore runs = new RunStore(store);
        long now = clock.millis();
        runs.begin(new RunStore.Run("r1", "a1", "m1", "running", null, true, 0, "{}", "{}", 0, 0, now, now, null),
                1 << 20);
        RunContext run = RunContext.of("r1", "a1", com.minimalistalliance.desk.agent.service.Caller.OWNER, null, "m1");
        Waits waits = new Waits(runs, clock);
        AtomicReference<String> waitingOn = new AtomicReference<>();
        waits.onChange((agent, runId) -> waitingOn.set(waits.waitingOn(runId)));

        // A first wait, cut off by a kill: kept with its deadline.
        Thread first = Thread.ofVirtual().start(() -> {
            try {
                waits.await(run, "k1", "desk", "env-1", Duration.ofSeconds(120));
            } catch (InterruptedException e) {
                // The kill.
            }
        });
        org.awaitility.Awaitility.await().until(() -> "desk".equals(waitingOn.get()));
        first.interrupt();
        first.join();
        store.close();

        // Down 60 s; the answer comes while nothing waits: kept for the run that resumes.
        clock.advance(Duration.ofSeconds(60));
        store = new AgentStore(data.resolve("agent.db"), clock);
        store.open();
        runs = new RunStore(store);
        Waits again = new Waits(runs, clock);
        assertThat(again.answer("a1", "desk", "env-1", Map.of("text", "Yes."))).isTrue();
        RunWaits.Outcome got = again.await(run, "k1", "desk", "env-1", Duration.ofSeconds(120));
        assertThat(got.answered()).isTrue();
        assertThat(got.answer()).containsEntry("text", "Yes.");
        // Its deadline was the first one's, not a new 120 s.
        assertThat(runs.wait("r1", "k1").deadlineAt()).isEqualTo(now + 120_000);

        // A second wait whose time runs out: it times out, and nothing is left waiting.
        AtomicReference<RunWaits.Outcome> second = new AtomicReference<>();
        Thread waiting = Thread.ofVirtual().start(() -> {
            try {
                second.set(again.await(run, "k2", "desk", "env-2", Duration.ofSeconds(120)));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        org.awaitility.Awaitility.await().until(() -> "desk".equals(again.waitingOn("r1")));
        clock.advance(Duration.ofSeconds(121));
        again.wake();
        waiting.join(Duration.ofSeconds(10));
        assertThat(second.get().answered()).isFalse();
        assertThat(again.waitingOn("r1")).isNull();
        // An answer for a wait that timed out isn't taken: it goes to the thread instead.
        assertThat(again.answer("a1", "desk", "env-2", Map.of("text", "Late."))).isFalse();

        // An answer a kept wait took whose run ends without reading it goes to the thread as the run ends.
        runs.await(new RunStore.Wait("r1", "k3", "a1", "desk", "env-3", "waiting", now + 999_999, null, now));
        assertThat(again.answer("a1", "desk", "env-3", Map.of("text", "Later."))).isTrue();
        List<RunWaits.Untaken> untaken = new ArrayList<>();
        again.untaken(untaken::add);
        again.ended("r1");
        assertThat(untaken).singleElement().satisfies(u -> {
            assertThat(u.ref()).isEqualTo("env-3");
            assertThat(u.answer()).containsEntry("text", "Later.");
        });
        store.close();
    }

    @Test
    void desksWaitIsDurableItsFirstDeadlineAndAnAnswerThatCameMeanwhileOneAnswerOnePlace() throws Exception {
        Path data = Files.createDirectories(root.resolve("deskwaits"));
        MutableClock clock = new MutableClock(Rig.START);
        AgentStore store = new AgentStore(data.resolve("agent.db"), clock);
        store.open();
        RunStore runs = new RunStore(store);
        long now = clock.millis();
        runs.begin(new RunStore.Run("r1", "a1", "m1", "running", null, true, 0, "{}", "{\"taint\":[]}", 0, 0, now,
                now, null), 1 << 20);
        java.util.function.Function<String, String> outboxAgent = ref -> ref.startsWith("env-") ? "a1" : null;
        com.minimalistalliance.desk.agent.run.DurableDeskWaits desks =
                new com.minimalistalliance.desk.agent.run.DurableDeskWaits(new Waits(runs, clock), outboxAgent);
        // desk_message keeps its wait before the message goes out; then the process is killed.
        desks.expect("r1", "k1", "a1", "env-1", now + 120_000);
        store.close();

        clock.advance(Duration.ofSeconds(30));
        store = new AgentStore(data.resolve("agent.db"), clock);
        store.open();
        runs = new RunStore(store);
        desks = new com.minimalistalliance.desk.agent.run.DurableDeskWaits(new Waits(runs, clock), outboxAgent);
        // The answer comes while the run is still picking up: the kept wait takes it, so it isn't the thread's.
        assertThat(desks.answer("env-1", Map.of("id", "in-1", "text", "Yes."))).isTrue();
        // The resumed call expects again with its key: the kept wait, its first deadline, and the answer.
        var wait = desks.expect("r1", "k1", "a1", "env-1", clock.millis() + 120_000);
        assertThat(wait.await()).containsEntry("text", "Yes.");
        assertThat(runs.wait("r1", "k1").deadlineAt()).isEqualTo(now + 120_000);
        // A cancelled wait (the message never went) and an answer no outbox row names take nothing: the thread's.
        desks.expect("r1", "k2", "a1", "env-2", clock.millis() + 120_000).cancel();
        assertThat(desks.answer("env-2", Map.of("id", "in-2", "text", "Late."))).isFalse();
        assertThat(desks.answer("other-3", Map.of("id", "in-3"))).isFalse();
        // A desk_message call that settles without reading its wait (interrupted after a deskd restart) ends it: an
        // answer then goes to the thread at once, not held until the run ends (Security's DR-L10).
        Waits plain = new Waits(runs, clock);
        new com.minimalistalliance.desk.agent.run.DurableDeskWaits(plain, outboxAgent)
                .expect("r1", "k4", "a1", "env-4", clock.millis() + 120_000);
        plain.cancelAny("r1", "k4");
        assertThat(desks.answer("env-4", Map.of("id", "in-4"))).isFalse();
        store.close();
    }

    @Test
    void aRollbacksLeftoversAreDroppedAndTheColumnComesBack() throws Exception {
        Path data = Files.createDirectories(root.resolve("migrate"));
        MutableClock clock = new MutableClock(Rig.START);
        AgentStore store = new AgentStore(data.resolve("agent.db"), clock);
        store.open();
        RunStore runs = new RunStore(store);
        long now = clock.millis();
        runs.begin(new RunStore.Run("r1", "manager", "m1", "running", null, true, 0, "{}", "{}", 0, 0, now, now,
                null), 1 << 20);
        runs.planned("r1", new RunStore.Step(1, "{}", null, now), "{}", now, 1 << 20);
        store.close();
        // An older desk-agent opens it (rollback): it ends the reply its way, and knows nothing of runs or resumed.
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + data.resolve("agent.db"));
                Statement s = c.createStatement()) {
            s.execute("ALTER TABLE messages DROP COLUMN resumed");
        }
        store = new AgentStore(data.resolve("agent.db"), clock);
        store.open();
        runs = new RunStore(store);
        RunStore.Run row = runs.run("r1");
        assertThat(row.resumable()).isFalse();
        assertThat(row.start()).isNull();
        assertThat(runs.steps("r1")).isEmpty();
        assertThat(runs.resumable()).isEmpty();
        assertThat(runs.anyResumed()).isFalse();
        store.close();
    }

    @Test
    void withTheKillSwitchOffARunsRecordsStillSettleAndNothingReadsInterrupted() throws Exception {
        Path data = Files.createDirectories(root.resolve("switch"));
        TeamDesk.resumesOff(data);
        try (ResumeRig rig = new ResumeRig(data, new MutableClock(Rig.START))) {
            rig.step(Kind.READ, Kind.WRITE).step(Kind.AUTO);
            rig.send("Do it all.");
            Map<String, Object> reply = rig.drive();
            assertThat(reply).containsEntry("state", "done");
            assertThat(rig.check(reply)).isEmpty();
            assertThat(rig.desk.service.runCalls().store().ofRun(rig.runId)).hasSize(3)
                    .allSatisfy(c -> assertThat(c.state()).isEqualTo("done"));
            assertThat(rig.desk.audit.readBefore(null, 1000)).noneMatch(r -> r.entry().action().equals(
                    "tool.interrupt"));
            assertThat(rig.desk.service.runCalls().checkpoints().store().run(rig.runId).resumable()).isFalse();
        }
    }

    @Test
    void aResumeIsAuditedAndTheReplySaysSo() throws Exception {
        try (ResumeRig rig = rig("audit")) {
            rig.step(Kind.WRITE).fault(Point.CARD, 1, Fault.PAUSE);
            rig.send("Save it.");
            Map<String, Object> reply = rig.drive();
            assertThat(reply).containsEntry("resumed", 1);
            List<AuditLog.Row> rows = rig.desk.audit.readBefore(null, 1000);
            assertThat(rows).filteredOn(r -> r.entry().action().equals("run.resume")).singleElement()
                    .satisfies(r -> assertThat(r.entry().target()).isEqualTo("agent:" + rig.agent + " run:"
                            + rig.runId));
            assertThat(map(rig.desk.call("agent.approval.get", "approvalId", list(rig.desk.call(
                    "agent.approvals.list", "agentId", rig.agent, "state", "all").get("approvals")).get(0).get("id"))
                    .get("approval"))).containsEntry("state", "done");
        }
    }
}
