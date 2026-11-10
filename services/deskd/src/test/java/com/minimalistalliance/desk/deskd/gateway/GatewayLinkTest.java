package com.minimalistalliance.desk.deskd.gateway;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.platform.HeartbeatLoop;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.ControlPlaneRig;
import com.minimalistalliance.desk.deskd.testing.FakeGateway;
import com.minimalistalliance.desk.deskd.testing.FakePlatform;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.testing.TestTokens;
import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

class GatewayLinkTest {

    private static final String TAB = "ab".repeat(32);
    private static final String OTHER_TAB = "ef".repeat(32);

    @TempDir
    Path dir;

    private ControlPlaneRig rig;

    private ControlPlaneRig rig(GatewayLink.Timing timing) throws Exception {
        rig = new ControlPlaneRig(dir, timing, ControlPlaneRig.SLOW_BEATS);
        return rig;
    }

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
    }

    private static Map<String, Object> message(String type, Object... pairs) {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("type", type);
        for (int i = 0; i < pairs.length; i += 2) {
            message.put((String) pairs[i], pairs[i + 1]);
        }
        return message;
    }

    private String token(String fingerprint) {
        return rig.platform.tokens.mint(fingerprint, Instant.now());
    }

    private void open(String sessionId, String fingerprint) throws Exception {
        rig.gateway.send(message("session.open", "sessionId", sessionId, "deskToken", token(fingerprint), "openedAt", Instant.now().toString()));
        assertThat(rig.gateway.await("session.accept")).containsEntry("sessionId", sessionId);
    }

    /** All the way to a bound session that has said HELLO. Returns the client on the far side. */
    private TestClient connect(String sessionId, String fingerprint, long handle) throws Exception {
        open(sessionId, fingerprint);
        rig.gateway.send(message("signal", "sessionId", sessionId, "data", Map.of("type", "offer", "sdp", TestClient.offerFor(fingerprint))));
        Map<String, Object> signal = rig.gateway.await("signal");
        assertThat(signal).containsEntry("sessionId", sessionId);
        assertThat(Json.object(signal, "data")).containsEntry("type", "answer").containsEntry("sdp", "v=0 answer for test");
        TestClient client = new TestClient(rig.rtc, handle);
        client.hello();
        return client;
    }

    // ---- connecting

    @Test
    void defaultPingBeatsTheFirewallIdleClose() {
        // ma-platform ADR 0108: CloudFront in front of gw. closes a WebSocket idle about 100 s; desks ping at least every 45 s.
        assertThat(GatewayLink.Timing.DEFAULT.pingEvery()).isLessThanOrEqualTo(Duration.ofSeconds(45));
    }

    @Test
    void theUpgradeCarriesTheSubprotocolAndASignedStsRequestAndReadyComesFirst() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        FakeGateway.Upgrade upgrade = rig.gateway.upgrades.poll(5, TimeUnit.SECONDS);
        assertThat(upgrade.path()).isEqualTo("/v1");
        assertThat(upgrade.protocol()).isEqualTo("ma.gw.v1");

        Map<String, Object> blob = Json.parseObject(Base64.getUrlDecoder().decode(upgrade.auth()));
        assertThat(blob).containsEntry("url", "https://sts.us-east-1.amazonaws.com/");
        Map<String, Object> headers = Json.object(blob, "headers");
        assertThat(headers)
                .containsEntry("x-ma-gateway-id", "gw.test.invalid")
                .containsEntry("x-amz-security-token", FakePlatform.SESSION_TOKEN);
        assertThat((String) headers.get("authorization")).contains("/us-east-1/sts/aws4_request");

        Map<String, Object> ready = rig.gateway.poll(5000);
        assertThat(ready)
                .containsEntry("type", "ready")
                .containsEntry("bootId", "00000000-0000-4000-8000-000000000099")
                .containsEntry("runtimeVersion", "test-version")
                .containsEntry("deskApi", "1.0")
                .containsEntry("sessions", List.of())
                .containsEntry("peerSessions", List.of());
    }

    @Test
    void itSendsPingsAndGetsOnWithIt() throws Exception {
        rig(new GatewayLink.Timing(
                Duration.ofMillis(20), Duration.ofMillis(200), Duration.ofMillis(50), Duration.ofSeconds(5),
                Duration.ofMillis(100), Duration.ofHours(1), Duration.ZERO)).bootToReady();
        rig.gateway.await("ping");
        rig.gateway.await("ping");
        rig.gateway.await("ping");
        assertThat(rig.gateway.connections).hasValue(1);
        assertThat(rig.link.isReady()).isTrue();
    }

    @Test
    void aPingNobodyAnswersMeansReconnecting() throws Exception {
        rig(new GatewayLink.Timing(
                Duration.ofMillis(20), Duration.ofMillis(200), Duration.ofMillis(50), Duration.ofMillis(100),
                Duration.ofMillis(100), Duration.ofHours(1), Duration.ZERO)).bootToReady();
        rig.gateway.answerPing = false;
        await().atMost(Duration.ofSeconds(5)).until(() -> rig.gateway.connections.get() >= 2);
    }

    @Test
    void theNormalCloseAt2HoursReconnectsAndLiveSessionsSurvive() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        TestClient client = connect("cs-1", TAB, 1);

        rig.gateway.closeConnection(1001);
        await().atMost(Duration.ofSeconds(5)).until(() -> rig.gateway.connections.get() == 2);
        Map<String, Object> ready = rig.gateway.await("ready");
        assertThat(ready).containsEntry("sessions", List.of("cs-1"));
        await().until(rig.link::isReady);

        // The peer connection never noticed.
        assertThat(rig.sessions.sessionIds()).containsExactly("cs-1");
        assertThat(client.call("desk.status.get", Map.of())).containsEntry("_kind", "RES");

        // The new link works for new sessions.
        connect("cs-2", OTHER_TAB, 2);
    }

    @Test
    void anAbruptDropReconnectsToo() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        rig.gateway.closeConnection(1006);
        await().atMost(Duration.ofSeconds(5)).until(() -> rig.gateway.connections.get() == 2);
        await().until(rig.link::isReady);
    }

    @Test
    void connectionReplacedStopsReconnectingUntilTheNextHello() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        rig.gateway.send(message("error", "code", "connection_replaced", "message", "x", "retryable", false));
        Thread.sleep(50);
        rig.gateway.closeConnection(1000);
        await().until(() -> !rig.link.isReady());
        Thread.sleep(300);
        assertThat(rig.gateway.connections).hasValue(1);

        rig.link.enable();
        await().atMost(Duration.ofSeconds(5)).until(() -> rig.gateway.connections.get() == 2);
        await().until(rig.link::isReady);
    }

    @Test
    void close4403StopsReconnectingUntilTheNextHello() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        rig.gateway.closeConnection(4403);
        await().until(() -> !rig.link.isReady());
        Thread.sleep(300);
        assertThat(rig.gateway.connections).hasValue(1);
    }

    @Test
    void whenBlockedItAsksForAHelloAfterAWhileSoItCantStayStuck() throws Exception {
        rig(new GatewayLink.Timing(
                Duration.ofMillis(20), Duration.ofMillis(200), Duration.ofHours(1), Duration.ofSeconds(5),
                Duration.ofMillis(100), Duration.ofMillis(200), Duration.ZERO)).bootToReady();
        rig.platform.awaitApi("/v1/agent/hello");
        rig.gateway.closeConnection(4403);
        assertThat(rig.platform.awaitApi("/v1/agent/hello").json()).containsEntry("reason", "requested");
        await().atMost(Duration.ofSeconds(5)).until(() -> rig.gateway.connections.get() == 2);
    }

    @Test
    void a403AtTheUpgradeBlocksAndA401Retries() throws Exception {
        try (RefusingServer refusing = new RefusingServer(401)) {
            rig(ControlPlaneRig.FAST_LINK);
            rig.platform.gatewayUrl = "ws://127.0.0.1:" + refusing.port() + "/v1";
            rig.boot.start();
            await().atMost(Duration.ofSeconds(5)).until(() -> refusing.attempts.get() >= 3);
            // 401 means the blob or the credentials: it asks IMDS again.
            await().until(() -> rig.platform.credentialFetches.get() >= 2);
        }
    }

    @Test
    void a403AtTheUpgradeDoesntHammerTheGateway() throws Exception {
        try (RefusingServer refusing = new RefusingServer(403)) {
            rig(ControlPlaneRig.FAST_LINK);
            rig.platform.gatewayUrl = "ws://127.0.0.1:" + refusing.port() + "/v1";
            rig.boot.start();
            await().atMost(Duration.ofSeconds(5)).until(() -> refusing.attempts.get() >= 1);
            Thread.sleep(300);
            assertThat(refusing.attempts).hasValue(1);
        }
    }

    // ---- sessions

    @Test
    void openVerifiesThenSignalReachesDeskRtcAndTheAnswerComesBack() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        TestClient client = connect("cs-1", TAB, 1);
        Map<String, Object> create = rig.rtc.awaitJson("session.create");
        assertThat(create)
                .containsEntry("sessionId", "cs-1")
                .containsEntry("expectedFingerprint", TAB)
                .containsEntry("permissions", Map.of("video", true, "input", true));
        assertThat(create.get("offer")).isEqualTo(TestClient.offerFor(TAB));

        Map<String, Object> status = client.call("desk.status.get", Map.of());
        assertThat(status)
                .containsEntry("_kind", "RES")
                .containsEntry("deskId", TestTokens.DESK_ID)
                .containsEntry("instanceType", "c7g.large")
                .containsEntry("deskdVersion", "test-version");
    }

    /** The link's own stamps, against a real token. A span can read - if the test beats the writer's stamp. */
    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void aSessionsTimeOnTheLinkIsLoggedAndSaysNothingOfTheToken(CapturedOutput output) throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> rig.platform.awaitApi("/v1/agent/hello"));
        String badToken = "x" + token(TAB);
        rig.gateway.send(message("session.open", "sessionId", "cs-bad", "deskToken", badToken, "openedAt", Instant.now().toString()));
        rig.gateway.await("session.reject");
        await().until(() -> output.getOut().contains("result=rejected"));
        assertThat(output.getOut()).containsPattern("session timing first=true result=rejected openMs=\\d+");

        TestClient client = connect("cs-1", TAB, 1);
        assertThat(client.call("desk.status.get", Map.of())).containsEntry("_kind", "RES");
        await().until(() -> output.getOut().contains("result=ok"));
        assertThat(output.getOut()).containsPattern(
                "session timing first=true result=ok openMs=[\\d-]+ offerMs=\\d+ createMs=\\d+ connectMs=[\\d-]+ helloMs=\\d+ firstRpcMs=\\d+");
        assertThat(output.getOut()).doesNotContain("cs-1").doesNotContain(badToken);
    }

    @Test
    void aBadTokenIsRejectedAndAllocatesNothing() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        rig.gateway.send(message("session.open", "sessionId", "cs-1", "deskToken", "garbage"));
        assertThat(rig.gateway.await("session.reject"))
                .containsEntry("sessionId", "cs-1")
                .containsEntry("code", "invalid_token");
        assertThat(rig.sessions.sessionIds()).isEmpty();
        assertNothingSentToDeskRtc("session.create");
    }

    @Test
    void aTokenForAnotherDeskIsWrongDesk() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        Map<String, Object> claims = rig.platform.tokens.claims(TAB, Instant.now());
        claims.put("aud", "d-otherdesk0000");
        rig.gateway.send(message("session.open", "sessionId", "cs-1", "deskToken", rig.platform.tokens.es256(TestTokens.header(), claims)));
        assertThat(rig.gateway.await("session.reject")).containsEntry("code", "wrong_desk");
    }

    @Test
    void anOfferWithAnotherFingerprintGetsARefusalThenACloseAndAllocatesNothing() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        open("cs-1", TAB);
        rig.gateway.send(message("signal", "sessionId", "cs-1", "data", Map.of("type", "offer", "sdp", TestClient.offerFor(OTHER_TAB))));

        Map<String, Object> first = awaitSessionMessage();
        assertThat(first).containsEntry("type", "signal");
        assertThat(Json.object(first, "data"))
                .containsEntry("type", "refusal")
                .containsEntry("code", "identity_mismatch")
                .containsKey("message");
        Map<String, Object> second = awaitSessionMessage();
        assertThat(second).containsEntry("type", "session.close").containsEntry("reason", "identity_mismatch");
        assertThat(rig.sessions.sessionIds()).isEmpty();
        assertNothingSentToDeskRtc("session.create");
    }

    @Test
    void anOfferWithNoFingerprintOrNoSdpIsRefused() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        open("cs-1", TAB);
        rig.gateway.send(message("signal", "sessionId", "cs-1", "data", Map.of("type", "offer", "sdp", "v=0\r\n")));
        assertThat(Json.object(awaitSessionMessage(), "data")).containsEntry("code", "identity_mismatch");

        open("cs-2", TAB);
        rig.gateway.send(message("signal", "sessionId", "cs-2", "data", Map.of("type", "offer")));
        assertThat(Json.object(awaitSessionMessage(), "data")).containsEntry("code", "identity_mismatch");
    }

    private void assertNothingSentToDeskRtc(String type) throws InterruptedException {
        Map<String, Object> next;
        while ((next = rig.rtc.pollJson(50)) != null) {
            assertThat(next).doesNotContainEntry("t", type);
        }
    }

    private Map<String, Object> awaitSessionMessage() throws InterruptedException {
        while (true) {
            Map<String, Object> message = rig.gateway.poll(5000);
            assertThat(message).as("a session message from deskd").isNotNull();
            if (message.containsKey("sessionId")) {
                return message;
            }
        }
    }

    @Test
    void aSignalForASessionDeskdDoesntHaveTellsTheGatewaySo() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        rig.gateway.send(message("signal", "sessionId", "cs-gone", "data", Map.of("type", "offer", "sdp", TestClient.offerFor(TAB))));
        assertThat(Json.object(awaitSessionMessage(), "data")).containsEntry("type", "refusal");
        assertThat(awaitSessionMessage()).containsEntry("type", "session.close").containsEntry("reason", "closed_by_desk");
    }

    @Test
    void anIceRestartIsRelayedBothWays() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        connect("cs-1", TAB, 1);
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("type", "offer");
        data.put("sdp", TestClient.offerFor(TAB));
        data.put("restart", true);
        rig.gateway.send(message("signal", "sessionId", "cs-1", "data", data));
        assertThat(Json.object(rig.gateway.await("signal"), "data")).containsEntry("type", "answer");
        assertThat(rig.rtc.awaitJson("session.ice_restart")).containsEntry("sessionId", "cs-1");
        assertThat(rig.sessions.sessionIds()).containsExactly("cs-1");
    }

    @Test
    void otherSignalTypesAreIgnored() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        open("cs-1", TAB);
        rig.gateway.send(message("signal", "sessionId", "cs-1", "data", Map.of("type", "candidate", "candidate", "x")));
        rig.gateway.send(message("signal", "sessionId", "cs-1"));
        assertNothingSentToDeskRtc("session.create");
        assertThat(rig.sessions.sessionIds()).containsExactly("cs-1");
    }

    @Test
    void anAnswerTooLargeForTheGatewayIsNotSentAndTheSessionEnds() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        rig.rtc.autoAnswer(false);
        open("cs-1", TAB);
        rig.gateway.send(message("signal", "sessionId", "cs-1", "data", Map.of("type", "offer", "sdp", TestClient.offerFor(TAB))));
        rig.rtc.awaitJson("session.create");
        Map<String, Object> answer = new LinkedHashMap<>();
        answer.put("t", "session.answer");
        answer.put("sessionId", "cs-1");
        answer.put("handle", 1);
        answer.put("answer", "x".repeat(31 * 1024));
        rig.rtc.sendJson(answer);
        assertThat(Json.object(awaitSessionMessage(), "data")).containsEntry("type", "refusal").containsEntry("code", "internal");
        assertThat(awaitSessionMessage()).containsEntry("type", "session.close");
    }

    @Test
    void aLargeAnswerUnderTheLimitGetsThroughInFramesTheGatewayTakes() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        rig.rtc.autoAnswer(false);
        open("cs-1", TAB);
        rig.gateway.send(message("signal", "sessionId", "cs-1", "data", Map.of("type", "offer", "sdp", TestClient.offerFor(TAB))));
        rig.rtc.awaitJson("session.create");
        Map<String, Object> answer = new LinkedHashMap<>();
        answer.put("t", "session.answer");
        answer.put("sessionId", "cs-1");
        answer.put("handle", 1);
        answer.put("answer", "x".repeat(29 * 1024));
        rig.rtc.sendJson(answer);
        assertThat(Json.object(awaitSessionMessage(), "data")).containsEntry("type", "answer");
        assertThat(rig.gateway.largestFrameBytes.get()).isLessThanOrEqualTo(32 * 1024);
    }

    // ---- refresh and expiry

    @Test
    void aRefreshExtendsTheSessionAndWithoutOneItClosesAtExpPlus30() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        // Past exp, inside the skew: 2 s left in a valid token.
        Instant issued = Instant.now().minusSeconds(328);
        rig.gateway.send(message("session.open", "sessionId", "cs-1", "deskToken", rig.platform.tokens.mint(TAB, issued)));
        rig.gateway.await("session.accept");
        rig.gateway.send(message("signal", "sessionId", "cs-1", "data", Map.of("type", "offer", "sdp", TestClient.offerFor(TAB))));
        rig.gateway.await("signal");
        TestClient client = new TestClient(rig.rtc, 1);
        client.hello();

        rig.gateway.send(message("session.refresh", "sessionId", "cs-1", "deskToken", rig.platform.tokens.mint(TAB, issued.plusSeconds(1))));
        // The first token would have expired by now. The refresh gave it one more second, and then:
        long started = System.nanoTime();
        assertThat(client.nextJson(Channels.CTL, FrameKind.CLOSE)).containsEntry("code", 4401).containsEntry("reason", "token_expired");
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(6));
        assertThat(rig.gateway.await("session.close")).containsEntry("sessionId", "cs-1").containsEntry("reason", "token_expired");
        assertThat(rig.sessions.sessionIds()).isEmpty();
    }

    @Test
    void aGoodRefreshKeepsTheSessionPastTheOldToken() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        // 1 to 2 s left. With 329 it could be a few milliseconds, which failed now and then at session.open.
        rig.gateway.send(message("session.open", "sessionId", "cs-1", "deskToken", rig.platform.tokens.mint(TAB, Instant.now().minusSeconds(328))));
        rig.gateway.await("session.accept");
        rig.gateway.send(message("session.refresh", "sessionId", "cs-1", "deskToken", token(TAB)));
        Thread.sleep(2500);
        assertThat(rig.sessions.sessionIds()).containsExactly("cs-1");
    }

    @Test
    void aRefreshForAnotherSessionsSidLeavesItToExpire() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        rig.gateway.send(message("session.open", "sessionId", "cs-1", "deskToken", rig.platform.tokens.mint(TAB, Instant.now().minusSeconds(328))));
        rig.gateway.await("session.accept");
        Map<String, Object> claims = rig.platform.tokens.claims(TAB, Instant.now());
        claims.put("sid", "s-other");
        rig.gateway.send(message("session.refresh", "sessionId", "cs-1", "deskToken", rig.platform.tokens.es256(TestTokens.header(), claims)));
        await().atMost(Duration.ofSeconds(4)).until(() -> rig.sessions.sessionIds().isEmpty());
    }

    // ---- close, revoke, notify

    @Test
    void sessionCloseFromTheGatewayIsNotEchoedBack() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        TestClient client = connect("cs-1", TAB, 1);
        rig.gateway.send(message("session.close", "sessionId", "cs-1", "reason", "closed_by_client"));
        assertThat(client.nextJson(Channels.CTL, FrameKind.CLOSE)).containsEntry("code", 1000).containsEntry("reason", "closed_by_client");
        assertThat(rig.rtc.awaitJson("session.close")).containsEntry("sessionId", "cs-1");
        await().until(() -> rig.sessions.sessionIds().isEmpty());
        Thread.sleep(50);
        List<Object> types = new ArrayList<>();
        Map<String, Object> next;
        while ((next = rig.gateway.poll(10)) != null) {
            types.add(next.get("type"));
        }
        assertThat(types).doesNotContain("session.close");
    }

    @Test
    void closeCodesFollowTheGatewaysReason() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        TestClient stopping = connect("cs-1", TAB, 1);
        rig.gateway.send(message("session.close", "sessionId", "cs-1", "reason", "desk_stopping"));
        assertThat(stopping.nextJson(Channels.CTL, FrameKind.CLOSE)).containsEntry("code", 4503);
        TestClient revoked = connect("cs-2", OTHER_TAB, 2);
        rig.gateway.send(message("session.close", "sessionId", "cs-2", "reason", "revoked"));
        assertThat(revoked.nextJson(Channels.CTL, FrameKind.CLOSE)).containsEntry("code", 4401);
    }

    /** Regression: the jti was used up before the slot check, so the retry got invalid_token. */
    @Test
    void aTokenTurnedAwayFromAFullDeskCanBeTriedAgain() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        for (int i = 1; i <= 4; i++) {
            open("cs-" + i, String.valueOf(i).repeat(64));
        }
        String token = token("5".repeat(64));
        rig.gateway.send(message("session.open", "sessionId", "cs-5", "deskToken", token));
        assertThat(rig.gateway.await("session.reject"))
                .containsEntry("sessionId", "cs-5")
                .containsEntry("code", "session_limit_reached");
        rig.gateway.send(message("session.close", "sessionId", "cs-1", "reason", "closed_by_client"));
        await().until(() -> !rig.sessions.sessionIds().contains("cs-1"));

        rig.gateway.send(message("session.open", "sessionId", "cs-6", "deskToken", token));
        assertThat(rig.gateway.await("session.accept")).containsEntry("sessionId", "cs-6");

        // Once it has opened a session, the jti is used up as before.
        rig.gateway.send(message("session.close", "sessionId", "cs-6", "reason", "closed_by_client"));
        await().until(() -> !rig.sessions.sessionIds().contains("cs-6"));
        rig.gateway.send(message("session.open", "sessionId", "cs-7", "deskToken", token));
        assertThat(rig.gateway.await("session.reject")).containsEntry("code", "invalid_token");
    }

    /** A client may send a fresh token both ways, since session.refreshed doesn't prove the relay. */
    @Test
    void theSameTokenSentBothWaysIsHarmless() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        TestClient client = connect("cs-1", TAB, 1);
        String fresh = token(TAB);
        client.sendJson(Channels.CTL, FrameKind.AUTH, 7, Map.of("deskToken", fresh));
        assertThat(client.nextJson(Channels.CTL, FrameKind.AUTH)).containsEntry("ok", true);
        rig.gateway.send(message("session.refresh", "sessionId", "cs-1", "deskToken", fresh));
        // The first AUTH's thread lets go just after its reply, and until then a second gets rate_limited.
        Thread.sleep(200);
        client.sendJson(Channels.CTL, FrameKind.AUTH, 8, Map.of("deskToken", fresh));
        assertThat(client.nextJson(Channels.CTL, FrameKind.AUTH))
                .containsEntry("ok", false)
                .containsEntry("code", "invalid_token");
        assertThat(client.call("desk.status.get", Map.of())).containsEntry("_kind", "RES");
    }

    @Test
    void aSessionThatEndsOnTheDeskIsReportedWithAReasonOnTheGatewaysList() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        connect("cs-1", TAB, 1);
        rig.rtc.sendJson(Map.of("t", "session.closed", "sessionId", "cs-1", "reason", "consent_timeout"));
        assertThat(rig.gateway.await("session.close")).containsEntry("sessionId", "cs-1").containsEntry("reason", "closed_by_desk");
    }

    @Test
    void revokeClosesMatchingSessionsAndRefusesTheirNextToken() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        TestClient client = connect("cs-1", TAB, 1);
        rig.gateway.send(message("revoke", "revokedSessions", List.of("s-testsession"), "tokensValidAfter", null, "userIds", List.of()));
        assertThat(client.nextJson(Channels.CTL, FrameKind.CLOSE)).containsEntry("code", 4401).containsEntry("reason", "revoked");
        assertThat(rig.gateway.await("session.close")).containsEntry("reason", "revoked");

        rig.gateway.send(message("session.open", "sessionId", "cs-2", "deskToken", token(TAB)));
        assertThat(rig.gateway.await("session.reject")).containsEntry("code", "invalid_token");
    }

    @Test
    void revokeByUserAndByTokensValidAfterWork() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        connect("cs-1", TAB, 1);
        rig.gateway.send(message("revoke", "revokedSessions", List.of(), "userIds", List.of(TestTokens.OWNER_ID), "tokensValidAfter", null));
        assertThat(rig.gateway.await("session.close")).containsEntry("reason", "revoked");

        // A second later, a token issued after that revocation is good again.
        Thread.sleep(1100);
        connect("cs-2", OTHER_TAB, 2);
        rig.gateway.send(message("revoke", "tokensValidAfter", Instant.now().plusSeconds(1).toString()));
        assertThat(rig.gateway.await("session.close")).containsEntry("sessionId", "cs-2").containsEntry("reason", "revoked");
    }

    @Test
    void notifyConfigAndHeartbeatAreActedOnAndOtherTopicsIgnored() throws Exception {
        rig = new ControlPlaneRig(dir, ControlPlaneRig.FAST_LINK, new HeartbeatLoop.Timing(Duration.ofHours(1), Duration.ofMillis(10), Duration.ofSeconds(5)));
        rig.bootToReady();
        rig.platform.awaitApi("/v1/agent/heartbeat");

        rig.gateway.send(message("notify", "topic", "keys", "keysVersion", 8, "dropKeyIds", List.of()));
        rig.gateway.send(message("notify", "topic", "something_new"));
        rig.gateway.send(message("a.future.message", "x", 1));
        rig.gateway.send(message("notify", "topic", "heartbeat", "reason", "prepare_stop"));
        rig.platform.awaitApi("/v1/agent/heartbeat");

        rig.platform.configVersion = 13;
        rig.gateway.send(message("notify", "topic", "config", "configVersion", 13));
        rig.platform.awaitApi("/v1/agent/config");
        await().until(() -> rig.state.config().configVersion() == 13);
        assertThat(rig.link.isReady()).isTrue();
    }

    // ---- outbound limit

    @Test
    void nothingOverThe32KiBLimitIsSent() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        rig.gateway.await("ready");
        rig.link.offerRefused("cs-1", "x".repeat(GatewayLink.MAX_MESSAGE_BYTES));
        assertThat(rig.gateway.poll(100)).isNull();
        assertThat(rig.link.isReady()).isTrue();
    }

    @Test
    void aSecondMessageForASessionWaitsForTheFirst() throws Exception {
        rig(ControlPlaneRig.FAST_LINK).bootToReady();
        rig.gateway.send(message("session.open", "sessionId", "cs-1", "deskToken", token(TAB)));
        rig.gateway.send(message("session.close", "sessionId", "cs-1", "reason", "closed_by_client"));
        assertThat(rig.gateway.await("session.accept")).containsEntry("sessionId", "cs-1");
        await().until(() -> rig.sessions.sessionIds().isEmpty());
    }

    /** Answers every upgrade with an HTTP status, which the WebSocket test server can't do. */
    private static final class RefusingServer implements AutoCloseable {
        final AtomicInteger attempts = new AtomicInteger();
        private final ServerSocket server;
        private final int status;

        RefusingServer(int status) throws IOException {
            this.status = status;
            server = new ServerSocket(0, 16, InetAddress.getLoopbackAddress());
            Thread.ofVirtual().start(this::serve);
        }

        int port() {
            return server.getLocalPort();
        }

        private void serve() {
            while (true) {
                try (Socket socket = server.accept()) {
                    attempts.incrementAndGet();
                    socket.getOutputStream().write(("HTTP/1.1 " + status + " Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                            .getBytes(StandardCharsets.ISO_8859_1));
                    socket.getOutputStream().flush();
                } catch (IOException e) {
                    return;
                }
            }
        }

        @Override
        public void close() throws IOException {
            server.close();
        }
    }
}
