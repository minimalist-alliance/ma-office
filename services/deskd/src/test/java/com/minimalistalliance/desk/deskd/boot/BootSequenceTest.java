package com.minimalistalliance.desk.deskd.boot;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.platform.DeskState;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.session.SessionAuthorizer;
import com.minimalistalliance.desk.deskd.testing.ControlPlaneRig;
import com.minimalistalliance.desk.deskd.testing.FakePlatform;
import com.minimalistalliance.desk.deskd.testing.TestTokens;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class BootSequenceTest {

    private static final String HELLO = "/v1/agent/hello";
    private static final String TAB = "ab".repeat(32);

    @TempDir
    Path dir;

    private ControlPlaneRig rig;

    @BeforeEach
    void setUp() throws Exception {
        rig = new ControlPlaneRig(dir, ControlPlaneRig.FAST_LINK, ControlPlaneRig.SLOW_BEATS);
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    private void assertSessionsRefused(String code) {
        assertThatThrownBy(() -> rig.verifier.authorizeOpen(rig.platform.tokens.mint(TAB, Instant.now())))
                .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class,
                        e -> assertThat(e.code()).isEqualTo(code));
    }

    @Test
    void theOrderIsImdsThenDeskRtcThenHelloThenGatewayThenHeartbeat() throws Exception {
        rig.bootToReady();
        Map<String, Object> configure = rig.rtc.awaitJson("configure");
        assertThat(configure).containsEntry("publicIpv4", "203.0.113.7").containsEntry("maxSessions", 4);
        rig.platform.awaitApi("/v1/agent/heartbeat");

        List<String> timeline = List.copyOf(rig.platform.timeline);
        assertThat(timeline.get(0)).isEqualTo("imds");
        assertThat(timeline.indexOf("hello")).isLessThan(timeline.indexOf("ready"));
        assertThat(timeline.indexOf("ready")).isLessThan(timeline.indexOf("heartbeat"));
        // Hello's fingerprints can only have come from configured, so desk-rtc was before hello.
        assertThat(Json.object(rig.platform.awaitHello(), "dtls"))
                .containsEntry("fingerprintsSha256", List.of("cd".repeat(32)))
                .containsEntry("notAfter", "2027-01-01T00:00:00Z");
    }

    @Test
    void helloCarriesWhatPlatformRequires() throws Exception {
        rig.bootToReady();
        Map<String, Object> hello = rig.platform.awaitHello();
        assertThat(hello)
                .containsEntry("instanceId", FakePlatform.INSTANCE_ID)
                .containsEntry("bootId", "00000000-0000-4000-8000-000000000099")
                .containsEntry("reason", "boot")
                .containsEntry("amiId", "ami-0123456789abcdef0")
                .containsEntry("runtimeVersion", "test-version")
                .containsEntry("imageVersion", "image-1")
                .containsEntry("deskApi", "1.0")
                .containsEntry("capabilities", List.of());
        assertThat(Json.object(hello, "dataVolume")).containsEntry("mounted", true).containsKeys("totalBytes", "usedBytes");
    }

    @Test
    void imdsFailuresAreRetriedAndSessionsStayRefusedUntilItsRead() throws Exception {
        rig.platform.imdsFailuresLeft.set(1_000_000);
        rig.boot.start();
        Thread.sleep(150);
        assertThat(rig.state.identity()).isNull();
        assertSessionsRefused("desk_not_ready");
        assertThat(rig.rtc.connectionCount()).isZero();
        assertThat(rig.platform.apiRequests).isEmpty();

        rig.platform.imdsFailuresLeft.set(0);
        await().atMost(Duration.ofSeconds(5)).until(rig.link::isReady);
        assertThat(rig.state.deskId()).isEqualTo(TestTokens.DESK_ID);
    }

    @Test
    void aMissingTagFailsClosedAndKeepsTrying() throws Exception {
        String deskId = rig.platform.metadata.remove("/latest/meta-data/tags/instance/DeskId");
        rig.boot.start();
        Thread.sleep(150);
        assertSessionsRefused("desk_not_ready");
        assertThat(rig.platform.apiRequests).isEmpty();
        rig.platform.metadata.put("/latest/meta-data/tags/instance/DeskId", deskId);
        await().atMost(Duration.ofSeconds(5)).until(rig.link::isReady);
    }

    @Test
    void aHelloThatFailsIsRetriedWithBackoff() throws Exception {
        rig.platform.helloReplies.add(FakePlatform.Reply.of(500, "{\"error\":{\"code\":\"internal\"}}"));
        rig.platform.helloReplies.add(FakePlatform.Reply.of(503, "{\"message\":\"Service Unavailable\"}"));
        rig.bootToReady();
        assertThat(rig.platform.countApi(HELLO)).isEqualTo(3);
    }

    @Test
    void aHelloRateLimitedIsRetriedAfterRetryAfter() throws Exception {
        rig.platform.helloReplies.add(new FakePlatform.Reply(429, "{\"message\":\"Too Many Requests\"}", Map.of("Retry-After", "1")));
        long started = System.nanoTime();
        rig.bootToReady();
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isGreaterThanOrEqualTo(Duration.ofMillis(950));
    }

    @Test
    void aRefusalFromPlatformIdlesQuietlyAndStillRecovers() throws Exception {
        rig.platform.helloReplies.add(FakePlatform.Reply.of(409, "{\"error\":{\"code\":\"invalid_state\",\"message\":\"stopping\"}}"));
        long started = System.nanoTime();
        rig.bootToReady();
        assertThat(rig.platform.countApi(HELLO)).isEqualTo(2);
        // The rig's quiet retry is 200 ms, against 20 ms for a failure.
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isGreaterThanOrEqualTo(Duration.ofMillis(190));
    }

    @Test
    void withoutConfigInHelloItFetchesConfig() throws Exception {
        rig.platform.helloCarriesConfig = false;
        rig.bootToReady();
        assertThat(rig.platform.countApi("/v1/agent/config")).isEqualTo(1);
        assertThat(rig.state.issuer()).isEqualTo(TestTokens.ISSUER);
    }

    @Test
    void anEnvWithNoApiBaseFailsClosed() throws Exception {
        try (ControlPlaneRig unknownEnv = rigWithNoApiOverride()) {
            unknownEnv.platform.metadata.put("/latest/meta-data/tags/instance/Env", "somewhere-else");
            unknownEnv.boot.start();
            Thread.sleep(150);
            assertThat(unknownEnv.state.identity()).isNull();
            assertThat(unknownEnv.state.apiBase()).isNull();
            assertThat(unknownEnv.platform.apiRequests).isEmpty();
        }
    }

    private ControlPlaneRig rigWithNoApiOverride() throws Exception {
        Path other = dir.resolve("other");
        Files.createDirectories(other);
        return ControlPlaneRig.withoutApiOverride(other);
    }

    @Test
    void aDeskRtcThatComesBackWithANewCertificateSendsHelloAgain() throws Exception {
        rig.bootToReady();
        rig.platform.awaitHello();
        rig.rtc.fingerprints(List.of("cd".repeat(32), "ef".repeat(32)));
        rig.rtc.drop();
        Map<String, Object> hello = rig.platform.awaitHello();
        assertThat(hello).containsEntry("reason", "cert_rotated");
        assertThat(Json.object(hello, "dtls")).containsEntry("fingerprintsSha256", List.of("cd".repeat(32), "ef".repeat(32)));
    }

    @Test
    void aDeskRtcThatComesBackWithTheSameCertificateNeedsNoHello() throws Exception {
        rig.bootToReady();
        rig.rtc.drop();
        await().until(rig.rtcClient::isConfigured);
        Thread.sleep(100);
        assertThat(rig.platform.countApi(HELLO)).isEqualTo(1);
    }

    @Test
    void keysAreFetchedAtBootSoTheFirstSessionDoesntPayForIt() throws Exception {
        rig.bootToReady();
        await().until(() -> rig.platform.jwksFetches.get() == 1);
        rig.verifier.authorizeOpen(rig.platform.tokens.mint(TAB, Instant.now()));
        assertThat(rig.platform.jwksFetches).hasValue(1);
    }

    @Test
    void theJwksOverrideFromDeskdEnvWinsOverConfig() {
        DeskState state = new DeskState("b", null, "http://127.0.0.1:9/jwks");
        assertThat(state.jwksUrl()).isEqualTo("http://127.0.0.1:9/jwks");
    }
}
