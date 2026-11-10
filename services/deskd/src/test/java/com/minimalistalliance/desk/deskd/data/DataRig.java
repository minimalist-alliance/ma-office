package com.minimalistalliance.desk.deskd.data;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.browser.BrowserModule;
import com.minimalistalliance.desk.deskd.browser.UnitsClient;
import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.platform.StreamingPause;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.session.SessionGrant;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import com.minimalistalliance.desk.deskd.status.DeskFacts;
import com.minimalistalliance.desk.deskd.status.StatusMethods;
import com.minimalistalliance.desk.deskd.testing.FakeDataHelper;
import com.minimalistalliance.desk.deskd.testing.FakeDeskRtc;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import com.minimalistalliance.desk.deskd.testing.StubAuthorizer;
import com.minimalistalliance.desk.deskd.testing.StubUnitsSocket;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.testing.TestTiming;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The data module as DataPlaneConfiguration wires it, with the Browser module beside it, driven through a client's
 * frames: a fake desk-rtc, a stub units.sock and a fake desk-data on real Unix sockets, and Chromium's debugging port
 * on a port the test picks.
 */
final class DataRig implements AutoCloseable {

    static final DataModule.Timing FAST = new DataModule.Timing(
            Duration.ofSeconds(5), Duration.ofMinutes(30), Duration.ofSeconds(5), Duration.ofSeconds(30), Duration.ofMillis(100));

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

    static {
        TestTiming.pollFast();
    }

    final Path dir;
    final FakeDeskRtc fake;
    final StubUnitsSocket units;
    final FakeDataHelper helper;
    final RtcClient rtc;
    final RpcDispatcher dispatcher = new RpcDispatcher();
    final EventHub hub = new EventHub(new TopicRegistry());
    final SessionManager sessions;
    final PlatformHttp http = new PlatformHttp();
    final BrowserModule browser;
    final DataModule data;
    /** The free budget's clock and the bandwidth pause's. Only a test moves it. */
    final MutableClock clock = new MutableClock(Instant.parse("2026-11-07T12:00:00Z"));
    /** What the Platform has said. {@link StreamingPause#apply} is how a test says it. */
    final StreamingPause pause = new StreamingPause(clock);
    private final StubAuthorizer authorizer = new StubAuthorizer();
    private final AtomicLong nextId = new AtomicLong(10_000);
    private long nextHandle = 1;

    /**
     * @param cdpPort where Chromium would be: 9, where nothing listens, for a Chromium that's down
     * @param withHelper false for a desk without desk-data
     */
    DataRig(Path dir, int cdpPort, boolean withHelper, DataModule.Timing timing) throws Exception {
        this(dir, cdpPort, withHelper, timing, FreeBudget.DEFAULT_VOLUME_BYTES, Duration.ofHours(1));
    }

    /**
     * @param volumeBytes the data volume's size, so the free budget is 3 times this
     * @param budgetEvery the least time between two writes of the budget's file
     */
    DataRig(Path dir, int cdpPort, boolean withHelper, DataModule.Timing timing, long volumeBytes, Duration budgetEvery) throws Exception {
        this.dir = dir;
        Path socket = dir.resolve("rtc.sock");
        fake = new FakeDeskRtc(socket);
        units = new StubUnitsSocket(dir.resolve("units.sock"));
        helper = withHelper ? new FakeDataHelper(dir.resolve("data.sock")) : null;
        rtc = new RtcClient(new RtcClient.Config(socket, SessionManager.MAX_SESSIONS, FACTS::publicIpv4));
        new StatusMethods(FACTS, rtc, "test", System.nanoTime()).register(dispatcher);
        sessions = new SessionManager(rtc, authorizer, dispatcher, hub, FACTS, "1", Instant.now());
        browser = new BrowserModule(
                rtc,
                sessions,
                dispatcher,
                hub,
                http,
                new UnitsClient(dir.resolve("units.sock"))::run,
                dir.resolve(BrowserModule.REFUSAL_MARKER),
                cdpPort,
                ownUid());
        units.forgetStartupThaw();
        data = new DataModule(
                sessions, dispatcher, browser, dir.resolve("data.sock"), dir.resolve(DataModule.FREE_BYTES_FILE), FACTS::bootId,
                new FreeBudget(dir.resolve(FreeBudget.NAME), () -> volumeBytes, clock, budgetEvery),
                dir.resolve(BrowserHold.KEPT_FILE),
                timing);
        data.followStreamingPause(pause);
        rtc.start(sessions);
        await().until(rtc::isConfigured);
    }

    DataRig(Path dir) throws Exception {
        this(dir, 9, true, FAST);
    }

