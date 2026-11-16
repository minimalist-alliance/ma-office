package com.minimalistalliance.desk.deskd.courier.relay;

import com.minimalistalliance.desk.deskd.platform.AgentClient;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;

/**
 * {@code courier-send} in contract 0.4.1 (ma-platform {@code relay.md} §3, "Sending"):
 * {@code POST /v1/agent/courier/send} {@code {from, to, rfcMessageId, raw | upload}} with an {@code Idempotency-Key},
 * answering {@code 202 {id, accepted, refused: [{address, code}]}}. {@code raw} is base64url, up to {@link #INLINE_MAX}
 * (4 MiB, what the door takes inline); a larger message goes up first through {@code POST /v1/agent/courier/uploads}
 * {@code {bytes}} ({@code 201 {uploadId, url, method: "PUT", headers, expiresAt}}), a presigned {@code PUT} of exactly its
 * bytes under this desk's own prefix, then is sent as {@code {upload: uploadId}}. The door caps either at
 * {@code mail.maxMessageBytes} (25 MiB) with {@code 413 too_large}. The {@code PUT} goes through the relay's own drop
 * uploader ({@link RelayApi#upload}): https only, no headers but the presign's, its signed length checked against the body.
 * An upload the door no longer has ({@code 409 upload_missing}: it expired between the {@code PUT} and the send) is made
 * again once. Whether sending is available comes from {@code GET /v1/agent/courier-addresses}' {@code sending.available},
 * read by the transport.
 */
public final class PlatformCourierSend implements CourierSend {

    /**
     * The largest message sent inside the call: the door's own inline cap (contract 0.4.1, {@code raw} up to 4 MiB; a Lambda
     * request holds about 6 MB, and base64 grows the message by a third). Anything larger goes through an upload.
     */
    public static final int INLINE_MAX = 4 * 1024 * 1024;

    /** A presigned {@code PUT} of a message's bytes: the relay's drop uploader, with its checks. */
    @FunctionalInterface
    public interface Uploader {
        void put(String url, Map<String, String> headers, byte[] bytes) throws IOException, InterruptedException;
    }

    private final AgentClient client;
    private final Uploader uploader;
    private final BooleanSupplier available;

    public PlatformCourierSend(AgentClient client, Uploader uploader, BooleanSupplier available) {
        this.client = client;
        this.uploader = uploader;
        this.available = available;
    }

    @Override
    public boolean available() {
        return available.getAsBoolean();
    }

    @Override
    public Accepted submit(Submission s) throws IOException, InterruptedException {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("from", s.from());
        body.put("to", s.to());
        body.put("rfcMessageId", s.rfcMessageId());
        if (s.raw().length <= INLINE_MAX) {
            body.put("raw", Base64.getUrlEncoder().withoutPadding().encodeToString(s.raw()));
            return read(send(body, s), s.to());
        }
        body.put("upload", upload(s.raw()));
        try {
            return read(send(body, s), s.to());
        } catch (RelayApi.Refused r) {
            if (r.status() != 409 || !"upload_missing".equals(r.code())) {
                throw r;
            }
            // It went before the send reached it (an upload lives 5 minutes unused): once more, with a fresh one.
            body.put("upload", upload(s.raw()));
            return read(send(body, s), s.to());
        }
    }

    private Map<String, Object> send(Map<String, Object> body, Submission s) throws IOException, InterruptedException {
        try {
            return client.courier("POST", "/v1/agent/courier/send", body, Map.of("Idempotency-Key", s.idempotencyKey()));
        } catch (AgentClient.ApiException e) {
            throw new RelayApi.Refused(e.status(), e.code(), e.retryAfter());
        }
    }

    /**
     * Reserves an upload of exactly these bytes and {@code PUT}s them: its id, which the send names. A reservation that
     * doesn't read as the contract's is a wrong answer, never followed.
     */
    private String upload(byte[] raw) throws IOException, InterruptedException {
        Map<String, Object> answer;
        try {
            answer = client.courier("POST", "/v1/agent/courier/uploads", Map.of("bytes", raw.length), Map.of());
        } catch (AgentClient.ApiException e) {
            throw new RelayApi.Refused(e.status(), e.code(), e.retryAfter());
        }
        String id = answer.get("uploadId") instanceof String u && UPLOAD_ID.matcher(u).matches() ? u : null;
        String url = answer.get("url") instanceof String x ? x : null;
        if (id == null || url == null || (answer.get("method") != null && !"PUT".equals(answer.get("method")))) {
            throw new IOException("the upload's reservation isn't the contract's");
        }
        Map<String, String> headers = new LinkedHashMap<>();
        if (answer.get("headers") instanceof Map<?, ?> h) {
            for (Map.Entry<?, ?> e : h.entrySet()) {
                if (!(e.getKey() instanceof String k) || !(e.getValue() instanceof String v)) {
                    throw new IOException("the upload's reservation isn't the contract's");
                }
                headers.put(k, v);
            }
        }
        uploader.put(url, headers, raw);
        return id;
    }

    /** The door's upload id: {@code up-} and a ULID. */
    private static final java.util.regex.Pattern UPLOAD_ID = java.util.regex.Pattern.compile("up-[0-9A-HJKMNP-TV-Z]{26}");

    /** The answer, read strictly: a recipient it doesn't name is taken as refused ({@code unanswered}). */
    static Accepted read(Map<String, Object> answer, List<String> asked) {
        String id = answer.get("id") instanceof String i && i.length() <= 128 ? i : null;
        List<String> accepted = new ArrayList<>();
        Map<String, String> refused = new LinkedHashMap<>();
        if (answer.get("accepted") instanceof List<?> l) {
            for (Object o : l) {
                if (o instanceof String a && asked.contains(a)) {
                    accepted.add(a);
                }
            }
        }
        if (answer.get("refused") instanceof List<?> l) {
            for (Object o : l) {
                if (o instanceof Map<?, ?> m && m.get("address") instanceof String a && asked.contains(a) && !accepted.contains(a)) {
                    refused.put(a, m.get("code") instanceof String c && c.matches("[a-z_]{1,32}") ? c : "refused");
                }
            }
        }
        for (String a : asked) {
            if (!accepted.contains(a) && !refused.containsKey(a)) {
                refused.put(a, "unanswered");
            }
        }
        return new Accepted(id, accepted, refused);
    }
}
