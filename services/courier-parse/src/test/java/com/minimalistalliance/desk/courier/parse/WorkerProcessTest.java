package com.minimalistalliance.desk.courier.parse;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.courier.testkit.MimeCorpus;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The worker as the sandbox starts it: its own JVM, with {@code courier-parse.options}' flags exactly (the 72 MiB heap,
 * the security manager, stdout for the answer only), the classpath swapped for this build's. What this proves that the
 * in-process tests can't: the readers, the sanitizer, ImageIO and the archive lister all work under the security manager,
 * a 30 MiB message and the limits' messages fit the heap, and the deadline ends a worker on its own. The container's own
 * fence (uid 1113, no network, 160 MiB) is {@code scripts/test-courier-sandbox.sh}'s, on Docker.
 */
class WorkerProcessTest {

    static final Path OPTIONS = Path.of("../desk-agent/docker/courier-parse.options");

    /** courier-parse.options' JVM flags, with this build's classpath and {@code trackers} in place of the image's. */
    static List<String> command(Path trackers) throws IOException {
        List<String> cmd = new ArrayList<>();
        cmd.add(Path.of(System.getProperty("java.home"), "bin", "java").toString());
        List<String> lines = new ArrayList<>();
        for (String line : Files.readAllLines(OPTIONS)) {
            if (!line.isBlank() && !line.startsWith("#")) {
                lines.add(line.strip());
            }
        }
        for (int i = 0; i < lines.size(); i++) {
            String l = lines.get(i);
            if (l.equals("-cp")) {
                cmd.add("-cp");
                cmd.add(System.getProperty("java.class.path"));
                i++;
            } else if (l.startsWith("-Dma.courier.trackers=")) {
                cmd.add("-Dma.courier.trackers=" + trackers);
            } else {
                cmd.add(l);
            }
        }
        return cmd;
    }

    record Run(int exit, String line, byte[] body, long millis) {}

    static Run run(Path trackers, String request, byte[] raw) throws Exception {
        ProcessBuilder pb = new ProcessBuilder(command(trackers));
        pb.environment().clear();
        pb.redirectError(ProcessBuilder.Redirect.DISCARD);
        long t = System.nanoTime();
        Process p = pb.start();
        Thread writer = Thread.ofVirtual().start(() -> {
            try (OutputStream out = p.getOutputStream()) {
                out.write((request + "\n").getBytes(StandardCharsets.US_ASCII));
                out.write(raw);
            } catch (IOException e) {
                // The worker stopped reading.
            }
        });
        byte[] all;
        try (InputStream in = p.getInputStream()) {
            all = in.readAllBytes();
        }
        assertThat(p.waitFor(30, TimeUnit.SECONDS)).isTrue();
        writer.join(5000);
        int nl = 0;
        while (nl < all.length && all[nl] != '\n') {
            nl++;
        }
        String line = new String(all, 0, Math.min(nl, all.length), StandardCharsets.US_ASCII);
        byte[] body = nl + 1 <= all.length ? java.util.Arrays.copyOfRange(all, nl + 1, all.length) : new byte[0];
        return new Run(p.exitValue(), line, body, (System.nanoTime() - t) / 1_000_000);
    }

    @Test
    void theWorkerReadsUnderItsOwnFlagsAndSecurityManager(@TempDir Path dir) throws Exception {
        Path trackers = dir.resolve("trackers.txt");
        Files.writeString(trackers, "# test\npx.tracker.example\n");
        Run r = run(trackers, "courier1 message", PartsTest.sample("apple-mail-mixed"));
        assertThat(r.exit()).isZero();
        assertThat(r.line()).isEqualTo("OK");
        assertThat(new String(r.body(), StandardCharsets.UTF_8)).contains("\"v\":1");
        Run html = run(trackers, "courier1 message", ("From: a@example.com\nContent-Type: text/html\n\n<p>hi"
                + "<img src=\"https://px.tracker.example/x.png\" width=\"40\" height=\"40\"><script>alert(1)</script>").getBytes(StandardCharsets.US_ASCII));
        assertThat(new String(html.body(), StandardCharsets.UTF_8)).contains("<p>hi</p>").doesNotContain("tracker").doesNotContain("script");
        Run image = run(trackers, "courier1 image 2", PartsTest.sample("related-cid-png"));
        assertThat(image.line()).matches("OK (png|jpeg) \\d+ \\d+|ERR not_found");
        Run listing = run(trackers, "courier1 archive 2", PartsTest.sample("zip-with-exe"));
        assertThat(listing.line()).isEqualTo("OK");
        assertThat(new String(listing.body(), StandardCharsets.UTF_8)).contains("\"format\":\"zip\"");
        Run bad = run(trackers, "courier1 nope", new byte[0]);
        assertThat(bad.line()).isEqualTo("ERR bad_request");
    }

    @Test
    void theLargestMessagesFitTheHeapAndTheLimitsAreRefused(@TempDir Path dir) throws Exception {
        Path trackers = dir.resolve("none.txt");
        Run large = run(trackers, "courier1 message", MimeCorpus.large(39 << 20).raw());
        assertThat(large.line()).as("39 MiB, %d ms", large.millis()).isEqualTo("OK");
        Run over = run(trackers, "courier1 message", MimeCorpus.overLimit().raw());
        assertThat(over.line()).isEqualTo("ERR too_large");
        assertThat(run(trackers, "courier1 message", MimeCorpus.tooManyParts(2001).raw()).line()).isEqualTo("ERR too_many_parts");
        assertThat(run(trackers, "courier1 message", MimeCorpus.tooDeep(21).raw()).line()).isEqualTo("ERR too_deep");
        // HTML at the size the tree is allowed, nested and wide: read, or left out with its text, never an exit.
        StringBuilder h = new StringBuilder("From: a@example.com\nContent-Type: text/html; charset=utf-8\n\n");
        while (h.length() < (2 << 20) - 200) {
            h.append("<table><tr><td style=\"color: red\"><a href=\"https://x.example/?utm_source=1\">link</a> word</td></tr></table>\n");
        }
        Run wide = run(trackers, "courier1 message", h.toString().getBytes(StandardCharsets.UTF_8));
        assertThat(wide.line()).as("%d ms", wide.millis()).isEqualTo("OK");
        System.out.printf("worker process: 39 MiB in %d ms, 2 MiB of HTML in %d ms%n", large.millis(), wide.millis());
    }
}
