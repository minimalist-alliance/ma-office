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
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Function;

/**
 * desk-notebook's side of {@code notebook.sock}, scripted, on a real Unix socket, with the contract's frames and one
 * connection per deskd session. Methods with a handler are answered at once, and the rest wait in {@link #requests} for
 * the test. A {@code sub} gets {@link #tree} as its first event. It keeps no notes: {@link #likeTheService} gives it
 * just enough state for {@code notebook/NotebookContractChecks}.
 *
 * <p>It can misbehave the ways a real one could: {@link Connection#stall()} or {@link #stallAll()} stop reading, so
 * deskd's writes fill the socket and park. {@link #stopAccepting()} leaves connections in the backlog.
 * {@link Connection#sendRaw} sends a frame's header and only as much of it as a test wants.
 */
public final class FakeNotebookSocket implements NotebookService {

    /** One {@code req} with no handler, for the test to answer. */
    public record Request(Connection connection, long id, String method, Map<String, Object> params) {
        public void reply(Object result) {
            connection.reply(id, result);
        }
    }

    /** One accepted connection, deskd's for one session. */
    public final class Connection {
        private final SocketChannel channel;
        private final ReentrantLock writeLock = new ReentrantLock();
        /** Every JSON message from deskd in order, the hello first. */
        public final BlockingQueue<Map<String, Object>> received = new LinkedBlockingQueue<>();
        public final BlockingQueue<byte[]> collab = new LinkedBlockingQueue<>();
        /** Live subscriptions: sid to topic. */
        public final Map<Long, String> subscriptions = new ConcurrentHashMap<>();
        private volatile boolean stalled;
        private volatile boolean open = true;

        Connection(SocketChannel channel) {
            this.channel = channel;
        }

        public boolean isOpen() {
            return open;
        }

        /** Stops reading: what deskd writes next waits in the socket, and then in deskd. */
        public void stall() {
            stalled = true;
        }

        public void resume() {
            stalled = false;
        }

        public void reply(long id, Object r) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("t", "res");
            m.put("id", id);
            m.put("r", r);
            sendJson(m);
        }

