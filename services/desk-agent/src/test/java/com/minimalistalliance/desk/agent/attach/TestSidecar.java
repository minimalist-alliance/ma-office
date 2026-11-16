package com.minimalistalliance.desk.agent.attach;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * A stand-in for ADR 0097's sandbox in tests: a Unix socket at {@code <dir>/sock/parse.sock} that hands each connection
 * to a {@link Handler}. {@link #realWorker} is desk-svc's {@code -accept -conn-stdio} in miniature: per connection, the
 * real {@code ParseWorker --from-stream} with this JVM's classpath and {@code Parsers.WORKER_FLAGS}, the connection as its
 * stdin and stdout, an empty environment and its stderr discarded.
 */
final class TestSidecar implements AutoCloseable {

    /** What the stand-in does with one connection; it is closed afterwards. */
    interface Handler {
        void serve(SocketChannel connection) throws Exception;
    }

    final Path dir;
    final Path socket;
    final AtomicInteger connections = new AtomicInteger();
    private final ServerSocketChannel server;
    private final Thread acceptor;

    private TestSidecar(Path dir, Handler handler) throws IOException {
        this.dir = dir;
        Path sock = Files.createDirectories(dir.resolve("sock"));
        this.socket = sock.resolve("parse.sock");
        server = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        server.bind(UnixDomainSocketAddress.of(socket));
        acceptor = new Thread(() -> {
            while (server.isOpen()) {
                SocketChannel connection;
                try {
                    connection = server.accept();
                } catch (IOException e) {
                    return;
                }
                connections.incrementAndGet();
                Thread one = new Thread(() -> {
                    try (connection) {
                        handler.serve(connection);
                    } catch (Exception e) {
                        // The connection closes; the client sees what it got.
                    }
                }, "test-sidecar-conn");
                one.setDaemon(true);
                one.start();
            }
        }, "test-sidecar");
        acceptor.setDaemon(true);
        acceptor.start();
    }

    static TestSidecar serving(Path dir, Handler handler) throws IOException {
        return new TestSidecar(dir, handler);
    }

    /** The real worker per connection, as the sandbox runs {@code java @/app/parse.options}. */
    static TestSidecar realWorker(Path dir) throws IOException {
        return new TestSidecar(dir, TestSidecar::runWorker);
    }

    static void runWorker(SocketChannel connection) throws Exception {
        ProcessBuilder builder = new ProcessBuilder(Parsers.streamCommand());
        builder.environment().clear();
        builder.redirectError(ProcessBuilder.Redirect.DISCARD);
        Process worker = builder.start();
        try {
            Thread in = new Thread(() -> {
                try (OutputStream stdin = worker.getOutputStream()) {
                    ByteBuffer buffer = ByteBuffer.allocate(1 << 16);
                    while (connection.read(buffer) >= 0) {
                        stdin.write(buffer.array(), 0, buffer.position());
                        buffer.clear();
                    }
                } catch (IOException e) {
                    // The worker stopped reading, or the client went.
                }
            }, "test-sidecar-in");
            in.setDaemon(true);
            in.start();
            try (InputStream stdout = worker.getInputStream()) {
                byte[] chunk = new byte[1 << 16];
                int read;
                while ((read = stdout.read(chunk)) >= 0) {
                    ByteBuffer buffer = ByteBuffer.wrap(chunk, 0, read);
                    while (buffer.hasRemaining()) {
                        connection.write(buffer);
                    }
                }
            }
            worker.waitFor();
        } finally {
            worker.destroyForcibly();
        }
    }

    /** Reads what the client sends up to its half-close. */
    static byte[] readAll(SocketChannel connection) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        ByteBuffer buffer = ByteBuffer.allocate(1 << 16);
        while (connection.read(buffer) >= 0) {
            out.write(buffer.array(), 0, buffer.position());
            buffer.clear();
        }
        return out.toByteArray();
    }

    static void write(SocketChannel connection, String text) throws IOException {
        ByteBuffer buffer = ByteBuffer.wrap(text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        while (buffer.hasRemaining()) {
            connection.write(buffer);
        }
    }

    /** Stops listening; the socket file stays, as a stopped sandbox's would, so a connect is refused. */
    void stop() throws IOException {
        server.close();
    }

    @Override
    public void close() throws IOException {
        server.close();
        Files.deleteIfExists(socket);
    }
}
