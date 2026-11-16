package com.minimalistalliance.desk.agent.attach;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.channels.ServerSocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * ADR 0097's marker rule and failure table, against a stand-in sandbox ({@link TestSidecar}) that runs the real
 * {@code ParseWorker --from-stream} per connection, and against scripted ones for each failure. "No child" is checked
 * twice: {@link Parsers#counts()} never counts one, and each refused file is one the child would have read.
 */
class ParsersSidecarTest {

    private static final byte[] TEXT = "Plain words".getBytes(StandardCharsets.UTF_8);

    @TempDir
    Path tmp;

    private static String reason(Parsers parsers, String kind, byte[] bytes) {
        AtomicReference<String> reason = new AtomicReference<>();
        assertThatThrownBy(() -> parsers.read(kind, bytes, 100_000, 100, "f")).isInstanceOfSatisfying(
                AttachException.class, e -> reason.set(e.reason()));
        return reason.get();
    }

    private static void noChild(Parsers parsers) {
        assertThat(parsers.counts().child()).isZero();
        assertThat(parsers.mode()).isEqualTo("sidecar");
    }

    // --- which way

    @Test
    void withNeitherMarkerNorSocketTheChildReads() throws Exception {
        try (Parsers parsers = new Parsers(30, tmp.resolve("desk-parse"))) {
            assertThat(parsers.mode()).isEqualTo("child");
            assertThat(parsers.read("text", TEXT, 100_000, 100, "f").text()).isEqualTo("Plain words");
            assertThat(parsers.counts()).isEqualTo(new Parsers.Counts(0, 0, 1, 0));
        }
        // An empty directory is neither: an image that made /run/desk-parse but no marker or socket.
        Path empty = Files.createDirectories(tmp.resolve("empty"));
        try (Parsers parsers = new Parsers(30, empty)) {
            assertThat(parsers.read("text", TEXT, 100_000, 100, "f").text()).isEqualTo("Plain words");
            assertThat(parsers.counts().child()).isEqualTo(1);
        }
    }

    @Test
    void withAWorkingSocketEveryKindGoesToTheSidecar() throws Exception {
        try (TestSidecar sidecar = TestSidecar.realWorker(tmp); Parsers parsers = new Parsers(30, tmp)) {
            assertThat(parsers.mode()).isEqualTo("sidecar");
            assertThat(parsers.read("text", TEXT, 100_000, 100, "f").text()).isEqualTo("Plain words");
            assertThat(parsers.read("pdf", Fixtures.pdf(2, "Quarterly"), 100_000, 100, "f").text())
                    .contains("Quarterly page 1", "Quarterly page 2");
            assertThat(parsers.read("docx", Fixtures.docx("Hello", "World"), 100_000, 100, "f").text())
                    .contains("Hello\nWorld");
            assertThat(parsers.read("xlsx", Fixtures.xlsx(), 100_000, 100, "f").text()).contains("Name\tTotal");
            assertThat(parsers.read("pptx", Fixtures.pptx(), 100_000, 100, "f").text()).contains("First slide");
            Parsers.Text cut = parsers.read("pdf", Fixtures.pdf(5, "Row"), 100_000, 2, "f");
            assertThat(cut.cut()).isTrue();
            assertThat(cut.text()).contains("page 2").doesNotContain("page 3");
            assertThat(sidecar.connections.get()).isEqualTo(6);
            assertThat(parsers.counts()).isEqualTo(new Parsers.Counts(6, 0, 0, 0));
        }
    }

    @Test
    void aFileTheWorkerCannotReadKeepsItsReasonAndTheSidecarServesTheNext() throws Exception {
        try (TestSidecar sidecar = TestSidecar.realWorker(tmp); Parsers parsers = new Parsers(30, tmp)) {
            assertThat(reason(parsers, "docx", Fixtures.zipBomb("word/document.xml", 150)))
                    .isIn("too_complex", "unreadable");
            assertThat(reason(parsers, "pdf", Fixtures.pdfWithoutText())).isEqualTo("no_text");
            assertThat(parsers.read("text", TEXT, 100_000, 100, "f").text()).isEqualTo("Plain words");
            noChild(parsers);
        }
    }

    @Test
    void aWorkerThatRunsOutOfMemoryIsTooComplexAndTheNextFileReads() throws Exception {
        try (TestSidecar sidecar = TestSidecar.realWorker(tmp); Parsers parsers = new Parsers(30, tmp)) {
            assertThat(reason(parsers, "pdf", Fixtures.heavyPdf())).isEqualTo("too_complex");
            assertThat(parsers.read("text", TEXT, 100_000, 100, "f").text()).isEqualTo("Plain words");
            noChild(parsers);
        }
    }

    @Test
    void filesReadsAskGoesThroughTheSidecarWholeAndNotCut() throws Exception {
        AtomicReference<String> line = new AtomicReference<>();
        try (TestSidecar sidecar = TestSidecar.serving(tmp, c -> {
            byte[] all = TestSidecar.readAll(c);
            int newline = new String(all, StandardCharsets.US_ASCII).indexOf('\n');
            line.set(new String(all, 0, newline, StandardCharsets.US_ASCII));
            TestSidecar.write(c, "OK \nfine");
        }); Parsers parsers = new Parsers(30, tmp)) {
            assertThat(parsers.read("pdf", TEXT, 2_000_000, 500, "f").text()).isEqualTo("fine");
            assertThat(line.get()).isEqualTo("parse1 pdf 2000000 500");
        }
    }

    // --- the deadline's order (Security CP-I1)

    @Test
    void desksWaitForTheSidecarPastItsOwnKillAndCleanUp() throws Exception {
        // A connection always ends by desk-svc's close after -clean, never by desk-agent giving up first, so a worker that
        // took itself over can't be holding the socket when the next file goes.
        assertThat(Parsers.SIDECAR_WAIT_SECONDS).isGreaterThanOrEqualTo(Parsers.DESK_SVC_KILL_SECONDS + 3);
        Path run = Path.of("../../image/recipe/files/usr/local/lib/ma/desk-parse-run");
        org.junit.jupiter.api.Assumptions.assumeTrue(Files.isRegularFile(run), "the image recipe isn't in this tree");
        assertThat(Files.readString(run)).contains("-deadline-sec " + Parsers.DESK_SVC_KILL_SECONDS + " ");
    }

    @Test
    void aSilentSidecarIsATimeoutAtTheSidecarsWaitNotTheChildsDeadline() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        try (TestSidecar sidecar = TestSidecar.serving(tmp, c -> {
            TestSidecar.readAll(c);
            release.await(20, TimeUnit.SECONDS);
        }); Parsers parsers = new Parsers(1, tmp, 2_000, 3)) {
            long t = System.nanoTime();
            assertThat(reason(parsers, "pdf", TEXT)).isEqualTo("timeout");
            long ms = (System.nanoTime() - t) / 1_000_000;
            // 3 s (the sidecar's wait), not 1 s (the child's).
            assertThat(ms).isBetween(2_800L, 10_000L);
        } finally {
            release.countDown();
        }
    }

    // --- the marker rule: once seen, never a child

    @Test
    void theMarkerAloneMeansUnavailableAndNoChild() throws Exception {
        Files.writeString(tmp.resolve("required"), "1");
        try (Parsers parsers = new Parsers(30, tmp)) {
            assertThat(parsers.mode()).isEqualTo("sidecar");
            assertThat(reason(parsers, "text", TEXT)).isEqualTo("unavailable");
            assertThat(reason(parsers, "pdf", Fixtures.pdf(1, "x"))).isEqualTo("unavailable");
            noChild(parsers);
            assertThat(parsers.counts()).isEqualTo(new Parsers.Counts(2, 2, 0, 0));
        }
    }

    @Test
    void onceSeenTheSidecarIsUsedForTheRestOfTheProcesssLife() throws Exception {
        Path dir = tmp.resolve("desk-parse");
        try (Parsers parsers = new Parsers(30, dir)) {
            assertThat(parsers.read("text", TEXT, 100_000, 100, "f").text()).isEqualTo("Plain words");
            assertThat(parsers.counts().child()).isEqualTo(1);
            // The image's marker appears (a later boot's tmpfiles, or a mount that came late): from now on, the sidecar.
            Files.createDirectories(dir);
            Files.writeString(dir.resolve("required"), "1");
            assertThat(reason(parsers, "text", TEXT)).isEqualTo("unavailable");
            // And it goes away again: still never a child.
            Files.delete(dir.resolve("required"));
            Files.delete(dir);
            assertThat(parsers.mode()).isEqualTo("sidecar");
            assertThat(reason(parsers, "text", TEXT)).isEqualTo("unavailable");
            assertThat(parsers.counts()).isEqualTo(new Parsers.Counts(2, 2, 1, 0));
        }
    }

    @Test
    void theSocketAloneIsSeenToo() throws Exception {
        try (Parsers parsers = new Parsers(30, tmp)) {
            assertThat(parsers.mode()).isEqualTo("child");
            try (TestSidecar sidecar = TestSidecar.realWorker(tmp)) {
                assertThat(parsers.read("text", TEXT, 100_000, 100, "f").text()).isEqualTo("Plain words");
            }
            // The socket went with its sandbox: unavailable, not the child.
            assertThat(reason(parsers, "text", TEXT)).isEqualTo("unavailable");
            noChild(parsers);
        }
    }

    // --- ADR 0097's failure table

    @Test
    void aRefusedConnectionIsUnavailable() throws Exception {
        TestSidecar sidecar = TestSidecar.realWorker(tmp);
        sidecar.stop(); // the socket file stays, nothing listens
        try (Parsers parsers = new Parsers(30, tmp)) {
            assertThat(Files.exists(sidecar.socket)).isTrue();
            assertThat(reason(parsers, "text", TEXT)).isEqualTo("unavailable");
            noChild(parsers);
        }
    }

    @Test
    void aPathThatIsNotASocketIsUnavailable() throws Exception {
        Files.createDirectories(tmp.resolve("sock"));
        Files.writeString(tmp.resolve("sock/parse.sock"), "not a socket");
        try (Parsers parsers = new Parsers(30, tmp)) {
            assertThat(reason(parsers, "text", TEXT)).isEqualTo("unavailable");
            noChild(parsers);
        }
    }

    @Test
    void deniedOrAnyOtherFirstLineIsUnavailable() throws Exception {
        for (String answer : new String[] {"err denied\n", "err bad_request\n", "err exec format error\n",
                "HTTP/1.1 200 OK\r\n\r\nhi", "ERR bad_request\n", "ERR Not A Word\n", "ok\nlowercase",
                "x".repeat(200)}) {
            Path dir = Files.createTempDirectory(tmp, "d");
            try (TestSidecar sidecar = TestSidecar.serving(dir, c -> TestSidecar.write(c, answer));
                    Parsers parsers = new Parsers(30, dir)) {
                assertThat(reason(parsers, "text", TEXT)).as(answer).isEqualTo("unavailable");
                noChild(parsers);
            }
        }
    }

    @Test
    void anErrReasonFromTheWorkerIsKept() throws Exception {
        try (TestSidecar sidecar = TestSidecar.serving(tmp, c -> {
            TestSidecar.readAll(c);
            TestSidecar.write(c, "ERR encrypted\n");
        }); Parsers parsers = new Parsers(30, tmp)) {
            assertThat(reason(parsers, "pdf", TEXT)).isEqualTo("encrypted");
        }
    }

    @Test
    void aStreamThatEndsBeforeALineIsTooComplex() throws Exception {
        for (String answer : new String[] {"", "OK", "ERR too_compl"}) {
            Path dir = Files.createTempDirectory(tmp, "d");
            try (TestSidecar sidecar = TestSidecar.serving(dir, c -> {
                TestSidecar.readAll(c);
                TestSidecar.write(c, answer);
            }); Parsers parsers = new Parsers(30, dir)) {
                assertThat(reason(parsers, "text", TEXT)).as(answer).isEqualTo("too_complex");
                noChild(parsers);
            }
        }
        // A worker that ends at once, the file unread (desk-svc closing after a failed start): the same.
        Path dir = Files.createTempDirectory(tmp, "d");
        try (TestSidecar sidecar = TestSidecar.serving(dir, c -> {}); Parsers parsers = new Parsers(30, dir)) {
            assertThat(reason(parsers, "text", new byte[4 << 20])).isEqualTo("too_complex");
        }
    }

    @Test
    void busyIsTriedAgainWithinTheWindowThenSucceeds() throws Exception {
        AtomicInteger tries = new AtomicInteger();
        try (TestSidecar sidecar = TestSidecar.serving(tmp, c -> {
            if (tries.incrementAndGet() <= 2) {
                TestSidecar.write(c, "err busy\n"); // as desk-svc: at once, the request unread
                return;
            }
            TestSidecar.readAll(c);
            TestSidecar.write(c, "OK \nthird time");
        }); Parsers parsers = new Parsers(30, tmp, 5_000)) {
            assertThat(parsers.read("text", new byte[2 << 20], 100_000, 100, "f").text()).isEqualTo("third time");
            assertThat(tries.get()).isEqualTo(3);
        }
    }

    @Test
    void busyPastTheWindowIsBusy() throws Exception {
        try (TestSidecar sidecar = TestSidecar.serving(tmp, c -> TestSidecar.write(c, "err busy\n"));
                Parsers parsers = new Parsers(30, tmp, 1_000)) {
            long started = System.nanoTime();
            assertThat(reason(parsers, "text", TEXT)).isEqualTo("busy");
            long ms = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
            assertThat(ms).isBetween(500L, 3_000L);
            assertThat(sidecar.connections.get()).isGreaterThan(1);
            noChild(parsers);
        }
    }

    @Test
    void theDeadlineClosesTheConnection() throws Exception {
        CountDownLatch closed = new CountDownLatch(1);
        AtomicLong closedAt = new AtomicLong();
        try (TestSidecar sidecar = TestSidecar.serving(tmp, c -> {
            TestSidecar.readAll(c);
            // A worker still busy: nothing answered. It notices the close on its next write.
            try {
                while (true) {
                    Thread.sleep(50);
                    TestSidecar.write(c, ".");
                }
            } catch (IOException e) {
                closedAt.set(System.nanoTime());
                closed.countDown();
            }
        }); Parsers parsers = new Parsers(1, tmp, Parsers.BUSY_WINDOW_MS, 1)) {
            long started = System.nanoTime();
            assertThat(reason(parsers, "text", TEXT)).isEqualTo("timeout");
            long answered = System.nanoTime();
            assertThat(TimeUnit.NANOSECONDS.toMillis(answered - started)).isBetween(900L, 2_500L);
            assertThat(closed.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(TimeUnit.NANOSECONDS.toMillis(closedAt.get() - answered)).isLessThan(1_000L);
            noChild(parsers);
        }
    }

    @Test
    void aConnectThatHangsIsBoundByTheDeadline() throws Exception {
        // A listener that never accepts, with a full backlog: connect waits, and the deadline still ends it.
        Path sock = Files.createDirectories(tmp.resolve("sock")).resolve("parse.sock");
        try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            server.bind(UnixDomainSocketAddress.of(sock), 1);
            java.util.List<java.nio.channels.SocketChannel> filling = new java.util.ArrayList<>();
            try (Parsers parsers = new Parsers(1, tmp, Parsers.BUSY_WINDOW_MS, 1)) {
                for (int i = 0; i < 4; i++) {
                    java.nio.channels.SocketChannel fill = java.nio.channels.SocketChannel.open(StandardProtocolFamily.UNIX);
                    fill.configureBlocking(false);
                    try {
                        fill.connect(UnixDomainSocketAddress.of(sock));
                    } catch (IOException e) {
                        // The backlog is full.
                    }
                    filling.add(fill);
                }
                long started = System.nanoTime();
                assertThat(reason(parsers, "text", TEXT)).isIn("timeout", "unavailable");
                assertThat(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)).isLessThan(3_000L);
                noChild(parsers);
            } finally {
                for (var fill : filling) {
                    fill.close();
                }
            }
        }
    }
}
