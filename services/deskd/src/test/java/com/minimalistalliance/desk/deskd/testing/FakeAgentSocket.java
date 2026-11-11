package com.minimalistalliance.desk.deskd.testing;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Function;

/**
 * desk-agent's side of {@code agent.sock}, scripted (services/desk-agent/docs/proposals.md section 5), on a real Unix
 * socket. Methods with a handler are answered at once, and the rest wait in {@link #requests} for the test to answer.
 * A {@code sub} to a topic with a snapshot gets it as its first event, and any other topic an {@code error} event.
 */
public final class FakeAgentSocket implements AutoCloseable {

    /** One KEY frame: its id, its JSON head and the key's bytes. */
    public record KeyFrame(long id, Map<String, Object> head, byte[] key) {}

    private final Path path;
    private final ServerSocketChannel server;
    private final Thread acceptor;
    private final ReentrantLock writeLock = new ReentrantLock();
    private volatile SocketChannel current;
    private volatile boolean closed;
    private volatile boolean stalled;

    /** Every JSON message deskd sent, in order. */
    public final BlockingQueue<Map<String, Object>> received = new LinkedBlockingQueue<>();
    /** The {@code req}s with no handler. */
    public final BlockingQueue<Map<String, Object>> requests = new LinkedBlockingQueue<>();
    public final BlockingQueue<KeyFrame> keys = new LinkedBlockingQueue<>();
    public final Map<String, Function<Map<String, Object>, Object>> handlers = new ConcurrentHashMap<>();
    /** A topic's snapshot data, made at each {@code sub}. */
    public final Map<String, java.util.function.Supplier<Map<String, Object>>> snapshots = new ConcurrentHashMap<>();
    /**
     * A topic whose first event is an {@code error} with this code, the subscription staying, as an older desk-agent
     * sends {@code too_large} for a snapshot past its frame.
     */
    public final Map<String, String> snapshotErrors = new ConcurrentHashMap<>();
    /** Live subscriptions on the current connection: sid to topic. */
    public final Map<Long, String> subscriptions = new ConcurrentHashMap<>();
    private volatile int connections;

    public FakeAgentSocket(Path path) throws IOException {
        this.path = path;
        Files.deleteIfExists(path);
        server = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        server.bind(UnixDomainSocketAddress.of(path));
        acceptor = Thread.ofVirtual().name("fake-agent").start(this::accept);
    }

    public int connections() {
        return connections;
    }

    /** Stops reading, as a desk-agent that has hung would: what deskd writes next waits in the socket, and then in deskd. */
    public void stall() {
        stalled = true;
    }

    public void resume() {
        stalled = false;
    }

    public boolean connected() {
        return current != null;
    }

