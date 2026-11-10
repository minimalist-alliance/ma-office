package com.minimalistalliance.desk.deskd;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.SessionEvents;
import com.minimalistalliance.desk.deskd.gateway.GatewayLink;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.Message;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcPeer;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import com.minimalistalliance.desk.deskd.rpc.RpcSession;
import com.minimalistalliance.desk.deskd.rpc.SubscriptionService;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.rtc.RtcStats;
import com.minimalistalliance.desk.deskd.testing.FakePlatform;
import com.minimalistalliance.desk.deskd.testing.TestTiming;
import java.io.IOException;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * The real deskd application against the real desk-rtc, gateway-shim and deskctl: a real Pion client,
 * real DTLS and SCTP, over UDP and ICE-TCP on loopback, tokens checked by the real verifier against
 * the shim's JWKS. Only IMDS is a fake here. Run it with services/scripts/test-against-desk-rtc.sh.
 *
 * <p>The clipboard tests need a desk-rtc with the clipboard (handoff 15 B). With {@code DESK_RTC_DISPLAY} naming an X
 * display the test may use, such as a private Xvfb, and {@code xclip} on the PATH, they also go through real X, with
 * xclip as the other client. deskctl has no clipboard, so those calls go to deskd's real dispatcher in process.
 */
@EnabledIfEnvironmentVariable(named = "DESK_RTC_DIST", matches = ".+")
class RealDeskRtcIT {

    /** The shim's defaults: gateway-shim --desk-id and --owner-id. */
    private static final String SHIM_DESK = "d-dev0000000000";
    private static final String SHIM_OWNER = "00000000-0000-4000-8000-000000000001";

    static {
        TestTiming.pollFast();
    }

    @TempDir
    Path dir;

    private final List<Process> processes = new ArrayList<>();
    private Path dist;
    private int shimPort;
    private int rtcPort;
    private FakePlatform imds;
    private ConfigurableApplicationContext context;
    private RtcClient rtc;
    private Process deskRtc;
    private final List<Process> clips = new ArrayList<>();

    @BeforeEach
    void setUp() throws Exception {
        dist = Path.of(System.getenv("DESK_RTC_DIST"));
        shimPort = freePort();
        rtcPort = freePort();
        start("gateway-shim", "--addr", "127.0.0.1:" + shimPort);
        startDeskRtc();

        imds = new FakePlatform();
        imds.metadata.put("/latest/meta-data/tags/instance/DeskId", SHIM_DESK);
        imds.metadata.put("/latest/meta-data/tags/instance/UserId", SHIM_OWNER);
        imds.metadata.put("/latest/meta-data/public-ipv4", "127.0.0.1");

        context = DeskdApplication.application().run(
                "--deskd.rtc.socket=" + dir.resolve("rtc.sock"),
                "--deskd.admin.socket=" + dir.resolve("admin.sock"),
                "--deskd.data.dir=" + dir,
                "--deskd.imds.url=" + imds.url(),
                "--deskd.api.url=http://127.0.0.1:" + shimPort);
        rtc = context.getBean(RtcClient.class);
        GatewayLink link = context.getBean(GatewayLink.class);
        await().atMost(Duration.ofSeconds(30)).until(link::isReady);
    }

    @AfterEach
    void tearDown() throws Exception {
        if (context != null) {
            context.close();
        }
        if (imds != null) {
            imds.close();
        }
        for (Process clip : clips) {
            clip.destroyForcibly();
        }
        for (Process process : processes) {
            process.destroy();
            if (!process.waitFor(5, TimeUnit.SECONDS)) {
                process.destroyForcibly();
            }
        }
    }

    @Test
    void configuredCarriesWhatHelloNeeds() {
        assertThat(rtc.rtcVersion()).isNotBlank();
        assertThat(rtc.fingerprints()).singleElement().asString().matches("[0-9a-f]{64}");
        assertThat(Instant.parse(rtc.fingerprintsNotAfter())).isAfter(Instant.now());
    }

