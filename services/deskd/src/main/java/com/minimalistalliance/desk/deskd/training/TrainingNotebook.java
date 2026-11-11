package com.minimalistalliance.desk.deskd.training;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Stands in for desk-notebook on a temporary Unix socket: each {@code req} gets an empty result, a {@code sub} its first
 * {@code {rev}}, and a collab message comes back as it went. It's only there so the relay's classes are in the archive.
 */
final class TrainingNotebook implements AutoCloseable {

    private static final byte JSON = 0x01;

    private final ServerSocketChannel server;

    TrainingNotebook(Path socket) throws IOException {
        server = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        server.bind(UnixDomainSocketAddress.of(socket));
        Thread.ofVirtual().name("training-notebook").start(this::accept);
    }

    private void accept() {
        try {
            while (true) {
                SocketChannel client = server.accept();
                Thread.ofVirtual().name("training-notebook-read").start(() -> serve(client));
            }
        } catch (IOException e) {
            // The training has ended.
        }
    }

    private static void serve(SocketChannel client) {
        ByteBuffer header = ByteBuffer.allocate(5);
        try (client) {
            while (fill(client, header.clear())) {
                ByteBuffer body = ByteBuffer.allocate(header.getInt(0) - 1);
                if (!fill(client, body)) {
                    return;
                }
                if (header.get(4) == JSON) {
                    answer(client, Json.parseObject(body.array()));
                } else {
                    write(client, header.get(4), body.array());
                }
            }
        } catch (IOException e) {
            // deskd has gone, as it does when the session ends.
        } catch (JsonFormatException | RuntimeException e) {
            // The training then fails on what never came.
            System.err.println("training notebook failed: " + e.getClass().getName());
        }
    }

    private static void answer(SocketChannel client, Map<String, Object> message) throws IOException {
        Map<String, Object> reply = new LinkedHashMap<>();
        switch (String.valueOf(message.get("t"))) {
            case "req" -> {
                reply.put("t", "res");
                reply.put("id", message.get("id"));
                reply.put("r", Map.of());
            }
            case "sub" -> {
                reply.put("t", "evt");
                reply.put("sid", message.get("sid"));
                reply.put("data", Map.of("rev", 1));
            }
            case "health" -> {
                // The heartbeat's read of the storage state, so it loads here and doesn't wait out its second.
                reply.put("t", "health");
                reply.put("ok", true);
                reply.put("storage", Map.of("state", "ok", "unsavedPages", 0, "unsavedBytes", 0, "refusing", false, "degradedSeconds", 0));
            }
            default -> {
                return;
            }
        }
        write(client, JSON, Json.bytes(reply));
    }

    private static void write(SocketChannel client, byte type, byte[] body) throws IOException {
        ByteBuffer frame = ByteBuffer.allocate(5 + body.length);
        frame.putInt(1 + body.length).put(type).put(body).flip();
        while (frame.hasRemaining()) {
            client.write(frame);
        }
    }

    private static boolean fill(SocketChannel client, ByteBuffer buffer) throws IOException {
        while (buffer.hasRemaining()) {
            if (client.read(buffer) < 0) {
                return false;
            }
        }
        return true;
    }

    @Override
    public void close() throws IOException {
        server.close();
    }
}
