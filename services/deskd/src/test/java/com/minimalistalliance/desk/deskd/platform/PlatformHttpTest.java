package com.minimalistalliance.desk.deskd.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class PlatformHttpTest {

    private ServerSocket server;
    private PlatformHttp http;

    @BeforeEach
    void setUp() throws IOException {
        server = new ServerSocket(0, 8, InetAddress.getLoopbackAddress());
        http = new PlatformHttp();
    }

    @AfterEach
    void tearDown() throws IOException {
        http.close();
        server.close();
    }

    private HttpRequest request() {
        return HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + server.getLocalPort() + "/x")).GET().build();
    }

    /** Sends the response head and part of a body, then stays silent, and reports when the client hangs up. */
    private CompletableFuture<Void> stallAfterHeaders() {
        CompletableFuture<Void> hungUp = new CompletableFuture<>();
        Thread.ofVirtual().start(() -> {
            try (Socket socket = server.accept()) {
                socket.getOutputStream().write(
                        "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nab".getBytes(StandardCharsets.ISO_8859_1));
                socket.getOutputStream().flush();
                while (socket.getInputStream().read() >= 0) {
                    // The request itself, then the end of the stream once the client gives up.
                }
                hungUp.complete(null);
            } catch (IOException e) {
                hungUp.complete(null);
            }
        });
        return hungUp;
    }

    @Test
    void aBodyThatStallsTimesOutAndTheConnectionIsClosed() throws Exception {
        CompletableFuture<Void> hungUp = stallAfterHeaders();
        long started = System.nanoTime();
        assertThatThrownBy(() -> http.send(request(), HttpResponse.BodyHandlers.ofByteArray(), Duration.ofMillis(200)))
                .isInstanceOf(HttpTimeoutException.class);
        assertThat(Duration.ofNanos(System.nanoTime() - started))
                .isGreaterThanOrEqualTo(Duration.ofMillis(200))
                .isLessThan(Duration.ofSeconds(3));
        // No connection is left behind for each stall.
        hungUp.get(5, TimeUnit.SECONDS);
    }

    @Test
    void beingInterruptedCancelsTheRequestToo() throws Exception {
        CompletableFuture<Void> hungUp = stallAfterHeaders();
        CompletableFuture<Throwable> outcome = new CompletableFuture<>();
        Thread caller = Thread.ofVirtual().start(() -> {
            try {
                http.send(request(), HttpResponse.BodyHandlers.ofByteArray(), Duration.ofMinutes(1));
                outcome.complete(null);
            } catch (IOException | InterruptedException e) {
                outcome.complete(e);
            }
        });
        Thread.sleep(200);
        caller.interrupt();
        assertThat(outcome.get(5, TimeUnit.SECONDS)).isInstanceOf(InterruptedException.class);
        hungUp.get(5, TimeUnit.SECONDS);
    }

    @Test
    void aCompleteResponseIsReturned() throws Exception {
        Thread.ofVirtual().start(() -> {
            try (Socket socket = server.accept()) {
                socket.getInputStream().read();
                socket.getOutputStream().write(
                        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".getBytes(StandardCharsets.ISO_8859_1));
                socket.getOutputStream().flush();
            } catch (IOException e) {
                // The assertion below reports it.
            }
        });
        HttpResponse<String> response = http.send(request(), HttpResponse.BodyHandlers.ofString(), Duration.ofSeconds(5));
        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.body()).isEqualTo("ok");
    }

    @Test
    void aFailureToConnectIsAnIoException() throws Exception {
        int port;
        try (ServerSocket gone = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            port = gone.getLocalPort();
        }
        HttpRequest request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/x")).GET().build();
        assertThatThrownBy(() -> http.send(request, HttpResponse.BodyHandlers.ofByteArray(), Duration.ofSeconds(5)))
                .isInstanceOf(IOException.class);
    }
}
