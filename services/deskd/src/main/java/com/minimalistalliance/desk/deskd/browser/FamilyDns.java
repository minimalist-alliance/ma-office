package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Flow;

/**
 * Asks the family resolver a teen's Chromium uses whether it filters a host: RFC 8484, a POST of the DNS wire format, the
 * way Chromium asks it under the image's teen policy ({@code DnsOverHttpsTemplates}). For a name it filters, it answers
 * {@code 0.0.0.0} to A and {@code ::} to AAAA, with an extended error of 16 (Censored) or 17 (Filtered) beside it (checked
 * on 2026-11-07 against its own test names). Only the addresses are read here, as the brief for this asks.
 *
 * <p><b>What it's sent.</b> One name a teen's Chromium has just asked it about, in a query of message ID 0 (RFC 8484 4.1)
 * padded to 128 bytes (RFC 8467), and no cookie: the shared client keeps none. A second query, for AAAA, goes only when the
 * first has no address in it. Nothing here logs the name, and an exception never carries it.
 *
 * <p><b>Time.</b> Both queries share one deadline, and the shared client's {@link PlatformHttp#send} gives up on a
 * response that isn't whole by then.
 */
final class FamilyDns implements FilteredSites.Lookup {

    static final URI ENDPOINT = URI.create("https://family.cloudflare-dns.com/dns-query");
    /** What one look gets, both queries together. A teen sees Chromium's own page for this long at most. */
    static final Duration TIMEOUT = Duration.ofSeconds(2);
    /** A DNS message can't be longer. */
    static final int MAX_RESPONSE_BYTES = 65_535;

    static final int TYPE_A = 1;
    static final int TYPE_AAAA = 28;
    private static final int TYPE_OPT = 41;
    private static final int CLASS_IN = 1;
    private static final int RD = 0x0100;
    private static final int QR = 0x8000;
    private static final int TC = 0x0200;
    private static final int NXDOMAIN = 3;
    private static final int UDP_PAYLOAD = 1232;
    private static final int PADDING_OPTION = 12;
    private static final int PAD_BLOCK = 128;
    /** A name can't take more labels than this, compressed or not. */
    private static final int MAX_LABELS = 128;
    private static final String MEDIA_TYPE = "application/dns-message";

    /** What one answer's addresses say. */
    enum Addresses {
        /** No A or AAAA in it: NODATA, NXDOMAIN, or only a CNAME. */
        NONE,
        /** Only {@code 0.0.0.0} and {@code ::}: how the resolver filters. */
        UNSPECIFIED,
        /** At least one real address. */
        REAL
    }

    private final PlatformHttp http;
    private final URI endpoint;
    private final Duration timeout;

    FamilyDns(PlatformHttp http) {
        this(http, ENDPOINT, TIMEOUT);
    }

    FamilyDns(PlatformHttp http, URI endpoint, Duration timeout) {
        this.http = http;
        this.endpoint = endpoint;
        this.timeout = timeout;
    }

    /** @param host already through {@link FilteredSites#hostOf}: lower case, ASCII, no trailing dot */
    @Override
    public boolean filtered(String host) throws IOException, InterruptedException {
        long deadline = System.nanoTime() + timeout.toNanos();
        Addresses a = ask(host, TYPE_A, deadline);
        if (a != Addresses.NONE) {
            return a == Addresses.UNSPECIFIED;
        }
        return ask(host, TYPE_AAAA, deadline) == Addresses.UNSPECIFIED;
    }

    private Addresses ask(String host, int type, long deadline) throws IOException, InterruptedException {
        long left = deadline - System.nanoTime();
        if (left <= 0) {
            throw new HttpTimeoutException("no answer in time");
        }
        HttpRequest request = HttpRequest.newBuilder(endpoint)
                .POST(HttpRequest.BodyPublishers.ofByteArray(query(host, type)))
                .header("Content-Type", MEDIA_TYPE)
                .header("Accept", MEDIA_TYPE)
                .timeout(Duration.ofNanos(left))
                .build();
        HttpResponse<byte[]> response = http.send(request, info -> new BoundedBytes(), Duration.ofNanos(left));
        if (response.statusCode() != 200) {
            throw new IOException("status " + response.statusCode());
        }
        return addresses(response.body());
    }

