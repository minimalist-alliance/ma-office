package com.minimalistalliance.desk.agent.training;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.json.JsonFormatException;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SocketChannel;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;

/**
 * The training's deskd: the agent socket's client side, as docs/proposals.md section 5 has it. Synchronous, as the
 * training does one thing at a time: it reads frames until the one it waits for, keeping the rest.
 */
final class TrainingClient implements AutoCloseable {

    private final SocketChannel channel;
    private final List<Map<String, Object>> kept = new ArrayList<>();
    private long nextId;

    TrainingClient(Path socket) throws IOException {
        channel = SocketChannel.open(StandardProtocolFamily.UNIX);
        channel.connect(UnixDomainSocketAddress.of(socket));
    }

    Map<String, Object> call(String method, Map<String, Object> p) throws IOException {
        long id = ++nextId;
        Map<String, Object> req = new LinkedHashMap<>();
        req.put("t", "req");
        req.put("id", id);
        req.put("m", method);
        req.put("p", p);
        send(req);
        return await(m -> !"evt".equals(m.get("t")) && m.get("id") instanceof Number n && n.longValue() == id);
    }

    Map<String, Object> addKey(String provider, byte[] key) throws IOException {
        long id = ++nextId;
        byte[] head = Json.bytes(Map.of("m", "agent.key.add", "p", Map.of("provider", provider, "label", "Training")));
        int length = 1 + 4 + 2 + head.length + 2 + key.length;
        ByteBuffer frame = ByteBuffer.allocate(4 + length).putInt(length).put((byte) 2).putInt((int) id)
                .putShort((short) head.length).put(head).putShort((short) key.length).put(key);
        java.util.Arrays.fill(key, (byte) 0);
        write(frame.flip());
        return await(m -> !"evt".equals(m.get("t")) && m.get("id") instanceof Number n && n.longValue() == id);
    }

    void subscribe(long sid, String topic) throws IOException {
        send(Map.of("t", "sub", "sid", sid, "topic", topic));
    }

    Map<String, Object> await(Predicate<Map<String, Object>> match) throws IOException {
        for (int i = 0; i < kept.size(); i++) {
            if (match.test(kept.get(i))) {
                return kept.remove(i);
            }
        }
        while (true) {
            Map<String, Object> next = read();
            if (match.test(next)) {
                return next;
            }
            kept.add(next);
        }
    }

    private void send(Map<String, Object> message) throws IOException {
        byte[] json = Json.bytes(message);
        write(ByteBuffer.allocate(5 + json.length).putInt(json.length + 1).put((byte) 1).put(json).flip());
    }

    private void write(ByteBuffer buffer) throws IOException {
        while (buffer.hasRemaining()) {
            channel.write(buffer);
        }
    }

    private Map<String, Object> read() throws IOException {
        ByteBuffer header = ByteBuffer.allocate(5);
        fill(header);
        ByteBuffer body = ByteBuffer.allocate(header.getInt(0) - 1);
        fill(body);
        try {
            return Json.parseObject(body.array());
        } catch (JsonFormatException e) {
            throw new IOException("bad frame from desk-agent");
        }
    }

    private void fill(ByteBuffer buffer) throws IOException {
        while (buffer.hasRemaining()) {
            if (channel.read(buffer) < 0) {
                throw new IOException("desk-agent closed the socket");
            }
        }
    }

    @Override
    public void close() throws IOException {
        channel.close();
    }
}
