package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * What the relay does when desk-agent stops reading, and when a caller is interrupted while its call is going out: a
 * stalled desk-agent costs only its own calls, and a cancel never touches the connection the other sessions share.
 */
class AgentLinkFailureTest {

    /** Longer than a Unix socket's buffer, so a write of it waits on a peer that isn't reading. */
    private static final String PAD = "x".repeat(900_000);
    /** A stall that lasts while a test looks. */
    private static final AgentLink.Timing STAYS_STALLED = new AgentLink.Timing(Duration.ofMillis(20), Duration.ofMillis(100), Duration.ofSeconds(60));
    /** Long enough that nothing gives up on its own while a test looks. */
    private static final AgentMethods.Waits PATIENT = new AgentMethods.Waits(Duration.ofSeconds(60), Duration.ofSeconds(60));

    @TempDir
    Path dir;

    private AgentRig rig;

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            if (rig.agent != null) {
                rig.agent.resume();
            }
            rig.close();
        }
    }

    private AgentRig rig(AgentLink.Timing timing) throws Exception {
        rig = new AgentRig(dir, true, timing, PATIENT);
        // Stands in for the Browser's methods, which share the session's 32 slots with everything else it calls.
        rig.dispatcher.register("browser.tab.list", (context, params) -> Map.of("tabs", List.of()));
        return rig;
    }

    /** The defect: a write blocked holding the link's lock, and every call after it waited on that lock, uninterruptibly. */
    @Test
    void aDeskAgentThatStopsReadingLeavesTheSessionsOtherCallsPrompt() throws Exception {
        AgentRig r = rig(STAYS_STALLED);
        TestClient client = r.connect("a");
        r.agent.stall();
        r.send(client, "agent.thread.get", Map.of("agentId", "manager", "pad", PAD), null);
        for (int i = 0; i < 39; i++) {
            r.send(client, "agent.list", Map.of(), null);
        }

        // At most half the session's slots wait on desk-agent, so the rest are refused at once.
        for (int i = 0; i < 40 - AgentLink.MAX_SESSION_CALLS; i++) {
            assertThat(client.nextReply()).containsEntry("_kind", "ERR").extracting("code").isIn("unavailable", "rate_limited");
        }
        long started = System.nanoTime();
        for (int i = 0; i < 40; i++) {
            assertThat(client.call("browser.tab.list", Map.of())).containsEntry("_kind", "RES");
        }
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(5));
        assertThat(r.sessions.isLive("a")).isTrue();
    }

    /**
     * SIGTERM's path, with a mutation's write stuck on a desk-agent that isn't reading. Past {@code beginEffect} nothing
     * interrupts a call, so only a close that waits on nothing gets out.
     */
    @Test
    void stoppingNeverWaitsOnADeskAgentThatStoppedReading() throws Exception {
        AgentRig r = rig(STAYS_STALLED);
        TestClient client = r.connect("a");
        r.agent.stall();
        r.send(client, "agent.update", Map.of("agentId", "manager", "name", "M", "pad", PAD), UUID.randomUUID().toString());
        for (int i = 0; i < 10; i++) {
            r.send(client, "agent.list", Map.of(), null);
        }
        await().until(() -> r.module.link().writingForTest());

        long started = System.nanoTime();
        Thread stopping = Thread.ofVirtual().start(() -> {
            r.sessions.stop(false);
            r.module.close();
        });
        stopping.join(Duration.ofSeconds(5));

        assertThat(stopping.isAlive()).as("still stopping after 5 s").isFalse();
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(2));
    }

    /**
     * The other defect: an interrupt on a thread inside a SocketChannel call closes the channel, and every session's
     * calls on it with it. Here a cancel lands while its call's long request is going out to a desk-agent that has paused.
     */
    @Test
    void aCancelWhileItsCallIsGoingOutLeavesTheConnectionToEveryoneElse() throws Exception {
        AgentRig r = rig(STAYS_STALLED);
        r.agent.handlers.put("agent.list", p -> Map.of("agents", List.of()));
        TestClient a = r.connect("a");
        TestClient b = r.connect("b");
        long waiting = r.send(b, "agent.thread.get", Map.of("agentId", "manager"), null);
        long relayed = ((Number) r.agent.requests.poll(5, TimeUnit.SECONDS).get("id")).longValue();
        r.agent.stall();

        long id = r.send(a, "agent.thread.get", Map.of("agentId", "manager", "pad", PAD), null);
        await().until(() -> r.module.link().writingForTest());
        a.send(Channels.RPC, FrameKind.CANCEL, id, 0, new byte[0]);
        assertThat(a.nextReply()).containsEntry("_id", id).containsEntry("code", "cancelled");
        Thread.sleep(100);
        r.agent.resume();

        // b's call was already with desk-agent, on the same connection: its answer still comes.
        r.agent.reply(relayed, Map.of("agentId", "manager", "messages", List.of(), "seq", 1));
        assertThat(b.nextReply()).containsEntry("_id", waiting).containsEntry("_kind", "RES");
        assertThat(r.call(b, "agent.list", Map.of())).containsEntry("_kind", "RES");
        assertThat(r.call(a, "agent.list", Map.of())).containsEntry("_kind", "RES");
        assertThat(r.agent.connections()).isEqualTo(1);
        assertThat(((Number) r.agent.next("cancel").get("id")).longValue()).isGreaterThan(relayed);
    }

    /** A write that makes no progress for {@code writeStall} fails what's waiting, and the link comes back. */
    @Test
    void aWriteThatMakesNoProgressDropsTheLinkAndItComesBack() throws Exception {
        AgentRig r = rig(new AgentLink.Timing(Duration.ofMillis(20), Duration.ofMillis(100), Duration.ofMillis(500)));
        r.agent.handlers.put("agent.list", p -> Map.of("agents", List.of()));
        TestClient client = r.connect("a");
        r.agent.stall();

        long started = System.nanoTime();
        long stuck = r.send(client, "agent.update", Map.of("agentId", "manager", "pad", PAD), UUID.randomUUID().toString());
        await().until(() -> r.module.link().writingForTest());
        long behind = r.send(client, "agent.update", Map.of("agentId", "manager", "name", "M"), UUID.randomUUID().toString());
        long read = r.send(client, "agent.list", Map.of(), null);
        Map<Long, Map<String, Object>> replies = new java.util.HashMap<>();
        for (int i = 0; i < 3; i++) {
            Map<String, Object> reply = client.nextReply();
            replies.put((Long) reply.get("_id"), reply);
        }

        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(8));
        // Its bytes had begun to go, so it may have applied. The ones behind it never went.
        assertThat(replies.get(stuck)).containsEntry("code", "unavailable");
        assertThat(replies.get(stuck).get("details")).isEqualTo(Map.of("reason", "unavailable", "mayHaveApplied", true));
        assertThat(replies.get(behind)).containsEntry("code", "unavailable");
        assertThat(replies.get(behind).get("details")).isEqualTo(Map.of("reason", "unavailable"));
        assertThat(replies.get(read)).containsEntry("code", "unavailable");

        r.agent.resume();
        await().until(() -> r.agent.connections() == 2 && r.module.link().isConnected());
        assertThat(r.call(client, "agent.list", Map.of())).containsEntry("_kind", "RES");
        assertThat(r.agent.received).noneMatch(m -> "req".equals(m.get("t")) && "M".equals(((Map<?, ?>) m.get("p")).get("name")));
    }
}
