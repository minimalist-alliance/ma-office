package com.minimalistalliance.desk.deskd.platform;

import com.minimalistalliance.desk.deskd.aws.AwsCredentials;
import com.minimalistalliance.desk.deskd.aws.RoleCredentials;
import com.minimalistalliance.desk.deskd.gateway.DeskAuth;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Flow;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * deskd's client of Desk Maia's service on Minimalist Alliance's AI account (ma-platform {@code docs/contracts/desk-maia.md},
 * contract 0.4.4; the owner, Nov 14: "Maia ALWAYS runs on the company account"): {@code POST {endpoints.maia}/v1/desk-maia/call}
 * with a fresh {@code X-MA-Desk-Auth} each call, signed by the desk role ({@link DeskAuth#forMaia}) over the config's
 * {@code maiaId} and the exact body's SHA-256. On a {@code 401 desk_auth} the role's credentials are fetched again and the call
 * is made once more with a new proof.
 *
 * <p>deskd only relays: the body is desk-agent's request with {@code "v": 1} first, and the answer is the Platform's, a 200's
 * body or its error envelope's {@code code} and {@code details}. What deskd can't get an answer for is {@code unavailable}
 * with its own reason: {@code no_service} (no endpoint configured), {@code unreachable} (no connection or no envelope),
 * {@code timeout} (no whole answer in 150 s: the call may have been made) or {@code response} (an answer deskd won't read).
 *
 * <p><b>Never logged:</b> the body, the text, a tool's input, the answer or the proof. A log line says an outcome word and
 * sizes at most.
 */
public final class DeskMaiaClient {

    private static final Logger log = LoggerFactory.getLogger(DeskMaiaClient.class);

    public static final String ROUTE = "/v1/desk-maia/call";
    /** A helper's model call on Minimalist Alliance's provider (ma-platform {@code desk-helpers.md}). */
    public static final String HELPERS_CALL = "/v1/desk-helpers/call";
    /** The member's credits for helpers on Minimalist Alliance's provider, and their starting grant the first time. */
    public static final String HELPERS_CREDITS = "/v1/desk-helpers/credits";
    /** The whole answer within this (a model's turn at the Platform's caps fits well inside it). */
    public static final Duration TIMEOUT = Duration.ofSeconds(150);
    /** The most of an answer deskd reads: a turn's text and calls at 16,000 tokens are far under it. */
    static final int MAX_RESPONSE_BYTES = 2 << 20;

    /** The desk role's credentials: {@link RoleCredentials} on a desk, a fixed pair in tests. */
    public interface RoleKeys {
        AwsCredentials current() throws IOException, InterruptedException;

        /** The service refused them: the next {@link #current} fetches new ones. */
        void invalidate();

        static RoleKeys of(RoleCredentials credentials) {
            return new RoleKeys() {
                @Override
                public AwsCredentials current() throws IOException, InterruptedException {
                    return credentials.current();
                }

                @Override
                public void invalidate() {
                    credentials.invalidate();
                }
            };
        }
    }

    /** Where the service is and what to sign as its audience: {@code endpoints.maia} and {@code endpoints.maiaId}. */
    public record Endpoint(String url, String maiaId) {
        /** From the config, or null where the service isn't configured. */
        public static Endpoint of(PlatformConfig config) {
            return config == null || !config.maiaService() ? null : new Endpoint(config.maiaUrl(), config.maiaId());
        }
    }

    /**
     * What came back. {@code ok}: the 200's body. Otherwise {@code code} (the Platform's {@code error.code}, or deskd's own
     * {@code unavailable}) and {@code details} as given.
     */
    public record Answer(boolean ok, int status, Map<String, Object> body, String code, Map<String, Object> details) {
        public Answer {
            body = body == null ? Map.of() : body;
            details = details == null ? Map.of() : details;
        }

        static Answer ok(Map<String, Object> body) {
            return new Answer(true, 200, body, null, null);
        }

        static Answer refused(int status, String code, Map<String, Object> details) {
            return new Answer(false, status, null, code, details);
        }

        /** deskd's own: no answer it can use. */
        public static Answer unavailable(String reason) {
            return new Answer(false, 0, null, "unavailable", Map.of("reason", reason));
        }

        /** No content: the outcome and a size only. */
        @Override
        public String toString() {
            return "Answer[" + (ok ? "ok" : code) + ", " + status + "]";
        }
    }

    private final PlatformHttp http;
    private final RoleKeys keys;
    private final Supplier<Endpoint> endpoint;
    private final Clock clock;
    private final Duration timeout;

    /** @param endpoint the service as the config says now, or null while it isn't configured */
    public DeskMaiaClient(PlatformHttp http, RoleKeys keys, Supplier<Endpoint> endpoint, Clock clock) {
        this(http, keys, endpoint, clock, TIMEOUT);
    }

    DeskMaiaClient(PlatformHttp http, RoleKeys keys, Supplier<Endpoint> endpoint, Clock clock, Duration timeout) {
        this.http = http;
        this.keys = keys;
        this.endpoint = endpoint;
        this.clock = clock;
        this.timeout = timeout;
    }

    /** Whether the service is configured here now. */
    public boolean configured() {
        return endpoint.get() != null;
    }

    /**
     * One call with these exact body bytes. Never throws for the Platform's answer: a refusal is an {@link Answer} too.
     *
     * @throws InterruptedException if the caller's thread is interrupted, which cancels the call
     */
    public Answer call(byte[] body) throws InterruptedException {
        return call(ROUTE, body);
    }

    /**
     * One call to another route of the same service, with the same proof (ma-platform {@code desk-helpers.md}: helpers on
     * Minimalist Alliance's provider share Desk Maia's URL and audience): {@link #HELPERS_CALL} or {@link #HELPERS_CREDITS}.
     *
     * @throws InterruptedException if the caller's thread is interrupted, which cancels the call
     */
    public Answer call(String route, byte[] body) throws InterruptedException {
        if (!ROUTE.equals(route) && !HELPERS_CALL.equals(route) && !HELPERS_CREDITS.equals(route)) {
            throw new IllegalArgumentException("not a route of this service");
        }
        Endpoint at = endpoint.get();
        if (at == null) {
            return Answer.unavailable("no_service");
        }
        String hash = HexFormat.of().formatHex(sha256(body));
        URI uri;
        try {
            uri = URI.create(at.url() + route);
        } catch (IllegalArgumentException e) {
            return Answer.unavailable("no_service");
        }
        try {
            HttpResponse<byte[]> response = send(uri, at.maiaId(), hash, body);
            if (response.statusCode() == 401 && "desk_auth".equals(reasonOf(response.body()))) {
                // The role's credentials changed under us (or the proof's clock was off): fetch them again, once.
                keys.invalidate();
                response = send(uri, at.maiaId(), hash, body);
            }
            Answer answer = read(response);
            log.debug("desk maia: {} ({} bytes sent, {} back)", answer.ok() ? "ok" : answer.code(), body.length,
                    response.body().length);
            return answer;
        } catch (HttpTimeoutException e) {
            log.warn("desk maia: no whole answer in time ({} bytes sent)", body.length);
            return Answer.unavailable("timeout");
        } catch (TooLarge e) {
            log.warn("desk maia: the answer was over {} bytes", MAX_RESPONSE_BYTES);
            return Answer.unavailable("response");
        } catch (IOException e) {
            log.warn("desk maia: unreachable ({})", e.getClass().getSimpleName());
            return Answer.unavailable("unreachable");
        }
    }

    private HttpResponse<byte[]> send(URI uri, String maiaId, String hash, byte[] body)
            throws IOException, InterruptedException {
        AwsCredentials role = keys.current();
        String proof = DeskAuth.forMaia(role, maiaId, hash, clock.instant());
        HttpRequest request = HttpRequest.newBuilder(uri)
                .timeout(timeout)
                .header("content-type", "application/json")
                .header("x-ma-desk-auth", proof)
                .POST(HttpRequest.BodyPublishers.ofByteArray(body))
                .build();
        try {
            return http.send(request, info -> new BoundedBody(
                    info.headers().firstValueAsLong("content-length").orElse(0) > MAX_RESPONSE_BYTES), timeout);
        } catch (IOException e) {
            if (e instanceof TooLarge || e.getCause() instanceof TooLarge) {
                throw new TooLarge();
            }
            throw e;
        }
    }

    /** A 200's JSON object, or the error envelope's code and details; no envelope is {@code unavailable}. */
    private static Answer read(HttpResponse<byte[]> response) {
        int status = response.statusCode();
        Map<String, Object> json;
        try {
            json = response.body().length == 0 ? null : Json.parseObject(response.body());
        } catch (JsonFormatException | RuntimeException e) {
            json = null;
        }
        if (status == 200) {
            return json == null ? Answer.unavailable("response") : Answer.ok(json);
        }
        Map<String, Object> error = json == null ? null : Json.object(json, "error");
        String code = error == null ? null : Json.string(error, "code");
        if (code == null || !code.matches("[a-z_]{1,32}")) {
            // A Function URL's own refusal or a 5xx with no envelope: deskd can't say more.
            return Answer.unavailable(status == 429 ? "busy" : "unreachable");
        }
        Map<String, Object> details = error.get("details") instanceof Map<?, ?> ? Json.object(error, "details") : Map.of();
        return Answer.refused(status, code, new LinkedHashMap<>(details));
    }

    /** {@code details.reason} of an error envelope, or null. */
    private static String reasonOf(byte[] body) {
        try {
            Map<String, Object> error = Json.object(Json.parseObject(body), "error");
            Map<String, Object> details = error == null || !(error.get("details") instanceof Map<?, ?>) ? null
                    : Json.object(error, "details");
            return details == null ? null : Json.string(details, "reason");
        } catch (JsonFormatException | RuntimeException e) {
            return null;
        }
    }

    static byte[] sha256(byte[] body) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(body);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** The answer was over {@link #MAX_RESPONSE_BYTES}. */
    private static final class TooLarge extends IOException {
        private static final long serialVersionUID = 1L;

        TooLarge() {
            super("the answer is over the limit", null);
        }
    }

    /** Fails as soon as it's over the limit, which ends the exchange and its connection. */
    private static final class BoundedBody implements HttpResponse.BodySubscriber<byte[]> {
        private final CompletableFuture<byte[]> result = new CompletableFuture<>();
        private final boolean tooBig;
        private byte[] bytes = new byte[8192];
        private int length;
        private Flow.Subscription subscription;

        BoundedBody(boolean tooBig) {
            this.tooBig = tooBig;
        }

        @Override
        public CompletionStage<byte[]> getBody() {
            return result;
        }

        @Override
        public void onSubscribe(Flow.Subscription newSubscription) {
            subscription = newSubscription;
            if (tooBig) {
                overLimit();
                return;
            }
            subscription.request(1);
        }

        @Override
        public void onNext(List<ByteBuffer> buffers) {
            for (ByteBuffer buffer : buffers) {
                int size = buffer.remaining();
                if (size > MAX_RESPONSE_BYTES - length) {
                    overLimit();
                    return;
                }
                if (size > bytes.length - length) {
                    bytes = Arrays.copyOf(bytes, Math.min(MAX_RESPONSE_BYTES, Math.max(bytes.length * 2, length + size)));
                }
                buffer.get(bytes, length, size);
                length += size;
            }
            subscription.request(1);
        }

        private void overLimit() {
            subscription.cancel();
            result.completeExceptionally(new TooLarge());
        }

        @Override
        public void onError(Throwable error) {
            result.completeExceptionally(error);
        }

        @Override
        public void onComplete() {
            result.complete(Arrays.copyOf(bytes, length));
        }
    }
}
