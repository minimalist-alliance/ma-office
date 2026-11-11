package com.minimalistalliance.desk.deskd.agent;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * deskd's side of desk-agent's socket, {@code /run/desk-agent/agent.sock} (services/desk-agent/docs/proposals.md
 * section 5). desk-agent listens and accepts only deskd's uid; this connects, and reconnects with backoff. One connection
 * for the whole desk, which every session's calls share.
 *
 * <p><b>Frames.</b> {@code u32be length} of what follows, {@code u8 type}, the body, at most 4 MiB. {@code 0x01} is a
 * JSON object with a {@code t}: deskd sends {@code req}, {@code cancel}, {@code sub} and {@code unsub}, and reads
 * {@code res}, {@code err} and {@code evt}; desk-agent's {@code tcall}, a tool call deskd runs (tools/ToolHost), is
 * answered {@code tres} or {@code terr}. {@code 0x02} carries a key for {@code agent.key.add}: {@code u32be id},
 * {@code u16be} length and a JSON head, {@code u16be} length and the key's bytes. deskd zeroes its copies once written or
 * dropped.
 *
 * <p><b>Threads.</b> Each connection has three virtual threads, as {@code notebook/NotebookLink} has, and callers touch
 * none of them, so nothing that interrupts a caller (a CANCEL, a deadline, a session's end) can reach a thread doing
 * socket I/O, which would close the channel for every session on it.
 * <ul>
 *   <li>The <b>link thread</b> connects, then reads, and cleans up when a connection goes. The reader only completes
 *       calls and hands events to the listener, which must not block.
 *   <li>The <b>writer</b> takes frames off a bounded queue, at most {@link #IO_BYTES} a write.
 *   <li>The <b>watcher</b> sleeps unless a write is under way, and closes the channel if that write makes no progress
 *       for {@code writeStall}. That's how a desk-agent that has stopped reading fails its calls, which then get
 *       {@code unavailable}, and the link connects again.
 * </ul>
 * The lock guards state and is never held across I/O or a wait for the peer. {@link #close} waits for nothing: closing a
 * {@link SocketChannel} in blocking mode wakes whoever is parked on it.
 *
 * <p><b>The queue is bounded by construction.</b> A call is refused at once, with {@code unavailable}, past
 * {@link #MAX_SESSION_CALLS} of one session's, or past {@link #MAX_QUEUED} bytes waiting to be written, so a caller never
 * waits for room, and calls stuck on a desk-agent that has stalled can't take every one of a session's 32 slots and get
 * its Browser calls {@code rate_limited}. A mutation's {@link Gate} runs on the writer, right before its bytes go: one
 * that never got that far did nothing.
 *
 * <p>Nothing here logs a method's params, a result, an event's data or a key.
 */
public final class AgentLink implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(AgentLink.class);

    static final byte JSON = 0x01;
    static final byte KEY = 0x02;
    static final int MAX_FRAME = 4 << 20;
    /**
     * Calls out to desk-agent at once, per session: half of what {@code RpcSession} allows, so calls stuck on a stalled
     * desk-agent never take every slot and get the session's other calls {@code rate_limited}.
     */
    static final int MAX_SESSION_CALLS = 16;
    /** Bytes of frames waiting to be written, past which a call is refused. One frame always fits an empty queue. */
    static final int MAX_QUEUED = MAX_FRAME;
    private static final int IO_BYTES = 64 << 10;
    /** What cancels and subscriptions may add past {@link #MAX_QUEUED}: they mustn't lose to a queue of calls. */
    private static final int CONTROL_SLACK = 64 << 10;
    /** What tool replies may add past {@link #MAX_QUEUED}: each is at most a frame, and only so many run at once. */
    private static final int REPLY_SLACK = 8 << 20;

    /** deskd's error codes (API.md section 4). desk-agent's {@code err} is relayed only with one of these. */
    private static final Set<String> CODES = Set.of(
            RpcException.BAD_REQUEST, RpcException.UNAUTHORIZED, RpcException.FORBIDDEN,
            RpcException.STEP_UP_REQUIRED, RpcException.NOT_FOUND, RpcException.PRECONDITION_FAILED,
            RpcException.CONFLICT, RpcException.TOO_LARGE, RpcException.RATE_LIMITED,
            RpcException.DEADLINE_EXCEEDED, RpcException.CANCELLED, RpcException.UNAVAILABLE, RpcException.INTERNAL);

    /**
     * @param minBackoff the first gap between tries to connect, doubling to {@code maxBackoff}
     * @param writeStall how long a write may go with no progress before the connection goes
     * @param healthyAfter a connection that lasted this long starts the backoff again; a shorter one doesn't, so a peer
     *     that accepts and drops at once is tried with the backoff, not four times a second (audit D7)
     */
    public record Timing(Duration minBackoff, Duration maxBackoff, Duration writeStall, Duration healthyAfter) {
        public static final Duration HEALTHY_AFTER = Duration.ofSeconds(10);
        public static final Timing DEFAULT =
                new Timing(Duration.ofMillis(250), Duration.ofSeconds(5), Duration.ofSeconds(5), HEALTHY_AFTER);

        public Timing(Duration minBackoff, Duration maxBackoff, Duration writeStall) {
            this(minBackoff, maxBackoff, writeStall, HEALTHY_AFTER);
        }

        public Timing(Duration minBackoff, Duration maxBackoff) {
            this(minBackoff, maxBackoff, DEFAULT.writeStall());
        }
    }

    /** What the link reports. Each runs on the link's own thread, and none may block. */
    public interface Listener {
        void connected();

        void disconnected();

        /** One {@code evt}: {@code data} as desk-agent sent it, never logged. */
        void event(long sid, String topic, String type, Map<String, Object> data);

        /**
         * One {@code tcall} from desk-agent (proposals.md section 5, "Tool calls"), the whole frame, never logged. It must
         * not block: the answer goes back through {@link AgentLink#reply}. desk-agent sends none until deskd's hello.
         */
        default void toolCall(Map<String, Object> message) {}
    }

    /** Runs on the writer, right before a call's bytes go: {@code beginEffect} for a mutation. */
    @FunctionalInterface
    interface Gate {
        void open() throws RpcException;
    }

    private static final Listener NONE = new Listener() {
        @Override
        public void connected() {}

        @Override
        public void disconnected() {}

        @Override
        public void event(long sid, String topic, String type, Map<String, Object> data) {}
    };

    /** One frame on its way out, whole, header and all. A call stays in {@link #calls} until its caller is done with it. */
    private static final class Outgoing {
        private static final int QUEUED = 0;
        private static final int WRITING = 1;
        private static final int WITHDRAWN = 2;

        final byte[] frame;
        final Gate gate;
        /** A call's reply. Failing it fails whoever waits. */
        final CompletableFuture<Map<String, Object>> done = new CompletableFuture<>();
        final AtomicInteger state = new AtomicInteger(QUEUED);

        Outgoing(byte[] frame, Gate gate) {
            this.frame = frame;
            this.gate = gate;
        }

        /** @return false if it's not to be written: its caller left, or its gate refused */
        boolean begin() {
            if (!state.compareAndSet(QUEUED, WRITING)) {
                return false;
            }
            if (gate != null) {
                try {
                    gate.open();
                } catch (RpcException e) {
                    done.completeExceptionally(e);
                    return false;
                }
            }
            return true;
        }

        /** A KEY frame holds a key, and a call's params may be private: nothing keeps them once they're done with. */
        void zero() {
            Arrays.fill(frame, (byte) 0);
        }
    }

    private static final class Connection {
        final SocketChannel channel;
        /** Guarded by the lock, and read without it only by whoever's about to find out anyway. */
        volatile boolean alive = true;
        volatile boolean writing;
        volatile long lastProgress;
        /** Guarded by the lock. */
        boolean watcherAsleep;
        Outgoing inHand;

        Connection(SocketChannel channel) {
            this.channel = channel;
        }
    }

    private final Path socket;
    private final Timing timing;
    private final AtomicLong ids = new AtomicLong();
    private final AtomicLong sids = new AtomicLong();
    private final Map<Long, Outgoing> calls = new ConcurrentHashMap<>();
    private final ReentrantLock lock = new ReentrantLock();
    /** The writer: something's queued, or the connection has gone. */
    private final Condition work = lock.newCondition();
    /** The watcher: a write has begun, or the connection has gone. */
    private final Condition watch = lock.newCondition();
    /** The link thread, between tries. */
    private final Condition stopping = lock.newCondition();
    /** Guarded by the lock. */
    private final ArrayDeque<Outgoing> queue = new ArrayDeque<>();
    /** Calls out per session, by session id. Guarded by the lock. */
    private final Map<String, Integer> perSession = new HashMap<>();
    private volatile Connection current;
    private volatile Listener listener = NONE;
    private Thread thread;
    private long queuedBytes;
    private boolean closed;

    public AgentLink(Path socket, Timing timing) {
        this.socket = socket;
        this.timing = timing;
    }

    /** Starts connecting. Later calls do nothing. */
    public void start(Listener newListener) {
        lock.lock();
        try {
            if (thread == null && !closed) {
                listener = newListener;
                thread = Thread.ofVirtual().name("agent-link").start(this::run);
            }
        } finally {
            lock.unlock();
        }
    }

    public boolean isConnected() {
        return current != null;
    }

    /** For tests: a write is under way now, as it stays while a desk-agent that has stopped reading holds it. */
    boolean writingForTest() {
        Connection connection = current;
        return connection != null && connection.writing;
    }

    /** A new id for a subscription. Ids are never reused. */
    public long newSid() {
        return sids.incrementAndGet();
    }

    /** A call of deskd's own, counted against no session. See {@link #call(String, Map, Duration, String, Gate)}. */
    public Object call(String method, Map<String, Object> params, Duration wait) throws RpcException, InterruptedException {
        return call(method, params, wait, null, null);
    }

    /**
     * One relayed call: {@code req} with this method and params, then its {@code res} or {@code err}. It doesn't wait to
     * find room or to write: it queues, and waits only for the answer.
     *
     * @param session the calling session's id, whose calls out are limited, or null for deskd's own
     * @param gate what to run right before the bytes go, or null
     * @return {@code r}, or an empty object if desk-agent sent none
     * @throws RpcException desk-agent's error, the gate's, or {@code unavailable} if it can't be reached, doesn't answer
     *     in time, or there's no room for this call now
     * @throws InterruptedException a cancel or a deadline: desk-agent is sent {@code cancel} if the call went out
     */
    public Object call(String method, Map<String, Object> params, Duration wait, String session, Gate gate)
            throws RpcException, InterruptedException {
        return call(method, params, wait, session, gate, null);
    }

    /**
     * {@link #call(String, Map, Duration, String, Gate)} for a client's session, with who it is: desk-agent decides what
     * that caller may see and spend by it, and by nothing in {@code p} (API.md section 14).
     *
     * @param caller {@link com.minimalistalliance.desk.deskd.rpc.Caller#toJson}, or null for deskd's own calls
     */
    public Object call(String method, Map<String, Object> params, Duration wait, String session, Gate gate,
            Map<String, Object> caller) throws RpcException, InterruptedException {
        long id = ids.incrementAndGet();
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("t", "req");
        message.put("id", id);
        message.put("m", method);
        message.put("p", params);
        if (caller != null) {
            message.put("caller", caller);
        }
        byte[] body = Json.bytes(message);
        if (body.length > MAX_FRAME - 1) {
            throw new RpcException(RpcException.TOO_LARGE, "Params too large", Map.of());
        }
        return await(id, new Outgoing(frame(JSON, body), gate), wait, session);
    }

    /**
     * {@code agent.key.add}'s call, with the key in a KEY frame. The caller's {@code key} is zeroed here, sent or not,
     * and so is the frame, once written or dropped.
     *
     * @param params the method's params without the key
     */
    public Object callWithKey(String method, Map<String, Object> params, byte[] key, Duration wait, String session, Gate gate)
            throws RpcException, InterruptedException {
        return callWithKey(method, params, key, wait, session, gate, null);
    }

    /** {@link #callWithKey(String, Map, byte[], Duration, String, Gate)}, with the caller in the KEY frame's head. */
    public Object callWithKey(String method, Map<String, Object> params, byte[] key, Duration wait, String session, Gate gate,
            Map<String, Object> caller) throws RpcException, InterruptedException {
        long id = ids.incrementAndGet();
        try {
            if (id > 0xffff_ffffL || key.length > 0xffff) {
                throw unavailable();
            }
            Map<String, Object> head = new LinkedHashMap<>();
            head.put("m", method);
            head.put("p", params);
            if (caller != null) {
                head.put("caller", caller);
            }
            byte[] headBytes = Json.bytes(head);
            if (headBytes.length > 0xffff) {
                throw new RpcException(RpcException.TOO_LARGE, "Params too large", Map.of());
            }
            ByteBuffer frame = ByteBuffer.allocate(5 + 4 + 2 + headBytes.length + 2 + key.length);
            frame.putInt(frame.capacity() - 4).put(KEY).putInt((int) id).putShort((short) headBytes.length)
                    .put(headBytes).putShort((short) key.length).put(key);
            return await(id, new Outgoing(frame.array(), gate), wait, session);
        } finally {
            Arrays.fill(key, (byte) 0);
        }
    }

    /** Sends {@code sub}. @return false if there's no connection, or no room, so nothing will be sent */
    public boolean subscribe(long sid, String topic) {
        return subscribe(sid, topic, null);
    }

    /**
     * Sends {@code sub}, for whom: desk-agent shows a guild member only their own agents and threads.
     *
     * @param caller the subscriber, or null for the owner's view; {@code {"kind":"system"}} is deskd's own, for the
     *     heartbeat, which sees every agent's status
     */
    public boolean subscribe(long sid, String topic, Map<String, Object> caller) {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("t", "sub");
        message.put("sid", sid);
        message.put("topic", topic);
        if (caller != null) {
            message.put("caller", caller);
        }
        return control(message);
    }

    /** Sends {@code unsub}, if there's a connection: a new connection has no subscriptions anyway. */
    public void unsubscribe(long sid) {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("t", "unsub");
        message.put("sid", sid);
        control(message);
    }

    /**
     * Sends a {@code tres} or {@code terr} for desk-agent's {@code tcall}. A reply isn't a call: nothing waits for an
     * answer to it, and it's dropped with the connection, as desk-agent's call then fails anyway. It may pass
     * {@link #MAX_QUEUED} by up to {@link #REPLY_SLACK}, as replies are bounded by deskd's own tool calls at once.
     *
     * @return false if there's no connection, or no room
     */
    public boolean reply(Map<String, Object> message) {
        byte[] body = Json.bytes(message);
        if (body.length > MAX_FRAME - 1) {
            return false;
        }
        byte[] frame = frame(JSON, body);
        lock.lock();
        try {
            if (closed || current == null || queuedBytes + frame.length > MAX_QUEUED + REPLY_SLACK) {
                return false;
            }
            enqueue(new Outgoing(frame, null));
            return true;
        } finally {
            lock.unlock();
        }
    }

    /** SIGTERM's path. Never blocks, however stalled desk-agent is: every call waiting gets {@code unavailable}. */
    @Override
    public void close() {
        List<Outgoing> failing = new ArrayList<>();
        Connection connection;
        lock.lock();
        try {
            if (closed) {
                return;
            }
            closed = true;
            connection = current;
            current = null;
            if (connection != null) {
                connection.alive = false;
            }
            drainQueue(failing);
            failing.addAll(calls.values());
            work.signalAll();
            watch.signalAll();
            stopping.signalAll();
        } finally {
            lock.unlock();
        }
        if (connection != null) {
            closeQuietly(connection.channel);
        }
        fail(failing);
    }

    private Object await(long id, Outgoing call, Duration wait, String session) throws RpcException, InterruptedException {
        lock.lock();
        try {
            if (closed || current == null) {
                call.zero();
                throw unavailable();
            }
            int out = session == null ? 0 : perSession.getOrDefault(session, 0);
            if (out >= MAX_SESSION_CALLS || (queuedBytes > 0 && queuedBytes + call.frame.length > MAX_QUEUED)) {
                call.zero();
                throw unavailable();
            }
            if (session != null) {
                perSession.put(session, out + 1);
            }
            calls.put(id, call);
            enqueue(call);
        } finally {
            lock.unlock();
        }
        try {
            Map<String, Object> message = call.done.get(wait.toNanos(), TimeUnit.NANOSECONDS);
            if ("res".equals(message.get("t"))) {
                return message.get("r") == null ? Map.of() : message.get("r");
            }
            throw relayed(message);
        } catch (InterruptedException e) {
            withdraw(call, id);
            throw e;
        } catch (TimeoutException e) {
            withdraw(call, id);
            throw unavailable();
        } catch (ExecutionException e) {
            throw e.getCause() instanceof RpcException refusal ? refusal : unavailable();
        } finally {
            calls.remove(id);
            if (session != null) {
                lock.lock();
                try {
                    perSession.computeIfPresent(session, (key, out) -> out > 1 ? out - 1 : null);
                } finally {
                    lock.unlock();
                }
            }
        }
    }

    /** A caller has stopped waiting. A call still queued never went, so nothing needs telling. */
    private void withdraw(Outgoing call, long id) {
        lock.lock();
        try {
            if (call.state.compareAndSet(Outgoing.QUEUED, Outgoing.WITHDRAWN)) {
                if (queue.remove(call)) {
                    queuedBytes -= call.frame.length;
                }
                call.zero();
                return;
            }
            Map<String, Object> cancel = new LinkedHashMap<>();
            cancel.put("t", "cancel");
            cancel.put("id", id);
            offerControl(cancel);
        } finally {
            lock.unlock();
        }
    }

    private boolean control(Map<String, Object> message) {
        lock.lock();
        try {
            return offerControl(message);
        } finally {
            lock.unlock();
        }
    }

    /** With the lock held. A cancel or a subscription that can't fit is dropped: its link has stalled, and will go. */
    private boolean offerControl(Map<String, Object> message) {
        byte[] frame = frame(JSON, Json.bytes(message));
        if (closed || current == null || queuedBytes + frame.length > MAX_QUEUED + CONTROL_SLACK) {
            return false;
        }
        enqueue(new Outgoing(frame, null));
        return true;
    }

    /** With the lock held. */
    private void enqueue(Outgoing item) {
        queue.addLast(item);
        queuedBytes += item.frame.length;
        work.signalAll();
    }

    /** With the lock held: what's queued, out of the queue and into {@code failing}, its bytes zeroed. */
    private void drainQueue(List<Outgoing> failing) {
        for (Outgoing item : queue) {
            item.zero();
            failing.add(item);
        }
        queue.clear();
        queuedBytes = 0;
    }

    /** desk-agent's {@code err} as the client's ERR: its code and details, or {@code internal} for a code deskd lacks. */
    static RpcException relayed(Map<String, Object> message) {
        String code = Json.string(message, "code");
        if (code == null || !CODES.contains(code) || RpcException.INTERNAL.equals(code)) {
            return new RpcException(RpcException.INTERNAL, "Internal error", Map.of());
        }
        Map<String, Object> details = Json.object(message, "details");
        return new RpcException(code, "desk-agent: " + code, details == null ? Map.of() : details);
    }

    private static RpcException unavailable() {
        return new RpcException(RpcException.UNAVAILABLE, "desk-agent isn't reachable", Map.of("reason", "unavailable"));
    }

    private static byte[] frame(byte type, byte[] body) {
        return ByteBuffer.allocate(5 + body.length).putInt(1 + body.length).put(type).put(body).array();
    }

    // ---- the link thread

    private void run() {
        long backoff = timing.minBackoff().toNanos();
        boolean saidWaiting = false;
        while (!isClosed()) {
            SocketChannel channel = connect();
            if (channel == null) {
                if (!saidWaiting) {
                    log.info("agent link: waiting for desk-agent's socket");
                    saidWaiting = true;
                }
            } else {
                saidWaiting = false;
                long connected = System.nanoTime();
                serve(channel);
                if (System.nanoTime() - connected >= timing.healthyAfter().toNanos()) {
                    backoff = timing.minBackoff().toNanos();
                }
            }
            if (!sleep(backoff)) {
                return;
            }
            backoff = Math.min(backoff * 2, timing.maxBackoff().toNanos());
        }
    }

    /**
     * On a virtual thread this can't park: a Unix socket's connect either finishes or fails at once.
     *
     * @return null if it failed, whichever way
     */
    private SocketChannel connect() {
        SocketChannel channel = null;
        try {
            channel = SocketChannel.open(StandardProtocolFamily.UNIX);
            channel.connect(UnixDomainSocketAddress.of(socket));
            return channel;
        } catch (IOException | RuntimeException e) {
            closeQuietly(channel);
            return null;
        }
    }

    private void serve(SocketChannel channel) {
        Connection connection = new Connection(channel);
        lock.lock();
        try {
            if (closed) {
                closeQuietly(channel);
                return;
            }
            current = connection;
        } finally {
            lock.unlock();
        }
        Thread.ofVirtual().name("agent-link-write").start(() -> writeLoop(connection));
        Thread.ofVirtual().name("agent-link-watch").start(() -> watchWrites(connection));
        log.info("agent link: connected");
        listener.connected();
        try {
            read(connection.channel);
        } catch (IOException | JsonFormatException | RuntimeException e) {
            if (!isClosed()) {
                // The class alone: exception text can quote the payload.
                log.warn("agent link: dropped ({})", e.getClass().getSimpleName());
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        lost(connection);
        listener.disconnected();
    }

    /** The connection has gone: what's waiting fails with {@code unavailable}, and the next one starts with a clean slate. */
    private void lost(Connection connection) {
        List<Outgoing> failing = new ArrayList<>();
        lock.lock();
        try {
            connection.alive = false;
            if (current == connection) {
                current = null;
            }
            drainQueue(failing);
            failing.addAll(calls.values());
            work.signalAll();
            watch.signalAll();
        } finally {
            lock.unlock();
        }
        closeQuietly(connection.channel);
        fail(failing);
    }

    private void read(SocketChannel channel) throws IOException, JsonFormatException, InterruptedException {
        ByteBuffer header = ByteBuffer.allocate(5);
        while (true) {
            header.clear();
            if (!fill(channel, header)) {
                if (!isClosed()) {
                    log.warn("agent link: desk-agent closed the socket");
                }
                return;
            }
            int length = header.getInt(0);
            if (length < 1 || length - 1 > MAX_FRAME || header.get(4) != JSON) {
                throw new IOException("bad frame");
            }
            dispatch(Json.parseObject(body(channel, length - 1)));
        }
    }

    private void dispatch(Map<String, Object> message) throws IOException {
        String t = Json.string(message, "t");
        if ("res".equals(t) || "err".equals(t)) {
            Outgoing call = calls.get(number(message, "id"));
            if (call != null) {
                call.done.complete(message);
            }
        } else if ("tcall".equals(t)) {
            number(message, "id");
            listener.toolCall(message);
        } else if ("evt".equals(t)) {
            Map<String, Object> data = Json.object(message, "data");
            String type = Json.string(message, "type");
            if (type == null) {
                throw new IOException("evt without a type");
            }
            listener.event(number(message, "sid"), Json.string(message, "topic"), type, data == null ? Map.of() : data);
        } else {
            throw new IOException("unknown t");
        }
    }

    private static long number(Map<String, Object> message, String key) throws IOException {
        if (!(message.get(key) instanceof Number number)) {
            throw new IOException("no " + key);
        }
        return number.longValue();
    }

    private static byte[] body(SocketChannel channel, int size) throws IOException {
        byte[] body = new byte[size];
        ByteBuffer buffer = ByteBuffer.wrap(body);
        while (buffer.position() < size) {
            buffer.limit(Math.min(buffer.position() + IO_BYTES, size));
            if (!fill(channel, buffer)) {
                throw new IOException("closed in a frame");
            }
        }
        return body;
    }

    private static boolean fill(SocketChannel channel, ByteBuffer buffer) throws IOException {
        while (buffer.hasRemaining()) {
            if (channel.read(buffer) < 0) {
                return false;
            }
        }
        return true;
    }

    private boolean isClosed() {
        lock.lock();
        try {
            return closed;
        } finally {
            lock.unlock();
        }
    }

    /** @return false once closed */
    private boolean sleep(long nanos) {
        lock.lock();
        try {
            long left = nanos;
            while (!closed && left > 0) {
                left = stopping.awaitNanos(left);
            }
            return !closed;
        } catch (InterruptedException e) {
            // Nothing interrupts this thread.
            return false;
        } finally {
            lock.unlock();
        }
    }

    // ---- the writer

    private void writeLoop(Connection connection) {
        try {
            Outgoing item;
            while ((item = next(connection)) != null) {
                try {
                    if (item.begin()) {
                        writeFrame(connection, item.frame);
                    }
                } finally {
                    item.zero();
                    written(connection, item);
                }
            }
        } catch (IOException | RuntimeException e) {
            drop(connection);
        } catch (InterruptedException e) {
            drop(connection);
            Thread.currentThread().interrupt();
        }
    }

    /** From the writer or the watcher: the link thread sees it in its read, and it cleans up. */
    private static void drop(Connection connection) {
        closeQuietly(connection.channel);
    }

    /** @return the next frame, or null once the connection has gone */
    private Outgoing next(Connection connection) throws InterruptedException {
        lock.lock();
        try {
            while (connection.alive && queue.isEmpty()) {
                work.await();
            }
            if (!connection.alive) {
                return null;
            }
            connection.inHand = queue.pollFirst();
            return connection.inHand;
        } finally {
            lock.unlock();
        }
    }

    private void written(Connection connection, Outgoing item) {
        lock.lock();
        try {
            connection.inHand = null;
            // Once the connection has gone, the count has started over without this.
            if (current == connection) {
                queuedBytes -= item.frame.length;
            }
        } finally {
            lock.unlock();
        }
    }

    private void writeFrame(Connection connection, byte[] frame) throws IOException {
        connection.lastProgress = System.nanoTime();
        connection.writing = true;
        wakeWatcher(connection);
        try {
            ByteBuffer rest = ByteBuffer.wrap(frame);
            while (rest.position() < frame.length) {
                rest.limit(Math.min(rest.position() + IO_BYTES, frame.length));
                while (rest.hasRemaining()) {
                    if (connection.channel.write(rest) > 0) {
                        connection.lastProgress = System.nanoTime();
                    }
                }
            }
        } finally {
            connection.writing = false;
        }
    }

    private void wakeWatcher(Connection connection) {
        lock.lock();
        try {
            if (connection.watcherAsleep) {
                connection.watcherAsleep = false;
                watch.signalAll();
            }
        } finally {
            lock.unlock();
        }
    }

    // ---- the watcher

    /** Parked with no timer while nothing is being written, so an idle link costs nothing. */
    private void watchWrites(Connection connection) {
        long stall = timing.writeStall().toNanos();
        lock.lock();
        try {
            while (connection.alive) {
                if (!connection.writing) {
                    connection.watcherAsleep = true;
                    watch.await();
                    continue;
                }
                long idle = System.nanoTime() - connection.lastProgress;
                if (idle >= stall) {
                    break;
                }
                watch.awaitNanos(stall - idle);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return;
        } finally {
            lock.unlock();
        }
        if (connection.alive) {
            log.warn("agent link: a write to desk-agent made no progress, so the link goes");
            drop(connection);
        }
    }

    // ---- what callers get

    private static void fail(List<Outgoing> failing) {
        IOException gone = new IOException("link lost");
        for (Outgoing item : failing) {
            item.done.completeExceptionally(gone);
        }
    }

    private static void closeQuietly(SocketChannel channel) {
        if (channel != null) {
            try {
                channel.close();
            } catch (IOException e) {
                // Nothing to do.
            }
        }
    }

    static byte[] ascii(String text) {
        return text.getBytes(StandardCharsets.US_ASCII);
    }
}