    @Test
    void statusOverUdp() throws Exception {
        assertStatus("udp");
    }

    @Test
    void statusOverIceTcp() throws Exception {
        assertStatus("tcp");
    }

    @Test
    void aTokenBoundToAnotherCertificateIsRefused() throws Exception {
        Run run = deskctl("--bad-cnf");
        assertThat(run.exitCode()).isNotZero();
        assertThat(run.stderr()).contains("identity_mismatch");
    }

    @Test
    void statsReportWhatTheSessionsSent() throws Exception {
        assertStatus("udp");
        RtcStats[] stats = new RtcStats[1];
        Thread thread = Thread.ofVirtual().start(() -> {
            try {
                stats[0] = rtc.stats();
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        });
        thread.join(Duration.ofSeconds(10));
        assertThat(stats[0]).isNotNull();
        assertThat(stats[0].bytesSent()).isPositive();
        assertThat(stats[0].bytesReceived()).isPositive();
    }

    @Test
    void deskRtcSaysTheStreamIsDownAndKnowsSessionVideo() throws Exception {
        await().atMost(Duration.ofSeconds(10)).until(() -> "down".equals(rtc.streamState()));
        RtcStats[] stats = new RtcStats[1];
        Thread thread = Thread.ofVirtual().start(() -> {
            try {
                stats[0] = rtc.stats();
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        });
        thread.join(Duration.ofSeconds(10));
        assertThat(stats[0].stream().state()).isEqualTo("down");
        assertThat(stats[0].stream().viewers()).isZero();

        // desk-rtc logs any message type it doesn't know, and has no reply to session.video.
        rtc.setVideo("cs-nobody", true);
        rtc.setVideo("cs-nobody", false);
        Thread.sleep(200);
        assertThat(Files.readString(dir.resolve("desk-rtc.log"))).doesNotContain("ignoring unknown message");
    }

    @Test
    void aRestartOfDeskRtcEndsSessionsAndComesBack() throws Exception {
        assertStatus("udp");
        Process deskRtc = processes.remove(processes.size() - 1);
        deskRtc.destroy();
        assertThat(deskRtc.waitFor(5, TimeUnit.SECONDS)).isTrue();
        await().atMost(Duration.ofSeconds(10)).until(() -> !rtc.isConfigured());

        startDeskRtc();
        await().atMost(Duration.ofSeconds(20)).until(rtc::isConfigured);
        assertStatus("udp");
    }

    private void assertStatus(String transport) throws Exception {
        Run run = deskctl("--transport", transport, "--json");
        assertThat(run.exitCode()).as("deskctl: %s", run.stderr()).isZero();
        Map<String, Object> output = Json.parseObject(run.stdout().getBytes(StandardCharsets.UTF_8));
        assertThat(output).containsEntry("transport", transport);
        System.out.printf("deskctl over %s: setup %s ms, desk.status.get %s ms%n", transport, output.get("setupMs"), output.get("rttMs"));
        Map<String, Object> status = Json.object(output, "status");
        assertThat(status)
                .containsEntry("deskId", SHIM_DESK)
                .containsEntry("rtcVersion", rtc.rtcVersion())
                .containsEntry("instanceType", "c7g.large")
                .containsKeys("deskdVersion", "bootId", "uptimeSec");
        assertThat((String) status.get("javaVersion")).startsWith("21.");
    }

    private record Run(int exitCode, String stdout, String stderr) {}

    private Run deskctl(String... flags) throws Exception {
        List<String> command = new ArrayList<>(List.of(
                dist.resolve("deskctl").toString(), "status", "--gateway", "ws://127.0.0.1:" + shimPort + "/v1"));
        command.addAll(List.of(flags));
        Path out = Files.createTempFile(dir, "deskctl", ".out");
        Path err = Files.createTempFile(dir, "deskctl", ".err");
        Process process = new ProcessBuilder(command).redirectOutput(out.toFile()).redirectError(err.toFile()).start();
        assertThat(process.waitFor(40, TimeUnit.SECONDS)).as("deskctl finished").isTrue();
        return new Run(process.exitValue(), Files.readString(out), Files.readString(err));
    }

    private void startDeskRtc() throws IOException {
        startDeskRtc(null);
    }

    private void startDeskRtc(String display) throws IOException {
        List<String> flags = new ArrayList<>(List.of(
                "--socket", dir.resolve("rtc.sock").toString(),
                "--data-dir", dir.resolve("rtc-data").toString(),
                "--bind", "127.0.0.1",
                "--port", Integer.toString(rtcPort)));
        if (display != null) {
            flags.addAll(List.of("--display", display));
        }
        start("desk-rtc", flags.toArray(String[]::new));
        deskRtc = processes.get(processes.size() - 1);
    }

    /** desk-rtc again, on the display, and deskd connected to it. */
    private String restartDeskRtcOnTheDisplay() throws Exception {
        String display = System.getenv("DESK_RTC_DISPLAY");
        Assumptions.assumeTrue(display != null && !display.isBlank(), "DESK_RTC_DISPLAY names no X display");
        Assumptions.assumeTrue(!display.equals(":0") && !display.equals(":10"), "not a shared display");
        processes.remove(deskRtc);
        deskRtc.destroy();
        assertThat(deskRtc.waitFor(5, TimeUnit.SECONDS)).isTrue();
        await().atMost(Duration.ofSeconds(10)).until(() -> !rtc.isConfigured());
        startDeskRtc(display);
        await().atMost(Duration.ofSeconds(20)).until(rtc::isConfigured);
        return display;
    }

    // ---- the clipboard, through deskd's real dispatcher and topic, desk-rtc's xclip and real X

    /** One owner session's RPC layer, in process: deskctl can't call the clipboard. */
    private final class InProcessSession implements RpcPeer {
        final BlockingQueue<Map<String, Object>> replies = new LinkedBlockingQueue<>();
        final BlockingQueue<Map<String, Object>> events = new LinkedBlockingQueue<>();
        final SessionEvents subscriptions;
        final RpcSession rpc;
        final AtomicLong ids = new AtomicLong(1);

        InProcessSession() {
            EventHub hub = context.getBean(EventHub.class);
            subscriptions = hub.newSession();
            subscriptions.attach(new SessionEvents.Sink() {
                @Override
                public void enqueue(long subId, long seq, byte[] payload) {
                    events.add(parse(payload));
                }

                @Override
                public long queuedBytes() {
                    return 0;
                }
            });
            rpc = context.getBean(RpcDispatcher.class).newSession(this);
        }

        Map<String, Object> call(FrameKind kind, Map<String, Object> body) throws Exception {
            long id = ids.getAndIncrement();
            rpc.onMessage(new Message(kind, false, false, id, 0, Json.bytes(body)));
            Map<String, Object> reply = replies.poll(40, TimeUnit.SECONDS);
            assertThat(reply).as("a reply to %s", body.get("m")).isNotNull();
            return reply;
        }

        Map<String, Object> call(String method, Map<String, Object> params) throws Exception {
            return call(FrameKind.REQ, Map.of("m", method, "p", params));
        }

        @Override
        public boolean ready() {
            return true;
        }

        @Override
        public RpcPrincipal principal() {
            return new RpcPrincipal(SHIM_OWNER, "owner", "cs-in-process", true, true);
        }

        @Override
        public SubscriptionService subscriptions() {
            return subscriptions;
        }

        @Override
        public void send(FrameKind kind, long id, byte[] payload) {
            Map<String, Object> reply = new LinkedHashMap<>(parse(payload));
            reply.put("_kind", kind.name());
            replies.add(reply);
        }

        @Override
        public void closeRateLimited() {}

        private static Map<String, Object> parse(byte[] payload) {
            try {
                return Json.parseObject(payload);
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        }
    }

    private static void assertUnavailable(Map<String, Object> reply, String reason) {
        assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", "unavailable");
        assertThat(reply.get("details")).isEqualTo(Map.of("reason", reason));
    }

    /** xclip owning the display's CLIPBOARD with these bytes, as a page's copy would leave it. */
    private void copyWithXclip(String display, byte[] bytes) throws Exception {
        Path input = Files.write(Files.createTempFile(dir, "clip", ".in"), bytes);
        ProcessBuilder builder = new ProcessBuilder("xclip", "-selection", "clipboard", "-quiet", "-i", input.toString())
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(dir.resolve("xclip.log").toFile()));
        builder.environment().put("DISPLAY", display);
        clips.add(builder.start());
        // It owns the selection once another client can read what it holds.
        await().atMost(Duration.ofSeconds(10)).until(() -> Arrays.equals(pasteWithXclip(display), bytes));
    }

    private byte[] pasteWithXclip(String display) throws Exception {
        Path output = Files.createTempFile(dir, "clip", ".out");
        ProcessBuilder builder = new ProcessBuilder("xclip", "-selection", "clipboard", "-o", "-t", "UTF8_STRING")
                .redirectError(ProcessBuilder.Redirect.appendTo(dir.resolve("xclip.log").toFile()))
                .redirectOutput(output.toFile());
        builder.environment().put("DISPLAY", display);
        Process process = builder.start();
        assertThat(process.waitFor(20, TimeUnit.SECONDS)).isTrue();
        return Files.readAllBytes(output);
    }

    @Test
    void theClipboardWithNoDisplayIsUnavailableAtOnce() throws Exception {
        InProcessSession session = new InProcessSession();
        long started = System.nanoTime();
        assertUnavailable(session.call("browser.clipboard.write", Map.of("text", "x")), "display");
        assertUnavailable(session.call("browser.clipboard.read", Map.of()), "display");
        // desk-rtc answered no_display: deskd didn't wait out its own 15 s.
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(5));
        assertThat(Files.readString(dir.resolve("desk-rtc.log"))).doesNotContain("ignoring unknown message");
    }

    @Test
    void aMillionBytesBothWaysThroughRealX() throws Exception {
        String display = restartDeskRtcOnTheDisplay();
        InProcessSession session = new InProcessSession();
        // No character JSON escapes, or a million bytes would be over a RES's 1 MiB and the read too_large.
        String text = ("h\u00E9llo \u2603 \uD83D\uDE00 line, tab ").repeat(40_000);
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        text = new String(Arrays.copyOf(bytes, 1_000_000 - 4), StandardCharsets.UTF_8).replace("\uFFFD", "") + "abcd";
        bytes = text.getBytes(StandardCharsets.UTF_8);
        assertThat(bytes.length).isLessThanOrEqualTo(1_000_000).isGreaterThan(999_990);

        long started = System.nanoTime();
        assertThat(session.call("browser.clipboard.write", Map.of("text", text))).containsEntry("_kind", "RES");
        System.out.printf("clipboard.write of %d bytes: %d ms%n", bytes.length, Duration.ofNanos(System.nanoTime() - started).toMillis());
        assertThat(pasteWithXclip(display)).isEqualTo(bytes);
        // desk-rtc still owns it, so this read comes from its memory.
        assertThat(session.call("browser.clipboard.read", Map.of())).containsEntry("text", text);

        String copied = new StringBuilder(text).reverse().toString();
        copyWithXclip(display, copied.getBytes(StandardCharsets.UTF_8));
        started = System.nanoTime();
        assertThat(session.call("browser.clipboard.read", Map.of())).containsEntry("text", copied);
        System.out.printf("clipboard.read of %d bytes from xclip: %d ms%n", bytes.length, Duration.ofNanos(System.nanoTime() - started).toMillis());

        byte[] over = new byte[1_000_001];
        Arrays.fill(over, (byte) 'o');
        copyWithXclip(display, over);
        Map<String, Object> tooLarge = session.call("browser.clipboard.read", Map.of());
        assertThat(tooLarge).containsEntry("_kind", "ERR").containsEntry("code", "too_large");
        assertThat(tooLarge.get("details")).isEqualTo(Map.of("limit", 1_000_000));
        Map<String, Object> refused = session.call("browser.clipboard.write", Map.of("text", text + "\u2603"));
        assertThat(refused).containsEntry("code", "too_large");
        assertThat(pasteWithXclip(display)).isEqualTo(over);
    }

    @Test
    void whatAnotherClientLeftIsCleanedAndNulsGoToTheDesk() throws Exception {
        String display = restartDeskRtcOnTheDisplay();
        InProcessSession session = new InProcessSession();
        copyWithXclip(display, new byte[] {'a', 0, 'b', (byte) 0xFF, 'c', (byte) 0xE2, (byte) 0x98, '\n'});
        assertThat(session.call("browser.clipboard.read", Map.of())).containsEntry("text", "ab\uFFFDc\uFFFD\n");
        copyWithXclip(display, new byte[] {0, 0});
        assertThat(session.call("browser.clipboard.read", Map.of())).containsEntry("_kind", "RES").containsEntry("text", null);

        assertThat(session.call("browser.clipboard.write", Map.of("text", "x\0y"))).containsEntry("_kind", "RES");
        assertThat(pasteWithXclip(display)).isEqualTo("xy".getBytes(StandardCharsets.UTF_8));
    }

    @Test
    void theTopicHearsAnotherClientsCopyAndKeepsWatchingAcrossARestartOfDeskRtc() throws Exception {
        String display = restartDeskRtcOnTheDisplay();
        InProcessSession session = new InProcessSession();
        Map<String, Object> sub = session.call(FrameKind.SUB, Map.of("topic", "browser.clipboard", "params", Map.of()));
        assertThat(sub).containsEntry("_kind", "RES");
        assertThat(session.events.poll(500, TimeUnit.MILLISECONDS)).as("no first event").isNull();

        // desk-rtc dials X every 500 ms once watching, so a copy straight after may come before it's listening.
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
            copyWithXclip(display, ("copied " + System.nanoTime()).getBytes(StandardCharsets.UTF_8));
            assertThat(session.events.poll(1, TimeUnit.SECONDS)).isEqualTo(Map.of("type", "changed", "data", Map.of()));
        });
        // deskd's own write isn't a change.
        assertThat(session.call("browser.clipboard.write", Map.of("text", "mine"))).containsEntry("_kind", "RES");
        assertThat(session.events.poll(700, TimeUnit.MILLISECONDS)).isNull();

