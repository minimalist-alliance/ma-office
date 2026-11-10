package com.minimalistalliance.desk.agent.admin;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.testing.Health;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class AdminServerTest {

    @TempDir
    Path dir;

    private Path socket;
    private AdminServer server;
    private volatile boolean healthy = true;

    @BeforeEach
    void start() throws Exception {
        socket = dir.resolve("admin.sock");
        Files.writeString(socket, "stale");
        server = new AdminServer(socket, new AdminServer.Health() {
            @Override
            public boolean healthy() {
                return healthy;
            }

            @Override
            public String version() {
                return "1.2.3";
            }

            @Override
            public Map<String, Object> details() {
                return Map.of("manager", "no_key");
            }
        });
        server.start();
    }

    @AfterEach
    void stop() {
        server.close();
    }

    @Test
    void healthAnswersOnAnOwnerOnlySocketThatReplacedTheStaleFile() throws Exception {
        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(socket))).isEqualTo("rw-------");
        assertThat(Health.get(socket))
                .startsWith("HTTP/1.1 200 OK\r\n")
                .contains("Content-Type: application/json")
                .endsWith("{\"status\":\"ok\",\"version\":\"1.2.3\",\"manager\":\"no_key\"}");
        healthy = false;
        assertThat(Health.get(socket)).startsWith("HTTP/1.1 503 ").contains("\"status\":\"failing\"");
    }

    @Test
    void onlyGetHealthIsServed() throws Exception {
        assertThat(Health.request(socket, "GET /other HTTP/1.1\r\n\r\n")).startsWith("HTTP/1.1 404 ");
        assertThat(Health.request(socket, "POST /health HTTP/1.1\r\n\r\n")).startsWith("HTTP/1.1 405 ");
        assertThat(Health.request(socket, "nonsense\r\n\r\n")).startsWith("HTTP/1.1 400 ");
        // A head past the limit; the socket would reset under the unread rest, so routing is asked directly.
        assertThat(new String(server.respond(null), java.nio.charset.StandardCharsets.ISO_8859_1))
                .startsWith("HTTP/1.1 431 ");
    }

    @Test
    void closingRemovesTheSocket() {
        server.close();
        assertThat(socket).doesNotExist();
    }
}
