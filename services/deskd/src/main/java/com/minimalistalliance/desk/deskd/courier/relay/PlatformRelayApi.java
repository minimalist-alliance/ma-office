package com.minimalistalliance.desk.deskd.courier.relay;

import com.minimalistalliance.desk.deskd.platform.AgentClient;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * The relay's agent routes through {@link AgentClient} (SigV4 with the desk's role, as every {@code /v1/agent/*} route),
 * and its presigned drop links through {@link PlatformHttp}, unsigned. A drop link must be {@code https} with no user
 * info (plain {@code http} on a loopback address only when built for the test kit's fake, CT-I1): the platform hands it
 * out, and nothing else is fetched.
 */
public final class PlatformRelayApi implements RelayApi {

    private static final Duration DROP_TIMEOUT = Duration.ofMinutes(5);
    /** Headers a reservation may ask a drop's {@code PUT} to carry; anything else is a wrong answer. */
    private static final Set<String> RESTRICTED = Set.of("host", "content-length", "connection", "expect", "upgrade");

    private final AgentClient client;
    private final PlatformHttp http;
    private final boolean allowLoopbackHttp;

    public PlatformRelayApi(AgentClient client, PlatformHttp http) {
        this(client, http, false);
    }

    /** @param allowLoopbackHttp plain {@code http} drop links on a loopback address: the test kit's fake relay only (CT-I1) */
    public PlatformRelayApi(AgentClient client, PlatformHttp http, boolean allowLoopbackHttp) {
        this.client = client;
        this.http = http;
        this.allowLoopbackHttp = allowLoopbackHttp;
    }

    @Override
    public Map<String, Object> addresses() throws IOException, InterruptedException {
        return call("GET", "/v1/agent/courier-addresses", null, null);
    }

    @Override
    public Map<String, Object> lookup(String address) throws IOException, InterruptedException {
        return call("GET", "/v1/agent/keys/lookup?address=" + URLEncoder.encode(address, StandardCharsets.UTF_8), null, null);
    }

    @Override
    public Map<String, Object> reserveDrop(String to, long bytes) throws IOException, InterruptedException {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("to", to);
        body.put("bytes", bytes);
        return call("POST", "/v1/agent/relay/drops", body, null);
    }

    @Override
    public void upload(String url, Map<String, String> headers, byte[] bytes) throws IOException, InterruptedException {
        HttpRequest.Builder b = HttpRequest.newBuilder(dropUri(url, allowLoopbackHttp)).timeout(DROP_TIMEOUT).PUT(HttpRequest.BodyPublishers.ofByteArray(bytes));
        if (headers != null) {
            for (Map.Entry<String, String> h : headers.entrySet()) {
                if (h.getKey() == null || h.getValue() == null) {
                    throw new IOException("a drop header deskd won't send");
                }
                String name = h.getKey().toLowerCase(Locale.ROOT);
                if ("content-length".equals(name)) {
                    // Signed into the link (staging's are): the client sends exactly this itself, from the body.
                    if (!h.getValue().strip().equals(Integer.toString(bytes.length))) {
                        throw new IOException("the drop's signed length isn't the body's");
                    }
                    continue;
                }
                if (RESTRICTED.contains(name)) {
                    throw new IOException("a drop header deskd won't send");
                }
                b.header(h.getKey(), h.getValue());
            }
        }
        HttpResponse<Void> r = http.send(b.build(), HttpResponse.BodyHandlers.discarding(), DROP_TIMEOUT);
        if (r.statusCode() / 100 != 2) {
            throw new Refused(r.statusCode(), null, null);
        }
    }

    @Override
    public Map<String, Object> send(Map<String, Object> envelope, String idempotencyKey) throws IOException, InterruptedException {
        return call("POST", "/v1/agent/relay/send", envelope, idempotencyKey == null ? null : Map.of("Idempotency-Key", idempotencyKey));
    }

    @Override
    public Map<String, Object> collect(String after, int limit) throws IOException, InterruptedException {
        String q = "?limit=" + limit + (after == null ? "" : "&after=" + URLEncoder.encode(after, StandardCharsets.UTF_8));
        return call("GET", "/v1/agent/relay" + q, null, null);
    }

    @Override
    public InputStream download(String url, long max) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder(dropUri(url, allowLoopbackHttp)).timeout(DROP_TIMEOUT).GET().build();
        HttpResponse<InputStream> r = http.send(request, HttpResponse.BodyHandlers.ofInputStream(), DROP_TIMEOUT);
        if (r.statusCode() != 200) {
            r.body().close();
            throw new Refused(r.statusCode(), null, null);
        }
        return new Bounded(r.body(), max);
    }

    @Override
    public Map<String, Object> ack(List<String> ids) throws IOException, InterruptedException {
        return call("POST", "/v1/agent/relay/ack", Map.of("ids", ids), null);
    }

    @Override
    public Map<String, Object> pending() throws IOException, InterruptedException {
        return call("GET", "/v1/agent/relay/pending", null, null);
    }

    @Override
    public Map<String, Object> claimDevice(String userCode) throws IOException, InterruptedException {
        return call("POST", "/v1/agent/devices/claim", Map.of("userCode", userCode), null);
    }

    @Override
    public Map<String, Object> ownKeys() throws IOException, InterruptedException {
        return call("GET", "/v1/agent/keys", null, null);
    }

    @Override
    public void deleteDevice(String deviceId) throws IOException, InterruptedException {
        if (!com.minimalistalliance.desk.courier.envelope.DeviceEnvelope.DEVICE_ID.matcher(deviceId).matches()) {
            throw new IOException("not a device id");
        }
        call("DELETE", "/v1/agent/keys/devices/" + deviceId, null, null);
    }

    private Map<String, Object> call(String method, String path, Map<String, Object> body, Map<String, String> headers)
            throws IOException, InterruptedException {
        try {
            return client.courier(method, path, body, headers == null ? Map.of() : headers);
        } catch (AgentClient.ApiException e) {
            throw new Refused(e.status(), e.code(), e.retryAfter());
        }
    }

    /** A drop link the desk will follow: https, or (for the test kit's fake only) http on a loopback address. */
    static URI dropUri(String url, boolean allowLoopbackHttp) throws IOException {
        URI u;
        try {
            u = URI.create(url);
        } catch (IllegalArgumentException | NullPointerException e) {
            throw new IOException("not a drop link");
        }
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        if (u.getHost() == null || u.getRawUserInfo() != null) {
            throw new IOException("not a drop link");
        }
        if ("https".equals(scheme)) {
            return u;
        }
        if (allowLoopbackHttp && "http".equals(scheme) && loopback(u.getHost())) {
            return u;
        }
        throw new IOException("not a drop link");
    }

    private static boolean loopback(String host) {
        if (!"127.0.0.1".equals(host) && !"[::1]".equals(host) && !"localhost".equals(host)) {
            return false;
        }
        try {
            return InetAddress.getByName(host.replace("[", "").replace("]", "")).isLoopbackAddress();
        } catch (IOException e) {
            return false;
        }
    }

    /** Stops a download past what its reference said it holds. */
    private static final class Bounded extends FilterInputStream {
        private long left;

        Bounded(InputStream in, long max) {
            super(in);
            this.left = max + 1;
        }

        @Override
        public int read() throws IOException {
            if (left <= 0) {
                throw new IOException("the drop is larger than it said");
            }
            int b = super.read();
            if (b >= 0) {
                left--;
            }
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) {
                throw new IOException("the drop is larger than it said");
            }
            int n = super.read(b, off, (int) Math.min(len, left));
            if (n > 0) {
                left -= n;
            }
            return n;
        }
    }
}
