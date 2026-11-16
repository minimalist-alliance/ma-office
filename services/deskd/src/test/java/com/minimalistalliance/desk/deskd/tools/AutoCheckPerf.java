package com.minimalistalliance.desk.deskd.tools;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.files.AgentFilesRig;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;

/**
 * What deskd's own check of a call done without asking costs (the draft ADR's §17, Auto-approve: "The check adds 5 ms";
 * run with {@code -Dperf=true}): {@link ToolHost#requireAuto} (the record, the class, the place, the arguments' hash and
 * the ledger's reservation, with the ledger kept on disk) and the area's place check where it writes
 * ({@code AgentFiles.requireInside}), for a 2 KiB new file. Prints one {@code PERF} line and holds its p95 under 5 ms.
 */
@EnabledIfSystemProperty(named = "perf", matches = "true")
class AutoCheckPerf {

    @TempDir
    Path dir;

    private static double pct(List<Long> nanos, double q) {
        List<Long> sorted = new ArrayList<>(nanos);
        Collections.sort(sorted);
        return sorted.get((int) Math.min(sorted.size() - 1, Math.round(sorted.size() * q))) / 1e6;
    }

    @Test
    void deskdsCheckOfAnUnaskedCall() throws Exception {
        try (AgentFilesRig rig = new AgentFilesRig(dir.resolve("rig"))) {
            Files.createDirectories(rig.root().resolve("Research"));
            ToolHost host = new ToolHost(Clock.systemUTC(), ToolHost.ownerOnly(), () -> false, () -> true);
            FilesTools files = new FilesTools(rig.files().agentAccess());
            host.area(HostedDecls.FILES, files);
            host.access(new ToolHost.AccessRecord() {
                @Override
                public boolean autoOn(Caller caller, String agentId, String group) {
                    return "files".equals(group);
                }

                @Override
                public String place(String agentId, String group) {
                    return "Research";
                }
            });
            host.autoLedger().keepIn(dir);
            HostedDecls.Decl decl = HostedDecls.get("files_write");
            List<Long> nanos = new ArrayList<>();
            int rounds = 3000;
            for (int i = 0; i < rounds; i++) {
                String agentId = "ag-" + (i / 100); // each agent's day of 100
                String runId = "run-" + (i / 20);
                Map<String, Object> args = Map.of("path", "Research/n" + i + ".md", "text", "x".repeat(2048),
                        "replace", false);
                char[] c = "aaaaaaaaaaaaaaaaaaaa".toCharArray();
                for (int k = c.length - 1, n = 1_000_000 + i; k >= 0 && n > 0; k--, n /= 32) {
                    c[k] = "abcdefghijklmnopqrstuvwxyz234567".charAt(n % 32);
                }
                String id = "ap-" + new String(c);
                HostedCall call = new HostedCall(i, runId, agentId, "files_write", args, null, false, Caller.THE_OWNER,
                        null, id);
                RunLedger.Run run = host.ledger().join(runId, agentId, Caller.THE_OWNER, List.of());
                HostedTool.Look found = files.look(call, run);
                long t0 = System.nanoTime();
                HostedCall.AutoPlace place = host.requireAuto(call, decl, ToolRisk.WRITE, found, run, "files", files);
                rig.files().agentAccess().requireInside((String) args.get("path"), place.folder());
                long t1 = System.nanoTime();
                host.autoLedger().finish(id, "done", Map.of("kind", "file", "path", args.get("path"), "sha256", "s"));
                if (i >= 300) {
                    nanos.add(t1 - t0);
                }
            }
            double p50 = pct(nanos, 0.5);
            double p95 = pct(nanos, 0.95);
            System.out.println(String.format(Locale.ROOT,
                    "PERF deskd's check of a call done without asking n=%d p50=%.3fms p95=%.3fms max=%.3fms",
                    nanos.size(), p50, p95, pct(nanos, 1.0)));
            assertThat(p95).as("deskd's check's p95, ms").isLessThan(5.0);
            host.close();
        }
    }
}