        // A new connection starts with the watch off: deskd sends it again.
        processes.remove(deskRtc);
        deskRtc.destroy();
        assertThat(deskRtc.waitFor(5, TimeUnit.SECONDS)).isTrue();
        await().atMost(Duration.ofSeconds(10)).until(() -> !rtc.isConfigured());
        startDeskRtc(display);
        await().atMost(Duration.ofSeconds(20)).until(rtc::isConfigured);
        session.events.clear();
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
            copyWithXclip(display, ("again " + System.nanoTime()).getBytes(StandardCharsets.UTF_8));
            assertThat(session.events.poll(1, TimeUnit.SECONDS)).isEqualTo(Map.of("type", "changed", "data", Map.of()));
        });

        Map<String, Object> unsub = session.call(FrameKind.UNSUB, Map.of("subId", sub.get("subId")));
        assertThat(unsub).containsEntry("_kind", "RES");
        session.events.clear();
        Thread.sleep(300);
        copyWithXclip(display, "unwatched".getBytes(StandardCharsets.UTF_8));
        assertThat(session.events.poll(1, TimeUnit.SECONDS)).isNull();
        assertThat(Files.readString(dir.resolve("desk-rtc.log"))).doesNotContain("ignoring unknown message");
    }

    private void start(String binary, String... flags) throws IOException {
        List<String> command = new ArrayList<>(List.of(dist.resolve(binary).toString()));
        command.addAll(List.of(flags));
        processes.add(new ProcessBuilder(command)
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(dir.resolve(binary + ".log").toFile()))
                .start());
    }

    private static int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }
}
