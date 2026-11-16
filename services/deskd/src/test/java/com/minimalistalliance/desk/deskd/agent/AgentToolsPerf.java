package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.files.AgentFilesRig;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import com.minimalistalliance.desk.deskd.tools.FilesTools;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
import com.minimalistalliance.desk.deskd.tools.ToolHost;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
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
 * deskd's side of the Agent's Files tools, measured, not asserted against a budget (run with {@code -Dperf=true}; a plain
 * {@code verify} skips it): an approved {@code files_write}'s second check and run (the hash over a 256 KiB payload, the
 * ticket's redeem, the write and its trash), and {@code files_read}'s throughput paging a large text file through
 * {@link ToolHost} as desk-agent calls it. Prints one {@code PERF} line per measure.
 */
@EnabledIfSystemProperty(named = "perf", matches = "true")
@SuppressWarnings("unchecked")
class AgentToolsPerf {

    @TempDir
    Path dir;

    private static String line(String name, List<Long> nanos) {
        List<Long> sorted = new ArrayList<>(nanos);
        Collections.sort(sorted);
        double p50 = sorted.get(sorted.size() / 2) / 1e6;
        double p95 = sorted.get((int) Math.min(sorted.size() - 1, Math.round(sorted.size() * 0.95))) / 1e6;
        double max = sorted.get(sorted.size() - 1) / 1e6;
        return String.format(Locale.ROOT, "PERF %s n=%d p50=%.3fms p95=%.3fms max=%.3fms", name, nanos.size(), p50, p95,
                max);
    }

    private static Map<String, Object> message(long id, String tool, Map<String, Object> args, boolean look,
            Map<String, Object> approval) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "tcall");
        m.put("id", id);
        m.put("tool", tool);
        m.put("runId", "run-perf");
        m.put("agentId", "ag-perf");
        m.put("args", args);
        m.put("taint", List.of());
        if (look) {
            m.put("phase", "look");
        }
        if (approval != null) {
            m.put("approval", approval);
            m.put("context", "agent");
        }
        return m;
    }

    @Test
    void anApprovedWritesSecondCheckAndRunAndFilesReadThroughput() throws Exception {
        try (AgentFilesRig files = new AgentFilesRig(dir.resolve("files"))) {
            MutableClock clock = new MutableClock(Instant.parse("2026-11-12T20:00:00Z"));
            ApprovalTickets tickets = new ApprovalTickets(clock);
            ToolHost host = new ToolHost(clock, agentId -> Caller.THE_OWNER, () -> false, () -> true);
            host.tickets((approvalId, sha256, agentId, runId, tool, context, args) -> {
                var redeemed = tickets.redeem(approvalId, sha256, agentId, runId, tool, context, args);
                return redeemed.ok() ? null : redeemed.refusal().code();
            });
            host.area(HostedDecls.FILES, new FilesTools(files.files().agentAccess()));
            BlockingQueue<Map<String, Object>> replies = new LinkedBlockingQueue<>();

            // ---- an approved 256 KiB replace: look, the member's yes (deskd's ticket), the second check and the run.
            String text = "x".repeat(256 * 1024 - 8) + "\n"; // the most a write takes is 256 Ki characters
            Files.writeString(files.root().resolve("big.md"), "old");
            List<Long> lookNs = new ArrayList<>();
            List<Long> runNs = new ArrayList<>();
            List<Long> hashNs = new ArrayList<>();
            for (int i = 0; i < 120; i++) {
                Map<String, Object> args = new LinkedHashMap<>();
                args.put("path", "big.md");
                args.put("text", text + i);
                args.put("replace", true);
                long t0 = System.nanoTime();
                host.onCall(message(i * 2L, "files_write", args, true, null), replies::add);
                Map<String, Object> look = replies.poll(10, TimeUnit.SECONDS);
                long t1 = System.nanoTime();
                assertThat(look).containsEntry("t", "tres");
                Map<String, Object> payload = (Map<String, Object>) ((Map<String, Object>) look.get("r")).get("payload");
                long h0 = System.nanoTime();
                String sha = ToolHost.hash("ag-perf", "run-perf", "files_write", "agent", payload);
                hashNs.add(System.nanoTime() - h0);
                String id = String.format(Locale.ROOT, "ap-%020d", i).replace('0', 'a').replace('1', 'b')
                        .replace('2', 'c').replace('3', 'd').replace('4', 'e').replace('5', 'f').replace('6', 'g')
                        .replace('7', 'h').replace('8', 'i').replace('9', 'j');
                assertThat(tickets.record(id, sha, Caller.THE_OWNER)).isTrue();
                long t2 = System.nanoTime();
                host.onCall(message(i * 2L + 1, "files_write", payload, false, Map.of("approvalId", id, "sha256", sha)),
                        replies::add);
                Map<String, Object> ran = replies.poll(10, TimeUnit.SECONDS);
                long t3 = System.nanoTime();
                assertThat(ran).as(String.valueOf(ran)).containsEntry("t", "tres");
                if (i >= 20) {
                    lookNs.add(t1 - t0);
                    runNs.add(t3 - t2);
                }
            }
            System.out.println(line("deskd.files_write.256KiB.look", lookNs));
            System.out.println(line("deskd.files_write.256KiB.hash", hashNs.subList(20, hashNs.size())));
            System.out.println(line("deskd.files_write.256KiB.recheck+run", runNs));

            // ---- files_read: a 64 MiB text file paged at 128 Ki characters through ToolHost, as desk-agent pages it.
            Path big = files.root().resolve("log.txt");
            byte[] chunk = ("A line of text from a long log, with some words in it, 0123456789 ünïcödé.\n")
                    .getBytes(StandardCharsets.UTF_8);
            long target = 64L * 1024 * 1024;
            try (OutputStream out = Files.newOutputStream(big)) {
                for (long written = 0; written < target; written += chunk.length) {
                    out.write(chunk);
                }
            }
            long size = Files.size(big);
            for (int round = 0; round < 3; round++) {
                long offset = 0;
                int pages = 0;
                long chars = 0;
                List<Long> pageNs = new ArrayList<>();
                long start = System.nanoTime();
                while (true) {
                    Map<String, Object> args = new LinkedHashMap<>();
                    args.put("path", "log.txt");
                    args.put("offset", offset);
                    long p0 = System.nanoTime();
                    host.onCall(message(10_000L + pages, "files_read", args, false, null), replies::add);
                    Map<String, Object> reply = replies.poll(30, TimeUnit.SECONDS);
                    pageNs.add(System.nanoTime() - p0);
                    assertThat(reply).containsEntry("t", "tres");
                    Map<String, Object> content = (Map<String, Object>) ((Map<String, Object>) reply.get("r"))
                            .get("content");
                    chars += ((String) content.get("text")).length();
                    pages++;
                    Object next = content.get("next");
                    if (next == null) {
                        break;
                    }
                    offset = ((Number) next).longValue();
                }
                double seconds = (System.nanoTime() - start) / 1e9;
                System.out.println(String.format(Locale.ROOT,
                        "PERF deskd.files_read.64MiB round=%d pages=%d chars=%d bytes=%d seconds=%.3f MiBps=%.1f",
                        round, pages, chars, size, seconds, size / (1024.0 * 1024) / seconds));
                System.out.println(line("deskd.files_read.page128Ki", pageNs));
            }
            host.close();
        }
    }
}
