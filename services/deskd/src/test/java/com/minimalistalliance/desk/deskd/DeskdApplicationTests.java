package com.minimalistalliance.desk.deskd;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.data.DataModule;
import com.minimalistalliance.desk.deskd.gateway.GatewayLink;
import com.minimalistalliance.desk.deskd.platform.DeskState;
import com.minimalistalliance.desk.deskd.platform.HeartbeatLoop;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.session.SessionAuthorizer;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import com.minimalistalliance.desk.deskd.testing.FakeDataHelper;
import com.minimalistalliance.desk.deskd.testing.FakeDeskRtc;
import com.minimalistalliance.desk.deskd.testing.FakeGateway;
import com.minimalistalliance.desk.deskd.testing.FakePlatform;
import com.minimalistalliance.desk.deskd.testing.StubUnitsSocket;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.testing.TestTiming;
import com.minimalistalliance.desk.deskd.testing.TestTokens;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.context.ConfigurableApplicationContext;

/** Boots the real application, as main does, and drives it through its real sockets. */
@ExtendWith(OutputCaptureExtension.class)
class DeskdApplicationTests {

    private static final String TAB = "ab".repeat(32);

    static {
        TestTiming.pollFast();
    }

    @TempDir
    Path dir;

    @Test
    void bootsAndReportsReady(CapturedOutput output) throws Exception {
        assertBootsAndReportsReady(output, dir);
    }

    @Test
    void endToEndFromSessionOpenThroughSignalHelloAndStatus(CapturedOutput output) throws Exception {
        assertEndToEnd(output, dir);
    }

    /** SIGTERM's other path: Platform has said the desk is stopping, so clients can stop retrying. */
    @Test
    void sigtermAfterPrepareStopClosesWith4503() throws Exception {
        try (FakePlatform platform = new FakePlatform();
                FakeGateway gateway = new FakeGateway(platform.timeline);
                FakeDeskRtc rtc = new FakeDeskRtc(dir.resolve("rtc.sock"))) {
            rtc.autoStats(true);
            platform.heartbeatReplies.add(FakePlatform.Reply.of(200, platform.heartbeatReply(List.of("prepare_stop"))));
            try (ConfigurableApplicationContext context = bootAgainst(platform, gateway, dir)) {
                await().atMost(Duration.ofSeconds(20)).until(context.getBean(HeartbeatLoop.class)::prepareStopSeen);
                String sessionId = "cs-stopping";
                gateway.send(message("session.open", "sessionId", sessionId, "deskToken", platform.tokens.mint(TAB, Instant.now())));
                assertThat(gateway.await("session.accept")).containsEntry("sessionId", sessionId);
                gateway.send(message("signal", "sessionId", sessionId, "data", Map.of("type", "offer", "sdp", TestClient.offerFor(TAB))));
                gateway.await("signal");
                TestClient client = new TestClient(rtc, 1);
                client.hello();

                context.close();
                Map<String, Object> close = client.nextJson(Channels.CTL, FrameKind.CLOSE);
                assertThat(close).containsEntry("code", 4503).containsEntry("reason", "desk_stopping");
                assertThat(rtc.awaitJson("session.close")).containsEntry("code", 4503).containsEntry("reason", "desk_stopping");
                assertThat(gateway.await("session.close")).containsEntry("reason", "desk_stopping");
            }
        }
    }

    @Test
    void aRefusedChromiumAndTheVolumeRecordThroughTheRealWiring() throws Exception {
        assertRefusedChromiumAndVolumeRecord(dir);
    }