    static int ownUid() {
        try {
            return (Integer) Files.getAttribute(Path.of("/proc/self"), "unix:uid");
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    /** A session past HELLO. An owner's token allows video and input, and an export one neither, as deskd's verifier. */
    TestClient connect(String sessionId, String scope) throws Exception {
        boolean owner = RpcPrincipal.OWNER.equals(scope);
        String fingerprint = String.format("%02x", nextHandle + 16).repeat(32);
        SessionGrant grant = new SessionGrant(
                "user-1", "sid-" + sessionId, scope, fingerprint, owner, owner, Instant.now(), Instant.now().plus(Duration.ofHours(1)));
        authorizer.allow("token-" + sessionId, grant);
        sessions.open(sessionId, "token-" + sessionId);
        sessions.offer(sessionId, TestClient.offerFor(fingerprint));
        TestClient client = new TestClient(fake, nextHandle++);
        client.hello();
        return client;
    }

    /** A guild member's session past HELLO: no video, no input, and the member's caller. */
    TestClient member(String sessionId, String memberId, String role, java.util.List<String> grants) throws Exception {
        String fingerprint = String.format("%02x", nextHandle + 16).repeat(32);
        com.minimalistalliance.desk.deskd.rpc.Caller caller = new com.minimalistalliance.desk.deskd.rpc.Caller(
                "guild_member", memberId, role, com.minimalistalliance.desk.deskd.rpc.Caller.effectiveGrants(role, grants),
                "Name", null, false);
        SessionGrant grant = new SessionGrant(memberId, "sid-" + memberId, "guild_member", fingerprint, false, false,
                Instant.now(), Instant.now().plus(Duration.ofHours(1)), caller, "gu-testguild01");
        authorizer.allow("token-" + sessionId, grant);
        sessions.open(sessionId, "token-" + sessionId);
        sessions.offer(sessionId, TestClient.offerFor(fingerprint));
        TestClient client = new TestClient(fake, nextHandle++);
        client.hello();
        return client;
    }

    TestClient owner(String sessionId) throws Exception {
        return connect(sessionId, RpcPrincipal.OWNER);
    }

    TestClient export(String sessionId) throws Exception {
        return connect(sessionId, RpcPrincipal.EXPORT);
    }

    /** A request, with a fresh idem so a mutation can go too. Replies in between would be a test's own doing. */
    Map<String, Object> call(TestClient client, String method, Map<String, Object> params) throws Exception {
        long id = send(client, method, params, UUID.randomUUID().toString());
        Map<String, Object> reply = client.nextReply();
        assertThat(reply).containsEntry("_id", id);
        return reply;
    }

    long send(TestClient client, String method, Map<String, Object> params, String idem) {
        long id = nextId.getAndIncrement();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("m", method);
        body.put("p", params);
        if (idem != null) {
            body.put("idem", idem);
        }
        client.sendJson(Channels.RPC, FrameKind.REQ, id, body);
        return id;
    }

    /** A SUB, and its reply. */
    Map<String, Object> subscribe(TestClient client, String topic) throws Exception {
        long id = nextId.getAndIncrement();
        client.sendJson(Channels.RPC, FrameKind.SUB, id, Map.of("topic", topic, "params", Map.of()));
        Map<String, Object> reply = client.nextReply();
        assertThat(reply).containsEntry("_id", id);
        return reply;
    }

    void credit(TestClient client, long transferId, long bytes) {
        client.sendJson(Channels.BULK, FrameKind.CREDIT, transferId, Map.of("bytes", bytes));
    }

    /** What a reader has once a transfer's END has come: its bytes, and the END frame's payload. */
    record Received(byte[] bytes, byte[] end, int frames, long frameBytes) {}

    /**
     * Reads CHUNK frames of this transfer in order until its END, granting more credit each time this much has come.
     *
     * @param grantEvery 0 to grant none
     */
    static Received receive(TestClient client, long transferId, long grantEvery, DataRig rig) throws Exception {
        return receive(client, transferId, grantEvery, rig, 0);
    }

    /** {@link #receive}, from a frame past the first. */
    static Received receive(TestClient client, long transferId, long grantEvery, DataRig rig, long firstSeq) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        long sinceGrant = 0;
        long expectSeq = firstSeq;
        int frames = 0;
        long frameBytes = 0;
        while (true) {
            Frame frame = client.next(Channels.BULK);
            assertThat(frame.kind()).isEqualTo(FrameKind.CHUNK);
            assertThat(frame.id()).isEqualTo(transferId);
            assertThat(frame.seq()).isEqualTo(expectSeq++);
            assertThat(frame.flags() & Frame.BIN).isEqualTo(Frame.BIN);
            assertThat(frame.more()).isFalse();
            frames++;
            frameBytes += Frame.HEADER_BYTES + frame.payload().length;
            if ((frame.flags() & Frame.END) != 0) {
                return new Received(bytes.toByteArray(), frame.payload(), frames, frameBytes);
            }
            bytes.write(frame.payload());
            sinceGrant += frame.payload().length;
            if (grantEvery > 0 && sinceGrant >= grantEvery) {
                rig.credit(client, transferId, sinceGrant);
                sinceGrant = 0;
            }
        }
    }

    /** A JSON array from a reply, for AssertJ. */
    @SuppressWarnings("unchecked")
    static List<Object> list(Object value) {
        return (List<Object>) value;
    }

    /** A JSON object from a reply, for AssertJ. */
    @SuppressWarnings("unchecked")
    static Map<String, Object> map(Object value) {
        return (Map<String, Object>) value;
    }

    @Override
    public void close() throws Exception {
        data.close();
        browser.close();
        http.close();
        rtc.close();
        fake.close();
        units.close();
        if (helper != null) {
            helper.close();
        }
    }
}
