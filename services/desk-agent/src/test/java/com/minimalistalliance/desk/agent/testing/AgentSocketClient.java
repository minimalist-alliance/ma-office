package com.minimalistalliance.desk.agent.testing;

import com.minimalistalliance.desk.agent.json.Json;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.LinkedBlockingDeque;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Predicate;

/**
 * What deskd's relay will be, as far as the agent socket sees it (docs/proposals.md section 5): JSON frames for
 * {@code req}, {@code sub} and {@code unsub}, and the KEY frame for {@code agent.key.add}. Everything that comes back
 * is kept in order, so a test can wait for a reply by id or an event by sid and type.
 */
public final class AgentSocketClient implements AutoCloseable {

    private final SocketChannel channel;
    private final LinkedBlockingDeque<Map<String, Object>> received = new LinkedBlockingDeque<>();
    private final AtomicLong ids = new AtomicLong();
    private final Thread reader;
    public volatile boolean closedByPeer;

    public AgentSocketClient(Path socket) throws IOException {
        channel = SocketChannel.open(StandardProtocolFamily.UNIX);
        channel.connect(UnixDomainSocketAddress.of(socket));
        reader = Thread.ofVirtual().start(this::read);
    }

    private void read() {
        try {
            ByteBuffer header = ByteBuffer.allocate(5);
            while (true) {
                header.clear();
                if (!fill(header)) {
                    break;
                }
                ByteBuffer body = ByteBuffer.allocate(header.getInt(0) - 1);
                if (!fill(body)) {
                    break;
                }
                received.add(Json.parseObject(body.array()));
            }
        } catch (Exception e) {
            // Closed.
        }
        closedByPeer = true;
    }

    private boolean fill(ByteBuffer buffer) throws IOException {
        while (buffer.hasRemaining()) {
            if (channel.read(buffer) < 0) {
                return false;
            }
        }
        return true;
    }

    public void sendJson(Map<String, Object> message) throws IOException {
        byte[] json = Json.bytes(message);
        write(ByteBuffer.allocate(5 + json.length).putInt(json.length + 1).put((byte) 1).put(json).flip());
    }

    public void sendRaw(byte[] frame) throws IOException {
        write(ByteBuffer.wrap(frame));
    }

    private void write(ByteBuffer buffer) throws IOException {
        while (buffer.hasRemaining()) {
            channel.write(buffer);
        }
    }

    /** Sends a request and waits for its {@code res} or {@code err}. */
    public Map<String, Object> call(String method, Map<String, Object> p) throws Exception {
        long id = ids.incrementAndGet();
        Map<String, Object> req = new LinkedHashMap<>();
        req.put("t", "req");
        req.put("id", id);
        req.put("m", method);
        req.put("p", p);
        sendJson(req);
        return await(m -> ("res".equals(m.get("t")) || "err".equals(m.get("t"))) && number(m, "id") == id);
    }

    /** The KEY frame: the key's bytes outside the JSON. */
    public Map<String, Object> addKey(String provider, String label, byte[] key) throws Exception {
        long id = ids.incrementAndGet();
        Map<String, Object> head = new LinkedHashMap<>();
        head.put("m", "agent.key.add");
        head.put("p", Map.of("provider", provider, "label", label, "deskId", "d-test"));
        byte[] json = Json.bytes(head);
        int length = 1 + 4 + 2 + json.length + 2 + key.length;
        ByteBuffer frame = ByteBuffer.allocate(4 + length).putInt(length).put((byte) 2).putInt((int) id)
                .putShort((short) json.length).put(json).putShort((short) key.length).put(key);
        write(frame.flip());
        return await(m -> ("res".equals(m.get("t")) || "err".equals(m.get("t"))) && number(m, "id") == id);
    }

    public void subscribe(long sid, String topic) throws IOException {
        sendJson(Map.of("t", "sub", "sid", sid, "topic", topic));
    }

    /** {@code req} with the caller deskd adds (its API.md section 14). */
    public Map<String, Object> call(String method, Map<String, Object> p, Map<String, Object> caller) throws Exception {
        long id = ids.incrementAndGet();
        Map<String, Object> req = new LinkedHashMap<>();
        req.put("t", "req");
        req.put("id", id);
        req.put("m", method);
        req.put("p", p);
        req.put("caller", caller);
        sendJson(req);
        return await(m -> ("res".equals(m.get("t")) || "err".equals(m.get("t"))) && number(m, "id") == id);
    }

    /** {@code sub} with the caller. */
    public void subscribe(long sid, String topic, Map<String, Object> caller) throws IOException {
        sendJson(Map.of("t", "sub", "sid", sid, "topic", topic, "caller", caller));
    }

    /** Waits for the next event on {@code sid} of that type, skipping others of that sid. */
    public Map<String, Object> event(long sid, String type) throws Exception {
        return await(m -> "evt".equals(m.get("t")) && number(m, "sid") == sid && type.equals(m.get("type")));
    }

    /** Waits for the first received message matching, removing it and everything received before it. */
    public Map<String, Object> await(Predicate<Map<String, Object>> match) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(10).toNanos();
        while (true) {
            for (Map<String, Object> message : received) {
                if (match.test(message)) {
                    received.remove(message);
                    return message;
                }
            }
            long left = deadline - System.nanoTime();
            if (left <= 0) {
                throw new AssertionError("nothing matched; received " + received);
            }
            Map<String, Object> next = received.pollFirst(Math.min(left, 50_000_000), TimeUnit.NANOSECONDS);
            if (next != null) {
                received.addFirst(next);
            }
            Thread.sleep(5);
        }
    }

    public static long number(Map<String, Object> m, String key) {
        return m.get(key) instanceof Number n ? n.longValue() : -1;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> map(Object value) {
        return (Map<String, Object>) value;
    }

    @Override
    public void close() throws IOException {
        channel.close();
        reader.interrupt();
    }

    public static byte[] ascii(String text) {
        return text.getBytes(StandardCharsets.US_ASCII);
    }
}
