package com.minimalistalliance.desk.deskd.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.ControlPlaneRig;
import com.minimalistalliance.desk.deskd.testing.FakePlatform;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

@ExtendWith(OutputCaptureExtension.class)
class HeartbeatLoopTest {

    private static final String BEAT = "/v1/agent/heartbeat";

    @TempDir
    Path dir;

    private ControlPlaneRig rig;

    @BeforeEach
    void setUp() throws Exception {
        rig = new ControlPlaneRig(dir, ControlPlaneRig.FAST_LINK, new HeartbeatLoop.Timing(
                Duration.ofMillis(300), Duration.ofMillis(100), Duration.ofSeconds(5)));
        rig.platform.nextHeartbeatSeconds = null;
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    @Test
    void theBodyHasWhatPlatformRequires() throws Exception {
        rig.bootToReady();
        Map<String, Object> body = rig.platform.awaitApi(BEAT).json();
        assertThat(body).containsEntry("bootId", "00000000-0000-4000-8000-000000000099").containsEntry("final", false);
        assertThat(((Number) body.get("seq")).longValue()).isPositive();
        assertThat(Instant.parse((String) body.get("sentAt"))).isCloseTo(Instant.now(), within(5, ChronoUnit.SECONDS));
        Map<String, Object> agent = Json.object(body, "agent");
        assertThat(agent).containsEntry("status", "offline").containsKeys("busyUntil", "lastActivityAt", "lastLlmCallAt");
        assertThat(Json.object(body, "clients")).containsEntry("connected", 0);
        assertThat(Json.object(body, "media")).containsEntry("bytesSent", 1000).containsEntry("bytesReceived", 2000);
        assertThat(Json.object(body, "health")).containsEntry("status", "ok");
        assertThat(body).containsEntry("readyToStop", false);
    }

    @Test
    void itBeatsOnThePeriodWithRisingSeqFromTheClock() throws Exception {
        rig.bootToReady();
        List<Long> seqs = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            seqs.add(((Number) rig.platform.awaitApi(BEAT).json().get("seq")).longValue());
        }
        assertThat(seqs).isSorted().doesNotHaveDuplicates();
        // Above the clock's seconds, so a restart of deskd within this boot can't fall behind.
        assertThat(seqs.get(0)).isGreaterThanOrEqualTo(Instant.now().getEpochSecond() - 10);
    }

    @Test
    void theLogShowsTheFirstAcceptedHeartbeatAndTheFirstAfterAFailure(CapturedOutput output) throws Exception {
        rig.platform.heartbeatReplies.add(FakePlatform.Reply.of(200, rig.platform.heartbeatReply(List.of())));
        rig.platform.heartbeatReplies.add(FakePlatform.Reply.of(200, rig.platform.heartbeatReply(List.of())));
        rig.platform.heartbeatReplies.add(FakePlatform.Reply.of(500, "{}"));
        rig.bootToReady();
        await().until(() -> count(output, "heartbeat refused") == 1 && count(output, "heartbeat accepted") == 2);
        assertThat(count(output, "heartbeat accepted")).isEqualTo(2);
        long beats = rig.platform.countApi(BEAT);
        await().until(() -> rig.platform.countApi(BEAT) >= beats + 2);
        assertThat(count(output, "heartbeat accepted")).isEqualTo(2);
    }

    private static int count(CapturedOutput output, String text) {
        return output.getOut().split(text, -1).length - 1;
    }

    @Test
    void theResponseSetsThePeriod() throws Exception {
        rig.platform.nextHeartbeatSeconds = 3600;
        rig.bootToReady();
        rig.platform.awaitApi(BEAT);
        Thread.sleep(500);
        assertThat(rig.platform.countApi(BEAT)).isEqualTo(1);
    }

    @Test
    void extraHeartbeatsKeepTheSpacing() throws Exception {
        rig.platform.nextHeartbeatSeconds = 3600;
        rig.bootToReady();
        rig.platform.awaitApi(BEAT);
        long first = System.nanoTime();
        rig.heartbeat.requestSoon();
        rig.heartbeat.requestSoon();
        rig.platform.awaitApi(BEAT);
        assertThat(Duration.ofNanos(System.nanoTime() - first)).isGreaterThanOrEqualTo(Duration.ofMillis(90));
        Thread.sleep(200);
        assertThat(rig.platform.countApi(BEAT)).isEqualTo(2);
    }

    // ---- the ready heartbeat

    /** A rig with a period of an hour, so a heartbeat that comes sooner came for some other reason. */
    private void beats(Duration spacing, Duration requestTimeout) throws Exception {
        rig.close();
        rig = new ControlPlaneRig(dir, ControlPlaneRig.FAST_LINK, new HeartbeatLoop.Timing(Duration.ofHours(1), spacing, requestTimeout));
        rig.platform.nextHeartbeatSeconds = null;
    }

    private void repliesWith(String... actions) {
        rig.platform.heartbeatReplies.add(FakePlatform.Reply.of(200, rig.platform.heartbeatReply(List.of(actions))));
    }

    private static long seq(Map<String, Object> body) {
        return ((Number) body.get("seq")).longValue();
    }

    @Test
    void theReadyHeartbeatGoesStraightAfterTheFirstPrepareStopWithNoSpacing() throws Exception {
        beats(Duration.ofSeconds(30), Duration.ofSeconds(5));
        repliesWith("prepare_stop", "a_future_action");
        rig.bootToReady();
        Map<String, Object> first = rig.platform.awaitApi(BEAT).json();
        long replied = System.nanoTime();
        assertThat(first).containsEntry("readyToStop", false);

        Map<String, Object> ready = rig.platform.awaitApi(BEAT).json();
        assertThat(Duration.ofNanos(System.nanoTime() - replied)).isLessThan(Duration.ofSeconds(5));
        assertThat(ready).containsEntry("readyToStop", true).containsEntry("final", false);
        // Likely in the same second, and Platform ignores a seq it has passed.
        assertThat(seq(ready)).isGreaterThan(seq(first));
    }

    /** The reply to the ready heartbeat carries prepare_stop too, and so does every one until the stop. */
    @Test
    void theReplyToTheReadyHeartbeatBringsNoOtherHeartbeat() throws Exception {
        beats(Duration.ofMillis(100), Duration.ofSeconds(5));
        for (int i = 0; i < 5; i++) {
            repliesWith("prepare_stop");
        }
        rig.bootToReady();
        rig.platform.awaitApi(BEAT);
        rig.platform.awaitApi(BEAT);
        Thread.sleep(500);
        assertThat(rig.platform.countApi(BEAT)).isEqualTo(2);
    }

