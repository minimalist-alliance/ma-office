package com.minimalistalliance.desk.deskd.courier.relay;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * An instance metadata service on 127.0.0.1 for a self-hosted staging test desk that runs for days (the Courier soak,
 * CR-4.1): it hands deskd's {@code RoleCredentials} the desk's session, and asks ma-platform for a new one
 * ({@code POST /v1/self-hosted/session}, signed with the desk's pairing key, contract {@code selfhost.md}) whenever the one
 * it holds has under {@link #RENEW_BEFORE} left. Sessions last 15 minutes. Never logs or prints a credential or the key.
 */
final class SessionImds implements AutoCloseable {

    static final Duration RENEW_BEFORE = Duration.ofMinutes(7);
    /** A fresh token per run (Security's DL-L5): the loopback port is still reachable by any local user who asks for one, as IMDS is. */
    private final String TOKEN = java.util.HexFormat.of().formatHex(new SecureRandom().generateSeed(16));
    private static final String FP = "cd".repeat(32);

    private final HttpServer server;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private final String apiBase;
    private final String env;
    private final String publicKey;
    private final PrivateKey privateKey;
    private final SecureRandom random = new SecureRandom();
    private Map<String, Object> held;
    private Instant heldUntil = Instant.EPOCH;
    private volatile String lastProblem;

    /**
     * @param publicKey the pairing key's raw Ed25519 public key, base64url (as the pairing sent it)
     * @param pkcs8 the pairing key's private half, PKCS#8 DER
     */
    SessionImds(String apiBase, String env, String publicKey, byte[] pkcs8) throws Exception {
        this.apiBase = apiBase;
        this.env = env;
        this.publicKey = publicKey;
        this.privateKey = KeyFactory.getInstance("Ed25519").generatePrivate(new PKCS8EncodedKeySpec(pkcs8));
        server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 8);
        server.createContext("/", this::answer);
        server.start();
    }

    String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    /** The last renewal problem (a status or exception name), or null. */
    String lastProblem() {
        return lastProblem;
    }

    private byte[] sign(String purpose, String at, String nonce, String extra) throws Exception {
        String msg = String.join("\n", List.of("ma-selfhost/v1", purpose, env, publicKey, at, nonce, extra));
        Signature s = Signature.getInstance("Ed25519");
        s.initSign(privateKey);
        s.update(msg.getBytes(StandardCharsets.UTF_8));
        return s.sign();
    }

    private static String b64u(byte[] b) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    /** A fresh session from the platform. */
    @SuppressWarnings("unchecked")
    private synchronized Map<String, Object> credentials() throws IOException {
        Instant now = Instant.now();
        if (held != null && now.plus(RENEW_BEFORE).isBefore(heldUntil)) {
            return held;
        }
        IOException last = null;
        for (int attempt = 0; attempt < 4; attempt++) {
            try {
                String at = Instant.now().truncatedTo(ChronoUnit.SECONDS).toString();
                byte[] n = new byte[16];
                random.nextBytes(n);
                String nonce = b64u(n);
                Map<String, Object> body = new LinkedHashMap<>();
                body.put("v", 1);
                body.put("publicKey", publicKey);
                body.put("at", at);
                body.put("nonce", nonce);
                body.put("sig", b64u(sign("session", at, nonce, "")));
                body.put("dtls", Map.of("fingerprintsSha256", List.of(FP), "sig", b64u(sign("dtls", at, nonce, FP))));
                HttpRequest req = HttpRequest.newBuilder(URI.create(apiBase + "/v1/self-hosted/session")).timeout(Duration.ofSeconds(20))
                        .header("content-type", "application/json").POST(HttpRequest.BodyPublishers.ofByteArray(Json.bytes(body))).build();
                HttpResponse<byte[]> r = http.send(req, HttpResponse.BodyHandlers.ofByteArray());
                if (r.statusCode() == 200) {
                    Map<String, Object> c = (Map<String, Object>) Json.parseObject(r.body()).get("credentials");
                    if (c != null && c.get("accessKeyId") instanceof String) {
                        held = c;
                        heldUntil = c.get("expiration") instanceof String e ? Instant.parse(e) : Instant.now().plus(Duration.ofMinutes(15));
                        lastProblem = null;
                        return held;
                    }
                }
                lastProblem = "session_http_" + r.statusCode();
                last = new IOException(lastProblem);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException("interrupted");
            } catch (Exception e) {
                lastProblem = e.getClass().getSimpleName();
                last = e instanceof IOException io ? io : new IOException(lastProblem);
            }
            try {
                Thread.sleep(2_000L << attempt);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException("interrupted");
            }
        }
        if (held != null && Instant.now().isBefore(heldUntil)) {
            return held;
        }
        throw last;
    }

    private void answer(HttpExchange x) throws IOException {
        String path = x.getRequestURI().getPath();
        String body;
        int status = 200;
        if (path.equals("/latest/api/token")) {
            body = TOKEN;
        } else if (!TOKEN.equals(x.getRequestHeaders().getFirst("X-aws-ec2-metadata-token"))) {
            status = 401;
            body = "";
        } else if (path.equals("/latest/meta-data/iam/security-credentials/")) {
            body = "soak";
        } else if (path.equals("/latest/meta-data/iam/security-credentials/soak")) {
            try {
                Map<String, Object> c0 = credentials();
                Map<String, Object> c = new LinkedHashMap<>();
                c.put("Code", "Success");
                c.put("AccessKeyId", c0.get("accessKeyId"));
                c.put("SecretAccessKey", c0.get("secretAccessKey"));
                c.put("Token", c0.get("sessionToken"));
                c.put("Expiration", c0.get("expiration") instanceof String e ? e : Instant.now().plus(Duration.ofMinutes(15)).toString());
                body = new String(Json.bytes(c), StandardCharsets.UTF_8);
            } catch (IOException e) {
                status = 503;
                body = "";
            }
        } else {
            status = 404;
            body = "";
        }
        byte[] out = body.getBytes(StandardCharsets.UTF_8);
        x.sendResponseHeaders(status, out.length == 0 ? -1 : out.length);
        try (OutputStream o = x.getResponseBody()) {
            o.write(out);
        }
    }

    @Override
    public void close() {
        server.stop(0);
    }
}
