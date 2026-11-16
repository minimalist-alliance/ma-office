package com.minimalistalliance.desk.agent.approval;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.service.Caller;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import com.minimalistalliance.desk.agent.tool.Classified;
import com.minimalistalliance.desk.agent.tool.RunContext;
import com.minimalistalliance.desk.agent.tool.ToolDecl;
import com.minimalistalliance.desk.agent.tool.ToolRegistry;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;

/**
 * What the gate's check of a call done without asking costs (the draft ADR's §17, Auto-approve: "The check adds 5 ms"),
 * measured on real SQLite (run with {@code -Dperf=true}; a plain {@code verify} skips it): {@link Approvals#admit} of one
 * {@code files_write} the member's switch covers (the policy, the class, the place, the counts and its approval row kept
 * before it runs), against the same admit of a read that needs nothing. Prints one {@code PERF} line per measure and holds
 * the unasked admit's p95 under 5 ms.
 */
@EnabledIfSystemProperty(named = "perf", matches = "true")
class AutoApprovePerf {

    @TempDir
    Path data;

    private static double pct(List<Long> nanos, double q) {
        List<Long> sorted = new ArrayList<>(nanos);
        Collections.sort(sorted);
        return sorted.get((int) Math.min(sorted.size() - 1, Math.round(sorted.size() * q))) / 1e6;
    }

    private static String line(String name, List<Long> nanos) {
        return String.format(Locale.ROOT, "PERF %s n=%d p50=%.3fms p95=%.3fms max=%.3fms", name, nanos.size(),
                pct(nanos, 0.5), pct(nanos, 0.95), pct(nanos, 1.0));
    }

    @Test
    void theGatesCheckOfAnUnaskedCall() throws Exception {
        MutableClock clock = new MutableClock(Rig.START);
        try (TeamDesk desk = new TeamDesk(data, clock)) {
            String a = desk.agent("Alice");
            desk.call("agent.access.set", "agentId", a, "auto", Map.of("files", Map.of("folder", "Research")));
            Approvals gate = desk.service.approvals();
            ToolRegistry registry = new ToolRegistry();
            ToolDecl write = registry.decl("files_write");
            ToolDecl read = registry.decl("files_list");
            List<Long> unasked = new ArrayList<>();
            List<Long> plain = new ArrayList<>();
            int rounds = 2000;
            for (int i = 0; i < rounds; i++) {
                if (i > 0 && i % 100 == 0) {
                    clock.advance(Duration.ofDays(1)); // the day's 100
                }
                RunContext run = RunContext.of("run-" + i, a, Caller.OWNER, Map.of("kind", "member"), "msg-" + i);
                gate.begin(run);
                Map<String, Object> payload = Map.of("path", "Research/n" + i + ".md", "text", "x".repeat(2048),
                        "replace", false);
                Classified c = new Classified(new ToolCall("w" + i, "files_write", payload, false, null), write,
                        write.risk(), "agent", Map.of("kind", "file", "path", payload.get("path")), payload, null);
                Classified r = new Classified(new ToolCall("r" + i, "files_list", Map.of(), false, null), read,
                        read.risk(), "agent", Map.of(), Map.of(), null);
                long t0 = System.nanoTime();
                List<Verdict> v = gate.admit(run, List.of(c));
                long t1 = System.nanoTime();
                List<Verdict> base = gate.admit(run, List.of(r));
                long t2 = System.nanoTime();
                assertThat(v.get(0)).isInstanceOf(Verdict.Allowed.class);
                assertThat(base.get(0)).isInstanceOf(Verdict.Auto.class);
                gate.starting(v.get(0));
                gate.settle(run, c, v.get(0), new ToolResult("w" + i, "saved", false));
                gate.ended(run.runId());
                if (i >= 200) {
                    unasked.add(t1 - t0);
                    plain.add(t2 - t1);
                }
            }
            System.out.println(line("desk-agent admit, a call done without asking (policy, class, place, counts, row)",
                    unasked));
            System.out.println(line("desk-agent admit, a read that needs nothing", plain));
            assertThat(pct(unasked, 0.95)).as("the unasked check's p95, ms").isLessThan(5.0);
        }
    }
}