    @Test
    void aReadyHeartbeatThatFailsGoesAgainAtTheSpacingNotAPeriodLater() throws Exception {
        beats(Duration.ofMillis(300), Duration.ofSeconds(5));
        repliesWith("prepare_stop");
        rig.platform.heartbeatReplies.add(FakePlatform.Reply.of(500, "{}"));
        rig.platform.heartbeatReplies.add(FakePlatform.Reply.of(500, "{}"));
        repliesWith("prepare_stop");
        rig.bootToReady();
        rig.platform.awaitApi(BEAT);
        assertThat(rig.platform.awaitApi(BEAT).json()).containsEntry("readyToStop", true);
        for (int i = 0; i < 2; i++) {
            long failed = System.nanoTime();
            assertThat(rig.platform.awaitApi(BEAT).json()).containsEntry("readyToStop", true);
            assertThat(Duration.ofNanos(System.nanoTime() - failed)).isGreaterThanOrEqualTo(Duration.ofMillis(250));
        }
        // That one was accepted, so it's the period again.
        Thread.sleep(600);
        assertThat(rig.platform.countApi(BEAT)).isEqualTo(4);
    }

    @Test
    void aReadyHeartbeatWithNoReplyGoesAgainAtTheSpacingNotAPeriodLater() throws Exception {
        beats(Duration.ofMillis(100), Duration.ofMillis(300));
        repliesWith("prepare_stop");
        rig.platform.heartbeatReplies.add(FakePlatform.Reply.STALLED);
        rig.bootToReady();
        rig.platform.awaitApi(BEAT);
        rig.platform.awaitApi(BEAT);
        assertThat(rig.platform.awaitApi(BEAT).json()).containsEntry("readyToStop", true);
    }

    @Test
    void aRefusedReadyHeartbeatGoesAgainWhenRetryAfterAllowsAndNoSooner() throws Exception {
        beats(Duration.ofMillis(100), Duration.ofSeconds(5));
        repliesWith("prepare_stop");
        rig.platform.heartbeatReplies.add(new FakePlatform.Reply(429, "{\"error\":{\"code\":\"rate_limited\"}}", Map.of("Retry-After", "1")));
        rig.bootToReady();
        rig.platform.awaitApi(BEAT);
        rig.platform.awaitApi(BEAT);
        long refused = System.nanoTime();
        assertThat(rig.platform.awaitApi(BEAT).json()).containsEntry("readyToStop", true);
        assertThat(Duration.ofNanos(System.nanoTime() - refused)).isGreaterThanOrEqualTo(Duration.ofMillis(900));
    }

    /** The exemption is for that one heartbeat. What Platform's spacing rule covers keeps it, as ever. */
    @Test
    void anExtraHeartbeatAfterTheReadyOneKeepsTheSpacing() throws Exception {
        beats(Duration.ofSeconds(3), Duration.ofSeconds(5));
        repliesWith("prepare_stop");
        repliesWith("prepare_stop");
        repliesWith("prepare_stop");
        rig.bootToReady();
        rig.platform.awaitApi(BEAT);
        long replied = System.nanoTime();
        rig.platform.awaitApi(BEAT);
        long ready = System.nanoTime();
        assertThat(Duration.ofNanos(ready - replied)).isLessThan(Duration.ofSeconds(2));

        rig.heartbeat.requestSoon();
        rig.platform.awaitApi(BEAT);
        assertThat(Duration.ofNanos(System.nanoTime() - ready)).isGreaterThanOrEqualTo(Duration.ofMillis(2500));
    }

    /** gateway.md: notify heartbeat keeps the 15 s spacing. It's the reply it fetches that needs no wait. */
    @Test
    void aNotifyHeartbeatKeepsTheSpacingAndItsPrepareStopBringsTheReadyOneAtOnce() throws Exception {
        beats(Duration.ofSeconds(3), Duration.ofSeconds(5));
        rig.bootToReady();
        rig.platform.awaitApi(BEAT);
        long first = System.nanoTime();

        repliesWith("prepare_stop");
        rig.gateway.send(Map.of("type", "notify", "topic", "heartbeat", "reason", "prepare_stop"));
        assertThat(rig.platform.awaitApi(BEAT).json()).containsEntry("readyToStop", false);
        long replied = System.nanoTime();
        assertThat(Duration.ofNanos(replied - first)).isGreaterThanOrEqualTo(Duration.ofMillis(2500));

        assertThat(rig.platform.awaitApi(BEAT).json()).containsEntry("readyToStop", true);
        assertThat(Duration.ofNanos(System.nanoTime() - replied)).isLessThan(Duration.ofSeconds(2));
    }

    /** A stop called off and asked for again is a new stop, and it gets its own. */
    @Test
    void eachStopGetsOneReadyHeartbeatAtOnce() throws Exception {
        beats(Duration.ofSeconds(3), Duration.ofSeconds(5));
        repliesWith("prepare_stop");
        repliesWith();
        repliesWith("prepare_stop");
        repliesWith("prepare_stop");
        rig.bootToReady();
        rig.platform.awaitApi(BEAT);
        long replied = System.nanoTime();
        assertThat(rig.platform.awaitApi(BEAT).json()).containsEntry("readyToStop", true);
        assertThat(Duration.ofNanos(System.nanoTime() - replied)).isLessThan(Duration.ofSeconds(2));

        // Its reply had no prepare_stop, so the stop is off, and nothing more is owed.
        rig.heartbeat.requestSoon();
        assertThat(rig.platform.awaitApi(BEAT).json()).containsEntry("readyToStop", false);
        replied = System.nanoTime();
        assertThat(rig.platform.awaitApi(BEAT).json()).containsEntry("readyToStop", true);
        assertThat(Duration.ofNanos(System.nanoTime() - replied)).isLessThan(Duration.ofSeconds(2));

        Thread.sleep(300);
        assertThat(rig.platform.countApi(BEAT)).isEqualTo(4);
    }

    /** Nothing but a reply asks for it, however many extra heartbeats go out. */
    @Test
    void withNoPrepareStopNoHeartbeatEverSaysReadyToStop() throws Exception {
        beats(Duration.ofMillis(100), Duration.ofSeconds(5));
        rig.bootToReady();
        rig.platform.awaitApi(BEAT);
        rig.heartbeat.requestSoon();
        rig.platform.awaitApi(BEAT);
        Thread last = rig.heartbeat.stopAndSendFinal(Duration.ofSeconds(5));
        last.join(Duration.ofSeconds(5));
        assertThat(rig.platform.apiRequests.stream().filter(request -> BEAT.equals(request.path())))
                .hasSize(3)
                .allSatisfy(request -> assertThat(request.json()).containsEntry("readyToStop", false));
    }