    /**
     * The configuration's own wiring: a refused start, as desk-units words it, reaches the client's error, the real
     * /health with its status unchanged, and the last heartbeat, which also has the volume's record. There's no way to
     * hurry a heartbeat here, as the real timing has them 16 s apart at the least, and the last one is built as any
     * other is.
     */
    static void assertRefusedChromiumAndVolumeRecord(Path dir) throws Exception {
        String startBrowser = "start desk-browser";
        Files.writeString(dir.resolve("volume.json"), "{\"volumeId\":\"vol-0abc123\",\"formattedAt\":\"2026-11-06T02:00:00Z\",\"image\":\"0.2.3\"}\n");
        try (FakePlatform platform = new FakePlatform();
                FakeGateway gateway = new FakeGateway(platform.timeline);
                FakeDeskRtc rtc = new FakeDeskRtc(dir.resolve("rtc.sock"));
                StubUnitsSocket units = new StubUnitsSocket(dir.resolve("units.sock"))) {
            rtc.autoStats(true);
            try (ConfigurableApplicationContext context = bootAgainst(platform, gateway, dir)) {
                await().atMost(Duration.ofSeconds(20)).until(context.getBean(GatewayLink.class)::isReady);
                assertThat(health(dir)).doesNotContain("\"chromium\"");

                String sessionId = "cs-refused";
                gateway.send(message("session.open", "sessionId", sessionId, "deskToken", platform.tokens.mint(TAB, Instant.now())));
                gateway.await("session.accept");
                gateway.send(message("signal", "sessionId", sessionId, "data", Map.of("type", "offer", "sdp", TestClient.offerFor(TAB))));
                gateway.await("signal");
                TestClient client = new TestClient(rtc, 1);
                client.hello();

                units.reply(
                        startBrowser,
                        "err failed start desk-browser: desk-browser-start: REFUSING TO START, profile left untouched: profile last ran "
                                + "Chromium 157.0.0.0, newer than the installed 156.0.8078.79. Update Chromium; never remove the profile (ADR 0035)");
                Map<String, Object> reply = client.call("browser.stream.set", Map.of("state", "live"));
                assertThat(reply)
                        .containsEntry("code", "unavailable")
                        .containsEntry("details", Map.of("unit", "desk-browser", "code", "failed", "reason", "chromium_older_than_profile"));
                assertThat(health(dir))
                        .contains("200 OK", "\"status\":\"ok\"", "\"chromium\":\"older_than_profile\"")
                        .doesNotContain("REFUSING", "157.0.0.0");
                // Beside units.sock, which is where the configuration puts it.
                await().until(() -> Files.exists(dir.resolve("chromium-refused")));
                String version = context.getEnvironment().getProperty("deskd.version");
                assertThat(version).isNotBlank();
                assertThat(health(dir)).contains("\"version\":\"" + version + "\"");

                context.close();
                Map<String, Object> last = platform.apiRequests.stream()
                        .filter(request -> "/v1/agent/heartbeat".equals(request.path()))
                        .map(FakePlatform.Request::json)
                        .filter(body -> Boolean.TRUE.equals(body.get("final")))
                        .findFirst()
                        .orElseThrow();
                assertThat(Json.object(last, "health")).containsEntry("status", "degraded");
                assertThat(Json.object(Json.object(last, "health"), "checks")).containsEntry("chromium", "older_than_profile");
                // ADR 0078, DE-2: /health's own version and answer, which a refused Chromium doesn't change.
                assertThat(Json.object(last, "deskd")).isEqualTo(Map.of("version", version, "status", "ok"));
                assertThat(Json.object(last, "dataVolume"))
                        .containsOnlyKeys("totalBytes", "usedBytes", "volumeId", "formattedAt")
                        .containsEntry("volumeId", "vol-0abc123")
                        .containsEntry("formattedAt", "2026-11-06T02:00:00Z");
                assertThat(Json.object(platform.awaitHello(), "dataVolume")).doesNotContainKeys("volumeId", "formattedAt");
            }
        }
    }

    @Test
    void thePauseAndTheFreeBudgetThroughTheRealWiring() throws Exception {
        assertPauseAndFreeBudget(dir);
    }

