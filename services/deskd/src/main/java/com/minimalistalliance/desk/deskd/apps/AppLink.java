package com.minimalistalliance.desk.deskd.apps;

import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.TokenBucket;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import jdk.net.ExtendedSocketOptions;
import jdk.net.UnixDomainPrincipal;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * deskd's connection to one app, on {@code /run/ma-apps/<id>/app.sock} (the desk app contract, section 5). The app listens;
 * deskd connects, checks the peer's uid ({@code SO_PEERCRED}) is the app's, says HELLO and waits for the app's.
 *
 * <p><b>Frames.</b> A {@code u32be} length, then one frame exactly as the data channels have it (design 4.2.4: the 12-byte
 * header, then the payload), never fragmented: REQ and RES up to 1 MiB, every other kind up to 64 KiB. A frame past its
 * limit, a wrong version, a set reserved byte or a second HELLO ends the link. AUTH, ACTIVITY, DATA, CHUNK and CREDIT are
 * reserved, and like any unknown kind are ignored.
 *
 * <p><b>Threads.</b> A reader, a writer and a ticker, all virtual. Callers only queue frames and wait for their reply, so
 * nothing that interrupts a caller can close the socket for everyone (the writer alone touches it). The ticker wakes every
 * 5 s: it PINGs every 30 s, ends the link after 3 PINGs with no PONG, and ends it when a write has made no progress for
 * 10 s, which is how a stalled app fails its own link and nothing else.
 *
 * <p><b>Bounds.</b> 32 calls in flight from deskd, 4 MiB queued to write, and from the app 50 requests a second and 8 at
 * once. Nothing here logs a method, a param, a result or an event.
 */
final class AppLink {

    private static final Logger log = LoggerFactory.getLogger(AppLink.class);

    static final int HEADER = 12;
    static final int MAX_CALLS = 32;
    static final long MAX_QUEUED = 4L << 20;
    static final int APP_REQUESTS_PER_SECOND = 50;
    static final int APP_REQUESTS_AT_ONCE = 8;
    static final int CLOSE_API_MISMATCH = 4426;
    static final int CLOSE_PROTOCOL = 4000;
    private static final Duration PING_EVERY = Duration.ofSeconds(30);
    private static final int MISSED_PONGS = 3;
    private static final Duration WRITE_STALL = Duration.ofSeconds(10);
    /** How often the ticker looks: a stalled write is caught within 15 s, and a PING goes every 30. */
    private static final Duration TICK = Duration.ofSeconds(5);
    /** Codes an app's ERR may carry to the client. Anything else becomes {@code internal}. */
    private static final Set<String> CODES = Set.of(
            RpcException.BAD_REQUEST, RpcException.FORBIDDEN, RpcException.NOT_FOUND, RpcException.PRECONDITION_FAILED,
            RpcException.CONFLICT, RpcException.TOO_LARGE, RpcException.RATE_LIMITED, RpcException.UNAVAILABLE,
            RpcException.DEADLINE_EXCEEDED, RpcException.CANCELLED);

    /** What deskd does with what the app does on its own. */
    interface Events {
        /** The app asked deskd for something (section 5.3). Runs on its own virtual thread. */
        Object request(String method, Map<String, Object> params) throws RpcException;

        /**
         * The link has gone, once, for whatever reason. {@code planned} if deskd closed it; {@code code} is the app's CLOSE
         * code if it sent one (4426 for another major), else 0.
         */
        void down(AppLink link, boolean planned, int code);
    }

    /** Events of one subscription, in order, on the reader's thread: must not block. */
    @FunctionalInterface
    interface Sink {
        void event(String type, Object data);
    }

    /** The link couldn't be opened. {@link #reason} is what the member's tile says: {@code no_hello} or {@code needs_update}. */
    static final class OpenException extends Exception {
        private static final long serialVersionUID = 1L;

        private final String reason;

        OpenException(String reason) {
            super(reason, null, false, false);
            this.reason = reason;
        }

        String reason() {
            return reason;
        }
    }

