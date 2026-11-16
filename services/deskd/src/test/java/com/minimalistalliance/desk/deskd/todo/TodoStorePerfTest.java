package com.minimalistalliance.desk.deskd.todo;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Path;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The draft ADR's §17 To-dos row: a create takes at most 50 ms p95. Agent adds on a real file with
 * {@code synchronous=FULL} (each one on disk before it returns), each through the whole dedupe and caps path, against a
 * store already holding 1,000 items; then the member's own adds and the Needs you read.
 */
class TodoStorePerfTest {

    @TempDir
    Path dir;

    @Test
    void aCreateTakesAtMostFiftyMillisecondsP95() throws Exception {
        // An hour between adds, so the day's caps don't come into it: what's measured is the add itself.
        com.minimalistalliance.desk.deskd.testing.MutableClock clock =
                new com.minimalistalliance.desk.deskd.testing.MutableClock(java.time.Instant.parse("2026-11-01T00:00:00Z"));
        try (TodoStore store = TodoStore.open(dir.resolve(TodoStore.FILE), clock, () -> ZoneOffset.UTC)) {
            for (int i = 0; i < 1000; i++) {
                store.memberAdd(null, "Background item " + i, null, null, false);
            }
            List<Long> agent = new ArrayList<>();
            for (int i = 0; i < 400; i++) {
                TodoStore.Source source = new TodoStore.Source("courier", Map.of("messageId", "m" + i, "channelId",
                        "c" + (i % 40)), "Email from someone · subject " + i, "courier:c" + (i % 40));
                long t0 = System.nanoTime();
                store.agentAdd(new TodoStore.AgentAdd("ag-" + (i / 25), "run-" + (i / 8), "ap-" + i,
                        "Reply to message number " + i + " about topic " + (i * 7919 % 1000), null, null, source, true,
                        null));
                agent.add(System.nanoTime() - t0);
                clock.advance(java.time.Duration.ofHours(1));
            }
            List<Long> member = new ArrayList<>();
            for (int i = 0; i < 200; i++) {
                long t0 = System.nanoTime();
                store.memberAdd(new TodoStore.Idem("idem-" + i, "todo.add", Map.of("title", "x" + i)), "Member item " + i,
                        null, null, false);
                member.add(System.nanoTime() - t0);
            }
            List<Long> reads = new ArrayList<>();
            for (int i = 0; i < 200; i++) {
                long t0 = System.nanoTime();
                store.list(new TodoStore.ListQuery("needs_you", null, null, null, null, null, 50));
                reads.add(System.nanoTime() - t0);
            }
            double agentP95 = p95(agent);
            double memberP95 = p95(member);
            System.out.printf("todo create p95: agent add %.1f ms (p50 %.1f), member add %.1f ms; needs_you read p95 %.1f ms%n",
                    agentP95, p50(agent), memberP95, p95(reads));
            assertThat(agentP95).isLessThanOrEqualTo(50.0);
            assertThat(memberP95).isLessThanOrEqualTo(50.0);
        }
    }

    private static double p95(List<Long> nanos) {
        return at(nanos, 0.95);
    }

    private static double p50(List<Long> nanos) {
        return at(nanos, 0.50);
    }

    private static double at(List<Long> nanos, double q) {
        List<Long> sorted = new ArrayList<>(nanos);
        Collections.sort(sorted);
        return sorted.get((int) Math.ceil(q * sorted.size()) - 1) / 1e6;
    }
}
