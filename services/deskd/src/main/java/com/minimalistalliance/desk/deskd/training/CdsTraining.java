package com.minimalistalliance.desk.deskd.training;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import java.io.IOException;
import java.math.BigInteger;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import java.util.stream.Stream;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * The AppCDS training run: the real deskd, wired as on a desk, from boot through a real token, a session and the
 * Browser, against stand-ins on loopback and temporary Unix sockets. So the classes and lambdas of that path come
 * out of the archive on a desk instead of being loaded cold in the first session. See services/CLAUDE.md, Release
 * rules.
 *
 * <p>The Dockerfile's training RUN is the only thing that gets here, through the JVM system property
 * {@code DeskdApplication} checks. Nothing a running desk sets can reach it: the property isn't an environment
 * variable or a Spring property, the check doesn't run where /run/desk exists, and nothing else refers to this
 * package. This run's settings are system properties, which outrank anything in the environment, so no
 * environment can point it off loopback. It uses no /data, /run/desk or secrets, and needs no network. What it
 * writes goes in a temporary directory and goes away. What the JVM keeps at exit is class metadata only: a dynamic
 * archive holds no heap, so no value from this run can be in it.
 *
 * <p>A step that doesn't go as it does on a desk fails the run, and so the build, rather than quietly archiving
 * less. CDS holds no compiled code, so this doesn't remove JIT warm-up.
 */
public final class CdsTraining {

    private static final Duration WHOLE_RUN = Duration.ofMinutes(3);
    private static final Duration STEP = Duration.ofSeconds(30);
    private static final String DESK_ID = "d-training";
    private static final String OWNER_ID = UUID.nameUUIDFromBytes(new byte[] {1}).toString();
    private static final String ISSUER = "https://issuer.training.invalid";
    private static final String KEY_ID = "training";
    private static final String FINGERPRINT = "ab".repeat(32);
    private static final String VOLUME_ID = "vol-0123456789abcdef0";
    private static final Base64.Encoder B64 = Base64.getUrlEncoder().withoutPadding();

    private final KeyPair signing;
    private final BlockingQueue<Map<String, Object>> fromDeskd = new LinkedBlockingQueue<>();
    private final BlockingQueue<String> heartbeats = new LinkedBlockingQueue<>();
    private volatile LoopbackServer.Peer gateway;
    private TrainingRtc rtc;
    private Path adminSocket;
    private volatile int apiPort;
    private volatile int linkPort;
    private long nextRequest = 1;
    private long nextJti = 1;

    private CdsTraining() throws GeneralSecurityException {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        signing = generator.generateKeyPair();
    }

