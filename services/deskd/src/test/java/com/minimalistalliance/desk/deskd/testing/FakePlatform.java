package com.minimalistalliance.desk.deskd.testing;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * IMDS, the API and JWKS on one real HTTP port, answering as agent.md and desk-endpoint.md say.
 * Anything a test doesn't script gets a good default, with an unknown field or two, since deskd must
 * ignore those. It records what deskd sends.
 */
public final class FakePlatform implements AutoCloseable {

    public static final String INSTANCE_ID = "i-0a1b2c3d4e5f60789";
    public static final String ACCESS_KEY = "ASIAVEXAMPLE7Q2M";
    public static final String SECRET_KEY = "secret-key-that-must-not-be-logged";
    public static final String SESSION_TOKEN = "session-token-that-must-not-be-logged";
    public static final String MODEL_PRICES = "/v1/public/model-prices";
    private static final String IMDS_TOKEN = "imds-token-1";
    private static final String CHUNKED = "x-fake-chunked";

    public record Reply(int status, String body, Map<String, String> headers) {
        /** Headers and 2 of the 10 body bytes they promise, then silence, as on a path that died mid-response. */
        public static final Reply STALLED = new Reply(200, "stalled", Map.of());

        public static Reply of(int status, String body) {
            return new Reply(status, body, Map.of());
        }

        public static Reply of(int status, String body, String etag) {
            return new Reply(status, body, Map.of("ETag", etag));
        }

        /** With no content-length, so the size isn't known until it's been read. */
        public static Reply chunked(int status, String body) {
            return new Reply(status, body, Map.of(CHUNKED, "1"));
        }
    }

    public record Request(String method, String path, Map<String, String> headers, byte[] body) {
        public String header(String name) {
            return headers.get(name.toLowerCase(Locale.ROOT));
        }

        public Map<String, Object> json() {
            try {
                return Json.parseObject(body);
            } catch (JsonFormatException e) {
                throw new IllegalStateException(e);
            }
        }
    }

    public final TestTokens tokens = new TestTokens();
    /** Everything deskd sent to the API, in order. */
    public final List<Request> apiRequests = new CopyOnWriteArrayList<>();
    /** In order, with what other fakes add: imds, configure, hello, config, ready, heartbeat. */
    public final List<String> timeline = new CopyOnWriteArrayList<>();
    private final Map<String, List<Long>> arrivals = new ConcurrentHashMap<>();
    public final Map<String, String> metadata = new ConcurrentHashMap<>();
    public final Queue<Reply> helloReplies = new ConcurrentLinkedQueue<>();
    public final Queue<Reply> heartbeatReplies = new ConcurrentLinkedQueue<>();
    public final Queue<Reply> configReplies = new ConcurrentLinkedQueue<>();
    /** What the next fetches of the price table get, and then a 404, as a Platform without one answers. */
    public final Queue<Reply> modelPricesReplies = new ConcurrentLinkedQueue<>();
    public final AtomicInteger imdsTokenPuts = new AtomicInteger();
    public final AtomicInteger imdsFailuresLeft = new AtomicInteger();
    public final AtomicInteger credentialFetches = new AtomicInteger();
    public final AtomicInteger jwksFetches = new AtomicInteger();
    public final AtomicInteger jwksStallsLeft = new AtomicInteger();
    public volatile boolean imdsSlow;
    public volatile boolean imdsStalled;
    public volatile boolean jwksUp = true;
    public volatile long jwksDelayMillis;
    public volatile Map<String, Object> jwksBody;
    public volatile Instant credentialsExpire = Instant.now().plusSeconds(6 * 3600);
    public volatile String gatewayUrl = "ws://127.0.0.1:1/v1";
    public volatile boolean helloCarriesConfig = true;
    public volatile long configVersion = 12;
    /** What heartbeat responses ask for; null leaves the field out and the loop to its own period. */
    public volatile Integer nextHeartbeatSeconds = 60;
    /** The {@code streaming} object heartbeat replies and the config carry (bandwidth.md), or none while null. */
    public volatile Map<String, Object> streaming;
    /** The {@code agentDefaults} the config carries, or none while null. */
    public volatile Map<String, Object> agentDefaults;
    /** {@code ageBand} on the config (age.md, section 8), which can be anything, a null included. {@link #NO_AGE_BAND} leaves it out. */
    public volatile Object ageBand = "adult";
    /** Hello's copy of the config leaves {@code ageBand} out, while the GET goes by {@link #ageBand}. */
    public volatile boolean helloOmitsAgeBand;
    public static final Object NO_AGE_BAND = new Object();
    /** {@code tierLimits} on the config (agent.md, ADR 0090), which can be anything, a null included. {@link #NO_TIER_LIMITS} leaves it out. */
    public volatile Object tierLimits = NO_TIER_LIMITS;
    public static final Object NO_TIER_LIMITS = new Object();
    /** Hello's copy of the config says this {@code configVersion} instead, as a Platform that couldn't finish it says 0. */
    public volatile Long helloConfigVersion;

    private final Map<String, BlockingQueue<Request>> apiQueues = new ConcurrentHashMap<>();
    private final HttpServer server;
    private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();

