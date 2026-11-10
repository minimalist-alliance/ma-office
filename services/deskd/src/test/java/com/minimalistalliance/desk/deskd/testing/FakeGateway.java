package com.minimalistalliance.desk.deskd.testing;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.java_websocket.WebSocket;
import org.java_websocket.WebSocketImpl;
import org.java_websocket.drafts.Draft;
import org.java_websocket.drafts.Draft_6455;
import org.java_websocket.exceptions.InvalidDataException;
import org.java_websocket.extensions.IExtension;
import org.java_websocket.framing.Framedata;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.protocols.IProtocol;
import org.java_websocket.protocols.Protocol;
import org.java_websocket.server.WebSocketServer;

/**
 * Stands in for gw. on a real WebSocket: it takes the desk's connection, answers ready and ping as
 * gateway.md says, records everything, and sends what a test tells it to. It notes the largest single
 * frame, since API Gateway drops a connection that sends one over 32 KiB.
 */
public final class FakeGateway implements AutoCloseable {

    /** @param auth X-MA-Desk-Auth as it arrived */
    public record Upgrade(String path, String auth, String protocol) {}

    public final BlockingQueue<Upgrade> upgrades = new LinkedBlockingQueue<>();
    public final AtomicInteger connections = new AtomicInteger();
    public final AtomicInteger largestFrameBytes = new AtomicInteger();
    public volatile boolean answerReady = true;
    public volatile boolean answerPing = true;

    private final BlockingQueue<Map<String, Object>> received = new LinkedBlockingQueue<>();
    private final List<String> timeline;
    private final CountDownLatch started = new CountDownLatch(1);
    private final Server server;
    private volatile WebSocket socket;

    static {
        TestTiming.pollFast();
    }

    /** @param timeline ready is added here when it arrives; may be a throwaway list */
    public FakeGateway(List<String> timeline) throws InterruptedException {
        this.timeline = timeline;
        server = new Server();
        server.setReuseAddr(true);
        server.start();
        if (!started.await(10, TimeUnit.SECONDS)) {
            throw new IllegalStateException("fake gateway didn't start");
        }
    }

    public String url() {
        return "ws://127.0.0.1:" + server.getPort() + "/v1";
    }

    public void send(Map<String, Object> message) {
        socket.send(new String(Json.bytes(message), StandardCharsets.UTF_8));
    }

    /** Closes the current connection with this code, as API Gateway does with 1001 at 2 h. */
    public void closeConnection(int code) {
        socket.close(code, "closing");
    }

    /** The next message of this type; others in the way are dropped. */
    public Map<String, Object> await(String type) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(FakeDeskRtc.TIMEOUT_SECONDS);
        while (System.nanoTime() < deadline) {
            Map<String, Object> message = received.poll(20, TimeUnit.MILLISECONDS);
            if (message != null && type.equals(message.get("type"))) {
                return message;
            }
        }
        throw new AssertionError("no gateway message of type " + type);
    }

    /** The next message of any type within the wait, or null. */
    public Map<String, Object> poll(long millis) throws InterruptedException {
        return received.poll(millis, TimeUnit.MILLISECONDS);
    }

    @Override
    public void close() throws InterruptedException {
        server.stop(200);
    }

    /** The library hides fragments from the server, so this is where a frame's size can be seen. */
    private final class MeasuringDraft extends Draft_6455 {
        MeasuringDraft() {
            super(Collections.<IExtension>emptyList(), List.<IProtocol>of(new Protocol("ma.gw.v1")));
        }

        @Override
        public Draft copyInstance() {
            return new MeasuringDraft();
        }

        @Override
        public void processFrame(WebSocketImpl connection, Framedata frame) throws InvalidDataException {
            largestFrameBytes.accumulateAndGet(frame.getPayloadData().remaining(), Math::max);
            super.processFrame(connection, frame);
        }
    }

    private final class Server extends WebSocketServer {
        Server() {
            super(new InetSocketAddress("127.0.0.1", 0), List.of(new MeasuringDraft()));
        }

        @Override
        public void onOpen(WebSocket connection, ClientHandshake handshake) {
            socket = connection;
            connections.incrementAndGet();
            upgrades.add(new Upgrade(
                    handshake.getResourceDescriptor(),
                    handshake.getFieldValue("X-MA-Desk-Auth"),
                    handshake.getFieldValue("Sec-WebSocket-Protocol")));
        }

        @Override
        public void onMessage(WebSocket connection, String text) {
            Map<String, Object> message;
            try {
                message = Json.parseObject(text.getBytes(StandardCharsets.UTF_8));
            } catch (JsonFormatException e) {
                throw new IllegalStateException("deskd sent bad JSON", e);
            }
            received.add(message);
            Object type = message.get("type");
            if ("ready".equals(type)) {
                timeline.add("ready");
                if (answerReady) {
                    connection.send("{\"type\":\"ready.ack\",\"at\":\"2026-11-05T00:00:00Z\"}");
                }
            } else if ("ping".equals(type) && answerPing) {
                connection.send("{\"type\":\"pong\",\"at\":\"2026-11-05T00:00:00Z\"}");
            }
        }

        @Override
        public void onClose(WebSocket connection, int code, String reason, boolean remote) {
            // A test sees the effect.
        }

        @Override
        public void onError(WebSocket connection, Exception error) {
            // A test sees the effect.
        }

        @Override
        public void onStart() {
            started.countDown();
        }
    }
}
