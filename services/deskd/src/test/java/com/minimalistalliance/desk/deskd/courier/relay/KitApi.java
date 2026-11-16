package com.minimalistalliance.desk.deskd.courier.relay;

import com.minimalistalliance.desk.courier.testkit.FakeRelay;
import com.minimalistalliance.desk.deskd.protocol.Json;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The relay's routes and {@code courier-send} for one desk on the test kit's {@link FakeRelay}, naming the desk with its
 * header rather than signing: deskd's {@link RelayApi} and {@link CourierSend} for tests of everything above them.
 * {@link PlatformRelayApiTest} proves the signed client against the same fake.
 */
public final class KitApi implements RelayApi, CourierSend {

    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

    private final String base;
    final String deskId;

    public KitApi(String base, String deskId) {
        this.base = base;
        this.deskId = deskId;
    }

    @Override
    public Map<String, Object> addresses() throws IOException {
        return call("GET", "/v1/agent/courier-addresses", null, null);
    }

    @Override
    public Map<String, Object> lookup(String address) throws IOException {
        return call("GET", "/v1/agent/keys/lookup?address=" + URLEncoder.encode(address, StandardCharsets.UTF_8), null, null);
    }

    public Map<String, Object> putKeys(Map<String, Object> keys) throws IOException {
        return call("PUT", "/v1/agent/keys", keys, null);
    }

    @Override
    public Map<String, Object> reserveDrop(String to, long bytes) throws IOException {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("to", to);
        b.put("bytes", bytes);
        return call("POST", "/v1/agent/relay/drops", b, null);
    }

    @Override
    public void upload(String url, Map<String, String> headers, byte[] bytes) throws IOException {
        PlatformRelayApi.dropUri(url, true);
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url)).PUT(HttpRequest.BodyPublishers.ofByteArray(bytes));
        if (headers != null) {
            headers.forEach((k, v) -> {
                if (!"content-length".equalsIgnoreCase(k)) {
                    b.header(k, v);
                }
            });
        }
        HttpResponse<byte[]> r = send(b);
        if (r.statusCode() != 200) {
            throw new Refused(r.statusCode(), null, null);
        }
    }

    @Override
    public Map<String, Object> send(Map<String, Object> envelope, String idempotencyKey) throws IOException {
        return call("POST", "/v1/agent/relay/send", envelope, idempotencyKey);
    }

    @Override
    public Map<String, Object> collect(String after, int limit) throws IOException {
        return call("GET", "/v1/agent/relay?limit=" + limit + (after == null ? "" : "&after=" + URLEncoder.encode(after, StandardCharsets.UTF_8)),
                null, null);
    }

    @Override
    public InputStream download(String url, long max) throws IOException {
        PlatformRelayApi.dropUri(url, true);
        HttpResponse<byte[]> r = send(HttpRequest.newBuilder(URI.create(url)).GET());
        if (r.statusCode() != 200) {
            throw new Refused(r.statusCode(), null, null);
        }
        return new ByteArrayInputStream(r.body());
    }

    @Override
    public Map<String, Object> ack(List<String> ids) throws IOException {
        return call("POST", "/v1/agent/relay/ack", Map.of("ids", ids), null);
    }

    @Override
    public Map<String, Object> pending() throws IOException {
        return call("GET", "/v1/agent/relay/pending", null, null);
    }

    // ---- paired devices (relay.md 0.4.3)

    @Override
    public Map<String, Object> claimDevice(String userCode) throws IOException {
        return call("POST", "/v1/agent/devices/claim", Map.of("userCode", userCode), null);
    }

    @Override
    public Map<String, Object> ownKeys() throws IOException {
        return call("GET", "/v1/agent/keys", null, null);
    }

    @Override
    public void deleteDevice(String deviceId) throws IOException {
        call("DELETE", "/v1/agent/keys/devices/" + deviceId, null, null);
    }

    // ---- courier-send

    @Override
    public boolean available() {
        return true;
    }

    @Override
    public Accepted submit(Submission s) throws IOException {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("from", s.from());
        body.put("to", s.to());
        body.put("rfcMessageId", s.rfcMessageId());
        body.put("raw", Base64.getUrlEncoder().withoutPadding().encodeToString(s.raw()));
        return PlatformCourierSend.read(call("POST", "/v1/agent/courier/send", body, s.idempotencyKey()), s.to());
    }

    private Map<String, Object> call(String method, String path, Map<String, Object> body, String idem) throws IOException {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base + path)).header(FakeRelay.DESK_HEADER, deskId).timeout(Duration.ofSeconds(30));
        if (idem != null) {
            b.header("Idempotency-Key", idem);
        }
        b.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(Json.bytes(body)));
        if (body != null) {
            b.header("Content-Type", "application/json");
        }
        HttpResponse<byte[]> r = send(b);
        Map<String, Object> m;
        try {
            m = r.body().length == 0 ? Map.of() : Json.parseObject(r.body());
        } catch (Exception e) {
            m = Map.of();
        }
        if (r.statusCode() / 100 != 2) {
            Object e = m.get("error");
            String code = e instanceof Map<?, ?> em && em.get("code") instanceof String c ? c : null;
            Duration retry = r.headers().firstValue("Retry-After").map(v -> Duration.ofSeconds(Long.parseLong(v))).orElse(null);
            throw new Refused(r.statusCode(), code, retry);
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
