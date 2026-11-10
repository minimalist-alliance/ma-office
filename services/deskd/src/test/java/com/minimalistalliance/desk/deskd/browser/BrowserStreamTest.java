package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.session.SessionGrant;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import com.minimalistalliance.desk.deskd.status.DeskFacts;
import com.minimalistalliance.desk.deskd.testing.FakeDeskRtc;
import com.minimalistalliance.desk.deskd.testing.StubAuthorizer;
import com.minimalistalliance.desk.deskd.testing.StubUnitsSocket;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
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

/**
 * browser.stream.set from the client's frames to session.video on a fake desk-rtc and to requests on a
 * stub units.sock, all on real Unix sockets.
 */
class BrowserStreamTest {

    private static final String START_BROWSER = "start desk-browser";
    private static final String START_STREAM = "start desk-stream";
    private static final String STOP_STREAM = "stop desk-stream";

    @TempDir
    Path dir;

    private FakeDeskRtc fake;
    private StubUnitsSocket units;
    private RtcClient rtc;
    private SessionManager sessions;
    private PlatformHttp http;
    private BrowserModule module;
    private final StubAuthorizer authorizer = new StubAuthorizer();
    private final Map<String, Long> handles = new HashMap<>();
    private long nextHandle = 1;
    private long nextRequest = 1000;

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
        units = new StubUnitsSocket(dir.resolve("units.sock"));
        rtc = new RtcClient(new RtcClient.Config(socket, SessionManager.MAX_SESSIONS, FACTS::publicIpv4));
        RpcDispatcher dispatcher = new RpcDispatcher();
        EventHub hub = new EventHub(new TopicRegistry());
        sessions = new SessionManager(rtc, authorizer, dispatcher, hub, FACTS, "1", Instant.now());
        http = new PlatformHttp();
        module = new BrowserModule(
                rtc,
                sessions,
                dispatcher,
                hub,
                http,
                new UnitsClient(dir.resolve("units.sock"))::run,
                dir.resolve(BrowserModule.REFUSAL_MARKER),
                9,
                BrowserRig.ownUid());
        units.forgetStartupThaw();
        rtc.start(sessions);
        await().until(rtc::isConfigured);
    }

    @AfterEach
    void tearDown() throws Exception {
        module.close();
        http.close();
        rtc.close();
        fake.close();
        units.close();
    }

    private TestClient connect(String sessionId, boolean video) throws Exception {
        String fingerprint = String.format("%02x", handles.size() + 16).repeat(32);
        SessionGrant grant = new SessionGrant(
                "user-1", "sid-" + sessionId, "owner", fingerprint, video, true, Instant.now(), Instant.now().plus(Duration.ofHours(1)));
        authorizer.allow("token-" + sessionId, grant);
        sessions.open(sessionId, "token-" + sessionId);
        sessions.offer(sessionId, TestClient.offerFor(fingerprint));
        handles.put(sessionId, nextHandle);
        TestClient client = new TestClient(fake, nextHandle++);
        client.hello();
        return client;
    }

    private TestClient connect(String sessionId) throws Exception {
        return connect(sessionId, true);
    }

    /** Sends the request and returns without waiting, so a test can do things while it's in flight. */
    private long send(TestClient client, String state) {
        long id = nextRequest++;
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("m", "browser.stream.set");
        body.put("p", Map.of("state", state));
        client.sendJson(Channels.RPC, FrameKind.REQ, id, body);
        return id;
    }

    private Map<String, Object> reply(TestClient client, long id) throws Exception {
        Map<String, Object> reply = client.nextReply();
        assertThat(reply).containsEntry("_id", id);
        return reply;
    }

    private Map<String, Object> set(TestClient client, String state) throws Exception {
        return reply(client, send(client, state));
    }

    private void assertState(Map<String, Object> reply, String state) {
        assertThat(reply).containsEntry("_kind", "RES").containsEntry("state", state);
    }

    /** Every session.video so far: "cs-1 true". Others are dropped. */
    private List<String> drainVideo(long waitMillis) throws Exception {
        List<String> video = new ArrayList<>();
        while (true) {
            Map<String, Object> message = fake.pollJson(waitMillis);
            if (message == null) {
                return video;
            }
            if ("session.video".equals(message.get("t"))) {
                video.add(message.get("sessionId") + " " + message.get("view"));
            }
        }
    }

    private String nextVideo() throws Exception {
        Map<String, Object> message = fake.awaitJson("session.video");
        return message.get("sessionId") + " " + message.get("view");
    }

    // ---- the table of desk-runtime.md 8.4

    @Test
    void liveStartsTheBrowserThenTheStreamThenSendsVideo() throws Exception {
        TestClient a = connect("cs-a");
        units.hold(START_BROWSER);
        units.hold(START_STREAM);
        long id = send(a, "live");
        units.awaitHeld(START_BROWSER);
        assertThat(units.requests()).containsExactly(START_BROWSER);
        units.release(START_BROWSER);
        units.awaitHeld(START_STREAM);
        assertThat(drainVideo(50)).isEmpty();
        units.release(START_STREAM);
        assertState(reply(a, id), "live");
        assertThat(nextVideo()).isEqualTo("cs-a true");
        assertThat(units.requests()).containsExactly(START_BROWSER, START_STREAM);
    }

    @Test
    void warmStartsOnlyTheStreamThenSaysViewFalse() throws Exception {
        TestClient a = connect("cs-a");
        units.hold(START_STREAM);
        long id = send(a, "warm");
        units.awaitHeld(START_STREAM);
        assertThat(drainVideo(50)).isEmpty();
        units.release(START_STREAM);
        assertState(reply(a, id), "warm");
        assertThat(nextVideo()).isEqualTo("cs-a false");
        assertThat(units.requests()).containsExactly(START_STREAM);
    }

    @Test
    void offCutsVideoFirstThenStopsTheStreamAndLeavesTheBrowser() throws Exception {
        TestClient a = connect("cs-a");
        assertState(set(a, "live"), "live");
        assertThat(nextVideo()).isEqualTo("cs-a true");
        units.clearRequests();

        units.hold(STOP_STREAM);
        long id = send(a, "off");
        assertThat(nextVideo()).isEqualTo("cs-a false");
        units.awaitHeld(STOP_STREAM);
        units.release(STOP_STREAM);
        assertState(reply(a, id), "off");
        assertThat(units.requests()).containsExactly(STOP_STREAM);
        assertThat(units.isRunning("desk-browser")).isTrue();
        assertThat(units.isRunning("desk-stream")).isFalse();
    }

    @Test
    void anOffWithNothingRunningAsksNothingOfTheUnits() throws Exception {
        TestClient a = connect("cs-a");
        assertState(set(a, "off"), "off");
        assertThat(nextVideo()).isEqualTo("cs-a false");
        assertThat(units.requests()).isEmpty();
    }

    @Test
    void settingAStateTwiceIsHarmlessAndNeedsNoIdem() throws Exception {
        TestClient a = connect("cs-a");
        assertState(set(a, "live"), "live");
        assertState(set(a, "live"), "live");
        assertState(set(a, "off"), "off");
        assertState(set(a, "off"), "off");
        assertThat(units.isRunning("desk-stream")).isFalse();
        assertThat(units.requests().stream().filter(STOP_STREAM::equals)).hasSize(1);
    }

    @Test
    void aBadStateIsABadRequestAndNothingMoves() throws Exception {
        TestClient a = connect("cs-a");
        assertThat(set(a, "sideways"))
                .containsEntry("_kind", "ERR")
                .containsEntry("code", "bad_request")
                .containsEntry("details", Map.of("reason", "state"));
        assertThat(units.requests()).isEmpty();
    }

    @Test
    void onlyATokenThatAllowsVideoMayGoLive() throws Exception {
        TestClient a = connect("cs-a", false);
        assertThat(set(a, "live"))
                .containsEntry("_kind", "ERR")
                .containsEntry("code", "forbidden")
                .containsEntry("details", Map.of("reason", "permission"));
        assertThat(units.requests()).isEmpty();
        assertState(set(a, "warm"), "warm");
    }

    // ---- several sessions

    @Test
    void theStreamStopsOnlyWhenTheLastSessionIsDone() throws Exception {
        TestClient a = connect("cs-a");
        TestClient b = connect("cs-b");
        assertState(set(a, "live"), "live");
        assertState(set(b, "warm"), "warm");
        assertThat(drainVideo(50)).containsExactly("cs-a true", "cs-b false");

        assertState(set(a, "off"), "off");
        assertThat(units.requests()).doesNotContain(STOP_STREAM);
        assertThat(units.isRunning("desk-stream")).isTrue();

        assertState(set(b, "off"), "off");
        assertThat(units.requests()).endsWith(STOP_STREAM);
        assertThat(units.isRunning("desk-stream")).isFalse();
    }

    @Test
    void aLaterViewerGetsVideoAtOnceWhileTheUnitsAreUp() throws Exception {
        TestClient a = connect("cs-a");
        TestClient b = connect("cs-b");
        assertState(set(a, "live"), "live");
        assertThat(nextVideo()).isEqualTo("cs-a true");
        // B13: warm to live can't wait for a Python process per unit.
        assertState(set(b, "warm"), "warm");
        assertThat(nextVideo()).isEqualTo("cs-b false");
        units.hold(START_BROWSER);
        long id = send(b, "live");
        assertThat(nextVideo()).isEqualTo("cs-b true");
        units.awaitHeld(START_BROWSER);
        units.release(START_BROWSER);
        assertState(reply(b, id), "live");
    }

    @Test
    void anOffWithAnotherViewerAnswersAtOnceThoughAStartIsUnderWay() throws Exception {
        TestClient a = connect("cs-a");
        TestClient b = connect("cs-b");
        assertState(set(a, "warm"), "warm");
        units.hold(START_STREAM);
        long live = send(b, "warm");
        units.awaitHeld(START_STREAM);
        assertState(set(a, "off"), "off");
        units.release(START_STREAM);
        assertState(reply(b, live), "warm");
        assertThat(units.isRunning("desk-stream")).isTrue();
    }

    // ---- interleavings

    @Test
    void anOffDuringAStartEndsStopped() throws Exception {
        TestClient a = connect("cs-a");
        units.hold(START_STREAM);
        long live = send(a, "live");
        units.awaitHeld(START_STREAM);

        long off = send(a, "off");
        // The earlier request is told what now applies, and off waits for the stop.
        assertState(reply(a, live), "off");
        assertThat(units.isRunning("desk-stream")).isFalse();
        units.release(START_STREAM);
        assertState(reply(a, off), "off");

        assertThat(units.requests()).containsExactly(START_BROWSER, START_STREAM, STOP_STREAM);
        assertThat(units.isRunning("desk-stream")).isFalse();
        assertThat(drainVideo(50)).containsExactly("cs-a false");
    }

    @Test
    void anOffDuringAStartOfTheBrowserNeedsNoStop() throws Exception {
        TestClient a = connect("cs-a");
        units.hold(START_BROWSER);
        send(a, "live");
        units.awaitHeld(START_BROWSER);
        send(a, "off");
        // Both answer at once, as nothing's left to wait for, and each call has its own thread: in either order.
        assertState(a.nextReply(), "off");
        assertState(a.nextReply(), "off");
        units.release(START_BROWSER);
        await().until(() -> units.isRunning("desk-browser"));
        assertThat(drainVideo(50)).containsExactly("cs-a false");
        assertThat(units.requests()).containsExactly(START_BROWSER);
    }

    @Test
    void aLiveDuringAStopEndsRunning() throws Exception {
        TestClient a = connect("cs-a");
        assertState(set(a, "live"), "live");
        assertThat(nextVideo()).isEqualTo("cs-a true");
        units.clearRequests();

        units.hold(STOP_STREAM);
        long off = send(a, "off");
        assertThat(nextVideo()).isEqualTo("cs-a false");
        units.awaitHeld(STOP_STREAM);

        long live = send(a, "live");
        assertState(reply(a, off), "live");
        // A stop is still happening, so no video yet.
        assertThat(drainVideo(50)).isEmpty();
        units.release(STOP_STREAM);
        assertState(reply(a, live), "live");
        assertThat(nextVideo()).isEqualTo("cs-a true");
        assertThat(units.requests()).containsExactly(STOP_STREAM, START_BROWSER, START_STREAM);
        assertThat(units.isRunning("desk-stream")).isTrue();
    }

    @Test
    void anotherSessionsLiveDuringAStopEndsRunningAndTheOffIsAnswered() throws Exception {
        TestClient a = connect("cs-a");
        TestClient b = connect("cs-b");
        assertState(set(a, "warm"), "warm");
        units.hold(STOP_STREAM);
        long off = send(a, "off");
        units.awaitHeld(STOP_STREAM);
        long live = send(b, "live");
        units.release(STOP_STREAM);
        assertState(reply(a, off), "off");
        assertState(reply(b, live), "live");
        assertThat(units.isRunning("desk-stream")).isTrue();
    }

    @Test
    void aStormOfRequestsEndsWhereTheLastOneSays() throws Exception {
        TestClient a = connect("cs-a");
        TestClient b = connect("cs-b");
        String[] states = {"live", "off", "warm", "live", "off"};
        // Past 32 running at once a session gets rate_limited, so these stay under that, or the last
        // word might be refused.
        List<Long> ids = new ArrayList<>();
        for (int round = 0; round < 5; round++) {
            for (String state : states) {
                ids.add(send(a, state));
                ids.add(send(b, state));
            }
        }
        await().atMost(Duration.ofSeconds(20)).untilAsserted(() -> {
            assertThat(units.isRunning("desk-stream")).isFalse();
            assertThat(drainVideo(20)).isNotNull();
            assertThat(sessions.isLive("cs-a")).isTrue();
        });
        long last = send(a, "live");
        await().atMost(Duration.ofSeconds(20)).until(() -> units.isRunning("desk-stream"));
        // Replies come in any order. Every request gets exactly one.
        List<Long> answered = new ArrayList<>();
        for (int i = 0; i < ids.size() / 2 + 1; i++) {
            Map<String, Object> reply = a.nextReply();
            assertThat(reply).containsEntry("_kind", "RES");
            answered.add((Long) reply.get("_id"));
        }
        assertThat(answered).contains(last).doesNotHaveDuplicates();
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            List<String> video = drainVideo(100);
            assertThat(video).endsWith("cs-a true");
        });
    }

    @Test
    void anOlderRequestThatReachesTheHandlerLateChangesNothing() {
        BrowserStream stream = new BrowserStream(
                (verb, unit) -> {}, (id, view) -> {}, id -> true, () -> {}, () -> {}, transition -> {}, Duration.ofMinutes(5), unusedMarker());
        assertThat(stream.set("cs-1", BrowserStream.Level.WARM, 5).join()).isEqualTo(BrowserStream.Level.WARM);
        assertThat(stream.set("cs-1", BrowserStream.Level.LIVE, 4).join()).isEqualTo(BrowserStream.Level.WARM);
        assertThat(stream.level()).isEqualTo(BrowserStream.Level.WARM);
    }

    @Test
    void aRequestThatLosesARaceWithItsSessionsEndLeavesNothing() {
        List<String> steps = new ArrayList<>();
        BrowserStream stream = new BrowserStream(
                (verb, unit) -> steps.add(verb), (id, view) -> {}, id -> false, () -> {}, () -> {}, transition -> {}, Duration.ofMinutes(5), unusedMarker());
        assertThat(stream.set("cs-gone", BrowserStream.Level.LIVE, 1).join()).isEqualTo(BrowserStream.Level.OFF);
        assertThat(stream.hasViewer()).isFalse();
        assertThat(steps).isEmpty();
    }

    // ---- sessions that end

    @Test
    void aSessionClosingWithoutOffCountsAsOffAndItsVideoIsCut() throws Exception {
        TestClient a = connect("cs-a");
        assertState(set(a, "live"), "live");
        assertThat(nextVideo()).isEqualTo("cs-a true");
        a.sendJson(Channels.CTL, FrameKind.CLOSE, 0, Map.of("code", 1000));
        assertThat(nextVideo()).isEqualTo("cs-a false");
        await().until(() -> !units.isRunning("desk-stream"));
        assertThat(units.requests()).endsWith(STOP_STREAM);
        assertThat(units.isRunning("desk-browser")).isTrue();
    }

    @Test
    void aRevocationCountsAsOff() throws Exception {
        TestClient a = connect("cs-a");
        TestClient b = connect("cs-b");
        assertState(set(a, "live"), "live");
        assertState(set(b, "live"), "live");
        drainVideo(50);
        sessions.revoke(grant -> grant.sid().equals("sid-cs-a"));
        assertThat(nextVideo()).isEqualTo("cs-a false");
        assertThat(units.isRunning("desk-stream")).isTrue();
        sessions.revoke(grant -> grant.sid().equals("sid-cs-b"));
        assertThat(nextVideo()).isEqualTo("cs-b false");
        await().until(() -> !units.isRunning("desk-stream"));
    }

    @Test
    void deskRtcGoingAwayCountsAsOffForEverySession() throws Exception {
        TestClient a = connect("cs-a");
        assertState(set(a, "live"), "live");
        assertThat(units.isRunning("desk-stream")).isTrue();
        fake.drop();
        await().until(() -> !units.isRunning("desk-stream"));
        assertThat(units.isRunning("desk-browser")).isTrue();
    }

    @Test
    void aSessionClosedDuringAStartEndsStoppedWithNoVideo() throws Exception {
        TestClient a = connect("cs-a");
        units.hold(START_STREAM);
        send(a, "live");
        units.awaitHeld(START_STREAM);
        a.sendJson(Channels.CTL, FrameKind.CLOSE, 0, Map.of("code", 1000));
        await().until(() -> !sessions.isLive("cs-a"));
        units.release(START_STREAM);
        await().until(() -> units.requests().contains(STOP_STREAM) && !units.isRunning("desk-stream"));
        assertThat(drainVideo(50)).doesNotContain("cs-a true");
    }

    @Test
    void aSessionThatNeverAskedForAnythingAsksNothingOfTheUnits() throws Exception {
        TestClient a = connect("cs-a");
        a.sendJson(Channels.CTL, FrameKind.CLOSE, 0, Map.of("code", 1000));
        await().until(() -> !sessions.isLive("cs-a"));
        Thread.sleep(50);
        assertThat(units.requests()).isEmpty();
    }

    // ---- failures

    @Test
    void aFailedStartIsUnavailableNamingTheUnitAndLeavesTheSessionOff() throws Exception {
        TestClient a = connect("cs-a");
        units.reply(START_BROWSER, "err failed start desk-browser: no");
        assertThat(set(a, "live"))
                .containsEntry("_kind", "ERR")
                .containsEntry("code", "unavailable")
                .containsEntry("details", Map.of("unit", "desk-browser", "code", "failed"));
        assertThat(units.requests()).containsExactly(START_BROWSER);
        assertThat(drainVideo(50)).isEmpty();

        units.replyOk(START_BROWSER);
        units.reply(START_STREAM, "err timeout start desk-stream took too long");
        assertThat(set(a, "live"))
                .containsEntry("code", "unavailable")
                .containsEntry("details", Map.of("unit", "desk-stream", "code", "timeout"));
        // It may have got halfway, so with nobody wanting it, it's stopped.
        await().until(() -> units.requests().contains(STOP_STREAM));

        units.replyOk(START_STREAM);
        assertState(set(a, "live"), "live");
        assertThat(nextVideo()).isEqualTo("cs-a true");
    }

    @Test
    void noUnitSocketIsUnavailableToo() throws Exception {
        TestClient a = connect("cs-a");
        units.close();
        assertThat(set(a, "warm"))
                .containsEntry("code", "unavailable")
                .containsEntry("details", Map.of("unit", "desk-stream", "code", "unreachable"));
        units = new StubUnitsSocket(dir.resolve("units.sock"));
    }

    @Test
    void aFailedStartOnlyFailsTheRequestsThatNeededIt() throws Exception {
        TestClient a = connect("cs-a");
        TestClient b = connect("cs-b");
        assertState(set(a, "live"), "live");
        assertThat(nextVideo()).isEqualTo("cs-a true");
        units.reply(START_STREAM, "err failed nope");
        assertThat(set(b, "warm")).containsEntry("code", "unavailable");
        // A's own want stands, and it keeps its video: it didn't ask for anything just now.
        assertThat(drainVideo(50)).doesNotContain("cs-a false");
        assertThat(units.requests()).doesNotContain(STOP_STREAM);
    }

    @Test
    void aFailureAfterVideoWentOutCutsVideoAgain() throws Exception {
        TestClient a = connect("cs-a");
        TestClient b = connect("cs-b");
        assertState(set(a, "live"), "live");
        assertThat(nextVideo()).isEqualTo("cs-a true");
        units.reply(START_STREAM, "err failed nope");
        assertThat(set(b, "live")).containsEntry("code", "unavailable");
        assertThat(drainVideo(50)).containsExactly("cs-b true", "cs-b false");
    }

    @Test
    void aFailedStopIsUnavailableAndTheNextOffTriesAgain() throws Exception {
        TestClient a = connect("cs-a");
        assertState(set(a, "warm"), "warm");
        units.reply(STOP_STREAM, "err failed still there");
        assertThat(set(a, "off"))
                .containsEntry("code", "unavailable")
                .containsEntry("details", Map.of("unit", "desk-stream", "code", "failed"));
        assertThat(units.isRunning("desk-stream")).isTrue();
        units.replyOk(STOP_STREAM);
        assertState(set(a, "off"), "off");
        assertThat(units.isRunning("desk-stream")).isFalse();
    }

    /** Regression: only an end of a session that still wanted the stream tried again, so this one stayed up. */
    @Test
    void aFailedStopIsTriedAgainWhenTheLastSessionThatWasAlreadyOffEnds() throws Exception {
        TestClient a = connect("cs-a");
        assertState(set(a, "warm"), "warm");
        units.reply(STOP_STREAM, "err failed still there");
        assertThat(set(a, "off")).containsEntry("code", "unavailable");
        assertThat(units.isRunning("desk-stream")).isTrue();
        units.replyOk(STOP_STREAM);
        units.clearRequests();
        a.sendJson(Channels.CTL, FrameKind.CLOSE, 0, Map.of("code", 1000));
        await().until(() -> !units.isRunning("desk-stream"));
        assertThat(units.requests()).containsExactly(STOP_STREAM);
    }

    @Test
    void aFailedStopIsTriedAgainWhenASessionThatNeverAskedForAnythingEnds() throws Exception {
        TestClient a = connect("cs-a");
        TestClient other = connect("cs-other");
        assertState(set(a, "warm"), "warm");
        units.reply(STOP_STREAM, "err failed still there");
        assertThat(set(a, "off")).containsEntry("code", "unavailable");
        a.sendJson(Channels.CTL, FrameKind.CLOSE, 0, Map.of("code", 1000));
        await().until(() -> !sessions.isLive("cs-a") && units.requests().stream().filter(STOP_STREAM::equals).count() == 2);
        assertThat(units.isRunning("desk-stream")).isTrue();
        units.replyOk(STOP_STREAM);
        other.sendJson(Channels.CTL, FrameKind.CLOSE, 0, Map.of("code", 1000));
        await().until(() -> !units.isRunning("desk-stream"));
    }

    @Test
    void aFailedStopWaitsWhileAnotherSessionWantsTheStream() throws Exception {
        TestClient a = connect("cs-a");
        TestClient b = connect("cs-b");
        TestClient c = connect("cs-c");
        assertState(set(a, "warm"), "warm");
        units.reply(STOP_STREAM, "err failed still there");
        assertThat(set(a, "off")).containsEntry("code", "unavailable");
        units.replyOk(STOP_STREAM);
        units.clearRequests();

        assertState(set(b, "warm"), "warm");
        units.clearRequests();
        c.sendJson(Channels.CTL, FrameKind.CLOSE, 0, Map.of("code", 1000));
        await().until(() -> !sessions.isLive("cs-c"));
        Thread.sleep(50);
        assertThat(units.requests()).isEmpty();
        assertThat(units.isRunning("desk-stream")).isTrue();
    }

    // ---- a Chromium the image refuses to start (desk-runtime.md 8.3, ADR 0035)

    /** Exactly what desk-units sends, and longer than UnitsClient keeps. */
    private static final String REFUSED =
            "err failed start desk-browser: desk-browser-start: REFUSING TO START, profile left untouched: profile last ran "
                    + "Chromium 157.0.0.0, newer than the installed 156.0.8078.79. Update Chromium; never remove the profile (ADR 0035)";
    private static final String REFUSED_TEXT = "start desk-browser: desk-browser-start: REFUSING TO START, profile left untouched";
    private static final Map<String, Object> REFUSED_DETAILS =
            Map.of("unit", "desk-browser", "code", "failed", "reason", "chromium_older_than_profile");

    @SuppressWarnings("unchecked")
    private Map<String, Object> browserHealth() {
        return (Map<String, Object>) module.health().get("browser");
    }

    private void assertRefusedState(boolean refused) {
        assertThat(module.chromiumRefused()).isEqualTo(refused);
        if (refused) {
            assertThat(browserHealth()).containsEntry("chromium", "older_than_profile");
        } else {
            assertThat(browserHealth()).doesNotContainKey("chromium");
        }
    }

    @Test
    void aRefusedStartIsUnavailableWithItsReasonAndNoneOfItsWords() throws Exception {
        TestClient a = connect("cs-a");
        assertRefusedState(false);
        units.reply(START_BROWSER, REFUSED);

        Map<String, Object> reply = set(a, "live");

        assertThat(reply)
                .containsEntry("_kind", "ERR")
                .containsEntry("code", "unavailable")
                .containsEntry("message", "A unit failed")
                .containsEntry("details", REFUSED_DETAILS);
        assertThat(reply.toString()).doesNotContain("REFUSING", "157.0.0.0", "156.0.8078.79", "profile last ran");
        // As with any failed start: nothing more was tried, and the session is off.
        assertThat(units.requests()).containsExactly(START_BROWSER);
        assertThat(drainVideo(50)).isEmpty();
        assertThat(module.health().get("stream").toString()).contains("wanted=off");
        assertRefusedState(true);
    }

    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void theRefusalsWordsGoToTheLog(CapturedOutput output) throws Exception {
        TestClient a = connect("cs-a");
        units.reply(START_BROWSER, REFUSED);
        assertThat(set(a, "live")).containsEntry("details", REFUSED_DETAILS);
        await().until(() -> output.getOut().contains(REFUSED_TEXT));
    }

    /** A profile the wrapper can't compare is refused the same way, and it's the same to a client. */
    @Test
    void everyReasonTheWrapperGivesCounts() throws Exception {
        TestClient a = connect("cs-a");
        for (String why : List.of(
                "/data/browser/profile/Last Version isn't a version, so it can't be compared",
                "can't read the installed Chromium's version")) {
            units.reply(START_BROWSER, "err failed start desk-browser: desk-browser-start: REFUSING TO START, profile left untouched: " + why);
            assertThat(set(a, "live")).containsEntry("details", REFUSED_DETAILS);
        }
    }

    @Test
    void nothingElseCountsAsARefusal() throws Exception {
        TestClient a = connect("cs-a");
        Map<String, String> replies = new LinkedHashMap<>();
        // Other codes, with the words in them.
        replies.put("err timeout start desk-browser: REFUSING TO START", "timeout");
        replies.put("err denied start desk-browser: REFUSING TO START", "denied");
        replies.put("err bad_request start desk-browser: REFUSING TO START", "bad_request");
        // The right code, without them or in the wrong place.
        replies.put("err failed start desk-browser: Job for desk-browser.service failed", "failed");
        replies.put("err failed REFUSING TO START", "failed");
        replies.put("err failed desk-browser-start: REFUSING TO START", "failed");
        replies.put("err failed stop desk-browser: desk-browser-start: REFUSING TO START", "failed");
        replies.put("err failed", "failed");
        for (Map.Entry<String, String> entry : replies.entrySet()) {
            units.reply(START_BROWSER, entry.getKey());
            assertThat(set(a, "live"))
                    .as(entry.getKey())
                    .containsEntry("code", "unavailable")
                    .containsEntry("details", Map.of("unit", "desk-browser", "code", entry.getValue()));
            assertRefusedState(false);
        }
        // Another unit, with all of it.
        units.replyOk(START_BROWSER);
        units.reply(START_STREAM, "err failed start desk-browser: REFUSING TO START");
        assertThat(set(a, "live")).containsEntry("details", Map.of("unit", "desk-stream", "code", "failed"));
        assertRefusedState(false);
    }

    /** warm never asks for desk-browser, so it can't be refused, and it doesn't settle anything. */
    @Test
    void warmStartsOnlyTheStreamWhileChromiumIsRefused() throws Exception {
        TestClient a = connect("cs-a");
        units.reply(START_BROWSER, REFUSED);
        assertThat(set(a, "live")).containsEntry("details", REFUSED_DETAILS);
        units.clearRequests();

        assertState(set(a, "warm"), "warm");

        assertThat(units.requests()).containsExactly(START_STREAM);
        assertRefusedState(true);
    }

    @Test
    void goingFromWarmToLiveCanBeRefusedAndLeavesTheSessionOffAndTheStreamStopped() throws Exception {
        TestClient a = connect("cs-a");
        assertState(set(a, "warm"), "warm");
        assertThat(nextVideo()).isEqualTo("cs-a false");
        units.reply(START_BROWSER, REFUSED);

        assertThat(set(a, "live")).containsEntry("details", REFUSED_DETAILS);

        await().until(() -> units.requests().contains(STOP_STREAM) && !units.isRunning("desk-stream"));
        assertThat(drainVideo(50)).doesNotContain("cs-a true");
        assertRefusedState(true);
    }

    @Test
    void onlyAStartThatWorksClearsTheRefusal() throws Exception {
        TestClient a = connect("cs-a");
        units.reply(START_BROWSER, REFUSED);
        assertThat(set(a, "live")).containsEntry("details", REFUSED_DETAILS);
        assertRefusedState(true);

        // It didn't answer: that says nothing about the profile.
        units.reply(START_BROWSER, "err timeout start desk-browser took over 34 s");
        assertThat(set(a, "live")).containsEntry("details", Map.of("unit", "desk-browser", "code", "timeout"));
        assertRefusedState(true);

        // It got past the check, and then something else went wrong, as a failed systemctl does.
        units.reply(START_BROWSER, "err failed start desk-browser: Job for desk-browser.service failed");
        assertThat(set(a, "live")).containsEntry("details", Map.of("unit", "desk-browser", "code", "failed"));
        assertRefusedState(true);

        // Another unit working says nothing about this one.
        assertState(set(a, "warm"), "warm");
        assertRefusedState(true);

        units.close();
        assertThat(set(a, "live")).containsEntry("details", Map.of("unit", "desk-browser", "code", "unreachable"));
        assertRefusedState(true);
        units = new StubUnitsSocket(dir.resolve("units.sock"));

        // Refused once more, and then it starts.
        units.reply(START_BROWSER, REFUSED);
        assertThat(set(a, "live")).containsEntry("details", REFUSED_DETAILS);
        units.replyOk(START_BROWSER);
        assertState(set(a, "live"), "live");
        assertRefusedState(false);
    }

    /** The state goes by what desk-units said about the desk, whether or not the one who asked is still waiting. */
    @Test
    void aRefusalIsRememberedThoughItsRequestWasOvertaken() throws Exception {
        TestClient a = connect("cs-a");
        units.reply(START_BROWSER, REFUSED);
        units.hold(START_BROWSER);
        send(a, "live");
        units.awaitHeld(START_BROWSER);
        send(a, "off");
        a.nextReply();
        a.nextReply();
        units.release(START_BROWSER);
        await().until(module::chromiumRefused);
        assertRefusedState(true);
    }

    // ---- the same with nothing but the stream, so a test can see each step and when it happens

    /** Answers as desk-units does, and records each request. */
    private static final class ScriptedUnits implements BrowserStream.Units {
        final List<String> requests = new CopyOnWriteArrayList<>();
        final Map<String, String> failures = new ConcurrentHashMap<>();
        final Map<String, CountDownLatch> gates = new ConcurrentHashMap<>();
        final List<Boolean> refusedDuringBrowserStart = new CopyOnWriteArrayList<>();
        volatile BrowserStream stream;

        @Override
        public void run(String verb, String unit) throws UnitException, InterruptedException {
            String request = verb + " " + unit;
            // Before requests: a test waits on that one, and then reads this.
            if (request.equals(START_BROWSER)) {
                refusedDuringBrowserStart.add(stream.chromiumRefused());
            }
            requests.add(request);
            CountDownLatch gate = gates.remove(request);
            if (gate != null) {
                gate.await();
            }
            String text = failures.get(request);
            if (text != null) {
                throw new UnitException(unit, "failed", text);
            }
        }

        long count(String request) {
            return requests.stream().filter(request::equals).count();
        }
    }

    private static final String REFUSED_WORDS = REFUSED.substring("err failed ".length());

    private final ScriptedUnits scripted = new ScriptedUnits();
    private final AtomicInteger hurries = new AtomicInteger();

    private RefusalMarker unusedMarker() {
        return new RefusalMarker(dir.resolve("unused-" + RefusalMarker.NAME));
    }

    /** Apart from the module's, which is the one beside units.sock. */
    private Path scriptedMarker() {
        return dir.resolve("scripted-" + RefusalMarker.NAME);
    }

    private BrowserStream scriptedStream() {
        return scriptedStream(Duration.ofMinutes(5));
    }

    private BrowserStream scriptedStream(Duration restartEvery) {
        return scriptedStream(restartEvery, scriptedMarker());
    }

    private BrowserStream scriptedStream(Duration restartEvery, Path marker) {
        BrowserStream stream = new BrowserStream(
                scripted, (id, view) -> {}, id -> true, () -> {}, hurries::incrementAndGet, transition -> {}, restartEvery, new RefusalMarker(marker));
        scripted.stream = stream;
        return stream;
    }

    /** One viewer, with Chromium up, as it is before it's lost. */
    private BrowserStream streamWithAViewer() {
        return streamWithAViewer(Duration.ofMinutes(5));
    }

    private BrowserStream streamWithAViewer(Duration restartEvery) {
        BrowserStream stream = scriptedStream(restartEvery);
        assertThat(stream.set("cs-1", BrowserStream.Level.LIVE, 1).join()).isEqualTo(BrowserStream.Level.LIVE);
        scripted.requests.clear();
        return stream;
    }

    /** Whatever the worker would still do, it has had time to. */
    private static void settleWorker() throws InterruptedException {
        Thread.sleep(150);
    }

    /** Trace question: nothing re-arms a start after a refusal, so the worker takes one step and goes away. */
    @Test
    void aViewerLosingChromiumTriesOnceAndARefusalEndsIt() throws Exception {
        BrowserStream stream = streamWithAViewer();
        scripted.failures.put(START_BROWSER, REFUSED_WORDS);

        stream.browserLost();
        await().until(stream::chromiumRefused);
        settleWorker();
        assertThat(scripted.requests).containsExactly(START_BROWSER);
        assertThat(stream.level()).isEqualTo(BrowserStream.Level.LIVE);
    }

    /**
     * Regression: a connection that opens and drops brings a loss each time, and each start kept the connector at its
     * smallest gap, so a process holding the port that way meant a Python process and a crit line about 4 times a second.
     */
    @Test
    void afterARefusalALostChromiumAsksNothingMoreWithinRestartEvery() throws Exception {
        BrowserStream stream = streamWithAViewer();
        scripted.failures.put(START_BROWSER, REFUSED_WORDS);
        stream.browserLost();
        await().until(stream::chromiumRefused);
        settleWorker();
        scripted.requests.clear();

        for (int i = 0; i < 5; i++) {
            stream.browserLost();
            settleWorker();
        }

        assertThat(scripted.requests).isEmpty();
    }

    /** Never asking again would keep a viewer from a Chromium that's there to be had, once the refusal has gone. */
    @Test
    void afterARefusalALostChromiumAsksForAStartAgainOncePerRestartEvery() throws Exception {
        // Long enough that a loaded machine can't make "too soon" late.
        Duration every = Duration.ofSeconds(2);
        BrowserStream stream = streamWithAViewer(every);
        scripted.failures.put(START_BROWSER, REFUSED_WORDS);
        stream.browserLost();
        await().until(stream::chromiumRefused);
        scripted.requests.clear();

        // Too soon after that start.
        stream.browserLost();
        settleWorker();
        assertThat(scripted.requests).isEmpty();

        Thread.sleep(every.toMillis());
        stream.browserLost();
        await().until(() -> scripted.count(START_BROWSER) == 1);

        // Refused again, and that start is the new last one.
        stream.browserLost();
        settleWorker();
        assertThat(scripted.count(START_BROWSER)).isEqualTo(1);

        // The refusal has gone by the next try, and the viewer has Chromium back.
        scripted.failures.remove(START_BROWSER);
        Thread.sleep(every.toMillis());
        stream.browserLost();
        await().until(() -> scripted.count(START_BROWSER) == 2 && !stream.chromiumRefused());
    }

    @Test
    void aLossAskedForWhileARefusedStartIsOnItsWayBringsNoOtherTry() throws Exception {
        BrowserStream stream = streamWithAViewer();
        scripted.failures.put(START_BROWSER, REFUSED_WORDS);
        CountDownLatch gate = new CountDownLatch(1);
        scripted.gates.put(START_BROWSER, gate);

        stream.browserLost();
        await().until(() -> scripted.count(START_BROWSER) == 1);
        stream.browserLost();
        gate.countDown();
        await().until(stream::chromiumRefused);
        settleWorker();

        assertThat(scripted.count(START_BROWSER)).isEqualTo(1);
    }

    /** A request still tries, as it's the only thing that can find out the image was fixed. */
    @Test
    void aRequestStillTriesAfterARefusalAndOnceItWorksALossBringsAStartAgain() throws Exception {
        BrowserStream stream = streamWithAViewer();
        scripted.failures.put(START_BROWSER, REFUSED_WORDS);
        stream.browserLost();
        await().until(stream::chromiumRefused);

        scripted.failures.remove(START_BROWSER);
        assertThat(stream.set("cs-1", BrowserStream.Level.LIVE, 2).join()).isEqualTo(BrowserStream.Level.LIVE);
        assertThat(stream.chromiumRefused()).isFalse();
        scripted.requests.clear();

        stream.browserLost();
        await().until(() -> scripted.count(START_BROWSER) == 1);
    }

    /** Second trace question: a browser that likely won't come doesn't get 30 s of polling again and again. */
    @Test
    void aStartAfterARefusalHurriesTheConnectorOnlyOnceItHasWorked() {
        BrowserStream stream = scriptedStream();
        scripted.failures.put(START_BROWSER, REFUSED_WORDS);

        // Nothing is known yet: the one before the start, and none after it.
        assertThatStreamSetFails(stream, 1);
        assertThat(hurries).hasValue(1);

        assertThatStreamSetFails(stream, 2);
        assertThatStreamSetFails(stream, 3);
        assertThat(hurries).hasValue(1);

        scripted.failures.remove(START_BROWSER);
        assertThat(stream.set("cs-1", BrowserStream.Level.LIVE, 4).join()).isEqualTo(BrowserStream.Level.LIVE);
        assertThat(hurries).hasValue(2);

        // That's over, so it's both again.
        assertThat(stream.set("cs-1", BrowserStream.Level.LIVE, 5).join()).isEqualTo(BrowserStream.Level.LIVE);
        assertThat(hurries).hasValue(4);
    }

    private static void assertThatStreamSetFails(BrowserStream stream, long arrival) {
        assertThatThrownBy(() -> stream.set("cs-1", BrowserStream.Level.LIVE, arrival).join())
                .hasCauseInstanceOf(UnitException.class);
    }

    /** The restart of a Chromium that's off its port has the one stop of desk-browser there is. */
    @Test
    void aStopOfTheBrowserThatSaysTheWordsDoesntSetTheRefusal() throws Exception {
        BrowserStream stream = scriptedStream();
        scripted.failures.put("stop desk-browser", REFUSED_WORDS);

        stream.browserDisplaced();

        await().until(() -> scripted.count(START_BROWSER) == 1);
        assertThat(scripted.refusedDuringBrowserStart).containsExactly(false);
    }

    /**
     * A restart asked for while a start was on its way, which then is refused: the one way a stop of desk-browser could
     * have run while a refusal stood. It would only take away a Chromium that works, for a start that would very likely
     * be refused, so the refusal drops it, as it does a loss asked for meanwhile.
     */
    @Test
    void aRestartAskedForWhileARefusedStartIsOnItsWayIsDropped() throws Exception {
        BrowserStream stream = scriptedStream();
        scripted.failures.put(START_BROWSER, REFUSED_WORDS);
        CountDownLatch gate = new CountDownLatch(1);
        scripted.gates.put(START_BROWSER, gate);
        CompletableFuture<BrowserStream.Level> live = stream.set("cs-1", BrowserStream.Level.LIVE, 1);
        await().until(() -> scripted.count(START_BROWSER) == 1);
        stream.browserDisplaced();
        gate.countDown();
        assertThatThrownBy(live::join).hasCauseInstanceOf(UnitException.class);
        settleWorker();

        assertThat(scripted.requests).containsExactly(START_BROWSER);
        assertThat(stream.chromiumRefused()).isTrue();
    }

    /** It would stop a Chromium that's working, for a start that would very likely be refused. */
    @Test
    void aKnownRefusalLeavesAChromiumOffItsPortAsItIs() throws Exception {
        BrowserStream stream = scriptedStream(Duration.ofMillis(1));
        scripted.failures.put(START_BROWSER, REFUSED_WORDS);
        assertThatStreamSetFails(stream, 1);
        scripted.requests.clear();

        for (int i = 0; i < 3; i++) {
            stream.browserDisplaced();
            settleWorker();
        }

        assertThat(scripted.requests).isEmpty();
    }

    /** Once a start works, a Chromium off its port is restarted again. */
    @Test
    void aStartThatWorksLetsAChromiumOffItsPortBeRestartedAgain() throws Exception {
        BrowserStream stream = scriptedStream(Duration.ofMillis(1));
        scripted.failures.put(START_BROWSER, REFUSED_WORDS);
        assertThatStreamSetFails(stream, 1);
        scripted.failures.remove(START_BROWSER);
        assertThat(stream.set("cs-1", BrowserStream.Level.LIVE, 2).join()).isEqualTo(BrowserStream.Level.LIVE);
        scripted.requests.clear();

        stream.browserDisplaced();

        await().until(() -> scripted.count(START_BROWSER) == 1);
        assertThat(scripted.requests).containsExactly("stop desk-browser", START_BROWSER);
    }

    /**
     * A hold that comes while a restart of a Chromium off its port is stopping it: the restart would have left Chromium
     * running, so the release puts it back, with nobody viewing and nothing on the port by the time the hold's stop goes.
     */
    @Test
    void aHoldDuringARestartStillGetsChromiumBackOnTheRelease() throws Exception {
        BrowserStream stream = scriptedStream();
        CountDownLatch restartStop = new CountDownLatch(1);
        scripted.gates.put("stop desk-browser", restartStop);
        stream.browserDisplaced();
        await().until(() -> scripted.count("stop desk-browser") == 1);

        CompletableFuture<Void> held = stream.hold();
        restartStop.countDown();
        assertThat(held).succeedsWithin(Duration.ofSeconds(5));
        settleWorker();
        assertThat(scripted.requests).containsExactly("stop desk-browser", "stop desk-browser");

        stream.release();

        await().atMost(Duration.ofSeconds(5)).until(() -> scripted.count(START_BROWSER) == 1);
        settleWorker();
        assertThat(scripted.requests).containsExactly("stop desk-browser", "stop desk-browser", START_BROWSER);
    }

    // ---- the refusal across a restart of deskd (RefusalMarker)

    @Test
    void aRefusalLeavesAnEmptyFileBesideUnitsSockAndAStartThatWorksRemovesIt() throws Exception {
        Path marker = dir.resolve("chromium-refused");
        TestClient a = connect("cs-a");
        units.reply(START_BROWSER, REFUSED);
        assertThat(set(a, "live")).containsEntry("details", REFUSED_DETAILS);
        await().until(() -> Files.exists(marker, LinkOption.NOFOLLOW_LINKS));
        assertThat(Files.isRegularFile(marker, LinkOption.NOFOLLOW_LINKS)).isTrue();
        assertThat(Files.size(marker)).isZero();

        // Anything else leaves it.
        units.reply(START_BROWSER, "err timeout start desk-browser took over 34 s");
        assertThat(set(a, "live")).containsEntry("details", Map.of("unit", "desk-browser", "code", "timeout"));
        Thread.sleep(50);
        assertThat(marker).exists();

        units.replyOk(START_BROWSER);
        assertState(set(a, "live"), "live");
        await().until(() -> !Files.exists(marker, LinkOption.NOFOLLOW_LINKS));
    }

    /** What the heartbeat and /health then say from the start, so Platform doesn't read a restart as a fix. */
    @Test
    void aNewDeskdStartsRefusedIfTheFileIsThere() throws Exception {
        Path again = Files.createDirectory(dir.resolve("again"));
        Files.createFile(again.resolve(BrowserModule.REFUSAL_MARKER));
        try (BrowserRig rig = new BrowserRig(again, 9, BrowserRig.FAST)) {
            assertThat(rig.module.chromiumRefused()).isTrue();
            @SuppressWarnings("unchecked")
            Map<String, Object> health = (Map<String, Object>) rig.module.health().get("browser");
            assertThat(health).containsEntry("chromium", "older_than_profile");
        }
    }

    @Test
    void withNoFileANewDeskdStartsWithNothingRefused() throws Exception {
        assertThat(scriptedStream().chromiumRefused()).isFalse();
    }

    /** Read once, at the start: a file that comes later is the next deskd's business. */
    @Test
    void theFileIsReadOnlyAtTheStart() throws Exception {
        BrowserStream stream = scriptedStream();
        Files.createFile(scriptedMarker());
        assertThat(stream.chromiumRefused()).isFalse();
    }

    /** A start that works removes the file a refusal before this deskd left. */
    @Test
    void aRefusalFromBeforeIsClearedByAStartThatWorks() throws Exception {
        Files.createFile(scriptedMarker());
        BrowserStream stream = scriptedStream();
        assertThat(stream.chromiumRefused()).isTrue();

        assertThat(stream.set("cs-1", BrowserStream.Level.LIVE, 1).join()).isEqualTo(BrowserStream.Level.LIVE);

        assertThat(stream.chromiumRefused()).isFalse();
        await().until(() -> !Files.exists(scriptedMarker(), LinkOption.NOFOLLOW_LINKS));
    }

    /** rtc owns /run/desk, so anything can be at the name. Presence is all it says, a link to nothing included. */
    @Test
    void aLinkAtTheNameCountsAsThereAndIsntFollowedToLookForIt() throws Exception {
        Files.createSymbolicLink(scriptedMarker(), dir.resolve("nothing"));
        assertThat(scriptedStream().chromiumRefused()).isTrue();
    }

    @Test
    void writingDoesntFollowALinkAtTheName() throws Exception {
        BrowserStream stream = scriptedStream();
        Path target = dir.resolve("target");
        Files.createSymbolicLink(scriptedMarker(), target);
        scripted.failures.put(START_BROWSER, REFUSED_WORDS);

        assertThatStreamSetFails(stream, 1);

        assertThat(stream.chromiumRefused()).isTrue();
        settleWorker();
        assertThat(target).doesNotExist();
    }

    @Test
    void removingTakesALinkAtTheNameAndNotWhatItNames() throws Exception {
        Path target = Files.writeString(dir.resolve("target"), "theirs");
        Files.createSymbolicLink(scriptedMarker(), target);
        BrowserStream stream = scriptedStream();

        assertThat(stream.set("cs-1", BrowserStream.Level.LIVE, 1).join()).isEqualTo(BrowserStream.Level.LIVE);

        await().until(() -> !Files.exists(scriptedMarker(), LinkOption.NOFOLLOW_LINKS));
        assertThat(Files.readString(target)).isEqualTo("theirs");
    }

    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void aFileThatCantBeWrittenIsOneLineAndTheRefusalStillStands(CapturedOutput output) throws Exception {
        BrowserStream stream = scriptedStream(Duration.ofMinutes(5), dir.resolve("no-such-directory").resolve(RefusalMarker.NAME));
        scripted.failures.put(START_BROWSER, REFUSED_WORDS);

        assertThatStreamSetFails(stream, 1);

        assertThat(stream.chromiumRefused()).isTrue();
        await().until(() -> output.getOut().contains("couldn't write chromium-refused"));
        assertThat(output.getOut().lines().filter(line -> line.contains("couldn't write chromium-refused"))).hasSize(1);
        // Removing what isn't there is no failure.
        scripted.failures.remove(START_BROWSER);
        assertThat(stream.set("cs-1", BrowserStream.Level.LIVE, 2).join()).isEqualTo(BrowserStream.Level.LIVE);
        Thread.sleep(50);
        assertThat(output.getOut()).doesNotContain("couldn't remove");
    }

    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void aFileThatCantBeRemovedIsOneLineAndTheStartStillClearsTheRefusal(CapturedOutput output) throws Exception {
        Files.createDirectories(scriptedMarker().resolve("theirs"));
        BrowserStream stream = scriptedStream();
        assertThat(stream.chromiumRefused()).isTrue();

        assertThat(stream.set("cs-1", BrowserStream.Level.LIVE, 1).join()).isEqualTo(BrowserStream.Level.LIVE);

        assertThat(stream.chromiumRefused()).isFalse();
        String line = "couldn't remove chromium-refused, so a restart of deskd would still take Chromium as refused";
        await().until(() -> output.getOut().contains(line));
        assertThat(output.getOut().lines().filter(l -> l.contains(line))).hasSize(1);
        assertThat(output.getOut()).doesNotContain(dir.toString());
    }

    // ---- what the worker costs, and what can't block

    @Test
    void aHungUnitBlocksNeitherPingNorAnotherRpcNorAnotherSession() throws Exception {
        TestClient a = connect("cs-a");
        TestClient b = connect("cs-b");
        units.hold(START_BROWSER);
        send(a, "live");
        units.awaitHeld(START_BROWSER);

        a.sendJson(Channels.CTL, FrameKind.PING, 7, Map.of());
        assertThat(a.nextJson(Channels.CTL, FrameKind.PONG)).isNotNull();
        assertThat(b.call("no.such.method", Map.of())).containsEntry("code", "not_found");
        a.sendJson(Channels.RPC, FrameKind.REQ, 1, Map.of("m", "no.such.method"));
        assertThat(a.nextReply()).containsEntry("code", "not_found");
        b.sendJson(Channels.CTL, FrameKind.CLOSE, 0, Map.of("code", 1000));
        await().until(() -> !sessions.isLive("cs-b"));
        units.release(START_BROWSER);
    }

    @Test
    void aClientThatStopsWaitingDoesntStopTheWork() throws Exception {
        TestClient a = connect("cs-a");
        units.hold(START_STREAM);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("m", "browser.stream.set");
        body.put("p", Map.of("state", "live"));
        body.put("deadlineMs", 50);
        a.sendJson(Channels.RPC, FrameKind.REQ, 1, body);
        assertThat(a.nextReply()).containsEntry("code", "deadline_exceeded");
        units.awaitHeld(START_STREAM);
        units.release(START_STREAM);
        assertThat(nextVideo()).isEqualTo("cs-a true");
        assertThat(units.isRunning("desk-stream")).isTrue();
    }

    @Test
    void deskRtcSayingTheStreamIsUpAtBootWithNobodyWatchingStopsIt() throws Exception {
        fake.sendJson(Map.of("t", "stream.state", "state", "warm"));
        await().until(() -> units.requests().contains(STOP_STREAM));
        units.clearRequests();
        // Only the first message of a process means an orphan.
        fake.sendJson(Map.of("t", "stream.state", "state", "live"));
        fake.sendJson(Map.of("t", "stream.state", "state", "warm"));
        await().until(() -> "warm".equals(rtc.streamState()));
        Thread.sleep(50);
        assertThat(units.requests()).isEmpty();
    }

    /** Regression: a stream still connecting when deskd came back said down first, and was never stopped. */
    @Test
    void aStreamLeftOverThatConnectsLateIsStoppedToo() throws Exception {
        fake.sendJson(Map.of("t", "stream.state", "state", "down"));
        await().until(() -> "down".equals(rtc.streamState()));
        Thread.sleep(50);
        assertThat(units.requests()).isEmpty();
        fake.sendJson(Map.of("t", "stream.state", "state", "warm"));
        await().until(() -> units.requests().contains(STOP_STREAM));
    }

    @Test
    void theStreamDeskdItselfStartedIsntTakenForALeftover() throws Exception {
        fake.sendJson(Map.of("t", "stream.state", "state", "down"));
        await().until(() -> "down".equals(rtc.streamState()));
        TestClient a = connect("cs-a");
        assertState(set(a, "warm"), "warm");
        // The stream connects, as it does after a start, and the session has already lost interest.
        assertState(set(a, "off"), "off");
        assertThat(units.requests()).containsExactly(START_STREAM, STOP_STREAM);
        fake.sendJson(Map.of("t", "stream.state", "state", "warm"));
        await().until(() -> "warm".equals(rtc.streamState()));
        Thread.sleep(50);
        assertThat(units.requests()).containsExactly(START_STREAM, STOP_STREAM);
    }

    @Test
    void aStreamThatConnectsWhileASessionWantsItIsLeftRunning() throws Exception {
        TestClient a = connect("cs-a");
        units.hold(START_STREAM);
        long id = send(a, "warm");
        units.awaitHeld(START_STREAM);
        fake.sendJson(Map.of("t", "stream.state", "state", "warm"));
        await().until(() -> "warm".equals(rtc.streamState()));
        units.release(START_STREAM);
        assertState(reply(a, id), "warm");
        Thread.sleep(50);
        assertThat(units.requests()).containsExactly(START_STREAM);
    }

    @Test
    void aFreshBootSaysDownAndAsksNothingOfTheUnits() throws Exception {
        fake.sendJson(Map.of("t", "stream.state", "state", "down"));
        await().until(() -> "down".equals(rtc.streamState()));
        Thread.sleep(50);
        assertThat(units.requests()).isEmpty();
    }

    // ---- what a transition cost

    private static List<String> timingLines(CapturedOutput output, String kind) {
        return output.getOut().lines().filter(line -> line.contains("browser.stream.set timing " + kind)).toList();
    }

    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void aTransitionLogsTimeInEachUnitAndARepeatLogsNothing(CapturedOutput output) throws Exception {
        TestClient client = connect("a");
        assertState(set(client, "warm"), "warm");
        await().until(() -> timingLines(output, "from=off to=warm").size() == 1);
        assertThat(timingLines(output, "from=off to=warm").get(0)).containsPattern(
                "result=ok browserStartMs=- streamStartMs=\\d+ stopMs=- unitsMs=\\d+ cdpMs=- totalMs=\\d+$");

        assertState(set(client, "warm"), "warm");
        Thread.sleep(50);
        assertThat(timingLines(output, "from=warm to=warm")).isEmpty();
        assertThat(timingLines(output, "from=off to=warm")).hasSize(1);

        assertState(set(client, "off"), "off");
        await().until(() -> timingLines(output, "from=warm to=off").size() == 1);
        assertThat(timingLines(output, "from=warm to=off").get(0)).containsPattern("result=ok browserStartMs=- streamStartMs=- stopMs=\\d+ ");
    }

    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void aFailedStartIsNamedInItsLine(CapturedOutput output) throws Exception {
        TestClient client = connect("a");
        units.reply(START_BROWSER, "err failed it would not start");
        assertThat(set(client, "live")).containsEntry("_kind", "ERR");
        await().until(() -> timingLines(output, "from=off to=live result=failed").size() == 1);
        assertThat(timingLines(output, "from=off to=live result=failed").get(0)).containsPattern(
                "browserStartMs=\\d+ streamStartMs=- stopMs=- unitsMs=\\d+ cdpMs=- totalMs=\\d+$");
    }

    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void aRequestOvertakenWhileItWaitedSaysSo(CapturedOutput output) throws Exception {
        TestClient client = connect("a");
        units.hold(START_BROWSER);
        send(client, "live");
        units.awaitHeld(START_BROWSER);
        send(client, "off");
        client.nextReply();
        client.nextReply();
        units.release(START_BROWSER);
        await().until(() -> timingLines(output, "from=off to=live result=overtaken").size() == 1);
    }
}