    /**
     * The configuration's own wiring: the Platform's pause, from the config, refuses an owner's data.read and not an
     * export's, whose bytes reach the last heartbeat and the budget's file in the data directory.
     */
    static void assertPauseAndFreeBudget(Path dir) throws Exception {
        String exportTab = "cd".repeat(32);
        byte[] bytes = new byte[100_000];
        try (FakePlatform platform = new FakePlatform();
                FakeGateway gateway = new FakeGateway(platform.timeline);
                FakeDeskRtc rtc = new FakeDeskRtc(dir.resolve("rtc.sock"));
                FakeDataHelper helper = new FakeDataHelper(dir.resolve("data.sock"))) {
            rtc.autoStats(true);
            helper.part("files", "Files");
            helper.file("files", "a.bin", bytes);
            Instant resumesAt = Instant.now().plus(Duration.ofDays(2)).truncatedTo(ChronoUnit.SECONDS);
            platform.streaming = Map.of("streamProfile", "paused", "resumesAt", resumesAt.toString());
            try (ConfigurableApplicationContext context = bootAgainst(platform, gateway, dir)) {
                await().atMost(Duration.ofSeconds(20)).until(context.getBean(GatewayLink.class)::isReady);
                Map<String, Object> read = Map.of("part", "files", "path", "a.bin");

                gateway.send(message("session.open", "sessionId", "cs-owner", "deskToken", platform.tokens.mint(TAB, Instant.now())));
                gateway.await("session.accept");
                gateway.send(message("signal", "sessionId", "cs-owner", "data", Map.of("type", "offer", "sdp", TestClient.offerFor(TAB))));
                gateway.await("signal");
                TestClient owner = new TestClient(rtc, 1);
                owner.hello();
                Map<String, Object> refused = owner.call("data.read", read);
                assertThat(refused).containsEntry("code", "unavailable");
                assertThat(refused).containsEntry("details", Map.of("reason", "bandwidth_limit", "resumesAt", resumesAt.toString()));

                Map<String, Object> claims = platform.tokens.claims(exportTab, Instant.now());
                claims.put("scope", "export");
                gateway.send(message("session.open", "sessionId", "cs-export", "deskToken", platform.tokens.es256(TestTokens.header(), claims)));
                gateway.await("session.accept");
                gateway.send(message("signal", "sessionId", "cs-export", "data", Map.of("type", "offer", "sdp", TestClient.offerFor(exportTab))));
                gateway.await("signal");
                TestClient export = new TestClient(rtc, 2);
                export.hello();
                assertThat(export.call("data.read", read)).containsEntry("_kind", "RES").containsEntry("size", bytes.length);
                long frameBytes = 0;
                while (true) {
                    Frame frame = export.next(Channels.BULK);
                    frameBytes += Frame.HEADER_BYTES + frame.payload().length;
                    if ((frame.flags() & Frame.END) != 0) {
                        break;
                    }
                }
                long sent = frameBytes;
                await().atMost(Duration.ofSeconds(5)).until(() -> context.getBean(DataModule.class).freeBytesSent() == sent);

                context.close();
                Map<String, Object> saved = Json.parseObject(Files.readAllBytes(dir.resolve("free-export.json")));
                assertThat(((Number) saved.get("usedBytes")).longValue()).isEqualTo(sent);
                Map<String, Object> last = platform.apiRequests.stream()
                        .filter(request -> "/v1/agent/heartbeat".equals(request.path()))
                        .map(FakePlatform.Request::json)
                        .filter(body -> Boolean.TRUE.equals(body.get("final")))
                        .findFirst()
                        .orElseThrow();
                assertThat(((Number) Json.object(last, "media").get("freeBytesSent")).longValue()).isEqualTo(sent);
            }
        }
    }

    @Test
    void theAgeBandThroughTheRealWiring() throws Exception {
        assertAgeBandWiring(dir);
    }

