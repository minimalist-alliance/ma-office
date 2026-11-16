package com.minimalistalliance.desk.deskd.courier.relay;

import java.io.IOException;
import java.io.InputStream;
import java.time.Duration;
import java.util.List;
import java.util.Map;

/**
 * The relay's agent routes as this desk calls them (ma-platform contract 0.4.0, {@code relay.md} §3), and the presigned
 * drop links they hand out. Answers are the contract's JSON, as maps; refusals are {@link Refused} with the contract's
 * code. {@link PlatformRelayApi} signs each call with the desk's role, as every {@code /v1/agent/*} route.
 */
public interface RelayApi {

    /** A non-2xx answer: its status, the error envelope's code (null for none), and {@code Retry-After} if it gave one. */
    final class Refused extends IOException {
        private static final long serialVersionUID = 1L;

        private final int status;
        private final String code;
        private final transient Duration retryAfter;

        public Refused(int status, String code, Duration retryAfter) {
            super("HTTP " + status + (code == null ? "" : " " + code));
            this.status = status;
            this.code = code;
            this.retryAfter = retryAfter;
        }

        public int status() {
            return status;
        }

        public String code() {
            return code;
        }

        public Duration retryAfter() {
            return retryAfter;
        }
    }

    /** {@code GET /v1/agent/courier-addresses}: {@code {domain, address, closed}} and, proposed for 0.4.1, {@code doorKeys}, {@code sending}. */
    Map<String, Object> addresses() throws IOException, InterruptedException;

    /** {@code GET /v1/agent/keys/lookup?address=}: an address's published keys. */
    Map<String, Object> lookup(String address) throws IOException, InterruptedException;

    /** {@code POST /v1/agent/relay/drops}: reserves one drop of {@code bytes} (a drop bucket) for {@code to}. */
    Map<String, Object> reserveDrop(String to, long bytes) throws IOException, InterruptedException;

    /** {@code PUT}s exactly the drop's bytes to the presigned URL a reservation gave, with every header it named. */
    void upload(String url, Map<String, String> headers, byte[] bytes) throws IOException, InterruptedException;

    /** {@code POST /v1/agent/relay/send}, with an {@code Idempotency-Key}. */
    Map<String, Object> send(Map<String, Object> envelope, String idempotencyKey) throws IOException, InterruptedException;

    /** {@code GET /v1/agent/relay?after=&limit=}: a page, oldest first. */
    Map<String, Object> collect(String after, int limit) throws IOException, InterruptedException;

    /**
     * {@code GET}s a drop from its one-minute presigned link, at most {@code max} bytes; the stream must be closed. A drop is
     * read straight through the envelope library, never kept whole before it's checked.
     */
    InputStream download(String url, long max) throws IOException, InterruptedException;

    /** {@code POST /v1/agent/relay/ack}. */
    Map<String, Object> ack(List<String> ids) throws IOException, InterruptedException;

    /** {@code GET /v1/agent/relay/pending}: {@code {pending, oldestAt}}. */
    Map<String, Object> pending() throws IOException, InterruptedException;

    /**
     * {@code POST /v1/agent/devices/claim {userCode}} (relay.md 0.4.3): the code the member typed binds that device to this
     * desk and its member; the answer is the device's public keys.
     */
    default Map<String, Object> claimDevice(String userCode) throws IOException, InterruptedException {
        throw new Refused(404, "not_found", null);
    }

    /** {@code GET /v1/agent/keys}: this desk's own keys and its paired devices. */
    default Map<String, Object> ownKeys() throws IOException, InterruptedException {
        throw new Refused(404, "not_found", null);
    }

    /** {@code DELETE /v1/agent/keys/devices/{deviceId}}: the device goes, with its inbox. */
    default void deleteDevice(String deviceId) throws IOException, InterruptedException {
        throw new Refused(404, "not_found", null);
    }
}
