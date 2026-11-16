package com.minimalistalliance.desk.agent.tool;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.manager.ManagerAgent;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;

/**
 * desk-agent's half of {@code files_read} on a large file, measured, not asserted against a budget (run with
 * {@code -Dperf=true}): each of deskd's 128 Ki pages fitted under the run loop's cut and fenced as untrusted, as the model
 * reads it, over a 64 MiB file, read on from each {@code next} to the end. Prints how many pages the model needs, the
 * throughput of desk-agent's own handling, and the time per page.
 */
@EnabledIfSystemProperty(named = "perf", matches = "true")
class FilesReadPerf {

    @Test
    void aLargeFileReadPageByPageAsTheModelReadsIt() throws Exception {
        String line = "A line of text from a long log, with some words in it, 0123456789 ünïcödé.\n";
        StringBuilder b = new StringBuilder();
        while (b.length() < 64 * 1024 * 1024) {
            b.append(line);
        }
        String file = b.toString();
        byte[] bytes = file.getBytes(StandardCharsets.UTF_8);
        for (int round = 0; round < 3; round++) {
            long offsetChars = 0;
            long offsetBytes = 0;
            int pages = 0;
            List<Long> pageNs = new ArrayList<>();
            long t0 = System.nanoTime();
            while (offsetChars < file.length()) {
                // deskd's page: 128 Ki characters from the byte offset (here from the matching character offset).
                int end = (int) Math.min(file.length(), offsetChars + 128 * 1024);
                Map<String, Object> page = new LinkedHashMap<>();
                page.put("path", "log.txt");
                page.put("text", file.substring((int) offsetChars, end));
                page.put("offset", offsetBytes);
                page.put("next", end >= file.length() ? null : offsetBytes + file.substring((int) offsetChars, end)
                        .getBytes(StandardCharsets.UTF_8).length);
                long p0 = System.nanoTime();
                String out = AgentTools.fitPage("files_read", page, true, ManagerAgent.MAX_RESULT_CHARS);
                pageNs.add(System.nanoTime() - p0);
                assertThat(out.length()).isLessThanOrEqualTo(ManagerAgent.MAX_RESULT_CHARS);
                String json = (String) Json.parseObject(out.split("\n", 2)[1].getBytes(StandardCharsets.UTF_8))
                        .get("content");
                Map<String, Object> seen = Json.parseObject(json.getBytes(StandardCharsets.UTF_8));
                String kept = (String) seen.get("text");
                offsetChars += kept.length();
                offsetBytes += kept.getBytes(StandardCharsets.UTF_8).length;
                if (seen.get("next") != null) {
                    assertThat(((Number) seen.get("next")).longValue()).isEqualTo(offsetBytes);
                }
                pages++;
            }
            double seconds = (System.nanoTime() - t0) / 1e9;
            Collections.sort(pageNs);
            System.out.println(String.format(Locale.ROOT,
                    "PERF desk-agent.files_read.64MiB round=%d modelPages=%d bytes=%d seconds=%.3f MiBps=%.1f "
                            + "fit p50=%.3fms p95=%.3fms",
                    round, pages, bytes.length, seconds, bytes.length / (1024.0 * 1024) / seconds,
                    pageNs.get(pageNs.size() / 2) / 1e6, pageNs.get((int) (pageNs.size() * 0.95)) / 1e6));
            assertThat(offsetBytes).isEqualTo(bytes.length);
        }
    }
}
