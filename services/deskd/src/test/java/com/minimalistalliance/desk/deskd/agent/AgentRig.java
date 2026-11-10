package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.session.SessionGrant;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import com.minimalistalliance.desk.deskd.status.DeskFacts;
import com.minimalistalliance.desk.deskd.testing.FakeAgentSocket;
import com.minimalistalliance.desk.deskd.testing.FakeDeskRtc;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import com.minimalistalliance.desk.deskd.testing.StubAuthorizer;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.testing.TestTiming;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The relay as DataPlaneConfiguration wires it, driven through a client's frames: a fake desk-rtc and a fake
 * desk-agent, each on a real Unix socket.
 */
final class AgentRig implements AutoCloseable {

    static final AgentLink.Timing FAST = new AgentLink.Timing(Duration.ofMillis(20), Duration.ofMillis(100));
    static final AgentMethods.Waits WAITS = new AgentMethods.Waits(Duration.ofSeconds(3), Duration.ofSeconds(5));

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

    final Path agentSocket;
    final FakeDeskRtc rtcFake;
    final FakeAgentSocket agent;
    final RtcClient rtc;
    final RpcDispatcher dispatcher = new RpcDispatcher();
    final EventHub hub = new EventHub(new TopicRegistry());
    final SessionManager sessions;
    final MutableClock clock = new MutableClock(Instant.parse("2026-11-06T10:00:00Z"));
    final AgentModule module;
    /** What the relay takes the owner's band to be: an adult's, unless a test says otherwise. */
    volatile AgeBand.Band band = AgeBand.Band.ADULT;
    private final StubAuthorizer authorizer = new StubAuthorizer();
    private final AtomicLong nextId = new AtomicLong(10_000);
    private long nextHandle = 1;

    AgentRig(Path dir) throws Exception {
        this(dir, true);
    }

    /** @param listen whether desk-agent is there from the start */
    AgentRig(Path dir, boolean listen) throws Exception {
        this(dir, listen, FAST, WAITS);
    }

    AgentRig(Path dir, boolean listen, AgentLink.Timing timing, AgentMethods.Waits waits) throws Exception {
        Path rtcSocket = dir.resolve("rtc.sock");
        agentSocket = dir.resolve("agent.sock");
        rtcFake = new FakeDeskRtc(rtcSocket);
        agent = listen ? new FakeAgentSocket(agentSocket) : null;
        rtc = new RtcClient(new RtcClient.Config(rtcSocket, SessionManager.MAX_SESSIONS, FACTS::publicIpv4));
        sessions = new SessionManager(rtc, authorizer, dispatcher, hub, FACTS, "1", Instant.now());
        module = new AgentModule(agentSocket, dispatcher, hub, FACTS::deskId, clock, timing, waits, () -> band);
        rtc.start(sessions);
        await().until(rtc::isConfigured);
        module.start();
        if (agent != null) {
            await().until(() -> module.link().isConnected());
        }
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
        return call(client, method, params, AgentMethods.MUTATIONS.contains(method) ? UUID.randomUUID().toString() : null);
    }

    Map<String, Object> call(TestClient client, String method, Map<String, Object> params, String idem) throws Exception {
        long id = send(client, method, params, idem);
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

    @Override
    public void close() throws Exception {
        module.close();
        rtc.close();
        rtcFake.close();
        if (agent != null) {
            agent.close();
        }
    }
}
