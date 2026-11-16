package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.courier.keys.DeskKeys;
import com.minimalistalliance.desk.deskd.courier.keys.KeyPublisher;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.session.SessionGrant;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import com.minimalistalliance.desk.deskd.status.DeskFacts;
import com.minimalistalliance.desk.deskd.testing.FakeDeskRtc;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import com.minimalistalliance.desk.deskd.testing.StubAuthorizer;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.testing.TestTiming;
import com.minimalistalliance.desk.deskd.testing.TestTokens;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Courier as DataPlaneConfiguration wires it, driven through a client's frames: a fake desk-rtc, the real session and RPC
 * layers, the module with its store in a temporary directory, its switch file, and the desk's kind and band under the
 * test's control. Messages arrive through the store's sink, as a transport would hand them.
 */
final class CourierRig implements AutoCloseable {

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

    final Path dir;
    final FakeDeskRtc fake;
    final RtcClient rtc;
    final RpcDispatcher dispatcher = new RpcDispatcher();
    final EventHub hub = new EventHub(new TopicRegistry());
    final SessionManager sessions;
    final MutableClock clock = new MutableClock(Instant.parse("2026-11-12T12:00:00Z"));
    final AtomicBoolean guild = new AtomicBoolean();
    final AtomicReference<AgeBand.Band> band = new AtomicReference<>(AgeBand.Band.ADULT);
    final CourierModule module;
    private final StubAuthorizer authorizer = new StubAuthorizer();
    private final AtomicLong nextId = new AtomicLong(10_000);
    private long nextHandle = 1;

    CourierRig(Path dir) throws Exception {
        this(dir, dir.resolve("courier"));
    }

    CourierRig(Path dir, Path storeRoot) throws Exception {
        this(dir, storeRoot, null, KeyPublisher.NONE);
    }

    /** With the desk's keys in {@code keys} (Wave 1.4), published through {@code publisher}. */
    CourierRig(Path dir, Path storeRoot, DeskKeys.Settings keys, KeyPublisher publisher) throws Exception {
        this.dir = dir;
        Files.createDirectories(dir.resolve("desk"));
        Path socket = dir.resolve("rtc.sock");
        fake = new FakeDeskRtc(socket);
        rtc = new RtcClient(new RtcClient.Config(socket, SessionManager.MAX_SESSIONS, FACTS::publicIpv4));
        sessions = new SessionManager(rtc, authorizer, dispatcher, hub, FACTS, "1", Instant.now());
        CourierModule.Settings settings = new CourierModule.Settings(storeRoot, dir.resolve("desk"), true, Duration.ofDays(3650),
                CourierStore.Settings.DEFAULT);
        module = new CourierModule(dispatcher, hub, settings, TestMime.PARSER, new CourierSwitch(settings.switchDirectory()), guild::get,
                band::get, clock, keys, publisher);
        rtc.start(sessions);
        await().until(rtc::isConfigured);
        if (module.store() != null) {
            module.store().putAccount(new Courier.Account("desk", "desk", "This desk's address", "me@desk.example", "ok"),
                    List.<String[]>of(new String[] {"email", "me@desk.example"}));
        }
    }

    CourierStore store() {
        return module.store();
    }

    void switchTo(String words) throws Exception {
        Path f = dir.resolve("desk").resolve(CourierSwitch.FILE);
        if (words == null) {
            Files.deleteIfExists(f);
        } else {
            Files.writeString(f, words);
        }
        // The switch is read at most once a second.
        Thread.sleep(1_100);
    }

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

    TestClient owner(String sessionId) throws Exception {
        return connect(sessionId, RpcPrincipal.OWNER);
    }

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

    @Override
    public void close() throws Exception {
        module.close();
        rtc.close();
        fake.close();
    }
}
