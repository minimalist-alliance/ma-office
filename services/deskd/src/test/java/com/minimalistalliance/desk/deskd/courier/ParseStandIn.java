package com.minimalistalliance.desk.deskd.courier;

import com.minimalistalliance.desk.courier.parse.CourierWorker;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.channels.Channels;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;

/**
 * The Courier sandbox's socket, in tests: one connection at a time, as {@code desk-svc -max-conn 1} serves it. By default
 * each connection runs the real Courier mode ({@link CourierWorker#serve}) in this JVM, as the sandbox's worker would in
 * its own; a script can answer instead, for the failures a sandbox can have ({@code err busy}, a worker killed, a hang,
 * a hostile answer).
 */
final class ParseStandIn implements AutoCloseable {

    /** What a scripted connection does: given the request's bytes (line included), the bytes to answer, or null to hang. */
    interface Script extends Function<byte[], byte[]> {}

    final Path socket;
    final AtomicInteger connections = new AtomicInteger();
    private final ServerSocketChannel server;
    private final Thread acceptor;
    private volatile Script script;
    private volatile long workerMillis = 10_000;

    ParseStandIn(Path dir) throws IOException {
        Files.createDirectories(dir);
        socket = dir.resolve("parse.sock");
        server = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        server.bind(UnixDomainSocketAddress.of(socket));
        acceptor = Thread.ofVirtual().start(this::accept);
    }

    /** Scripted answers from now on; null goes back to the real worker. */
    ParseStandIn script(Script s) {
        this.script = s;
        return this;
    }

    ParseStandIn workerMillis(long ms) {
        this.workerMillis = ms;
        return this;
    }

    private void accept() {
        while (server.isOpen()) {
            try (SocketChannel c = server.accept()) {
                connections.incrementAndGet();
                serve(c);
            } catch (IOException | RuntimeException e) {
                // A connection that went wrong; the next one is served.
            }
        }
    }

    private void serve(SocketChannel c) throws IOException {
        InputStream in = Channels.newInputStream(c);
        OutputStream out = Channels.newOutputStream(c);
        Script s = script;
        if (s == null) {
            CourierWorker.serve(in, out, workerMillis);
            return;
        }
        byte[] request = in.readAllBytes();
        byte[] answer = s.apply(request);
        if (answer == null) {
            try {
                Thread.sleep(60_000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return;
        }
        out.write(answer);
        out.flush();
    }

    @Override
    public void close() throws IOException {
        server.close();
        acceptor.interrupt();
        Files.deleteIfExists(socket);
    }
}