    @Test
    void prepareStopLeavesSessionsOpen() throws Exception {
        rig.bootToReady();
        rig.sessions.open("cs-1", rig.platform.tokens.mint("ab".repeat(32), Instant.now()));
        rig.platform.heartbeatReplies.add(FakePlatform.Reply.of(200, rig.platform.heartbeatReply(List.of("prepare_stop"))));
        await().until(() -> rig.platform.apiRequests.stream()
                .filter(request -> BEAT.equals(request.path()))
                .anyMatch(request -> Boolean.TRUE.equals(request.json().get("readyToStop"))));
        assertThat(rig.sessions.sessionIds()).containsExactly("cs-1");
    }

    @Test
    void helloRequiredSendsAHelloWithReasonRequested() throws Exception {
        rig.bootToReady();
        rig.platform.awaitApi("/v1/agent/hello");
        rig.platform.heartbeatReplies.add(FakePlatform.Reply.of(200, rig.platform.heartbeatReply(List.of("hello_required"))));
        assertThat(rig.platform.awaitApi("/v1/agent/hello").json()).containsEntry("reason", "requested");
    }

    @Test
    void a429WaitsForRetryAfterAndALostHeartbeatDoesntStopTheLoop() throws Exception {
        rig.platform.heartbeatReplies.add(new FakePlatform.Reply(429, "{\"error\":{\"code\":\"rate_limited\"}}", Map.of("Retry-After", "1")));
        rig.bootToReady();
        rig.platform.awaitApi(BEAT);
        long refused = System.nanoTime();
        rig.heartbeat.requestSoon();
        rig.platform.awaitApi(BEAT);
        assertThat(Duration.ofNanos(System.nanoTime() - refused)).isGreaterThanOrEqualTo(Duration.ofMillis(900));
    }

    /** Gaps between arrivals of the heartbeat at the Platform, in milliseconds. */
    private List<Long> beatGapsMillis() {
        List<Long> at = rig.platform.arrivals(BEAT);
        List<Long> gaps = new ArrayList<>();
        for (int i = 1; i < at.size(); i++) {
            gaps.add(java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(at.get(i) - at.get(i - 1)));
        }
        return gaps;
    }

    @Test
    void a503IsRetriedAtTheSpacingNotAWholePeriodLater() throws Exception {
        // Audit D3: after any failure but a 429 the next heartbeat waited a whole period. Here the period is an hour.
        beats(Duration.ofMillis(200), Duration.ofSeconds(5));
        rig.platform.heartbeatReplies.add(FakePlatform.Reply.of(503, "{\"message\":\"Service Unavailable\"}"));
        rig.bootToReady();
        rig.platform.awaitApi(BEAT);
        rig.platform.awaitApi(BEAT);
        // The spacing, plus up to a quarter more.
        assertThat(beatGapsMillis().get(0)).isBetween(190L, 1500L);
        // That one was accepted, so it's the period again.
        Thread.sleep(600);
        assertThat(rig.platform.countApi(BEAT)).isEqualTo(2);
    }

    @Test
    void heartbeatsThatKeepFailingBackOffFromTheSpacingUpToThePeriod() throws Exception {
        rig.close();
        rig = new ControlPlaneRig(dir, ControlPlaneRig.FAST_LINK, new HeartbeatLoop.Timing(
                Duration.ofMillis(1500), Duration.ofMillis(100), Duration.ofSeconds(5)));
        rig.platform.nextHeartbeatSeconds = null;
        for (int i = 0; i < 5; i++) {
            rig.platform.heartbeatReplies.add(FakePlatform.Reply.of(503, "{}"));
        }
        rig.bootToReady();
        await().atMost(Duration.ofSeconds(15)).until(() -> rig.platform.countApi(BEAT) >= 7);
        List<Long> gaps = beatGapsMillis();
        // 100, 200, 400, 800, then the period (1,500), each with up to a quarter more; then the period after a success.
        assertThat(gaps.get(0)).isBetween(95L, 600L);
        assertThat(gaps.get(1)).isBetween(195L, 700L);
        assertThat(gaps.get(2)).isBetween(395L, 1000L);
        assertThat(gaps.get(3)).isBetween(795L, 1500L);
        assertThat(gaps.get(4)).isBetween(1495L, 2400L);
        assertThat(gaps.get(5)).isBetween(1495L, 2400L);
    }

