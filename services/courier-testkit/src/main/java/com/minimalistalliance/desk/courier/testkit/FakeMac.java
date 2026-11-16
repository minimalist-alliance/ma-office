package com.minimalistalliance.desk.courier.testkit;

import com.minimalistalliance.desk.courier.envelope.BodySource;
import com.minimalistalliance.desk.courier.envelope.BoxKey;
import com.minimalistalliance.desk.courier.envelope.BoxKeyPair;
import com.minimalistalliance.desk.courier.envelope.DeviceEnvelope;
import com.minimalistalliance.desk.courier.envelope.Drop;
import com.minimalistalliance.desk.courier.envelope.Envelope;
import com.minimalistalliance.desk.courier.envelope.EnvelopeException;
import com.minimalistalliance.desk.courier.envelope.IdentityKey;
import com.minimalistalliance.desk.courier.envelope.IdentityKeyPair;
import com.minimalistalliance.desk.courier.envelope.PublishedKeys;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.jr.ob.JSON;

/**
 * MA Connector for Mac, faked in Java for deskd's tests: a paired device on the {@link FakeRelay}'s device routes (relay.md
 * 0.4.3), signing every request with its own key, and speaking the desk-and-device format (the draft ADR "Courier's Mac
 * connector" §B) through {@link DeviceEnvelope}. The real app is Swift (ma-desk {@code connectors/mac}); the two are checked
 * against each other end to end with the app's harness on a Mac.
 */
public final class FakeMac {

    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private static final JSON J = JSON.std.with(JSON.Feature.WRITE_NULL_PROPERTIES);
    private static final DateTimeFormatter AT = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    private final String base;
    private final SecureRandom random = new SecureRandom();
    final IdentityKeyPair identity = IdentityKeyPair.generate(random);
    final BoxKeyPair box = BoxKeyPair.generate(random, System.currentTimeMillis());
    private String pairingId;
    private String userCode;
    private String deviceId;
    private IdentityKey deskIdentity;
    private BoxKey deskBox;
    private long ulidMillis;
    private int ulidCounter;

    public FakeMac(FakeRelay relay) {
        this(relay.baseUrl());
    }

    public FakeMac(String base) {
        this.base = base;
    }

    /** A payload the desk sent down, opened and verified. */
    public record Down(String relayId, String type, Map<String, Object> fields) {}

    /** An answer the relay refused. */
    public static final class Refused extends IOException {
        private static final long serialVersionUID = 1L;
        public final int status;
        public final String code;

        Refused(int status, String code) {
            super(status + " " + code);
            this.status = status;
            this.code = code;
        }
    }

    public String deviceId() {
        return deviceId;
    }

    public String userCode() {
        return userCode;
    }

    public IdentityKey identityKey() {
        return identity.publicKey();
    }

    /** {@code POST /v1/device/pairings}: the code the member types into Courier. */
    public String startPairing() throws IOException {
        PublishedKeys k = PublishedKeys.bind(identity, box.publicKey());
        Map<String, Object> b = new LinkedHashMap<>(k.toJson());
        b.put("kind", "mac");
        b.put("name", "Mac");
        b.put("app", Map.of("version", "1.0.0"));
        Map<String, Object> r = call("POST", "/v1/device/pairings", "", b, null);
        pairingId = (String) r.get("pairingId");
        userCode = (String) r.get("userCode");
        return userCode;
    }

    /** Polls once; true when the desk has claimed the code. */
    public boolean paired() throws IOException {
        Map<String, Object> r = call("GET", "/v1/device/pairings/" + pairingId, "", null, null);
        if (!"paired".equals(r.get("state"))) {
            return false;
        }
        deviceId = (String) r.get("deviceId");
        @SuppressWarnings("unchecked")
        Map<String, Object> desk = (Map<String, Object>) r.get("desk");
        try {
            PublishedKeys k = PublishedKeys.fromJson(Map.of("identityKey", desk.get("identityKey"), "boxKey", desk.get("boxKey"), "binding",
                    desk.get("binding")));
            if (!k.bindingValid()) {
                throw new IOException("the desk's binding doesn't verify");
            }
            deskIdentity = k.identityKey();
            deskBox = k.boxKey();
        } catch (EnvelopeException e) {
            throw new IOException("the desk's keys don't read");
        }
        return true;
    }

