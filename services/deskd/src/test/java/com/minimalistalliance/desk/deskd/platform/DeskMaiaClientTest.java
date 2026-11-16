package com.minimalistalliance.desk.deskd.platform;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.minimalistalliance.desk.deskd.aws.AwsCredentials;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

/**
 * deskd's client of Desk Maia's service against a stand-in on loopback (ma-platform desk-maia.md): the route, a fresh proof
 * each call signing the audience and the exact body's hash, the 200 and the error envelope as given, one refresh and retry on
 * {@code 401 desk_auth}, deskd's own {@code unavailable} reasons, the answer's size cap, and nothing of a call in the logs.
 */
class DeskMaiaClientTest {

    private static final String MAIA_ID = "maia.staging.minimalistalliance.com";
    private static final String SECRET = "the member's words that must never be logged";

    /** One request as the stand-in got it. */
    record Got(String path, String proof, String contentType, byte[] body) {
        Map<String, Object> proofJson() throws Exception {
            return Json.parseObject(Base64.getUrlDecoder().decode(proof));
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> proofHeaders() throws Exception {
            return (Map<String, Object>) proofJson().get("headers");
        }
    }

    /** What the stand-in answers: a status and a body. */
    record Reply(int status, String body) {}

    private HttpServer server;
    private PlatformHttp http;
    private final ConcurrentLinkedQueue<Got> got = new ConcurrentLinkedQueue<>();
    private final AtomicReference<Function<Got, Reply>> script = new AtomicReference<>();
    private final AtomicInteger fetches = new AtomicInteger();
    private final AtomicInteger invalidations = new AtomicInteger();
    private volatile long stallMillis;

    private final DeskMaiaClient.RoleKeys keys = new DeskMaiaClient.RoleKeys() {
        @Override
        public AwsCredentials current() {
            int n = fetches.incrementAndGet();
            return new AwsCredentials("ASIAEXAMPLE" + n, "secret-key-that-must-not-be-logged", "token-" + n,
                    Instant.now().plus(Duration.ofHours(1)));
        }

        @Override
        public void invalidate() {
            invalidations.incrementAndGet();
        }
    };

    @BeforeEach
    void setUp() throws Exception {
        server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.createContext("/", this::answer);
        server.setExecutor(java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor());
        server.start();
        http = new PlatformHttp();
    }

    @AfterEach
    void tearDown() {
        http.close();
        server.stop(0);
    }

