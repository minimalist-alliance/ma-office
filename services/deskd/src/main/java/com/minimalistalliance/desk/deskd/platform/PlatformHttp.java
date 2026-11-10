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
