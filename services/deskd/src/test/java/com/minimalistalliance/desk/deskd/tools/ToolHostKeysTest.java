package com.minimalistalliance.desk.deskd.tools;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.testing.MutableClock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/**
 * {@link ToolHost}'s keys on their own (durable runs' seam; API.md §18, "Keys"): what a key binds, which replies are
 * kept, and that a look and a run's end ignore one. {@code agent/AgentToolKeysTest} runs them over the real socket.
 */
@SuppressWarnings("unchecked")
class ToolHostKeysTest {

    private static final String KEY_TIME = "2026-11-13T20:00:00Z";
    private final MutableClock clock = new MutableClock(Instant.parse(KEY_TIME));
    private final AtomicInteger runs = new AtomicInteger();
    private volatile ToolRisk raise;
    private final ToolHost host = new ToolHost(clock, ToolHost.ownerOnly(), () -> false, () -> true);

    {
        host.tickets((approvalId, sha256, agentId, runId, tool, context, args) -> null);
        host.area(HostedDecls.FILES, new HostedTool() {
            @Override
            public Look look(HostedCall call, RunLedger.Run run) {
                Look plain = Look.plain(call.args(), Map.of());
                return raise == null ? plain : plain.withRisk(raise);
            }

            @Override
            public Result run(HostedCall call, RunLedger.Run run) {
                return Result.of("ran " + runs.incrementAndGet());
            }
        });
    }

    private String key() {
        long ms = clock.millis();
        return String.format("%08x-%04x-7abc-9def-0123456789ab", ms >>> 16, ms & 0xffff);
    }

    private static Map<String, Object> call(long id, String tool, Map<String, Object> args, String key) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "tcall");
        m.put("id", id);
        m.put("runId", "run-1");
        m.put("agentId", "manager");
        m.put("tool", tool);
        m.put("args", args);
        m.put("taint", List.of());
        m.put("key", key);
        return m;
    }

    private static Map<String, Object> approved(Map<String, Object> m) {
        m.put("approval", Map.of("approvalId", "ap-aaaaaaaaaaaaaaaaaaaa", "sha256", ToolHost.hash("manager", "run-1",
                (String) m.get("tool"), "agent", (Map<String, Object>) m.get("args"))));
        m.put("context", "agent");
        return m;
    }

    @Test
    void theHelloSaysKeysAreKeptTenMinutes() {
        assertThat(host.hello()).containsEntry("keys", Map.of("ttlSec", 600L));
    }

    @Test
    void aReadWhoseClassRoseToOneThatAsksIsKeptAndAPlainReadIsNot() {
        String key = key();
        Map<String, Object> read = call(1, "files_read", Map.of("path", "a.txt"), key);
        host.keyed(read);
        host.keyed(read);
        assertThat(runs.get()).as("a plain read runs again").isEqualTo(2);

        raise = ToolRisk.WRITE;
        String other = key().substring(0, 24) + "000000000002";
        Map<String, Object> risen = approved(call(2, "files_read", Map.of("path", "b.txt"), other));
        Map<String, Object> first = host.keyed(risen);
        assertThat(first.get("t")).as("%s", first).isEqualTo("tres");
        risen.put("id", 3L);
        Map<String, Object> second = host.keyed(risen);
        assertThat(second.get("id")).isEqualTo(3L);
        assertThat(second.get("r")).isEqualTo(first.get("r"));
        assertThat(runs.get()).as("risen to a write, it's kept").isEqualTo(3);
    }

    @Test
    void aLookAndARunsEndIgnoreTheKey() {
        Map<String, Object> look = call(1, "files_write", Map.of("path", "a.txt", "text", "x"), "not a key");
        look.put("phase", "look");
        assertThat(host.keyed(look).get("t")).isEqualTo("tres");
        Map<String, Object> end = call(2, HostedDecls.RUN_END, Map.of(), "not a key");
        assertThat(host.keyed(end).get("t")).isEqualTo("tres");
        assertThat(runs.get()).isZero();
    }

    @Test
    void theKeyBindsTheCallAndAFractionInTheArgumentsStillHasAFingerprint() {
        Map<String, Object> a = call(1, "files_write", Map.of("path", "a.txt", "text", "x"), key());
        Map<String, Object> b = new LinkedHashMap<>(a);
        b.put("args", Map.of("path", "a.txt", "text", "y"));
        Map<String, Object> c = new LinkedHashMap<>(a);
        c.put("runId", "run-2");
        Map<String, Object> d = new LinkedHashMap<>(a);
        d.put("id", 99L);
        d.put("taint", List.of("U"));
        assertThat(ToolHost.fingerprint(a)).isNotEqualTo(ToolHost.fingerprint(b)).isNotEqualTo(ToolHost.fingerprint(c))
                .isEqualTo(ToolHost.fingerprint(d));
        Map<String, Object> fraction = call(1, "files_read", Map.of("path", "a.txt", "offset", 1.5), key());
        assertThat(ToolHost.fingerprint(fraction)).matches("[0-9a-f]{64}");
    }
}
