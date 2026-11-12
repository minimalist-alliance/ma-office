package com.minimalistalliance.desk.deskd.apps;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.session.SessionGrant;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import com.minimalistalliance.desk.deskd.status.DeskFacts;
import com.minimalistalliance.desk.deskd.testing.FakeDeskRtc;
import com.minimalistalliance.desk.deskd.testing.StubAuthorizer;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.testing.TestTiming;
import com.minimalistalliance.desk.deskd.testing.TestTokens;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The apps module as DataPlaneConfiguration wires it, driven through a client's frames: a fake desk-rtc, a real
 * {@code /data/apps} in a temp directory, the helper as {@link FakeAppHost}, the Platform's routes as {@link TestApps.Source},
 * and a review key the test made.
 *
 * <p>With {@code bundled}, the image's bundled apps are {@code <dir>/bundled-apps}, which the test lays out before it makes
 * the rig, kept in {@code <desk>/apps} and run by a bundled {@link FakeAppHost}, or with {@code realHost} by the real
 * {@link BundledAppHost}, which runs each as a process of its own.
 */
final class AppsRig implements AutoCloseable {

    static {
        TestTiming.pollFast();
    }

    private static final DeskFacts FACTS = new DeskFacts() {
        @Override
        public String deskId() {
            return TestTokens.DESK_ID;
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

    final Path root;
    final Path deskDir;
    final TestApps apps = new TestApps();
    final TestApps.Source source = new TestApps.Source();
    final FakeAppHost host;
    final FakeDeskRtc fake;
    final RtcClient rtc;
    final RpcDispatcher dispatcher = new RpcDispatcher();
    final EventHub hub = new EventHub(new TopicRegistry());
    final SessionManager sessions;
    final AppsModule module;
    final Path bundledRoot;
    final Path bundledData;
    final Path bundledRun;
    final boolean realHost;
    /** The bundled apps' host: a {@link FakeAppHost} or a {@link BundledAppHost}, or null for a rig with none. */
    AppHost bundledHost;
    final AtomicBoolean guild = new AtomicBoolean();
    final Members members = new Members();

    /** The guild's roster as apps see it: who stays, set by the test, null for a roster not to be trusted. */
    static final class Members implements AppMembers {
        volatile java.util.Set<String> retained;
        private final List<Runnable> listeners = new java.util.concurrent.CopyOnWriteArrayList<>();

        @Override
        public java.util.Set<String> retained() {
            return retained;
        }

        @Override
        public long nextChangeAtMillis() {
            return Long.MAX_VALUE;
        }

        @Override
        public void onChange(Runnable wake) {
            listeners.add(wake);
        }

        /** The roster changed to this. */
        void set(java.util.Set<String> next) {
            retained = next;
            listeners.forEach(Runnable::run);
        }
    }
    final AtomicLong freeBytes = new AtomicLong(100L << 30);
    private final StubAuthorizer authorizer = new StubAuthorizer();
    private final AtomicLong nextId = new AtomicLong(10_000);
    private long nextHandle = 1;

    AppsRig(Path dir) throws Exception {
        this(dir, false, false);
    }

    AppsRig(Path dir, boolean bundled, boolean realHost) throws Exception {
        root = Files.createDirectories(dir.resolve("apps"));
        deskDir = Files.createDirectories(dir.resolve("desk"));
        host = new FakeAppHost(root, dir.resolve("run"));
        bundledRoot = dir.resolve("bundled-apps");
        bundledData = deskDir.resolve(AppsModule.BUNDLED_DATA);
        bundledRun = dir.resolve("brun");
        this.realHost = realHost;
        Path socket = dir.resolve("rtc.sock");
        fake = new FakeDeskRtc(socket);
        rtc = new RtcClient(new RtcClient.Config(socket, SessionManager.MAX_SESSIONS, FACTS::publicIpv4));
        sessions = new SessionManager(rtc, authorizer, dispatcher, hub, FACTS, "1", Instant.now());
        module = new AppsModule(new AppStore(root), new AppsSwitch(deskDir), host, source,
                () -> List.of(apps.reviewKey(AppManifest.COMMUNITY)), apps.arch, freeBytes::get, dispatcher, hub, guild::get,
                () -> "America/Denver", Clock.systemUTC(), bundled ? bundledParts(false) : AppsModule.Bundled.none());
        module.runtime.tickEvery(Duration.ofMillis(200));
        module.guildMembers(members);
        module.start();
        rtc.start(sessions);
        await().until(rtc::isConfigured);
    }

    /**
     * The image's bundled apps as a deskd sees them: a fresh check of {@link #bundledRoot}, their registry in the desk's
     * directory, and their host, which a deskd restart makes anew only when it's the real one (its children went with the old
     * deskd).
     */
    private AppsModule.Bundled bundledParts(boolean restart) {
        BundledApps bundledApps = new BundledApps(bundledRoot, apps.arch, FakeAppHost.ownUid());
        if (bundledHost == null || (restart && realHost)) {
            bundledHost = realHost ? new BundledAppHost(bundledData, bundledRun, bundledApps::find)
                    : new FakeAppHost(bundledData, bundledRun, true);
        }
        return new AppsModule.Bundled(bundledApps, new AppStore(bundledData, true), bundledHost);
    }

    FakeAppHost fakeBundledHost() {
        return (FakeAppHost) bundledHost;
    }

    /** A new module over the same volume and helper, as a deskd restart has it. */
    AppsModule restart() {
        module.close();
        RpcDispatcher d = new RpcDispatcher();
        EventHub h = new EventHub(new TopicRegistry());
        AppsModule next = new AppsModule(new AppStore(root), new AppsSwitch(deskDir), host, source,
                () -> List.of(apps.reviewKey(AppManifest.COMMUNITY)), apps.arch, freeBytes::get, d, h, guild::get,
                () -> "America/Denver", Clock.systemUTC(), bundledHost != null ? bundledParts(true) : AppsModule.Bundled.none());
        next.start();
        return next;
    }

    /** Publishes these versions in the catalog and serves their packages. */
    void publish(long seq, TestApps.Built... versions) {
        for (TestApps.Built b : versions) {
            source.serve(b);
        }
        source.catalog = apps.catalog(seq, List.of(versions), List.of(), List.of());
    }

    // ---- sessions

    TestClient owner(String sessionId) throws Exception {
        return connect(sessionId, RpcPrincipal.OWNER, null);
    }

    TestClient export(String sessionId) throws Exception {
        return connect(sessionId, RpcPrincipal.EXPORT, null);
    }

    TestClient member(String sessionId, String memberId, String role) throws Exception {
        Caller caller = new Caller(Caller.GUILD_MEMBER, memberId, role, Caller.effectiveGrants(role, List.of()), "Name", null, false);
        return connect(sessionId, RpcPrincipal.GUILD_MEMBER, caller);
    }

    private TestClient connect(String sessionId, String scope, Caller caller) throws Exception {
        boolean owner = RpcPrincipal.OWNER.equals(scope);
        String fingerprint = String.format("%02x", nextHandle + 16).repeat(32);
        SessionGrant grant = caller == null
                ? new SessionGrant("user-1", "sid-" + sessionId, scope, fingerprint, owner, owner, Instant.now(), Instant.now().plus(Duration.ofHours(1)))
                : new SessionGrant(caller.memberId(), "sid-" + sessionId, scope, fingerprint, false, false, Instant.now(),
                        Instant.now().plus(Duration.ofHours(1)), caller, "gu-testguild01");
        authorizer.allow("token-" + sessionId, grant);
        sessions.open(sessionId, "token-" + sessionId);
        sessions.offer(sessionId, TestClient.offerFor(fingerprint));
        TestClient client = new TestClient(fake, nextHandle++);
        client.hello();
        return client;
    }

    // ---- calls

    Map<String, Object> call(TestClient client, String method, Object... pairs) throws Exception {
        return callWith(client, method, UUID.randomUUID().toString(), params(pairs));
    }

    static Map<String, Object> params(Object... pairs) {
        Map<String, Object> p = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            p.put((String) pairs[i], pairs[i + 1]);
        }
        return p;
    }

    Map<String, Object> callWith(TestClient client, String method, String idem, Map<String, Object> params) throws Exception {
        long id = nextId.getAndIncrement();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("m", method);
        body.put("p", params);
        if (idem != null) {
            body.put("idem", idem);
        }
        body.put("deadlineMs", 20_000);
        client.sendJson(Channels.RPC, FrameKind.REQ, id, body);
        Map<String, Object> reply = client.nextReply();
        assertThat(reply).containsEntry("_id", id);
        return reply;
    }

    Map<String, Object> ok(TestClient client, String method, Object... pairs) throws Exception {
        Map<String, Object> reply = call(client, method, pairs);
        assertThat(reply).as(method + " " + reply).containsEntry("_kind", "RES");
        return reply;
    }

    Map<String, Object> err(TestClient client, String code, String method, Object... pairs) throws Exception {
        Map<String, Object> reply = call(client, method, pairs);
        assertThat(reply).as(method + " " + reply).containsEntry("_kind", "ERR").containsEntry("code", code);
        return reply;
    }

    /** {@code apps.install} of a built version, with its own permissions as the grants. */
    Map<String, Object> install(TestClient client, TestApps.Built b) throws Exception {
        return call(client, "apps.install", "id", TestApps.ID, "version", b.version(), "packageSha256", b.sha256(), "grants", b.permissions());
    }

    /** A SUB's reply. */
    Map<String, Object> subscribe(TestClient client, String topic) throws Exception {
        long id = nextId.getAndIncrement();
        client.sendJson(Channels.RPC, FrameKind.SUB, id, Map.of("topic", topic, "params", Map.of()));
        Map<String, Object> reply = client.nextReply();
        assertThat(reply).containsEntry("_id", id);
        return reply;
    }

    /** The next event on the events channel, with its subscription id. */
    static Map<String, Object> event(TestClient client) throws Exception {
        Frame frame = client.next(Channels.EVENTS);
        assertThat(frame.kind()).isEqualTo(FrameKind.EVT);
        Map<String, Object> event = new LinkedHashMap<>(Json.parseObject(frame.payload()));
        event.put("_sub", frame.id());
        return event;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> app(Map<String, Object> list, String id) {
        for (Object a : (List<Object>) list.get("apps")) {
            Map<String, Object> app = (Map<String, Object>) a;
            if (id.equals(app.get("id"))) {
                return app;
            }
        }
        return null;
    }

    @Override
    public void close() throws Exception {
        module.close();
        host.closeAll();
        if (bundledHost instanceof FakeAppHost fakeHost) {
            fakeHost.closeAll();
        } else if (bundledHost != null) {
            bundledHost.close();
        }
        // A widget summary is kept by a thread of its own, which can still be writing under the volume when JUnit deletes it.
        await().until(() -> AppRuntime.AppSummaryFile.writers() == 0);
        rtc.close();
        fake.close();
    }
}