    /** One question with an OPT record, its padding taking the message to a multiple of 128 bytes. */
    static byte[] query(String host, int type) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(PAD_BLOCK);
        writeShort(out, 0);
        writeShort(out, RD);
        writeShort(out, 1);
        writeShort(out, 0);
        writeShort(out, 0);
        writeShort(out, 1);
        for (String label : host.split("\\.", -1)) {
            byte[] bytes = label.getBytes(StandardCharsets.US_ASCII);
            if (bytes.length == 0 || bytes.length > 63) {
                throw new IllegalArgumentException("not a name");
            }
            out.write(bytes.length);
            out.writeBytes(bytes);
        }
        out.write(0);
        writeShort(out, type);
        writeShort(out, CLASS_IN);
        // OPT: root name, type, payload size, extended rcode and flags of 0, then the padding option.
        int unpadded = out.size() + 1 + 2 + 2 + 4 + 2 + 4;
        int pad = (PAD_BLOCK - unpadded % PAD_BLOCK) % PAD_BLOCK;
        out.write(0);
        writeShort(out, TYPE_OPT);
        writeShort(out, UDP_PAYLOAD);
        writeShort(out, 0);
        writeShort(out, 0);
        writeShort(out, 4 + pad);
        writeShort(out, PADDING_OPTION);
        writeShort(out, pad);
        out.writeBytes(new byte[pad]);
        return out.toByteArray();
    }

    /**
     * Believes nothing of the message but what it has to: a response, not cut short, with every length inside it.
     *
     * @throws IOException for anything else, or an answer the resolver couldn't give
     */
    static Addresses addresses(byte[] message) throws IOException {
        ByteBuffer in = ByteBuffer.wrap(message);
        if (message.length < 12) {
            throw new IOException("short message");
        }
        int flags = in.getShort(2) & 0xFFFF;
        if ((flags & QR) == 0 || (flags & TC) != 0) {
            throw new IOException("not a whole response");
        }
        int rcode = flags & 0xF;
        if (rcode == NXDOMAIN) {
            return Addresses.NONE;
        }
        if (rcode != 0) {
            throw new IOException("rcode " + rcode);
        }
        int questions = in.getShort(4) & 0xFFFF;
        int answers = in.getShort(6) & 0xFFFF;
        int at = 12;
        for (int i = 0; i < questions; i++) {
            at = skipName(message, at) + 4;
        }
        boolean any = false;
        boolean real = false;
        for (int i = 0; i < answers; i++) {
            at = skipName(message, at);
            if (at + 10 > message.length) {
                throw new IOException("record cut short");
            }
            int type = in.getShort(at) & 0xFFFF;
            int recordClass = in.getShort(at + 2) & 0xFFFF;
            int length = in.getShort(at + 8) & 0xFFFF;
            at += 10;
            if (at + length > message.length) {
                throw new IOException("record cut short");
            }
            boolean address = recordClass == CLASS_IN
                    && ((type == TYPE_A && length == 4) || (type == TYPE_AAAA && length == 16));
            if (address) {
                any = true;
                for (int b = at; b < at + length; b++) {
                    real |= message[b] != 0;
                }
            }
            at += length;
        }
        return !any ? Addresses.NONE : real ? Addresses.REAL : Addresses.UNSPECIFIED;
    }

    /** @return where the name that starts here ends */
    private static int skipName(byte[] message, int at) throws IOException {
        for (int labels = 0; labels < MAX_LABELS; labels++) {
            if (at >= message.length) {
                throw new IOException("name cut short");
            }
            int length = message[at] & 0xFF;
            if (length == 0) {
                return at + 1;
            }
            if ((length & 0xC0) == 0xC0) {
                if (at + 2 > message.length) {
                    throw new IOException("name cut short");
                }
                return at + 2;
            }
            if ((length & 0xC0) != 0) {
                throw new IOException("bad label");
            }
            at += 1 + length;
        }
        throw new IOException("name too long");
    }

    private static void writeShort(ByteArrayOutputStream out, int value) {
        out.write((value >> 8) & 0xFF);
        out.write(value & 0xFF);
    }

    /** The body, whole, or a failed request once it's past what a DNS message can be. */
    private static final class BoundedBytes implements HttpResponse.BodySubscriber<byte[]> {
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream(512);
        private final CompletableFuture<byte[]> result = new CompletableFuture<>();
        private Flow.Subscription subscription;

        @Override
        public CompletionStage<byte[]> getBody() {
            return result;
        }

        @Override
        public void onSubscribe(Flow.Subscription newSubscription) {
            subscription = newSubscription;
            subscription.request(1);
        }

        @Override
        public void onNext(List<ByteBuffer> buffers) {
            for (ByteBuffer buffer : buffers) {
                if (bytes.size() + buffer.remaining() > MAX_RESPONSE_BYTES) {
                    subscription.cancel();
                    result.completeExceptionally(new IOException("body over the limit"));
                    return;
                }
                byte[] chunk = new byte[buffer.remaining()];
                buffer.get(chunk);
                bytes.writeBytes(chunk);
            }
            subscription.request(1);
        }

        @Override
        public void onError(Throwable error) {
            result.completeExceptionally(error);
        }

        @Override
        public void onComplete() {
            result.complete(bytes.toByteArray());
        }
    }
}
