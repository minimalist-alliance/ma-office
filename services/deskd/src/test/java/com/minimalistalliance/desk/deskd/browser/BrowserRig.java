package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
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
import com.minimalistalliance.desk.deskd.testing.TestTiming;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;

/**
 * The whole Browser module as DataPlaneConfiguration wires it, driven through a client's frames: a fake
 * desk-rtc and a stub units.sock on real Unix sockets, and Chromium's debugging port on a port the test
 * picks.
 */
final class BrowserRig implements AutoCloseable {

    /** Short enough for tests, and with room for what a shared 2-core machine does to them. */
    static BrowserTabs.Timing timing(Duration publishEvery, Duration recentCall) {
        return timing(publishEvery, recentCall, Duration.ofMinutes(5));
    }

    static BrowserTabs.Timing timing(Duration publishEvery, Duration recentCall, Duration restartEvery) {
        return new BrowserTabs.Timing(
                publishEvery,
                recentCall,
                Duration.ofMillis(1500),
                Duration.ofMillis(800),
                Duration.ofMillis(800),
                Duration.ofMillis(800),
                Duration.ofMillis(300),
                Duration.ofMillis(50),
                Duration.ofMillis(800),
                restartEvery,
                new CdpClient.Timing(
                        Duration.ofMillis(500),
                        Duration.ofMillis(800),
                        Duration.ofMillis(20),
                        Duration.ofMillis(100),
                        Duration.ofMillis(50),
                        Duration.ofMillis(500)));
    }

    static final BrowserTabs.Timing FAST = timing(Duration.ofMillis(20), Duration.ofSeconds(30));

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

    final FakeDeskRtc fake;
    final StubUnitsSocket units;
    final RtcClient rtc;
    final RpcDispatcher dispatcher = new RpcDispatcher();
    final EventHub hub = new EventHub(new TopicRegistry());
    final SessionManager sessions;
    final PlatformHttp http = new PlatformHttp();
    final BrowserModule module;
    private final StubAuthorizer authorizer = new StubAuthorizer();
    private final AtomicLong nextId = new AtomicLong(10_000);
    private long nextHandle = 1;

    BrowserRig(Path dir, int cdpPort, BrowserTabs.Timing timing) throws Exception {
        this(dir, cdpPort, timing, new CdpListener(CdpListener.PROC_TCP, CdpListener.PROC_TCP6, cdpPort, ownUid()));
    }

