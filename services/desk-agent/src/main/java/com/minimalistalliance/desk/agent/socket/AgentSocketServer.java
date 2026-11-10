package com.minimalistalliance.desk.agent.socket;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.json.JsonFormatException;
import com.minimalistalliance.desk.agent.service.AgentService;
import com.minimalistalliance.desk.agent.service.Caller;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.service.TopicHub;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import jdk.net.ExtendedSocketOptions;
import jdk.net.UnixDomainPrincipal;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * desk-agent's side of the agent socket (docs/proposals.md section 5): {@code /run/desk-agent/agent.sock}, mode
 * {@code 0660}, for deskd only. A peer whose {@code SO_PEERCRED} uid isn't {@code peerUid} is closed at once. One
 * connection at a time; a new one replaces the old.
 *
 * <p>Frames are {@code u32be length}, {@code u8 type}, body, at most 4 MiB. {@code 0x01} is a JSON object with a
 * {@code t}: {@code req}, {@code cancel}, {@code sub} and {@code unsub} from deskd; {@code res}, {@code err} and
 * {@code evt} back. {@code 0x02} is a key for {@code agent.key.add}, read straight into a direct buffer so it's never
 * a {@code String} here.
 *
 * <p>Each request runs on a virtual thread of its own, so a slow provider call doesn't hold up the reader. Replies
 * and events go through one writer queue; if deskd stops reading and it passes 16 MiB, the connection is dropped,
 * as a peer that doesn't read can't be allowed to grow desk-agent's memory.
 */
