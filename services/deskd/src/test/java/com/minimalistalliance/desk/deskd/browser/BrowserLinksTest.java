package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Links out (API.md section 10): what the xdg-open stand-in sends on links.sock, what reaches a subscriber of
 * browser.links, and what's dropped and counted. The whole Browser module, with no Chromium behind it, so no tab is known.
 * The stand-in itself, the real script, is at the end.
 */
class BrowserLinksTest {

    private static final Instant NOW = Instant.parse("2026-11-11T10:00:00.700Z");
    private static final BrowserLinks.Timing TIMING = new BrowserLinks.Timing(Duration.ofSeconds(5), Duration.ofSeconds(10), 3);
    private static final Map<String, Object> PERMISSION = Map.of("reason", "permission");
    private static final Path STAND_IN = Path.of("desk-tools", "xdg-open");

    @TempDir
    Path dir;

    private BrowserRig rig;
    private Path socket;
    private final AtomicLong nanos = new AtomicLong(1_000_000_000L);
    private final MutableClock clock = new MutableClock(NOW);

    @BeforeEach
    void setUp() throws Exception {
        rig = new BrowserRig(dir, 9, BrowserRig.FAST, new CdpListener(CdpListener.PROC_TCP, CdpListener.PROC_TCP6, 9, BrowserRig.ownUid()));
        socket = dir.resolve("links.sock");
    }

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
    }

    private void serve() {
        assertThat(rig.module.serveLinks(socket, BrowserRig.ownUid(), TIMING, clock, nanos::get)).isTrue();
    }

    private TestClient subscribed(String sessionId) throws Exception {
        TestClient client = rig.connect(sessionId);
        assertThat(client.subscribe(BrowserLinks.TOPIC, null)).containsEntry("_kind", "RES");
        return client;
    }

    /** One connection to links.sock, as the stand-in makes: these bytes, then the reply's line. */
    private String send(byte[] request) throws IOException {
        try (SocketChannel channel = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            channel.connect(UnixDomainSocketAddress.of(socket));
            ByteBuffer out = ByteBuffer.wrap(request);
            while (out.hasRemaining()) {
                channel.write(out);
            }
            channel.shutdownOutput();
            return readAll(channel);
        }
    }

    private String open(String url) throws IOException {
        return send(("open " + url + "\n").getBytes(StandardCharsets.UTF_8));
    }

    /**
     * The reply's line, or what came before the end. Only up to the newline: deskd closes with what it didn't read still
     * queued, which Linux tells the peer as ECONNRESET once it has read what was sent.
     */
    private static String readAll(SocketChannel channel) throws IOException {
        ByteArrayOutputStream reply = new ByteArrayOutputStream();
        ByteBuffer in = ByteBuffer.allocate(1);
        while (channel.read(in) >= 0) {
            reply.write(in.get(0));
            in.clear();
            if (reply.toByteArray()[reply.size() - 1] == '\n') {
                break;
            }
        }
        return reply.toString(StandardCharsets.US_ASCII);
    }

    private static Map<String, Object> event(TestClient client) throws Exception {
        return client.nextJson(Channels.EVENTS, FrameKind.EVT);
    }

    private void noEvent(TestClient client) throws Exception {
        assertThat(rig.fake.pollFrame(client.handle(), Channels.EVENTS, 300)).isNull();
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> linksHealth() {
        return (Map<String, Object>) ((Map<String, Object>) rig.module.health().get("browser")).get("links");
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> droppedCounts() {
        return (Map<String, Object>) linksHealth().get("dropped");
    }

    // ---- what goes

    @Test
    void aLinkReachesTheSubscriberCleanedWithItsText() throws Exception {
        serve();
        TestClient client = subscribed("cs-1");
        assertThat(open("mailto:a@example.com?subject=Hi%20there")).isEqualTo("ok\n");
        assertThat(event(client)).isEqualTo(Map.of("type", "linkOut", "data", Map.of(
                "url", "mailto:a@example.com?subject=Hi%20there",
                "scheme", "mailto",
                "displayText", "mailto:a@example.com?subject=Hi there",
                "reason", "externalScheme",
                "at", "2026-11-11T10:00:00Z")));
        // No Chromium here, so no tab is known to be on screen, and none is named.
        assertThat(open("ZoomMtg://zoom.us/join?confno=1 2")).isEqualTo("ok\n");
        assertThat(event(client).get("data")).isEqualTo(Map.of(
                "url", "zoommtg://zoom.us/join?confno=1%202",
                "scheme", "zoommtg",
                "displayText", "zoommtg://zoom.us/join?confno=1 2",
                "reason", "externalScheme",
                "at", "2026-11-11T10:00:00Z"));
        assertThat(linksHealth()).isEqualTo(Map.of("sent", 2L, "dropped", Map.of()));
    }

    @Test
    void everySubscribedSessionHearsIt() throws Exception {
        serve();
        TestClient laptop = subscribed("cs-laptop");
        TestClient phone = subscribed("cs-phone");
        assertThat(open("tel:+15551234567")).isEqualTo("ok\n");
        assertThat(((Map<?, ?>) event(laptop).get("data")).get("url")).isEqualTo("tel:+15551234567");
        assertThat(((Map<?, ?>) event(phone).get("data")).get("url")).isEqualTo("tel:+15551234567");
    }

    // ---- who hears it

    @Test
    void onlyOwnerSessionsWithVideoAndInputMaySubscribe() throws Exception {
        serve();
        TestClient watcher = rig.connect("cs-video", true, false);
        assertThat(watcher.subscribe(BrowserLinks.TOPIC, null)).containsEntry("code", "forbidden").containsEntry("details", PERMISSION);
        TestClient typist = rig.connect("cs-input", false, true);
        assertThat(typist.subscribe(BrowserLinks.TOPIC, null)).containsEntry("code", "forbidden").containsEntry("details", PERMISSION);
        for (String other : List.of("support", "export")) {
            TestClient session = rig.open("cs-" + other, other, true, true);
            session.hello();
            assertThat(session.subscribe(BrowserLinks.TOPIC, null)).containsEntry("code", "forbidden")
                    .containsEntry("details", Map.of("reason", "scope"));
        }
        assertThat(open("tel:1")).isEqualTo("dropped nobody\n");
    }

    @Test
    void aRefreshThatTakesAwayInputEndsIt() throws Exception {
        serve();
        TestClient client = subscribed("cs-1");
        rig.refresh("cs-1", true, false, BrowserRig.fingerprintOf(client));
        assertThat(event(client)).isEqualTo(Map.of("type", "error", "data", Map.of("code", "forbidden")));
        await().atMost(Duration.ofSeconds(5)).until(() -> !rig.hub.hasSubscribers(BrowserLinks.TOPIC));
        assertThat(open("tel:1")).isEqualTo("dropped nobody\n");
    }

    @Test
    void withNobodySubscribedALinkIsDroppedAndCounted() throws Exception {
        serve();
        assertThat(open("mailto:a@example.com")).isEqualTo("dropped nobody\n");
        assertThat(droppedCounts()).isEqualTo(Map.of("nobody", 1L));
    }

    @Test
    void theTopicHasNoFirstEvent() throws Exception {
        serve();
        noEvent(subscribed("cs-1"));
    }

    // ---- what's dropped

    @Test
    void badSchemesAndBadUrlsAreDroppedCountedAndNeverPublished() throws Exception {
        serve();
        TestClient client = subscribed("cs-1");
        for (String url : List.of("javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ms-msdt:/id x",
                "/data/browser/downloads/report.pdf", "slack://open")) {
            assertThat(open(url)).as(url).isEqualTo("dropped scheme\n");
        }
        assertThat(open("mailto:")).isEqualTo("dropped url\n");
        assertThat(open("https:no-host")).isEqualTo("dropped url\n");
        assertThat(open("mailto:a@example.com?body=" + "x".repeat(LinkOut.MAX_CHARS))).isEqualTo("dropped url\n");
        noEvent(client);
        assertThat(linksHealth()).isEqualTo(Map.of("sent", 0L, "dropped", Map.of("scheme", 6L, "url", 3L)));
        assertThat(linksHealth().toString()).doesNotContain("javascript", "passwd", "mailto");
    }

    @Test
    void theSameLinkTwiceWithinFiveSecondsGoesOnce() throws Exception {
        serve();
        TestClient client = subscribed("cs-1");
        assertThat(open("tel:+15551234567")).isEqualTo("ok\n");
        assertThat(open("tel:+15551234567")).isEqualTo("dropped repeat\n");
        nanos.addAndGet(TimeUnit.MILLISECONDS.toNanos(4900));
        assertThat(open("tel:+15551234567")).isEqualTo("dropped repeat\n");
        nanos.addAndGet(TimeUnit.MILLISECONDS.toNanos(200));
        assertThat(open("tel:+15551234567")).isEqualTo("ok\n");
        event(client);
        event(client);
        noEvent(client);
        assertThat(droppedCounts()).isEqualTo(Map.of("repeat", 2L));
    }

    @Test
    void atMostThreeInTenSeconds() throws Exception {
        serve();
        TestClient client = subscribed("cs-1");
        for (int i = 1; i <= 3; i++) {
            assertThat(open("tel:" + i)).isEqualTo("ok\n");
            nanos.addAndGet(TimeUnit.SECONDS.toNanos(1));
        }
        assertThat(open("tel:4")).isEqualTo("dropped rate\n");
        nanos.addAndGet(TimeUnit.MILLISECONDS.toNanos(6900));
        assertThat(open("tel:5")).isEqualTo("dropped rate\n");
        // Ten seconds after the first, it's out of the window, and one more may go.
        nanos.addAndGet(TimeUnit.MILLISECONDS.toNanos(100));
        assertThat(open("tel:6")).isEqualTo("ok\n");
        assertThat(open("tel:7")).isEqualTo("dropped rate\n");
        for (String url : List.of("tel:1", "tel:2", "tel:3", "tel:6")) {
            assertThat(((Map<?, ?>) event(client).get("data")).get("url")).isEqualTo(url);
        }
        noEvent(client);
        assertThat(linksHealth()).isEqualTo(Map.of("sent", 4L, "dropped", Map.of("rate", 3L)));
    }

    // ---- the socket's protocol

    @Test
    void whatIsntOneOpenLineIsARequestDrop() throws Exception {
        serve();
        TestClient client = subscribed("cs-1");
        assertThat(send("bogus tel:1\n".getBytes(StandardCharsets.US_ASCII))).isEqualTo("dropped request\n");
        assertThat(send("OPEN tel:1\n".getBytes(StandardCharsets.US_ASCII))).isEqualTo("dropped request\n");
        assertThat(send("open tel:1".getBytes(StandardCharsets.US_ASCII))).isEqualTo("dropped request\n");
        assertThat(send(new byte[0])).isEqualTo("dropped request\n");
        assertThat(send(new byte[] {'o', 'p', 'e', 'n', ' ', 't', 'e', 'l', ':', (byte) 0xC3, '\n'})).isEqualTo("dropped request\n");
        byte[] tooLong = ("open tel:" + "1".repeat(LinkSocket.MAX_LINE) + "\n").getBytes(StandardCharsets.US_ASCII);
        assertThat(send(tooLong)).isEqualTo("dropped request\n");
        noEvent(client);
        assertThat(droppedCounts()).isEqualTo(Map.of("request", 6L));
        // Only what comes before the newline counts.
        assertThat(send("open tel:1\nopen tel:2\n".getBytes(StandardCharsets.US_ASCII))).isEqualTo("ok\n");
        assertThat(((Map<?, ?>) event(client).get("data")).get("url")).isEqualTo("tel:1");
        noEvent(client);
    }

    @Test
    void aUrlInUtf8IsEncodedOnTheWay() throws Exception {
        serve();
        TestClient client = subscribed("cs-1");
        assertThat(open("mailto:müller@example.com")).isEqualTo("ok\n");
        assertThat(((Map<?, ?>) event(client).get("data")).get("url")).isEqualTo("mailto:m%C3%BCller@example.com");
    }

    @Test
    void aPeerThatIsntChromiumsUserIsRefused() throws Exception {
        assertThat(rig.module.serveLinks(socket, BrowserRig.ownUid() + 1, TIMING, clock, nanos::get)).isTrue();
        TestClient client = subscribed("cs-1");
        assertThat(open("tel:1")).isEqualTo("dropped peer\n");
        noEvent(client);
        assertThat(droppedCounts()).isEqualTo(Map.of("peer", 1L));
    }

    @Test
    void theSocketIsOnlyForItsOwnerAndGroup() throws Exception {
        serve();
        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(socket))).isEqualTo("rw-rw----");
        assertThat(Files.exists(dir.resolve("links.sock.new"))).isFalse();
    }

    @Test
    void aStaleSocketIsReplacedAndClosingRemovesIt() throws Exception {
        Files.writeString(socket, "stale");
        serve();
        assertThat(Files.readAttributes(socket, java.nio.file.attribute.BasicFileAttributes.class).isOther()).isTrue();
        rig.close();
        rig = null;
        assertThat(Files.exists(socket)).isFalse();
    }

    @Test
    void withNoDirectoryThereIsNoSocketAndNoTopic() throws Exception {
        assertThat(rig.module.serveLinks(dir.resolve("none").resolve("links.sock"), BrowserRig.ownUid())).isFalse();
        TestClient client = rig.connect("cs-1");
        assertThat(client.subscribe(BrowserLinks.TOPIC, null)).containsEntry("code", "not_found");
        assertThat(rig.module.health().get("browser").toString()).doesNotContain("links");
    }

    /** A peer that never sends its line holds a slot only until the timeout, and four of them hold back no one for long. */
    @Test
    void aSilentPeerIsCutOffAndTheSlotsComeBack() throws Exception {
        List<String> offered = new ArrayList<>();
        LinkSocket.Sink sink = new LinkSocket.Sink() {
            @Override
            public synchronized String offer(String url) {
                offered.add(url);
                return BrowserLinks.SENT;
            }

            @Override
            public String refused(String reason) {
                return reason;
            }
        };
        Path other = dir.resolve("direct.sock");
        try (LinkSocket server = new LinkSocket(other, BrowserRig.ownUid(), sink, Duration.ofMillis(400))) {
            server.start();
            List<SocketChannel> silent = new ArrayList<>();
            try {
                for (int i = 0; i < LinkSocket.MAX_CONNECTIONS; i++) {
                    SocketChannel channel = SocketChannel.open(StandardProtocolFamily.UNIX);
                    channel.connect(UnixDomainSocketAddress.of(other));
                    silent.add(channel);
                }
                // Each is answered when its time is up, and closed.
                for (SocketChannel channel : silent) {
                    assertThat(readAll(channel)).isIn("", "dropped request\n");
                }
            } finally {
                for (SocketChannel channel : silent) {
                    channel.close();
                }
            }
            socket = other;
            await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(open("tel:1")).isEqualTo("ok\n"));
            assertThat(offered).contains("tel:1");
        }
    }

    // ---- the stand-in, the real script

    private static boolean hasPython() {
        return Files.isExecutable(Path.of("/usr/bin/python3")) && Files.isRegularFile(STAND_IN);
    }

    private record Run(int exit, String stderr) {}

    /** The stand-in as Chromium runs it, by this name, with these arguments, pointed at the test's socket. */
    private Run standIn(Path script, String... args) throws Exception {
        List<String> command = new ArrayList<>(List.of("/usr/bin/python3", "-I", script.toString()));
        command.addAll(List.of(args));
        ProcessBuilder builder = new ProcessBuilder(command).redirectOutput(ProcessBuilder.Redirect.DISCARD);
        builder.environment().put("MA_LINKS_SOCKET", socket.toString());
        Process process = builder.start();
        String stderr = new String(process.getErrorStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(process.waitFor(20, TimeUnit.SECONDS)).isTrue();
        return new Run(process.exitValue(), stderr);
    }

    @Test
    void theStandInHandsDeskdTheUrlAndSaysHowItWent() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(hasPython(), "needs /usr/bin/python3 and desk-tools/xdg-open");
        serve();
        TestClient client = subscribed("cs-1");
        assertThat(standIn(STAND_IN, "zoommtg://zoom.us/join?confno=123")).isEqualTo(new Run(0, ""));
        assertThat(((Map<?, ?>) event(client).get("data")).get("url")).isEqualTo("zoommtg://zoom.us/join?confno=123");
        // Chromium runs xdg-email for mailto: the same file, by another name.
        Path email = dir.resolve("xdg-email");
        Files.createSymbolicLink(email, STAND_IN.toAbsolutePath());
        assertThat(standIn(email, "mailto:a@example.com").exit()).isZero();
        assertThat(((Map<?, ?>) event(client).get("data")).get("scheme")).isEqualTo("mailto");
        // Dropped: 4, and the reason, never the URL.
        Run dropped = standIn(STAND_IN, "javascript:secret-thing");
        assertThat(dropped.exit()).isEqualTo(4);
        assertThat(dropped.stderr()).contains("dropped scheme").doesNotContain("secret-thing");
        noEvent(client);
    }

    @Test
    void theStandInTakesExactlyOneUrlAndSendsNothingElse() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(hasPython(), "needs /usr/bin/python3 and desk-tools/xdg-open");
        serve();
        TestClient client = subscribed("cs-1");
        assertThat(standIn(STAND_IN).exit()).isEqualTo(1);
        assertThat(standIn(STAND_IN, "tel:1", "tel:2").exit()).isEqualTo(1);
        assertThat(standIn(STAND_IN, "--help").exit()).isEqualTo(1);
        assertThat(standIn(STAND_IN, "").exit()).isEqualTo(1);
        assertThat(standIn(STAND_IN, "tel:1\nopen tel:2").exit()).isEqualTo(1);
        noEvent(client);
        assertThat(linksHealth()).isEqualTo(Map.of("sent", 0L, "dropped", Map.of()));
    }

    @Test
    void theStandInWithNoDeskdListeningSaysSoQuickly() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(hasPython(), "needs /usr/bin/python3 and desk-tools/xdg-open");
        long start = System.nanoTime();
        Run run = standIn(STAND_IN, "tel:+15551234567");
        assertThat(run.exit()).isEqualTo(3);
        assertThat(run.stderr()).doesNotContain("5551234567");
        assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofSeconds(5));
    }
}
