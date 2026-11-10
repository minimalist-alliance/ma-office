package com.minimalistalliance.desk.deskd.notebook;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.session.SessionGrant;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import com.minimalistalliance.desk.deskd.status.DeskFacts;
import com.minimalistalliance.desk.deskd.testing.FakeDeskRtc;
import com.minimalistalliance.desk.deskd.testing.StubAuthorizer;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.testing.TestTiming;
import java.io.ByteArrayOutputStream;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The relay as DataPlaneConfiguration wires it, driven through a client's frames, with a fake desk-rtc on a real Unix
 * socket. desk-notebook is whatever a test starts at {@link #notebookSocket}: this doesn't know or care.
 */
final class NotebookRig implements AutoCloseable {

    /** Short gaps. The stalls are long enough that a shared machine at load 8 doesn't look like one. */
    static final NotebookModule.Timing FAST = new NotebookModule.Timing(
            Duration.ofMillis(20), Duration.ofMillis(100), Duration.ofSeconds(5), Duration.ofSeconds(2), Duration.ofSeconds(2));

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

    /** One DATA from deskd: whether it had BIN, and its bytes whole. */
    record Data(boolean binary, byte[] bytes) {
        boolean isReset() {
            return !binary && new String(bytes, java.nio.charset.StandardCharsets.UTF_8).equals("{\"t\":\"reset\"}");
        }
    }

    final Path notebookSocket;
    final FakeDeskRtc rtcFake;
    final RtcClient rtc;
    final RpcDispatcher dispatcher = new RpcDispatcher();
    final EventHub hub = new EventHub(new TopicRegistry());
    final SessionManager sessions;
    final NotebookModule module;
    /** Channel 4 to Commons, on a guild desk; whether this is one is {@link #guildDesk}. */
    final CommonsRelay commons;
    volatile boolean guildDesk = true;
    final StubAuthorizer authorizer = new StubAuthorizer();
    private final AtomicLong nextId = new AtomicLong(10_000);
    private long nextHandle = 1;

    NotebookRig(Path dir, Path notebookSocket) throws Exception {
        this(dir, notebookSocket, FAST);
    }

    NotebookRig(Path dir, Path notebookSocket, NotebookModule.Timing timing) throws Exception {
        this.notebookSocket = notebookSocket;
        Path rtcSocket = dir.resolve("rtc.sock");
        rtcFake = new FakeDeskRtc(rtcSocket);
        rtc = new RtcClient(new RtcClient.Config(rtcSocket, SessionManager.MAX_SESSIONS, FACTS::publicIpv4));
        sessions = new SessionManager(rtc, authorizer, dispatcher, hub, FACTS, "1", Instant.now());
        module = new NotebookModule(notebookSocket, sessions, dispatcher, hub, timing);
        commons = new CommonsRelay(dir.resolve("commons.sock"), sessions, hub, () -> guildDesk, timing);
        rtc.start(sessions);
        await().until(rtc::isConfigured);
    }

    TestClient connect(String sessionId) throws Exception {
        return connect(sessionId, "owner");
    }

    TestClient connect(String sessionId, String scope) throws Exception {
        String fingerprint = String.format("%02x", nextHandle + 16).repeat(32);
        SessionGrant grant = new SessionGrant(
                "user-1", "sid-" + sessionId, scope, fingerprint, true, true, Instant.now(), Instant.now().plus(Duration.ofHours(1)));
        authorizer.allow("token-" + sessionId, grant);
        sessions.open(sessionId, "token-" + sessionId);
        sessions.offer(sessionId, TestClient.offerFor(fingerprint));
        TestClient client = new TestClient(rtcFake, nextHandle++);
        client.hello();
        return client;
    }


    /** A session past HELLO with this grant, such as a guild member's. */
    TestClient connect(String sessionId, SessionGrant grant) throws Exception {
        authorizer.allow("token-" + sessionId, grant);
        sessions.open(sessionId, "token-" + sessionId);
        sessions.offer(sessionId, TestClient.offerFor(grant.expectedFingerprint()));
        TestClient client = new TestClient(rtcFake, nextHandle++);
        client.hello();
        return client;
    }

    /** A guild member's grant, for the tab this rig would give the next session. */
    SessionGrant member(String memberId, String role, java.util.List<String> grants, boolean teen) {
        return member(memberId, role, grants, teen, String.format("%02x", nextHandle + 16).repeat(32));
    }

    /** The same, for a tab already in use: a refresh's. */
    SessionGrant member(String memberId, String role, java.util.List<String> grants, boolean teen, String fingerprint) {
        com.minimalistalliance.desk.deskd.rpc.Caller caller = new com.minimalistalliance.desk.deskd.rpc.Caller(
                "guild_member", memberId, role, com.minimalistalliance.desk.deskd.rpc.Caller.effectiveGrants(role, grants),
                "Name", null, teen);
        return new SessionGrant(memberId, "sid-" + memberId, "guild_member", fingerprint, false, false, Instant.now(),
                Instant.now().plus(Duration.ofHours(1)), caller, "gu-testguild01");
    }

    /** Refreshes a session with this grant, as session.refresh with a new token would. */
    void refresh(String sessionId, SessionGrant grant) throws Exception {
        authorizer.allow("refresh-" + sessionId, grant);
        sessions.refresh(sessionId, "refresh-" + sessionId);
    }

    Map<String, Object> call(TestClient client, String method, Map<String, Object> params) throws Exception {
        return call(client, method, params, NotebookMethods.MUTATIONS.contains(method) ? UUID.randomUUID().toString() : null);
    }

    Map<String, Object> call(TestClient client, String method, Map<String, Object> params, String idem) throws Exception {
        long id = send(client, method, params, idem);
        Map<String, Object> reply = client.nextReply();
        assertThat(reply).containsEntry("_id", id);
        return reply;
    }

    long send(TestClient client, String method, Map<String, Object> params, String idem) {
        return send(client, method, params, idem, null);
    }

    long send(TestClient client, String method, Map<String, Object> params, String idem, Long deadlineMs) {
        long id = nextId.getAndIncrement();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("m", method);
        body.put("p", params);
        if (idem != null) {
            body.put("idem", idem);
        }
        if (deadlineMs != null) {
            body.put("deadlineMs", deadlineMs);
        }
        client.sendJson(Channels.RPC, FrameKind.REQ, id, body);
        return id;
    }

    /** One message of the room link, with BIN, on channel 4. */
    void sendCommons(TestClient client, byte[] message) {
        for (byte[] frame : Frame.fragment(FrameKind.DATA, Frame.BIN, 9, 0, message)) {
            rtcFake.sendData(client.handle(), Channels.MDOC, frame);
        }
    }

    /** One message of the client's virtual socket, with BIN. */
    void sendCollab(TestClient client, byte[] message) {
        for (byte[] frame : Frame.fragment(FrameKind.DATA, Frame.BIN, 7, 0, message)) {
            rtcFake.sendData(client.handle(), Channels.COLLAB, frame);
        }
    }

    /** The next DATA from deskd, joined. */
    Data nextData(TestClient client) throws InterruptedException {
        ByteArrayOutputStream joined = new ByteArrayOutputStream();
        while (true) {
            Frame frame = client.next(Channels.COLLAB);
            assertThat(frame.kind()).isEqualTo(FrameKind.DATA);
            joined.writeBytes(frame.payload());
            if (!frame.more()) {
                return new Data((frame.flags() & Frame.BIN) != 0, joined.toByteArray());
            }
        }
    }

    /** The next event on the topic, parsed. */
    Map<String, Object> nextEvent(TestClient client) throws Exception {
        return client.nextJson(Channels.EVENTS, FrameKind.EVT);
    }

    /**
     * Events until this {@code rev}. One heard while a SUB's snapshot is being made follows it, so a client can see the same
     * {@code rev} twice, which is harmless (API.md section 13).
     */
    void awaitRev(TestClient client, int rev) throws Exception {
        while (true) {
            Map<String, Object> event = nextEvent(client);
            assertThat(event).containsEntry("type", "snapshot");
            if (Map.of("rev", rev).equals(event.get("data"))) {
                return;
            }
        }
    }

    @Override
    public void close() throws Exception {
        module.close();
        commons.close();
        rtc.close();
        rtcFake.close();
    }
}
