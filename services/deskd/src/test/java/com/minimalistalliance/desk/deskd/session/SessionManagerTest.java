package com.minimalistalliance.desk.deskd.session;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;
import static org.hamcrest.Matchers.equalTo;

import com.minimalistalliance.desk.deskd.auth.Revocations;
import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.Topic;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.ReassemblyBudget;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.status.DeskFacts;
import com.minimalistalliance.desk.deskd.status.StatusMethods;
import com.minimalistalliance.desk.deskd.testing.FakeDeskRtc;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import com.minimalistalliance.desk.deskd.testing.StubAuthorizer;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/** The session rules, against a fake desk-rtc on a real Unix socket. */
class SessionManagerTest {

    private static final String TAB_A = "aa".repeat(32);
    private static final String TAB_B = "bb".repeat(32);

    @TempDir
    Path dir;

    private FakeDeskRtc fake;
    private RtcClient rtc;
    private final StubAuthorizer authorizer = new StubAuthorizer();
    private final RpcDispatcher dispatcher = new RpcDispatcher();
    private final TopicRegistry topics = new TopicRegistry();
    private final EventHub hub = new EventHub(topics);
    private final List<String> closed = new CopyOnWriteArrayList<>();
    private SessionManager sessions;

    private static final DeskFacts FACTS = new DeskFacts() {
        @Override
        public String deskId() {
            return "d-test";
        }

        @Override
        public String bootId() {
            return "boot-1";
        }

        @Override
        public String instanceType() {
            return "c7g.large";
        }

        @Override
        public String publicIpv4() {
            return "203.0.113.7";
        }
    };

    @BeforeEach
    void setUp() throws Exception {
        Path socket = dir.resolve("rtc.sock");
        fake = new FakeDeskRtc(socket);
        rtc = new RtcClient(new RtcClient.Config(socket, SessionManager.MAX_SESSIONS, FACTS::publicIpv4));
        sessions = new SessionManager(rtc, authorizer, dispatcher, hub, FACTS, "1.2.3", Instant.parse("2026-11-05T04:40:00Z"));
        sessions.setObserver((id, reason) -> closed.add(id + "/" + reason));
        new StatusMethods(FACTS, rtc, "1.2.3", System.nanoTime()).register(dispatcher);
        rtc.start(sessions);
        await().until(rtc::isConfigured);
    }

    @AfterEach
    void tearDown() throws Exception {
        rtc.close();
        fake.close();
    }

    private static final class SummaryTopic implements Topic {
        final AtomicInteger snapshots = new AtomicInteger();

        @Override
        public boolean coalescible() {
            return true;
        }

        @Override
        public Object snapshot(String topicKey, Map<String, Object> params) {
            return Map.of("n", snapshots.incrementAndGet());
        }
    }

    /** Opens a session all the way to a bound handle. */
    private TestClient connect(String sessionId, String token, String sub, String fingerprint) throws Exception {
        authorizer.allow(token, sub, fingerprint);
        sessions.open(sessionId, token);
        assertThat(sessions.offer(sessionId, TestClient.offerFor(fingerprint))).isEqualTo("v=0 answer for test");
        Map<String, Object> create = fake.awaitJson("session.create");
        assertThat(create).containsEntry("sessionId", sessionId).containsEntry("expectedFingerprint", fingerprint);
        return new TestClient(fake, handleOf(sessionId));
    }

    private long nextWireHandle = 1;
    private final Map<String, Long> wireHandles = new HashMap<>();

    /** The fake gives out handles in order, one per session.create. */
    private long handleOf(String sessionId) {
        return wireHandles.computeIfAbsent(sessionId, id -> nextWireHandle++);
    }

    private TestClient connect(String sessionId) throws Exception {
        return connect(sessionId, "token-" + sessionId, "user-1", fingerprintFor(sessionId));
    }

    private static String fingerprintFor(String sessionId) {
        String seed = String.format("%02x", Math.abs(sessionId.hashCode()) % 200);
        return seed.repeat(32);
    }

    private void assertClosedWith(TestClient client, int code) throws Exception {
        Map<String, Object> close = client.nextJson(Channels.CTL, FrameKind.CLOSE);
        assertThat(close).containsEntry("code", code);
    }

    private void assertNoFrame(TestClient client, int channel) throws Exception {
        assertThat(fake.pollFrame(client.handle(), channel, 100)).isNull();
    }

    // ---- default deny

