package com.minimalistalliance.desk.deskd.apps;

import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The app's side of {@code app.sock}, in Java, behaving as the sample's Tally does (the contract's section 1.5): it listens,
 * answers HELLO, serves {@code tally.get}, {@code tally.add} and {@code tally.reset} with idempotency by {@code idem}, the
 * topics {@code tally} and {@code app.summary}, and PING. It can be told to misbehave: never answer HELLO, close with 4426,
 * or crash.
 */
final class FakeApp implements AutoCloseable {

    enum Hello { ANSWER, SILENT, MISMATCH }

    final Path socket;
    final Hello hello;
    final AtomicInteger count = new AtomicInteger();
    final List<Map<String, Object>> requests = new CopyOnWriteArrayList<>();
    final List<Map<String, Object>> subscribes = new CopyOnWriteArrayList<>();
    final List<Map<String, Object>> hellos = new CopyOnWriteArrayList<>();
    final List<Map<String, Object>> fromDeskd = new CopyOnWriteArrayList<>();
    private final Map<String, byte[]> done = new ConcurrentHashMap<>();
    private final Map<Long, String> subs = new ConcurrentHashMap<>();
    private final AtomicLong nextSub = new AtomicLong();
    private final ServerSocketChannel server;
    private volatile SocketChannel connection;
    private volatile boolean closed;

    FakeApp(Path socket, Hello hello) throws IOException {
        this.socket = socket;
        this.hello = hello;
        Files.createDirectories(socket.getParent());
        Files.deleteIfExists(socket);
        server = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        server.bind(UnixDomainSocketAddress.of(socket));
        Thread.ofVirtual().name("fake-app").start(this::acceptLoop);
    }

    private void acceptLoop() {
        while (!closed) {
            try {
                SocketChannel c = server.accept();
                SocketChannel old = connection;
                if (old != null) {
                    old.close();
                }
                connection = c;
                Thread.ofVirtual().name("fake-app-conn").start(() -> serve(c));
            } catch (IOException e) {
                return;
            }
        }
    }

    private void serve(SocketChannel c) {
        try {
            AppLink.Frame first = AppLink.read(c);
            hellos.add(Json.parseObject(first.payload()));
            if (hello == Hello.SILENT) {
                Thread.sleep(60_000);
                return;
            }
            if (hello == Hello.MISMATCH) {
                send(c, FrameKind.CLOSE.code(), 0, 0, Map.of("code", 4426, "reason", "app_api_mismatch", "appApi", "2.0"));
                c.close();
                return;
            }
            send(c, FrameKind.HELLO.code(), 0, 0, Map.of("appApi", "1.0", "app", Map.of("id", TestApps.ID, "version", "x")));
            while (!closed) {
                AppLink.Frame f = AppLink.read(c);
                int kind = f.kind();
                if (kind == FrameKind.PING.code()) {
                    send(c, FrameKind.PONG.code(), f.id(), 0, null);
                } else if (kind == FrameKind.REQ.code()) {
                    request(c, f);
                } else if (kind == FrameKind.SUB.code()) {
                    Map<String, Object> body = Json.parseObject(f.payload());
                    subscribes.add(body);
                    String topic = Json.string(body, "topic");
                    if (!"tally".equals(topic) && !"app.summary".equals(topic)) {
                        send(c, FrameKind.ERR.code(), f.id(), 0, Map.of("code", "not_found", "message", "No such topic"));
                        continue;
                    }
                    long sub = nextSub.incrementAndGet();
                    subs.put(sub, topic);
                    send(c, FrameKind.RES.code(), f.id(), 0, Map.of("subId", sub, "seq", 0));
                    send(c, FrameKind.EVT.code(), sub, 1, Map.of("type", "snapshot", "data", data(topic)));
                } else if (kind == FrameKind.UNSUB.code()) {
                    Object sub = Json.parseObject(f.payload()).get("subId");
                    subs.remove(((Number) sub).longValue());
                    send(c, FrameKind.RES.code(), f.id(), 0, Map.of());
                } else if (kind == FrameKind.CLOSE.code()) {
                    return;
                } else if (kind == FrameKind.RES.code()) {
                    fromDeskd.add(Json.parseObject(f.payload()));
                }
            }
        } catch (Exception e) {
            // The connection's gone.
        }
    }

    private void request(SocketChannel c, AppLink.Frame f) throws Exception {
        Map<String, Object> r = Json.parseObject(f.payload());
        requests.add(r);
        String m = Json.string(r, "m");
        String idem = Json.string(r, "idem");
        switch (m) {
            case "tally.get" -> send(c, FrameKind.RES.code(), f.id(), 0, Map.of("count", count.get()));
            case "tally.add", "tally.reset" -> {
                byte[] before = idem == null ? null : done.get(idem);
                if (before != null) {
                    write(c, AppLink.encode(FrameKind.RES.code(), f.id(), 0, before));
                    return;
                }
                Map<String, Object> p = Json.object(r, "p");
                int by = p != null && p.get("by") instanceof Integer i ? i : 1;
                if ("tally.add".equals(m) && by == 0) {
                    send(c, FrameKind.ERR.code(), f.id(), 0, Map.of("code", "bad_request", "message", "by: not 0", "details", Map.of("field", "by")));
                    return;
                }
                int now = "tally.reset".equals(m) ? 0 : count.addAndGet(by);
                if ("tally.reset".equals(m)) {
                    count.set(0);
                }
                byte[] res = Json.bytes(Map.of("count", now));
                if (idem != null) {
                    done.put(idem, res);
                }
                write(c, AppLink.encode(FrameKind.RES.code(), f.id(), 0, res));
                for (Map.Entry<Long, String> s : subs.entrySet()) {
                    send(c, FrameKind.EVT.code(), s.getKey(), 2, Map.of("type", "patch", "data", data(s.getValue())));
                }
            }
            case "weird.error" -> send(c, FrameKind.ERR.code(), f.id(), 0, Map.of("code", "teapot", "message", "secret detail"));
            case "ask.desk" -> {
                send(c, FrameKind.REQ.code(), 99, 0, Map.of("m", "desk.info.get", "p", Map.of()));
                send(c, FrameKind.RES.code(), f.id(), 0, Map.of());
            }
            default -> send(c, FrameKind.ERR.code(), f.id(), 0, Map.of("code", "not_found", "message", "No such method"));
        }
    }

    private Object data(String topic) {
        if ("app.summary".equals(topic)) {
            return Map.of("rows", List.of(Map.of("text", String.valueOf(count.get()), "detail", "Tally")));
        }
        return Map.of("count", count.get());
    }

    void send(SocketChannel c, int kind, long id, long seq, Object body) throws IOException {
        write(c, AppLink.encode(kind, id, seq, body == null ? new byte[0] : Json.bytes(body)));
    }

    private synchronized void write(SocketChannel c, byte[] bytes) throws IOException {
        ByteBuffer out = ByteBuffer.wrap(bytes);
        while (out.hasRemaining()) {
            c.write(out);
        }
    }

    /** Sends raw bytes on the current connection, as a misbehaving app might. */
    void raw(byte[] bytes) throws IOException {
        write(connection, bytes);
    }

    /** Dies at once: the socket and the listener closed with no CLOSE frame, as a killed process would leave them. */
    void crash() throws IOException {
        close();
    }

    boolean connected() {
        SocketChannel c = connection;
        return c != null && c.isOpen();
    }

    Map<String, Object> lastRequest() {
        return requests.isEmpty() ? null : requests.get(requests.size() - 1);
    }

    static Map<String, Object> copy(Map<String, Object> m) {
        return new LinkedHashMap<>(m);
    }

    @Override
    public void close() throws IOException {
        closed = true;
        server.close();
        SocketChannel c = connection;
        if (c != null) {
            c.close();
        }
        Files.deleteIfExists(socket);
    }
}
