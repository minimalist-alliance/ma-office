package com.minimalistalliance.desk.courier.testkit;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import tools.jackson.jr.ob.JSON;

/**
 * The agent routes of contract 0.4.0 §3 as one desk calls them, for tests and the soak harness: a fake peer desk sends
 * and collects through it. It names its desk with {@value FakeRelay#DESK_HEADER} instead of signing (deskd's own
 * {@code AgentClient} signs, and the fake reads its access key id).
 */
public final class RelayClient {

    /** A non-2xx answer: the status and the error envelope's code (null when there was none). */
    public static final class Refused extends IOException {
        public final int status;
        public final String code;

        Refused(int status, String code) {
            super("HTTP " + status + (code == null ? "" : " " + code));
            this.status = status;
            this.code = code;
        }
    }

    private static final JSON J = JSON.std.with(JSON.Feature.WRITE_NULL_PROPERTIES);
    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

    private final String base;
    private final String deskId;

    public RelayClient(String base, String deskId) {
        this.base = base;
        this.deskId = deskId;
    }

    public String deskId() {
        return deskId;
    }

    public Map<String, Object> putKeys(Map<String, Object> keys) throws IOException {
        return call("PUT", "/v1/agent/keys", keys, null);
    }

    public Map<String, Object> lookup(String address) throws IOException {
        return call("GET", "/v1/agent/keys/lookup?address=" + URLEncoder.encode(address, StandardCharsets.UTF_8), null, null);
    }

    public Map<String, Object> addresses() throws IOException {
        return call("GET", "/v1/agent/courier-addresses", null, null);
    }

    public Map<String, Object> reserveDrop(String to, long bytes) throws IOException {
        return call("POST", "/v1/agent/relay/drops", Map.of("to", to, "bytes", bytes), null);
    }

    /**
     * {@code PUT}s a drop's bytes to the URL a reservation gave, with the headers it signed ({@code headers}; the length
     * goes as the body's own, which the client sends).
     */
    public void upload(String url, Map<String, Object> headers, byte[] bytes) throws IOException {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url)).PUT(HttpRequest.BodyPublishers.ofByteArray(bytes));
        if (headers != null) {
            headers.forEach((k, v) -> {
                if (!"content-length".equalsIgnoreCase(k) && v instanceof String s) {
                    b.header(k, s);
                }
            });
        }
        HttpResponse<byte[]> r = send(b);
        if (r.statusCode() != 200) {
            throw new Refused(r.statusCode(), null);
        }
    }

    public byte[] download(String url) throws IOException {
        HttpResponse<byte[]> r = send(HttpRequest.newBuilder(URI.create(url)).GET());
        if (r.statusCode() != 200) {
            throw new Refused(r.statusCode(), null);
        }
        return r.body();
    }

    public Map<String, Object> send(Map<String, Object> envelope, String idempotencyKey) throws IOException {
        return call("POST", "/v1/agent/relay/send", envelope, idempotencyKey);
    }

    public Map<String, Object> collect(String after, int limit) throws IOException {
        return call("GET", "/v1/agent/relay?limit=" + limit + (after == null ? "" : "&after=" + URLEncoder.encode(after, StandardCharsets.UTF_8)), null, null);
    }

    public Map<String, Object> ack(List<String> ids) throws IOException {
        return call("POST", "/v1/agent/relay/ack", Map.of("ids", ids), null);
    }

    public Map<String, Object> pending() throws IOException {
        return call("GET", "/v1/agent/relay/pending", null, null);
    }

    private Map<String, Object> call(String method, String path, Object body, String idem) throws IOException {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base + path)).header(FakeRelay.DESK_HEADER, deskId).timeout(Duration.ofSeconds(30));
        if (idem != null) {
            b.header("Idempotency-Key", idem);
        }
        b.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(J.asBytes(body)));
        if (body != null) {
            b.header("Content-Type", "application/json");
        }
        HttpResponse<byte[]> r = send(b);
        Map<String, Object> m = r.body().length == 0 ? Map.of() : J.mapFrom(r.body());
        if (r.statusCode() / 100 != 2) {
            Object e = m.get("error");
            throw new Refused(r.statusCode(), e instanceof Map<?, ?> em && em.get("code") instanceof String c ? c : null);
        }
        return m;
    }

    private static HttpResponse<byte[]> send(HttpRequest.Builder b) throws IOException {
        try {
            return HTTP.send(b.build(), HttpResponse.BodyHandlers.ofByteArray());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("interrupted");
        } catch (UncheckedIOException e) {
            throw e.getCause();
        }
    }
}