    private void answer(HttpExchange exchange) throws IOException {
        Got g = new Got(exchange.getRequestURI().getPath(), exchange.getRequestHeaders().getFirst("x-ma-desk-auth"),
                exchange.getRequestHeaders().getFirst("content-type"), exchange.getRequestBody().readAllBytes());
        got.add(g);
        if (stallMillis > 0) {
            try {
                Thread.sleep(stallMillis);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        Function<Got, Reply> step = script.get();
        Reply reply = step == null ? new Reply(200, "{\"v\":1,\"text\":\"Hello.\"}") : step.apply(g);
        byte[] body = reply.body().getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("content-type", "application/json");
        exchange.sendResponseHeaders(reply.status(), body.length == 0 ? -1 : body.length);
        if (body.length > 0) {
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        }
        exchange.close();
    }

    private DeskMaiaClient client() {
        return client(Duration.ofSeconds(10));
    }

    private DeskMaiaClient client(Duration timeout) {
        String url = "http://127.0.0.1:" + server.getAddress().getPort();
        return new DeskMaiaClient(http, keys, () -> new DeskMaiaClient.Endpoint(url, MAIA_ID), Clock.systemUTC(), timeout);
    }

    private static byte[] body(String text) {
        return ("{\"v\":1,\"task\":\"turn\",\"messages\":[{\"role\":\"user\",\"text\":\"" + text + "\"}]}")
                .getBytes(StandardCharsets.UTF_8);
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    @Test
    void aCallGoesToTheRouteWithAFreshProofOverItsAudienceAndItsExactBody() throws Exception {
        script.set(g -> new Reply(200, "{\"v\":1,\"text\":\"I asked your Work desk.\",\"stopReason\":\"end_turn\","
                + "\"usage\":{\"inputTokens\":10,\"outputTokens\":5},\"costMicroUsd\":2100,"
                + "\"allowance\":{\"fraction\":0.62,\"resetsAt\":\"2026-11-15T07:00:00.000Z\"}}"));
        byte[] sent = body("Compare three laptops");
        DeskMaiaClient.Answer answer = client().call(sent);
        assertThat(answer.ok()).isTrue();
        assertThat(answer.body()).containsEntry("text", "I asked your Work desk.");
        assertThat(((Number) answer.body().get("costMicroUsd")).longValue()).isEqualTo(2100L);
        Got first = got.poll();
        assertThat(first.path()).isEqualTo("/v1/desk-maia/call");
        assertThat(first.contentType()).isEqualTo("application/json");
        assertThat(first.body()).isEqualTo(sent);
        Map<String, Object> headers = first.proofHeaders();
        assertThat(headers).containsEntry("x-ma-maia-id", MAIA_ID).containsEntry("x-ma-body-sha256", sha256(sent))
                .containsEntry("x-amz-security-token", "token-1").doesNotContainKey("x-ma-gateway-id");
        assertThat(first.proofJson()).containsEntry("url", "https://sts.us-east-1.amazonaws.com/");

        // The next call has its own proof: the hash of its own body, and a new signature.
        byte[] next = body("And the fourth one");
        client().call(next);
        Got second = got.poll();
        assertThat(second.proofHeaders()).containsEntry("x-ma-body-sha256", sha256(next));
        assertThat(second.proof()).isNotEqualTo(first.proof());
    }

    @Test
    void refusalsComeBackAsTheirCodeAndDetails() throws Exception {
        script.set(g -> new Reply(429, "{\"error\":{\"code\":\"limit\",\"message\":\"Used up.\",\"retryable\":false,"
                + "\"details\":{\"reason\":\"limit_personal\",\"resetsAt\":\"2026-11-15T07:00:00.000Z\",\"window\":\"day\"}}}"));
        DeskMaiaClient.Answer limit = client().call(body("hi"));
        assertThat(limit.ok()).isFalse();
        assertThat(limit.status()).isEqualTo(429);
        assertThat(limit.code()).isEqualTo("limit");
        assertThat(limit.details()).containsEntry("reason", "limit_personal").containsEntry("window", "day")
                .containsEntry("resetsAt", "2026-11-15T07:00:00.000Z");
        for (Object[] c : new Object[][] {{503, "unavailable", "off"}, {413, "too_large", "input"},
                {400, "bad_request", "task"}, {403, "forbidden", "not_listed"}, {410, "desk_destroyed", null}}) {
            script.set(g -> new Reply((Integer) c[0], "{\"error\":{\"code\":\"" + c[1] + "\""
                    + (c[2] == null ? "" : ",\"details\":{\"reason\":\"" + c[2] + "\"}") + "}}"));
            DeskMaiaClient.Answer a = client().call(body("hi"));
            assertThat(a.code()).as(String.valueOf(c[1])).isEqualTo(c[1]);
            if (c[2] != null) {
                assertThat(a.details()).containsEntry("reason", c[2]);
            }
        }
        // No envelope: a Function URL's own refusal or a 5xx. deskd can't say more.
        script.set(g -> new Reply(502, "Bad Gateway"));
        assertThat(client().call(body("hi")).details()).containsEntry("reason", "unreachable");
        script.set(g -> new Reply(403, "{\"Message\":\"Forbidden\"}"));
        assertThat(client().call(body("hi")).code()).isEqualTo("unavailable");
        script.set(g -> new Reply(200, "not json"));
        assertThat(client().call(body("hi")).details()).containsEntry("reason", "response");
    }

    @Test
    void aDeskAuthRefusalFetchesTheRoleAgainAndTriesOnce() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        script.set(g -> calls.incrementAndGet() == 1
                ? new Reply(401, "{\"error\":{\"code\":\"unauthenticated\",\"details\":{\"reason\":\"desk_auth\"}}}")
                : new Reply(200, "{\"v\":1,\"text\":\"ok\"}"));
        DeskMaiaClient.Answer answer = client().call(body("hi"));
        assertThat(answer.ok()).isTrue();
        assertThat(invalidations.get()).isEqualTo(1);
        assertThat(got).hasSize(2);
        List<Got> both = List.copyOf(got);
        assertThat(both.get(1).proofHeaders()).containsEntry("x-amz-security-token", "token-2");
        assertThat(both.get(1).proof()).isNotEqualTo(both.get(0).proof());

        // Refused again: once only, and the refusal comes back.
        got.clear();
        script.set(g -> new Reply(401, "{\"error\":{\"code\":\"unauthenticated\",\"details\":{\"reason\":\"desk_auth\"}}}"));
        DeskMaiaClient.Answer twice = client().call(body("hi"));
        assertThat(twice.code()).isEqualTo("unauthenticated");
        assertThat(got).hasSize(2);
        // Another 401 isn't retried.
        got.clear();
        script.set(g -> new Reply(401, "{\"error\":{\"code\":\"unauthenticated\"}}"));
        client().call(body("hi"));
        assertThat(got).hasSize(1);
    }

    @Test
    void noServiceNoAnswerInTimeAndAnAnswerTooBigAreUnavailable() throws Exception {
        DeskMaiaClient none = new DeskMaiaClient(http, keys, () -> null, Clock.systemUTC());
        assertThat(none.configured()).isFalse();
        assertThat(none.call(body("hi")).details()).containsEntry("reason", "no_service");
        assertThat(got).isEmpty();
        assertThat(client().configured()).isTrue();

        stallMillis = 1_500;
        DeskMaiaClient.Answer late = client(Duration.ofMillis(300)).call(body("hi"));
        assertThat(late.code()).isEqualTo("unavailable");
        assertThat(late.details()).containsEntry("reason", "timeout");
        stallMillis = 0;

        String big = "{\"v\":1,\"text\":\"" + "x".repeat(DeskMaiaClient.MAX_RESPONSE_BYTES) + "\"}";
        script.set(g -> new Reply(200, big));
        assertThat(client().call(body("hi")).details()).containsEntry("reason", "response");

        DeskMaiaClient closed = new DeskMaiaClient(http, keys,
                () -> new DeskMaiaClient.Endpoint("http://127.0.0.1:1", MAIA_ID), Clock.systemUTC());
        assertThat(closed.call(body("hi")).details()).containsEntry("reason", "unreachable");
        assertThat(DeskMaiaClient.TIMEOUT).isEqualTo(Duration.ofSeconds(150));
    }

    @Test
    void nothingOfACallIsLogged() throws Exception {
        Logger root = (Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        Level was = root.getLevel();
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        root.addAppender(logs);
        root.setLevel(Level.TRACE);
        try {
            script.set(g -> new Reply(200, "{\"v\":1,\"text\":\"" + SECRET + "\"}"));
            client().call(body(SECRET));
            script.set(g -> new Reply(429, "{\"error\":{\"code\":\"limit\",\"message\":\"" + SECRET + "\"}}"));
            client().call(body(SECRET));
            script.set(g -> new Reply(502, SECRET));
            client().call(body(SECRET));
            stallMillis = 800;
            client(Duration.ofMillis(200)).call(body(SECRET));
            stallMillis = 0;
        } finally {
            root.detachAppender(logs);
            root.setLevel(was);
        }
        String all = logs.list.stream().map(e -> e.getFormattedMessage() + " " + (e.getThrowableProxy() == null ? ""
                : e.getThrowableProxy().getMessage())).reduce("", String::concat);
        assertThat(all).doesNotContain(SECRET).doesNotContain("secret-key-that-must-not-be-logged")
                .doesNotContain("token-").doesNotContain("x-ma-desk-auth").doesNotContain("AWS4-HMAC");
        assertThat(all).contains("desk maia");
    }
}
