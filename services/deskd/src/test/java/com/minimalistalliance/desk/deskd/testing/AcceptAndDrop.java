package com.minimalistalliance.desk.deskd.testing;

import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * A local peer on a Unix socket that accepts each connection and closes it after {@code holdMillis} (0: at once), as a
 * sibling that's crashing on every connection would. Records when each came in.
 */
public final class AcceptAndDrop implements AutoCloseable {

    /** {@link System#nanoTime} at each accept, oldest first. */
    public final List<Long> accepts = new CopyOnWriteArrayList<>();
    private final Path path;
    private final long holdMillis;
    private final ServerSocketChannel server;
    private volatile boolean closed;

    public AcceptAndDrop(Path path, long holdMillis) throws IOException {
        this.path = path;
        this.holdMillis = holdMillis;
        Files.deleteIfExists(path);
        server = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        server.bind(UnixDomainSocketAddress.of(path));
        Thread.ofVirtual().name("accept-and-drop").start(this::accept);
    }

    public Path socket() {
        return path;
    }

    private void accept() {
        while (!closed) {
            try {
                SocketChannel channel = server.accept();
                accepts.add(System.nanoTime());
                if (holdMillis <= 0) {
                    channel.close();
                } else {
                    Thread.ofVirtual().start(() -> {
                        try (channel) {
                            Thread.sleep(holdMillis);
                        } catch (IOException | InterruptedException e) {
                            // Closing anyway.
                        }
                    });
                }
            } catch (IOException e) {
                return;
            }
        }
    }

    @Override
    public void close() throws IOException {
        closed = true;
        server.close();
        Files.deleteIfExists(path);
    }
}
