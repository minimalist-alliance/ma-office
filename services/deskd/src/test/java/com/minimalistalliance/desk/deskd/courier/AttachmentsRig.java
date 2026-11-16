package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.auth.DeskTokenVerifier;
import com.minimalistalliance.desk.deskd.courier.keys.KeyPublisher;
import com.minimalistalliance.desk.deskd.courier.parse.CourierSandbox;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.data.Transfers;
import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import com.minimalistalliance.desk.deskd.files.FilesModule;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
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
import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Courier's attachments as DataPlaneConfiguration wires them: the real session and RPC layers over a fake desk-rtc, the
 * {@code bulk} transfers, a real Files tree in a temporary directory, and Courier with the real Courier mode answering on
 * a socket ({@link ParseStandIn}), so a part is cut out by the same worker the sandbox runs.
 */
final class AttachmentsRig implements AutoCloseable {

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
    final Path filesRoot;
    final FakeDeskRtc fake;
    final RtcClient rtc;
    final RpcDispatcher dispatcher = new RpcDispatcher();
    final EventHub hub = new EventHub(new TopicRegistry());
    final SessionManager sessions;
    final Transfers transfers;
    final FilesModule files;
    final ParseStandIn parse;
    final CourierModule module;
    final MutableClock clock = new MutableClock(Instant.parse("2026-11-12T12:00:00Z"));
    final AtomicReference<Instant> pausedUntil = new AtomicReference<>();
    private final StubAuthorizer authorizer = new StubAuthorizer();
    private final AtomicLong nextId = new AtomicLong(10_000);
    private long nextHandle = 1;

    AttachmentsRig(Path dir) throws Exception {
        this.dir = dir;
        this.filesRoot = dir.resolve("files");
        Files.createDirectories(dir.resolve("desk"));
        Files.createDirectories(filesRoot);
        Files.setPosixFilePermissions(filesRoot, java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"));
        Path socket = dir.resolve("rtc.sock");
        fake = new FakeDeskRtc(socket);
        rtc = new RtcClient(new RtcClient.Config(socket, SessionManager.MAX_SESSIONS, FACTS::publicIpv4));
        sessions = new SessionManager(rtc, authorizer, dispatcher, hub, FACTS, "1", Instant.now());
        transfers = Transfers.withoutExportAccounting(sessions, Duration.ofSeconds(30));
        sessions.registerChannelHandler(Channels.BULK, transfers);
        sessions.addSessionListener(new com.minimalistalliance.desk.deskd.session.SessionListener() {
            @Override
            public void onSessionEnded(String sessionId) {
                transfers.sessionEnded(sessionId);
            }
        });
        Path keys = dir.resolve("verdict-keys.json");
        Files.writeString(keys, "{\"keys\":[]}");
        FilesModule.Settings fs = new FilesModule.Settings(filesRoot, -1, 0, Duration.ofDays(30), Duration.ofHours(24),
                Duration.ofSeconds(3), Duration.ofDays(3650), false, true, keys);
        files = new FilesModule(sessions, dispatcher, hub, transfers, fs, null, new DeskTokenVerifier.Trust() {
            @Override
            public String deskId() {
                return TestTokens.DESK_ID;
            }

            @Override
            public String userId() {
                return "user-1";
            }

            @Override
            public String issuer() {
                return TestTokens.ISSUER;
            }
        }, () -> false, clock);
        parse = new ParseStandIn(dir.resolve("parse"));
        CourierSandbox sandbox = new CourierSandbox(new CourierSandbox.Settings(parse.socket, Duration.ofSeconds(15), Duration.ofSeconds(2)));
        CourierModule.Settings settings = new CourierModule.Settings(dir.resolve("courier"), dir.resolve("desk"), true, Duration.ofDays(3650),
                CourierStore.Settings.DEFAULT);
        module = new CourierModule(dispatcher, hub, settings, sandbox, new CourierSwitch(settings.switchDirectory()), () -> false,
                () -> AgeBand.Band.ADULT, clock, null, KeyPublisher.NONE);
        module.attachmentsThrough(files.agentAccess(), transfers, pausedUntil::get);
        rtc.start(sessions);
        await().until(rtc::isConfigured);
        module.store().putAccount(new Courier.Account("desk", "desk", "This desk's address", "me@desk.example", "ok"),
                List.<String[]>of(new String[] {"email", "me@desk.example"}));
    }

    CourierStore store() {
        return module.store();
    }

    /** A raw message through the sink, as the door's transport would hand it. @return its id */
    String deliver(byte[] raw, String externalSeed) throws Exception {
        Courier.Accepted a = store().accept(new Courier.Inbound("desk", "email",
                com.minimalistalliance.desk.deskd.courier.store.ExternalIds.email("desk", externalSeed + "@x", raw), Courier.Origin.LIVE, raw,
                null, Courier.Verdicts.NONE, false, false, List.of(), null));
        return a.messageId();
    }

    TestClient owner(String sessionId) throws Exception {
        String fingerprint = String.format("%02x", nextHandle + 16).repeat(32);
        SessionGrant grant = new SessionGrant(
                "user-1", "sid-" + sessionId, RpcPrincipal.OWNER, fingerprint, true, true, Instant.now(), Instant.now().plus(Duration.ofHours(1)));
        authorizer.allow("token-" + sessionId, grant);
        sessions.open(sessionId, "token-" + sessionId);
        sessions.offer(sessionId, TestClient.offerFor(fingerprint));
        TestClient client = new TestClient(fake, nextHandle++);
        client.hello();
        return client;
    }

    Map<String, Object> call(TestClient client, String method, Object... pairs) throws Exception {
        Map<String, Object> p = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            p.put((String) pairs[i], pairs[i + 1]);
        }
        long id = nextId.getAndIncrement();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("m", method);
        body.put("p", p);
        body.put("idem", UUID.randomUUID().toString());
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

    /** A transfer's bytes and its END frame's payload, granting credit as it goes. */
    record Received(byte[] bytes, byte[] end) {}

    Received receive(TestClient client, long transferId) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        long sinceGrant = 0;
        long seq = 0;
        while (true) {
            Frame frame = client.next(Channels.BULK);
            assertThat(frame.kind()).isEqualTo(FrameKind.CHUNK);
            assertThat(frame.id()).isEqualTo(transferId);
            assertThat(frame.seq()).isEqualTo(seq++);
            if ((frame.flags() & Frame.END) != 0) {
                return new Received(bytes.toByteArray(), frame.payload());
            }
            bytes.write(frame.payload());
            sinceGrant += frame.payload().length;
            if (sinceGrant >= 256 * 1024) {
                client.sendJson(Channels.BULK, FrameKind.CREDIT, transferId, Map.of("bytes", sinceGrant));
                sinceGrant = 0;
            }
        }
    }

    @Override
    public void close() throws Exception {
        module.close();
        files.close();
        parse.close();
        rtc.close();
        fake.close();
    }
}