    /**
     * The configuration's own wiring of the teen lock, which no rig can stand in for: a desk with no band on disk and a
     * Platform that can't read the membership gates the Browser and the Agent, and the band's arrival writes the file in
     * the data directory, starts the {@code live} that was waiting, and shuts the Agent.
     */
    static void assertAgeBandWiring(Path dir) throws Exception {
        String startBrowser = "start desk-browser";
        try (FakePlatform platform = new FakePlatform();
                FakeGateway gateway = new FakeGateway(platform.timeline);
                FakeDeskRtc rtc = new FakeDeskRtc(dir.resolve("rtc.sock"));
                StubUnitsSocket units = new StubUnitsSocket(dir.resolve("units.sock"))) {
            rtc.autoStats(true);
            platform.helloOmitsAgeBand = true;
            for (int i = 0; i < 1000; i++) {
                platform.configReplies.add(FakePlatform.Reply.of(503, "{\"error\":{\"code\":\"service_unavailable\",\"message\":\"no\"}}"));
            }
            try (ConfigurableApplicationContext context = bootAgainst(platform, gateway, dir)) {
                await().atMost(Duration.ofSeconds(20)).until(context.getBean(GatewayLink.class)::isReady);
                String sessionId = "cs-teen";
                gateway.send(message("session.open", "sessionId", sessionId, "deskToken", platform.tokens.mint(TAB, Instant.now())));
                gateway.await("session.accept");
                gateway.send(message("signal", "sessionId", sessionId, "data", Map.of("type", "offer", "sdp", TestClient.offerFor(TAB))));
                gateway.await("signal");
                TestClient client = new TestClient(rtc, 1);
                client.hello();

                Map<String, Object> waiting = Map.of("reason", "age_band");
                assertThat(client.call("browser.stream.set", Map.of("state", "live")))
                        .containsEntry("code", "unavailable")
                        .containsEntry("details", waiting);
                assertThat(client.call("agent.list", Map.of())).containsEntry("code", "unavailable").containsEntry("details", waiting);
                assertThat(client.subscribe("agent.state", null)).containsEntry("code", "unavailable").containsEntry("details", waiting);
                assertThat(units.requests()).doesNotContain(startBrowser);
                assertThat(health(dir)).contains("\"ageGate\":\"closed\"");
                assertThat(dir.resolve("age-band")).doesNotExist();

                platform.configReplies.clear();
                platform.ageBand = "teen";
                await().atMost(Duration.ofSeconds(40)).until(() -> Files.exists(dir.resolve("age-band")));
                assertThat(Files.readAllBytes(dir.resolve("age-band"))).containsExactly('t', 'e', 'e', 'n', '\n');
                await().atMost(Duration.ofSeconds(20)).until(() -> units.requests().contains(startBrowser));
                assertThat(rtc.awaitJson("session.video")).containsEntry("view", true);
                assertThat(client.call("agent.list", Map.of()))
                        .containsEntry("code", "forbidden")
                        .containsEntry("details", waiting);
                assertThat(health(dir)).doesNotContain("ageGate");
            }
        }
    }

