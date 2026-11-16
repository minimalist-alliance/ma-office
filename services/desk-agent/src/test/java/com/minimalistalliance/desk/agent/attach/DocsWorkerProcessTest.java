package com.minimalistalliance.desk.agent.attach;

import static org.assertj.core.api.Assertions.assertThat;

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
 * The documents mode in the real worker JVM as deskd's sandbox starts it: {@code courier-parse.options}' flags exactly
 * (72 MiB heap, serial GC, the security manager installed by {@code CourierWorker}), with this build's classpath. Proves
 * the mode is found through the service file, reads and draws with the manager in place, and leaves {@code courier1}
 * alone.
 */
class DocsWorkerProcessTest {

    static final Path OPTIONS = Path.of("docker/courier-parse.options");

    record Run(int exit, String line, byte[] body, long millis) {}

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

    static Run run(Path trackers, String request, byte[] input) throws Exception {
        List<String> cmd = command(trackers);
        boolean debug = Boolean.getBoolean("docs.debug");
        if (debug) {
            // -Ddocs.debug=true: the worker's own stack traces on this test's stderr.
            cmd.add(1, "-Dma.attach.debug=true");
        }
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.environment().clear();
        pb.redirectError(debug ? ProcessBuilder.Redirect.INHERIT : ProcessBuilder.Redirect.DISCARD);
        long t = System.nanoTime();
        Process p = pb.start();
        Thread writer = new Thread(() -> {
            try (OutputStream o = p.getOutputStream()) {
                o.write((request + "\n").getBytes(StandardCharsets.US_ASCII));
                o.write(input);
            } catch (IOException e) {
                // It stopped reading.
            }
        });
        writer.start();
        ByteArrayOutputStream all = new ByteArrayOutputStream();
        try (InputStream in = p.getInputStream()) {
            in.transferTo(all);
        }
        assertThat(p.waitFor(30, TimeUnit.SECONDS)).isTrue();
        byte[] bytes = all.toByteArray();
        int nl = 0;
        while (nl < bytes.length && bytes[nl] != '\n') {
            nl++;
        }
        String line = new String(bytes, 0, Math.min(nl, bytes.length), StandardCharsets.US_ASCII);
        byte[] body = nl + 1 <= bytes.length ? java.util.Arrays.copyOfRange(bytes, nl + 1, bytes.length) : new byte[0];
        return new Run(p.exitValue(), line, body, (System.nanoTime() - t) / 1_000_000L);
    }

    @Test
    void readsAndDrawsUnderTheSecurityManager(@TempDir Path dir) throws Exception {
        Path trackers = Files.writeString(dir.resolve("trackers.txt"), "tracker.example\n");
        byte[] contract = DocsFixtures.pdf(DocsFixtures.contract("Rosa Ortiz", 2, 6), true, false, null);
        Run read = run(trackers, "docs1 read pdf 200000 500", contract);
        assertThat(read.line()).isEqualTo("OK");
        String json = new String(read.body(), StandardCharsets.UTF_8);
        assertThat(json).startsWith("{\"v\":1,\"kind\":\"pdf\",\"pageCount\":6").contains("Payment is due on 1 December 2026.")
                .contains("\"signaturesEmpty\":1");
        Run draw = run(trackers, "docs1 render 3 1200", contract);
        assertThat(draw.line()).matches("OK jpeg 1200 [0-9]+");
        assertThat(javax.imageio.ImageIO.read(new java.io.ByteArrayInputStream(draw.body())).getWidth()).isEqualTo(1200);
        // An unembedded font is mapped (to a bundled one) under the manager too.
        Run mapped = run(trackers, "docs1 render 1 600", Fixtures.pdfWithUnembeddedFont("Garamond-Bold", "Mapped line"));
        assertThat(mapped.line()).startsWith("OK jpeg 600 ");
        Run docx = run(trackers, "docs1 read docx 100000 500", Fixtures.docx("A paragraph"));
        assertThat(docx.line()).isEqualTo("OK");
        assertThat(new String(docx.body(), StandardCharsets.UTF_8)).contains("A paragraph");
    }

    @Test
    void aHundredPagesReadAndAPageDrawsInTime(@TempDir Path dir) throws Exception {
        Path trackers = Files.writeString(dir.resolve("trackers.txt"), "");
        byte[] report = DocsFixtures.pdf(DocsFixtures.report(100));
        Run read = run(trackers, "docs1 read pdf 100000 500", report);
        assertThat(read.line()).isEqualTo("OK");
        Run draw = run(trackers, "docs1 render 50 1600", report);
        assertThat(draw.line()).startsWith("OK jpeg 1600 ");
        System.out.printf("docs worker: 100-page read %d ms (%d bytes of JSON), page draw %d ms (%d bytes)%n", read.millis(),
                read.body().length, draw.millis(), draw.body().length);
        assertThat(read.millis()).isLessThan(9_000);
        assertThat(draw.millis()).isLessThan(9_000);
    }

    @Test
    void refusalsAndCourierStayAsTheyWere(@TempDir Path dir) throws Exception {
        Path trackers = Files.writeString(dir.resolve("trackers.txt"), "");
        assertThat(run(trackers, "docs1 read exe 1 1", new byte[4]).line()).isEqualTo("ERR bad_request");
        assertThat(run(trackers, "docs1 render 1 800", Fixtures.heavyPdf()).line()).isIn("ERR too_complex", "ERR unreadable", "");
        assertThat(run(trackers, "nope1 x", new byte[4]).line()).isEqualTo("ERR bad_request");
        Run courier = run(trackers, "courier1 message", "From: a@example.com\r\nSubject: hi\r\n\r\nhello\r\n".getBytes(StandardCharsets.US_ASCII));
        assertThat(courier.line()).isEqualTo("OK");
        assertThat(new String(courier.body(), StandardCharsets.UTF_8)).startsWith("{\"v\":1,\"from\"");
    }
}