    @Test
    void aNextHeartbeatSecondsPastTheMaximumIsHeldToIt() throws Exception {
        // Audit D7: 3600 from the Platform silenced the desk for an hour. Here the maximum is 400 ms.
        rig.close();
        rig = new ControlPlaneRig(dir, ControlPlaneRig.FAST_LINK, new HeartbeatLoop.Timing(
                Duration.ofMillis(100), Duration.ofMillis(50), Duration.ofSeconds(5), Duration.ofMillis(400)));
        rig.platform.nextHeartbeatSeconds = 3600;
        rig.bootToReady();
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.platform.countApi(BEAT) >= 3);
        assertThat(beatGapsMillis().subList(0, 2)).allSatisfy(gap -> assertThat(gap).isBetween(390L, 1500L));
    }

    @Test
    void theDefaultMaximumIsTwoMinutesAndAnOldTimingKeepsItsLongPeriod() {
        assertThat(HeartbeatLoop.Timing.DEFAULT.maxPeriod()).isEqualTo(Duration.ofMinutes(2));
        assertThat(new HeartbeatLoop.Timing(Duration.ofHours(1), Duration.ofSeconds(1), Duration.ofSeconds(1)).maxPeriod())
                .isEqualTo(Duration.ofHours(1));
    }

    @Test
    void aRetryAfterOfAnHourIsHeldToFiveMinutes() {
        assertThat(PlatformHttp.retryAfter(headers("Retry-After", "3600"))).isEqualTo(Duration.ofMinutes(5));
        assertThat(PlatformHttp.retryAfter(headers("Retry-After", "99999999999999999999999"))).isEqualTo(Duration.ofMinutes(5));
        assertThat(PlatformHttp.retryAfter(headers("Retry-After", " 30 "))).isEqualTo(Duration.ofSeconds(30));
        assertThat(PlatformHttp.retryAfter(headers("Retry-After", "-5"))).isNull();
        assertThat(PlatformHttp.retryAfter(headers("Retry-After", "Wed, 21 Oct 2026 07:28:00 GMT"))).isNull();
        assertThat(PlatformHttp.retryAfter(headers("X-Other", "1"))).isNull();
    }

    private static java.net.http.HttpHeaders headers(String name, String value) {
        return java.net.http.HttpHeaders.of(Map.of(name, List.of(value)), (a, b) -> true);
    }

    @Test
    void aRefusedHeartbeatIsSentAgainWhenRetryAfterAllowsNotAWholePeriodLater() throws Exception {
        rig.close();
        rig = new ControlPlaneRig(dir, ControlPlaneRig.FAST_LINK, new HeartbeatLoop.Timing(
                Duration.ofHours(1), Duration.ofMillis(100), Duration.ofSeconds(5)));
        rig.platform.heartbeatReplies.add(new FakePlatform.Reply(429, "{\"error\":{\"code\":\"rate_limited\"}}", Map.of("Retry-After", "1")));
        rig.bootToReady();
        rig.platform.awaitApi(BEAT);
        long refused = System.nanoTime();
        rig.platform.awaitApi(BEAT);
        assertThat(Duration.ofNanos(System.nanoTime() - refused)).isBetween(Duration.ofMillis(900), Duration.ofSeconds(10));
    }

    @Test
    void aNewConfigVersionFetchesConfig() throws Exception {
        rig.bootToReady();
        assertThat(rig.platform.countApi("/v1/agent/config")).isZero();
        rig.platform.configVersion = 13;
        rig.platform.awaitApi("/v1/agent/config");
        await().until(() -> rig.state.config().configVersion() == 13);
    }

    /** ADR 0043: the account's values come with the config, so with no poll of their own, and absent is normal. */
    @Test
    void theAccountsDefaultsComeWithTheConfigAndFollowIt() throws Exception {
        rig.bootToReady();
        AccountDefaults defaults = rig.state.accountDefaults();
        Map<String, Object> none = new LinkedHashMap<>();
        none.put("deskDay", null);
        none.put("deskMonth", null);
        none.put("timeZone", null);
        none.put("tier", null);
        assertThat(defaults.current()).as("a Platform that doesn't send them yet").isEqualTo(none);
        List<String> changes = new CopyOnWriteArrayList<>();
        defaults.onChange(() -> changes.add(String.valueOf(defaults.current().get("timeZone"))));

        rig.platform.agentDefaults = Map.of("deskMonth", Map.of("maxMicroUsd", 5), "timeZone", "America/Denver", "aFieldFromTheFuture", 1);
        rig.platform.configVersion = 13;
        rig.platform.awaitApi("/v1/agent/config");
        await().until(() -> "America/Denver".equals(defaults.current().get("timeZone")));
        assertThat(defaults.current()).containsEntry("deskMonth", Map.of("maxMicroUsd", 5)).containsEntry("deskDay", null)
                .doesNotContainKey("aFieldFromTheFuture");

        // A new version with the same values is no change.
        rig.platform.configVersion = 14;
        await().until(() -> rig.state.config().configVersion() == 14);
        assertThat(changes).containsExactly("America/Denver");

        // A read that failed leaves the field out: the last values stand. Nulls that were sent replace them.
        rig.platform.agentDefaults = null;
        rig.platform.configVersion = 15;
        rig.platform.awaitApi("/v1/agent/config");
        await().until(() -> rig.state.config().configVersion() == 15);
        assertThat(defaults.current()).containsEntry("timeZone", "America/Denver");
        rig.platform.agentDefaults = none;
        rig.platform.configVersion = 16;
        await().until(() -> defaults.current().equals(none));
    }

    @Test
    void revocationsInAResponseCloseMatchingSessions() throws Exception {
        rig.bootToReady();
        rig.sessions.open("cs-1", rig.platform.tokens.mint("ab".repeat(32), Instant.now()));
        rig.platform.heartbeatReplies.add(FakePlatform.Reply.of(200, rig.platform.heartbeatReply(List.of(), List.of("s-testsession"), null)));
        await().until(() -> rig.sessions.sessionIds().isEmpty());
        assertThat(rig.gateway.await("session.close")).containsEntry("sessionId", "cs-1").containsEntry("reason", "revoked");
    }

    @Test
    void tokensValidAfterInAResponseClosesOlderSessions() throws Exception {
        rig.bootToReady();
        rig.sessions.open("cs-1", rig.platform.tokens.mint("ab".repeat(32), Instant.now().minusSeconds(60)));
        rig.platform.heartbeatReplies.add(FakePlatform.Reply.of(200, rig.platform.heartbeatReply(List.of(), List.of(), Instant.now().toString())));
        await().until(() -> rig.sessions.sessionIds().isEmpty());
    }

    @Test
    void connectedClientsAreCountedAndAChangeBringsAHeartbeatForward() throws Exception {
        rig.platform.nextHeartbeatSeconds = 3600;
        rig.bootToReady();
        rig.platform.awaitApi(BEAT);
        String fingerprint = "ab".repeat(32);
        rig.sessions.open("cs-1", rig.platform.tokens.mint(fingerprint, Instant.now()));
        rig.sessions.offer("cs-1", TestClient.offerFor(fingerprint));
        new TestClient(rig.rtc, 1).hello();
        rig.rtc.sendJson(Map.of("t", "session.state", "sessionId", "cs-1", "state", "connected", "transport", "tcp"));
        await().until(() -> rig.platform.apiRequests.stream()
                .filter(request -> BEAT.equals(request.path()))
                .anyMatch(request -> {
                    Map<String, Object> clients = Json.object(request.json(), "clients");
                    return Integer.valueOf(1).equals(clients.get("connected"))
                            && clients.get("lastConnectedAt") != null
                            && Integer.valueOf(1).equals(Json.object(clients, "transports").get("tcp"));
                }));
    }

    // ---- a Chromium the image refuses to start

    private static final String START_BROWSER = "start desk-browser";
    private static final String REFUSED =
            "err failed start desk-browser: desk-browser-start: REFUSING TO START, profile left untouched: profile last ran "
                    + "Chromium 157.0.0.0, newer than the installed 156.0.8078.79. Update Chromium; never remove the profile (ADR 0035)";

    private TestClient connectedClient() throws Exception {
        String fingerprint = "ab".repeat(32);
        rig.sessions.open("cs-1", rig.platform.tokens.mint(fingerprint, Instant.now()));
        rig.sessions.offer("cs-1", TestClient.offerFor(fingerprint));
        TestClient client = new TestClient(rig.rtc, 1);
        client.hello();
        return client;
    }

    private void refuseAStart(TestClient client) throws Exception {
        rig.units.reply(START_BROWSER, REFUSED);
        assertThat(client.call("browser.stream.set", Map.of("state", "live"))).containsEntry("code", "unavailable");
    }

    /** Heartbeats until one goes out after this, so it's seen what's true now. */
    private Map<String, Object> aLaterBeat() throws Exception {
        long seen = rig.platform.countApi(BEAT);
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.platform.countApi(BEAT) >= seen + 2);
        return rig.platform.apiRequests.stream()
                .filter(request -> BEAT.equals(request.path()))
                .reduce((a, b) -> b)
                .orElseThrow()
                .json();
    }

    private static Map<String, Object> checks(Map<String, Object> body) {
        return Json.object(Json.object(body, "health"), "checks");
    }

    @Test
    void aHealthyDeskSaysNothingOfChromiumAtAll() throws Exception {
        rig.bootToReady();
        Map<String, Object> body = rig.platform.awaitApi(BEAT).json();
        assertThat(Json.object(body, "health")).containsEntry("status", "ok");
        assertThat(checks(body)).isEqualTo(Map.of("rtc", "ok", "dataVolume", "ok"));
    }

    /** ADR 0045: that it's frozen, while it is, and nothing about why or what's open. Not a fault, so the status holds. */
    @Test
    void aFrozenBrowserSaysSoWhileItIsAndNothingMore() throws Exception {
        java.util.concurrent.atomic.AtomicBoolean frozen = new java.util.concurrent.atomic.AtomicBoolean(true);
        rig.heartbeat.browserFrozenFrom(frozen::get);
        rig.bootToReady();
        Map<String, Object> body = aLaterBeat();
        assertThat(Json.object(body, "health")).containsEntry("status", "ok");
        assertThat(checks(body)).isEqualTo(Map.of("rtc", "ok", "dataVolume", "ok", "browser", "frozen"));

        frozen.set(false);
        assertThat(checks(aLaterBeat())).isEqualTo(Map.of("rtc", "ok", "dataVolume", "ok"));
    }

    /** The rig wires the heartbeat to the Browser module as the application does: a desk nobody froze says nothing. */
    @Test
    void aRunningBrowserSaysNothingOfAFreeze() throws Exception {
        rig.bootToReady();
        assertThat(rig.browser.browserFrozen()).isFalse();
        assertThat(checks(aLaterBeat())).doesNotContainKey("browser");
    }

    @Test
    void aRefusedChromiumIsDegradedUntilAStartWorksAndTheRefusalsWordsNeverGoOut() throws Exception {
        rig.bootToReady();
        TestClient client = connectedClient();
        refuseAStart(client);

        Map<String, Object> refused = aLaterBeat();
        assertThat(Json.object(refused, "health")).containsEntry("status", "degraded");
        assertThat(checks(refused)).isEqualTo(Map.of("rtc", "ok", "dataVolume", "ok", "chromium", "older_than_profile"));

        // A timeout says nothing about the profile.
        rig.units.reply(START_BROWSER, "err timeout start desk-browser took over 34 s");
        assertThat(client.call("browser.stream.set", Map.of("state", "live"))).containsEntry("code", "unavailable");
        assertThat(Json.object(aLaterBeat(), "health")).containsEntry("status", "degraded");

        rig.units.replyOk(START_BROWSER);
        assertThat(client.call("browser.stream.set", Map.of("state", "live"))).containsEntry("state", "live");
        Map<String, Object> started = aLaterBeat();
        assertThat(Json.object(started, "health")).containsEntry("status", "ok");
        assertThat(checks(started)).doesNotContainKey("chromium");

        assertThat(rig.platform.apiRequests)
                .allSatisfy(request -> assertThat(new String(request.body(), StandardCharsets.UTF_8))
                        .doesNotContain("REFUSING", "157.0.0.0", "156.0.8078.79", "profile last ran"));
    }

    /** Platform clears its flag on any heartbeat without the check, so a restart of deskd mustn't read as a fix. */
    @Test
    void aRestartedDeskdStillReportsARefusalFromBefore() throws Exception {
        rig.bootToReady();
        refuseAStart(connectedClient());
        await().until(() -> Files.exists(dir.resolve("chromium-refused")));

        beats(Duration.ofMillis(100), Duration.ofSeconds(5));
        rig.bootToReady();

        Map<String, Object> first = rig.platform.awaitApi(BEAT).json();
        assertThat(Json.object(first, "health")).containsEntry("status", "degraded");
        assertThat(checks(first)).containsEntry("chromium", "older_than_profile");
    }

    /** A volume that's gone. The owner's age band, the tier's limits (none) and desk-rtc's identity are written there at boot, so they go too. */
    private void removeDataDir() throws Exception {
        Files.deleteIfExists(rig.dataDir.resolve(AgeBand.FILE));
        Files.deleteIfExists(rig.dataDir.resolve(TierLimits.FILE));
        Files.deleteIfExists(rig.dataDir.resolve("rtc-identity.json"));
        Files.delete(rig.dataDir);
    }

    @Test
    void aVolumeThatCantBeWrittenIsFailingWhateverChromiumSays() throws Exception {
        rig.bootToReady();
        refuseAStart(connectedClient());
        assertThat(Json.object(aLaterBeat(), "health")).containsEntry("status", "degraded");

        removeDataDir();

        Map<String, Object> body = aLaterBeat();
        assertThat(Json.object(body, "health")).containsEntry("status", "failing");
        assertThat(checks(body)).containsEntry("dataVolume", "failing").containsEntry("chromium", "older_than_profile");
    }

    @Test
    void aFullVolumeIsFailingThoughItStillLooksWritable() throws Exception {
        // Audit D5: the heartbeat looked only at the directory's mode, so a 100 % full volume said ok.
        rig.bootToReady();
        assertThat(checks(aLaterBeat())).containsEntry("dataVolume", "ok");

        rig.usableBytes.set(0);
        Map<String, Object> full = aLaterBeat();
        assertThat(checks(full)).containsEntry("dataVolume", "failing");
        assertThat(Json.object(full, "health")).containsEntry("status", "failing");

        // Under the floor is failing too; at it, ok again.
        rig.usableBytes.set(DataVolume.LOW_SPACE_BYTES - 1);
        assertThat(checks(aLaterBeat())).containsEntry("dataVolume", "failing");
        rig.usableBytes.set(DataVolume.LOW_SPACE_BYTES);
        Map<String, Object> room = aLaterBeat();
        assertThat(checks(room)).containsEntry("dataVolume", "ok");
        assertThat(Json.object(room, "health")).containsEntry("status", "ok");
    }

    // ---- desk-notebook's storage

    private static Map<String, Object> storage(String state, boolean refusing) {
        Map<String, Object> storage = new LinkedHashMap<>();
        storage.put("state", state);
        storage.put("unsavedPages", "ok".equals(state) ? 0 : 2);
        storage.put("unsavedBytes", "ok".equals(state) ? 0 : 4096);
        storage.put("refusing", refusing);
        storage.put("degradedSeconds", "ok".equals(state) ? 0 : 12);
        return storage;
    }

    @Test
    void notebookStorageThatFailsIsDegradedAndRefusingEditsIsFailing() throws Exception {
        java.util.concurrent.atomic.AtomicReference<Map<String, Object>> storage =
                new java.util.concurrent.atomic.AtomicReference<>(storage("ok", false));
        rig.heartbeat.notebookStorageFrom(storage::get);
        rig.bootToReady();
        Map<String, Object> fine = aLaterBeat();
        assertThat(checks(fine)).isEqualTo(Map.of("rtc", "ok", "dataVolume", "ok", "notebook", "ok"));
        assertThat(Json.object(fine, "health")).containsEntry("status", "ok");

        storage.set(storage("degraded", false));
        Map<String, Object> degraded = aLaterBeat();
        assertThat(checks(degraded)).containsEntry("notebook", "degraded");
        assertThat(Json.object(degraded, "health")).containsEntry("status", "degraded");

        storage.set(storage("degraded", true));
        Map<String, Object> refusing = aLaterBeat();
        assertThat(checks(refusing)).containsEntry("notebook", "failing");
        assertThat(Json.object(refusing, "health")).containsEntry("status", "failing");

        // desk-notebook not there, or a state this build doesn't know: no check, and nothing changes for it.
        storage.set(null);
        assertThat(checks(aLaterBeat())).isEqualTo(Map.of("rtc", "ok", "dataVolume", "ok"));
        storage.set(Map.of("state", "something-new"));
        assertThat(checks(aLaterBeat())).isEqualTo(Map.of("rtc", "ok", "dataVolume", "ok"));
    }

    @Test
    void theHeartbeatReadsDeskNotebooksHealthFrameOverItsSocket() throws Exception {
        try (com.minimalistalliance.desk.deskd.testing.FakeNotebookSocket notebook =
                new com.minimalistalliance.desk.deskd.testing.FakeNotebookSocket(dir.resolve("notebook.sock"))) {
            notebook.storage = storage("degraded", false);
            com.minimalistalliance.desk.deskd.notebook.NotebookModule module = new com.minimalistalliance.desk.deskd.notebook.NotebookModule(
                    notebook.socket(), rig.sessions, rig.dispatcher, rig.hub,
                    com.minimalistalliance.desk.deskd.notebook.NotebookModule.Timing.DEFAULT);
            rig.heartbeat.notebookStorageFrom(module::storage);
            rig.bootToReady();
            Map<String, Object> body = rig.platform.awaitApi(BEAT).json();
            assertThat(checks(body)).containsEntry("notebook", "degraded");
            assertThat(Json.object(body, "health")).containsEntry("status", "degraded");
            module.close();
        }
    }

    // ---- the volume's record    // ---- the volume's record

    private void record(String json) throws Exception {
        Files.writeString(rig.dataDir.resolve("volume.json"), json);
    }

    private static Map<String, Object> dataVolume(Map<String, Object> body) {
        return Json.object(body, "dataVolume");
    }

    /** What both real desks send today: their image has no record. */
    @Test
    void withNoRecordTheVolumeHasOnlyItsUsage(CapturedOutput output) throws Exception {
        rig.bootToReady();
        assertThat(dataVolume(rig.platform.awaitApi(BEAT).json())).containsOnlyKeys("totalBytes", "usedBytes");
        assertThat(output.getOut()).doesNotContain("volume record");
    }

    @Test
    void aFormattedVolumesRecordGoesOutWithoutItsImageAndNotInHello() throws Exception {
        record("{\"volumeId\":\"vol-0abc123\",\"formattedAt\":\"2026-11-06T02:00:00Z\",\"image\":\"0.2.3\"}\n");
        rig.bootToReady();
        Map<String, Object> volume = dataVolume(rig.platform.awaitApi(BEAT).json());
        assertThat(volume).containsOnlyKeys("totalBytes", "usedBytes", "volumeId", "formattedAt");
        assertThat(volume).containsEntry("volumeId", "vol-0abc123").containsEntry("formattedAt", "2026-11-06T02:00:00Z");
        assertThat(dataVolume(rig.platform.awaitHello())).doesNotContainKeys("volumeId", "formattedAt");
    }

    @Test
    void anOlderVolumesRecordSendsFormattedAtAsAJsonNullWithoutFirstSeenAt() throws Exception {
        record("{\"volumeId\":\"vol-0abc123\",\"formattedAt\":null,\"firstSeenAt\":\"2026-11-06T02:00:00Z\"}\n");
        rig.bootToReady();
        FakePlatform.Request beat = rig.platform.awaitApi(BEAT);
        Map<String, Object> volume = dataVolume(beat.json());
        assertThat(volume).containsOnlyKeys("totalBytes", "usedBytes", "volumeId", "formattedAt");
        assertThat(volume).containsEntry("formattedAt", null);
        assertThat(new String(beat.body(), StandardCharsets.UTF_8)).contains("\"formattedAt\":null").doesNotContain("firstSeenAt");
    }

    @Test
    void anUnknownVolumeIdGoesOutAsThatWord() throws Exception {
        record("{\"volumeId\":\"unknown\",\"formattedAt\":null,\"firstSeenAt\":\"2026-11-06T02:00:00Z\"}\n");
        rig.bootToReady();
        assertThat(dataVolume(rig.platform.awaitApi(BEAT).json())).containsEntry("volumeId", "unknown");
    }

    @Test
    void aBadRecordSendsNeitherFieldLogsOnceAndStopsNoHeartbeat(CapturedOutput output) throws Exception {
        record("{\"volumeId\":\"SECRETWORD\",\"formattedAt\":null}");
        rig.bootToReady();
        assertThat(dataVolume(rig.platform.awaitApi(BEAT).json())).containsOnlyKeys("totalBytes", "usedBytes");
        assertThat(dataVolume(aLaterBeat())).containsOnlyKeys("totalBytes", "usedBytes");
        assertThat(output.getOut().lines().filter(line -> line.contains("volume record ignored"))).hasSize(1);
        assertThat(output.getOut()).doesNotContain("SECRETWORD");
    }

    @Test
    void aRecordOverTheLimitOrASymlinkStopsNoHeartbeat() throws Exception {
        record("{\"volumeId\":\"vol-0abc\",\"formattedAt\":null,\"pad\":\"" + "x".repeat(8192) + "\"}");
        rig.bootToReady();
        assertThat(dataVolume(rig.platform.awaitApi(BEAT).json())).containsOnlyKeys("totalBytes", "usedBytes");
        Files.delete(rig.dataDir.resolve("volume.json"));

        beats(Duration.ofMillis(100), Duration.ofSeconds(5));
        Path elsewhere = dir.resolve("elsewhere.json");
        Files.writeString(elsewhere, "{\"volumeId\":\"vol-0abc\",\"formattedAt\":null}");
        Files.createSymbolicLink(rig.dataDir.resolve("volume.json"), elsewhere);
        rig.bootToReady();
        assertThat(dataVolume(rig.platform.awaitApi(BEAT).json())).containsOnlyKeys("totalBytes", "usedBytes");
    }

    @Test
    void theRecordIsReadOncePerProcess() throws Exception {
        record("{\"volumeId\":\"vol-0abc\",\"formattedAt\":null}");
        rig.bootToReady();
        assertThat(dataVolume(rig.platform.awaitApi(BEAT).json())).containsEntry("volumeId", "vol-0abc");
        record("{\"volumeId\":\"vol-0def\",\"formattedAt\":null}");
        assertThat(dataVolume(aLaterBeat())).containsEntry("volumeId", "vol-0abc");
    }

    @Test
    void withARecordAndNoUsageJustTheRecordGoesOut() throws Exception {
        record("{\"volumeId\":\"vol-0abc\",\"formattedAt\":\"2026-11-06T02:00:00Z\",\"image\":\"0.2.3\"}");
        rig.bootToReady();
        rig.platform.awaitApi(BEAT);
        Files.delete(rig.dataDir.resolve("volume.json"));
        removeDataDir();

        assertThat(dataVolume(aLaterBeat()))
                .containsOnlyKeys("volumeId", "formattedAt")
                .containsEntry("volumeId", "vol-0abc")
                .containsEntry("formattedAt", "2026-11-06T02:00:00Z");
    }

    @Test
    void withNeitherRecordNorUsageItStaysNull() throws Exception {
        rig.bootToReady();
        rig.platform.awaitApi(BEAT);
        removeDataDir();

        Map<String, Object> body = aLaterBeat();
        assertThat(body).containsEntry("dataVolume", null);
    }

    @Test
    void theLastHeartbeatSaysFinal() throws Exception {
        rig.bootToReady();
        rig.platform.awaitApi(BEAT);
        Thread last = rig.heartbeat.stopAndSendFinal(Duration.ofSeconds(5));
        assertThat(last).isNotNull();
        last.join(Duration.ofSeconds(5));
        Map<String, Object> body = rig.platform.apiRequests.stream()
                .filter(request -> BEAT.equals(request.path()))
                .reduce((a, b) -> b)
                .orElseThrow()
                .json();
        // A plain restart: Platform powers off on readyToStop, so this must not say it.
        assertThat(body).containsEntry("final", true).containsEntry("readyToStop", false);
    }

    @Test
    void theLastHeartbeatSaysReadyToStopAfterAPrepareStop() throws Exception {
        rig.platform.nextHeartbeatSeconds = 3600;
        rig.platform.heartbeatReplies.add(FakePlatform.Reply.of(200, rig.platform.heartbeatReply(List.of("prepare_stop"))));
        rig.bootToReady();
        rig.platform.awaitApi(BEAT);
        rig.platform.awaitApi(BEAT);
        Thread last = rig.heartbeat.stopAndSendFinal(Duration.ofSeconds(5));
        assertThat(last).isNotNull();
        last.join(Duration.ofSeconds(5));
        Map<String, Object> body = rig.platform.apiRequests.stream()
                .filter(request -> BEAT.equals(request.path()))
                .reduce((a, b) -> b)
                .orElseThrow()
                .json();
        assertThat(body).containsEntry("final", true).containsEntry("readyToStop", true);
    }

    @Test
    void prepareStopIsRememberedAfterLaterResponsesLeaveItOut() throws Exception {
        rig.bootToReady();
        rig.platform.awaitApi(BEAT);
        assertThat(rig.heartbeat.prepareStopSeen()).isFalse();
        rig.platform.heartbeatReplies.add(FakePlatform.Reply.of(200, rig.platform.heartbeatReply(List.of("prepare_stop"))));
        await().until(rig.heartbeat::prepareStopSeen);
        // The queue is empty again, so the next responses carry no action at all.
        long then = rig.platform.countApi(BEAT);
        await().until(() -> rig.platform.countApi(BEAT) >= then + 2);
        assertThat(rig.heartbeat.prepareStopSeen()).isTrue();
    }

    /** Heartbeats until one reports these byte totals. */
    private void awaitMedia(long bytesSent, long bytesReceived, long peerBytesSent) {
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.platform.apiRequests.stream()
                .filter(request -> BEAT.equals(request.path()))
                .map(request -> Json.object(request.json(), "media"))
                .anyMatch(media -> media != null
                        && ((Number) media.get("bytesSent")).longValue() == bytesSent
                        && ((Number) media.get("bytesReceived")).longValue() == bytesReceived
                        && ((Number) media.get("peerBytesSent")).longValue() == peerBytesSent));
    }

    /** Regression: desk-rtc's totals start again when it restarts, while agent.md's are since boot. */
    @Test
    void mediaBytesKeepRisingAcrossARestartOfDeskRtc() throws Exception {
        rig.rtc.statsTotals(5000, 7000, 11);
        rig.bootToReady();
        awaitMedia(5000, 7000, 11);
        rig.rtc.statsTotals(100, 200, 1);
        awaitMedia(5100, 7200, 12);
        rig.rtc.statsTotals(150, 250, 2);
        awaitMedia(5150, 7250, 13);
        // And again, on top of what the first restart left.
        rig.rtc.statsTotals(10, 20, 0);
        awaitMedia(5160, 7270, 13);
    }

    /** A dropped socket to the same desk-rtc changes nothing: its totals only go up. */
    @Test
    void mediaBytesThatOnlyRiseAreReportedAsTheyAre() throws Exception {
        rig.rtc.statsTotals(5000, 7000, 11);
        rig.bootToReady();
        awaitMedia(5000, 7000, 11);
        rig.rtc.statsTotals(6000, 7000, 11);
        awaitMedia(6000, 7000, 11);
    }

    /** Regression: the one heartbeat thread parked for ever, with no log line and /health still 200. */
    @Test
    void aResponseThatStallsAfterItsHeadersDoesntStopTheLoop() throws Exception {
        rig.close();
        rig = new ControlPlaneRig(dir, ControlPlaneRig.FAST_LINK, new HeartbeatLoop.Timing(
                Duration.ofMillis(100), Duration.ofMillis(100), Duration.ofMillis(300)));
        rig.platform.nextHeartbeatSeconds = null;
        rig.platform.heartbeatReplies.add(FakePlatform.Reply.STALLED);
        rig.bootToReady();
        rig.platform.awaitApi(BEAT);
        rig.platform.awaitApi(BEAT);
    }

    // ---- ADR 0078, section 6: what a desk in a shared host's slot says (DE-1, DE-2)

    private static final String BATCH = "/v1/agent/batch";

    private Map<String, Object> theLastBeat() {
        return rig.platform.apiRequests.stream()
                .filter(request -> BEAT.equals(request.path()))
                .reduce((a, b) -> b)
                .orElseThrow()
                .json();
    }

    /** DE-2: the Platform's promote reads deskd's own version and /health's answer from the heartbeat (section 3.3). */
    @Test
    void theDeskdBlockSaysThisDeskdsVersionAndWhatHealthSays() throws Exception {
        java.util.concurrent.atomic.AtomicBoolean healthy = new java.util.concurrent.atomic.AtomicBoolean(true);
        rig.heartbeat.deskdFrom("2026.11.11-abc1234", healthy::get);
        rig.bootToReady();
        Map<String, Object> fine = aLaterBeat();
        assertThat(Json.object(fine, "deskd")).containsOnlyKeys("version", "status")
                .containsEntry("version", "2026.11.11-abc1234")
                .containsEntry("status", "ok");
        assertThat(Json.object(fine, "health")).containsEntry("status", "ok");
        assertThat(checks(fine)).isEqualTo(Map.of("rtc", "ok", "dataVolume", "ok"));

        // /health would answer 503: the block says failing, and so does the heartbeat's own status.
        healthy.set(false);
        Map<String, Object> failing = aLaterBeat();
        assertThat(Json.object(failing, "deskd")).containsEntry("status", "failing").containsEntry("version", "2026.11.11-abc1234");
        assertThat(Json.object(failing, "health")).containsEntry("status", "failing");

        healthy.set(true);
        Map<String, Object> back = aLaterBeat();
        assertThat(Json.object(back, "deskd")).containsEntry("status", "ok");
        assertThat(Json.object(back, "health")).containsEntry("status", "ok");
    }

    @Test
    void aHealthCheckThatThrowsIsFailingAndTheHeartbeatStillGoes() throws Exception {
        rig.heartbeat.deskdFrom("2026.11.11-abc1234", () -> {
            throw new IllegalStateException("no");
        });
        rig.bootToReady();
        Map<String, Object> body = aLaterBeat();
        assertThat(Json.object(body, "deskd")).containsEntry("status", "failing");
        assertThat(Json.object(body, "health")).containsEntry("status", "failing");
    }

    /** Before it's wired, as in a rig with no admin socket, there's no block at all, never a made-up version. */
    @Test
    void withNothingToSayThereIsNoDeskdBlock() throws Exception {
        rig.bootToReady();
        assertThat(aLaterBeat()).doesNotContainKey("deskd");
    }

    /** /health writes a file, which the shutdown's budget hasn't time for: the final heartbeat says what the last one did. */
    @Test
    void theFinalHeartbeatSaysWhatTheLastOneDidWithoutAskingAgain() throws Exception {
        java.util.concurrent.atomic.AtomicInteger askedByTheFinal = new java.util.concurrent.atomic.AtomicInteger();
        rig.heartbeat.deskdFrom("2026.11.11-abc1234", () -> {
            if (Thread.currentThread().getName().equals("heartbeat-final")) {
                askedByTheFinal.incrementAndGet();
            }
            return false;
        });
        rig.bootToReady();
        assertThat(Json.object(aLaterBeat(), "deskd")).containsEntry("status", "failing");
        Thread last = rig.heartbeat.stopAndSendFinal(Duration.ofSeconds(5));
        assertThat(last).isNotNull();
        last.join(Duration.ofSeconds(5));
        Map<String, Object> body = theLastBeat();
        assertThat(body).containsEntry("final", true);
        assertThat(Json.object(body, "deskd")).containsEntry("status", "failing").containsEntry("version", "2026.11.11-abc1234");
        assertThat(askedByTheFinal).hasValue(0);
    }

    /**
     * DE-1: a shared desk has no /run/desk/batch.sock (the host takes its releases, section 6, PB-6), and deskd doesn't
     * relay batches at all yet. A reply that names one all the same fetches nothing, logs no batch error, and no heartbeat
     * carries {@code update}. A relay added later keeps this for a desk with no batch.sock.
     */
    @Test
    void aDeskWithNoBatchSocketMakesNoOfferAndItsHeartbeatHasNoUpdate(CapturedOutput output) throws Exception {
        assertThat(dir.resolve("batch.sock")).doesNotExist();
        String naming = rig.platform.heartbeatReply(List.of()).replaceFirst("\\{", "{\"batch\":{\"seq\":9004,\"id\":\"2026-12\"},");
        for (int i = 0; i < 4; i++) {
            rig.platform.heartbeatReplies.add(FakePlatform.Reply.of(200, naming));
        }
        rig.bootToReady();
        Map<String, Object> first = rig.platform.awaitApi(BEAT).json();
        Map<String, Object> later = aLaterBeat();
        assertThat(first).doesNotContainKey("update");
        assertThat(later).doesNotContainKey("update");
        assertThat(rig.platform.countApi(BATCH)).isZero();
        assertThat(output.getAll().lines()
                        .filter(line -> line.contains("WARN") || line.contains("ERROR"))
                        .filter(line -> line.toLowerCase(java.util.Locale.ROOT).contains("batch")))
                .isEmpty();
    }

    @Test
    void noHeartbeatIsSentIfTheLoopNeverStarted() {
        assertThat(rig.heartbeat.stopAndSendFinal(Duration.ofSeconds(1))).isNull();
    }
}