    @Test
    void withoutIdentityTheApplicationKeepsRunningAndRefusesSessions() throws Exception {
        try (FakePlatform platform = new FakePlatform();
                FakeDeskRtc rtc = new FakeDeskRtc(dir.resolve("rtc.sock"))) {
            platform.imdsFailuresLeft.set(1_000_000);
            try (ConfigurableApplicationContext context = DeskdApplication.application().run(args(dir, platform))) {
                assertThat(health(dir)).contains("200 OK", "\"rtc\":\"disconnected\"", "\"platform\":\"degraded\"");
                assertThatThrownBy(() -> context.getBean(SessionManager.class).open("cs-1", platform.tokens.mint(TAB, Instant.now())))
                        .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class,
                                e -> assertThat(e.code()).isEqualTo("desk_not_ready"));
                assertThat(platform.apiRequests).isEmpty();
            }
        }
    }

    @Test
    void withoutDeskRtcHealthStays200AndNothingElseMoves() throws Exception {
        try (FakePlatform platform = new FakePlatform();
                ConfigurableApplicationContext context = DeskdApplication.application().run(args(dir, platform))) {
            await().until(() -> context.getBean(DeskState.class).identity() != null);
            assertThat(health(dir)).contains("200 OK", "\"status\":\"ok\"", "\"rtc\":\"disconnected\"", "\"platform\":\"degraded\"");
            Thread.sleep(100);
            assertThat(platform.apiRequests).isEmpty();
        }
    }

    @Test
    void healthIs503OnlyWhenTheDataDirectoryIsMissingOrUnwritable() throws Exception {
        Path data = dir.resolve("data-desk");
        Files.createDirectories(data);
        String[] args = {
            "--deskd.rtc.socket=" + dir.resolve("rtc.sock"),
            "--deskd.admin.socket=" + dir.resolve("admin.sock"),
            "--deskd.data.dir=" + data,
            "--deskd.imds.url=http://127.0.0.1:1",
        };
        try (ConfigurableApplicationContext context = DeskdApplication.application().run(args)) {
            assertThat(health(dir)).contains("200 OK");
            Files.delete(data);
            assertThat(health(dir)).contains("503 ", "\"status\":\"failing\"");
        }
    }

    static String[] args(Path dir, FakePlatform platform) {
        return new String[] {
            "--deskd.rtc.socket=" + dir.resolve("rtc.sock"),
            "--deskd.admin.socket=" + dir.resolve("admin.sock"),
            "--deskd.data.dir=" + dir,
            "--deskd.imds.url=" + platform.url(),
            "--deskd.api.url=" + platform.url(),
            "--deskd.units.socket=" + dir.resolve("units.sock"),
            "--deskd.data.socket=" + dir.resolve("data.sock"),
            "--deskd.cdp.port=1",
        };
    }

    static void assertBootsAndReportsReady(CapturedOutput output, Path dir) throws Exception {
        try (FakePlatform platform = new FakePlatform();
                ConfigurableApplicationContext context = DeskdApplication.application().run(args(dir, platform))) {
            assertThat(context.getBean(ReadinessReporter.class).readyMillis()).isNotNegative();
            assertThat(dir.resolve("admin.sock")).exists();
        }
        assertThat(output.getOut().lines().filter(line -> line.contains("deskd ready in")))
                .singleElement()
                .asString()
                .containsPattern("deskd ready in \\d+ ms$");
        assertThat(dir.resolve("admin.sock")).doesNotExist();
    }

    /**
     * The walking skeleton with everything real but the far ends: fake IMDS, API, JWKS, gateway and
     * desk-rtc on real sockets, and a real ES256 token. session.open, signal, session.create, DATA
     * HELLO and desk.status.get, then SIGTERM's path.
     */
    static void assertEndToEnd(CapturedOutput output, Path dir) throws Exception {
        try (FakePlatform platform = new FakePlatform();
                FakeGateway gateway = new FakeGateway(platform.timeline);
                FakeDeskRtc rtc = new FakeDeskRtc(dir.resolve("rtc.sock"));
                ConfigurableApplicationContext context = bootAgainst(platform, gateway, dir)) {
            GatewayLink link = context.getBean(GatewayLink.class);
            await().atMost(Duration.ofSeconds(20)).until(link::isReady);
            assertThat(rtc.awaitJson("configure")).containsEntry("maxSessions", 4).containsEntry("publicIpv4", "203.0.113.7");
            assertThat(context.getBean(RtcClient.class).isConfigured()).isTrue();
            assertThat(health(dir)).contains("200 OK", "\"status\":\"ok\"", "\"rtc\":\"connected\"", "\"platform\":\"ok\"");

            Map<String, Object> hello = platform.awaitHello();
            assertThat(hello).containsEntry("instanceId", FakePlatform.INSTANCE_ID);
            assertThat(gateway.upgrades.poll().protocol()).isEqualTo("ma.gw.v1");

            String sessionId = "cs-m4k7q2x5v3a6b2c7";
            gateway.send(message("session.open", "sessionId", sessionId, "deskToken", platform.tokens.mint(TAB, Instant.now())));
            assertThat(gateway.await("session.accept")).containsEntry("sessionId", sessionId);

            gateway.send(message("signal", "sessionId", sessionId, "data", Map.of("type", "offer", "sdp", TestClient.offerFor(TAB))));
            assertThat(Json.object(gateway.await("signal"), "data")).containsEntry("type", "answer").containsEntry("sdp", "v=0 answer for test");
            assertThat(rtc.awaitJson("session.create"))
                    .containsEntry("sessionId", sessionId)
                    .containsEntry("expectedFingerprint", TAB);

            TestClient client = new TestClient(rtc, 1);
            Map<String, Object> serverHello = client.hello();
            assertThat(serverHello)
                    .containsEntry("deskApi", "1.0")
                    .containsEntry("sessionId", sessionId)
                    .containsEntry("deskId", TestTokens.DESK_ID)
                    .containsEntry("service", "deskd")
                    .containsEntry("runtime", "java-21");
            assertThat((String) serverHello.get("version")).isNotEqualTo("unknown").doesNotContain("@");

            Map<String, Object> status = client.call("desk.status.get", Map.of());
            assertThat(status)
                    .containsEntry("_kind", "RES")
                    .containsEntry("deskId", TestTokens.DESK_ID)
                    .containsEntry("deskdVersion", serverHello.get("version"))
                    .containsEntry("rtcVersion", "fake-rtc-1")
                    .containsEntry("instanceType", "c7g.large")
                    .containsKey("uptimeSec");
            assertThat((String) status.get("javaVersion")).startsWith("21.");
            assertThat((String) status.get("bootId")).isNotBlank();

            // The Browser is wired, and neither its units nor Chromium being absent gets anywhere near health.
            assertThat(client.call("browser.tab.list", Map.of()))
                    .containsEntry("_kind", "ERR")
                    .containsEntry("code", "unavailable")
                    .containsEntry("details", Map.of("reason", "chromium"));
            assertThat(client.call("browser.stream.set", Map.of("state", "warm")))
                    .containsEntry("code", "unavailable")
                    .containsEntry("details", Map.of("unit", "desk-stream", "code", "unreachable"));
            assertThat(health(dir)).contains("200 OK", "\"status\":\"ok\"", "\"browser\":{\"cdp\":", "\"stream\":{\"wanted\":\"off\"");

            // SIGTERM's path, with no prepare_stop seen, so a restart: the client hears 4002, desk-rtc
            // and the gateway hear the close, and Platform gets a last heartbeat, all well inside the
            // 5 s budget.
            long started = System.nanoTime();
            context.close();
            assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(5));
            Map<String, Object> close = client.nextJson(Channels.CTL, FrameKind.CLOSE);
            assertThat(close).containsEntry("code", 4002).containsEntry("reason", "deskd_restarting");
            assertThat(rtc.awaitJson("session.close")).containsEntry("code", 4002);
            assertThat(gateway.await("session.close")).containsEntry("reason", "closed_by_desk");
            assertThat(platform.apiRequests.stream()
                            .filter(request -> "/v1/agent/heartbeat".equals(request.path()))
                            .map(FakePlatform.Request::json))
                    .anyMatch(body -> Boolean.TRUE.equals(body.get("final")));
        }
        assertThat(Files.exists(dir.resolve("admin.sock"))).isFalse();
        // Nothing secret reached the log, on this path at least.
        assertThat(output.getAll()).doesNotContain(FakePlatform.SECRET_KEY, FakePlatform.SESSION_TOKEN, "eyJ");
    }

    private static ConfigurableApplicationContext bootAgainst(FakePlatform platform, FakeGateway gateway, Path dir) {
        platform.gatewayUrl = gateway.url();
        return DeskdApplication.application().run(args(dir, platform));
    }

    private static Map<String, Object> message(String type, Object... pairs) {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("type", type);
        for (int i = 0; i < pairs.length; i += 2) {
            message.put((String) pairs[i], pairs[i + 1]);
        }
        return message;
    }

    static String health(Path dir) throws IOException {
        try (SocketChannel channel = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            channel.connect(UnixDomainSocketAddress.of(dir.resolve("admin.sock")));
            channel.write(ByteBuffer.wrap("GET /health HTTP/1.1\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1)));
            ByteBuffer buffer = ByteBuffer.allocate(4096);
            while (channel.read(buffer) >= 0) {
                if (!buffer.hasRemaining()) {
                    break;
                }
            }
            return new String(buffer.array(), 0, buffer.position(), StandardCharsets.ISO_8859_1);
        }
    }

    @Test
    void theVersionComesFromTheBuild() throws Exception {
        try (var in = DeskdApplicationTests.class.getResourceAsStream("/application.properties")) {
            String properties = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            assertThat(properties).containsPattern("deskd\\.version=\\d");
        }
    }
}
