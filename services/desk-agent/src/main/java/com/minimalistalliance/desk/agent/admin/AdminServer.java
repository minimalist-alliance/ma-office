package com.minimalistalliance.desk.agent.admin;

import com.minimalistalliance.desk.agent.json.Json;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Semaphore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * GET /health on a Unix socket, the only HTTP desk-agent serves, in deskd's style (desk-runtime.md
 * section 6): one route, strict limits and no web server. The socket's mode is 0600, so only the
 * agent user and root, for the health script, can reach it. A copy of deskd's {@code AdminServer}
 * without its rtc and Platform fields, until the services share a module (STATUS.md).
 */
public final class AdminServer implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(AdminServer.class);

    static final int MAX_REQUEST_BYTES = 4096;
    static final int MAX_CONNECTIONS = 8;
    static final Duration READ_TIMEOUT = Duration.ofSeconds(2);

    /** What the route reports. */
    public interface Health {
        /** False only when desk-agent itself can't work: its data or databases. */
        boolean healthy();

        String version();

        /** More fields for the body, for information only. They never decide the status. */
        default Map<String, Object> details() {
            return Map.of();
        }
    }

    private final Path socket;
    private final Health health;
    private final Duration readTimeout;
    private final Semaphore slots = new Semaphore(MAX_CONNECTIONS);
    private ServerSocketChannel server;
    private Thread acceptor;
    private volatile boolean closed;

    public AdminServer(Path socket, Health health) {
        this(socket, health, READ_TIMEOUT);
    }

    AdminServer(Path socket, Health health, Duration readTimeout) {
        this.socket = socket;
        this.health = health;
        this.readTimeout = readTimeout;
    }

    /**
     * Binds the socket. A stale file from a previous run is replaced. The new socket gets its mode
     * under a temporary name and only then takes the real one, so it's never reachable at a wider
     * mode.
     *
     * @throws IOException if the socket can't be created, in which case desk-agent can't report
     *     health and shouldn't start
     */
    public void start() throws IOException {
        Path temporary = socket.resolveSibling(socket.getFileName() + ".new");
        Files.deleteIfExists(temporary);
        Files.deleteIfExists(socket);
        server = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        server.bind(UnixDomainSocketAddress.of(temporary));
        Files.setPosixFilePermissions(temporary, PosixFilePermissions.fromString("rw-------"));
        Files.move(temporary, socket, StandardCopyOption.ATOMIC_MOVE);
        acceptor = Thread.ofVirtual().name("admin-acceptor").start(this::acceptLoop);
    }

    @Override
    public void close() {
        closed = true;
        try {
            if (server != null) {
                server.close();
            }
            Files.deleteIfExists(socket);
        } catch (IOException e) {
            log.debug("closing the admin socket failed");
        }
        if (acceptor != null) {
            acceptor.interrupt();
        }
    }

    private void acceptLoop() {
        while (!closed) {
            try {
                SocketChannel client = server.accept();
                if (slots.tryAcquire()) {
                    Thread.ofVirtual().name("admin-connection").start(() -> serve(client));
                } else {
                    client.close();
                }
            } catch (IOException e) {
                if (!closed) {
                    log.warn("admin socket accept failed: {}", e.getClass().getSimpleName());
                    pause();
                }
            }
        }
    }

    private static void pause() {
        try {
            Thread.sleep(100);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private void serve(SocketChannel client) {
        // Closing the channel is what ends a read that's taking too long.
        Thread watchdog = Thread.ofVirtual().name("admin-timeout").start(() -> {
            try {
                Thread.sleep(readTimeout);
                closeQuietly(client);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        try (client) {
            write(client, respond(readHead(client)));
        } catch (IOException e) {
            log.debug("admin connection ended early: {}", e.getClass().getSimpleName());
        } finally {
            watchdog.interrupt();
            slots.release();
        }
    }

    /** @return the bytes up to the blank line, or null if there are too many before one */
    private static String readHead(SocketChannel client) throws IOException {
        ByteBuffer buffer = ByteBuffer.allocate(MAX_REQUEST_BYTES + 1);
        while (buffer.hasRemaining()) {
            if (client.read(buffer) < 0) {
                throw new IOException("closed before the request ended");
            }
            String sofar = new String(buffer.array(), 0, buffer.position(), StandardCharsets.ISO_8859_1);
            int end = sofar.indexOf("\r\n\r\n");
            if (end >= 0) {
                return sofar.substring(0, end);
            }
        }
        return null;
    }

    /** Package-private so the routing can be tested without a socket. */
    byte[] respond(String head) {
        if (head == null) {
            return plain(431, "Request Header Fields Too Large", "");
        }
        String requestLine = head.lines().findFirst().orElse("");
        String[] parts = requestLine.split(" ");
        if (parts.length != 3 || !parts[2].startsWith("HTTP/1.")) {
            return plain(400, "Bad Request", "");
        }
        if (!parts[1].equals("/health")) {
            return plain(404, "Not Found", "");
        }
        if (!parts[0].equals("GET")) {
            return plain(405, "Method Not Allowed", "Allow: GET\r\n");
        }
        boolean healthy = isHealthy();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", healthy ? "ok" : "failing");
        body.put("version", health.version());
        addDetails(body);
        byte[] json = Json.bytes(body);
        String status = healthy ? "200 OK" : "503 Service Unavailable";
        String headers = "HTTP/1.1 " + status + "\r\nContent-Type: application/json\r\nContent-Length: "
                + json.length + "\r\nConnection: close\r\n\r\n";
        byte[] headerBytes = headers.getBytes(StandardCharsets.ISO_8859_1);
        byte[] response = new byte[headerBytes.length + json.length];
        System.arraycopy(headerBytes, 0, response, 0, headerBytes.length);
        System.arraycopy(json, 0, response, headerBytes.length, json.length);
        return response;
    }

    private void addDetails(Map<String, Object> body) {
        try {
            body.putAll(health.details());
        } catch (RuntimeException e) {
            log.error("health details failed: {}", e.getClass().getName());
        }
    }

    private boolean isHealthy() {
        try {
            return health.healthy();
        } catch (RuntimeException e) {
            log.error("health check failed: {}", e.getClass().getName());
            return false;
        }
    }

    private static byte[] plain(int code, String reason, String extraHeaders) {
        String response = "HTTP/1.1 " + code + " " + reason + "\r\n" + extraHeaders
                + "Content-Length: 0\r\nConnection: close\r\n\r\n";
        return response.getBytes(StandardCharsets.ISO_8859_1);
    }

    private static void write(SocketChannel client, byte[] response) throws IOException {
        ByteBuffer buffer = ByteBuffer.wrap(response);
        while (buffer.hasRemaining()) {
            client.write(buffer);
        }
    }

    private static void closeQuietly(SocketChannel client) {
        try {
            client.close();
        } catch (IOException e) {
            log.debug("closing an admin connection failed");
        }
    }
}