    private record Pending(CompletableFuture<Frame> reply, Sink sink) {}

    record Frame(int kind, long id, long seq, byte[] payload) {}

    private final SocketChannel channel;
    private final Events events;
    private final Map<String, Object> hello;
    private final Map<Long, Pending> pending = new ConcurrentHashMap<>();
    private final Map<Long, Sink> subscriptions = new ConcurrentHashMap<>();
    private final Semaphore calls = new Semaphore(MAX_CALLS);
    private final Semaphore appCalls = new Semaphore(APP_REQUESTS_AT_ONCE);
    private final TokenBucket appRate = new TokenBucket(APP_REQUESTS_PER_SECOND, APP_REQUESTS_PER_SECOND, System::nanoTime);
    private final LinkedBlockingQueue<byte[]> queue = new LinkedBlockingQueue<>();
    private final AtomicLong queued = new AtomicLong();
    private final AtomicLong ids = new AtomicLong();
    private final AtomicBoolean gone = new AtomicBoolean();
    private volatile long writingSince;
    private volatile long lastPong = System.nanoTime();
    private volatile boolean planned;
    private volatile int closeCode;

    private AppLink(SocketChannel channel, Map<String, Object> hello, Events events) {
        this.channel = channel;
        this.hello = hello;
        this.events = events;
    }