    /** {@code res} for a request. */
    public void reply(long id, Object r) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "res");
        m.put("id", id);
        m.put("r", r);
        send(m);
    }

    /** {@code err} for a request. */
    public void error(long id, String code, Map<String, Object> details) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "err");
        m.put("id", id);
        m.put("code", code);
        m.put("details", details);
        send(m);
    }

    /** One event to every subscription of the topic. */
    public void publish(String topic, String type, Map<String, Object> data) {
        subscriptions.forEach((sid, name) -> {
            if (name.equals(topic)) {
                send(event(sid, topic, type, data));
            }
        });
    }

    public long subscribers(String topic) {
        return subscriptions.values().stream().filter(topic::equals).count();
    }

    /** The next message deskd sent with this {@code t}, skipping others. */
    public Map<String, Object> next(String t) throws InterruptedException {
        while (true) {
            Map<String, Object> m = received.poll(10, TimeUnit.SECONDS);
            if (m == null) {
                throw new AssertionError("nothing with t=" + t + " in 10 s");
            }
            if (t.equals(m.get("t"))) {
                return m;
            }
        }
    }

    /** Closes the current connection, as a restart of desk-agent would. */
    public void drop() throws IOException {
        SocketChannel channel = current;
        if (channel != null) {
            channel.close();
        }
    }

    @Override
    public void close() throws IOException {
        closed = true;
        drop();
        server.close();
        Files.deleteIfExists(path);
    }

    private void accept() {
        while (!closed) {
            try {
                SocketChannel channel = server.accept();
                SocketChannel old = current;
                if (old != null) {
                    old.close();
                }
                subscriptions.clear();
                current = channel;
                connections++;
                Thread.ofVirtual().name("fake-agent-read").start(() -> read(channel));
            } catch (IOException e) {
                return;
            }
        }
    }

    private void read(SocketChannel channel) {
        ByteBuffer header = ByteBuffer.allocate(5);
        try {
            while (true) {
                header.clear();
                if (!fill(channel, header)) {
                    break;
                }
                int length = header.getInt(0);
                ByteBuffer body = ByteBuffer.allocate(length - 1);
                if (!fill(channel, body)) {
                    break;
                }
                if (header.get(4) == 0x02) {
                    onKey(body);
                } else {
                    onJson(Json.parseObject(body.array()));
                }
            }
        } catch (Exception e) {
            // The connection ends.
        } finally {
            if (current == channel) {
                current = null;
                subscriptions.clear();
            }
            try {
                channel.close();
            } catch (IOException e) {
                // Nothing to do.
            }
        }
    }

    private void onKey(ByteBuffer body) throws Exception {
        long id = Integer.toUnsignedLong(body.getInt(0));
        int headLength = Short.toUnsignedInt(body.getShort(4));
        Map<String, Object> head = Json.parseObject(Arrays.copyOfRange(body.array(), 6, 6 + headLength));
        int keyLength = Short.toUnsignedInt(body.getShort(6 + headLength));
        if (6 + headLength + 2 + keyLength != body.capacity()) {
            throw new IOException("bad key frame");
        }
        byte[] key = Arrays.copyOfRange(body.array(), 8 + headLength, 8 + headLength + keyLength);
        keys.add(new KeyFrame(id, head, key));
        Function<Map<String, Object>, Object> handler = handlers.get("agent.key.add");
        if (handler != null) {
            reply(id, handler.apply(head));
        }
    }

    private void onJson(Map<String, Object> m) {
        received.add(m);
        switch (String.valueOf(m.get("t"))) {
            case "req" -> {
                Function<Map<String, Object>, Object> handler = handlers.get(m.get("m"));
                if (handler == null) {
                    requests.add(m);
                } else {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> p = (Map<String, Object>) m.get("p");
                    reply(((Number) m.get("id")).longValue(), handler.apply(p));
                }
            }
            case "sub" -> {
                long sid = ((Number) m.get("sid")).longValue();
                String topic = (String) m.get("topic");
                java.util.function.Supplier<Map<String, Object>> snapshot = snapshots.get(topic);
                String failure = snapshotErrors.get(topic);
                if (failure != null) {
                    subscriptions.put(sid, topic);
                    send(event(sid, topic, "error", Map.of("code", failure)));
                } else if (snapshot == null) {
                    send(event(sid, topic, "error", Map.of("code", "not_found")));
                } else {
                    subscriptions.put(sid, topic);
                    send(event(sid, topic, "snapshot", snapshot.get()));
                }
            }
            case "unsub" -> subscriptions.remove(((Number) m.get("sid")).longValue());
            default -> { }
        }
    }

    private static Map<String, Object> event(long sid, String topic, String type, Map<String, Object> data) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "evt");
        m.put("sid", sid);
        m.put("topic", topic);
        m.put("seq", 0);
        m.put("type", type);
        m.put("data", data);
        return m;
    }

    /** Any frame, as desk-agent would send it: a {@code tcall}, for one. */
    public void sendJson(Map<String, Object> m) {
        send(m);
    }

    private void send(Map<String, Object> m) {
        SocketChannel channel = current;
        if (channel == null) {
            return;
        }
        byte[] body = Json.bytes(m);
        ByteBuffer frame = ByteBuffer.allocate(5 + body.length);
        frame.putInt(1 + body.length).put((byte) 0x01).put(body).flip();
        writeLock.lock();
        try {
            while (frame.hasRemaining()) {
                channel.write(frame);
            }
        } catch (IOException e) {
            // The reader sees it.
        } finally {
            writeLock.unlock();
        }
    }

    private boolean fill(SocketChannel channel, ByteBuffer buffer) throws IOException, InterruptedException {
        while (buffer.position() < buffer.capacity()) {
            while (stalled && !closed) {
                Thread.sleep(1);
            }
            // A little at a time, so a stall stops it part way through a long frame.
            buffer.limit(Math.min(buffer.position() + 16384, buffer.capacity()));
            if (channel.read(buffer) < 0) {
                return false;
            }
        }
        return true;
    }
}
