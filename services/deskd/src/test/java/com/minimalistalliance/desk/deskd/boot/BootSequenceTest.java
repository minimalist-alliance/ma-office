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

    /** Gaps between hellos at this rig's Platform, in milliseconds. */
    private static List<Long> helloGaps(ControlPlaneRig on) {
        List<Long> at = on.platform.arrivals(HELLO);
        List<Long> gaps = new java.util.ArrayList<>();
        for (int i = 1; i < at.size(); i++) {
            gaps.add(java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(at.get(i) - at.get(i - 1)));
        }
        return gaps;
    }

    @Test
    void twoDesksRefusedTogetherRetryAtDifferentTimes() throws Exception {
        // Audit D3: exact doubling steps and an exact quiet retry brought a fleet back in lockstep.
        String refusal = "{\"error\":{\"code\":\"invalid_state\",\"message\":\"stopping\"}}";
        try (ControlPlaneRig second = new ControlPlaneRig(
                Files.createDirectories(dir.resolve("second")), ControlPlaneRig.FAST_LINK, ControlPlaneRig.SLOW_BEATS)) {
            for (int i = 0; i < 8; i++) {
                rig.platform.helloReplies.add(FakePlatform.Reply.of(409, refusal));
                second.platform.helloReplies.add(FakePlatform.Reply.of(409, refusal));
            }
            rig.boot.start();
            second.boot.start();
            await().atMost(Duration.ofSeconds(15)).until(() -> rig.platform.countApi(HELLO) >= 9 && second.platform.countApi(HELLO) >= 9);
            List<Long> mine = helloGaps(rig).subList(0, 8);
            List<Long> theirs = helloGaps(second).subList(0, 8);
            // The rig's quiet retry is 200 ms: never sooner, and up to half again.
            assertThat(mine).allSatisfy(gap -> assertThat(gap).isBetween(195L, 900L));
            assertThat(theirs).allSatisfy(gap -> assertThat(gap).isBetween(195L, 900L));
            long apart = 0;
            for (int i = 0; i < 8; i++) {
                apart = Math.max(apart, Math.abs(mine.get(i) - theirs.get(i)));
            }
            // Eight pairs of draws of 0 to 100 ms, each pair within 20 ms of each other: about 1 in 3,500.
            assertThat(apart).isGreaterThan(20L);
        }
    }

    @Test
    void theSpreadIsNeverSoonerThanTheStepAndAtMostHalfAgain() {
        java.util.List<Duration> waits = new java.util.ArrayList<>();
        for (int i = 0; i < 2000; i++) {
            waits.add(BootSequence.spread(Duration.ofSeconds(60)));
        }
        assertThat(waits).allSatisfy(wait -> assertThat(wait).isBetween(Duration.ofSeconds(60), Duration.ofSeconds(90)));
        assertThat(java.util.Collections.min(waits)).isLessThan(Duration.ofSeconds(61));
        assertThat(java.util.Collections.max(waits)).isGreaterThan(Duration.ofSeconds(89));
    }

    // ---- desk-rtc that never comes up (audit D4)

    private void keepIdentity(String json) throws Exception {
        Files.writeString(rig.dataDir.resolve("rtc-identity.json"), json);
    }

    @Test
    void aDeskRtcThatNeverConfiguresStillLetsHelloTheLinkAndTheHeartbeatGoWithTheIdentityItHad() throws Exception {
        keepIdentity("{\"fingerprintsSha256\":[\"" + "cd".repeat(32) + "\"],\"notAfter\":\"2027-01-01T00:00:00Z\"}");
        rig.rtc.autoConfigure(false);
        long started = System.nanoTime();
        rig.boot.start();

        // The rig's wait for desk-rtc is 500 ms (30 s on a desk).
        Map<String, Object> hello = rig.platform.awaitHello();
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isBetween(Duration.ofMillis(450), Duration.ofSeconds(5));
        assertThat(hello).containsEntry("reason", "boot");
        assertThat(Json.object(hello, "dtls"))
                .containsEntry("fingerprintsSha256", List.of("cd".repeat(32)))
                .containsEntry("notAfter", "2027-01-01T00:00:00Z");
        await().atMost(Duration.ofSeconds(5)).until(rig.link::isReady);
        Map<String, Object> beat = rig.platform.awaitApi("/v1/agent/heartbeat").json();
        assertThat(Json.object(Json.object(beat, "health"), "checks")).containsEntry("rtc", "failing");
        assertThat(Json.object(beat, "health")).containsEntry("status", "degraded");

        // A session can't be served yet: the refusal it always got.
        assertThatThrownBy(() -> rig.sessions.open("cs-1", rig.platform.tokens.mint(TAB, Instant.now())))
                .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class, e -> assertThat(e.code()).isEqualTo("desk_not_ready"));

        // desk-rtc comes up with the same identity: no second hello, and sessions work.
        rig.rtc.autoConfigure(true);
        rig.rtc.drop();
        await().atMost(Duration.ofSeconds(5)).until(rig.rtcClient::isConfigured);
        rig.sessions.open("cs-2", rig.platform.tokens.mint(TAB, Instant.now()));
        assertThat(rig.sessions.sessionIds()).contains("cs-2");
        Thread.sleep(150);
        assertThat(rig.platform.countApi(HELLO)).isEqualTo(1);
    }

    @Test
    void aDeskRtcThatComesUpLaterWithAnotherIdentitySaysHelloAgain() throws Exception {
        keepIdentity("{\"fingerprintsSha256\":[\"" + "ab".repeat(32) + "\"],\"notAfter\":null}");
        rig.rtc.autoConfigure(false);
        rig.boot.start();
        assertThat(Json.object(rig.platform.awaitHello(), "dtls")).containsEntry("fingerprintsSha256", List.of("ab".repeat(32)));

        rig.rtc.autoConfigure(true);
        rig.rtc.drop();
        Map<String, Object> again = rig.platform.awaitHello();
        assertThat(again).containsEntry("reason", "cert_rotated");
        assertThat(Json.object(again, "dtls")).containsEntry("fingerprintsSha256", List.of("cd".repeat(32)));
        // And it's kept for the next boot.
        await().until(() -> Files.readString(rig.dataDir.resolve("rtc-identity.json")).contains("cd".repeat(32)));
    }

    @Test
    void withNoIdentityFromAnEarlierBootHelloWaitsForDeskRtc() throws Exception {
        rig.rtc.autoConfigure(false);
        rig.boot.start();
        Thread.sleep(1000);
        assertThat(rig.platform.countApi(HELLO)).isZero();

        rig.rtc.autoConfigure(true);
        rig.rtc.drop();
        assertThat(Json.object(rig.platform.awaitHello(), "dtls")).containsEntry("fingerprintsSha256", List.of("cd".repeat(32)));
        await().atMost(Duration.ofSeconds(5)).until(rig.link::isReady);
    }

    @Test
    void anIdentityKeptOnAnotherVolumeIsNoneAndOneOnThisVolumeIsUsed() throws Exception {
        // /data/desk goes with an export to another desk, whose desk-rtc has its own identity.
        Files.writeString(rig.dataDir.resolve("volume.json"), "{\"volumeId\":\"vol-0abc\",\"formattedAt\":\"2026-11-06T02:00:00Z\"}");
        keepIdentity("{\"fingerprintsSha256\":[\"" + "cd".repeat(32) + "\"],\"notAfter\":null,"
                + "\"volume\":{\"volumeId\":\"vol-0def\",\"formattedAt\":\"2026-10-01T00:00:00Z\"}}");
        rig.rtc.autoConfigure(false);
        rig.boot.start();
        Thread.sleep(1000);
        assertThat(rig.platform.countApi(HELLO)).isZero();
        rig.close();

        rig = new ControlPlaneRig(Files.createDirectories(dir.resolve("same")), ControlPlaneRig.FAST_LINK, ControlPlaneRig.SLOW_BEATS);
        Files.writeString(rig.dataDir.resolve("volume.json"), "{\"volumeId\":\"vol-0abc\",\"formattedAt\":\"2026-11-06T02:00:00Z\"}");
        keepIdentity("{\"fingerprintsSha256\":[\"" + "cd".repeat(32) + "\"],\"notAfter\":null,"
                + "\"volume\":{\"volumeId\":\"vol-0abc\",\"formattedAt\":\"2026-11-06T02:00:00Z\"}}");
        rig.rtc.autoConfigure(false);
        rig.boot.start();
        assertThat(Json.object(rig.platform.awaitHello(), "dtls")).containsEntry("fingerprintsSha256", List.of("cd".repeat(32)));
    }

    @Test
    void whatsKeptNamesTheVolume() throws Exception {
        Files.writeString(rig.dataDir.resolve("volume.json"), "{\"volumeId\":\"vol-0abc\",\"formattedAt\":null}");
        rig.bootToReady();
        await().until(() -> Files.exists(rig.dataDir.resolve("rtc-identity.json")));
        Map<String, Object> volume = Json.object(Json.parseObject(Files.readAllBytes(rig.dataDir.resolve("rtc-identity.json"))), "volume");
        assertThat(volume).containsEntry("volumeId", "vol-0abc").containsEntry("formattedAt", null);
    }

    @Test
    void theIdentityIsKeptAtTheFirstConfiguredAndAJunkFileIsNone() throws Exception {
        rig.bootToReady();
        await().until(() -> Files.exists(rig.dataDir.resolve("rtc-identity.json")));
        assertThat(Json.parseObject(Files.readAllBytes(rig.dataDir.resolve("rtc-identity.json"))))
                .containsEntry("fingerprintsSha256", List.of("cd".repeat(32)))
                .containsEntry("notAfter", "2027-01-01T00:00:00Z");
        rig.close();

        // Not deskd's: too many fingerprints, upper case, not a list. Each is none, so hello waits for desk-rtc.
        for (String junk : List.of(
                "{\"fingerprintsSha256\":[\"" + "ab".repeat(32) + "\",\"" + "cd".repeat(32) + "\",\"" + "ef".repeat(32) + "\"]}",
                "{\"fingerprintsSha256\":[\"" + "AB".repeat(32) + "\"]}",
                "{\"fingerprintsSha256\":\"" + "ab".repeat(32) + "\"}",
                "not json")) {
            Path next = dir.resolve("junk-" + Math.abs(junk.hashCode()));
            Files.createDirectories(next);
            rig = new ControlPlaneRig(next, ControlPlaneRig.FAST_LINK, ControlPlaneRig.SLOW_BEATS);
            Files.writeString(rig.dataDir.resolve("rtc-identity.json"), junk);
            rig.rtc.autoConfigure(false);
            rig.boot.start();
            Thread.sleep(800);
            assertThat(rig.platform.countApi(HELLO)).as(junk).isZero();
            rig.close();
        }
        rig = new ControlPlaneRig(Files.createDirectories(dir.resolve("last")), ControlPlaneRig.FAST_LINK, ControlPlaneRig.SLOW_BEATS);
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