    /**
     * Connects (trying again while the socket isn't there yet, as the app may still be starting), checks the peer, and
     * trades HELLOs, all within {@code wait}.
     *
     * @param deskHello deskd's HELLO payload
     * @throws OpenException {@code needs_update} if the app closed with 4426 or speaks another major; otherwise {@code no_hello}
     */
    static AppLink open(Path socket, int peerUid, Map<String, Object> deskHello, Duration wait, Events events)
            throws OpenException, InterruptedException {
        long deadline = System.nanoTime() + wait.toNanos();
        SocketChannel channel = connect(socket, deadline);
        // Whichever comes first, the HELLO or the deadline, settles it: the watchdog closes the channel only if it wins.
        AtomicBoolean settled = new AtomicBoolean();
        Thread watchdog = Thread.ofVirtual().name("app-hello").start(() -> {
            try {
                Thread.sleep(Duration.ofNanos(Math.max(1, deadline - System.nanoTime())));
                if (settled.compareAndSet(false, true)) {
                    closeQuietly(channel);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        try {
            if (peerUid(channel) != peerUid) {
                log.warn("app link: refused a socket whose peer isn't the app's uid");
                throw new OpenException("no_hello");
            }
            write(channel, encode(FrameKind.HELLO.code(), 0, 0, Json.bytes(deskHello)));
            Frame frame = read(channel);
            Map<String, Object> reply = frame.payload().length == 0 ? Map.of() : Json.parseObject(frame.payload());
            if (frame.kind() == FrameKind.CLOSE.code()) {
                throw new OpenException(Integer.valueOf(CLOSE_API_MISMATCH).equals(reply.get("code")) ? "needs_update" : "no_hello");
            }
            if (frame.kind() != FrameKind.HELLO.code()) {
                throw new OpenException("no_hello");
            }
            String appApi = Json.string(reply, "appApi");
            if (appApi == null || !major(appApi).equals(major(Json.string(deskHello, "appApi")))) {
                throw new OpenException("needs_update");
            }
            if (!settled.compareAndSet(false, true)) {
                throw new OpenException("no_hello");
            }
            watchdog.interrupt();
            AppLink link = new AppLink(channel, Map.copyOf(reply), events);
            link.start();
            return link;
        } catch (IOException | JsonFormatException | RuntimeException e) {
            closeQuietly(channel);
            throw new OpenException("no_hello");
        } catch (OpenException e) {
            closeQuietly(channel);
            throw e;
        } finally {
            watchdog.interrupt();
        }
    }

    private static SocketChannel connect(Path socket, long deadline) throws OpenException, InterruptedException {
        while (true) {
            SocketChannel channel = null;
            try {
                if (Files.exists(socket)) {
                    channel = SocketChannel.open(StandardProtocolFamily.UNIX);
                    channel.connect(UnixDomainSocketAddress.of(socket));
                    return channel;
                }
            } catch (IOException e) {
                closeQuietly(channel);
            }
            if (System.nanoTime() >= deadline) {
                throw new OpenException("no_hello");
            }
            Thread.sleep(50);
        }
    }

    /** The peer's uid. A name the JDK resolved is looked up in this container's {@code /etc/passwd}; none matches nothing. */
    static int peerUid(SocketChannel channel) throws IOException {
        UnixDomainPrincipal principal = channel.getOption(ExtendedSocketOptions.SO_PEERCRED);
        String name = principal.user().getName();
        if (name.chars().allMatch(Character::isDigit) && !name.isEmpty() && name.length() < 10) {
            return Integer.parseInt(name);
        }
        try {
            for (String line : Files.readAllLines(Path.of("/etc/passwd"), StandardCharsets.UTF_8)) {
                String[] parts = line.split(":", -1);
                if (parts.length > 2 && parts[0].equals(name)) {
                    return Integer.parseInt(parts[2]);
                }
            }
        } catch (IOException | NumberFormatException e) {
            // Unknown, so refused.
        }
        return -1;
    }

    private void start() {
        Thread.ofVirtual().name("app-reader").start(this::readLoop);
        Thread.ofVirtual().name("app-writer").start(this::writeLoop);
        Thread.ofVirtual().name("app-ticker").start(this::tickLoop);
    }

    /** What the app said in its HELLO. */
    Map<String, Object> hello() {
        return hello;
    }

    boolean alive() {
        return !gone.get();
    }

    // ---- calls from deskd

    /** Runs right before a call's bytes are queued: a mutation's {@code beginEffect}. */
    @FunctionalInterface
    interface Gate {
        void open() throws RpcException;
    }

    /**
     * One REQ to the app and its reply.
     *
     * @return the RES payload, a JSON object
     * @throws RpcException the app's ERR (with a code from deskApi's list, else {@code internal}), {@code rate_limited} past 32
     *     in flight, {@code deadline_exceeded}, or {@code unavailable} if the link goes
     */
    Map<String, Object> call(Map<String, Object> request, Duration timeout, Gate gate) throws RpcException, InterruptedException {
        if (!calls.tryAcquire()) {
            throw new RpcException(RpcException.RATE_LIMITED, "Too many calls to the app at once", Map.of("limit", "appCalls"));
        }
        long id = nextId();
        try {
            Map<String, Object> body = new LinkedHashMap<>(request);
            body.put("deadlineMs", Math.max(1, timeout.toMillis()));
            byte[] bytes = Json.bytes(body);
            if (bytes.length > FrameKind.REQ.maxMessageBytes()) {
                throw new RpcException(RpcException.TOO_LARGE, "Request too large for the app");
            }
            CompletableFuture<Frame> reply = new CompletableFuture<>();
            pending.put(id, new Pending(reply, null));
            if (gate != null) {
                gate.open();
            }
            if (!send(FrameKind.REQ.code(), id, 0, bytes)) {
                throw unavailable();
            }
            Frame frame = await(reply, id, timeout, true);
            if (frame.kind() == FrameKind.ERR.code()) {
                throw relayedError(frame.payload());
            }
            try {
                return Json.parseObject(frame.payload());
            } catch (JsonFormatException e) {
                throw new RpcException(RpcException.INTERNAL, "Internal error");
            }
        } finally {
            pending.remove(id);
            calls.release();
        }
    }

    /**
     * SUB to one of the app's topics. The sink is in place before the reader reads past the RES, so the app's first event,
     * which follows its RES, reaches it.
     *
     * @return the app's {@code subId}
     */
    long subscribe(String topic, Map<String, Object> from, Sink sink, Duration timeout) throws RpcException, InterruptedException {
        long id = nextId();
        try {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("topic", topic);
            body.put("from", from);
            CompletableFuture<Frame> reply = new CompletableFuture<>();
            pending.put(id, new Pending(reply, sink));
            if (!send(FrameKind.SUB.code(), id, 0, Json.bytes(body))) {
                throw unavailable();
            }
            Frame frame = await(reply, id, timeout, false);
            if (frame.kind() == FrameKind.ERR.code()) {
                throw relayedError(frame.payload());
            }
            return subIdOf(frame.payload());
        } finally {
            pending.remove(id);
        }
    }

    /** Lets a subscription go, without waiting for the app's reply. */
    void unsubscribe(long subId) {
        if (subscriptions.remove(subId) != null) {
            send(FrameKind.UNSUB.code(), nextId(), 0, Json.bytes(Map.of("subId", subId)));
        }
    }

    /** A planned end: CLOSE, then the socket. The app's own end follows. */
    void close() {
        planned = true;
        send(FrameKind.CLOSE.code(), 0, 0, Json.bytes(Map.of("code", 1000, "reason", "closing")));
        // The writer gets the CLOSE out first if it can; the ticker ends a stalled one.
        queue.offer(new byte[0]);
    }

    private Frame await(CompletableFuture<Frame> reply, long id, Duration timeout, boolean cancellable)
            throws RpcException, InterruptedException {
        try {
            return reply.get(timeout.toNanos(), TimeUnit.NANOSECONDS);
        } catch (TimeoutException e) {
            if (cancellable) {
                send(FrameKind.CANCEL.code(), id, 0, new byte[0]);
            }
            throw new RpcException(RpcException.DEADLINE_EXCEEDED, "The app didn't answer in time");
        } catch (InterruptedException e) {
            if (cancellable) {
                send(FrameKind.CANCEL.code(), id, 0, new byte[0]);
            }
            throw e;
        } catch (ExecutionException e) {
            throw unavailable();
        }
    }

    private static RpcException unavailable() {
        return new RpcException(RpcException.UNAVAILABLE, "The app isn't running", Map.of("reason", "app_stopped"));
    }

    private static RpcException relayedError(byte[] payload) {
        try {
            Map<String, Object> err = Json.parseObject(payload);
            String code = Json.string(err, "code");
            if (code == null || !CODES.contains(code)) {
                return new RpcException(RpcException.INTERNAL, "Internal error");
            }
            String message = Json.string(err, "message");
            message = message == null ? code : message.length() > 200 ? message.substring(0, 200) : message;
            Map<String, Object> details = Json.object(err, "details");
            if (details == null || Json.bytes(details).length > 8192) {
                details = Map.of();
            }
            return new RpcException(code, message, details);
        } catch (JsonFormatException e) {
            return new RpcException(RpcException.INTERNAL, "Internal error");
        }
    }

    private static long subIdOf(byte[] payload) throws RpcException {
        try {
            if (Json.parseObject(payload).get("subId") instanceof Number n && n.longValue() >= 0 && n.longValue() <= 0xFFFFFFFFL) {
                return n.longValue();
            }
        } catch (JsonFormatException e) {
            // As below.
        }
        throw new RpcException(RpcException.INTERNAL, "Internal error");
    }

    private long nextId() {
        // u32, never 0: HELLO and CLOSE use 0.
        return ids.updateAndGet(i -> i >= 0xFFFFFFFFL ? 1 : i + 1);
    }

    // ---- the socket

    private boolean send(int kind, long id, long seq, byte[] payload) {
        if (gone.get()) {
            return false;
        }
        byte[] frame = encode(kind, id, seq, payload);
        if (queued.addAndGet(frame.length) > MAX_QUEUED) {
            queued.addAndGet(-frame.length);
            return false;
        }
        queue.offer(frame);
        return true;
    }

    private void writeLoop() {
        try {
            while (!gone.get()) {
                byte[] frame = queue.take();
                if (frame.length == 0) {
                    if (planned && queue.isEmpty()) {
                        end(0);
                        return;
                    }
                    continue;
                }
                writingSince = System.nanoTime();
                write(channel, frame);
                writingSince = 0;
                queued.addAndGet(-frame.length);
            }
        } catch (IOException | InterruptedException e) {
            end(0);
        }
    }

    private void readLoop() {
        try {
            while (!gone.get()) {
                handle(read(channel));
            }
        } catch (IOException | RuntimeException e) {
            end(0);
        }
    }

    private void handle(Frame frame) throws IOException {
        int kind = frame.kind();
        if (kind == FrameKind.RES.code() || kind == FrameKind.ERR.code()) {
            Pending p = pending.get(frame.id());
            if (p == null) {
                return;
            }
            if (p.sink() != null && kind == FrameKind.RES.code()) {
                try {
                    subscriptions.put(subIdOf(frame.payload()), p.sink());
                } catch (RpcException e) {
                    // The caller is told.
                }
            }
            p.reply().complete(frame);
        } else if (kind == FrameKind.EVT.code()) {
            Sink sink = subscriptions.get(frame.id());
            if (sink == null) {
                return;
            }
            Map<String, Object> event;
            try {
                event = Json.parseObject(frame.payload());
            } catch (JsonFormatException e) {
                return;
            }
            String type = Json.string(event, "type");
            if ("snapshot".equals(type) || "patch".equals(type)) {
                sink.event(type, event.get("data"));
            }
        } else if (kind == FrameKind.PING.code()) {
            send(FrameKind.PONG.code(), frame.id(), 0, new byte[0]);
        } else if (kind == FrameKind.PONG.code()) {
            lastPong = System.nanoTime();
        } else if (kind == FrameKind.REQ.code()) {
            appRequest(frame);
        } else if (kind == FrameKind.SUB.code() || kind == FrameKind.UNSUB.code()) {
            send(FrameKind.ERR.code(), frame.id(), 0, error(RpcException.NOT_FOUND, "No such topic"));
        } else if (kind == FrameKind.CLOSE.code()) {
            int code = 0;
            try {
                if (frame.payload().length > 0 && Json.parseObject(frame.payload()).get("code") instanceof Integer c) {
                    code = c;
                }
            } catch (JsonFormatException e) {
                // A CLOSE with no reason.
            }
            closeCode = code;
            end(code);
        } else if (kind == FrameKind.HELLO.code()) {
            throw new IOException("second HELLO");
        }
        // CANCEL: every deskd answer is quick, so there's nothing to stop. Reserved and unknown kinds: ignored.
    }

    private void appRequest(Frame frame) {
        boolean allowed;
        synchronized (appRate) {
            allowed = appRate.tryAcquire();
        }
        if (!allowed || !appCalls.tryAcquire()) {
            send(FrameKind.ERR.code(), frame.id(), 0, error(RpcException.RATE_LIMITED, "Too many requests"));
            return;
        }
        Thread.ofVirtual().name("app-request").start(() -> {
            try {
                Map<String, Object> body = Json.parseObject(frame.payload());
                String method = Json.string(body, "m");
                Map<String, Object> params = body.get("p") == null ? Map.of() : Json.object(body, "p");
                if (method == null || params == null) {
                    throw new RpcException(RpcException.BAD_REQUEST, "Request needs m and an object p");
                }
                Object result = events.request(method, params);
                send(FrameKind.RES.code(), frame.id(), 0, Json.bytes(result == null ? Map.of() : result));
            } catch (RpcException e) {
                Map<String, Object> err = new LinkedHashMap<>();
                err.put("code", e.code());
                err.put("message", e.getMessage());
                err.put("details", e.details());
                send(FrameKind.ERR.code(), frame.id(), 0, Json.bytes(err));
            } catch (JsonFormatException | RuntimeException e) {
                send(FrameKind.ERR.code(), frame.id(), 0, error(RpcException.BAD_REQUEST, "Invalid JSON"));
            } finally {
                appCalls.release();
            }
        });
    }

    private static byte[] error(String code, String message) {
        Map<String, Object> err = new LinkedHashMap<>();
        err.put("code", code);
        err.put("message", message);
        err.put("details", Map.of());
        return Json.bytes(err);
    }

    private void tickLoop() {
        long nextPing = System.nanoTime() + PING_EVERY.toNanos();
        try {
            while (!gone.get()) {
                Thread.sleep(TICK);
                long now = System.nanoTime();
                long since = writingSince;
                if (since != 0 && now - since > WRITE_STALL.toNanos()) {
                    log.warn("app link: a write made no progress, closing");
                    end(0);
                    return;
                }
                if (now - lastPong > PING_EVERY.toNanos() * MISSED_PONGS + WRITE_STALL.toNanos()) {
                    log.warn("app link: no PONG, closing");
                    end(0);
                    return;
                }
                if (now >= nextPing) {
                    send(FrameKind.PING.code(), nextId(), 0, new byte[0]);
                    nextPing = now + PING_EVERY.toNanos();
                }
            }
        } catch (InterruptedException e) {
            end(0);
        }
    }

    /** The link's end, once: the socket closed, every waiter failed, and deskd told. */
    private void end(int code) {
        if (!gone.compareAndSet(false, true)) {
            return;
        }
        closeQuietly(channel);
        queue.offer(new byte[0]);
        for (Pending p : pending.values()) {
            p.reply().completeExceptionally(new IOException("link gone"));
        }
        subscriptions.clear();
        events.down(this, planned, code == 0 ? closeCode : code);
    }

    // ---- frames on the socket

    static byte[] encode(int kind, long id, long seq, byte[] payload) {
        ByteBuffer out = ByteBuffer.allocate(4 + HEADER + payload.length);
        out.putInt(HEADER + payload.length);
        out.put((byte) 1);
        out.put((byte) kind);
        out.put((byte) 0);
        out.put((byte) 0);
        out.putInt((int) id);
        out.putInt((int) seq);
        out.put(payload);
        return out.array();
    }

    static int limitFor(int kind) {
        return kind == FrameKind.REQ.code() || kind == FrameKind.RES.code() ? FrameKind.RES.maxMessageBytes() : 64 << 10;
    }

    /** One frame. Nothing is allocated past the length's check. */
    static Frame read(SocketChannel channel) throws IOException {
        ByteBuffer head = ByteBuffer.allocate(4 + HEADER);
        readFully(channel, head);
        head.flip();
        long length = head.getInt() & 0xFFFFFFFFL;
        int version = head.get() & 0xff;
        int kind = head.get() & 0xff;
        head.get();
        int reserved = head.get() & 0xff;
        long id = head.getInt() & 0xFFFFFFFFL;
        long seq = head.getInt() & 0xFFFFFFFFL;
        if (length < HEADER || version != 1 || reserved != 0 || length - HEADER > limitFor(kind)) {
            throw new IOException("bad frame");
        }
        ByteBuffer payload = ByteBuffer.allocate((int) (length - HEADER));
        readFully(channel, payload);
        return new Frame(kind, id, seq, payload.array());
    }

    private static void readFully(SocketChannel channel, ByteBuffer buffer) throws IOException {
        while (buffer.hasRemaining()) {
            if (channel.read(buffer) < 0) {
                throw new IOException("closed");
            }
        }
    }

    private static void write(SocketChannel channel, byte[] bytes) throws IOException {
        ByteBuffer out = ByteBuffer.wrap(bytes);
        while (out.hasRemaining()) {
            channel.write(out);
        }
    }

    private static void closeQuietly(SocketChannel channel) {
        if (channel != null) {
            try {
                channel.close();
            } catch (IOException e) {
                // Closed either way.
            }
        }
    }

    static String major(String version) {
        if (version == null) {
            return "";
        }
        int dot = version.indexOf('.');
        return dot < 0 ? version : version.substring(0, dot);
    }

    /** For tests and the ticker's checks: how the link ended. */
    int closeCode() {
        return closeCode;
    }
}
