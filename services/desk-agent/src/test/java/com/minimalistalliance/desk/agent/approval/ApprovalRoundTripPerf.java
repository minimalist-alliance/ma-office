package com.minimalistalliance.desk.agent.approval;

import static com.minimalistalliance.desk.agent.testing.FakeProvider.Step.call;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import com.minimalistalliance.desk.agent.tool.Classified;
import com.minimalistalliance.desk.agent.tool.Risk;
import com.minimalistalliance.desk.agent.tool.ToolDecl;
import com.minimalistalliance.desk.agent.tool.ToolPolicy;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;

/**
 * The approval round trip in desk-agent, measured, not asserted against a budget (run with {@code -Dperf=true}; a plain
 * {@code verify} skips it): a model step's write classified and asked (card in {@code agent.db}, audited, published), the
 * member's {@code agent.approval.decide} with its hash, the waiting run woken, the tool run with the stored payload, the
 * approval settled and the run ended. On real SQLite files, the fake provider, and a write in the agent's own workspace as the
 * tool, so the numbers are the gate's and the store's, not a model's or deskd's. Prints one {@code PERF} line per measure.
 */
@EnabledIfSystemProperty(named = "perf", matches = "true")
class ApprovalRoundTripPerf {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);

    @TempDir
    Path data;

    private final ToolPolicy policy = (c, run) -> {
        ToolDecl decl = new ToolDecl(c.name(), "Save {path} in the workspace", null, "workspace:self",
                c.name().equals("workspace_write") ? Risk.WRITE : Risk.READ, Set.of(), ToolDecl.Host.DESK_AGENT);
        return new Classified(c, decl, decl.risk(), "agent", Map.of("kind", "file", "path",
                String.valueOf(c.input().get("path"))), c.input(), null);
    };

    private static String line(String name, List<Long> nanos) {
        List<Long> sorted = new ArrayList<>(nanos);
        Collections.sort(sorted);
        double p50 = sorted.get(sorted.size() / 2) / 1e6;
        double p95 = sorted.get((int) Math.min(sorted.size() - 1, Math.round(sorted.size() * 0.95))) / 1e6;
        double max = sorted.get(sorted.size() - 1) / 1e6;
        return String.format(Locale.ROOT, "PERF %s n=%d p50=%.3fms p95=%.3fms max=%.3fms", name, nanos.size(), p50, p95,
                max);
    }

    @Test
    void askDecideRunSettle() throws Exception {
        try (TeamDesk desk = new TeamDesk(data, new MutableClock(Rig.START))) {
            desk.service.toolPolicy(policy);
            String a = desk.agent("Alice");
            List<Long> askNs = new ArrayList<>();
            List<Long> decideNs = new ArrayList<>();
            List<Long> roundTripNs = new ArrayList<>();
            int rounds = 150;
            for (int i = 0; i < rounds; i++) {
                String path = "plans/p" + i + ".md";
                desk.provider.then(Step.calls(USAGE, List.of(call("c" + i, "workspace_write", "path", path, "text",
                        "x".repeat(2048))))).then(Step.answer(USAGE, "Saved."));
                long t0 = System.nanoTime();
                desk.call("agent.message.send", "agentId", a, "text", "Save " + i);
                List<Map<String, Object>> pending;
                while ((pending = list(desk.call("agent.approvals.list", "agentId", a).get("approvals"))).isEmpty()) {
                    Thread.onSpinWait();
                }
                long t1 = System.nanoTime();
                Map<String, Object> card = pending.get(0);
                String sha = Approvals.hash(a, (String) card.get("runId"), "workspace_write", "agent",
                        map(card.get("payload")));
                long t2 = System.nanoTime();
                desk.call("agent.approval.decide", "approvalId", card.get("id"), "approve", true, "sha256", sha);
                long t3 = System.nanoTime();
                while (true) {
                    List<Map<String, Object>> thread = desk.thread(a);
                    Map<String, Object> last = thread.get(thread.size() - 1);
                    if ("assistant".equals(last.get("role")) && "done".equals(last.get("state"))
                            && last.get("id").equals(card.get("messageId"))) {
                        break;
                    }
                    Thread.onSpinWait();
                }
                long t4 = System.nanoTime();
                assertThat(map(desk.call("agent.approval.get", "approvalId", card.get("id")).get("approval")).get("state"))
                        .isEqualTo("done");
                if (i >= 30) {
                    askNs.add(t1 - t0);
                    decideNs.add(t3 - t2);
                    roundTripNs.add(t4 - t2);
                }
            }
            System.out.println(line("desk-agent.approval.send-to-card", askNs));
            System.out.println(line("desk-agent.approval.decide-rpc", decideNs));
            System.out.println(line("desk-agent.approval.decide-to-run-ended", roundTripNs));
            assertThat(desk.audit.verify().intact()).isTrue();
        }
    }
}
