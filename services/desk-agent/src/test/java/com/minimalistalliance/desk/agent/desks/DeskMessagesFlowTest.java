package com.minimalistalliance.desk.agent.desks;

import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.approval.Approvals;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Two desks' desk-agents, end to end through a stand-in for each deskd and an office that carries their outboxes (draft
 * ADR §14): the pairing, a message and its answer within the wait, an answer after it into the thread, the answer's
 * card when the answering run read private data, a Stop on the answering desk refusing the very next message, a restart
 * of the answering desk mid-run, and the 7-day expiry.
 */
class DeskMessagesFlowTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);

    @TempDir
    Path dir;

    private final MutableClock clock = new MutableClock(Rig.START);
    private TeamDesk a;
    private TeamDesk b;
    private final FakeDeskd deskdA = new FakeDeskd("d-aaaa");
    private final FakeDeskd deskdB = new FakeDeskd("d-bbbb");
    private String grantId;

    @BeforeEach
    void start() throws Exception {
        Files.createDirectories(dir.resolve("a"));
        Files.createDirectories(dir.resolve("b"));
        a = open("a", deskdA);
        b = open("b", deskdB);
        a.bindLead();
        b.bindLead();
    }

    private TeamDesk open(String name, FakeDeskd deskd) throws Exception {
        TeamDesk desk = new TeamDesk(dir.resolve(name), clock);
        desk.service.deskLink(deskd);
        desk.service.desks().waitFor(Duration.ofSeconds(10));
        return desk;
    }

    @AfterEach
    void stop() {
        if (a != null) {
            a.close();
        }
        if (b != null) {
            b.close();
        }
    }

    // ---------------------------------------------------------------- the office

    /** What each desk's desk-agent answered every delivery. */
    private final List<Map<String, Object>> deliveries = new java.util.concurrent.CopyOnWriteArrayList<>();

    /** One pass of the office from one desk to the other: take, deliver each in order, done. @return how many it took */
    @SuppressWarnings("unchecked")
    private int carry(TeamDesk from, FakeDeskd fromDeskd, TeamDesk to, FakeDeskd toDeskd) throws Exception {
        Map<String, Object> taken = from.service.call("agent.desks.take", TeamDesk.m("toDeskId", toDeskd.deskId));
        List<Map<String, Object>> envelopes = list(taken.get("envelopes"));
        if (envelopes.isEmpty()) {
            return 0;
        }
        List<Map<String, Object>> results = new ArrayList<>();
        for (Map<String, Object> e : envelopes) {
            Map<String, Object> envelope = map(e.get("envelope"));
            Map<String, Object> sim = (Map<String, Object>) envelope.get("sim");
            long seq = seqOf(from, (String) e.get("id"));
            Map<String, Object> opened = FakeDeskd.opened(envelope, seq, clock.millis());
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("id", e.get("id"));
            try {
                Map<String, Object> answer = to.service.call("desk.desks.deliver", TeamDesk.m("opened", opened));
                deliveries.add(answer);
                result.put("outcome", answer.get("outcome"));
                if ("accept".equals(sim.get("kind"))) {
                    String[] half = toDeskd.sends.get((String) sim.get("grantId"));
                    half[2] = "active";
                }
            } catch (RpcError refused) {
                result.put("outcome", "refused");
                result.put("reason", refused.details().get("reason"));
            }
            results.add(result);
        }
        from.service.call("agent.desks.done", TeamDesk.m("results", results));
        return envelopes.size();
    }

    private static long seqOf(TeamDesk desk, String envId) throws Exception {
        return desk.service.desks().book().out(envId).seq();
    }

    /** Both ways until nothing moves. */
    private void settle() throws Exception {
        int moved;
        do {
            moved = carry(a, deskdA, b, deskdB) + carry(b, deskdB, a, deskdA);
        } while (moved > 0);
    }

    // ---------------------------------------------------------------- the pairing

    /** The member switches B on for A's lead; B's member allows it with B's lead answering. */
    private void pair() throws Exception {
        Map<String, Object> access = map(a.service.call("agent.access.set", TeamDesk.m("agentId", AgentStore.MANAGER,
                "desks", List.of(TeamDesk.m("deskId", "d-bbbb", "deskName", "Work", "on", true)))).get("access"));
        Map<String, Object> half = list(access.get("desks")).get(0);
        assertThat(half).containsEntry("state", "offered");
        grantId = (String) half.get("grantId");
        // deskd A records it and makes the offer, which it hands desk-agent's outbox.
        deskdA.sends.put(grantId, new String[] {AgentStore.MANAGER, "d-bbbb", "offered"});
        Map<String, Object> offer = deskdA.made("offer", grantId, "d-bbbb", Map.of("fromAgentId", AgentStore.MANAGER,
                "fromAgentName", "Researcher"));
        assertThat(list(a.service.call("desk.desks.queue", TeamDesk.m("envelopes", List.of(offer))).get("ids")))
                .hasSize(1);
        assertThat(map(a.service.call("agent.desks.take", TeamDesk.m("toDeskId", "d-bbbb"))).get("envelopes"))
                .asList().hasSize(1);
        settle();

        Map<String, Object> listed = b.service.call("agent.desks.list", Map.of());
        assertThat(list(listed.get("offers"))).singleElement().satisfies(o -> {
            assertThat(o).containsEntry("grantId", grantId).containsEntry("fromDeskId", "d-aaaa")
                    .containsEntry("fromAgentName", "Researcher").containsEntry("state", "offered");
        });
        assertThat(b.service.stateSnapshot()).containsEntry("deskOffers", 1);

        Map<String, Object> allowed = map(b.service.call("agent.desks.answer", TeamDesk.m("grantId", grantId,
                "allow", true, "agentId", AgentStore.MANAGER)).get("half"));
        assertThat(allowed).containsEntry("state", "active").containsEntry("agentId", AgentStore.MANAGER);
        deskdB.answers.put(grantId, new String[] {AgentStore.MANAGER, "d-aaaa", AgentStore.MANAGER});
        Map<String, Object> accept = deskdB.made("accept", grantId, "d-aaaa", Map.of("answeredBy", AgentStore.MANAGER,
                "answeredByName", "Helper"));
        b.service.call("desk.desks.queue", TeamDesk.m("envelopes", List.of(accept)));
        settle();

        Map<String, Object> after = map(a.service.call("agent.access.get", TeamDesk.m("agentId", AgentStore.MANAGER))
                .get("access"));
        assertThat(list(after.get("desks"))).singleElement().satisfies(h -> {
            assertThat(h).containsEntry("state", "active").containsEntry("toAgentName", "Helper");
        });
        Map<String, Object> incoming = map(b.service.call("agent.access.get", TeamDesk.m("agentId", AgentStore.MANAGER))
                .get("access"));
        assertThat(list(incoming.get("incoming"))).singleElement().satisfies(h -> {
            assertThat(h).containsEntry("state", "active").containsEntry("fromDeskId", "d-aaaa");
        });
    }

    // ---------------------------------------------------------------- messages

    @Test
    void aMessageAndItsAnswerWithinTheWaitAreTheToolsResult() throws Exception {
        pair();
        b.provider.then(Step.answer(USAGE, "Two meetings: 10:00 and 15:00."));
        a.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "desk_message", "desk", "Work", "text",
                "What's on today?")))).then(Step.answer(USAGE, "Work has two meetings."));
        a.call("agent.message.send", "agentId", AgentStore.MANAGER, "text", "Ask Work what's on.");
        // The run waits on the other desk: working, waiting_desk, which doesn't keep the desk awake.
        await().atMost(Duration.ofSeconds(10)).until(() -> "waiting_desk".equals(a.agentView(AgentStore.MANAGER)
                .get("statusDetail")));
        await().atMost(Duration.ofSeconds(15)).until(() -> {
            settle();
            return a.thread(AgentStore.MANAGER).stream().anyMatch(m -> "done".equals(m.get("state"))
                    && String.valueOf(m.get("text")).contains("two meetings"));
        });
        // What the model read as the tool's result: the answer, fenced as another desk's untrusted words.
        String result = TeamDesk.toolResults(a.lastRequest()).getLast().content();
        assertThat(result).startsWith("Untrusted content from an agent on another of the member's desks")
                .contains("Two meetings: 10:00 and 15:00.");
        // On B: the message in its lead's thread, from desk A, and its reply.
        List<Map<String, Object>> threadB = b.settled(AgentStore.MANAGER);
        assertThat(threadB).anySatisfy(m -> assertThat(map(m.get("origin"))).containsEntry("kind", "desk")
                .containsEntry("role", "message").containsEntry("deskId", "d-aaaa"));
        // B's run had no desk_message nor message_agent: one hop.
        assertThat(TeamDesk.toolNames(b.lastRequest())).doesNotContain("desk_message", "message_agent", "desk_answer");
        // The answer went once, without a card: B's run read nothing private.
        assertThat(list(b.call("agent.approvals.list", "state", "all").get("approvals"))).isEmpty();
        // A's desk-agent tells deskd the waiting call took the answer, so deskd gives that run it as a To-do source.
        assertThat(deliveries).anySatisfy(d -> assertThat(d).containsEntry("taken", true));
    }

    @Test
    void anAnswerAfterTheWaitComesToTheThreadAndStartsNoRun() throws Exception {
        pair();
        a.service.desks().waitFor(Duration.ofMillis(200));
        CountDownLatch slow = new CountDownLatch(1);
        b.provider.then(Step.answer(USAGE, "Later answer.").heldBy(slow));
        a.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "desk_message", "desk", "d-bbbb", "text", "Hi"))))
                .then(Step.answer(USAGE, "Sent it."));
        Map<String, Object> reply = a.ask(AgentStore.MANAGER, "Message Work.");
        assertThat(reply.get("text")).isEqualTo("Sent it.");
        assertThat(TeamDesk.toolResults(a.lastRequest()).getLast().content()).startsWith("Sent. It reaches Work");
        int requestsBefore = a.requests().size();
        carry(a, deskdA, b, deskdB);
        slow.countDown();
        await().atMost(Duration.ofSeconds(15)).until(() -> {
            settle();
            return a.thread(AgentStore.MANAGER).stream().anyMatch(m -> m.get("origin") != null
                    && "answer".equals(map(m.get("origin")).get("role")));
        });
        Map<String, Object> posted = a.thread(AgentStore.MANAGER).stream().filter(m -> m.get("origin") != null
                && "answer".equals(map(m.get("origin")).get("role"))).findFirst().orElseThrow();
        assertThat(posted.get("text")).isEqualTo("Later answer.");
        assertThat(map(posted.get("origin"))).containsEntry("deskId", "d-bbbb").containsEntry("agentName", "Helper")
                .containsEntry("private", false);
        assertThat(a.requests()).hasSize(requestsBefore);
        // The next run reads it as another desk's words, and holds U from it.
        a.provider.then(Step.answer(USAGE, "Noted."));
        a.ask(AgentStore.MANAGER, "What did Work say?");
        assertThat(TeamDesk.allText(a.lastRequest())).contains("An answer from an agent on another of the member's desks")
                .contains("Later answer.");
        assertThat(a.lastReply(AgentStore.MANAGER)).containsEntry("untrusted", true);
    }

    @Test
    void anAnswerFromARunThatReadPrivateDataAsksTheMemberOnItsDeskFirst() throws Exception {
        pair();
        // B's run reads a Notebook page (S), then answers: the answer is a send, on a card on B.
        b.provider.then(Step.calls(USAGE, List.of(Step.call("n1", "notebook_read", "pageId", "p1"))))
                .then(Step.answer(USAGE, "From your notes: the plan is X."));
        a.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "desk_message", "desk", "Work", "text", "Plan?"))))
                .then(Step.answer(USAGE, "Done."));
        a.call("agent.message.send", "agentId", AgentStore.MANAGER, "text", "Ask Work for the plan.");
        AtomicReference<Map<String, Object>> card = new AtomicReference<>();
        await().atMost(Duration.ofSeconds(15)).until(() -> {
            settle();
            List<Map<String, Object>> cards = list(b.call("agent.approvals.list").get("approvals"));
            card.set(cards.isEmpty() ? null : cards.get(0));
            return card.get() != null;
        });
        assertThat(card.get()).containsEntry("tool", "desk_answer").containsEntry("risk", "send");
        assertThat(map(card.get().get("payload"))).containsEntry("text", "From your notes: the plan is X.");
        assertThat(map(card.get().get("origin"))).containsEntry("kind", "desk");
        // Unattended: a 24-hour card.
        assertThat((long) card.get().get("expiresAt") - (long) card.get().get("createdAt"))
                .isEqualTo(Duration.ofHours(24).toMillis());
        String sha = Approvals.hash((String) card.get().get("agentId"), (String) card.get().get("runId"),
                (String) card.get().get("tool"), (String) card.get().get("context"), map(card.get().get("payload")));
        b.call("agent.approval.decide", "approvalId", card.get().get("id"), "approve", true, "sha256", sha);
        await().atMost(Duration.ofSeconds(15)).until(() -> {
            settle();
            return a.thread(AgentStore.MANAGER).stream().anyMatch(m -> "done".equals(m.get("state"))
                    && "Done.".equals(m.get("text")));
        });
        assertThat(TeamDesk.toolResults(a.lastRequest()).getLast().content()).contains("the plan is X");
        // The answer said private: A's run holds S now too, and its reply is marked so.
        assertThat(deskdA.calls.stream().filter(c -> "run_end".equals(c.get("tool"))).count()).isPositive();
        // B's run named its message to deskd on each call, look and run (To-do's source kind desk); A's runs never do.
        assertThat(deskdB.calls.stream().filter(c -> "notebook_read".equals(c.get("tool"))).toList()).isNotEmpty()
                .allSatisfy(c -> assertThat(map(c.get("origin"))).containsEntry("kind", "desk")
                        .containsKey("envelopeId"));
        assertThat(deskdA.calls).noneSatisfy(c -> assertThat(c).containsKey("origin"));
    }

    @Test
    void aStopOnTheAnsweringDeskRefusesTheVeryNextMessageAndTheSenderIsTold() throws Exception {
        pair();
        Map<String, Object> stopped = b.service.call("agent.desks.revoke", TeamDesk.m("grantId", grantId));
        assertThat(stopped).containsEntry("agentId", AgentStore.MANAGER);
        a.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "desk_message", "desk", "Work", "text", "Still?"))))
                .then(Step.answer(USAGE, "Sent."));
        a.service.desks().waitFor(Duration.ofMillis(100));
        a.ask(AgentStore.MANAGER, "Message Work.");
        settle();
        List<Map<String, Object>> threadA = a.settled(AgentStore.MANAGER);
        assertThat(threadA).anySatisfy(m -> assertThat(m.get("origin")).isNotNull()
                .satisfies(o -> assertThat(map(o)).containsEntry("role", "notice").containsEntry("notice", "refused")
                        .containsEntry("reason", "revoked")));
        // A's half went too: the tool is gone from the next step.
        Map<String, Object> after = map(a.service.call("agent.access.get", TeamDesk.m("agentId", AgentStore.MANAGER))
                .get("access"));
        assertThat(list(after.get("desks"))).isEmpty();
    }

    @Test
    void aRestartOfTheAnsweringDeskMidRunSendsBackAFailureNeverASecondRun() throws Exception {
        pair();
        CountDownLatch never = new CountDownLatch(1);
        b.provider.then(Step.answer(USAGE, "never").heldBy(never));
        a.service.desks().waitFor(Duration.ofMillis(100));
        a.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "desk_message", "desk", "Work", "text", "Hi"))))
                .then(Step.answer(USAGE, "Sent."));
        a.ask(AgentStore.MANAGER, "Message Work.");
        carry(a, deskdA, b, deskdB);
        await().atMost(Duration.ofSeconds(10)).until(() -> b.provider.requests().size() >= 1);
        // desk-agent B is killed mid-run, and starts again on the same files.
        b.kill();
        never.countDown();
        b = open("b", deskdB);
        b.service.desks().restore();
        await().atMost(Duration.ofSeconds(15)).until(() -> {
            settle();
            return a.thread(AgentStore.MANAGER).stream().anyMatch(m -> m.get("origin") != null
                    && "failed".equals(map(m.get("origin")).get("notice")));
        });
        Map<String, Object> notice = a.thread(AgentStore.MANAGER).stream().filter(m -> m.get("origin") != null
                && "failed".equals(map(m.get("origin")).get("notice"))).findFirst().orElseThrow();
        assertThat(map(notice.get("origin"))).containsEntry("reason", "interrupted");
        // The message is never answered by a second run: one request to B's model in all.
        assertThat(b.provider.requests()).isEmpty();
    }

    /**
     * The sending desk's desk-agent killed while its {@code desk_message} waits for the answer (release 2's proof: the
     * resend was refused {@code key_mismatch}, so the wait was never taken and the answer went to the thread while the
     * reply said none came). The resumed run asks deskd again by the call's key, binding what the first sending bound,
     * gets the same envelope, takes its kept wait, and reads the answer as the tool's result: one message, one
     * answering run, nothing posted to the thread.
     */
    @Test
    void aKillOfTheSendingDeskWhileItsMessageWaitsKeepsTheWaitAndTakesTheAnswer() throws Exception {
        deskdA.keyed = true;
        pair();
        b.provider.then(Step.answer(USAGE, "Two meetings: 10:00 and 15:00."));
        // A's run reads a private page first (S), so its message is a send on a card, which binds the call's context.
        a.provider.then(Step.calls(USAGE, List.of(Step.call("n1", "notebook_read", "pageId", "p1"))))
                .then(Step.calls(USAGE, List.of(Step.call("c1", "desk_message", "desk", "Work", "text",
                        "What's on today?"))));
        a.call("agent.message.send", "agentId", AgentStore.MANAGER, "text", "Ask Work what's on.");
        AtomicReference<Map<String, Object>> card = new AtomicReference<>();
        await().atMost(Duration.ofSeconds(15)).until(() -> {
            List<Map<String, Object>> cards = list(a.call("agent.approvals.list").get("approvals"));
            card.set(cards.isEmpty() ? null : cards.get(0));
            return card.get() != null;
        });
        assertThat(card.get()).containsEntry("tool", "desk_message").containsEntry("risk", "send");
        String sha = Approvals.hash((String) card.get().get("agentId"), (String) card.get().get("runId"),
                (String) card.get().get("tool"), (String) card.get().get("context"), map(card.get().get("payload")));
        a.call("agent.approval.decide", "approvalId", card.get().get("id"), "approve", true, "sha256", sha);
        // deskd ran it and the run waits on the other desk; nothing has been carried yet.
        await().atMost(Duration.ofSeconds(10)).until(() -> "waiting_desk".equals(a.agentView(AgentStore.MANAGER)
                .get("statusDetail")));
        assertThat(deskdA.madeBy).containsExactly("desk_message");

        // Killed (docker kill, a crash), and started again on the same files with the model's next step.
        TeamDesk dead = a;
        dead.kill();
        a = open("a", deskdA);
        a.provider.then(Step.answer(USAGE, "Work has two meetings."));
        a.resume();
        await().atMost(Duration.ofSeconds(15)).until(() -> {
            settle();
            return a.thread(AgentStore.MANAGER).stream().anyMatch(m -> "done".equals(m.get("state"))
                    && "Work has two meetings.".equals(m.get("text")));
        });
        // The resend bound what the first sending bound: deskd answered it from what it kept, never key_mismatch.
        assertThat(deskdA.mismatched).isEmpty();
        assertThat(deskdA.calls.stream().filter(c -> "desk_message".equals(c.get("tool")) && c.get("phase") == null
                && Boolean.TRUE.equals(c.get("retry"))).count()).isEqualTo(1);
        assertThat(deskdA.madeBy).containsExactly("desk_message");
        // The kept wait took the answer: it is the tool's result, fenced, and the thread got no copy of it.
        String result = TeamDesk.toolResults(a.lastRequest()).getLast().content();
        assertThat(result).contains("Two meetings: 10:00 and 15:00.").doesNotStartWith("Interrupted")
                .doesNotContain("key_mismatch");
        assertThat(a.thread(AgentStore.MANAGER)).noneMatch(m -> m.get("origin") != null
                && "answer".equals(map(m.get("origin")).get("role")));
        Map<String, Object> reply = a.lastReply(AgentStore.MANAGER);
        assertThat(reply).containsEntry("resumed", 1);
        // One message, one answering run on B.
        assertThat(b.provider.requests()).hasSize(1);
        assertThat(deliveries.stream().filter(d -> Boolean.TRUE.equals(d.get("taken"))).count()).isEqualTo(1);
        // One envelope, so one desks.sent in A's audit and one use of the grant, though the resumed call came back with
        // the same envelope (release 3's proof: Activity showed desks.sent twice).
        assertThat(a.audit.readBefore(null, 1000).stream().filter(r -> r.entry().action().equals("desks.sent")))
                .singleElement().satisfies(r -> assertThat(r.entry().target()).contains("grant:" + grantId));
        Map<String, Object> half = list(map(a.call("agent.access.get", "agentId", AgentStore.MANAGER).get("access"))
                .get("desks")).get(0);
        assertThat(half).containsEntry("count", 1);
    }

    @Test
    void aMessageNotTakenInSevenDaysIsNotDeliveredAndTheThreadSaysSo() throws Exception {
        pair();
        a.service.desks().waitFor(Duration.ofMillis(50));
        a.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "desk_message", "desk", "Work", "text", "Hi"))))
                .then(Step.answer(USAGE, "Sent."));
        a.ask(AgentStore.MANAGER, "Message Work.");
        clock.advance(Duration.ofDays(7).plusMinutes(1));
        // The office comes back after a week: nothing to take, and X's thread says it wasn't delivered.
        assertThat(carry(a, deskdA, b, deskdB)).isZero();
        assertThat(a.settled(AgentStore.MANAGER)).anySatisfy(m -> assertThat(m.get("origin")).isNotNull()
                .satisfies(o -> assertThat(map(o)).containsEntry("notice", "not_delivered")));
    }

    @Test
    void anAgentWithNoActiveGrantHasNoDeskMessageAndANamedDeskItHasNoneToIsRefused() throws Exception {
        a.provider.then(Step.answer(USAGE, "Hi."));
        a.ask(AgentStore.MANAGER, "Hello");
        assertThat(TeamDesk.toolNames(a.lastRequest())).doesNotContain("desk_message", "desk_answer");
        pair();
        a.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "desk_message", "desk", "Home", "text", "Hi"))))
                .then(Step.answer(USAGE, "Couldn't."));
        a.ask(AgentStore.MANAGER, "Message Home.");
        assertThat(TeamDesk.toolNames(a.lastRequest())).contains("desk_message").doesNotContain("desk_answer");
        assertThat(TeamDesk.toolResults(a.lastRequest()).getLast().content()).contains("no_grant");
    }
}