    /** Everything the desk sent down, opened, verified and acked (refused ones acked too, and left out). */
    public List<Down> receive() throws IOException {
        Map<String, Object> r = call("GET", "/v1/device/relay", "limit=100", null, null);
        List<Down> out = new ArrayList<>();
        List<String> ids = new ArrayList<>();
        if (r.get("envelopes") instanceof List<?> l) {
            for (Object o : l) {
                @SuppressWarnings("unchecked")
                Map<String, Object> e = (Map<String, Object>) o;
                String id = (String) e.get("id");
                ids.add(id);
                try {
                    byte[] pt = DeviceEnvelope.open(deviceId, List.of(box), b64((String) e.get("enc")), b64((String) e.get("ct")));
                    DeviceEnvelope.Payload p = DeviceEnvelope.unwrap(pt, deskIdentity, deviceId, DeviceEnvelope.DOWN);
                    Map<String, Object> fields = p.fields();
                    if ("big".equals(p.type())) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> ref = (Map<String, Object>) fields.get("drop");
                        fields = DeviceEnvelope.parse(dropBody(ref, e));
                    }
                    out.add(new Down(id, (String) fields.get("type"), fields));
                } catch (EnvelopeException x) {
                    // Refused: acked and left out, as the app does.
                }
            }
        }
        if (!ids.isEmpty()) {
            call("POST", "/v1/device/relay/ack", "", Map.of("ids", ids), null);
        }
        return out;
    }

    private byte[] dropBody(Map<String, Object> ref, Map<String, Object> e) throws IOException, EnvelopeException {
        for (Object o : (List<?>) e.get("drops")) {
            Map<?, ?> d = (Map<?, ?>) o;
            if (ref.get("id").equals(d.get("dropId"))) {
                HttpResponse<byte[]> r = send(HttpRequest.newBuilder(URI.create((String) d.get("url"))).GET());
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                Drop.open(ref, ((Number) d.get("bytes")).longValue(), new java.io.ByteArrayInputStream(r.body()), out);
                return out.toByteArray();
            }
        }
        throw new IOException("no such drop");
    }

    /** A file for a page: sealed into a drop and uploaded; the reference goes in the message's {@code files[].drop}. */
    public record Uploaded(String dropId, Map<String, Object> reference) {}

    public Uploaded upload(byte[] body) throws IOException {
        try {
            Drop.Sealer s = Drop.sealer(BodySource.of(body));
            Map<String, Object> r = call("POST", "/v1/device/relay/drops", "", Map.of("bytes", s.bucket()), null);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            s.write(out);
            HttpRequest.Builder put = HttpRequest.newBuilder(URI.create((String) r.get("url"))).PUT(HttpRequest.BodyPublishers.ofByteArray(out.toByteArray()));
            @SuppressWarnings("unchecked")
            Map<String, String> headers = (Map<String, String>) r.get("headers");
            headers.forEach((k, v) -> {
                if (!"content-length".equalsIgnoreCase(k)) {
                    put.header(k, v);
                }
            });
            HttpResponse<byte[]> u = send(put);
            if (u.statusCode() != 200) {
                throw new IOException("upload " + u.statusCode());
            }
            String id = (String) r.get("dropId");
            return new Uploaded(id, s.reference(id));
        } catch (EnvelopeException e) {
            throw new IOException(e.getMessage());
        }
    }

    /** Signs and seals one payload up to the desk; returns its payload id. A payload too big for an envelope goes whole in a drop. */
    public String sendUp(String type, Map<String, Object> fields, List<String> drops) throws IOException {
        return sendUp(type, fields, drops, Instant.now(), null);
    }

    public String sendUp(String type, Map<String, Object> fields, List<String> drops, Instant at, IdentityKeyPair signer) throws IOException {
        try {
            String id = ulid(at.toEpochMilli());
            IdentityKeyPair who = signer == null ? identity : signer;
            byte[] pt = DeviceEnvelope.wrap(who, deviceId, DeviceEnvelope.UP, type, fields, id, AT.format(at));
            List<String> all = new ArrayList<>(drops);
            if (pt.length >= DeviceEnvelope.MAX_PLAINTEXT_BUCKET) {
                Map<String, Object> inner = new LinkedHashMap<>(fields);
                inner.put("type", type);
                Uploaded u = upload(J.asBytes(inner));
                all.add(u.dropId());
                pt = DeviceEnvelope.wrap(who, deviceId, DeviceEnvelope.UP, "big", Map.of("drop", u.reference()), id, AT.format(at));
            }
            Envelope.Sealed s = DeviceEnvelope.seal(deviceId, deskBox, pt);
            Map<String, Object> env = new LinkedHashMap<>(s.toJson());
            if (!all.isEmpty()) {
                env.put("drops", all);
            }
            call("POST", "/v1/device/relay/send", "", env, "up" + id);
            return id;
        } catch (EnvelopeException e) {
            throw new IOException(e.getMessage());
        }
    }

    /** {@code DELETE /v1/device/self}: the Mac's own "Disconnect". */
    public void unpair() throws IOException {
        call("DELETE", "/v1/device/self", "", null, null);
    }

    /** One message in the page format (SPEC B.2). */
    public static Map<String, Object> message(long seq, String guid, String chatGuid, String sender, String text, Instant date) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("seq", seq);
        m.put("guid", guid);
        m.put("date", date.toEpochMilli());
        m.put("fromMe", sender == null);
        if (sender != null) {
            m.put("sender", sender);
        }
        m.put("senderService", chatGuid.startsWith("SMS") ? "SMS" : "iMessage");
        boolean group = chatGuid.contains(";+;");
        m.put("chat", Map.of("guid", chatGuid, "group", group, "participants",
                group ? List.of() : List.of(chatGuid.substring(chatGuid.lastIndexOf(';') + 1))));
        if (text != null) {
            m.put("text", text);
        }
        m.put("files", List.of());
        m.put("failed", false);
        m.put("appOnly", false);
        return m;
    }

    private Map<String, Object> call(String method, String path, String query, Map<String, Object> body, String idem) throws IOException {
        byte[] bytes = body == null ? new byte[0] : J.asBytes(body);
        String date = AT.format(Instant.now());
        byte[] n = new byte[16];
        random.nextBytes(n);
        String nonce = Base64.getUrlEncoder().withoutPadding().encodeToString(n);
        String signed = "ma-device-req/v1\n" + method + "\n" + path + "\n" + query + "\n" + date + "\n" + nonce + "\n" + sha256(bytes);
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base + path + (query.isEmpty() ? "" : "?" + query)))
                .header("MA-Device-Key", identity.publicKey().text())
                .header("MA-Date", date)
                .header("MA-Nonce", nonce)
                .header("MA-Signature", Base64.getUrlEncoder().withoutPadding().encodeToString(identity.sign(signed.getBytes(StandardCharsets.UTF_8))))
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(bytes))
                .timeout(Duration.ofSeconds(30));
        if (idem != null) {
            b.header("Idempotency-Key", idem);
        }
        HttpResponse<byte[]> r = send(b);
        Map<String, Object> m = r.body().length == 0 ? Map.of() : J.mapFrom(r.body());
        if (r.statusCode() / 100 != 2) {
            Object e = m.get("error");
            throw new Refused(r.statusCode(), e instanceof Map<?, ?> em ? (String) em.get("code") : null);
        }
        return m;
    }

    private static HttpResponse<byte[]> send(HttpRequest.Builder b) throws IOException {
        try {
            return HTTP.send(b.build(), HttpResponse.BodyHandlers.ofByteArray());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("interrupted");
        }
    }

    private static String sha256(byte[] b) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(b));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static byte[] b64(String s) {
        return Base64.getUrlDecoder().decode(s);
    }

    private String ulid(long ms) {
        if (ms <= ulidMillis) {
            ms = ulidMillis;
            ulidCounter++;
        } else {
            ulidMillis = ms;
            ulidCounter = random.nextInt(1 << 20);
        }
        String a = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
        StringBuilder s = new StringBuilder();
        for (int i = 9; i >= 0; i--) {
            s.append(a.charAt((int) ((ms >>> (5 * i)) & 31)));
        }
        long r = ((long) ulidCounter << 20) | random.nextInt(1 << 20);
        for (int i = 0; i < 16; i++) {
            s.append(a.charAt((int) (i < 8 ? (r >>> (5 * (7 - i))) & 31 : random.nextInt(32))));
        }
        return s.toString();
    }
}
