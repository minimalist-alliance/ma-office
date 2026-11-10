package com.minimalistalliance.desk.deskd.training;

import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameException;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Stands in for desk-rtc on a temporary Unix socket, speaking rtc.sock v1 (desk-runtime.md section 4), with the
 * far side of one client's data channels in the same object: {@link CdsTraining} sends what a client would.
 */
final class TrainingRtc implements AutoCloseable {

    private static final int JSON = 1;
    private static final int DATA = 2;
    private static final int CREDIT = 3;
    private static final long HANDLE = 1;

    private final ServerSocketChannel server;
    private final ReentrantLock writing = new ReentrantLock();
    private final List<BlockingQueue<Frame>> frames;
    private final Duration wait;
    private volatile SocketChannel client;
    /** The clipboard as desk-rtc keeps it: bytes, joined from a set's parts. Only the reader touches these. */
    private byte[] clipboard;
    private byte[] joining = new byte[0];
    private volatile boolean watching;

    TrainingRtc(Path socket, Duration wait) throws IOException {
        this.wait = wait;
        frames = List.of(
                new LinkedBlockingQueue<>(), new LinkedBlockingQueue<>(), new LinkedBlockingQueue<>(),
                new LinkedBlockingQueue<>(), new LinkedBlockingQueue<>(), new LinkedBlockingQueue<>());
        server = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        server.bind(UnixDomainSocketAddress.of(socket));
        Thread.ofVirtual().name("training-rtc").start(this::serve);
    }

    /** A frame as the client's data channel would deliver it. */
    void send(int channel, Frame frame) throws IOException {
        byte[] encoded = frame.encode();
        ByteBuffer out = ByteBuffer.allocate(10 + encoded.length);
        out.putInt(6 + encoded.length);
        out.put((byte) DATA);
        out.putInt((int) HANDLE);
        out.put((byte) channel);
        out.put(encoded);
        write(out);
    }

    /** The next frame deskd sent on this channel. */
    Frame next(int channel) throws InterruptedException {
        Frame frame = frames.get(channel).poll(wait.toNanos(), TimeUnit.NANOSECONDS);
        if (frame == null) {
            throw new IllegalStateException("no frame from deskd on channel " + channel);
        }
        return frame;
    }

    boolean watching() {
        return watching;
    }

    void sendJson(Map<String, Object> message) throws IOException {
        byte[] body = Json.bytes(message);
        ByteBuffer out = ByteBuffer.allocate(5 + body.length);
        out.putInt(1 + body.length);
        out.put((byte) JSON);
        out.put(body);
        write(out);
    }

    private void write(ByteBuffer out) throws IOException {
        out.flip();
        writing.lock();
        try {
            while (out.hasRemaining()) {
                client.write(out);
            }
        } finally {
            writing.unlock();
        }
    }

    @Override
    public void close() throws IOException {
        server.close();
        if (client != null) {
            client.close();
        }
    }

    private void serve() {
        try {
            client = server.accept();
            ByteBuffer head = ByteBuffer.allocate(4);
            while (true) {
                head.clear();
                readFully(head);
                ByteBuffer body = ByteBuffer.allocate(head.getInt(0));
                readFully(body);
                body.flip();
                onEnvelope(body);
            }
        } catch (IOException e) {
            // deskd has gone, as it does when the training ends.
        } catch (JsonFormatException | FrameException | RuntimeException e) {
            // deskd said something the protocol doesn't have. The training then fails on what never came.
            System.err.println("training rtc failed: " + e.getClass().getName());
        }
    }

    private void readFully(ByteBuffer buffer) throws IOException {
        while (buffer.hasRemaining()) {
            if (client.read(buffer) < 0) {
                throw new IOException("closed");
            }
        }
    }

    private void onEnvelope(ByteBuffer body) throws IOException, JsonFormatException, FrameException {
        int type = body.get() & 0xFF;
        if (type == JSON) {
            byte[] json = new byte[body.remaining()];
            body.get(json);
            onJson(Json.parseObject(json));
        } else if (type == DATA) {
            body.getInt();
            int channel = body.get() & 0xFF;
            byte[] frame = new byte[body.remaining()];
            body.get(frame);
            frames.get(channel).add(Frame.decode(frame));
            sendCredit(channel, frame.length);
        } else if (type != CREDIT) {
            throw new FrameException("an envelope of type " + type);
        }
    }

    private void sendCredit(int channel, int bytes) throws IOException {
        ByteBuffer out = ByteBuffer.allocate(14);
        out.putInt(10);
        out.put((byte) CREDIT);
        out.putInt((int) HANDLE);
        out.put((byte) channel);
        out.putInt(bytes);
        write(out);
    }

    private void onJson(Map<String, Object> message) throws IOException {
        String type = Json.string(message, "t");
        String sessionId = Json.string(message, "sessionId");
        switch (type == null ? "" : type) {
            case "configure" -> {
                Map<String, Object> reply = new LinkedHashMap<>();
                reply.put("t", "configured");
                reply.put("fingerprintsSha256", List.of("cd".repeat(32)));
                reply.put("notAfter", Instant.now().plus(Duration.ofDays(30)).toString());
                reply.put("version", "training");
                sendJson(reply);
                sendJson(Map.of("t", "stream.state", "state", "down"));
            }
            case "session.create" -> {
                Map<String, Object> reply = new LinkedHashMap<>();
                reply.put("t", "session.answer");
                reply.put("sessionId", sessionId);
                reply.put("handle", HANDLE);
                reply.put("answer", "v=0\r\n");
                sendJson(reply);
                sendJson(Map.of("t", "session.state", "sessionId", sessionId, "state", "connected", "transport", "udp"));
                sendJson(Map.of("t", "input.activity", "sessionId", sessionId, "at", Instant.now().toEpochMilli()));
            }
            case "session.close" -> sendJson(Map.of("t", "session.closed", "sessionId", sessionId, "reason", "client_closed"));
            case "session.video" -> sendJson(Map.of("t", "stream.state", "state", Boolean.TRUE.equals(message.get("view")) ? "live" : "warm"));
            case "stats.get" -> {
                Map<String, Object> reply = new LinkedHashMap<>();
                reply.put("t", "stats");
                reply.put("sessions", List.of());
                reply.put("bytesSent", 0);
                reply.put("bytesReceived", 0);
                reply.put("peerBytesSent", 0);
                sendJson(reply);
            }
            case "clipboard.watch" -> {
                watching = Boolean.TRUE.equals(message.get("on"));
                if (watching) {
                    // As if a page had just copied something.
                    sendJson(Map.of("t", "clipboard.changed"));
                }
            }
            case "clipboard.set" -> {
                byte[] part = Base64.getDecoder().decode(Json.string(message, "data"));
                byte[] joined = Arrays.copyOf(joining, joining.length + part.length);
                System.arraycopy(part, 0, joined, joining.length, part.length);
                joining = joined;
                if (Boolean.TRUE.equals(message.get("last"))) {
                    clipboard = joining;
                    joining = new byte[0];
                    sendJson(Map.of("t", "clipboard.ok", "id", message.get("id")));
                }
            }
            case "clipboard.get" -> {
                Map<String, Object> reply = new LinkedHashMap<>();
                reply.put("t", "clipboard.text");
                reply.put("id", message.get("id"));
                reply.put("part", 0);
                reply.put("last", true);
                if (clipboard == null) {
                    reply.put("none", true);
                } else {
                    reply.put("data", Base64.getEncoder().encodeToString(clipboard));
                }
                sendJson(reply);
            }
            default -> {
                // session.permissions has no reply, and nothing else comes in the training.
            }
        }
    }
}