    @Test
    void aTokenThatDoesntVerifyAllocatesNothing() throws Exception {
        assertThatThrownBy(() -> sessions.open("cs-1", "bad"))
                .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class,
                        e -> assertThat(e.code()).isEqualTo("invalid_token"));
        assertThat(sessions.sessionIds()).isEmpty();
        fake.awaitJson("configure");
        assertThat(fake.pollJson(100)).isNull();
    }

    @Test
    void framesForAHandleNoSessionOwnsAreDropped() throws Exception {
        TestClient stranger = new TestClient(fake, 77);
        stranger.sendJson(Channels.CTL, FrameKind.HELLO, 0, Map.of("deskApi", "1.0"));
        stranger.sendJson(Channels.RPC, FrameKind.REQ, 1, Map.of("m", "desk.status.get"));
        assertThat(fake.pollFrame(77, Channels.CTL, 200)).isNull();
        assertThat(fake.pollFrame(77, Channels.RPC, 50)).isNull();
    }

    @Test
    void anOfferForASessionNobodyOpenedIsRefused() {
        assertThatThrownBy(() -> sessions.offer("cs-never", TestClient.offerFor(TAB_A)))
                .isInstanceOf(SessionAuthorizer.RefusedException.class);
    }

    @Test
    void anOfferWithTheWrongFingerprintAllocatesNothingAndEndsTheSession() throws Exception {
        authorizer.allow("t", "user-1", TAB_A);
        sessions.open("cs-1", "t");
        fake.awaitJson("configure");
        assertThatThrownBy(() -> sessions.offer("cs-1", TestClient.offerFor(TAB_B)))
                .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class,
                        e -> assertThat(e.code()).isEqualTo("identity_mismatch"));
        assertThat(sessions.sessionIds()).isEmpty();
        assertThat(fake.pollJson(100)).isNull();
        assertThat(closed).containsExactly("cs-1/identity_mismatch");
    }

    @Test
    void deskRtcRefusingASessionEndsIt() throws Exception {
        fake.autoAnswer(false);
        authorizer.allow("t", "user-1", TAB_A);
        sessions.open("cs-1", "t");
        Thread.ofVirtual().start(() -> {
            try {
                fake.awaitJson("session.create");
                fake.sendJson(Map.of("t", "session.error", "sessionId", "cs-1", "code", "session_limit_reached", "message", "x"));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        assertThatThrownBy(() -> sessions.offer("cs-1", TestClient.offerFor(TAB_A)))
                .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class,
                        e -> assertThat(e.code()).isEqualTo("session_limit_reached"));
        assertThat(sessions.sessionIds()).isEmpty();
    }

    @Test
    void openWaitsUntilDeskRtcIsConfigured() throws Exception {
        fake.drop();
        fake.autoConfigure(false);
        await().until(() -> !rtc.isConfigured());
        authorizer.allow("t", "user-1", TAB_A);
        assertThatThrownBy(() -> sessions.open("cs-1", "t"))
                .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class,
                        e -> assertThat(e.code()).isEqualTo("desk_not_ready"));
    }

    @Test
    void aSecondOfferOnTheSameSessionIsRefusedAndEndsIt() throws Exception {
        connect("cs-1");
        assertThatThrownBy(() -> sessions.offer("cs-1", TestClient.offerFor(fingerprintFor("cs-1"))))
                .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class,
                        e -> assertThat(e.code()).isEqualTo("bad_state"));
        assertThat(sessions.sessionIds()).isEmpty();
    }

    @Test
    void theRefusalComesBeforeTheCloseSoTheGatewayRelaysThemInThatOrder() throws Exception {
        List<String> events = new CopyOnWriteArrayList<>();
        sessions.setObserver(new SessionObserver() {
            @Override
            public void onSessionClosed(String sessionId, String reason) {
                events.add("closed " + sessionId + " " + reason);
            }

            @Override
            public void onOfferRefused(String sessionId, String code) {
                events.add("refused " + sessionId + " " + code);
            }
        });
        authorizer.allow("t", "user-1", TAB_A);
        sessions.open("cs-1", "t");
        assertThatThrownBy(() -> sessions.offer("cs-1", TestClient.offerFor(TAB_B)))
                .isInstanceOf(SessionAuthorizer.RefusedException.class);
        assertThatThrownBy(() -> sessions.offer("cs-never", TestClient.offerFor(TAB_B)))
                .isInstanceOf(SessionAuthorizer.RefusedException.class);
        assertThat(events).containsExactly(
                "refused cs-1 identity_mismatch",
                "closed cs-1 identity_mismatch",
                "refused cs-never unknown_session",
                "closed cs-never closed_by_desk");
    }

    @Test
    void anIceRestartIsCheckedTheSameWayAndAnsweredOnTheSameSession() throws Exception {
        TestClient client = connect("cs-1", "t", "user-1", TAB_A);
        client.hello();
        assertThat(sessions.iceRestart("cs-1", TestClient.offerFor(TAB_A))).isEqualTo("v=0 answer for test");
        assertThat(fake.awaitJson("session.ice_restart")).containsEntry("sessionId", "cs-1");
        assertThat(sessions.sessionIds()).containsExactly("cs-1");

        assertThatThrownBy(() -> sessions.iceRestart("cs-1", TestClient.offerFor(TAB_B)))
                .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class,
                        e -> assertThat(e.code()).isEqualTo("identity_mismatch"));
        assertClosedWith(client, 4403);
        assertThat(sessions.sessionIds()).isEmpty();
    }

    @Test
    void aSecondAnswerWithAnotherHandleDoesntMoveTheSession() throws Exception {
        TestClient client = connect("cs-1");
        client.hello();
        fake.sendJson(Map.of("t", "session.answer", "sessionId", "cs-1", "handle", 99, "answer", "x"));
        assertThat(fake.awaitJson("session.close")).containsEntry("sessionId", "cs-1");
        // Nothing the rogue handle carries reaches the session.
        fake.sendDataIgnoringCredit(99, Channels.RPC, new Frame(FrameKind.REQ, 0, 1, 0, Json.bytes(Map.of("m", "x"))).encode());
        assertNoFrame(client, Channels.RPC);
    }

    @Test
    void permissionsFromTheGrantReachDeskRtc() throws Exception {
        authorizer.allow("t", new SessionGrant("u", "s", "support", TAB_A, true, false, Instant.now(), Instant.now().plusSeconds(60)));
        sessions.open("cs-1", "t");
        sessions.offer("cs-1", TestClient.offerFor(TAB_A));
        assertThat(fake.awaitJson("session.create"))
                .containsEntry("permissions", Map.of("video", true, "input", false));
    }

    // ---- HELLO

    @Test
    void helloIsAnsweredWithEverythingTheClientNeeds() throws Exception {
        TestClient client = connect("cs-1");
        Map<String, Object> hello = client.hello();
        assertThat(hello)
                .containsEntry("deskApi", "1.0")
                .containsEntry("sessionId", "cs-1")
                .containsEntry("service", "deskd")
                .containsEntry("version", "1.2.3")
                .containsEntry("deskId", "d-test")
                .containsEntry("startedAt", "2026-11-05T04:40:00Z")
                .containsEntry("runtime", "java-21")
                .containsEntry("resumed", false)
                .containsKeys("serverTime");
        assertThat((String) hello.get("resumeToken")).hasSize(43);
        Map<String, Object> limits = Json.object(hello, "limits");
        assertThat(limits)
                .containsEntry("maxFrameBytes", 16384)
                .containsEntry("maxRequestBytes", 1024 * 1024)
                .containsEntry("maxEventBytes", 64 * 1024)
                .containsEntry("maxDataBytes", 4 * 1024 * 1024)
                .containsEntry("requestsPerSecond", 200)
                .containsEntry("maxSubscriptions", 64)
                .containsEntry("maxSessions", 4)
                .containsEntry("resumeWindowSec", 120);
    }

    @Test
    void aMinorVersionDifferenceIsFine() throws Exception {
        TestClient client = connect("cs-1");
        client.sendJson(Channels.CTL, FrameKind.HELLO, 0, Map.of("deskApi", "1.9", "appVersion", "x", "newField", 1));
        assertThat(client.nextJson(Channels.CTL, FrameKind.HELLO)).containsEntry("deskApi", "1.0");
    }

    @Test
    void aMajorVersionMismatchClosesWith4426() throws Exception {
        TestClient client = connect("cs-1");
        client.sendJson(Channels.CTL, FrameKind.HELLO, 0, Map.of("deskApi", "2.0", "appVersion", "x"));
        Map<String, Object> close = client.nextJson(Channels.CTL, FrameKind.CLOSE);
        assertThat(close).containsEntry("code", 4426).containsEntry("deskApi", "1.0");
        await().until(() -> sessions.sessionIds().isEmpty());
        assertThat(fake.awaitJson("session.close")).containsEntry("code", 4426);
    }

    @Test
    void aMissingVersionClosesWith4426() throws Exception {
        TestClient client = connect("cs-1");
        client.sendJson(Channels.CTL, FrameKind.HELLO, 0, Map.of("appVersion", "x"));
        assertClosedWith(client, 4426);
    }

    @Test
    void requestsBeforeHelloAreUnauthorized() throws Exception {
        TestClient client = connect("cs-1");
        Map<String, Object> reply = client.call("desk.status.get", Map.of());
        assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", "unauthorized");
        assertThat(sessions.sessionIds()).contains("cs-1");
    }

    @Test
    void aSecondHelloIsAProtocolError() throws Exception {
        TestClient client = connect("cs-1");
        client.hello();
        client.sendJson(Channels.CTL, FrameKind.HELLO, 0, Map.of("deskApi", "1.0"));
        assertClosedWith(client, CloseCodes.PROTOCOL_ERROR);
    }

    @Test
    void ctlFramesBeforeHelloAreAProtocolError() throws Exception {
        TestClient client = connect("cs-1");
        client.sendJson(Channels.CTL, FrameKind.ACTIVITY, 0, Map.of("lastInputAt", "2026-11-05T04:46:20Z"));
        assertClosedWith(client, CloseCodes.PROTOCOL_ERROR);
    }

    @Test
    void malformedFramesAndWrongKindsAreProtocolErrors() throws Exception {
        TestClient badVersion = connect("cs-1");
        fake.sendData(badVersion.handle(), Channels.CTL, new byte[] {2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0});
        assertClosedWith(badVersion, CloseCodes.PROTOCOL_ERROR);

        TestClient badJson = connect("cs-2");
        badJson.send(Channels.CTL, FrameKind.HELLO, 0, 0, "not json".getBytes());
        assertClosedWith(badJson, CloseCodes.PROTOCOL_ERROR);

        TestClient wrongChannel = connect("cs-3");
        wrongChannel.hello();
        wrongChannel.sendJson(Channels.EVENTS, FrameKind.EVT, 1, Map.of());
        assertClosedWith(wrongChannel, CloseCodes.PROTOCOL_ERROR);

        TestClient wrongKind = connect("cs-4");
        wrongKind.hello();
        wrongKind.send(Channels.RPC, FrameKind.PING, 1, 0, new byte[0]);
        assertClosedWith(wrongKind, CloseCodes.PROTOCOL_ERROR);
    }

    @Test
    void anUnknownKindIsIgnored() throws Exception {
        TestClient client = connect("cs-1");
        client.hello();
        fake.sendData(client.handle(), Channels.CTL, new byte[] {1, (byte) 200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0});
        client.send(Channels.CTL, FrameKind.PING, 9, 0, new byte[0]);
        assertThat(client.next(Channels.CTL).kind()).isEqualTo(FrameKind.PONG);
    }

    // ---- liveness and activity

    @Test
    void pingGetsPongWithTheSameIdAndPayload() throws Exception {
        TestClient client = connect("cs-1");
        client.hello();
        client.send(Channels.CTL, FrameKind.PING, 42, 0, "{\"t\":1}".getBytes());
        Frame pong = client.next(Channels.CTL);
        assertThat(pong.kind()).isEqualTo(FrameKind.PONG);
        assertThat(pong.id()).isEqualTo(42);
        assertThat(new String(pong.payload())).isEqualTo("{\"t\":1}");
    }

    @Test
    void aSilentClientIsNeverClosedAndDisconnectedDoesntEndASession() throws Exception {
        TestClient client = connect("cs-1");
        client.hello();
        fake.sendJson(Map.of("t", "session.state", "sessionId", "cs-1", "state", "connected", "transport", "udp"));
        await().until(() -> sessions.connectedCount() == 1);
        assertThat(sessions.transportCounts()).containsExactly(Map.entry("udp", 1));
        fake.sendJson(Map.of("t", "session.state", "sessionId", "cs-1", "state", "disconnected", "transport", "udp"));
        fake.sendJson(Map.of("t", "session.state", "sessionId", "cs-1", "state", "failed", "transport", "udp"));
        await().until(() -> sessions.connectedCount() == 0);
        Thread.sleep(100);
        assertThat(sessions.sessionIds()).containsExactly("cs-1");
        assertNoFrame(client, Channels.CTL);

        // What does end it: desk-rtc saying so. session.closed has the reason, so the closed state
        // just before it has to leave the session for it.
        fake.sendJson(Map.of("t", "session.state", "sessionId", "cs-1", "state", "closed", "transport", "udp"));
        fake.sendJson(Map.of("t", "session.closed", "sessionId", "cs-1", "reason", "identity_mismatch"));
        await().until(() -> !closed.isEmpty());
        assertThat(closed).containsExactly("cs-1/identity_mismatch");
    }

    /** Regression: every open session with a known transport counted, whatever its state. */
    @Test
    void transportsCountTheSameSessionsThatConnectedDoes() throws Exception {
        TestClient client = connect("cs-1");
        fake.sendJson(Map.of("t", "session.state", "sessionId", "cs-1", "state", "connected", "transport", "udp"));
        // A PONG comes back after the socket has carried the state, and PING is allowed before HELLO.
        client.send(Channels.CTL, FrameKind.PING, 1, 0, new byte[0]);
        assertThat(client.next(Channels.CTL).kind()).isEqualTo(FrameKind.PONG);
        // Not past HELLO yet.
        assertThat(sessions.connectedCount()).isZero();
        assertThat(sessions.transportCounts()).isEmpty();

        client.hello();
        assertThat(sessions.connectedCount()).isEqualTo(1);
        assertThat(sessions.transportCounts()).containsEntry("udp", 1);

        fake.sendJson(Map.of("t", "session.state", "sessionId", "cs-1", "state", "disconnected", "transport", "udp"));
        await().until(() -> sessions.connectedCount() == 0);
        assertThat(sessions.transportCounts()).isEmpty();
    }

    @Test
    void activityMovesLastInputForwardOnly() throws Exception {
        TestClient client = connect("cs-1");
        client.hello();
        assertThat(sessions.lastInputAt()).isNull();

        Instant first = Instant.parse("2026-01-02T03:04:05Z");
        client.sendJson(Channels.CTL, FrameKind.ACTIVITY, 0, Map.of("lastInputAt", first.toString()));
        await().until(() -> first.equals(sessions.lastInputAt()));

        client.sendJson(Channels.CTL, FrameKind.ACTIVITY, 0, Map.of("lastInputAt", "2025-01-01T00:00:00Z"));
        client.sendJson(Channels.CTL, FrameKind.ACTIVITY, 0, Map.of("lastInputAt", "garbage"));
        client.send(Channels.CTL, FrameKind.PING, 1, 0, new byte[0]);
        client.next(Channels.CTL);
        assertThat(sessions.lastInputAt()).isEqualTo(first);
    }

    @Test
    void aClientCantClaimInputInTheFuture() throws Exception {
        TestClient client = connect("cs-1");
        client.hello();
        client.sendJson(Channels.CTL, FrameKind.ACTIVITY, 0, Map.of("lastInputAt", "2099-01-01T00:00:00Z"));
        await().until(() -> sessions.lastInputAt() != null);
        assertThat(sessions.lastInputAt()).isBeforeOrEqualTo(Instant.now());
    }

    @Test
    void inputActivityFromDeskRtcCountsToo() throws Exception {
        connect("cs-1").hello();
        fake.sendJson(Map.of("t", "input.activity", "sessionId", "cs-1", "at", "2026-03-04T05:06:07Z"));
        await().until(() -> Instant.parse("2026-03-04T05:06:07Z").equals(sessions.lastInputAt()));

        fake.sendJson(Map.of("t", "input.activity", "sessionId", "cs-unknown", "at", "2026-06-06T06:06:06Z"));
        fake.sendJson(Map.of("t", "stats.get"));
        Thread.sleep(50);
        assertThat(sessions.lastInputAt()).isEqualTo(Instant.parse("2026-03-04T05:06:07Z"));
    }

    // ---- AUTH

    @Test
    void authExtendsTheSession() throws Exception {
        TestClient client = connect("cs-1", "t1", "user-1", TAB_A);
        client.hello();
        Instant later = Instant.now().plus(Duration.ofHours(2));
        authorizer.allow("t2", new SessionGrant("user-1", "sid-user-1", "owner", TAB_A, true, true, Instant.now(), later));
        client.sendJson(Channels.CTL, FrameKind.AUTH, 7, Map.of("deskToken", "t2"));
        Map<String, Object> reply = client.nextJson(Channels.CTL, FrameKind.AUTH);
        assertThat(reply).containsEntry("ok", true).containsEntry("validUntil", later.toString());
    }

    @Test
    void authWithABadTokenLeavesTheSessionAsItWas() throws Exception {
        TestClient client = connect("cs-1", "t1", "user-1", TAB_A);
        client.hello();
        client.sendJson(Channels.CTL, FrameKind.AUTH, 7, Map.of("deskToken", "bad"));
        assertThat(client.nextJson(Channels.CTL, FrameKind.AUTH)).containsEntry("ok", false).containsEntry("code", "invalid_token");
        assertThat(sessions.sessionIds()).containsExactly("cs-1");
    }

    @Test
    void aRefreshForAnotherHolderIsRefused() throws Exception {
        TestClient client = connect("cs-1", "t1", "user-1", TAB_A);
        client.hello();
        authorizer.allow("other-user", "user-2", TAB_A);
        authorizer.allow("other-tab", "user-1", TAB_B);
        assertThatThrownBy(() -> sessions.refresh("cs-1", "other-user"))
                .isInstanceOf(SessionAuthorizer.RefusedException.class);
        client.sendJson(Channels.CTL, FrameKind.AUTH, 1, Map.of("deskToken", "other-tab"));
        assertThat(client.nextJson(Channels.CTL, FrameKind.AUTH)).containsEntry("ok", false);
    }

    @Test
    void aRefreshWithAnotherSidIsRefused() throws Exception {
        connect("cs-1", "t1", "user-1", TAB_A);
        authorizer.allow("t2", new SessionGrant("user-1", "sid-other", "owner", TAB_A, true, true, Instant.now(), Instant.now().plus(Duration.ofHours(2))));
        assertThatThrownBy(() -> sessions.refresh("cs-1", "t2"))
                .isInstanceOf(SessionAuthorizer.RefusedException.class);
    }

    @Test
    void anOlderTokenArrivingLateDoesntShortenTheSession() throws Exception {
        TestClient client = connect("cs-1", "t1", "user-1", TAB_A);
        client.hello();
        Instant later = Instant.now().plus(Duration.ofHours(2));
        authorizer.allow("newer", new SessionGrant("user-1", "sid-user-1", "owner", TAB_A, true, true, Instant.now(), later));
        authorizer.allow("older", new SessionGrant("user-1", "sid-user-1", "owner", TAB_A, true, true, Instant.now(), later.minusSeconds(600)));
        sessions.refresh("cs-1", "newer");
        client.sendJson(Channels.CTL, FrameKind.AUTH, 1, Map.of("deskToken", "older"));
        assertThat(client.nextJson(Channels.CTL, FrameKind.AUTH)).containsEntry("validUntil", later.toString());
    }

    @Test
    void aRefreshThatChangesPermissionsTellsDeskRtc() throws Exception {
        connect("cs-1", "t1", "user-1", TAB_A);
        authorizer.allow("t2", new SessionGrant("user-1", "sid-user-1", "owner", TAB_A, false, false, Instant.now(), Instant.now().plus(Duration.ofHours(2))));
        sessions.refresh("cs-1", "t2");
        assertThat(fake.awaitJson("session.permissions")).containsEntry("video", false).containsEntry("input", false);
    }

    /**
     * Regression: session.permissions went out only once bound, and nothing sent it at the bind, so a token
     * that narrowed while session.create was out left desk-rtc injecting input for the rest of the session.
     */
    @Test
    void aRefreshThatNarrowsWhileSessionCreateIsOutReachesDeskRtcAtTheBind() throws Exception {
        authorizer.allow("t1", "user-1", TAB_A);
        authorizer.allow("t2", new SessionGrant("user-1", "sid-user-1", "owner", TAB_A, true, false, Instant.now(), Instant.now().plus(Duration.ofHours(2))));
        sessions.open("cs-1", "t1");
        fake.autoAnswer(false);
        Thread offer = Thread.ofVirtual().start(() -> {
            try {
                sessions.offer("cs-1", TestClient.offerFor(TAB_A));
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        });
        assertThat(fake.awaitJson("session.create")).containsEntry("permissions", Map.of("video", true, "input", true));
        sessions.refresh("cs-1", "t2");
        fake.sendJson(Map.of("t", "session.answer", "sessionId", "cs-1", "handle", 1, "answer", "v=0"));
        offer.join(Duration.ofSeconds(5));
        assertThat(fake.awaitJson("session.permissions")).containsEntry("video", true).containsEntry("input", false);
    }

    @Test
    void aRefreshThatChangesNothingWhileSessionCreateIsOutSendsNothing() throws Exception {
        authorizer.allow("t1", "user-1", TAB_A);
        authorizer.allow("t2", StubAuthorizer.grant("user-1", TAB_A, Duration.ofHours(2)));
        sessions.open("cs-1", "t1");
        fake.autoAnswer(false);
        Thread offer = Thread.ofVirtual().start(() -> {
            try {
                sessions.offer("cs-1", TestClient.offerFor(TAB_A));
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        });
        fake.awaitJson("session.create");
        sessions.refresh("cs-1", "t2");
        fake.sendJson(Map.of("t", "session.answer", "sessionId", "cs-1", "handle", 1, "answer", "v=0"));
        offer.join(Duration.ofSeconds(5));
        TestClient client = new TestClient(fake, 1);
        client.hello();
        Map<String, Object> message;
        while ((message = fake.pollJson(100)) != null) {
            assertThat(message.get("t")).isNotEqualTo("session.permissions");
        }
    }

    @Test
    void aRefreshBeforeTheOfferGoesIntoSessionCreate() throws Exception {
        authorizer.allow("t1", "user-1", TAB_A);
        authorizer.allow("t2", new SessionGrant("user-1", "sid-user-1", "owner", TAB_A, false, true, Instant.now(), Instant.now().plus(Duration.ofHours(2))));
        sessions.open("cs-1", "t1");
        sessions.refresh("cs-1", "t2");
        sessions.offer("cs-1", TestClient.offerFor(TAB_A));
        assertThat(fake.awaitJson("session.create")).containsEntry("permissions", Map.of("video", false, "input", true));
    }

    @Test
    void anExpiredTokenClosesWith4401() throws Exception {
        authorizer.allow("t", StubAuthorizer.grant("user-1", TAB_A, Duration.ofMillis(300)));
        sessions.open("cs-1", "t");
        sessions.offer("cs-1", TestClient.offerFor(TAB_A));
        TestClient client = new TestClient(fake, 1);
        client.hello();
        Map<String, Object> close = client.nextJson(Channels.CTL, FrameKind.CLOSE);
        assertThat(close).containsEntry("code", 4401).containsEntry("reason", "token_expired");
        assertThat(fake.awaitJson("session.close")).containsEntry("code", 4401);
        await().until(() -> closed.contains("cs-1/token_expired"));
    }

    @Test
    void aRefreshPushesExpiryBack() throws Exception {
        authorizer.allow("t", StubAuthorizer.grant("user-1", TAB_A, Duration.ofMillis(400)));
        authorizer.allow("t2", StubAuthorizer.grant("user-1", TAB_A, Duration.ofHours(1)));
        sessions.open("cs-1", "t");
        sessions.offer("cs-1", TestClient.offerFor(TAB_A));
        sessions.refresh("cs-1", "t2");
        Thread.sleep(600);
        assertThat(sessions.sessionIds()).containsExactly("cs-1");
    }

    // ---- limits and closes

    @Test
    void fourSessionsPerDesk() throws Exception {
        for (int i = 1; i <= 4; i++) {
            authorizer.allow("t" + i, "user-1", String.format("%02x", i).repeat(32));
            sessions.open("cs-" + i, "t" + i);
        }
        authorizer.allow("t5", "user-1", "05".repeat(32));
        assertThatThrownBy(() -> sessions.open("cs-5", "t5"))
                .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class,
                        e -> assertThat(e.code()).isEqualTo("session_limit_reached"));
        assertThat(sessions.sessionIds()).hasSize(4);

        sessions.close("cs-1", CloseCodes.FORBIDDEN, "closed_by_desk");
        sessions.open("cs-5", "t5");
        assertThat(sessions.sessionIds()).hasSize(4);
    }

    @Test
    void aNewSessionFromTheSameTabReplacesTheOldOneWith4409() throws Exception {
        TestClient old = connect("cs-1", "t1", "user-1", TAB_A);
        old.hello();
        authorizer.allow("t2", "user-1", TAB_A);
        sessions.open("cs-2", "t2");
        assertClosedWith(old, 4409);
        assertThat(sessions.sessionIds()).containsExactly("cs-2");
        await().until(() -> closed.contains("cs-1/replaced"));
    }

    @Test
    void aClientCloseEndsTheSessionWithNoResume() throws Exception {
        TestClient client = connect("cs-1");
        Map<String, Object> hello = client.hello();
        client.sendJson(Channels.CTL, FrameKind.CLOSE, 0, Map.of("code", 1000, "reason", "bye"));
        assertThat(fake.awaitJson("session.close")).containsEntry("reason", "closed_by_client");
        await().until(() -> sessions.sessionIds().isEmpty());
        assertThat(closed).contains("cs-1/closed_by_client");

        TestClient next = connect("cs-2");
        Map<String, Object> resumed = next.hello(Map.of("sessionId", "cs-1", "resumeToken", hello.get("resumeToken")));
        assertThat(resumed).containsEntry("resumed", false);
    }

    @Test
    void aRevocationClosesWith4401AndLeavesNothingToResume() throws Exception {
        TestClient client = connect("cs-1");
        Map<String, Object> hello = client.hello();
        sessions.revoke(grant -> grant.sub().equals("user-1"));
        Map<String, Object> close = client.nextJson(Channels.CTL, FrameKind.CLOSE);
        assertThat(close).containsEntry("code", 4401).containsEntry("reason", "revoked");

        // Nothing kept for the old session, nor for one that was already waiting.
        TestClient next = connect("cs-2");
        assertThat(next.hello(Map.of("sessionId", "cs-1", "resumeToken", hello.get("resumeToken"))))
                .containsEntry("resumed", false);

        Map<String, Object> hello3 = connect("cs-3").hello();
        fake.sendJson(Map.of("t", "session.closed", "sessionId", "cs-3", "reason", "x"));
        await().until(() -> !sessions.sessionIds().contains("cs-3"));
        sessions.revoke(grant -> true);
        TestClient last = connect("cs-4");
        assertThat(last.hello(Map.of("sessionId", "cs-3", "resumeToken", hello3.get("resumeToken"))))
                .containsEntry("resumed", false);
    }

    /**
     * Regression: the revocation's scan ran before the session was in live and later repeats of the
     * sid scan nothing, so the session stayed open until exp + 30 s, up to about 5.5 minutes.
     */
    @Test
    void aRevocationThatLandsWhileATokenIsBeingCheckedStillStopsTheSession() throws Exception {
        authorizer.allow("t", "user-1", TAB_A);
        authorizer.afterCheck(() -> {
            authorizer.revokeSid("sid-user-1");
            sessions.revoke(authorizer::isRevoked);
        });
        assertThatThrownBy(() -> sessions.open("cs-1", "t"))
                .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class,
                        e -> assertThat(e.code()).isEqualTo("invalid_token"));
        assertThat(sessions.sessionIds()).isEmpty();
        assertThatThrownBy(() -> sessions.offer("cs-1", TestClient.offerFor(TAB_A)))
                .isInstanceOf(SessionAuthorizer.RefusedException.class);
    }

    @Test
    void stoppingClosesEverySessionWith4503AndRefusesNewOnes() throws Exception {
        TestClient client = connect("cs-1");
        client.hello();
        sessions.stop(true);
        Map<String, Object> close = client.nextJson(Channels.CTL, FrameKind.CLOSE);
        assertThat(close).containsEntry("code", 4503).containsEntry("reason", "desk_stopping");
        assertThat(fake.awaitJson("session.close")).containsEntry("code", 4503).containsEntry("reason", "desk_stopping");
        assertThat(closed).contains("cs-1/desk_stopping");
        authorizer.allow("t", "user-1", TAB_A);
        assertThatThrownBy(() -> sessions.open("cs-2", "t"))
                .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class,
                        e -> assertThat(e.code()).isEqualTo("desk_not_ready"));
    }

    /** Regression: 4503 on every SIGTERM made clients stop retrying through a plain restart of deskd. */
    @Test
    void aRestartClosesEverySessionWith4002AndTheGatewayHearsClosedByDesk() throws Exception {
        TestClient client = connect("cs-1");
        client.hello();
        sessions.stop(false);
        Map<String, Object> close = client.nextJson(Channels.CTL, FrameKind.CLOSE);
        assertThat(close).containsEntry("code", 4002).containsEntry("reason", "deskd_restarting");
        assertThat(fake.awaitJson("session.close")).containsEntry("code", 4002).containsEntry("reason", "deskd_restarting");
        // deskd_restarting isn't on gateway.md 2.3's list.
        assertThat(closed).contains("cs-1/closed_by_desk").doesNotContain("cs-1/deskd_restarting");
        authorizer.allow("t", "user-1", TAB_A);
        assertThatThrownBy(() -> sessions.open("cs-2", "t"))
                .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class,
                        e -> assertThat(e.code()).isEqualTo("desk_not_ready"));
    }

    @Test
    void aFailureOnTheDesksSideIsNotMistakenForARestart() throws Exception {
        assertThat(CloseCodes.INTERNAL).isNotEqualTo(CloseCodes.DESKD_RESTARTING);
        TestClient client = connect("cs-1");
        client.hello();
        sessions.registerChannelHandler(Channels.BULK, (session, message) -> {
            throw new IllegalStateException("a module failed");
        });
        client.sendJson(Channels.BULK, FrameKind.DATA, 1, Map.of());
        Map<String, Object> close = client.nextJson(Channels.CTL, FrameKind.CLOSE);
        assertThat(close).containsEntry("code", 4003).containsEntry("reason", "internal");
    }

    @Test
    void closeReachesTheClientBeforeDeskRtcHearsToCloseIt() throws Exception {
        TestClient client = connect("cs-1");
        client.hello();
        sessions.close("cs-1", CloseCodes.FORBIDDEN, "closed_by_desk");
        fake.awaitJson("session.close");
        // awaitJson returned, so CLOSE was already written: the socket keeps their order.
        assertThat(fake.pollFrame(client.handle(), Channels.CTL, 100)).isNotNull();
    }

    /**
     * Regression: a client with a valid session that stopped reading ctl and sent PINGs with new ids
     * kept getting credit back while PONGs filled the heap, until -XX:+ExitOnOutOfMemoryError ended
     * every session on the desk. Now its lane parks, and with no credit its own sends stop.
     */
    @Test
    void aClientThatStopsReadingCtlRunsOutOfCreditInsteadOfFillingTheHeap() throws Exception {
        fake.autoCredit(false);
        TestClient client = connect("cs-1");
        client.hello();
        long internal = (1L << 32) | client.handle();
        byte[] payload = new byte[60 * 1024];
        long sent = 0;
        long id = 1;
        long deadline = System.nanoTime() + Duration.ofSeconds(8).toNanos();
        flood:
        while (System.nanoTime() < deadline) {
            for (byte[] frame : Frame.fragment(FrameKind.PING, 0, id, 0, payload)) {
                if (RtcClient.INITIAL_CREDIT + fake.creditFromDeskd(client.handle(), Channels.CTL) - sent < frame.length) {
                    break flood;
                }
                fake.sendDataIgnoringCredit(client.handle(), Channels.CTL, frame);
                sent += frame.length;
            }
            id++;
            Thread.sleep(20); // Inside the 50 a second that ctl allows.
        }
        assertThat(System.nanoTime()).as("the client ran out of credit").isLessThan(deadline);
        assertThat(rtc.queuedBytes(internal, Channels.CTL))
                .isLessThanOrEqualTo(RtcClient.CHANNEL_QUEUE_LIMIT + Frame.MAX_FRAME_BYTES);
        assertThat(sessions.sessionIds()).containsExactly("cs-1");

        // The parked lane doesn't stop the session closing.
        sessions.close("cs-1", CloseCodes.NORMAL, CloseCodes.REASON_CLOSED_BY_DESK);
        assertThat(fake.awaitJson("session.close")).containsEntry("sessionId", "cs-1");
    }

    @Test
    void anOversizeRequestGetsAnErrorAndTheSessionGoesOn() throws Exception {
        TestClient client = connect("cs-1");
        client.hello();
        client.send(Channels.RPC, FrameKind.REQ, 9, 0, new byte[FrameKind.REQ.maxMessageBytes() + 1]);
        Map<String, Object> reply = client.nextReply();
        assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", "too_large").containsEntry("_id", 9L);
        assertThat(client.call("desk.status.get", Map.of())).containsEntry("_kind", "RES");
    }

    @Test
    void anOversizeMessageOnAModuleChannelClosesWith4001() throws Exception {
        TestClient client = connect("cs-1");
        client.hello();
        client.send(Channels.MDOC, FrameKind.EVT, 1, 0, new byte[FrameKind.EVT.maxMessageBytes() + 1]);
        assertClosedWith(client, CloseCodes.TOO_LARGE);
    }

    @Test
    void tooMuchHeldInIncompleteMessagesClosesWith4001() throws Exception {
        TestClient client = connect("cs-1");
        client.hello();
        byte[] full = new byte[Frame.MAX_PAYLOAD_BYTES];
        long sent = 0;
        // Never finished, across many ids, under the per-channel count until the budget runs out.
        for (int id = 0; sent <= ReassemblyBudget.DEFAULT_BYTES; id = (id + 1) % 32) {
            fake.sendData(client.handle(), Channels.COLLAB, new Frame(FrameKind.DATA, Frame.MORE | Frame.BIN, id, 0, full).encode());
            sent += full.length;
        }
        assertClosedWith(client, CloseCodes.TOO_LARGE);
    }

    @Test
    void aFloodOfControlFramesIsIgnoredThenClosed() throws Exception {
        TestClient client = connect("cs-1");
        client.hello();
        for (int i = 0; i < 1300; i++) {
            client.send(Channels.CTL, FrameKind.PING, i, 0, new byte[0]);
        }
        Frame frame;
        int pongs = 0;
        while ((frame = client.next(Channels.CTL)).kind() == FrameKind.PONG) {
            pongs++;
        }
        assertThat(frame.kind()).isEqualTo(FrameKind.CLOSE);
        assertThat(TestClient.parse(frame.payload())).containsEntry("code", 4429);
        assertThat(pongs).isLessThan(300);
    }

    // ---- credit, end to end

    @Test
    void aBlockedModuleOnBulkDoesntHoldUpCtlOrRpc() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch entered = new CountDownLatch(1);
        sessions.registerChannelHandler(Channels.BULK, (session, message) -> {
            entered.countDown();
            release.await();
        });
        TestClient client = connect("cs-1");
        client.hello();

        Frame chunk = new Frame(FrameKind.CHUNK, Frame.BIN, 1, 0, new byte[Frame.MAX_PAYLOAD_BYTES]);
        int frames = (int) (RtcClient.INITIAL_CREDIT / Frame.MAX_FRAME_BYTES);
        for (int i = 0; i < frames; i++) {
            fake.sendData(client.handle(), Channels.BULK, chunk.encode());
        }
        entered.await();

        // The handler is parked on the first chunk: no credit yet on bulk, and ctl and rpc still work.
        client.send(Channels.CTL, FrameKind.PING, 1, 0, new byte[0]);
        assertThat(client.next(Channels.CTL).kind()).isEqualTo(FrameKind.PONG);
        assertThat(client.call("desk.status.get", Map.of())).containsEntry("_kind", "RES");
        assertThat(fake.creditFromDeskd(client.handle(), Channels.BULK)).isZero();

        release.countDown();
        await().until(() -> fake.creditFromDeskd(client.handle(), Channels.BULK) >= 64 * 1024);
    }

    @Test
    void aBigResponseFlowsUnderCreditAndCtlPassesIt() throws Exception {
        dispatcher.register("big", (context, params) -> Map.of("v", "x".repeat(900 * 1024)));
        TestClient client = connect("cs-1");
        client.hello();
        fake.autoCredit(false);
        client.sendJson(Channels.RPC, FrameKind.REQ, 1, Map.of("m", "big"));

        await().until(() -> fake.bytesFromDeskd(client.handle(), Channels.RPC) >= RtcClient.INITIAL_CREDIT - Frame.MAX_FRAME_BYTES);
        Thread.sleep(50);
        long stuckAt = fake.bytesFromDeskd(client.handle(), Channels.RPC);
        assertThat(stuckAt).isLessThanOrEqualTo(RtcClient.INITIAL_CREDIT);

        client.send(Channels.CTL, FrameKind.PING, 1, 0, new byte[0]);
        assertThat(client.next(Channels.CTL).kind()).isEqualTo(FrameKind.PONG);

        fake.autoCredit(true);
        fake.sendCredit(client.handle(), Channels.RPC, 2L * 1024 * 1024);
        Map<String, Object> reply = client.nextReply();
        assertThat(reply).containsEntry("_kind", "RES");
        assertThat((String) reply.get("v")).hasSize(900 * 1024);
    }

    @Test
    void aShortResponseOvertakesALongOneOnTheWire() throws Exception {
        CountDownLatch longStarted = new CountDownLatch(1);
        CountDownLatch shortStarted = new CountDownLatch(1);
        dispatcher.register("long", (context, params) -> {
            longStarted.countDown();
            return Map.of("v", "x".repeat(900 * 1024));
        });
        dispatcher.register("short", (context, params) -> {
            shortStarted.countDown();
            return Map.of("v", "y");
        });
        TestClient client = connect("cs-1");
        client.hello();
        fake.autoCredit(false);

        client.sendJson(Channels.RPC, FrameKind.REQ, 1, Map.of("m", "long"));
        longStarted.await();
        await().until(() -> fake.bytesFromDeskd(client.handle(), Channels.RPC) >= RtcClient.INITIAL_CREDIT - Frame.MAX_FRAME_BYTES);

        // The long reply is out of credit, with most of it still to come. The short one starts now.
        client.sendJson(Channels.RPC, FrameKind.REQ, 2, Map.of("m", "short"));
        shortStarted.await();
        fake.autoCredit(true);
        fake.sendCredit(client.handle(), Channels.RPC, 2L * 1024 * 1024);

        boolean shortSeen = false;
        boolean longDone = false;
        while (!shortSeen || !longDone) {
            Frame frame = client.next(Channels.RPC);
            if (frame.id() == 2) {
                assertThat(frame.more()).isFalse();
                assertThat(longDone).as("short came after the long one finished").isFalse();
                shortSeen = true;
            } else if (!frame.more()) {
                longDone = true;
            }
        }
    }

    @Test
    void aSlowConsumerOverRealCreditGetsOneFreshSnapshot() throws Exception {
        SummaryTopic topic = new SummaryTopic();
        topics.register("summary", topic);
        TestClient client = connect("cs-1");
        client.hello();
        assertThat(client.subscribe("summary", null)).containsEntry("_kind", "RES");
        assertThat(TestClient.parse(client.next(Channels.EVENTS).payload())).containsEntry("type", "snapshot");

        fake.autoCredit(false);
        long publishedBytes = 0;
        String padding = "p".repeat(32 * 1024);
        while (publishedBytes < 3L * 1024 * 1024) {
            hub.publish("summary", "patch", Map.of("padding", padding));
            publishedBytes += padding.length();
        }
        // Everything over the window waits in deskd, and past 1 MiB the deltas stop.
        await().until(() -> fake.bytesFromDeskd(client.handle(), Channels.EVENTS) >= RtcClient.INITIAL_CREDIT - 64 * 1024);
        assertThat(topic.snapshots).hasValue(1);

        fake.autoCredit(true);
        fake.sendCredit(client.handle(), Channels.EVENTS, 4L * 1024 * 1024);

        int snapshots = 0;
        long lastSeq = 1;
        while (snapshots == 0) {
            Frame frame = client.next(Channels.EVENTS);
            assertThat(frame.seq()).isGreaterThanOrEqualTo(lastSeq);
            lastSeq = frame.seq();
            if (!frame.more() && new String(frame.payload()).startsWith("{\"type\":\"snapshot\"")) {
                snapshots++;
            }
        }
        assertThat(topic.snapshots).hasValue(2);
        assertThat(fake.pollFrame(client.handle(), Channels.EVENTS, 100)).isNull();
    }

    // ---- resume

    @Test
    void resumeCarriesSubscriptionsOverToANewSession() throws Exception {
        SummaryTopic topic = new SummaryTopic();
        topics.register("summary", topic);
        TestClient first = connect("cs-1");
        Map<String, Object> hello = first.hello();
        Map<String, Object> sub = first.subscribe("summary", null);
        long subId = ((Number) sub.get("subId")).longValue();
        first.next(Channels.EVENTS);

        fake.sendJson(Map.of("t", "session.closed", "sessionId", "cs-1", "reason", "consent_timeout"));
        await().until(() -> sessions.sessionIds().isEmpty());
        assertThat(closed).as("not on the gateway's list, so mapped").contains("cs-1/closed_by_desk");

        TestClient second = connect("cs-2");
        Map<String, Object> resumed = second.hello(Map.of("sessionId", "cs-1", "resumeToken", hello.get("resumeToken")));
        assertThat(resumed).containsEntry("resumed", true).containsEntry("sessionId", "cs-2");
        assertThat(resumed.get("resumeToken")).isNotEqualTo(hello.get("resumeToken"));

        Map<String, Object> again = second.subscribe("summary", 1L);
        assertThat(((Number) again.get("subId")).longValue()).isEqualTo(subId);
        hub.publish("summary", "patch", Map.of("n", 1));
        Frame event = second.next(Channels.EVENTS);
        assertThat(event.id()).isEqualTo(subId);
    }

    @Test
    void aResumeTokenWorksOnlyOnce() throws Exception {
        TestClient first = connect("cs-1");
        Map<String, Object> hello = first.hello();
        fake.sendJson(Map.of("t", "session.closed", "sessionId", "cs-1", "reason", "x"));
        await().until(() -> sessions.sessionIds().isEmpty());

        Map<String, Object> token = Map.of("sessionId", "cs-1", "resumeToken", hello.get("resumeToken"));
        assertThat(connect("cs-2").hello(token)).containsEntry("resumed", true);
        assertThat(connect("cs-3").hello(token)).containsEntry("resumed", false);
    }

    @Test
    void aWrongResumeTokenStartsFreshAndLeavesTheRealOneValid() throws Exception {
        TestClient first = connect("cs-1");
        Map<String, Object> hello = first.hello();
        fake.sendJson(Map.of("t", "session.closed", "sessionId", "cs-1", "reason", "x"));
        await().until(() -> sessions.sessionIds().isEmpty());

        Map<String, Object> wrong = Map.of("sessionId", "cs-1", "resumeToken", "A".repeat(43));
        assertThat(connect("cs-2").hello(wrong)).containsEntry("resumed", false);
        Map<String, Object> garbage = Map.of("sessionId", "cs-1", "resumeToken", "!!!not base64!!!");
        assertThat(connect("cs-3").hello(garbage)).containsEntry("resumed", false);

        Map<String, Object> right = Map.of("sessionId", "cs-1", "resumeToken", hello.get("resumeToken"));
        assertThat(connect("cs-4").hello(right)).containsEntry("resumed", true);
    }

    @Test
    void anotherUserCantResumeSomeoneElsesState() throws Exception {
        TestClient first = connect("cs-1", "t1", "user-1", TAB_A);
        Map<String, Object> hello = first.hello();
        fake.sendJson(Map.of("t", "session.closed", "sessionId", "cs-1", "reason", "x"));
        await().until(() -> sessions.sessionIds().isEmpty());

        TestClient other = connect("cs-2", "t2", "user-2", TAB_B);
        assertThat(other.hello(Map.of("sessionId", "cs-1", "resumeToken", hello.get("resumeToken"))))
                .containsEntry("resumed", false);
    }

    @Test
    void aSessionStillLiveCanBeResumedByTheSameClient() throws Exception {
        TestClient first = connect("cs-1", "t1", "user-1", TAB_A);
        Map<String, Object> hello = first.hello();

        // Certificate rollover in the same tab: a new connection before the old one is seen to go.
        TestClient second = connect("cs-2", "t2", "user-1", TAB_B);
        Map<String, Object> resumed = second.hello(Map.of("sessionId", "cs-1", "resumeToken", hello.get("resumeToken")));
        assertThat(resumed).containsEntry("resumed", true);
        assertClosedWith(first, 4409);
        assertThat(sessions.sessionIds()).containsExactly("cs-2");
    }

    /**
     * Regression: a failed ICE restart ends the session with session.close closed_by_client and then
     * opens a new one, which design 4.2.7 says resumes. The state had gone by then, every time.
     */
    @Test
    void aClientThatClosedThroughTheGatewayCanStillResume() throws Exception {
        TestClient first = connect("cs-1");
        Map<String, Object> hello = first.hello();
        sessions.close("cs-1", CloseCodes.NORMAL, CloseCodes.REASON_CLOSED_BY_CLIENT);
        TestClient second = connect("cs-2");
        assertThat(second.hello(Map.of("sessionId", "cs-1", "resumeToken", hello.get("resumeToken"))))
                .containsEntry("resumed", true);
    }

    @Test
    void aClientTheGatewayGaveUpOnCanStillResume() throws Exception {
        Map<String, Object> hello = connect("cs-1").hello();
        sessions.close("cs-1", CloseCodes.PROTOCOL_ERROR, CloseCodes.REASON_CLIENT_GONE);
        await().until(() -> sessions.sessionIds().isEmpty());
        assertThat(connect("cs-2").hello(Map.of("sessionId", "cs-1", "resumeToken", hello.get("resumeToken"))))
                .containsEntry("resumed", true);
    }

    @Test
    void afterTheWindowThereIsNothingToResume() throws Exception {
        rtc.close();
        fake.close();
        Path socket = dir.resolve("rtc2.sock");
        fake = new FakeDeskRtc(socket);
        rtc = new RtcClient(new RtcClient.Config(socket, SessionManager.MAX_SESSIONS, FACTS::publicIpv4));
        sessions = new SessionManager(rtc, authorizer, dispatcher, hub, FACTS, "1.2.3", Instant.now(), Duration.ofMillis(100));
        rtc.start(sessions);
        await().until(rtc::isConfigured);

        TestClient first = connect("cs-1");
        Map<String, Object> hello = first.hello();
        fake.sendJson(Map.of("t", "session.closed", "sessionId", "cs-1", "reason", "x"));
        await().until(() -> sessions.sessionIds().isEmpty());
        Thread.sleep(300);
        assertThat(connect("cs-2").hello(Map.of("sessionId", "cs-1", "resumeToken", hello.get("resumeToken"))))
                .containsEntry("resumed", false);
    }

    @Test
    void idempotentResultsOutliveTheSessionThatMadeThem() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        dispatcher.registerMutation("test.do", (context, params) -> Map.of("run", runs.incrementAndGet()));
        TestClient first = connect("cs-1");
        first.hello();
        first.sendJson(Channels.RPC, FrameKind.REQ, 1, Map.of("m", "test.do", "idem", "key-1"));
        assertThat(first.nextReply()).containsEntry("run", 1);
        fake.sendJson(Map.of("t", "session.closed", "sessionId", "cs-1", "reason", "x"));
        await().until(() -> sessions.sessionIds().isEmpty());

        // A fresh session with no resume, as after the window has passed.
        TestClient second = connect("cs-2");
        second.hello();
        second.sendJson(Channels.RPC, FrameKind.REQ, 1, Map.of("m", "test.do", "idem", "key-1"));
        assertThat(second.nextReply()).containsEntry("run", 1);
        assertThat(runs).hasValue(1);
    }

    @Test
    void reasonsFromDeskRtcReachTheGatewayOnlyIfItsListHasThem() throws Exception {
        connect("cs-1");
        connect("cs-2");
        fake.sendJson(Map.of("t", "session.closed", "sessionId", "cs-1", "reason", "identity_mismatch"));
        fake.sendJson(Map.of("t", "session.closed", "sessionId", "cs-2", "reason", "dtls_failed"));
        await().until(() -> sessions.sessionIds().isEmpty());
        assertThat(closed).containsExactlyInAnyOrder("cs-1/identity_mismatch", "cs-2/closed_by_desk");
    }

    @Test
    void aCreditOverrunByDeskRtcEndsThatSessionOnly() throws Exception {
        TestClient client = connect("cs-1");
        client.hello();
        TestClient other = connect("cs-2");
        byte[] frame = new Frame(FrameKind.DATA, Frame.BIN, 1, 0, new byte[Frame.MAX_PAYLOAD_BYTES]).encode();
        // A parked handler drains nothing, so no credit comes back.
        sessions.registerChannelHandler(Channels.BULK, (session, message) -> new CountDownLatch(1).await());
        for (int i = 0; i <= RtcClient.INITIAL_CREDIT / frame.length; i++) {
            fake.sendDataIgnoringCredit(client.handle(), Channels.BULK, frame);
        }
        assertThat(fake.awaitJson("session.close")).containsEntry("reason", "credit_violation");
        await().until(() -> sessions.sessionIds().equals(List.of("cs-2")));
        assertThat(closed).contains("cs-1/closed_by_desk");
        other.hello();
    }

    // ---- a dropped rtc socket

    @Test
    void aDroppedRtcSocketEndsAllSessionsAndTheirStateCanStillBeResumed() throws Exception {
        TestClient first = connect("cs-1");
        Map<String, Object> hello = first.hello();
        connect("cs-2");
        assertThat(sessions.sessionIds()).hasSize(2);

        fake.drop();
        await().until(() -> sessions.sessionIds().isEmpty());
        assertThat(closed).contains("cs-1/closed_by_desk", "cs-2/closed_by_desk");

        await().until(rtc::isConfigured);
        TestClient back = connect("cs-3");
        assertThat(back.hello(Map.of("sessionId", "cs-1", "resumeToken", hello.get("resumeToken"))))
                .containsEntry("resumed", true);
    }

    // ---- status

    @Test
    void statusGetAnswersExactlyTheAgreedFields() throws Exception {
        TestClient client = connect("cs-1");
        client.hello();
        Map<String, Object> status = client.call("desk.status.get", Map.of());
        assertThat(status)
                .containsEntry("_kind", "RES")
                .containsEntry("deskId", "d-test")
                .containsEntry("deskdVersion", "1.2.3")
                .containsEntry("rtcVersion", "fake-rtc-1")
                .containsEntry("bootId", "boot-1")
                .containsEntry("instanceType", "c7g.large")
                .containsKeys("uptimeSec", "javaVersion");
        status.remove("_kind");
        status.remove("_id");
        assertThat(status).containsOnlyKeys(
                "deskId", "deskdVersion", "rtcVersion", "bootId", "uptimeSec", "javaVersion", "instanceType");
        assertThat((String) status.get("javaVersion")).startsWith("21.");
    }

    @Test
    void noModuleMeansModuleChannelsAreDroppedAndCredited() throws Exception {
        TestClient client = connect("cs-1");
        client.hello();
        Frame chunk = new Frame(FrameKind.CHUNK, Frame.BIN, 1, 0, new byte[Frame.MAX_PAYLOAD_BYTES]);
        for (int i = 0; i < 8; i++) {
            fake.sendData(client.handle(), Channels.BULK, chunk.encode());
        }
        await().until(() -> fake.creditFromDeskd(client.handle(), Channels.BULK) > 0);
    }

    @Test
    void modulesSeeNothingBeforeHello() throws Exception {
        AtomicInteger seen = new AtomicInteger();
        sessions.registerChannelHandler(Channels.MDOC, (session, message) -> seen.incrementAndGet());
        TestClient client = connect("cs-1");
        client.send(Channels.MDOC, FrameKind.DATA, 1, 0, new byte[3]);
        client.send(Channels.CTL, FrameKind.PING, 1, 0, new byte[0]);
        client.next(Channels.CTL);
        Thread.sleep(50);
        assertThat(seen).hasValue(0);

        client.hello();
        client.send(Channels.MDOC, FrameKind.DATA, 2, 0, new byte[3]);
        await().untilAtomic(seen, equalTo(1));
    }

    private TestClient connectWith(String sessionId, SessionGrant grant) throws Exception {
        authorizer.allow("token-" + sessionId, grant);
        sessions.open(sessionId, "token-" + sessionId);
        sessions.offer(sessionId, TestClient.offerFor(grant.expectedFingerprint()));
        fake.awaitJson("session.create");
        TestClient client = new TestClient(fake, handleOf(sessionId));
        client.hello();
        return client;
    }

    private static SessionGrant exportGrant(String fingerprint) {
        return new SessionGrant(
                "user-1", "sid-export", "export", fingerprint, false, false, Instant.now(), Instant.now().plusSeconds(3600));
    }

    @Test
    void activityFromASessionWithoutInputIsIgnored() throws Exception {
        TestClient client = connectWith("cs-1", exportGrant(TAB_A));
        client.sendJson(Channels.CTL, FrameKind.ACTIVITY, 0, Map.of("lastInputAt", "2026-01-02T03:04:05Z"));
        client.send(Channels.CTL, FrameKind.PING, 1, 0, new byte[0]);
        client.next(Channels.CTL);
        assertThat(sessions.lastInputAt()).isNull();
    }

    @Test
    void collabAndMdocAreTheOwnersAloneAndBulkIsNot() throws Exception {
        AtomicInteger collab = new AtomicInteger();
        AtomicInteger mdoc = new AtomicInteger();
        AtomicInteger bulk = new AtomicInteger();
        sessions.registerChannelHandler(Channels.COLLAB, (session, message) -> collab.incrementAndGet());
        sessions.registerChannelHandler(Channels.MDOC, (session, message) -> mdoc.incrementAndGet());
        sessions.registerChannelHandler(Channels.BULK, (session, message) -> bulk.incrementAndGet());
        TestClient export = connectWith("cs-1", exportGrant(TAB_A));
        export.send(Channels.COLLAB, FrameKind.DATA, 1, 0, new byte[3]);
        export.send(Channels.MDOC, FrameKind.DATA, 1, 0, new byte[3]);
        export.send(Channels.BULK, FrameKind.CREDIT, 1, 0, new byte[0]);
        await().untilAtomic(bulk, equalTo(1));
        export.send(Channels.CTL, FrameKind.PING, 1, 0, new byte[0]);
        export.next(Channels.CTL);
        assertThat(collab).hasValue(0);
        assertThat(mdoc).hasValue(0);

        TestClient owner = connect("cs-2");
        owner.hello();
        owner.send(Channels.COLLAB, FrameKind.DATA, 1, 0, new byte[3]);
        owner.send(Channels.MDOC, FrameKind.DATA, 1, 0, new byte[3]);
        await().untilAtomic(collab, equalTo(1));
        await().untilAtomic(mdoc, equalTo(1));
    }

    @Test
    void aRepeatedUserRevocationClosesASessionOpenedSinceTheFirst() throws Exception {
        // The revocations' clock starts at the real time, in whole seconds as iat has them, because the session
        // manager checks the grant's expiry against the real time: a fixed date would expire the grant once the day
        // got past it.
        MutableClock clock = new MutableClock(Instant.now().truncatedTo(ChronoUnit.SECONDS));
        Revocations revocations = new Revocations(clock);
        revocations.closeSessionsThrough(sessions);
        revocations.apply(List.of(), List.of("user-1"), null);
        SessionGrant grant = new SessionGrant(
                "user-1", "sid-1", "owner", TAB_A, true, true, clock.instant(), clock.instant().plusSeconds(3600));
        connectWith("cs-1", grant);
        assertThat(closed).isEmpty();

        revocations.apply(List.of(), List.of("user-1"), null);
        await().until(() -> closed.stream().anyMatch(entry -> entry.startsWith("cs-1/")));
    }

    // ---- what a session cost

    private static List<String> timingLines(CapturedOutput output) {
        return output.getOut().lines().filter(line -> line.contains("session timing")).toList();
    }

    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void aSessionLeavesOneLineWithEverySpanAndOnlyTheFirstSaysSo(CapturedOutput output) throws Exception {
        long received = System.nanoTime();
        authorizer.allow("token-cs-1", "user-1", fingerprintFor("cs-1"));
        sessions.open("cs-1", "token-cs-1", received);
        sessions.openAnswered("cs-1");
        sessions.offer("cs-1", TestClient.offerFor(fingerprintFor("cs-1")), System.nanoTime());
        sessions.answerSent("cs-1");
        fake.awaitJson("session.create");
        TestClient client = new TestClient(fake, handleOf("cs-1"));
        client.hello();
        assertThat(timingLines(output)).isEmpty();
        assertThat(client.call("desk.status.get", Map.of())).containsEntry("_kind", "RES");

        await().until(() -> !timingLines(output).isEmpty());
        assertThat(timingLines(output).get(0)).containsPattern(
                "session timing first=true result=ok openMs=\\d+ offerMs=\\d+ createMs=\\d+ connectMs=\\d+ helloMs=\\d+ firstRpcMs=\\d+$");

        // More calls and the session's end add nothing to it.
        assertThat(client.call("desk.status.get", Map.of())).containsEntry("_kind", "RES");
        sessions.close("cs-1", 1000, "closed_by_client");
        TestClient second = connect("cs-2");
        second.hello();
        assertThat(second.call("desk.status.get", Map.of())).containsEntry("_kind", "RES");
        await().until(() -> timingLines(output).size() == 2);
        assertThat(timingLines(output).get(1)).contains("first=false").contains("result=ok");
        assertThat(timingLines(output)).noneMatch(line -> line.contains("cs-1") || line.contains("cs-2") || line.contains("user-1"));
    }

    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void aSessionThatEndsEarlyStillSaysWhatItGotTo(CapturedOutput output) throws Exception {
        TestClient client = connect("cs-1");
        client.hello();
        sessions.close("cs-1", 1000, "closed_by_client");
        await().until(() -> !timingLines(output).isEmpty());
        assertThat(timingLines(output).get(0))
                .contains("first=true result=ended")
                .contains("connectMs=- ")
                .containsPattern("helloMs=\\d+ firstRpcMs=-$");
    }

    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void aRefusedOpenLeavesALineAndDoesntCountAsTheFirstSession(CapturedOutput output) throws Exception {
        sessions.openRefused(System.nanoTime());
        assertThat(timingLines(output)).hasSize(1);
        assertThat(timingLines(output).get(0)).containsPattern("first=true result=rejected openMs=\\d+$");

        TestClient client = connect("cs-1");
        client.hello();
        client.call("desk.status.get", Map.of());
        await().until(() -> timingLines(output).size() == 2);
        assertThat(timingLines(output).get(1)).contains("first=true result=ok");

        sessions.openRefused(System.nanoTime());
        assertThat(timingLines(output).get(2)).contains("first=false result=rejected");
    }

    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void aPingBeforeHelloDoesntStartTheHelloSpan(CapturedOutput output) throws Exception {
        TestClient client = connect("cs-1");
        client.send(Channels.CTL, FrameKind.PING, 1, 0, new byte[0]);
        assertThat(client.next(Channels.CTL).kind()).isEqualTo(FrameKind.PONG);
        sessions.close("cs-1", 1000, "closed_by_client");
        await().until(() -> !timingLines(output).isEmpty());
        assertThat(timingLines(output).get(0)).contains("helloMs=-");
    }
}
