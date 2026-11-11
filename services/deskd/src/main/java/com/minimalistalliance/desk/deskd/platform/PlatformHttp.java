package com.minimalistalliance.desk.deskd.platform;

import java.io.IOException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.locks.ReentrantLock;

/**
 * The one HTTP and WebSocket client, shared by IMDS, the API, JWKS and the gateway. It's built on the
 * first call rather than with the beans, because building it loads TLS and the CA list, which is
 * tens of milliseconds that the boot thread can pay without holding up the admin socket.
 */
public final class PlatformHttp implements AutoCloseable {

    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(5);

    /**
     * The longest deskd honours a {@code Retry-After} from the Platform or the gateway: past it, it asks again anyway. A
     * slip on the other side (an hour, a year) mustn't silence a desk; 5 minutes is the fleet's unhealthy mark (agent.md).
     */
    public static final Duration MAX_RETRY_AFTER = Duration.ofMinutes(5);

    private final ReentrantLock lock = new ReentrantLock();
    private HttpClient client;
    private ExecutorService executor;

    public HttpClient client() {
        lock.lock();
        try {
            if (client == null) {
                executor = Executors.newVirtualThreadPerTaskExecutor();
                client = HttpClient.newBuilder()
                        .version(HttpClient.Version.HTTP_1_1)
                        .followRedirects(HttpClient.Redirect.NEVER)
                        .connectTimeout(CONNECT_TIMEOUT)
                        .executor(executor)
                        .build();
            }
            return client;
        } finally {
            lock.unlock();
        }
    }

    /**
     * One request, with the whole response inside the timeout. On JDK 21 {@code HttpRequest.timeout}
     * stops once the headers arrive and the client sets no TCP keepalive, so {@code HttpClient.send}
     * would wait for ever on a body that stalls. Giving up cancels the exchange, which closes its
     * connection. Every request except the gateway's WebSocket goes through here.
     *
     * @throws HttpTimeoutException if the whole response hasn't arrived in time
     */
    public <T> HttpResponse<T> send(HttpRequest request, HttpResponse.BodyHandler<T> body, Duration timeout)
            throws IOException, InterruptedException {
        CompletableFuture<HttpResponse<T>> response = client().sendAsync(request, body);
        try {
            return response.get(timeout.toNanos(), TimeUnit.NANOSECONDS);
        } catch (TimeoutException e) {
            response.cancel(true);
            throw new HttpTimeoutException("no complete response in time");
        } catch (InterruptedException e) {
            response.cancel(true);
            throw e;
        } catch (ExecutionException e) {
            throw e.getCause() instanceof IOException cause ? cause : new IOException("request failed", e.getCause());
        }
    }

    /**
     * {@code Retry-After} in whole seconds, the form the Platform and the gateway send, held to {@link #MAX_RETRY_AFTER}.
     *
     * @return null if there's none, or it isn't a whole number of seconds (an HTTP date is read as none)
     */
    public static Duration retryAfter(java.net.http.HttpHeaders headers) {
        String value = headers.firstValue("retry-after").map(String::trim).orElse("");
        if (value.isEmpty() || !value.chars().allMatch(c -> c >= '0' && c <= '9')) {
            return null;
        }
        long seconds = value.length() > 18 ? Long.MAX_VALUE : Long.parseLong(value);
        return seconds >= MAX_RETRY_AFTER.toSeconds() ? MAX_RETRY_AFTER : Duration.ofSeconds(seconds);
    }

    @Override
    public void close() {
        lock.lock();
        try {
            if (client != null) {
                client.shutdownNow();
                executor.shutdownNow();
            }
        } finally {
            lock.unlock();
        }
    }
}