public final class AgentSocketServer implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(AgentSocketServer.class);

    static final int MAX_FRAME = 4 << 20;
    static final int MAX_QUEUED_BYTES = 16 << 20;
    static final int MAX_IN_FLIGHT = 64;
    static final byte JSON = 0x01;
    static final byte KEY = 0x02;

    private final Path socket;
    private final PeerCheck peers;
    private final AgentService service;
    private final TopicHub topics;
    private final AtomicLong connections = new AtomicLong();
    private ServerSocketChannel server;
    private Thread acceptor;
    private volatile Connection current;
    private volatile boolean closed;

    public AgentSocketServer(Path socket, PeerCheck peers, AgentService service, TopicHub topics) {
        this.socket = socket;
        this.peers = peers;
        this.service = service;
        this.topics = topics;
    }

    /** Binds the socket at mode 0660 under a temporary name, then gives it its real one, as the admin socket does. */
    public void start() throws IOException {
        Path temporary = socket.resolveSibling(socket.getFileName() + ".new");
        Files.deleteIfExists(temporary);
        Files.deleteIfExists(socket);
        server = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        server.bind(UnixDomainSocketAddress.of(temporary));
        Files.setPosixFilePermissions(temporary, PosixFilePermissions.fromString("rw-rw----"));
        Files.move(temporary, socket, StandardCopyOption.ATOMIC_MOVE);
        acceptor = Thread.ofVirtual().name("agent-socket-acceptor").start(this::acceptLoop);
    }

    /** Whether deskd is connected now: informational, for /health. */
    public boolean connected() {
        Connection c = current;
        return c != null && !c.closed;
    }

    private void acceptLoop() {
        while (!closed) {
            try {
                SocketChannel channel = server.accept();
                UnixDomainPrincipal peer = channel.getOption(ExtendedSocketOptions.SO_PEERCRED);
                if (!peers.allowed(peer)) {
                    log.warn("agent socket refused a peer: uid {}", peer.user().getName());
                    channel.close();
                    continue;
                }
                Connection previous = current;
                Connection next = new Connection(connections.incrementAndGet(), channel);
                current = next;
                if (previous != null) {
                    previous.close();
                }
                next.start();
            } catch (IOException e) {
                if (!closed) {
                    log.warn("agent socket accept failed: {}", e.getClass().getSimpleName());
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

    @Override
    public void close() {
        closed = true;
        try {
            if (server != null) {
                server.close();
            }
            Files.deleteIfExists(socket);
        } catch (IOException e) {
            log.debug("closing the agent socket failed");
        }
        if (acceptor != null) {
            acceptor.interrupt();
        }
        Connection c = current;
        if (c != null) {
            c.close();
        }
    }

    /** One connection from deskd: a reader, a writer, and the requests and subscriptions it started. */
    final class Connection {
        private final long number;
        private final SocketChannel channel;
        private final LinkedBlockingQueue<byte[]> outbox = new LinkedBlockingQueue<>();
        private final AtomicLong queuedBytes = new AtomicLong();
        private final Map<Long, Thread> requests = new ConcurrentHashMap<>();
        private final Map<Long, Long> subscriptions = new ConcurrentHashMap<>();
        /** Set as the connection starts to close, so nothing more is queued. */
        private volatile boolean closed;
        /** {@link #close}'s work runs once. */
        private final AtomicBoolean closing = new AtomicBoolean();
        private Thread writer;

        Connection(long number, SocketChannel channel) {
            this.number = number;
            this.channel = channel;
        }

        void start() {
            writer = Thread.ofVirtual().name("agent-socket-writer").start(this::writeLoop);
            Thread.ofVirtual().name("agent-socket-reader").start(this::readLoop);
        }

        private void readLoop() {
            ByteBuffer header = ByteBuffer.allocate(5);
            try {
                while (!closed) {
                    header.clear();
                    if (!readFully(header)) {
                        break;
                    }
                    int length = header.getInt(0);
                    byte type = header.get(4);
                    if (length < 1 || length - 1 > MAX_FRAME) {
                        throw new IOException("bad frame length");
                    }
                    if (type == JSON) {
                        ByteBuffer body = ByteBuffer.allocate(length - 1);
                        if (!readFully(body)) {
                            break;
                        }
                        onJson(Json.parseObject(body.array()));
                    } else if (type == KEY) {
                        onKey(length - 1);
                    } else {
                        throw new IOException("bad frame type");
                    }
                }
            } catch (IOException | JsonFormatException | RuntimeException e) {
                if (!closed) {
                    log.warn("agent socket connection dropped: {}", e.getClass().getSimpleName());
                }
            } finally {
                close();
            }
        }

        private boolean readFully(ByteBuffer buffer) throws IOException {
            while (buffer.hasRemaining()) {
                if (channel.read(buffer) < 0) {
                    return false;
                }
            }
            return true;
        }

        /**
         * {@code u32be id}, {@code u16be} length and the JSON head, {@code u16be} length and the key. The key is read
         * into a direct buffer, handed to the service, and zeroed.
         */
        private void onKey(int length) throws IOException, JsonFormatException {
            ByteBuffer prefix = ByteBuffer.allocate(6);
            if (!readFully(prefix)) {
                throw new IOException("closed in a key frame");
            }
            long id = Integer.toUnsignedLong(prefix.getInt(0));
            int headLength = Short.toUnsignedInt(prefix.getShort(4));
            if (6 + headLength + 2 > length) {
                throw new IOException("bad key frame");
            }
            ByteBuffer head = ByteBuffer.allocate(headLength + 2);
            if (!readFully(head)) {
                throw new IOException("closed in a key frame");
            }
            int keyLength = Short.toUnsignedInt(head.getShort(headLength));
            if (6 + headLength + 2 + keyLength != length) {
                throw new IOException("bad key frame");
            }
            Map<String, Object> json = Json.parseObject(java.util.Arrays.copyOf(head.array(), headLength));
            ByteBuffer key = ByteBuffer.allocateDirect(keyLength);
            boolean handedOver = false;
            try {
                if (!readFully(key)) {
                    throw new IOException("closed in a key frame");
                }
                key.flip();
                Map<String, Object> p = Json.object(json, "p");
                if (!"agent.key.add".equals(json.get("m")) || p == null) {
                    reply(error(id, RpcError.badRequest("key_frame")));
                    return;
                }
                Caller caller;
                try {
                    caller = Caller.parse(json.get("caller"));
                } catch (RpcError e) {
                    reply(error(id, e));
                    return;
                }
                // The provider check takes seconds, so it runs on its own thread, which zeroes the buffer after.
                Thread thread = Thread.ofVirtual().name("agent-key").unstarted(() -> {
                    Map<String, Object> answer;
                    try {
                        answer = result(id, service.keyAdd(p, key, caller));
                    } catch (RpcError e) {
                        answer = error(id, e);
                    } catch (SQLException e) {
                        answer = error(id, RpcError.of("unavailable", "reason", "unavailable"));
                    } catch (RuntimeException e) {
                        log.error("agent key request failed: {}", e.getClass().getName());
                        answer = error(id, RpcError.of("internal"));
                    } finally {
                        zero(key);
                        requests.remove(id);
                    }
                    reply(answer);
                });
                requests.put(id, thread);
                handedOver = true;
                thread.start();
            } finally {
                if (!handedOver) {
                    zero(key);
                }
            }
        }

        private static void zero(ByteBuffer buffer) {
            for (int i = 0; i < buffer.capacity(); i++) {
                buffer.put(i, (byte) 0);
            }
        }

        private void onJson(Map<String, Object> message) throws IOException {
            String t = Json.string(message, "t");
            if (t == null) {
                throw new IOException("no t");
            }
            switch (t) {
                case "req" -> onRequest(message);
                case "cancel" -> {
                    Thread request = requests.get(number(message, "id"));
                    if (request != null) {
                        request.interrupt();
                    }
                }
                case "sub" -> onSubscribe(number(message, "sid"), Json.string(message, "topic"), message.get("caller"));
                case "unsub" -> {
                    Long key = subscriptions.remove(number(message, "sid"));
                    if (key != null) {
                        topics.unsubscribe(key);
                    }
                }
                default -> throw new IOException("unknown t");
            }
        }

        private void onRequest(Map<String, Object> message) throws IOException {
            long id = number(message, "id");
            String method = Json.string(message, "m");
            Map<String, Object> p = message.get("p") == null ? Map.of() : Json.object(message, "p");
            if (method == null || p == null) {
                throw new IOException("bad req");
            }
            if (requests.size() >= MAX_IN_FLIGHT) {
                reply(error(id, RpcError.of("rate_limited")));
                return;
            }
            Object rawCaller = message.get("caller");
            Thread thread = Thread.ofVirtual().name("agent-request").unstarted(() -> {
                Map<String, Object> answer;
                try {
                    answer = result(id, service.call(method, p, Caller.parse(rawCaller)));
                } catch (RpcError e) {
                    answer = error(id, e);
                } catch (SQLException e) {
                    log.error("agent request failed on storage: {}", e.getClass().getSimpleName());
                    answer = error(id, RpcError.of("unavailable", "reason", "unavailable"));
                } catch (RuntimeException e) {
                    log.error("agent request failed: {}", e.getClass().getName());
                    answer = error(id, RpcError.of("internal"));
                } finally {
                    requests.remove(id);
                }
                reply(answer);
            });
            requests.put(id, thread);
            thread.start();
        }

        private void onSubscribe(long sid, String topic, Object rawCaller) {
            Caller caller;
            try {
                caller = Caller.parse(rawCaller);
            } catch (RpcError e) {
                caller = null;
            }
            // A teen member's subscription is refused as their calls are, and the system may watch only the state.
            if (caller != null && caller.isMember() && caller.teen()) {
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("code", "forbidden");
                data.put("reason", "age_band");
                reply(event(sid, topic, 0, "error", data));
                return;
            }
            if (topic == null || caller == null || !service.knows(topic, caller)) {
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("code", "not_found");
                reply(event(sid, topic, 0, "error", data));
                return;
            }
            long key = (number << 32) | (sid & 0xffffffffL);
            Long previous = subscriptions.put(sid, key);
            if (previous != null) {
                topics.unsubscribe(previous);
            }
            // Each view of the state is its own topic in the hub; deskd hears the name it asked for.
            topics.subscribe(key, AgentService.hubTopic(topic, caller), service.snapshotFor(topic, caller),
                    (name, seq, type, data) -> reply(event(sid, topic, seq, type, data)));
        }

        private void reply(Map<String, Object> message) {
            if (closed) {
                return;
            }
            byte[] json = Json.bytes(message);
            if (json.length > MAX_FRAME) {
                // Too big for one frame: that one answer fails, not the connection. A thread's page and snapshot are cut to
                // fit well under it (AgentService.PAGE_BYTES), so this is a backstop.
                Map<String, Object> instead = new LinkedHashMap<>(message);
                instead.put("t", "evt".equals(message.get("t")) ? "evt" : "err");
                instead.remove("r");
                instead.put("type", "error");
                instead.put("code", "too_large");
                instead.put("details", Map.of());
                instead.put("data", Map.of("code", "too_large"));
                json = Json.bytes(instead);
            }
            byte[] frame = ByteBuffer.allocate(5 + json.length).putInt(json.length + 1).put(JSON).put(json).array();
            if (queuedBytes.addAndGet(frame.length) > MAX_QUEUED_BYTES) {
                log.warn("agent socket peer isn't reading: dropping the connection");
                // Not on this thread: an event's reply runs under its topic's lock, and close() takes the lock of every
                // topic this connection is subscribed to, so two topics' publishers could each wait for the other.
                closed = true;
                Thread.ofVirtual().name("agent-socket-close").start(this::close);
                return;
            }
            outbox.add(frame);
        }

        private void writeLoop() {
            try {
                while (!closed) {
                    byte[] frame = outbox.take();
                    ByteBuffer buffer = ByteBuffer.wrap(frame);
                    while (buffer.hasRemaining()) {
                        channel.write(buffer);
                    }
                    queuedBytes.addAndGet(-frame.length);
                }
            } catch (InterruptedException | IOException e) {
                close();
            }
        }

        void close() {
            if (!closing.compareAndSet(false, true)) {
                return;
            }
            closed = true;
            for (Long key : subscriptions.values()) {
                topics.unsubscribe(key);
            }
            subscriptions.clear();
            for (Thread request : List.copyOf(requests.values())) {
                request.interrupt();
            }
            if (writer != null) {
                writer.interrupt();
            }
            try {
                channel.close();
            } catch (IOException e) {
                log.debug("closing an agent connection failed");
            }
        }
    }

    private static long number(Map<String, Object> message, String key) throws IOException {
        if (!(message.get(key) instanceof Number n)) {
            throw new IOException("no " + key);
        }
        return n.longValue();
    }

    private static Map<String, Object> result(long id, Map<String, Object> r) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "res");
        m.put("id", id);
        m.put("r", r);
        return m;
    }

    private static Map<String, Object> error(long id, RpcError e) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "err");
        m.put("id", id);
        m.put("code", e.code());
        m.put("details", e.details() == null ? Map.of() : e.details());
        return m;
    }

    private static Map<String, Object> event(long sid, String topic, long seq, String type, Map<String, Object> data) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "evt");
        m.put("sid", sid);
        m.put("topic", topic);
        m.put("seq", seq);
        m.put("type", type);
        m.put("data", data);
        return m;
    }

    /** For tests: subscriptions held by the current connection. */
    List<Long> subscriptionsForTest() {
        Connection c = current;
        return c == null ? List.of() : new ArrayList<>(c.subscriptions.keySet());
    }
}
