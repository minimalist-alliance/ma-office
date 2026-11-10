package com.minimalistalliance.desk.deskd.files;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.data.Transfers;
import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
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
import com.nimbusds.jose.crypto.ECDSAVerifier;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.interfaces.ECPublicKey;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The Files module as DataPlaneConfiguration wires it, driven through a client's frames: a fake desk-rtc, a real tree in a
 * temp directory, the drive's free space and the guild switch under the test's control, and verdict tokens signed with a
 * key the test holds.
 */
final class FilesRig implements AutoCloseable {

    static {
        TestTiming.pollFast();
    }

    static final String MEMBER = "user-1";
    static final String DESK = TestTokens.DESK_ID;

    private static final DeskFacts FACTS = new DeskFacts() {
        @Override
        public String deskId() {
            return DESK;
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
    final Path root;
    final FakeDeskRtc fake;
    final RtcClient rtc;
    final RpcDispatcher dispatcher = new RpcDispatcher();
    final EventHub hub = new EventHub(new TopicRegistry());
    final SessionManager sessions;
    final Transfers transfers;
    final FilesModule files;
    final MutableClock clock = new MutableClock(Instant.parse("2026-11-08T12:00:00Z"));
    final TestTokens tokens = new TestTokens();
    final AtomicLong freeBytes = new AtomicLong(100L * 1024 * 1024 * 1024);
    final AtomicBoolean guild = new AtomicBoolean();
    private final StubAuthorizer authorizer = new StubAuthorizer();
    private final AtomicLong nextId = new AtomicLong(10_000);
    private long nextHandle = 1;

    FilesRig(Path dir) throws Exception {
        this(dir, false, true, Quota.FLOOR_BYTES, Duration.ofSeconds(3));
    }

    FilesRig(Path dir, boolean stubGate, boolean allowUnchecked, long floor, Duration finishWait) throws Exception {
        this.dir = dir;
        this.root = dir.resolve("files");
        Path socket = dir.resolve("rtc.sock");
        fake = new FakeDeskRtc(socket);
        rtc = new RtcClient(new RtcClient.Config(socket, SessionManager.MAX_SESSIONS, FACTS::publicIpv4));
        sessions = new SessionManager(rtc, authorizer, dispatcher, hub, FACTS, "1", Instant.now());
        transfers = Transfers.withoutExportAccounting(sessions, Duration.ofSeconds(30));
        sessions.registerChannelHandler(Channels.BULK, transfers);
        // DataModule does this in the desk: a session's end ends its transfers.
        sessions.addSessionListener(new com.minimalistalliance.desk.deskd.session.SessionListener() {
            @Override
            public void onSessionEnded(String sessionId) {
                transfers.sessionEnded(sessionId);
            }
        });
        ECPublicKey key = (ECPublicKey) tokens.keys().getPublic();
        VerdictVerifier verifier = new VerdictVerifier(
                kid -> TestTokens.KID.equals(kid) ? new ECDSAVerifier(key) : null,
                new VerdictVerifier.Identity() {
                    @Override
                    public String deskId() {
                        return DESK;
                    }

                    @Override
                    public String issuer() {
                        return TestTokens.ISSUER;
                    }
                },
                clock,
                stubGate ? VerdictVerifier.Mode.STUB : VerdictVerifier.Mode.REAL,
                allowUnchecked);
        Quota.Space space = new Quota.Space() {
            @Override
            public long total() {
                return 200L * 1024 * 1024 * 1024;
            }

            @Override
            public long free() {
                return freeBytes.get();
            }
        };
        FilesModule.Settings settings = new FilesModule.Settings(
                root, -1, floor, Duration.ofDays(30), Duration.ofHours(24), finishWait, Duration.ofDays(3650), stubGate, allowUnchecked, null);
        files = new FilesModule(sessions, dispatcher, hub, transfers, settings, verifier, space, guild::get, clock);
        rtc.start(sessions);
        await().until(rtc::isConfigured);
    }

    // ---- sessions

    TestClient connect(String sessionId, String scope) throws Exception {
        boolean owner = RpcPrincipal.OWNER.equals(scope);
        String fingerprint = String.format("%02x", nextHandle + 16).repeat(32);
        SessionGrant grant = new SessionGrant(
                MEMBER, "sid-" + sessionId, scope, fingerprint, owner, owner, Instant.now(), Instant.now().plus(Duration.ofHours(1)));
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

    /** A guild member's session, as a guild desk has them (this rig's desk is not one, but the scope is what is checked). */
    TestClient member(String sessionId) throws Exception {
        String fingerprint = String.format("%02x", nextHandle + 16).repeat(32);
        com.minimalistalliance.desk.deskd.rpc.Caller caller = new com.minimalistalliance.desk.deskd.rpc.Caller(
                "guild_member", "gm-1", "officer", com.minimalistalliance.desk.deskd.rpc.Caller.effectiveGrants("officer", List.of()),
                "Name", null, false);
        SessionGrant grant = new SessionGrant("gm-1", "sid-gm", "guild_member", fingerprint, false, false,
                Instant.now(), Instant.now().plus(Duration.ofHours(1)), caller, "gu-testguild01");
        authorizer.allow("token-" + sessionId, grant);
        sessions.open(sessionId, "token-" + sessionId);
        sessions.offer(sessionId, TestClient.offerFor(fingerprint));
        TestClient client = new TestClient(fake, nextHandle++);
        client.hello();
        return client;
    }

    TestClient export(String sessionId) throws Exception {
        return connect(sessionId, RpcPrincipal.EXPORT);
    }

    /** The same member in another browser, under another user id (a stranger, for isolation tests). */
    TestClient other(String sessionId, String sub) throws Exception {
        String fingerprint = String.format("%02x", nextHandle + 16).repeat(32);
        SessionGrant grant = new SessionGrant(
                sub, "sid-" + sessionId, RpcPrincipal.OWNER, fingerprint, true, true, Instant.now(), Instant.now().plus(Duration.ofHours(1)));
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

    Map<String, Object> ok(TestClient client, String method, Object... pairs) throws Exception {
        Map<String, Object> reply = call(client, method, pairs);
        assertThat(reply).as(method + " " + reply).containsEntry("_kind", "RES");
        return reply;
    }

    /** An error reply's code, and the reply for its details. */
    Map<String, Object> err(TestClient client, String code, String method, Object... pairs) throws Exception {
        Map<String, Object> reply = call(client, method, pairs);
        assertThat(reply).as(method + " " + reply).containsEntry("_kind", "ERR").containsEntry("code", code);
        return reply;
    }

    // ---- files on the real tree, for setup and for checking

    Path file(String relative, byte[] content) throws IOException {
        Path p = root.resolve(relative);
        Files.createDirectories(p.getParent());
        Files.write(p, content);
        return p;
    }

    static String sha(byte[] bytes) {
        try {
            return Uploads.hex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    // ---- uploads

    static byte[] bytes(int size, long seed) {
        byte[] b = new byte[size];
        new java.util.Random(seed).nextBytes(b);
        return b;
    }

    /** What a client holds of an upload while it sends. */
    static final class Sending {
        final String uploadId;
        final long transferId;
        long credit;
        long committed;
        long seq;
        String error;
        long sent;

        Sending(String uploadId, long transferId, long window, long startOffset) {
            this.uploadId = uploadId;
            this.transferId = transferId;
            this.credit = window;
            this.committed = startOffset;
            this.sent = startOffset;
        }
    }

    Sending begun(Map<String, Object> reply, long startOffset) {
        assertThat(reply).as(reply.toString()).containsEntry("_kind", "RES");
        return new Sending((String) reply.get("uploadId"), ((Number) reply.get("transferId")).longValue(),
                ((Number) reply.get("window")).longValue(), startOffset);
    }

    /** Sends {@code data[from, to)} within the credit, reading CREDIT frames when out of it. */
    void sendBytes(TestClient client, Sending s, byte[] data, long to) throws Exception {
        while (s.sent < to && s.error == null) {
            if (s.credit <= 0) {
                readCredit(client, s);
                continue;
            }
            int n = (int) Math.min(Math.min(Frame.MAX_PAYLOAD_BYTES, s.credit), to - s.sent);
            byte[] piece = java.util.Arrays.copyOfRange(data, (int) s.sent, (int) s.sent + n);
            client.sendFrame(Channels.BULK, FrameKind.CHUNK, Frame.BIN, s.transferId, s.seq++, piece);
            s.sent += n;
            s.credit -= n;
        }
    }

    void readCredit(TestClient client, Sending s) throws Exception {
        Frame frame = client.next(Channels.BULK);
        assertThat(frame.kind()).isEqualTo(FrameKind.CREDIT);
        assertThat(frame.id()).isEqualTo(s.transferId);
        Map<String, Object> body = Json.parseObject(frame.payload());
        s.credit += ((Number) body.get("bytes")).longValue();
        s.committed = ((Number) body.get("committed")).longValue();
        if (body.get("error") != null) {
            s.error = (String) body.get("error");
        }
    }

    /** Reads CREDITs until the desk says it has all of {@code size}, or ends the transfer. */
    void drain(TestClient client, Sending s, long size) throws Exception {
        while (s.committed < size && s.error == null) {
            readCredit(client, s);
        }
    }

    /** begin, send it all, finish. A {@code token} option goes to finish; the others to begin. @return finish's reply */
    Map<String, Object> upload(TestClient client, String path, byte[] data, Object... more) throws Exception {
        Map<String, Object> p = params("path", path, "size", (long) data.length);
        Object token = null;
        for (int i = 0; i < more.length; i += 2) {
            if ("token".equals(more[i])) {
                token = more[i + 1];
            } else {
                p.put((String) more[i], more[i + 1]);
            }
        }
        Map<String, Object> begin = callWith(client, "files.upload.begin", UUID.randomUUID().toString(), p);
        Sending s = begun(begin, 0);
        sendBytes(client, s, data, data.length);
        drain(client, s, data.length);
        Map<String, Object> f = params("uploadId", s.uploadId, "sha256", sha(data), "size", (long) data.length);
        if (token != null) {
            f.put("token", token);
        }
        return callWith(client, "files.upload.finish", UUID.randomUUID().toString(), f);
    }

    // ---- verdict tokens

    String verdict(byte[] original, String state) {
        return verdictFor(sha(original), original.length, state, MEMBER, DESK, TestTokens.ISSUER, Instant.parse("2026-11-08T12:00:00Z"), 600);
    }

    String verdictFor(String sha, long bytes, String state, String sub, String aud, String iss, Instant iat, long lifetime) {
        Map<String, Object> header = new LinkedHashMap<>();
        header.put("alg", "ES256");
        header.put("typ", VerdictVerifier.TYPE);
        header.put("kid", TestTokens.KID);
        Map<String, Object> claims = new LinkedHashMap<>();
        claims.put("iss", iss);
        claims.put("aud", aud);
        claims.put("sub", sub);
        claims.put("iat", iat.getEpochSecond());
        claims.put("exp", iat.getEpochSecond() + lifetime);
        claims.put("jti", "v-" + nextId.incrementAndGet());
        claims.put("ma_feature", "files");
        claims.put("ma_img", "img-1");
        claims.put("ma_sha256", sha);
        claims.put("ma_bytes", bytes);
        claims.put("ma_state", state);
        return tokens.es256(header, claims);
    }

    List<String> partials() throws IOException {
        try (var s = Files.list(root.resolve(".uploads"))) {
            return s.map(p -> p.getFileName().toString()).sorted().toList();
        }
    }

    private final AtomicBoolean closed = new AtomicBoolean();

    @Override
    public void close() throws Exception {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        files.close();
        rtc.close();
        fake.close();
    }
}
