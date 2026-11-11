package com.minimalistalliance.desk.agent.provider.http;

import com.minimalistalliance.desk.agent.provider.ProviderException;
import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.InetSocketAddress;
import java.net.ProxySelector;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpConnectTimeoutException;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The one HTTP client the provider adapters share: the JDK's, HTTP/1.1, no redirects, through deskd's egress proxy
 * when one is set (design 9.8). HTTP/1.1 because HTTP/2's header compression keeps header values, the key included,
 * in a table for the connection's life.
 *
 * <p>On JDK 21 a request's timeout stops at the response headers, so a stream that stalls would block for ever.
 * {@link #open} answers with a {@link Stream} whose reads are watched: no byte for {@code idleTimeout} interrupts
 * the reading thread, and the stream says it timed out. An interrupt from elsewhere, a run being stopped, ends a read
 * the same way.
 */
public final class HttpTransport {

    /** How long to wait: for a connection, for the response's headers, and between bytes of its body. */
    public record Timeouts(Duration connect, Duration headers, Duration idle) {

        public static final Timeouts DEFAULT =
                new Timeouts(Duration.ofSeconds(10), Duration.ofSeconds(120), Duration.ofSeconds(90));
    }

    private final HttpClient client;
    private final Timeouts timeouts;

    /** @param proxy deskd's egress proxy, or null to connect directly */
    public HttpTransport(Timeouts timeouts, InetSocketAddress proxy) {
        this.timeouts = timeouts;
        HttpClient.Builder builder = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .followRedirects(HttpClient.Redirect.NEVER)
                .connectTimeout(timeouts.connect());
        if (proxy != null) {
            builder.proxy(ProxySelector.of(proxy));
        }
        client = builder.build();
    }

    /**
     * A provider's base URL from a setting: {@code https}, or {@code http} only to loopback, for a stand-in. A key
     * never goes anywhere in clear text but this machine.
     *
     * @throws IllegalArgumentException otherwise
     */
    public static URI baseUri(String url) {
        URI uri = URI.create(url.endsWith("/") ? url.substring(0, url.length() - 1) : url);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost() == null ? "" : uri.getHost();
        boolean loopback = host.equals("127.0.0.1") || host.equals("localhost") || host.equals("[::1]");
        if (!(scheme.equals("https") || (scheme.equals("http") && loopback)) || uri.getRawQuery() != null
                || uri.getUserInfo() != null) {
            throw new IllegalArgumentException("a provider URL is https, or http to loopback");
        }
        return uri;
    }

    public HttpRequest.Builder request(URI uri) {
        return HttpRequest.newBuilder(uri).timeout(timeouts.headers());
    }

    /**
     * Sends the request and waits for the response's headers.
     *
     * @throws ProviderException {@code UNAVAILABLE} if nothing could be sent (not billed), {@code TIMEOUT} if no
     *     headers came in time, {@code CANCELLED} if this thread was interrupted (both possibly billed)
     */
    public Stream open(HttpRequest request) throws ProviderException {
        try {
            HttpResponse<InputStream> response = client.send(request, HttpResponse.BodyHandlers.ofInputStream());
            return new Stream(response.statusCode(), response.body(), timeouts.idle(), response.headers());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ProviderException(ProviderException.Kind.CANCELLED, true);
        } catch (HttpConnectTimeoutException | ConnectException e) {
            throw new ProviderException(ProviderException.Kind.UNAVAILABLE, false);
        } catch (HttpTimeoutException e) {
            throw new ProviderException(ProviderException.Kind.TIMEOUT, true);
        } catch (IOException e) {
            throw new ProviderException(ProviderException.Kind.UNAVAILABLE, true);
        }
    }

    /** A response's status and body, the body read under the idle watchdog. Close it when done. */
    public static final class Stream extends InputStream {
        private final int status;
        private final InputStream body;
        private final java.net.http.HttpHeaders headers;
        private volatile Duration idle;
        private final Thread reader = Thread.currentThread();
        private final AtomicLong lastProgress = new AtomicLong(System.nanoTime());
        private final AtomicBoolean timedOut = new AtomicBoolean();
        private final AtomicBoolean closed = new AtomicBoolean();
        private final Thread watchdog;

        Stream(int status, InputStream body, Duration idle, java.net.http.HttpHeaders headers) {
            this.status = status;
            this.body = body;
            this.headers = headers;
            this.idle = idle;
            watchdog = Thread.ofVirtual().name("http-idle").start(this::watch);
        }

        public int status() {
            return status;
        }

        /** A response header's first value, or null: OpenRouter's rate-limit headers say which limit a 429 is. */
        public String header(String name) {
            return headers == null ? null : headers.firstValue(name).orElse(null);
        }

        /**
         * Allows this long without a byte from now on. A reasoning step may stream nothing while the model thinks, so
         * the adapters lengthen the wait while one is open and set it back once text or a call starts.
         */
        public void idle(Duration longer) {
            idle = longer;
            lastProgress.set(System.nanoTime());
        }

        /** Whether the watchdog ended a read, as against an interrupt from elsewhere. */
        public boolean timedOut() {
            return timedOut.get();
        }

        private void watch() {
            try {
                while (!closed.get()) {
                    long idleNanos = idle.toNanos();
                    long waited = System.nanoTime() - lastProgress.get();
                    if (waited >= idleNanos) {
                        timedOut.set(true);
                        reader.interrupt();
                        return;
                    }
                    Thread.sleep(Duration.ofNanos(Math.max(idleNanos - waited, 1_000_000)));
                }
            } catch (InterruptedException e) {
                // Closed.
            }
        }

        @Override
        public int read() throws IOException {
            int b = body.read();
            lastProgress.set(System.nanoTime());
            return b;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            int n = body.read(buffer, offset, length);
            lastProgress.set(System.nanoTime());
            return n;
        }

        /** Reads and drops up to {@code limit} bytes of an error's body, so the connection can be reused. */
        public void drain(int limit) {
            try {
                body.readNBytes(limit);
            } catch (IOException e) {
                // It's being thrown away anyway.
            }
        }

        @Override
        public void close() {
            if (closed.compareAndSet(false, true)) {
                watchdog.interrupt();
                try {
                    body.close();
                } catch (IOException e) {
                    // Nothing more to do with it.
                }
            }
        }
    }

    /**
     * What a failed HTTP status means. None is billed: the provider refused before generating.
     *
     * @return the kind, for a status that isn't 2xx
     */
    public static ProviderException statusError(int status) {
        ProviderException.Kind kind;
        if (status == 401 || status == 403) {
            kind = ProviderException.Kind.AUTH;
        } else if (status == 429) {
            kind = ProviderException.Kind.RATE_LIMITED;
        } else if (status == 408 || status == 504) {
            kind = ProviderException.Kind.TIMEOUT;
        } else if (status >= 500) {
            kind = ProviderException.Kind.UNAVAILABLE;
        } else {
            kind = ProviderException.Kind.BAD_REQUEST;
        }
        return new ProviderException(kind, false);
    }

    /**
     * What an exception while reading a body means: the watchdog's timeout, a stop, or a cut connection. All may
     * have been billed, as the provider had started.
     */
    public static ProviderException readError(Stream stream) {
        if (stream.timedOut()) {
            Thread.interrupted();
            return new ProviderException(ProviderException.Kind.TIMEOUT, true);
        }
        if (Thread.currentThread().isInterrupted()) {
            return new ProviderException(ProviderException.Kind.CANCELLED, true);
        }
        return new ProviderException(ProviderException.Kind.UNAVAILABLE, true);
    }
}