        public void error(long id, String code, Map<String, Object> details) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("t", "err");
            m.put("id", id);
            m.put("code", code);
            m.put("details", details);
            sendJson(m);
        }

        public void event(long sid, Map<String, Object> data) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("t", "evt");
            m.put("sid", sid);
            m.put("data", data);
            sendJson(m);
        }

        /** One collab message, as a {@code 0x02} frame. */
        public void sendCollab(byte[] message) {
            send((byte) 0x02, message);
        }

        public void sendJson(Map<String, Object> m) {
            send((byte) 0x01, Json.bytes(m));
        }

        /** A frame claiming this length (of what follows it) and this type, and just this much of it. */
        public void sendRaw(int length, byte type, byte[] start) {
            ByteBuffer frame = ByteBuffer.allocate(5 + start.length);
            frame.putInt(length).put(type).put(start).flip();
            write(frame);
        }

        /** The next message from deskd with this {@code t}, skipping others. */
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

        /** Closes it, as a crash of desk-notebook would. */
        public void drop() {
            close(channel);
        }

        private void send(byte type, byte[] body) {
            ByteBuffer frame = ByteBuffer.allocate(5 + body.length);
            frame.putInt(1 + body.length).put(type).put(body).flip();
            write(frame);
        }

        private void write(ByteBuffer frame) {
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

        private void read() {
            ByteBuffer header = ByteBuffer.allocate(5);
            try {
                while (fill(header.clear())) {
                    int length = header.getInt(0);
                    ByteBuffer body = ByteBuffer.allocate(length - 1);
                    if (!fill(body)) {
                        break;
                    }
                    if (header.get(4) == 0x02) {
                        collab.add(body.array());
                        collabReceived.add(body.array());
                        Function<byte[], byte[]> answer = collabHandler;
                        if (answer != null) {
                            sendCollab(answer.apply(body.array()));
                        }
                    } else {
                        onJson(Json.parseObject(body.array()));
                    }
                }
            } catch (Exception e) {
                // The connection ends.
            } finally {
                open = false;
                subscriptions.clear();
                close(channel);
            }
        }

        private void onJson(Map<String, Object> m) {
            received.add(m);
            switch (String.valueOf(m.get("t"))) {
                case "req" -> {
                    long id = ((Number) m.get("id")).longValue();
                    String method = (String) m.get("m");
                    @SuppressWarnings("unchecked")
                    Map<String, Object> p = (Map<String, Object>) m.get("p");
                    Function<Map<String, Object>, Object> handler = handlers.get(method);
                    if (handler == null) {
                        requests.add(new Request(this, id, method, p));
                    } else {
                        Object result = handler.apply(p);
                        if (result instanceof Refusal refusal) {
                            error(id, refusal.code(), refusal.details());
                        } else {
                            reply(id, result);
                        }
                    }
                }
                case "sub" -> {
                    long sid = ((Number) m.get("sid")).longValue();
                    subscriptions.put(sid, (String) m.get("topic"));
                    Map<String, Object> first = tree;
                    if (first != null) {
                        event(sid, first);
                    }
                }
                case "unsub" -> subscriptions.remove(((Number) m.get("sid")).longValue());
                case "health" -> {
                    healthAsks.incrementAndGet();
                    Map<String, Object> reply = new LinkedHashMap<>();
                    reply.put("t", "health");
                    reply.put("ok", true);
                    reply.put("version", "fake");
                    reply.put("pages", 3);
                    Map<String, Object> said = storage;
                    if (said != null) {
                        reply.put("storage", said);
                    }
                    sendJson(reply);
                }
                default -> { }
            }
        }

        private boolean fill(ByteBuffer buffer) throws IOException, InterruptedException {
            while (buffer.position() < buffer.capacity()) {
                while (stalled || stallAll) {
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

    /** What a handler returns for an {@code err}. */
    public record Refusal(String code, Map<String, Object> details) {}

    private final Path path;
    private ServerSocketChannel server;
    private volatile boolean accepting = true;
    private volatile boolean closed;
    private volatile boolean stallAll;

    /** Every connection ever accepted, oldest first. */
    public final List<Connection> connections = new CopyOnWriteArrayList<>();
    public final BlockingQueue<Request> requests = new LinkedBlockingQueue<>();
    public final Map<String, Function<Map<String, Object>, Object>> handlers = new ConcurrentHashMap<>();
    /** Each collab message from deskd on any connection. */
    public final BlockingQueue<byte[]> collabReceived = new LinkedBlockingQueue<>();
    /** The first event of a new {@code sub}, or null for none. */
    public volatile Map<String, Object> tree = Map.of("rev", 1);
    /** The health frame's {@code storage}, as desk-notebook says it from main 6216d1e8; null leaves it out, as before. */
    public volatile Map<String, Object> storage = Map.of(
            "state", "ok", "unsavedPages", 0, "unsavedBytes", 0, "refusing", false, "degradedSeconds", 0);
    /** How many {@code health} frames it has answered. */
    public final java.util.concurrent.atomic.AtomicInteger healthAsks = new java.util.concurrent.atomic.AtomicInteger();
    /** If set, what to send back for a collab message. */
    public volatile Function<byte[], byte[]> collabHandler;

    public FakeNotebookSocket(Path path) throws IOException {
        this.path = path;
        listen();
    }

    /** No {@code accept}: what connects stays in the backlog, as with a desk-notebook whose event loop has hung. */
    public void stopAccepting() {
        accepting = false;
    }

    /** Stops reading on every connection, and on any that comes. */
    public void stallAll() {
        stallAll = true;
    }

    public void resumeAll() {
        stallAll = false;
    }

    public Connection last() {
        return connections.isEmpty() ? null : connections.get(connections.size() - 1);
    }

    public long openConnections() {
        return connections.stream().filter(Connection::isOpen).count();
    }

    public void dropAll() {
        connections.forEach(Connection::drop);
    }

    /** What the contract's table says for the few methods {@code notebook/NotebookContractChecks} uses. */
    public void likeTheService() {
        List<Map<String, Object>> notebooks = new CopyOnWriteArrayList<>();
        long[] rev = {0};
        tree = Map.of("rev", 0);
        handlers.put("notebook.tree", p -> {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("notebooks", List.copyOf(notebooks));
            result.put("tabs", List.of());
            result.put("pages", List.of());
            result.put("rev", rev[0]);
            result.put("next", null);
            return result;
        });
        handlers.put("notebook.notebook.create", p -> {
            Map<String, Object> notebook = new LinkedHashMap<>();
            notebook.put("id", "n" + (notebooks.size() + 1));
            notebook.put("title", p.getOrDefault("title", ""));
            notebooks.add(notebook);
            rev[0]++;
            publish(Map.of("rev", rev[0]));
            return Map.of("notebook", notebook, "tab", Map.of(), "page", Map.of());
        });
        handlers.put("notebook.page.trash", p -> new Refusal("not_found", Map.of()));
        // ADR 0091: the desk has no pages here, and a label that isn't one of the six colors is refused before the page is looked for.
        handlers.put("notebook.page.label", p -> {
            Object label = p.get("label");
            if (label != null && !(label instanceof String s && s.matches("blue|green|amber|rose|violet|slate"))) return new Refusal("bad_request", Map.of("reason", "label"));
            return new Refusal("not_found", Map.of());
        });
        handlers.put("notebook.page.duplicate", p -> new Refusal("not_found", Map.of()));
    }

    /** One event to every subscription on every open connection, and the first event of any later one. */
    public void publish(Map<String, Object> data) {
        tree = data;
        for (Connection connection : new ArrayList<>(connections)) {
            if (connection.isOpen()) {
                connection.subscriptions.keySet().forEach(sid -> connection.event(sid, data));
            }
        }
    }

    @Override
    public Path socket() {
        return path;
    }

    /** Every connection breaks. It goes on listening, as what keeps the socket's path isn't what's being tested. */
    @Override
    public void restart() {
        dropAll();
    }

    @Override
    public void close() throws IOException {
        closed = true;
        stallAll = false;
        dropAll();
        server.close();
        Files.deleteIfExists(path);
    }

    private void listen() throws IOException {
        Files.deleteIfExists(path);
        server = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        server.bind(UnixDomainSocketAddress.of(path));
        Thread.ofVirtual().name("fake-notebook").start(this::accept);
    }

    private void accept() {
        ServerSocketChannel listening = server;
        while (!closed) {
            try {
                while (!accepting) {
                    Thread.sleep(1);
                }
                Connection connection = new Connection(listening.accept());
                connections.add(connection);
                Thread.ofVirtual().name("fake-notebook-read").start(connection::read);
            } catch (IOException e) {
                return;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    private static void close(SocketChannel channel) {
        try {
            channel.close();
        } catch (IOException e) {
            // Nothing to do.
        }
    }
}
