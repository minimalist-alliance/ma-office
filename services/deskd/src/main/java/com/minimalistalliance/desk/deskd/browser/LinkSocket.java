package com.minimalistalliance.desk.deskd.browser;

import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.nio.file.attribute.UserPrincipal;
import java.time.Duration;
import java.util.concurrent.Semaphore;
import jdk.net.ExtendedSocketOptions;
import jdk.net.UnixDomainPrincipal;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * {@code /run/desk-links/links.sock}: where the desk's {@code xdg-open} stand-in hands deskd the one URL Chromium gave the
 * OS (desk-runtime.md section 8.11). One connection a link, one line each way:
 *
 * <pre>
 * open &lt;url&gt;\n          from the stand-in, at most {@value #MAX_LINE} bytes with the newline, UTF-8
 * ok\n                  passed to the member's device
 * dropped &lt;reason&gt;\n     or not: scheme, url, request, peer, repeat, rate or nobody
 * </pre>
 *
 * <p>Only Chromium's user may connect: the directory is {@code desk:kiosk 2750}, so the socket's group is kiosk, at mode
 * 0660, and each peer's uid is checked with {@code SO_PEERCRED} too. What it sends is treated as a web page's, which it is:
 * {@link BrowserLinks} decides everything. A peer gets {@value #READ_TIMEOUT_MILLIS} ms to send its line, and at most
 * {@value #MAX_CONNECTIONS} are served at once; past that a connection is closed with no reply.
 */
final class LinkSocket implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(LinkSocket.class);

    /** The verb, the longest URL {@link BrowserUrl} takes, and the newline: past that it's no request of the stand-in's. */
    static final int MAX_LINE = 5 + BrowserUrl.MAX_CHARS + 1;
    static final int MAX_CONNECTIONS = 4;
    static final long READ_TIMEOUT_MILLIS = 2000;
    private static final String VERB = "open ";

    /** What becomes of a link, and of a connection that brought none. Both return the word the reply carries. */
    interface Sink {
        String offer(String url);

        String refused(String reason);
    }

    private final Path socket;
    private final UserPrincipal chromium;
    private final Sink sink;
    private final Duration readTimeout;
    private final Semaphore slots = new Semaphore(MAX_CONNECTIONS);
    private ServerSocketChannel server;
    private Thread acceptor;
    private volatile boolean closed;

    /** @param chromiumUid the only uid that may connect: kiosk's, which Chromium runs as */
    LinkSocket(Path socket, int chromiumUid, Sink sink) throws IOException {
        this(socket, chromiumUid, sink, Duration.ofMillis(READ_TIMEOUT_MILLIS));
    }

    LinkSocket(Path socket, int chromiumUid, Sink sink, Duration readTimeout) throws IOException {
        this.socket = socket;
        // A number the name service doesn't know is taken as the uid itself, and principals compare by uid.
        this.chromium = FileSystems.getDefault().getUserPrincipalLookupService().lookupPrincipalByName(Integer.toString(chromiumUid));
        this.sink = sink;
        this.readTimeout = readTimeout;
    }

    /**
     * Binds the socket, replacing a stale one. It gets its mode under a temporary name and only then takes the real one,
     * so it's never reachable at another. Its group is the directory's, by the directory's setgid bit.
     */
    void start() throws IOException {
        Path temporary = socket.resolveSibling(socket.getFileName() + ".new");
        Files.deleteIfExists(temporary);
        Files.deleteIfExists(socket);
        server = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        server.bind(UnixDomainSocketAddress.of(temporary));
        Files.setPosixFilePermissions(temporary, PosixFilePermissions.fromString("rw-rw----"));
        Files.move(temporary, socket, StandardCopyOption.ATOMIC_MOVE);
        acceptor = Thread.ofVirtual().name("links-acceptor").start(this::acceptLoop);
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
            log.debug("closing the links socket failed");
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
                    Thread.ofVirtual().name("links-connection").start(() -> serve(client));
                } else {
                    closeQuietly(client);
                }
            } catch (IOException e) {
                if (!closed) {
                    log.warn("links socket accept failed: {}", e.getClass().getSimpleName());
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
        Thread watchdog = Thread.ofVirtual().name("links-timeout").start(() -> {
            try {
                Thread.sleep(readTimeout);
                closeQuietly(client);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        try (client) {
            String reply;
            if (!fromChromium(client)) {
                reply = sink.refused(BrowserLinks.DROP_PEER);
            } else {
                String url = readRequest(client);
                reply = url == null ? sink.refused(BrowserLinks.DROP_REQUEST) : sink.offer(url);
            }
            write(client, (BrowserLinks.SENT.equals(reply) ? reply : "dropped " + reply) + "\n");
        } catch (IOException e) {
            log.debug("links connection ended early: {}", e.getClass().getSimpleName());
        } finally {
            watchdog.interrupt();
            slots.release();
        }
    }

    private boolean fromChromium(SocketChannel client) {
        try {
            UnixDomainPrincipal peer = client.getOption(ExtendedSocketOptions.SO_PEERCRED);
            return peer != null && chromium.equals(peer.user());
        } catch (IOException | UnsupportedOperationException e) {
            return false;
        }
    }

    /** @return the URL of an {@code open} line, or null for anything else: no newline in time, another verb, not UTF-8 */
    private static String readRequest(SocketChannel client) throws IOException {
        ByteBuffer buffer = ByteBuffer.allocate(MAX_LINE);
        int scanned = 0;
        while (buffer.hasRemaining()) {
            if (client.read(buffer) < 0) {
                return null;
            }
            for (; scanned < buffer.position(); scanned++) {
                if (buffer.get(scanned) == '\n') {
                    return parse(buffer.array(), scanned);
                }
            }
        }
        return null;
    }

    private static String parse(byte[] bytes, int newline) {
        CharBuffer text;
        try {
            text = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes, 0, newline));
        } catch (CharacterCodingException e) {
            return null;
        }
        String line = text.toString();
        return line.startsWith(VERB) ? line.substring(VERB.length()) : null;
    }

    private static void write(SocketChannel client, String reply) throws IOException {
        ByteBuffer buffer = ByteBuffer.wrap(reply.getBytes(StandardCharsets.US_ASCII));
        while (buffer.hasRemaining()) {
            client.write(buffer);
        }
    }

    private static void closeQuietly(SocketChannel client) {
        try {
            client.close();
        } catch (IOException e) {
            log.debug("closing a links connection failed");
        }
    }
}
