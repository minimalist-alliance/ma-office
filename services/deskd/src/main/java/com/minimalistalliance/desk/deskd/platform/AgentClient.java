package com.minimalistalliance.desk.deskd.platform;

import com.minimalistalliance.desk.deskd.aws.AwsCredentials;
import com.minimalistalliance.desk.deskd.aws.RoleCredentials;
import com.minimalistalliance.desk.deskd.aws.SigV4;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Clock;
import java.time.Duration;
import java.util.Map;
import java.util.function.Supplier;

/**
 * POST hello, POST heartbeat and GET config (agent.md), signed with the instance role. The API base
 * follows the Env tag unless deskd.env overrides it, so a stand-in can take Platform's place.
 */
public final class AgentClient {

    private static final String SERVICE = "execute-api";
    private static final Duration CALL_TIMEOUT = Duration.ofSeconds(10);

    /** Platform answered, but not with 200. */
    public static final class ApiException extends IOException {
        private static final long serialVersionUID = 1L;

        private final int status;
        private final String code;
        private final Duration retryAfter;

        ApiException(int status, String code, Duration retryAfter) {
            super("HTTP " + status + (code == null ? "" : " " + code), null);
            this.status = status;
            this.code = code;
            this.retryAfter = retryAfter;
        }

        public int status() {
            return status;
        }

        /** The error envelope's code, or null for API Gateway's own errors. */
        public String code() {
            return code;
        }

        /** Retry-After, or null if there was none. */
        public Duration retryAfter() {
            return retryAfter;
        }
    }

    private final PlatformHttp http;
    private final RoleCredentials credentials;
    private final Supplier<String> apiBase;
    private final Clock clock;

    public AgentClient(PlatformHttp http, RoleCredentials credentials, Supplier<String> apiBase, Clock clock) {
        this.http = http;
        this.credentials = credentials;
        this.apiBase = apiBase;
        this.clock = clock;
    }

    public Map<String, Object> hello(Map<String, Object> body) throws IOException, InterruptedException {
        return call("POST", "/v1/agent/hello", Json.bytes(body), CALL_TIMEOUT);
    }

    /** @param timeout shorter for the last heartbeat, which has a 5 s budget */
    public Map<String, Object> heartbeat(Map<String, Object> body, Duration timeout)
            throws IOException, InterruptedException {
        return call("POST", "/v1/agent/heartbeat", Json.bytes(body), timeout);
    }

    public Map<String, Object> config() throws IOException, InterruptedException {
        return call("GET", "/v1/agent/config", null, CALL_TIMEOUT);
    }

    /** A guild desk's roster (ma-platform guild-sharing.md, "Roster push"). Any other desk gets 404. */
    public Map<String, Object> guildRoster() throws IOException, InterruptedException {
        return call("GET", "/v1/agent/guild/roster", null, CALL_TIMEOUT);
    }

    /**
     * Publishes the desk's Courier keys to the key directory (ma-platform contract 0.4.0, relay.md §3.1): the same keys
     * again are {@code changed: false}.
     */
    public Map<String, Object> putKeys(Map<String, Object> body) throws IOException, InterruptedException {
        return call("PUT", "/v1/agent/keys", Json.bytes(body), CALL_TIMEOUT);
    }

    /**
     * A route of Courier's relay and its sending (ma-platform contract 0.4.0, relay.md §3, and the proposed 0.4.1
     * {@code courier-send}), which answer 200, 201 or 202. {@code headers} are added and signed (an {@code Idempotency-Key}).
     * An empty answer is an empty map.
     */
    public Map<String, Object> courier(String method, String path, Map<String, Object> body, Map<String, String> headers)
            throws IOException, InterruptedException {
        String base = apiBase.get();
        if (base == null) {
            throw new IOException("no API base: the Env tag isn't prod or staging");
        }
        URI uri = URI.create(base + path);
        byte[] bytes = body == null ? null : Json.bytes(body);
        HttpResponse<byte[]> response = send(method, uri, bytes, headers, CALL_TIMEOUT);
        if (response.statusCode() == 403 && envelopeCode(response.body()) == null) {
            credentials.invalidate();
            response = send(method, uri, bytes, headers, CALL_TIMEOUT);
        }
        if (response.statusCode() / 100 != 2) {
            throw new ApiException(response.statusCode(), envelopeCode(response.body()), retryAfter(response));
        }
        if (response.body().length == 0) {
            return Map.of();
        }
        try {
            return Json.parseObject(response.body());
        } catch (JsonFormatException e) {
            throw new IOException(path + " answered with something other than JSON");
        }
    }

    private Map<String, Object> call(String method, String path, byte[] body, Duration timeout)
            throws IOException, InterruptedException {
        String base = apiBase.get();
        if (base == null) {
            throw new IOException("no API base: the Env tag isn't prod or staging");
        }
        URI uri = URI.create(base + path);
        HttpResponse<byte[]> response = send(method, uri, body, timeout);
        // API Gateway's authorizer turned the signature down, which is the role's credentials having
        // changed. agent.md: refresh once and retry.
        if (response.statusCode() == 403 && envelopeCode(response.body()) == null) {
            credentials.invalidate();
            response = send(method, uri, body, timeout);
        }
        if (response.statusCode() != 200) {
            throw new ApiException(response.statusCode(), envelopeCode(response.body()), retryAfter(response));
        }
        try {
            return Json.parseObject(response.body());
        } catch (JsonFormatException e) {
            throw new IOException(path + " answered with something other than JSON");
        }
    }

    private HttpResponse<byte[]> send(String method, URI uri, byte[] body, Duration timeout)
            throws IOException, InterruptedException {
        return send(method, uri, body, Map.of(), timeout);
    }

    private HttpResponse<byte[]> send(String method, URI uri, byte[] body, Map<String, String> headers, Duration timeout)
            throws IOException, InterruptedException {
        AwsCredentials current = credentials.current();
        Map<String, String> toSign = new java.util.TreeMap<>();
        if (body != null) {
            toSign.put("content-type", "application/json");
        }
        if (headers != null) {
            headers.forEach((k, v) -> toSign.put(k.toLowerCase(java.util.Locale.ROOT), v));
        }
        Map<String, String> signed = SigV4.sign(
                method, uri, toSign, body == null ? new byte[0] : body, SERVICE, SigV4.REGION, current, clock.instant());
        HttpRequest.Builder request = HttpRequest.newBuilder(uri)
                .timeout(timeout)
                .method(method, body == null
                        ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofByteArray(body));
        signed.forEach((name, value) -> {
            if (!name.equals("host")) {
                request.header(name, value);
            }
        });
        return http.send(request.build(), HttpResponse.BodyHandlers.ofByteArray(), timeout);
    }

    /** @return the code inside {"error":{...}}, or null if it isn't that envelope */
    private static String envelopeCode(byte[] body) {
        try {
            Map<String, Object> error = Json.object(Json.parseObject(body), "error");
            return error == null ? null : Json.string(error, "code");
        } catch (JsonFormatException e) {
            return null;
        }
    }

    /** Held to {@link PlatformHttp#MAX_RETRY_AFTER}, so no answer can park the boot thread or the heartbeat for long. */
    private static Duration retryAfter(HttpResponse<?> response) {
        return PlatformHttp.retryAfter(response.headers());
    }
}