    /** Trains, then ends the JVM, which is what writes the archive. Exits non-zero if anything went wrong. */
    public static void run(Supplier<ConfigurableApplicationContext> application) {
        Thread.ofPlatform().daemon().name("training-limit").start(() -> {
            try {
                Thread.sleep(WHOLE_RUN);
                System.err.println("deskd CDS training ran out of time");
                Runtime.getRuntime().halt(1);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        try {
            new CdsTraining().train(application);
            System.out.println("deskd CDS training finished");
        } catch (Exception | Error e) {
            System.err.println("deskd CDS training failed: " + e);
            Runtime.getRuntime().halt(1);
        }
        System.exit(0);
    }

    private void train(Supplier<ConfigurableApplicationContext> application) throws Exception {
        Path dir = Files.createTempDirectory("deskd-train");
        try {
            TrainingPki pki = TrainingPki.create();
            pki.trustInThisJvm(dir.resolve("trust.p12"));
            loadTheJdksCaList();
            TrainingChromium browser = new TrainingChromium();
            // Platform's endpoints can be on either, so both get a handshake.
            try (LoopbackServer imds = new LoopbackServer(this::imds, null, null);
                    LoopbackServer api = new LoopbackServer(this::api, pki.serverContext(), "TLSv1.2");
                    LoopbackServer link = new LoopbackServer(new GatewayHandler(), pki.serverContext(), "TLSv1.3");
                    LoopbackServer chromium = new LoopbackServer(browser, null, null);
                    TrainingRtc fakeRtc = new TrainingRtc(dir.resolve("rtc.sock"), STEP);
                    TrainingUnits units = new TrainingUnits(dir.resolve("units.sock"));
                    TrainingNotebook notebook = new TrainingNotebook(dir.resolve("notebook.sock"))) {
                browser.port(chromium.port());
                rtc = fakeRtc;
                adminSocket = dir.resolve("admin.sock");
                apiPort = api.port();
                linkPort = link.port();
                configure(dir, imds.port(), api.port(), chromium.port());
                // Closing the context sends the last heartbeat and closes deskd's sockets, as a SIGTERM does.
                try (ConfigurableApplicationContext ignored = application.get()) {
                    driveASession();
                }
            }
        } finally {
            try (Stream<Path> files = Files.walk(dir)) {
                for (Path file : files.sorted(Comparator.reverseOrder()).toList()) {
                    Files.deleteIfExists(file);
                }
            }
        }
    }

    private static void configure(Path dir, int imdsPort, int apiPort, int cdpPort) throws IOException {
        Files.createDirectory(dir.resolve("data"));
        // As desk-datadirs leaves it for deskd at every boot.
        Files.writeString(
                dir.resolve("data").resolve("volume.json"),
                "{\"volumeId\":\"" + VOLUME_ID + "\",\"formattedAt\":\"2026-11-06T02:00:00Z\",\"image\":\"training\"}\n");
        System.setProperty("deskd.imds.url", "http://127.0.0.1:" + imdsPort);
        System.setProperty("deskd.api.url", "https://localhost:" + apiPort);
        System.setProperty("deskd.jwks.url", "https://localhost:" + apiPort + "/.well-known/jwks.json");
        System.setProperty("deskd.rtc.socket", dir.resolve("rtc.sock").toString());
        System.setProperty("deskd.admin.socket", dir.resolve("admin.sock").toString());
        System.setProperty("deskd.units.socket", dir.resolve("units.sock").toString());
        // Nothing listens there: the relay to desk-agent waits, as on a desk before desk-agent is installed.
        System.setProperty("deskd.agent.socket", dir.resolve("agent.sock").toString());
        System.setProperty("deskd.notebook.socket", dir.resolve("notebook.sock").toString());
        // Nothing listens there, so data.* would answer unavailable: the training never calls one.
        System.setProperty("deskd.data.socket", dir.resolve("data.sock").toString());
        System.setProperty("deskd.data.dir", dir.resolve("data").toString());
        System.setProperty("deskd.cdp.port", Integer.toString(cdpPort));
        // Its stand-in for Chromium holds the port as whoever this is, and on a build that's root.
        System.setProperty("deskd.cdp.uid", Files.getAttribute(Path.of("/proc/self"), "unix:uid").toString());
        System.setProperty("deskd.image.version", "training");
    }

    /** A desk's first TLS reads the JDK's whole list and parses every certificate in it, of every kind of key. */
    private static void loadTheJdksCaList() throws IOException, GeneralSecurityException {
        Path cacerts = Path.of(System.getProperty("java.home"), "lib", "security", "cacerts");
        KeyStore list = KeyStore.getInstance(cacerts.toFile(), (char[]) null);
        if (list.size() == 0) {
            throw new IllegalStateException("the JDK's CA list is empty");
        }
    }

    // ---- the session

    private void driveASession() throws Exception {
        awaitFromDeskd("ready");
        // Hello and the JWKS come before the link, and the first heartbeat right after it.
        String heartbeat = heartbeats.poll(STEP.toSeconds(), TimeUnit.SECONDS);
        if (heartbeat == null) {
            throw new IllegalStateException("no heartbeat");
        }
        // That's what reads the volume's record, on a desk too.
        Map<String, Object> volume = Json.object(Json.parseObject(heartbeat.getBytes(StandardCharsets.UTF_8)), "dataVolume");
        if (volume == null || !VOLUME_ID.equals(Json.string(volume, "volumeId"))) {
            throw new IllegalStateException("the heartbeat has no volume record");
        }
        sendToDeskd(Map.of("type", "notify", "topic", "other"));
        String session = "training-session";

        sendOpen("refused", token("not " + ISSUER));
        awaitFromDeskd("session.reject");

        sendOpen(session, token(ISSUER));
        awaitFromDeskd("session.accept");
        sendToDeskd(Map.of("type", "signal", "sessionId", session, "data", Map.of("type", "offer", "sdp", offer())));
        Map<String, Object> answer = awaitFromDeskd("signal");
        if (!"answer".equals(Json.string(Json.object(answer, "data"), "type"))) {
            throw new IllegalStateException("no answer to the offer");
        }
        rtc.send(Channels.CTL, jsonFrame(FrameKind.HELLO, 0, Map.of("deskApi", "1.0", "appVersion", "training")));
        expect(Channels.CTL, FrameKind.HELLO);
        rtc.send(Channels.CTL, new Frame(FrameKind.PING, 0, 1, 0, new byte[0]));
        expect(Channels.CTL, FrameKind.PONG);
        rtc.send(Channels.CTL, jsonFrame(FrameKind.ACTIVITY, 0, Map.of("lastInputAt", Instant.now().toString())));

        call("desk.status.get", Map.of());
        rtc.send(Channels.RPC, jsonFrame(FrameKind.REQ, nextRequest, Map.of("m", "no.such.method", "p", Map.of())));
        expectReply(nextRequest++, FrameKind.ERR);
        rtc.send(Channels.CTL, jsonFrame(FrameKind.AUTH, 2, Map.of("deskToken", token(ISSUER))));
        expect(Channels.CTL, FrameKind.AUTH);

        driveTheBrowser();
        driveTheClipboard();
        driveTheNotebook();
        health();

        rtc.send(Channels.CTL, jsonFrame(FrameKind.CLOSE, 0, Map.of("code", 1000)));
        awaitFromDeskd("session.close");
    }

    private void driveTheBrowser() throws Exception {
        long subscription = nextRequest++;
        rtc.send(Channels.RPC, jsonFrame(FrameKind.SUB, subscription, Map.of("topic", "browser.tabs", "params", Map.of())));
        expectReply(subscription, FrameKind.RES);

        call("desk.attention.set", Map.of("seen", true));
        call("browser.stream.set", Map.of("state", "warm"));
        call("browser.stream.set", Map.of("state", "live"));
        // The list is how a client knows it's connected. A first try can find Chromium still being attached to.
        List<?> tabs = awaitTabs();
        if (tabs.size() != 2) {
            throw new IllegalStateException("the tab list has " + tabs.size() + " tabs");
        }
        expect(Channels.EVENTS, FrameKind.EVT);

        mutate("browser.tab.navigate", Map.of("url", "https://example.invalid/next"));
        mutate("browser.tab.back", Map.of());
        mutate("browser.tab.forward", Map.of());
        mutate("browser.tab.reload", Map.of());
        mutate("browser.tab.activate", Map.of("tabId", "page-a"));
        mutate("browser.text.insert", Map.of("text", "x"));
        mutate("browser.tab.open", Map.of());
        mutate("browser.tab.close", Map.of("tabId", "page-c"));

        long unsubscribe = nextRequest++;
        rtc.send(Channels.RPC, jsonFrame(FrameKind.UNSUB, unsubscribe, Map.of("sub", subscription)));
        expectAnyReply(unsubscribe);
        call("browser.stream.set", Map.of("state", "off"));
    }

    /** A paste and a copy, as a client does them: SUB, the event a page's copy brings, write, read, UNSUB. */
    private void driveTheClipboard() throws Exception {
        long subscription = nextRequest++;
        rtc.send(Channels.RPC, jsonFrame(FrameKind.SUB, subscription, Map.of("topic", "browser.clipboard", "params", Map.of())));
        Frame subscribed = expectAnyReply(subscription);
        if (subscribed.kind() != FrameKind.RES) {
            throw new IllegalStateException("the clipboard's SUB got " + subscribed.kind());
        }
        long subId = ((Number) Json.parseObject(subscribed.payload()).get("subId")).longValue();
        // Subscribing turns desk-rtc's watch on, and the stand-in answers that with a change.
        awaitEvent(subId);

        String text = "training \u00fcn\u00efc\u00f6d\u00e9 \u2603 \ud83d\ude00 and more\n";
        call("browser.clipboard.write", Map.of("text", text + "\u0000"));
        long read = nextRequest++;
        rtc.send(Channels.RPC, jsonFrame(FrameKind.REQ, read, Map.of("m", "browser.clipboard.read", "p", Map.of())));
        Frame reply = expectAnyReply(read);
        if (reply.kind() != FrameKind.RES || !text.equals(Json.string(Json.parseObject(reply.payload()), "text"))) {
            throw new IllegalStateException("the clipboard didn't read back what was written");
        }

        long unsubscribe = nextRequest++;
        rtc.send(Channels.RPC, jsonFrame(FrameKind.UNSUB, unsubscribe, Map.of("subId", subId)));
        expectReply(unsubscribe, FrameKind.RES);
        long deadline = System.nanoTime() + STEP.toNanos();
        while (rtc.watching()) {
            if (System.nanoTime() > deadline) {
                throw new IllegalStateException("the clipboard's watch stayed on");
            }
            Thread.sleep(10);
        }
    }

    /** A member opening Notebook: the tree, a write, the topic and a page's first message. */
    private void driveTheNotebook() throws Exception {
        call("notebook.tree", Map.of());
        mutate("notebook.page.trash", Map.of("pageId", "page-1"));
        long subscription = nextRequest++;
        rtc.send(Channels.RPC, jsonFrame(FrameKind.SUB, subscription, Map.of("topic", "notebook.tree", "params", Map.of())));
        Frame subscribed = expectAnyReply(subscription);
        if (subscribed.kind() != FrameKind.RES) {
            throw new IllegalStateException("the tree's SUB got " + subscribed.kind());
        }
        awaitEvent(((Number) Json.parseObject(subscribed.payload()).get("subId")).longValue());
        rtc.send(Channels.COLLAB, new Frame(FrameKind.DATA, Frame.BIN, 1, 0, new byte[] {0, 1, 2}));
        expect(Channels.COLLAB, FrameKind.DATA);
    }

    /** The next event for this subscription. Others, such as the tabs', can come first. */
    private void awaitEvent(long subId) throws Exception {
        long deadline = System.nanoTime() + STEP.toNanos();
        while (System.nanoTime() < deadline) {
            Frame frame = rtc.next(Channels.EVENTS);
            if (frame.kind() == FrameKind.EVT && frame.id() == subId) {
                return;
            }
        }
        throw new IllegalStateException("no event for subscription " + subId);
    }

    private List<?> awaitTabs() throws Exception {
        long deadline = System.nanoTime() + STEP.toNanos();
        while (System.nanoTime() < deadline) {
            long id = nextRequest++;
            rtc.send(Channels.RPC, jsonFrame(FrameKind.REQ, id, Map.of("m", "browser.tab.list", "p", Map.of())));
            Frame reply = expectAnyReply(id);
            if (reply.kind() == FrameKind.RES && Json.parseObject(reply.payload()).get("tabs") instanceof List<?> tabs && !tabs.isEmpty()) {
                return tabs;
            }
            Thread.sleep(50);
        }
        throw new IllegalStateException("no tabs");
    }

    /** What the smoke test asks: GET /health on the admin socket. */
    private void health() throws IOException {
        try (SocketChannel channel = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            channel.connect(UnixDomainSocketAddress.of(adminSocket));
            channel.write(ByteBuffer.wrap("GET /health HTTP/1.1\r\nHost: x\r\n\r\n".getBytes(StandardCharsets.US_ASCII)));
            ByteBuffer in = ByteBuffer.allocate(4096);
            while (channel.read(in) >= 0 && in.hasRemaining()) {
                // Until it closes: one request per connection.
            }
            String response = new String(in.array(), 0, in.position(), StandardCharsets.ISO_8859_1);
            if (!response.startsWith("HTTP/1.1 200")) {
                throw new IllegalStateException("health didn't answer 200");
            }
        }
    }

    private void call(String method, Map<String, Object> params) throws Exception {
        long id = nextRequest++;
        rtc.send(Channels.RPC, jsonFrame(FrameKind.REQ, id, Map.of("m", method, "p", params)));
        expectReply(id, FrameKind.RES);
    }

    private void mutate(String method, Map<String, Object> params) throws Exception {
        long id = nextRequest++;
        rtc.send(Channels.RPC, jsonFrame(FrameKind.REQ, id, Map.of("m", method, "p", params, "idem", "idem-" + id)));
        expectReply(id, FrameKind.RES);
    }

    private void expectReply(long id, FrameKind kind) throws Exception {
        Frame reply = expectAnyReply(id);
        if (reply.kind() != kind) {
            throw new IllegalStateException("request " + id + " got " + reply.kind() + " " + Json.string(Json.parseObject(reply.payload()), "code"));
        }
    }

    private Frame expectAnyReply(long id) throws Exception {
        Frame reply = rtc.next(Channels.RPC);
        if (reply.id() != id) {
            throw new IllegalStateException("a reply to " + reply.id() + " while waiting for " + id);
        }
        return reply;
    }

    private void expect(int channel, FrameKind kind) throws Exception {
        Frame frame = rtc.next(channel);
        if (frame.kind() != kind) {
            throw new IllegalStateException("expected " + kind + " and got " + frame.kind());
        }
    }

    private static Frame jsonFrame(FrameKind kind, long id, Map<String, Object> body) {
        return new Frame(kind, 0, id, 0, Json.bytes(body));
    }

    private void sendOpen(String sessionId, String token) throws IOException {
        sendToDeskd(Map.of("type", "session.open", "sessionId", sessionId, "deskToken", token, "openedAt", Instant.now().toString()));
    }

    private void sendToDeskd(Map<String, Object> message) throws IOException {
        gateway.send(new String(Json.bytes(message), StandardCharsets.UTF_8));
    }

    private Map<String, Object> awaitFromDeskd(String type) throws InterruptedException {
        long deadline = System.nanoTime() + STEP.toNanos();
        while (true) {
            Map<String, Object> message = fromDeskd.poll(deadline - System.nanoTime(), TimeUnit.NANOSECONDS);
            if (message == null) {
                throw new IllegalStateException("deskd never sent " + type);
            }
            if (type.equals(Json.string(message, "type"))) {
                return message;
            }
        }
    }

    // ---- the token

    private String token(String issuer) throws GeneralSecurityException {
        long now = Instant.now().getEpochSecond();
        Map<String, Object> header = Map.of("alg", "ES256", "typ", "ma-desk+jwt", "kid", KEY_ID);
        Map<String, Object> claims = new LinkedHashMap<>();
        claims.put("iss", issuer);
        claims.put("aud", DESK_ID);
        claims.put("sub", OWNER_ID);
        claims.put("scope", "owner");
        claims.put("sid", "s-training");
        claims.put("jti", "jt-" + nextJti++);
        claims.put("iat", now);
        claims.put("nbf", now);
        claims.put("exp", now + 300);
        claims.put("cnf", Map.of("x5t#S256", B64.encodeToString(HexFormat.of().parseHex(FINGERPRINT))));
        claims.put("ma_owner", OWNER_ID);
        String input = B64.encodeToString(Json.bytes(header)) + "." + B64.encodeToString(Json.bytes(claims));
        Signature signature = Signature.getInstance("SHA256withECDSAinP1363Format");
        signature.initSign(signing.getPrivate());
        signature.update(input.getBytes(StandardCharsets.US_ASCII));
        return input + "." + B64.encodeToString(signature.sign());
    }

    private static String offer() {
        List<String> pairs = new ArrayList<>();
        for (int i = 0; i < FINGERPRINT.length(); i += 2) {
            pairs.add(FINGERPRINT.substring(i, i + 2).toUpperCase(Locale.ROOT));
        }
        String line = "a=fingerprint:sha-256 " + String.join(":", pairs) + "\r\n";
        return "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" + line + "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" + line;
    }

    private Map<String, Object> jwks() {
        ECPublicKey key = (ECPublicKey) signing.getPublic();
        Map<String, Object> jwk = new LinkedHashMap<>();
        jwk.put("kty", "EC");
        jwk.put("crv", "P-256");
        jwk.put("kid", KEY_ID);
        jwk.put("use", "sig");
        jwk.put("alg", "ES256");
        jwk.put("x", B64.encodeToString(fixed(key.getW().getAffineX())));
        jwk.put("y", B64.encodeToString(fixed(key.getW().getAffineY())));
        return Map.of("keys", List.of(jwk));
    }

    private static byte[] fixed(BigInteger value) {
        byte[] raw = value.toByteArray();
        byte[] out = new byte[32];
        int copy = Math.min(raw.length, 32);
        System.arraycopy(raw, raw.length - copy, out, 32 - copy, copy);
        return out;
    }

    // ---- the stand-ins for Platform

    private LoopbackServer.Response imds(LoopbackServer.Request request) {
        String path = request.path();
        String body = switch (path) {
            case "/latest/api/token" -> "training-imds-token";
            case "/latest/meta-data/tags/instance/DeskId" -> DESK_ID;
            case "/latest/meta-data/tags/instance/UserId" -> OWNER_ID;
            case "/latest/meta-data/tags/instance/DeskKind" -> "test";
            case "/latest/meta-data/tags/instance/Env" -> "staging";
            case "/latest/meta-data/instance-id" -> "i-0000000000000000";
            case "/latest/meta-data/public-ipv4" -> "192.0.2.1";
            case "/latest/meta-data/instance-type" -> "training";
            case "/latest/meta-data/ami-id" -> "ami-00000000";
            case "/latest/meta-data/iam/security-credentials/" -> "training-role\n";
            case "/latest/meta-data/iam/security-credentials/training-role" -> new String(Json.bytes(Map.of(
                    "Code", "Success",
                    "AccessKeyId", "ASIATRAINING",
                    "SecretAccessKey", "not-a-secret",
                    "Token", "not-a-token",
                    "Expiration", Instant.now().plus(Duration.ofHours(6)).toString())), StandardCharsets.UTF_8);
            default -> null;
        };
        return body == null ? new LoopbackServer.Response(404, "") : new LoopbackServer.Response(200, body);
    }

    private LoopbackServer.Response api(LoopbackServer.Request request) {
        Map<String, Object> body = switch (request.path()) {
            // Without config here, deskd asks for it, so that's run too.
            case "/v1/agent/hello" -> Map.of("deskId", DESK_ID, "state", "running", "heartbeatSeconds", 60);
            case "/v1/agent/config" -> config();
            case "/v1/agent/heartbeat" -> {
                heartbeats.add(new String(request.body(), StandardCharsets.UTF_8));
                yield Map.of("state", "running", "nextHeartbeatSeconds", 60, "configVersion", 1, "actions", List.of());
            }
            case "/.well-known/jwks.json" -> jwks();
            default -> null;
        };
        return body == null
                ? new LoopbackServer.Response(404, "{\"error\":{\"code\":\"not_found\",\"message\":\"no\"}}")
                : new LoopbackServer.Response(200, new String(Json.bytes(body), StandardCharsets.UTF_8));
    }

    private Map<String, Object> config() {
        Map<String, Object> endpoints = new LinkedHashMap<>();
        endpoints.put("api", "https://localhost:" + apiPort);
        endpoints.put("issuer", ISSUER);
        endpoints.put("jwks", "https://localhost:" + apiPort + "/.well-known/jwks.json");
        endpoints.put("gateway", "wss://localhost:" + linkPort + "/v1");
        endpoints.put("gatewayId", "gw.training.invalid");
        return Map.of("configVersion", 1, "endpoints", endpoints);
    }

    private final class GatewayHandler implements LoopbackServer.Handler {
        @Override
        public LoopbackServer.Response http(LoopbackServer.Request request) {
            return new LoopbackServer.Response(404, "");
        }

        @Override
        public void webSocket(LoopbackServer.Request request, LoopbackServer.Peer peer) throws Exception {
            gateway = peer;
            String text;
            while ((text = peer.read()) != null) {
                Map<String, Object> message = Json.parseObject(text.getBytes(StandardCharsets.UTF_8));
                fromDeskd.add(message);
                if ("ready".equals(Json.string(message, "type"))) {
                    peer.send("{\"type\":\"ready.ack\"}");
                }
            }
        }
    }

    /** Stands in for desk-units: one request per connection, and every job goes well. */
    private static final class TrainingUnits implements AutoCloseable {
        private final ServerSocketChannel server;

        TrainingUnits(Path socket) throws IOException {
            server = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
            server.bind(UnixDomainSocketAddress.of(socket));
            Thread.ofVirtual().name("training-units").start(this::serve);
        }

        private void serve() {
            try {
                while (true) {
                    try (SocketChannel client = server.accept()) {
                        ByteBuffer request = ByteBuffer.allocate(64);
                        do {
                            if (client.read(request) < 0) {
                                break;
                            }
                        } while (request.get(request.position() - 1) != '\n');
                        client.write(ByteBuffer.wrap("ok\n".getBytes(StandardCharsets.US_ASCII)));
                    }
                }
            } catch (IOException e) {
                // Closed: the training is over.
            }
        }

        @Override
        public void close() throws IOException {
            server.close();
        }
    }
}
