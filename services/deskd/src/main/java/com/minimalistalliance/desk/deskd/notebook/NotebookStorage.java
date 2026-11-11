package com.minimalistalliance.desk.deskd.notebook;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SocketChannel;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.ReentrantLock;

/**
 * desk-notebook's storage state, from its health frame (services/notebook README, "A full disk"): whether its writes are
 * failing, so edits wait in memory, and whether it now refuses them. For {@code /health} and the heartbeat's
 * {@code health.checks.notebook}.
 *
 * <p>One short connection of its own, as {@code docker/health} makes: {@code {"t":"health"}} and its answer, with no hello,
 * which desk-notebook answers without one and closes without a line in its log. At most once in {@link #fresh}, which
 * the heartbeat's minute makes about once a minute, and never longer than {@link #wait}, after which it's unknown. Only
 * counts and the state go further, whatever else the frame holds: no page, title or text. {@code /health} never waits on
 * it ({@link #lastRead}): the admin socket gives a request 2 s in all, and a rollout reads {@code /health}.
 */
final class NotebookStorage {

    static final Duration FRESH = Duration.ofSeconds(10);
    static final Duration WAIT = Duration.ofSeconds(1);
    /** The real answer is a few hundred bytes. */
    private static final int MAX_REPLY = 64 << 10;

    private final Path socket;
    private final Duration fresh;
    private final Duration wait;
    private final ReentrantLock lock = new ReentrantLock();
    private final java.util.concurrent.atomic.AtomicBoolean refreshing = new java.util.concurrent.atomic.AtomicBoolean();
    private volatile Map<String, Object> last;
    private volatile long readAt;
    private volatile boolean readOnce;

    NotebookStorage(Path socket) {
        this(socket, FRESH, WAIT);
    }

    NotebookStorage(Path socket, Duration fresh, Duration wait) {
        this.socket = socket;
        this.fresh = fresh;
        this.wait = wait;
    }

    /**
     * Parks for at most {@link #wait} (and for another caller's read, if one is under way).
     *
     * @return {@code {state, unsavedPages, unsavedBytes, refusing, degradedSeconds}}, or null if desk-notebook isn't there,
     *     didn't answer in time, or said nothing of its storage (a build before it did)
     */
    Map<String, Object> read() throws InterruptedException {
        lock.lockInterruptibly();
        try {
            long now = System.nanoTime();
            if (readOnce && now - readAt < fresh.toNanos()) {
                return last;
            }
            last = ask();
            readAt = System.nanoTime();
            readOnce = true;
            return last;
        } finally {
            lock.unlock();
        }
    }

    /**
     * What was read last, without waiting, for {@code /health}; and if that's older than {@link #fresh}, a read in the
     * background, one at a time, for the next to see. Null before any read has finished.
     */
    Map<String, Object> lastRead() {
        if ((!readOnce || System.nanoTime() - readAt >= fresh.toNanos()) && refreshing.compareAndSet(false, true)) {
            Thread.ofVirtual().name("notebook-storage-read").start(() -> {
                try {
                    read();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } finally {
                    refreshing.set(false);
                }
            });
        }
        return last;
    }

    private Map<String, Object> ask() throws InterruptedException {
        SocketChannel channel;
        try {
            channel = SocketChannel.open(StandardProtocolFamily.UNIX);
        } catch (IOException e) {
            return null;
        }
        AtomicReference<Map<String, Object>> answer = new AtomicReference<>();
        try (channel) {
            // A Unix socket's connect either finishes or fails at once; the read is what can stall, so it has its own
            // thread, and closing the channel ends it.
            Thread reader = Thread.ofVirtual().name("notebook-storage").start(() -> answer.set(exchange(channel)));
            if (!reader.join(wait)) {
                closeQuietly(channel);
                reader.join(wait);
                return null;
            }
        } catch (IOException e) {
            return null;
        }
        return answer.get();
    }

    private Map<String, Object> exchange(SocketChannel channel) {
        try {
            channel.connect(UnixDomainSocketAddress.of(socket));
            byte[] body = Json.bytes(Map.of("t", "health"));
            ByteBuffer out = ByteBuffer.allocate(5 + body.length).putInt(1 + body.length).put(NotebookLink.JSON).put(body).flip();
            while (out.hasRemaining()) {
                channel.write(out);
            }
            // Its own frames only: a health connection is never subscribed to anything.
            ByteBuffer header = ByteBuffer.allocate(5);
            if (!fill(channel, header)) {
                return null;
            }
            int length = header.getInt(0);
            if (length < 2 || length > MAX_REPLY || header.get(4) != NotebookLink.JSON) {
                return null;
            }
            ByteBuffer reply = ByteBuffer.allocate(length - 1);
            if (!fill(channel, reply)) {
                return null;
            }
            Map<String, Object> frame = Json.parseObject(reply.array());
            return "health".equals(Json.string(frame, "t")) ? countsOf(Json.object(frame, "storage")) : null;
        } catch (IOException | JsonFormatException | RuntimeException e) {
            return null;
        }
    }

    /** Only the five fields the README names, each checked; anything else in the block stays behind. */
    static Map<String, Object> countsOf(Map<String, Object> storage) {
        if (storage == null) {
            return null;
        }
        Object state = storage.get("state");
        if (!"ok".equals(state) && !"degraded".equals(state)) {
            return null;
        }
        Map<String, Object> counts = new LinkedHashMap<>();
        counts.put("state", state);
        counts.put("unsavedPages", count(storage.get("unsavedPages")));
        counts.put("unsavedBytes", count(storage.get("unsavedBytes")));
        counts.put("refusing", Boolean.TRUE.equals(storage.get("refusing")));
        counts.put("degradedSeconds", count(storage.get("degradedSeconds")));
        return counts;
    }

    private static long count(Object value) {
        return value instanceof Number number && number.doubleValue() >= 0 ? number.longValue() : 0;
    }

    private static boolean fill(SocketChannel channel, ByteBuffer buffer) throws IOException {
        while (buffer.hasRemaining()) {
            if (channel.read(buffer) < 0) {
                return false;
            }
        }
        return true;
    }

    private static void closeQuietly(SocketChannel channel) {
        try {
            channel.close();
        } catch (IOException e) {
            // Closing.
        }
    }
}
