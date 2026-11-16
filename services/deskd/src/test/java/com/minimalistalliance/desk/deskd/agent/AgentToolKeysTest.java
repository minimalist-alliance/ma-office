package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.tools.HostedCall;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
import com.minimalistalliance.desk.deskd.tools.HostedTool;
import com.minimalistalliance.desk.deskd.tools.RunLedger;
import com.minimalistalliance.desk.deskd.tools.ToolHost;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * A call's key over the real agent socket (durable runs' seam; API.md §18, "Keys"): desk-agent's {@code tcall} with a
 * {@code key}, through the real {@link AgentLink} and {@link ToolHost}, to an area that counts what it runs. The same key
 * runs once, a repeat waits for the first, a key past its 10 minutes is refused and never runs, a link dropped mid-call
 * gives the real result to the call asked again, and a deskd that never held the key (a restart) refuses it.
 */
@SuppressWarnings("unchecked")
class AgentToolKeysTest {

    private static final String AGENT = "manager";
    private static final String RUN = "run-keys-1";
    private static final SecureRandom RANDOM = new SecureRandom();

    @TempDir
    Path dir;

    private AgentRig rig;
    private ToolHost host;
    private final AtomicInteger writes = new AtomicInteger();
    private final AtomicInteger lists = new AtomicInteger();
    private volatile CountDownLatch hold;
    private final CountDownLatch entered = new CountDownLatch(1);
    private long nextId = 100;

