package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.files.AgentFilesRig;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import com.minimalistalliance.desk.deskd.tools.FilesTools;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
import com.minimalistalliance.desk.deskd.tools.ToolHost;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;

/**
 * W7's performance run for §17's Files row, deskd's own part, through {@link ToolHost} as desk-agent calls it: list and
 * search over 10,000 files (150 ms), a text read's first page (300 ms), an approved write with its second check (150
 * ms). p95 of 50 each. Run with {@code -Dperf=true}; a plain {@code verify} skips it. It prints one {@code PERF} line per
 * measure with its budget, and fails on a miss only with {@code -Dperf.enforce=true}, since a build box isn't a desk
 * (the nightly on a {@code DeskKind=test} desk is {@code web/tests/real-desk/rt-agent-perf.mjs}).
 */
@EnabledIfSystemProperty(named = "perf", matches = "true")
@SuppressWarnings("unchecked")
class HarnessToolsPerf {

    private static final int RUNS = 50;

    @TempDir
    Path dir;

    private final BlockingQueue<Map<String, Object>> replies = new LinkedBlockingQueue<>();
    private long id;

    private static Map<String, Object> args(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    private Map<String, Object> call(ToolHost host, String tool, Map<String, Object> a, Map<String, Object> approval)
            throws InterruptedException {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "tcall");
        m.put("id", ++id);
        m.put("tool", tool);
        m.put("runId", "run-perf");
        m.put("agentId", "ag-perf");
        m.put("args", a);
        m.put("taint", List.of());
        if (approval != null) {
            m.put("approval", approval);
            m.put("context", "agent");
        }
        host.onCall(m, replies::add);
        Map<String, Object> r = replies.poll(30, TimeUnit.SECONDS);
        assertThat(r).isNotNull();
        assertThat(r).as(tool).containsEntry("t", "tres");
        return r;
    }

    private static List<String> misses = new ArrayList<>();

    private static void report(String name, List<Long> nanos, double budgetMs) {
        List<Long> s = new ArrayList<>(nanos);
        Collections.sort(s);
        double p50 = s.get(s.size() / 2) / 1e6;
        double p95 = s.get((int) Math.min(s.size() - 1, Math.round(s.size() * 0.95))) / 1e6;
        boolean miss = p95 > budgetMs;
        System.out.println(String.format(Locale.ROOT, "PERF %s n=%d p50=%.2fms p95=%.2fms budget=%.0fms %s", name,
                s.size(), p50, p95, budgetMs, miss ? "MISS" : "ok"));
        if (miss) {
            misses.add(name);
        }
    }

    @Test
    void filesOverTenThousandFiles() throws Exception {
        try (AgentFilesRig files = new AgentFilesRig(dir.resolve("files"))) {
            // 10,000 files: 100 folders of 100, names a search can find.
            for (int f = 0; f < 100; f++) {
                Path folder = Files.createDirectories(files.root().resolve("projects/p" + f));
                for (int i = 0; i < 100; i++) {
                    Files.writeString(folder.resolve("note-" + f + "-" + i + (i == 42 ? "-invoice" : "") + ".md"), "x");
                }
            }
            Files.writeString(files.root().resolve("long.txt"), "Line of text for the first page.\n".repeat(40_000));
            MutableClock clock = new MutableClock(Instant.parse("2026-11-13T20:00:00Z"));
            ApprovalTickets tickets = new ApprovalTickets(clock);
            ToolHost host = new ToolHost(clock, agentId -> Caller.THE_OWNER, () -> false, () -> true);
            host.tickets((approvalId, sha256, agentId, runId, tool, context, a) -> {
                var redeemed = tickets.redeem(approvalId, sha256, agentId, runId, tool, context, a);
                return redeemed.ok() ? null : redeemed.refusal().code();
            });
            host.area(HostedDecls.FILES, new FilesTools(files.files().agentAccess()));
            // Warm the paths once, as a desk's first call would have.
            call(host, "files_list", args("path", "projects/p1"), null);
            call(host, "files_search", args("q", "invoice"), null);

            List<Long> list = new ArrayList<>();
            List<Long> search = new ArrayList<>();
            List<Long> read = new ArrayList<>();
            List<Long> write = new ArrayList<>();
            for (int i = 0; i < RUNS; i++) {
                long t = System.nanoTime();
                call(host, "files_list", args("path", "projects/p" + (i % 100)), null);
                list.add(System.nanoTime() - t);
                t = System.nanoTime();
                Map<String, Object> r = call(host, "files_search", args("q", "invoice"), null);
                search.add(System.nanoTime() - t);
                assertThat(String.valueOf(r.get("r"))).contains("invoice");
                t = System.nanoTime();
                call(host, "files_read", args("path", "long.txt"), null);
                read.add(System.nanoTime() - t);
                Map<String, Object> payload = args("path", "out-" + i + ".md", "text", "saved " + i, "replace", false);
                String sha = ToolHost.hash("ag-perf", "run-perf", "files_write", "agent", payload);
                String approvalId = String.format(Locale.ROOT, "ap-%020d", i).replace('0', 'a').replace('1', 'b').replace('2', 'c')
                        .replace('3', 'd').replace('4', 'e').replace('5', 'f').replace('6', 'g').replace('7', 'h')
                        .replace('8', 'i').replace('9', 'j');
                assertThat(tickets.record(approvalId, sha, Caller.THE_OWNER)).isTrue();
                t = System.nanoTime();
                call(host, "files_write", payload, Map.of("approvalId", approvalId, "sha256", sha));
                write.add(System.nanoTime() - t);
            }
            report("files_list one folder of 100, tree of 10,000", list, 150);
            report("files_search over 10,000 files", search, 150);
            report("files_read first page of a 1.3 MB text file", read, 300);
            report("files_write approved, second check and fsync", write, 150);
            host.close();
        }
        if (Boolean.getBoolean("perf.enforce")) {
            assertThat(misses).as("budgets missed").isEmpty();
        }
    }
}