    public FakePlatform() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 32);
        server.setExecutor(executor);
        server.createContext("/", this::handle);
        server.start();
        jwksBody = tokens.jwks();
        metadata.put("/latest/meta-data/tags/instance/DeskId", TestTokens.DESK_ID);
        metadata.put("/latest/meta-data/tags/instance/UserId", TestTokens.OWNER_ID);
        metadata.put("/latest/meta-data/tags/instance/DeskKind", "test");
        metadata.put("/latest/meta-data/tags/instance/Env", "staging");
        metadata.put("/latest/meta-data/instance-id", INSTANCE_ID);
        metadata.put("/latest/meta-data/public-ipv4", "203.0.113.7");
        metadata.put("/latest/meta-data/instance-type", "c7g.large");
        metadata.put("/latest/meta-data/ami-id", "ami-0123456789abcdef0");
        metadata.put("/latest/meta-data/iam/security-credentials/", "ma-desk-d-testdesk0001\n");
    }

    public String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    /** The next request to this path that no earlier call has taken. */
    public Request awaitApi(String path) throws InterruptedException {
        Request request = queueFor(path).poll(FakeDeskRtc.TIMEOUT_SECONDS, TimeUnit.SECONDS);
        if (request == null) {
            throw new AssertionError("no API request to " + path);
        }
        return request;
    }

    private BlockingQueue<Request> queueFor(String path) {
        return apiQueues.computeIfAbsent(path, key -> new LinkedBlockingQueue<>());
    }

    /** The body of the next hello. */
    public Map<String, Object> awaitHello() throws InterruptedException {
        return awaitApi("/v1/agent/hello").json();
    }

    /** {@link System#nanoTime} as each request to this path came in, oldest first. */
    public List<Long> arrivals(String path) {
        return List.copyOf(arrivals.getOrDefault(path, List.of()));
    }

    public long countApi(String path) {
        return apiRequests.stream().filter(request -> path.equals(request.path())).count();
    }

    @Override
    public void close() {
        server.stop(0);
        executor.shutdownNow();
    }

    private void handle(HttpExchange exchange) throws IOException {
        try (exchange) {
            String path = exchange.getRequestURI().getPath();
            if (path.startsWith("/latest/")) {
                imds(exchange, path);
            } else if (path.equals("/.well-known/jwks.json")) {
                jwks(exchange);
            } else {
                api(exchange, path);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private void imds(HttpExchange exchange, String path) throws IOException, InterruptedException {
        exchange.getRequestBody().readAllBytes();
        if (imdsSlow) {
            Thread.sleep(3000);
        }
        if (imdsStalled) {
            reply(exchange, Reply.STALLED);
            return;
        }
        if (imdsFailuresLeft.get() > 0 && imdsFailuresLeft.getAndDecrement() > 0) {
            reply(exchange, Reply.of(500, "broken"));
            return;
        }
        if (path.equals("/latest/api/token")) {
            imdsTokenPuts.incrementAndGet();
            boolean good = "PUT".equals(exchange.getRequestMethod())
                    && "21600".equals(exchange.getRequestHeaders().getFirst("X-aws-ec2-metadata-token-ttl-seconds"));
            reply(exchange, good ? Reply.of(200, IMDS_TOKEN) : Reply.of(400, ""));
            return;
        }
        if (!IMDS_TOKEN.equals(exchange.getRequestHeaders().getFirst("X-aws-ec2-metadata-token"))) {
            reply(exchange, Reply.of(401, ""));
            return;
        }
        timeline.add("imds");
        if (path.startsWith("/latest/meta-data/iam/security-credentials/") && !metadata.containsKey(path)) {
            credentialFetches.incrementAndGet();
            Map<String, Object> credentials = new LinkedHashMap<>();
            credentials.put("Code", "Success");
            credentials.put("AccessKeyId", ACCESS_KEY);
            credentials.put("SecretAccessKey", SECRET_KEY);
            credentials.put("Token", SESSION_TOKEN);
            credentials.put("Expiration", credentialsExpire.toString());
            reply(exchange, Reply.of(200, new String(Json.bytes(credentials), StandardCharsets.UTF_8)));
            return;
        }
        String value = metadata.get(path);
        reply(exchange, value == null ? Reply.of(404, "") : Reply.of(200, value));
    }

    private void jwks(HttpExchange exchange) throws IOException, InterruptedException {
        jwksFetches.incrementAndGet();
        if (jwksDelayMillis > 0) {
            Thread.sleep(jwksDelayMillis);
        }
        if (jwksStallsLeft.getAndUpdate(left -> Math.max(0, left - 1)) > 0) {
            reply(exchange, Reply.STALLED);
            return;
        }
        reply(exchange, jwksUp ? Reply.of(200, new String(Json.bytes(jwksBody), StandardCharsets.UTF_8)) : Reply.of(503, ""));
    }

    private void api(HttpExchange exchange, String path) throws IOException {
        arrivals.computeIfAbsent(path, key -> new CopyOnWriteArrayList<>()).add(System.nanoTime());
        byte[] body = exchange.getRequestBody().readAllBytes();
        Map<String, String> headers = new LinkedHashMap<>();
        exchange.getRequestHeaders().forEach((name, values) -> headers.put(name.toLowerCase(Locale.ROOT), values.get(0)));
        Request request = new Request(exchange.getRequestMethod(), path, headers, body);
        // The reply is chosen before the request is seen, so a reply a test queues once it has seen this one is for the
        // next. The other way round, it could land on this one.
        Reply chosen = switch (path) {
            case "/v1/agent/hello" -> {
                timeline.add("hello");
                Reply scripted = helloReplies.poll();
                yield scripted != null ? scripted : Reply.of(200, helloReply());
            }
            case "/v1/agent/heartbeat" -> {
                timeline.add("heartbeat");
                Reply scripted = heartbeatReplies.poll();
                yield scripted != null ? scripted : Reply.of(200, heartbeatReply(List.of()));
            }
            case "/v1/agent/config" -> {
                timeline.add("config");
                Reply scripted = configReplies.poll();
                yield scripted != null ? scripted : Reply.of(200, new String(Json.bytes(config()), StandardCharsets.UTF_8));
            }
            case MODEL_PRICES -> {
                Reply scripted = modelPricesReplies.poll();
                yield scripted != null ? scripted : Reply.of(404, "{\"message\":\"Not Found\"}");
            }
            default -> Reply.of(404, "{\"error\":{\"code\":\"not_found\",\"message\":\"no\"}}");
        };
        apiRequests.add(request);
        queueFor(path).add(request);
        reply(exchange, chosen);
    }

    private String helloReply() {
        Map<String, Object> reply = new LinkedHashMap<>();
        reply.put("deskId", TestTokens.DESK_ID);
        reply.put("state", "running");
        reply.put("heartbeatSeconds", 60);
        reply.put("aFieldFromTheFuture", Map.of("x", 1));
        if (helloCarriesConfig) {
            Map<String, Object> config = config();
            if (helloOmitsAgeBand) {
                config.remove("ageBand");
            }
            if (helloConfigVersion != null) {
                config.put("configVersion", helloConfigVersion);
            }
            reply.put("config", config);
        }
        return new String(Json.bytes(reply), StandardCharsets.UTF_8);
    }

    /** A heartbeat response as agent.md shows it, with these actions. */
    public String heartbeatReply(List<String> actions) {
        return heartbeatReply(actions, List.of(), null);
    }

    public String heartbeatReply(List<String> actions, List<String> revokedSessions, String tokensValidAfter) {
        Map<String, Object> reply = new LinkedHashMap<>();
        reply.put("state", "running");
        if (nextHeartbeatSeconds != null) {
            reply.put("nextHeartbeatSeconds", nextHeartbeatSeconds);
        }
        reply.put("activity", Map.of("lastActiveAt", "2026-11-04T21:00:00Z"));
        reply.put("configVersion", configVersion);
        reply.put("keysVersion", 7);
        reply.put("revokedSessions", revokedSessions);
        reply.put("tokensValidAfter", tokensValidAfter);
        reply.put("actions", actions);
        if (streaming != null) {
            reply.put("streaming", streaming);
        }
        reply.put("aFieldFromTheFuture", 1);
        return new String(Json.bytes(reply), StandardCharsets.UTF_8);
    }

    private Map<String, Object> config() {
        Map<String, Object> endpoints = new LinkedHashMap<>();
        endpoints.put("api", url());
        endpoints.put("issuer", TestTokens.ISSUER);
        endpoints.put("jwks", url() + "/.well-known/jwks.json");
        endpoints.put("gateway", gatewayUrl);
        endpoints.put("gatewayId", "gw.test.invalid");
        Map<String, Object> config = new LinkedHashMap<>();
        config.put("configVersion", configVersion);
        config.put("endpoints", endpoints);
        if (streaming != null) {
            config.put("streaming", streaming);
        }
        if (agentDefaults != null) {
            config.put("agentDefaults", agentDefaults);
        }
        if (ageBand != NO_AGE_BAND) {
            config.put("ageBand", ageBand);
        }
        if (tierLimits != NO_TIER_LIMITS) {
            config.put("tierLimits", tierLimits);
        }
        config.put("aFieldFromTheFuture", 1);
        return config;
    }

    private static void reply(HttpExchange exchange, Reply reply) throws IOException {
        if (reply == Reply.STALLED) {
            stall(exchange);
            return;
        }
        reply.headers().forEach((name, value) -> exchange.getResponseHeaders().add(name, value));
        byte[] bytes = reply.body().getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(reply.status(), reply.headers().containsKey(CHUNKED) ? 0 : bytes.length == 0 ? -1 : bytes.length);
        if (bytes.length > 0) {
            exchange.getResponseBody().write(bytes);
        }
    }

    private static void stall(HttpExchange exchange) throws IOException {
        exchange.sendResponseHeaders(200, 10);
        exchange.getResponseBody().write(new byte[] {'{', '"'});
        exchange.getResponseBody().flush();
        try {
            Thread.sleep(60_000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
