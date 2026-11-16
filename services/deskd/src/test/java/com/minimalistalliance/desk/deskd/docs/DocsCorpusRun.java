package com.minimalistalliance.desk.deskd.docs;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import com.minimalistalliance.desk.deskd.files.AgentFilesRig;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcTestCalls;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;

/**
 * The corpus run: desk-agent's synthetic corpus ({@code DocsCorpusExport}) through Files, deskd's index and the REAL worker
 * (a JVM per request with the sandbox's flags and security manager), then the gold facts checked: contract versions'
 * changed pages, the signed milestone, refusals, the reading views, pages drawn. Prints per-file times.
 *
 * <p>{@code -Ddocs.corpus.dir=DIR -Ddocs.worker.cp=CP [-Ddocs.worker.options=../desk-agent/docker/courier-parse.options]}
 */
@EnabledIfSystemProperty(named = "docs.corpus.dir", matches = ".+")
class DocsCorpusRun {

    @TempDir
    Path dir;

    @Test
    @SuppressWarnings("unchecked")
    void theCorpusThroughTheRealWorker() throws Exception {
        Path corpus = Path.of(System.getProperty("docs.corpus.dir"));
        Path options = Path.of(System.getProperty("docs.worker.options", "../desk-agent/docker/courier-parse.options"));
        Path trackers = Files.writeString(dir.resolve("trackers.txt"), "");
        ProcessDocsSandbox sandbox = new ProcessDocsSandbox(options, System.getProperty("docs.worker.cp"), trackers);
        AgentFilesRig files = new AgentFilesRig(dir.resolve("f"));
        RpcDispatcher dispatcher = new RpcDispatcher();
        MutableClock clock = new MutableClock(Instant.parse("2026-11-12T17:00:00Z"));
        DocsModule module = new DocsModule(dispatcher, new EventHub(new TopicRegistry()), Files.createDirectories(dir.resolve("desk")),
                files.files().docsAccess(), sandbox, () -> false, () -> false, () -> ZoneId.of("America/Denver"), clock);
        try {
            // Everything but the contract chains goes in at once; the chains go in as versions of one file each.
            int files0 = 0;
            try (Stream<Path> s = Files.list(corpus)) {
                for (Path p : s.sorted().toList()) {
                    String n = p.getFileName().toString();
                    if (n.startsWith("contract-") || n.equals("signed-contract.pdf")) {
                        continue;
                    }
                    Path to = files.root().resolve("Courier/" + n);
                    Files.createDirectories(to.getParent());
                    Files.copy(p, to);
                    Files.setLastModifiedTime(to, FileTime.from(clock.instant()));
                    files0++;
                }
            }
            long t0 = System.nanoTime();
            module.intake().scanFolder("Courier", false);
            long indexMs = (System.nanoTime() - t0) / 1_000_000L;
            // The contract chain: v1, v2 (page 3 changed), v3 (page 5 changed), then signed.
            Path chain = files.root().resolve("Contracts/Rosa contract.pdf");
            Files.createDirectories(chain.getParent());
            int[][] gold = {{}, {3}, {5}};
            String id = null;
            for (int v = 1; v <= 3; v++) {
                Files.copy(corpus.resolve("contract-rosa-ortiz-v" + v + ".pdf"), chain, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                clock.advance(Duration.ofMinutes(10));
                Files.setLastModifiedTime(chain, FileTime.from(clock.instant()));
                module.intake().scanFolder("Contracts", false);
                id = (String) call(dispatcher, "docs.byPath", Map.of("path", "Contracts/Rosa contract.pdf")).get("id");
                if (v > 1) {
                    Map<String, Object> ch = call(dispatcher, "docs.changes", Map.of("id", id));
                    if (Boolean.getBoolean("docs.eval.debug")) {
                        System.out.println("v" + v + " changes " + ch + " get " + call(dispatcher, "docs.get", Map.of("id", id)).get("versions")
                                + " doc " + doc(dispatcher, id));
                    }
                    List<Integer> want = java.util.Arrays.stream(gold[v - 1]).boxed().toList();
                    assertThat(ch.get("pages")).as("v" + v + " changed pages").isEqualTo(want);
                }
                call(dispatcher, "docs.seen", Map.of("id", id, "page", 1));
            }
            // An unsigned contract with a signature field, then the same one signed: "Signed", and it leaves Needs you.
            Path toSign = files.root().resolve("Courier/To sign.pdf");
            Files.copy(corpus.resolve("contract-rosa-ortiz-v2.pdf"), toSign);
            module.intake().scanFolder("Courier", false);
            String signId = (String) call(dispatcher, "docs.byPath", Map.of("path", "Courier/To sign.pdf")).get("id");
            Map<String, Object> unsigned = doc(dispatcher, signId);
            assertThat(unsigned.get("place")).isEqualTo("needs");
            assertThat(unsigned.get("maybe")).isEqualTo(true);
            Files.copy(corpus.resolve("signed-contract.pdf"), toSign, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            clock.advance(Duration.ofMinutes(10));
            Files.setLastModifiedTime(toSign, FileTime.from(clock.instant()));
            module.intake().scanFolder("Courier", false);
            Map<String, Object> got = call(dispatcher, "docs.get", Map.of("id", signId));
            List<Map<String, Object>> versions = (List<Map<String, Object>>) got.get("versions");
            assertThat(versions.get(0).get("milestoneText")).isEqualTo("Signed");
            assertThat(((Map<String, Object>) got.get("doc")).get("state")).isEqualTo("handled");
            // Refusals and kinds.
            Map<String, Object> locked = doc(dispatcher, byPath(dispatcher, "Courier/locked.pdf"));
            Map<String, Object> lockedText = call(dispatcher, "docs.text", Map.of("id", locked.get("id")));
            assertThat(lockedText.get("unread")).isEqualTo("encrypted");
            Map<String, Object> report = doc(dispatcher, byPath(dispatcher, "Courier/report-300.pdf"));
            assertThat(report.get("pageCount")).isEqualTo(300);
            Map<String, Object> scan = call(dispatcher, "docs.text", Map.of("id", byPath(dispatcher, "Courier/scan.pdf")));
            assertThat((List<?>) scan.get("pages")).isNotEmpty();
            Map<String, Object> docx = call(dispatcher, "docs.text", Map.of("id", byPath(dispatcher, "Courier/notes.docx")));
            assertThat(String.valueOf(docx.get("sections"))).contains("Ship the documents viewer.");
            assertThat(call(dispatcher, "docs.text", Map.of("id", byPath(dispatcher, "Courier/deck.pptx")))).containsKey("pages");
            assertThat(call(dispatcher, "docs.text", Map.of("id", byPath(dispatcher, "Courier/numbers.xlsx")))).containsKey("sections");
            Map<String, Object> bomb = doc(dispatcher, byPath(dispatcher, "Courier/bomb.docx"));
            assertThat(bomb.get("pageCount")).isNull();
            Map<String, Object> readme = doc(dispatcher, byPath(dispatcher, "Courier/readme.txt"));
            assertThat(readme.get("maybe").equals(true) || !"needs".equals(readme.get("place"))).as("text never lifts it").isTrue();
            // Pages drawn by the real worker.
            Doc contract = module.engine().store.doc(id);
            byte[] bytes = module.engine().bytesOf(contract, null);
            long r0 = System.nanoTime();
            DocsSandbox.Image page3 = sandbox.render(bytes, 3, 1170);
            long renderMs = (System.nanoTime() - r0) / 1_000_000L;
            assertThat(page3.width()).isEqualTo(1170);
            assertThat(page3.bytes().length).isLessThan(400_000);
            Map<String, Object> listed = call(dispatcher, "docs.list", Map.of("place", "all", "limit", 100));
            long reads = sandbox.timings.stream().filter(t -> t[0] == 0).count();
            long readMax = sandbox.timings.stream().filter(t -> t[0] == 0).mapToLong(t -> t[1]).max().orElse(0);
            double readAvg = sandbox.timings.stream().filter(t -> t[0] == 0).mapToLong(t -> t[1]).average().orElse(0);
            System.out.printf("docs corpus run: %d files indexed in %d ms (%d worker reads, avg %.0f ms, max %d ms); %d documents"
                    + " listed; contract chain v2 page 3, v3 page 5 marked; Signed milestone; a phone-width page drawn in %d ms,"
                    + " %d bytes%n", files0, indexMs, reads, readAvg, readMax, ((List<?>) listed.get("items")).size(), renderMs,
                    page3.bytes().length);
        } finally {
            module.close();
            files.close();
        }
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> call(RpcDispatcher d, String m, Map<String, Object> p) throws Exception {
        return (Map<String, Object>) RpcTestCalls.call(d, m, p);
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> doc(RpcDispatcher d, String id) throws Exception {
        return (Map<String, Object>) call(d, "docs.get", Map.of("id", id)).get("doc");
    }

    static String byPath(RpcDispatcher d, String path) throws Exception {
        return (String) call(d, "docs.byPath", Map.of("path", path)).get("id");
    }
}