    /** The real table says whose the port is: the fake and the real Chromium run as this user here. */
    static int ownUid() {
        try {
            return (Integer) Files.getAttribute(Path.of("/proc/self"), "unix:uid");
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    BrowserRig(Path dir, int cdpPort, BrowserTabs.Timing timing, Supplier<CdpListener.Verdict> listener) throws Exception {
        this(dir, cdpPort, timing, listener, BrowserClipboard.Timing.DEFAULT);
    }

    BrowserRig(Path dir, int cdpPort, BrowserTabs.Timing timing, Supplier<CdpListener.Verdict> listener, BrowserClipboard.Timing clipboard)
            throws Exception {
        this(dir, cdpPort, timing, listener, clipboard, null);
    }

    /** With these timings for what a desk nobody looks at does (ADR 0045). */
    BrowserRig(Path dir, int cdpPort, BrowserTabs.Timing timing, DeskAttention.Timing attention, BrowserFreeze.Timing freeze)
            throws Exception {
        this(dir, cdpPort, timing, new CdpListener(CdpListener.PROC_TCP, CdpListener.PROC_TCP6, cdpPort, ownUid()),
                BrowserClipboard.Timing.DEFAULT, null, attention, freeze, units -> {}, true);
    }

    /**
     * As above, with the stub set up before the module exists, for what deskd does as it starts. The thaw every start
     * begins with is left in the stub's requests, for the test to see.
     */
    BrowserRig(
            Path dir,
            int cdpPort,
            BrowserTabs.Timing timing,
            DeskAttention.Timing attention,
            BrowserFreeze.Timing freeze,
            java.util.function.Consumer<StubUnitsSocket> beforeModule)
            throws Exception {
        this(dir, cdpPort, timing, new CdpListener(CdpListener.PROC_TCP, CdpListener.PROC_TCP6, cdpPort, ownUid()),
                BrowserClipboard.Timing.DEFAULT, null, attention, freeze, beforeModule, false);
    }

    /** @param familyDns what says whether a host is filtered, or null for the real resolver, which only a teen's desk asks */
    BrowserRig(Path dir, int cdpPort, BrowserTabs.Timing timing, FilteredSites.Lookup familyDns) throws Exception {
        this(dir, cdpPort, timing, new CdpListener(CdpListener.PROC_TCP, CdpListener.PROC_TCP6, cdpPort, ownUid()),
                BrowserClipboard.Timing.DEFAULT, familyDns);
    }

    BrowserRig(
            Path dir,
            int cdpPort,
            BrowserTabs.Timing timing,
            Supplier<CdpListener.Verdict> listener,
            BrowserClipboard.Timing clipboard,
            FilteredSites.Lookup familyDns)
            throws Exception {
        this(dir, cdpPort, timing, listener, clipboard, familyDns, DeskAttention.Timing.DEFAULT, BrowserFreeze.Timing.DEFAULT, units -> {},
                true);
    }

    private BrowserRig(
            Path dir,
            int cdpPort,
            BrowserTabs.Timing timing,
            Supplier<CdpListener.Verdict> listener,
            BrowserClipboard.Timing clipboard,
            FilteredSites.Lookup familyDns,
            DeskAttention.Timing attention,
            BrowserFreeze.Timing freeze,
            java.util.function.Consumer<StubUnitsSocket> beforeModule,
            boolean forgetStartupThaw)
            throws Exception {
        Path socket = dir.resolve("rtc.sock");
        fake = new FakeDeskRtc(socket);
        units = new StubUnitsSocket(dir.resolve("units.sock"));
        beforeModule.accept(units);
        rtc = new RtcClient(new RtcClient.Config(socket, SessionManager.MAX_SESSIONS, FACTS::publicIpv4));
        sessions = new SessionManager(rtc, authorizer, dispatcher, hub, FACTS, "1", Instant.now());
        module = new BrowserModule(
                rtc,
                sessions,
                dispatcher,
                hub,
                http,
                new UnitsClient(dir.resolve("units.sock"))::run,
                dir.resolve(BrowserModule.REFUSAL_MARKER),
                cdpPort,
                listener,
                timing,
                clipboard,
                familyDns != null ? familyDns : new FamilyDns(http),
                attention,
                freeze);
        if (forgetStartupThaw) {
            units.forgetStartupThaw();
        }
        rtc.start(sessions);
        await().until(rtc::isConfigured);
    }

    TestClient connect(String sessionId, boolean video, boolean input) throws Exception {
        TestClient client = open(sessionId, video, input);
        client.hello();
        return client;
    }

    /** Up to a bound handle, with HELLO left to the test. */
    TestClient open(String sessionId, boolean video, boolean input) throws Exception {
        return open(sessionId, "owner", video, input);
    }

    TestClient open(String sessionId, String scope, boolean video, boolean input) throws Exception {
        String fingerprint = String.format("%02x", nextHandle + 16).repeat(32);
        SessionGrant grant = new SessionGrant(
                "user-1", "sid-" + sessionId, scope, fingerprint, video, input, Instant.now(), Instant.now().plus(Duration.ofHours(1)));
        authorizer.allow("token-" + sessionId, grant);
        sessions.open(sessionId, "token-" + sessionId);
        sessions.offer(sessionId, TestClient.offerFor(fingerprint));
        return new TestClient(fake, nextHandle++);
    }

    /** A later token for this session, valid for longer, with these permissions. */
    void refresh(String sessionId, boolean video, boolean input, String fingerprint) throws Exception {
        String token = "refresh-" + sessionId + "-" + nextId.getAndIncrement();
        authorizer.allow(token, new SessionGrant(
                "user-1", "sid-" + sessionId, "owner", fingerprint, video, input, Instant.now(), Instant.now().plus(Duration.ofHours(2))));
        sessions.refresh(sessionId, token);
    }

    /** The fingerprint {@link #open} gave the session with this handle. */
    static String fingerprintOf(TestClient client) {
        return String.format("%02x", client.handle() + 16).repeat(32);
    }

    TestClient connect(String sessionId) throws Exception {
        return connect(sessionId, true, true);
    }

    /** A request with a fresh idem. Replies in between would be a test's own doing. */
    Map<String, Object> call(TestClient client, String method, Map<String, Object> params) throws Exception {
        return call(client, method, params, UUID.randomUUID().toString());
    }

    Map<String, Object> call(TestClient client, String method, Map<String, Object> params, String idem) throws Exception {
        long id = send(client, method, params, idem);
        Map<String, Object> reply = client.nextReply();
        assertThat(reply).containsEntry("_id", id);
        return reply;
    }

    /** Sends and returns, so a test can do things while the call is out. */
    long send(TestClient client, String method, Map<String, Object> params, String idem) {
        return send(client, method, params, idem, null);
    }

    long send(TestClient client, String method, Map<String, Object> params, String idem, Integer deadlineMs) {
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

    /** Sends SUB and returns, so a test can do things while it's answered. */
    long sendSub(TestClient client, String topic) {
        long id = nextId.getAndIncrement();
        client.sendJson(Channels.RPC, FrameKind.SUB, id, Map.of("topic", topic, "params", Map.of()));
        return id;
    }

    @Override
    public void close() throws Exception {
        module.close();
        http.close();
        rtc.close();
        fake.close();
        units.close();
    }
}
