package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.courier.store.AgentView;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.courier.store.Invariants;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import com.minimalistalliance.desk.deskd.tools.CourierTools;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
import com.minimalistalliance.desk.deskd.tools.ToolHost;
import com.minimalistalliance.desk.deskd.tools.ToolHostCalls;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * §17's Courier row through the agent's tools, on a store of {@code -Dcourier.tools.perf.messages} messages (2,000 in a
 * normal build; the bar's run is 50,000, with {@code -Dcourier.tools.perf=true} to hold the times to the bar): the four
 * tools through deskd's real {@link ToolHost} and {@link CourierTools}, each result fitted, as desk-agent calls them.
 * {@code courier_new} with 100 or more waiting, 100 new messages delivered (as many calls as that takes), a search, a
 * list and a read, each timed; and the whole store drained through {@code courier_new} in runs that end {@code done},
 * every message an agent may see given exactly once. The report goes to {@code target/courier-tools-perf.json}.
 */
@SuppressWarnings("unchecked")
class CourierToolsPerfTest {

    private static final boolean BAR = Boolean.getBoolean("courier.tools.perf");
    private static final int MESSAGES = Integer.getInteger("courier.tools.perf.messages", BAR ? 50_000 : 2_000);

    private long nextId = 1;
    private int nextKey = 1;
    private MutableClock clock;

    private Map<String, Object> call(ToolHost host, String run, String agent, String tool, Map<String, Object> args) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "tcall");
        m.put("id", nextId++);
        m.put("runId", run);
        m.put("agentId", agent);
        m.put("tool", tool);
        m.put("args", args);
        m.put("taint", List.of());
        if (tool.equals("courier_new")) {
            long ms = clock.millis();
            m.put("key", String.format("%08x-%04x-7abc-9def-%012x", ms >>> 16, ms & 0xffff, nextKey++));
        }
        Map<String, Object> reply = ToolHostCalls.keyed(host, m);
        assertThat(reply.get("t")).as("%s %s", tool, reply).isEqualTo("tres");
        return (Map<String, Object>) ((Map<String, Object>) reply.get("r")).get("content");
    }

    private void end(ToolHost host, String run, String agent, Object cursor) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "tcall");
        m.put("id", nextId++);
        m.put("runId", run);
        m.put("agentId", agent);
        m.put("tool", "run_end");
        m.put("args", Map.of("state", "done", "courier", cursor));
        ToolHostCalls.keyed(host, m);
    }

    @Test
    void theToolsOnALargeStore(@TempDir Path dir) throws Exception {
        clock = new MutableClock(Instant.parse("2026-11-12T12:00:00Z"));
        Random rnd = new Random(2026);
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("messages", MESSAGES);
        try (CourierStore store = CourierStore.open(dir.resolve("courier"), TestMime.PARSER, clock, CourierStore.Settings.DEFAULT)) {
            store.putAccount(new Courier.Account("gmail", "imap", "Gmail", "me@gmail.example", "ok"),
                    List.<String[]>of(new String[] {"email", "me@gmail.example"}));
            store.putAccount(new Courier.Account("desk", "desk", "Desk", "me@desk.example", "ok"),
                    List.<String[]>of(new String[] {"email", "me@desk.example"}));
            long t0 = System.nanoTime();
            for (int at = 0; at < MESSAGES; at += 100) {
                List<Courier.Inbound> batch = new ArrayList<>(100);
                for (int i = at; i < Math.min(MESSAGES, at + 100); i++) {
                    batch.add(CourierPerfTest.message(rnd, i));
                }
                store.accept(batch, new Courier.CursorUpdate("gmail", "INBOX", Integer.toString(at)));
                clock.advance(Duration.ofMillis(5));
            }
            report.put("insertSeconds", Math.round((System.nanoTime() - t0) / 1e8) / 10.0);
            assertThat(Invariants.messages(store)).isEqualTo(MESSAGES);
            AgentView view = new AgentView(store, () -> true, () -> true);
            ToolHost host = new ToolHost(clock, ToolHost.ownerOnly(), () -> false, () -> true);
            host.area(HostedDecls.COURIER, new CourierTools(() -> view, () -> ZoneId.of("America/Denver"), clock));

            // Every message an agent may see from courier_new, in its order: (receivedAt, id).
            List<Object[]> eligible = Invariants.read(store, c -> {
                List<Object[]> out = new ArrayList<>();
                try (var ps = c.prepareStatement("""
                        SELECT received_at, id FROM messages WHERE direction = 'in' AND bulk = 0 AND lane IN ('people', 'other')
                          AND origin <> 'backfill'
                        ORDER BY received_at, id"""); var r = ps.executeQuery()) {
                    while (r.next()) {
                        out.add(new Object[] {r.getLong(1), r.getString(2)});
                    }
                }
                return out;
            });
            report.put("eligible", eligible.size());

            // ---- courier_new, one call with 100 or more waiting: a new agent each time, its cursor at a random place.
            int trials = 100;
            long[] oneCall = new long[trials];
            long[] perCall = new long[trials];
            for (int i = 0; i < trials; i++) {
                Object[] at = eligible.get(rnd.nextInt(Math.max(1, eligible.size() - 150)));
                String agent = "ag-perf" + i;
                view.saveCursor(agent, new CourierRead.Cursor((Long) at[0], (String) at[1]));
                long s = System.nanoTime();
                Map<String, Object> got = call(host, "run-one-" + i, agent, "courier_new", Map.of());
                oneCall[i] = (System.nanoTime() - s) / 1000;
                perCall[i] = ((List<?>) got.get("messages")).size();
            }
            report.put("courierNewOneCallMs", CourierPerfTest.statsUs(oneCall));
            report.put("courierNewMessagesPerCall", stats(perCall));

            // ---- 100 new messages delivered, as many calls as that takes.
            long[] hundred = new long[30];
            long[] callsFor100 = new long[30];
            for (int i = 0; i < hundred.length; i++) {
                Object[] at = eligible.get(rnd.nextInt(Math.max(1, eligible.size() - 150)));
                String agent = "ag-perf-h" + i;
                view.saveCursor(agent, new CourierRead.Cursor((Long) at[0], (String) at[1]));
                int got = 0;
                int calls = 0;
                long s = System.nanoTime();
                while (got < 100) {
                    Map<String, Object> page = call(host, "run-h-" + i, agent, "courier_new", Map.of());
                    got += ((List<?>) page.get("messages")).size();
                    calls++;
                    if (!Boolean.TRUE.equals(page.get("more"))) {
                        break;
                    }
                }
                hundred[i] = (System.nanoTime() - s) / 1000;
                callsFor100[i] = calls;
            }
            report.put("courierNew100MessagesMs", CourierPerfTest.statsUs(hundred));
            report.put("courierNewCallsFor100", stats(callsFor100));

            // ---- search, list, read.
            long[] search = new long[100];
            for (int i = 0; i < search.length; i++) {
                String q = CourierPerfTest.VOCAB[rnd.nextInt(500)];
                long s = System.nanoTime();
                call(host, "run-s", "ag-perf-s", "courier_search", Map.of("q", q));
                search[i] = (System.nanoTime() - s) / 1000;
            }
            report.put("courierSearchMs", CourierPerfTest.statsUs(search));
            long[] list = new long[50];
            for (int i = 0; i < list.length; i++) {
                long s = System.nanoTime();
                call(host, "run-l", "ag-perf-l", "courier_list", i % 2 == 0 ? Map.of() : Map.of("unread", true));
                list[i] = (System.nanoTime() - s) / 1000;
            }
            report.put("courierListMs", CourierPerfTest.statsUs(list));
            long[] read = new long[100];
            for (int i = 0; i < read.length; i++) {
                String id = (String) eligible.get(rnd.nextInt(eligible.size()))[1];
                long s = System.nanoTime();
                call(host, "run-r", "ag-perf-r", "courier_read", Map.of("messageId", id));
                read[i] = (System.nanoTime() - s) / 1000;
            }
            report.put("courierReadMs", CourierPerfTest.statsUs(read));

            // ---- the whole store, drained through courier_new in runs that end done: each message once, none missed.
            String agent = "ag-perf-drain";
            view.saveCursor(agent, new CourierRead.Cursor(Long.MIN_VALUE + 1, ""));
            List<String> given = new ArrayList<>();
            Set<String> seen = new HashSet<>();
            int run = 0;
            int calls = 0;
            long drain = System.nanoTime();
            boolean more = true;
            while (more) {
                String runId = "run-drain-" + (++run);
                Object cursor = null;
                for (int c = 0; c < 50 && more; c++) {
                    Map<String, Object> page = call(host, runId, agent, "courier_new", Map.of());
                    calls++;
                    for (Map<String, Object> m : (List<Map<String, Object>>) page.get("messages")) {
                        given.add((String) m.get("messageId"));
                        seen.add((String) m.get("messageId"));
                    }
                    cursor = page.get("cursor");
                    more = Boolean.TRUE.equals(page.get("more"));
                }
                end(host, runId, agent, cursor);
            }
            report.put("drainRuns", run);
            report.put("drainCalls", calls);
            report.put("drainSeconds", Math.round((System.nanoTime() - drain) / 1e8) / 10.0);
            List<String> expected = new ArrayList<>();
            for (Object[] e : eligible) {
                expected.add((String) e[1]);
            }
            report.put("drainGiven", given.size());
            String json = new String(Json.bytes(report), StandardCharsets.UTF_8);
            System.out.println("COURIER-TOOLS-PERF " + json);
            Files.createDirectories(Path.of("target"));
            Files.writeString(Path.of("target", "courier-tools-perf.json"), json);
            assertThat(given).hasSameSizeAs(seen).isEqualTo(expected);
            if (BAR) {
                assertThat((Double) ((Map<String, Object>) report.get("courierNewOneCallMs")).get("p95")).isLessThanOrEqualTo(500.0);
                assertThat((Double) ((Map<String, Object>) report.get("courierNew100MessagesMs")).get("p95")).isLessThanOrEqualTo(500.0);
                assertThat((Double) ((Map<String, Object>) report.get("courierSearchMs")).get("p95")).isLessThanOrEqualTo(300.0);
            }
            host.close();
        }
    }

    private static Map<String, Object> stats(long[] v) {
        long[] s = v.clone();
        java.util.Arrays.sort(s);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("min", s[0]);
        m.put("p50", s[s.length / 2]);
        m.put("max", s[s.length - 1]);
        return m;
    }
}