    @BeforeEach
    void start() throws Exception {
        rig = new AgentRig(dir);
        host = host();
        rig.module.hostTools(host);
        rig.agent.drop();
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.agent.connections() >= 2 && rig.module.link().isConnected());
        Map<String, Object> hello;
        do {
            hello = rig.agent.next("req");
        } while (!ToolHost.HELLO.equals(hello.get("m")));
        // deskd says it keeps calls' replies by their key, so desk-agent may ask again after a lost link.
        assertThat(((Map<String, Object>) hello.get("p")).get("keys")).isEqualTo(Map.of("ttlSec", 600));
    }

    @AfterEach
    void stop() throws Exception {
        CountDownLatch h = hold;
        if (h != null) {
            h.countDown();
        }
        host.close();
        rig.close();
    }

    /** A ToolHost as deskd wires it, with every approval redeemed and a Files area that counts its runs. */
    private ToolHost host() {
        ToolHost h = new ToolHost(rig.clock, ToolHost.ownerOnly(), () -> false, () -> true);
        h.tickets((approvalId, sha256, agentId, runId, tool, context, args) -> null);
        h.area(HostedDecls.FILES, new HostedTool() {
            @Override
            public Look look(HostedCall call, RunLedger.Run run) {
                return Look.plain(call.args(), Map.of("kind", "file", "path", String.valueOf(call.args().get("path"))));
            }

            @Override
            public Result run(HostedCall call, RunLedger.Run run) throws InterruptedException {
                if (call.tool().equals("files_list")) {
                    return Result.of(Map.of("entries", List.of(), "n", lists.incrementAndGet()));
                }
                entered.countDown();
                CountDownLatch h = hold;
                if (h != null) {
                    h.await(20, TimeUnit.SECONDS);
                }
                return Result.of("Saved, time " + writes.incrementAndGet() + ".");
            }
        });
        return h;
    }

    /** A UUIDv7 as desk-agent makes it, from this time. */
    private static String key(long ms) {
        return String.format("%08x-%04x-7%03x-%x%03x-%012x", ms >>> 16, ms & 0xffff, RANDOM.nextInt(0x1000),
                8 + RANDOM.nextInt(4), RANDOM.nextInt(0x1000), RANDOM.nextLong() & 0xffffffffffffL);
    }

    private Map<String, Object> write(String key, boolean retry, String text) {
        Map<String, Object> args = Map.of("path", "notes.md", "text", text);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "tcall");
        m.put("id", nextId++);
        m.put("runId", RUN);
        m.put("agentId", AGENT);
        m.put("tool", "files_write");
        m.put("args", args);
        m.put("taint", List.of());
        m.put("approval", Map.of("approvalId", "ap-aaaaaaaaaaaaaaaaaaaa", "sha256",
                ToolHost.hash(AGENT, RUN, "files_write", "agent", args)));
        m.put("context", "agent");
        m.put("key", key);
        if (retry) {
            m.put("retry", true);
        }
        return m;
    }

    private Map<String, Object> answer(Map<String, Object> call) throws InterruptedException {
        rig.agent.sendJson(call);
        while (true) {
            Map<String, Object> m = rig.agent.received.poll(10, TimeUnit.SECONDS);
            assertThat(m).as("an answer to %s", call.get("id")).isNotNull();
            if (("tres".equals(m.get("t")) || "terr".equals(m.get("t"))) && m.get("id") instanceof Number n
                    && n.longValue() == ((Number) call.get("id")).longValue()) {
                return m;
            }
        }
    }

    private static Map<String, Object> r(Map<String, Object> reply) {
        assertThat(reply.get("t")).as("%s", reply).isEqualTo("tres");
        return (Map<String, Object>) reply.get("r");
    }

    private static void refused(Map<String, Object> reply, String code, String reason) {
        assertThat(reply.get("t")).isEqualTo("terr");
        assertThat(reply.get("code")).isEqualTo(code);
        assertThat((Map<String, Object>) reply.get("details")).containsEntry("reason", reason);
    }

    // ---------------------------------------------------------------- tests

    @Test
    void aRepeatedKeyRunsOnceAndEveryRepeatGetsTheFirstReply() throws Exception {
        String key = key(rig.clock.millis());
        Map<String, Object> first = r(answer(write(key, false, "hello")));
        assertThat(first.get("content")).isEqualTo("Saved, time 1.");
        // Again with the same key, asked again (retry) or not: the stored reply, with this call's own id.
        Map<String, Object> again = answer(write(key, true, "hello"));
        assertThat(r(again)).isEqualTo(first);
        assertThat(r(answer(write(key, false, "hello")))).isEqualTo(first);
        assertThat(writes.get()).isEqualTo(1);
        // Another key is another call.
        assertThat(r(answer(write(key(rig.clock.millis()), false, "hello"))).get("content")).isEqualTo("Saved, time 2.");
        // The same key for another call is refused, never given the first's reply, and runs nothing.
        refused(answer(write(key, false, "something else")), "bad_request", "key_mismatch");
        assertThat(writes.get()).isEqualTo(2);
    }

    @Test
    void aRepeatWhileTheFirstStillRunsWaitsForItAndRunsNothing() throws Exception {
        hold = new CountDownLatch(1);
        String key = key(rig.clock.millis());
        Map<String, Object> first = write(key, false, "hello");
        Map<String, Object> second = write(key, true, "hello");
        rig.agent.sendJson(first);
        assertThat(entered.await(10, TimeUnit.SECONDS)).isTrue();
        rig.agent.sendJson(second);
        hold.countDown();
        Map<Long, Map<String, Object>> byId = new java.util.HashMap<>();
        while (byId.size() < 2) {
            Map<String, Object> m = rig.agent.next("tres");
            byId.put(((Number) m.get("id")).longValue(), m);
        }
        assertThat(r(byId.get((Long) second.get("id")))).isEqualTo(r(byId.get((Long) first.get("id"))));
        assertThat(writes.get()).isEqualTo(1);
    }

    @Test
    void anExpiredKeyIsRefusedAndNeverRuns() throws Exception {
        // A first call whose key was made more than 10 minutes ago: stale, refused before anything runs.
        String stale = key(rig.clock.millis() - Duration.ofMinutes(10).plusSeconds(1).toMillis());
        refused(answer(write(stale, false, "hello")), "conflict", "key_expired");
        assertThat(writes.get()).isZero();

        // A call that ran, and its reply kept 10 minutes: past them, asking again by its key is refused, not run.
        String key = key(rig.clock.millis());
        r(answer(write(key, false, "hello")));
        rig.clock.advance(Duration.ofMinutes(9));
        assertThat(r(answer(write(key, true, "hello"))).get("content")).isEqualTo("Saved, time 1.");
        rig.clock.advance(Duration.ofMinutes(1).plusSeconds(1));
        refused(answer(write(key, true, "hello")), "conflict", "key_unknown");
        // Nor as a first call: its key is past its time too.
        refused(answer(write(key, false, "hello")), "conflict", "key_expired");
        assertThat(writes.get()).isEqualTo(1);
    }

    @Test
    void aLinkDroppedMidCallGivesTheRealResultToTheCallAskedAgain() throws Exception {
        hold = new CountDownLatch(1);
        String key = key(rig.clock.millis());
        rig.agent.sendJson(write(key, false, "hello"));
        assertThat(entered.await(10, TimeUnit.SECONDS)).isTrue();
        // The link goes while the call runs: its reply has nowhere to go.
        rig.agent.drop();
        hold.countDown();
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.agent.connections() >= 3 && rig.module.link().isConnected());
        await().atMost(Duration.ofSeconds(10)).until(() -> writes.get() == 1);
        // desk-agent asks again on the new link, by the same key: deskd's reply, and nothing run twice.
        Map<String, Object> again = r(answer(write(key, true, "hello")));
        assertThat(again.get("content")).isEqualTo("Saved, time 1.");
        assertThat(writes.get()).isEqualTo(1);
    }

    @Test
    void aDeskdThatNeverHeldTheKeyRefusesItAskedAgainAndRunsNothing() throws Exception {
        String key = key(rig.clock.millis());
        r(answer(write(key, false, "hello")));
        // deskd restarts: its replies by key were in RAM, and are gone.
        host.close();
        host = host();
        rig.module.hostTools(host);
        refused(answer(write(key, true, "hello")), "conflict", "key_unknown");
        assertThat(writes.get()).isEqualTo(1);
        // A retry needs its key.
        Map<String, Object> keyless = write(key, true, "hello");
        keyless.remove("key");
        refused(answer(keyless), "bad_request", "key");
        assertThat(writes.get()).isEqualTo(1);
    }

    @Test
    void aReadIsntKeptSoTheSameKeyReadsAgain() throws Exception {
        String key = key(rig.clock.millis());
        Map<String, Object> list = write(key, false, "x");
        list.put("tool", "files_list");
        list.put("args", Map.of("path", ""));
        list.remove("approval");
        list.remove("context");
        assertThat(r(answer(list)).get("content")).isEqualTo(Map.of("entries", List.of(), "n", 1));
        list.put("id", nextId++);
        assertThat(r(answer(list)).get("content")).isEqualTo(Map.of("entries", List.of(), "n", 2));
        // A malformed key is refused before anything runs.
        list.put("id", nextId++);
        list.put("key", "not-a-key");
        refused(answer(list), "bad_request", "key");
        assertThat(lists.get()).isEqualTo(2);
    }
}
