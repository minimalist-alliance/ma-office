package com.minimalistalliance.desk.deskd.testing;

import static org.assertj.core.api.Assertions.fail;

import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameException;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Stands in for desk-rtc on a real Unix socket: it listens, takes one connection at a time, and
 * speaks desk-runtime.md 4.2 byte for byte. It records what deskd sends and sends what a test tells
 * it to. By default it answers configure and session.create by itself and gives credit back for
 * everything it reads. With {@link #autoClipboard} it also holds a clipboard as desk-rtc does: a set's
 * parts joined as bytes and answered on the last, a get answered in parts of 45 KiB, and watch kept.
 */
public final class FakeDeskRtc implements AutoCloseable {

    public static final long TIMEOUT_SECONDS = 10;

    private final Path socket;
    private final ServerSocketChannel server;
    private final Thread acceptor;
    private final BlockingQueue<Map<String, Object>> json = new LinkedBlockingQueue<>();
    private final Map<Long, BlockingQueue<Frame>> frames = new ConcurrentHashMap<>();
    private final Map<Long, AtomicLong> creditFromDeskd = new ConcurrentHashMap<>();
    private final Map<Long, AtomicLong> bytesFromDeskd = new ConcurrentHashMap<>();
    private final Map<Long, AtomicLong> bytesToDeskd = new ConcurrentHashMap<>();
    private final ReentrantLock writeLock = new ReentrantLock();
    private final AtomicLong nextHandle = new AtomicLong(1);
    private final AtomicLong connections = new AtomicLong();
    private volatile SocketChannel client;
    private volatile boolean autoConfigure = true;
    private volatile boolean autoAnswer = true;
    private volatile boolean autoCredit = true;
    private volatile boolean closed;
    private volatile List<String> fingerprints = List.of("cd".repeat(32));
    private volatile boolean autoStats;
    private volatile boolean autoClosed = true;
    private volatile List<Long> statsTotals = List.of(1000L, 2000L, 0L);
    private volatile boolean autoClipboard;
    private volatile byte[] clipboard;
    private volatile boolean watching;
    private final Map<Object, byte[]> joining = new ConcurrentHashMap<>();
    /** Each envelope from deskd in the order it came: the JSON's t, or "data" with the frame's bytes. */
    private final List<String> order = Collections.synchronizedList(new ArrayList<>());
    private volatile boolean recordOrder;
    private volatile boolean paused;
    private volatile boolean guildV04;

    static {
        TestTiming.pollFast();
    }

    public FakeDeskRtc(Path socket) throws IOException {
        this.socket = socket;
        Files.deleteIfExists(socket);
        server = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        server.bind(UnixDomainSocketAddress.of(socket));
        acceptor = Thread.ofVirtual().name("fake-rtc-accept").start(this::acceptLoop);
    }

    public void autoConfigure(boolean on) {
        autoConfigure = on;
    }

    public void autoAnswer(boolean on) {
        autoAnswer = on;
    }

    /** Off: deskd keeps only its first 256 KiB per channel, unless the test grants more. */
    public void autoCredit(boolean on) {
        autoCredit = on;
    }

    /** On: stats.get gets an answer, as the heartbeat needs. Off by default so a test can answer itself. */
    public void autoStats(boolean on) {
        autoStats = on;
    }

    /** Off: session.close gets no session.closed, as from a desk-rtc that has stopped cooperating. */
    public void autoClosed(boolean on) {
        autoClosed = on;
    }

    /**
     * On: a Guild Desk's configure is answered as desk-rtc 0.4.0 does, with {@code deskKind}, {@code maxSessions},
     * {@code maxSessionsPerMember} and the {@code credit} it took (64 to 256 KiB as asked, else 256 KiB). Off, as 0.3.x:
     * none of those.
     */
    public void guildV04(boolean on) {
        guildV04 = on;
    }

    /** What autoStats reports from now on. */
    public void statsTotals(long bytesSent, long bytesReceived, long peerBytesSent) {
        statsTotals = List.of(bytesSent, bytesReceived, peerBytesSent);
    }

    /** On: clipboard.set, get and watch are answered as desk-rtc does, from {@link #clipboard()}. */
    public void autoClipboard(boolean on) {
        autoClipboard = on;
    }

    /** The bytes the clipboard holds, or null for no text. */
    public byte[] clipboard() {
        return clipboard;
    }

    /** As if another X client had taken the clipboard. Sends nothing: {@link #clipboardChanged} does. */
    public void clipboard(byte[] bytes) {
        clipboard = bytes;
    }

    /** What the last clipboard.watch said, on the current connection. A new connection starts with it off. */
    public boolean watching() {
        return watching;
    }

    public void clipboardChanged() {
        sendJson(Map.of("t", "clipboard.changed"));
    }

    /** On: stops reading the socket, as a busy desk-rtc would, so what deskd sends waits in its queues. */
    public void pauseReading(boolean on) {
        paused = on;
    }

    /** On: {@link #order} records from now. */
    public void recordOrder(boolean on) {
        recordOrder = on;
    }

    /** The envelopes deskd has sent while recording, in order: "data:<bytes>" for a frame, the t of a JSON message otherwise. */
    public List<String> order() {
        synchronized (order) {
            return List.copyOf(order);
        }
    }

    /** What the next configured reports. */
    public void fingerprints(List<String> values) {
        fingerprints = values;
    }

    /** How many connections deskd has made so far. */
    public long connectionCount() {
        return connections.get();
    }

    @Override
    public void close() throws IOException {
        closed = true;
        drop();
        server.close();
        acceptor.interrupt();
        Files.deleteIfExists(socket);
    }

    /** Cuts the connection, as a crash of desk-rtc would. */
    public void drop() throws IOException {
        SocketChannel current = client;
        if (current != null) {
            current.close();
        }
        client = null;
    }

    public void sendJson(Map<String, Object> message) {
        byte[] body = Json.bytes(message);
        ByteBuffer out = ByteBuffer.allocate(5 + body.length);
        out.putInt(1 + body.length);
        out.put((byte) 1);
        out.put(body);
        write(out);
    }

    /** Sends a frame as desk-rtc would: within the credit deskd has given, waiting for more if needed. */
    public void sendData(long handle, int channel, byte[] frame) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(TIMEOUT_SECONDS);
        AtomicLong sent = bytesToDeskd.computeIfAbsent(key(handle, channel), k -> new AtomicLong());
        while (RtcClient.INITIAL_CREDIT + creditFromDeskd(handle, channel) - sent.get() < frame.length) {
            if (System.nanoTime() > deadline) {
                fail("no credit from deskd on channel " + channel);
            }
            try {
                Thread.sleep(1);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
        sent.addAndGet(frame.length);
        sendDataIgnoringCredit(handle, channel, frame);
    }

    /** Sends a frame whatever the credit, to test what deskd does about that. */
    public void sendDataIgnoringCredit(long handle, int channel, byte[] frame) {
        ByteBuffer out = ByteBuffer.allocate(10 + frame.length);
        out.putInt(6 + frame.length);
        out.put((byte) 2);
        out.putInt((int) handle);
        out.put((byte) channel);
        out.put(frame);
        write(out);
    }

    public void sendCredit(long handle, int channel, long bytes) {
        ByteBuffer out = ByteBuffer.allocate(14);
        out.putInt(10);
        out.put((byte) 3);
        out.putInt((int) handle);
        out.put((byte) channel);
        out.putInt((int) bytes);
        write(out);
    }

    /** Writes bytes as they are, to test what deskd does with a bad envelope. */
    public void sendRaw(byte[] bytes) {
        write(ByteBuffer.wrap(bytes));
    }

    /** The next JSON message of this type; any others in the way are dropped. */
    public Map<String, Object> awaitJson(String type) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(TIMEOUT_SECONDS);
        while (System.nanoTime() < deadline) {
            Map<String, Object> message = json.poll(100, TimeUnit.MILLISECONDS);
            if (message != null && type.equals(message.get("t"))) {
                return message;
            }
        }
        return fail("no rtc message of type " + type);
    }

    /** The next JSON message within the wait, whatever its type, or null. */
    public Map<String, Object> pollJson(long millis) throws InterruptedException {
        return json.poll(millis, TimeUnit.MILLISECONDS);
    }

    public Frame awaitFrame(long handle, int channel) throws InterruptedException {
        Frame frame = queue(handle, channel).poll(TIMEOUT_SECONDS, TimeUnit.SECONDS);
        return frame != null ? frame : fail("no frame on channel " + channel);
    }

    /** The next frame within the wait, or null. */
    public Frame pollFrame(long handle, int channel, long millis) throws InterruptedException {
        return queue(handle, channel).poll(millis, TimeUnit.MILLISECONDS);
    }

    /** Total CREDIT deskd has sent for this channel. */
    public long creditFromDeskd(long handle, int channel) {
        return creditFromDeskd.computeIfAbsent(key(handle, channel), k -> new AtomicLong()).get();
    }

    /** Total frame bytes deskd has sent on this channel. */
    public long bytesFromDeskd(long handle, int channel) {
        return bytesFromDeskd.computeIfAbsent(key(handle, channel), k -> new AtomicLong()).get();
    }

    private BlockingQueue<Frame> queue(long handle, int channel) {
        return frames.computeIfAbsent(key(handle, channel), k -> new LinkedBlockingQueue<>());
    }

    private static long key(long handle, int channel) {
        return (handle << 8) | channel;
    }

    private void write(ByteBuffer out) {
        out.rewind();
        writeLock.lock();
        try {
            SocketChannel current = client;
            if (current == null) {
                return;
            }
            while (out.hasRemaining()) {
                current.write(out);
            }
        } catch (IOException e) {
            // A test that drops the socket can race with a write; the test sees the effect.
        } finally {
            writeLock.unlock();
        }
    }

    private void acceptLoop() {
        while (!closed) {
            try {
                SocketChannel accepted = server.accept();
                SocketChannel previous = client;
                watching = false;
                joining.clear();
                client = accepted;
                connections.incrementAndGet();
                if (previous != null) {
                    previous.close();
                }
                Thread.ofVirtual().name("fake-rtc-read").start(() -> readLoop(accepted));
            } catch (IOException e) {
                return;
            }
        }
    }

    private void readLoop(SocketChannel channel) {
        ByteBuffer head = ByteBuffer.allocate(4);
        try {
            while (true) {
                while (paused) {
                    Thread.sleep(1);
                }
                head.clear();
                if (!readFully(channel, head)) {
                    return;
                }
                int length = head.getInt(0);
                ByteBuffer body = ByteBuffer.allocate(length);
                if (!readFully(channel, body)) {
                    return;
                }
                body.flip();
                onEnvelope(body);
            }
        } catch (IOException e) {
            // deskd went away, or the test dropped the socket.
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static boolean readFully(SocketChannel channel, ByteBuffer buffer) throws IOException {
        while (buffer.hasRemaining()) {
            if (channel.read(buffer) < 0) {
                return false;
            }
        }
        return true;
    }

    private void onEnvelope(ByteBuffer body) {
        int type = body.get() & 0xFF;
        switch (type) {
            case 1 -> onJson(body);
            case 2 -> onData(body);
            case 3 -> {
                long handle = body.getInt() & 0xFFFFFFFFL;
                int channel = body.get() & 0xFF;
                long bytes = body.getInt() & 0xFFFFFFFFL;
                creditFromDeskd.computeIfAbsent(key(handle, channel), k -> new AtomicLong()).addAndGet(bytes);
            }
            default -> throw new IllegalStateException("unknown envelope type " + type);
        }
    }

    private void onJson(ByteBuffer body) {
        byte[] bytes = new byte[body.remaining()];
        body.get(bytes);
        Map<String, Object> message;
        try {
            message = Json.parseObject(bytes);
        } catch (JsonFormatException e) {
            throw new IllegalStateException(e);
        }
        json.add(message);
        String type = Json.string(message, "t");
        if (recordOrder) {
            order.add(String.valueOf(type));
        }
        if (type != null && type.startsWith("clipboard.") && autoClipboard) {
            onClipboard(type, message);
            return;
        }
        if ("configure".equals(type) && autoConfigure) {
            Map<String, Object> reply = new LinkedHashMap<>();
            reply.put("t", "configured");
            reply.put("fingerprintsSha256", fingerprints);
            reply.put("notAfter", "2027-01-01T00:00:00Z");
            reply.put("version", "fake-rtc-1");
            if (guildV04 && "guild".equals(message.get("deskKind"))) {
                long asked = message.get("credit") instanceof Number number ? number.longValue() : 0;
                reply.put("deskKind", "guild");
                reply.put("maxSessions", message.get("maxSessions"));
                reply.put("maxSessionsPerMember", message.get("maxSessionsPerMember"));
                reply.put("credit", asked < 64 * 1024 || asked > 256 * 1024 ? 256 * 1024 : asked);
            }
            sendJson(reply);
        } else if (("session.create".equals(type) || "session.ice_restart".equals(type)) && autoAnswer) {
            String sessionId = Json.string(message, "sessionId");
            Map<String, Object> reply = new LinkedHashMap<>();
            reply.put("t", "session.answer");
            reply.put("sessionId", sessionId);
            reply.put("handle", "session.create".equals(type) ? nextHandle.getAndIncrement() : nextHandle.get() - 1);
            reply.put("answer", "v=0 answer for test");
            sendJson(reply);
        } else if ("stats.get".equals(type) && autoStats) {
            Map<String, Object> reply = new LinkedHashMap<>();
            reply.put("t", "stats");
            reply.put("sessions", List.of());
            reply.put("bytesSent", statsTotals.get(0));
            reply.put("bytesReceived", statsTotals.get(1));
            reply.put("peerBytesSent", statsTotals.get(2));
            sendJson(reply);
        } else if ("session.close".equals(type) && autoClosed) {
            sendJson(Map.of("t", "session.closed", "sessionId", Json.string(message, "sessionId"), "reason", "closed"));
        }
    }

    private void onClipboard(String type, Map<String, Object> message) {
        Object id = message.get("id");
        switch (type) {
            case "clipboard.watch" -> watching = Boolean.TRUE.equals(message.get("on"));
            case "clipboard.set" -> {
                byte[] part = Base64.getDecoder().decode(Json.string(message, "data"));
                byte[] before = Integer.valueOf(0).equals(message.get("part")) ? new byte[0] : joining.getOrDefault(id, new byte[0]);
                byte[] joined = Arrays.copyOf(before, before.length + part.length);
                System.arraycopy(part, 0, joined, before.length, part.length);
                if (Boolean.TRUE.equals(message.get("last"))) {
                    joining.remove(id);
                    clipboard = joined;
                    sendJson(Map.of("t", "clipboard.ok", "id", id));
                } else {
                    joining.put(id, joined);
                }
            }
            case "clipboard.get" -> sendClipboardText(id, clipboard, ((Number) message.get("maxBytes")).intValue());
            default -> throw new IllegalStateException("deskd sent " + type);
        }
    }

    /** A get's answer, as desk-rtc gives it: parts of 45 KiB, none for no text, or too_large past maxBytes. */
    public void sendClipboardText(Object id, byte[] text, int maxBytes) {
        if (text == null) {
            sendJson(Map.of("t", "clipboard.text", "id", id, "part", 0, "last", true, "none", true));
            return;
        }
        if (text.length > maxBytes) {
            sendJson(Map.of("t", "clipboard.error", "id", id, "code", "too_large"));
            return;
        }
        int partBytes = 45 * 1024;
        int part = 0;
        int from = 0;
        do {
            int to = Math.min(text.length, from + partBytes);
            sendJson(Map.of(
                    "t", "clipboard.text", "id", id, "part", part++, "last", to == text.length,
                    "data", Base64.getEncoder().encodeToString(Arrays.copyOfRange(text, from, to))));
            from = to;
        } while (from < text.length);
    }

    private void onData(ByteBuffer body) {
        long handle = body.getInt() & 0xFFFFFFFFL;
        int channel = body.get() & 0xFF;
        byte[] frameBytes = new byte[body.remaining()];
        body.get(frameBytes);
        bytesFromDeskd.computeIfAbsent(key(handle, channel), k -> new AtomicLong()).addAndGet(frameBytes.length);
        if (recordOrder) {
            order.add("data:" + frameBytes.length);
        }
        try {
            queue(handle, channel).add(Frame.decode(frameBytes));
        } catch (FrameException e) {
            throw new IllegalStateException("deskd sent a bad frame", e);
        }
        if (autoCredit) {
            sendCredit(handle, channel, frameBytes.length);
        }
    }
}
