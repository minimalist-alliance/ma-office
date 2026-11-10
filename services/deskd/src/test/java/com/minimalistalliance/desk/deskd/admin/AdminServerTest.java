package com.minimalistalliance.desk.deskd.admin;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.testing.TestTiming;
import java.io.IOException;
import java.net.SocketException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class AdminServerTest {

    static {
        TestTiming.pollFast();
    }

    @TempDir
    Path dir;

    private Path socket;
    private AdminServer server;
    private final FakeHealth health = new FakeHealth();

    private static final class FakeHealth implements AdminServer.Health {
        volatile boolean healthy = true;
        volatile boolean rtc = true;
        volatile boolean platform = true;

        @Override
        public boolean healthy() {
            return healthy;
        }

        @Override
        public boolean rtcConnected() {
            return rtc;
        }

        @Override
        public boolean platformOk() {
            return platform;
        }

        @Override
        public String version() {
            return "1.2.3";
        }
    }

    @BeforeEach
    void setUp() throws IOException {
        socket = dir.resolve("deskd-admin.sock");
        server = new AdminServer(socket, health, Duration.ofMillis(300));
        server.start();
    }

    @AfterEach
    void tearDown() {
        server.close();
    }

    private SocketChannel connect() throws IOException {
        SocketChannel channel = SocketChannel.open(StandardProtocolFamily.UNIX);
        channel.connect(UnixDomainSocketAddress.of(socket));
        return channel;
    }

    /** Sends the bytes and reads until deskd closes. */
    private String exchange(String request) throws IOException {
        try (SocketChannel channel = connect()) {
            channel.write(ByteBuffer.wrap(request.getBytes(StandardCharsets.ISO_8859_1)));
            return readToEnd(channel);
        }
    }

    private static String readToEnd(SocketChannel channel) throws IOException {
        ByteBuffer buffer = ByteBuffer.allocate(8192);
        while (channel.read(buffer) >= 0) {
            if (!buffer.hasRemaining()) {
                buffer = ByteBuffer.allocate(buffer.capacity() * 2).put(buffer.flip());
            }
        }
        return new String(buffer.array(), 0, buffer.position(), StandardCharsets.ISO_8859_1);
    }

    private String get() throws IOException {
        return exchange("GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n");
    }

    @Test
    void healthyIs200WithTheAgreedBody() throws IOException {
        String response = get();
        assertThat(response).startsWith("HTTP/1.1 200 OK\r\n").contains("Content-Type: application/json\r\n", "Connection: close\r\n");
        assertThat(response).endsWith("\r\n\r\n{\"status\":\"ok\",\"version\":\"1.2.3\",\"rtc\":\"connected\",\"platform\":\"ok\"}");
    }

    @Test
    void contentLengthMatchesTheBody() throws IOException {
        String response = get();
        String body = response.substring(response.indexOf("\r\n\r\n") + 4);
        assertThat(response).contains("Content-Length: " + body.length() + "\r\n");
    }

    @Test
    void lostLinksAreReportedButNeverFailHealth() throws IOException {
        health.rtc = false;
        health.platform = false;
        assertThat(get())
                .startsWith("HTTP/1.1 200 OK")
                .endsWith("{\"status\":\"ok\",\"version\":\"1.2.3\",\"rtc\":\"disconnected\",\"platform\":\"degraded\"}");
    }

    @Test
    void only503WhenDeskdItselfIsBroken() throws IOException {
        health.healthy = false;
        assertThat(get()).startsWith("HTTP/1.1 503 ").contains("\"status\":\"failing\"");
    }

    @Test
    void anOtherPathIs404() throws IOException {
        assertThat(exchange("GET /other HTTP/1.1\r\n\r\n")).startsWith("HTTP/1.1 404 ");
        assertThat(exchange("GET /health/ HTTP/1.1\r\n\r\n")).startsWith("HTTP/1.1 404 ");
        assertThat(exchange("GET /health?x=1 HTTP/1.1\r\n\r\n")).startsWith("HTTP/1.1 404 ");
        assertThat(exchange("POST /other HTTP/1.1\r\n\r\n")).startsWith("HTTP/1.1 404 ");
    }

    @Test
    void anOtherMethodIs405() throws IOException {
        assertThat(exchange("POST /health HTTP/1.1\r\nContent-Length: 0\r\n\r\n"))
                .startsWith("HTTP/1.1 405 ")
                .contains("Allow: GET\r\n");
        assertThat(exchange("HEAD /health HTTP/1.1\r\n\r\n")).startsWith("HTTP/1.1 405 ");
        assertThat(exchange("DELETE /health HTTP/1.1\r\n\r\n")).startsWith("HTTP/1.1 405 ");
    }

    @Test
    void garbageIs400() throws IOException {
        assertThat(exchange("nonsense\r\n\r\n")).startsWith("HTTP/1.1 400 ");
        assertThat(exchange("GET /health\r\n\r\n")).startsWith("HTTP/1.1 400 ");
        assertThat(exchange("GET /health SPDY/3\r\n\r\n")).startsWith("HTTP/1.1 400 ");
    }

    @Test
    void oneByteOverTheLimitIs431() throws IOException {
        String head = "GET /health HTTP/1.1\r\nX-Junk: ";
        assertThat(exchange(head + "a".repeat(AdminServer.MAX_REQUEST_BYTES + 1 - head.length())))
                .startsWith("HTTP/1.1 431 ");
    }

    @Test
    void aMuchLargerRequestIsNeverReadInFull() throws IOException {
        // A Unix socket closed with bytes unread reaches the client as a reset, and that's fine:
        // what matters is that deskd stops reading at the limit and still serves the next request.
        String huge = "GET /health HTTP/1.1\r\nX-Junk: " + "a".repeat(64 * 1024) + "\r\n\r\n";
        try {
            assertThat(exchange(huge)).startsWith("HTTP/1.1 431 ");
        } catch (SocketException e) {
            assertThat(e).hasMessageContaining("reset");
        }
        assertThat(get()).startsWith("HTTP/1.1 200 ");
    }

    @Test
    void aRequestAtTheLimitIsRead() throws IOException {
        String head = "GET /health HTTP/1.1\r\nX-Junk: ";
        String padded = head + "a".repeat(AdminServer.MAX_REQUEST_BYTES - head.length() - 4) + "\r\n\r\n";
        assertThat(padded).hasSize(AdminServer.MAX_REQUEST_BYTES);
        assertThat(exchange(padded)).startsWith("HTTP/1.1 200 ");
    }

    @Test
    void aSlowClientIsCutOff() throws IOException {
        try (SocketChannel channel = connect()) {
            channel.write(ByteBuffer.wrap("GET /hea".getBytes(StandardCharsets.ISO_8859_1)));
            long start = System.nanoTime();
            assertThat(readToEnd(channel)).isEmpty();
            assertThat(Duration.ofNanos(System.nanoTime() - start))
                    .isGreaterThanOrEqualTo(Duration.ofMillis(250))
                    .isLessThan(Duration.ofSeconds(5));
        }
    }

    @Test
    void connectionsAreLimited() throws IOException {
        List<SocketChannel> idle = new ArrayList<>();
        try {
            for (int i = 0; i < AdminServer.MAX_CONNECTIONS; i++) {
                idle.add(connect());
            }
            // Past the limit, a connection closes without a reply, until a slot comes free.
            await().atMost(Duration.ofSeconds(5)).until(() -> {
                try (SocketChannel extra = connect()) {
                    extra.write(ByteBuffer.wrap("GET /health HTTP/1.1\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1)));
                    return !readToEnd(extra).isEmpty();
                } catch (IOException e) {
                    return false;
                }
            });
        } finally {
            for (SocketChannel channel : idle) {
                channel.close();
            }
        }
        assertThat(get()).startsWith("HTTP/1.1 200 ");
    }

    @Test
    void theSocketIsOwnerOnly() throws IOException {
        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(socket, LinkOption.NOFOLLOW_LINKS)))
                .isEqualTo("rw-------");
    }

    @Test
    void aStaleSocketFileIsReplaced() throws IOException {
        server.close();
        Path stale = dir.resolve("stale.sock");
        try (ServerSocketChannel old = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            old.bind(UnixDomainSocketAddress.of(stale));
        }
        assertThat(stale).exists();
        Path leftover = dir.resolve("stale.sock.new");
        Files.writeString(leftover, "left by a crash");
        socket = stale;
        server = new AdminServer(stale, health, Duration.ofMillis(300));
        server.start();
        assertThat(get()).startsWith("HTTP/1.1 200 ");
        assertThat(leftover).doesNotExist();
    }

    @Test
    void closingRemovesTheSocketFile() {
        assertThat(socket).exists();
        server.close();
        assertThat(socket).doesNotExist();
    }

    @Test
    void detailsAreAddedAndCantFailHealth() throws IOException {
        boolean[] broken = new boolean[1];
        AdminServer details = new AdminServer(dir.resolve("details.sock"), new AdminServer.Health() {
            @Override
            public boolean healthy() {
                return true;
            }

            @Override
            public boolean rtcConnected() {
                return true;
            }

            @Override
            public boolean platformOk() {
                return true;
            }

            @Override
            public String version() {
                return "1";
            }

            @Override
            public Map<String, Object> details() {
                if (broken[0]) {
                    throw new IllegalStateException("no");
                }
                return Map.of("browser", Map.of("cdp", "idle"));
            }
        }, Duration.ofMillis(300));
        String head = "GET /health HTTP/1.1\r\n";
        assertThat(new String(details.respond(head), StandardCharsets.ISO_8859_1))
                .contains("200 OK", "\"browser\":{\"cdp\":\"idle\"}");
        broken[0] = true;
        assertThat(new String(details.respond(head), StandardCharsets.ISO_8859_1)).contains("200 OK").doesNotContain("browser");
    }

    @Test
    void aHealthCheckThatThrowsIsBroken() throws IOException {
        server.close();
        server = new AdminServer(socket, new AdminServer.Health() {
            @Override
            public boolean healthy() {
                throw new IllegalStateException("oops");
            }

            @Override
            public boolean rtcConnected() {
                return false;
            }

            @Override
            public boolean platformOk() {
                return false;
            }

            @Override
            public String version() {
                return "1.2.3";
            }
        }, Duration.ofMillis(300));
        server.start();
        assertThat(get()).startsWith("HTTP/1.1 503 ");
    }

    @Test
    void aSocketThatCantBeCreatedFailsStart() {
        AdminServer broken = new AdminServer(dir.resolve("no/such/dir/admin.sock"), health);
        assertThatThrownBy(broken::start).isInstanceOf(IOException.class);
    }
}
