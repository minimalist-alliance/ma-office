package com.minimalistalliance.desk.deskd.notebook;

import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.session.Session;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SocketChannel;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
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
 * One session's connection to desk-notebook, on {@code /run/desk-notebook/notebook.sock} (the Notebook contract,
 * "deskd to desk-notebook"). It opens at the session's first {@code notebook.*}, SUB or {@code collab} DATA, its first
 * frame is the {@code hello}, and it closes when the session ends.
 *
 * <p><b>Frames.</b> {@code u32be length} of what follows, {@code u8 type}, body, at most 4 MiB + 64 KiB. {@code 0x01} is
 * a JSON object with a {@code t}, {@code 0x02} one collab message's bytes. A collab message past DATA's 4 MiB, or a
 * JSON one past a RES's 1 MiB and 64 KiB, could only be refused by the client or parsed at great cost, so the link
 * goes rather than read it, and a {@code reset} tells the client. Nothing is allocated before those checks.
 *
 * <p><b>Threads.</b> Each connection has three virtual threads, and RPC callers touch none of them, so nothing that
 * interrupts a caller can reach a thread doing socket I/O, which would close the channel for everyone on it.
 * <ul>
 *   <li>The <b>link thread</b> connects, and then reads. It's also the one that cleans up when a connection goes.
 *   <li>The <b>writer</b> takes frames off a bounded queue. It writes at most {@link #IO_BYTES} at a time, as the JDK
 *       copies a heap buffer into a native one per call: more would come out of {@code MaxDirectMemorySize} and be
 *       copied again on each partial write.
 *   <li>The <b>watcher</b> sleeps unless a write is under way, and closes the channel if that write makes no progress
 *       for {@code writeStall}. That's how a stalled peer fails this link, and only this link.
 * </ul>
 * The lock guards state and is never held across I/O or a wait for the peer. {@link #close} doesn't wait for anything:
 * closing a {@link SocketChannel} in blocking mode wakes whoever is parked on it, and leaves the rest to them.
 *
 * <p><b>The queue is bounded by construction.</b> {@link #MAX_CALLS} calls at most, each refused at once past
 * {@link #MAX_JSON} of JSON waiting, so a caller never waits for room. {@link #collab} waits for its message to be
 * written before it returns, and its lane is serial, so one collab message at most is queued, and the sender's credit
 * stops while it waits.
 *
 * <p>Nothing here logs a method's params, a result, an event's data or a collab message.
 */
final class NotebookLink {

    private static final Logger log = LoggerFactory.getLogger(NotebookLink.class);

    static final byte JSON = 0x01;
    static final byte COLLAB = 0x02;
    /** The contract's limit on what follows a frame's length. */
    static final int MAX_FRAME = (4 << 20) + (64 << 10);
    /** A collab message goes on as one DATA, which stops here. */
    static final int MAX_COLLAB = FrameKind.DATA.maxMessageBytes();
    /** A {@code res} past a RES's limit by more than its envelope can't become one, and costs more to parse the longer it is. */
    static final int MAX_JSON = FrameKind.RES.maxMessageBytes() + (64 << 10);
    /**
     * Calls out to desk-notebook at once, per session: half of what {@code RpcSession} allows, so calls stuck on a stalled
     * desk-notebook can never take every slot and get the session's Browser calls {@code rate_limited}.
     */
    static final int MAX_CALLS = 16;
    private static final int IO_BYTES = 64 << 10;
    /** What cancels and subscriptions may add past {@link #MAX_JSON}: they mustn't lose to a queue of calls. */
    private static final int CONTROL_SLACK = 64 << 10;
    /** A relayed error's details go in an ERR, which stops at 64 KiB. */
    private static final int MAX_ERROR_DETAILS = 32 << 10;

    /** deskd's error codes (API.md section 4). desk-notebook's {@code err} is relayed only with one of these. */
    private static final Set<String> CODES = Set.of(
            RpcException.BAD_REQUEST, RpcException.UNAUTHORIZED, RpcException.FORBIDDEN,
            RpcException.STEP_UP_REQUIRED, RpcException.NOT_FOUND, RpcException.PRECONDITION_FAILED,
            RpcException.CONFLICT, RpcException.TOO_LARGE, RpcException.RATE_LIMITED,
            RpcException.DEADLINE_EXCEEDED, RpcException.CANCELLED, RpcException.UNAVAILABLE);

    /** Runs on the writer, right before a call's bytes go: {@code beginEffect} for a mutation. */
    @FunctionalInterface
    interface Gate {
        void open() throws RpcException;
    }

    /** One frame on its way out. A call stays in {@link #calls} until its caller is done with it. */
    private static final class Outgoing {
        private static final int QUEUED = 0;
        private static final int WRITING = 1;
        private static final int WITHDRAWN = 2;

        final byte type;
        final byte[] body;
        final Gate gate;
        /** A call's reply, or a collab message's being written. Failing it fails whoever waits. */
        final CompletableFuture<Map<String, Object>> done = new CompletableFuture<>();
        final AtomicInteger state = new AtomicInteger(QUEUED);

        Outgoing(byte type, byte[] body, Gate gate) {
            this.type = type;
            this.body = body;
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

        int jsonBytes() {
            return type == JSON ? body.length : 0;
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

    private final Session session;
    private final Path socket;
    private final NotebookModule.Service service;
    private final NotebookModule.Timing timing;
    private final NotebookLinks links;
    private final CollabOut out;
    private final AtomicLong ids = new AtomicLong();
    private final Map<Long, Outgoing> calls = new ConcurrentHashMap<>();
    private final ReentrantLock lock = new ReentrantLock();
    /** The writer: something's queued, or the connection has gone. */
    private final Condition work = lock.newCondition();
    /** The watcher: a write has begun, or the connection has gone. */
    private final Condition watch = lock.newCondition();
    /** The link thread, between tries. */
    private final Condition wake = lock.newCondition();
    private final ArrayDeque<Outgoing> queue = new ArrayDeque<>();
    private volatile Connection current;
    private volatile long treeSid;
    private long nextSid;
    private long queuedJson;
    private boolean closed;
    private boolean running;
    private boolean treeWanted;
    /** The client has sent DATA since the last {@code reset}, so its virtual socket counts as open. */
    private boolean collabInUse;
    /** Time with a connection up, before the current one; and when the current one came up. Guarded by the lock. */
    private long upNanos;
    private long upSince;
    /** The caller the service last heard on the current connection, in a hello or a {@code caller}. Guarded by the lock. */
    private Map<String, Object> toldCaller;
    /** The {@code settings} the service last heard on the current connection, or null for none. Guarded by the lock. */
    private Map<String, Object> toldSettings;
    /** Commons' voice bytes: the last count it sent on this session, and what earlier voice connections sent. Guarded by the lock. */
    private long voiceLast;
    private long voiceCarried;
    private boolean attempted;
    private long lastAttempt;
    private long backoff;

    NotebookLink(Session session, Path socket, NotebookModule.Service service, NotebookModule.Timing timing, NotebookLinks links) {
        this.session = session;
        this.socket = socket;
        this.service = service;
        this.timing = timing;
        this.links = links;
        this.out = new CollabOut(session, service.channel());
        this.backoff = timing.minBackoff().toNanos();
    }

    boolean isConnected() {
        return current != null;
    }

    /** How long this session has had a connection to the service, all its connections together. */
    long connectedNanos() {
        lock.lock();
        try {
            return upNanos + (current != null ? System.nanoTime() - upSince : 0);
        } finally {
            lock.unlock();
        }
    }

    /** Total bytes Commons' voice connections sent to this session, as its {@code usage} frames say. */
    long voiceBytesSent() {
        lock.lock();
        try {
            return voiceCarried + voiceLast;
        } finally {
            lock.unlock();
        }
    }

    /** A {@code usage} frame's count: cumulative per voice connection; {@code final: true} closes it. */
    private void voiceUsage(Object n, boolean last) {
        long value;
        if (n instanceof Long || n instanceof Integer) {
            value = ((Number) n).longValue();
        } else if (n instanceof Double d && !d.isNaN() && !d.isInfinite() && d < 9.0e18) {
            value = (long) Math.floor(d);
        } else {
            return;
        }
        if (value < 0) {
            return;
        }
        lock.lock();
        try {
            if (last) {
                // That voice connection has closed: its final count is kept, and the next connection starts at 0.
                voiceCarried += value;
                voiceLast = 0;
            } else {
                if (value < voiceLast) {
                    voiceCarried += voiceLast; // fallback: a drop with no final frame is a new connection
                }
                voiceLast = value;
            }
        } finally {
            lock.unlock();
        }
    }

    /** With the lock held: the current connection is ending. */
    private void countDown() {
        if (current != null) {
            upNanos += System.nanoTime() - upSince;
        }
    }

    /** For tests: a write is under way now, as it stays while a stalled peer holds it. */
    boolean writingForTest() {
        Connection connection = current;
        return connection != null && connection.writing;
    }

    /** It holds a subscription to the tree on a live connection, so what it hears is current. */
    boolean treeLive() {
        return current != null && treeSid != 0;
    }

    /**
     * One relayed call. It doesn't wait to find room or to write: it queues, and waits only for the answer.
     *
     * @param gate what to run right before the bytes go, or null
     * @return {@code r}, or an empty object if desk-notebook sent none
     * @throws RpcException desk-notebook's error, or {@code unavailable} with {@code reason: notebook} if it's down, doesn't
     *     answer in time, or there's no room for this call now
     * @throws InterruptedException a cancel or a deadline: desk-notebook is sent {@code cancel} if the call went out
     */
    Object call(String method, Map<String, Object> params, Gate gate) throws RpcException, InterruptedException {
        long id = ids.incrementAndGet();
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("t", "req");
        message.put("id", id);
        message.put("m", method);
        message.put("p", params);
        Outgoing call = new Outgoing(JSON, Json.bytes(message), gate);
        lock.lock();
        try {
            if (closed || calls.size() >= MAX_CALLS || (queuedJson > 0 && queuedJson + call.body.length > MAX_JSON)) {
                throw unavailable();
            }
            calls.put(id, call);
            enqueue(call);
        } finally {
            lock.unlock();
        }
        try {
            Map<String, Object> reply = call.done.get(timing.call().toNanos(), TimeUnit.NANOSECONDS);
            if ("res".equals(reply.get("t"))) {
                return reply.get("r") == null ? Map.of() : reply.get("r");
            }
            throw relayed(reply);
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
        }
    }

    /**
     * One message from the client's virtual socket. It returns once the message has been written or dropped: the caller
     * is the session's {@code collab} lane, so that's what holds its next message back and its credit with it. A
     * message dropped because the link is down gets a {@code reset}, as all of them do once the client's socket has gone.
     */
    void collab(byte[] message) throws InterruptedException {
        Outgoing item = new Outgoing(COLLAB, message, null);
        lock.lock();
        try {
            if (closed) {
                return;
            }
            collabInUse = true;
            enqueue(item);
        } finally {
            lock.unlock();
        }
        try {
            item.done.get();
        } catch (InterruptedException e) {
            if (item.state.compareAndSet(Outgoing.QUEUED, Outgoing.WITHDRAWN)) {
                lock.lock();
                try {
                    queue.remove(item);
                } finally {
                    lock.unlock();
                }
            }
            throw e;
        } catch (ExecutionException e) {
            log.debug("notebook link: a collab message was dropped with its connection");
        }
    }

    /** Whether the session's client is subscribed to the tree, which is what keeps a link trying to reconnect. */
    void wantTree(boolean wanted) {
        lock.lock();
        try {
            if (closed || treeWanted == wanted) {
                return;
            }
            treeWanted = wanted;
            if (current != null) {
                settleTree();
            } else if (wanted) {
                wakeLinkThread();
            }
        } finally {
            lock.unlock();
        }
    }

    /**
     * A refresh changed the session's caller: the service hears it before anything else the session sends from now on.
     * Before a connection, or before its hello has been made, there's nothing to do, as the hello reads the caller then.
     */
    void callerChanged() {
        lock.lock();
        try {
            if (!closed && current != null && toldCaller != null) {
                tellCaller();
            }
        } finally {
            lock.unlock();
        }
    }

    /**
     * The effective settings changed: the service hears them on every connection that is up and has had its hello, as
     * {@code {"t":"settings","settings":{"editBudget":{...}}}}. Never blocks.
     */
    void settingsChanged() {
        lock.lock();
        try {
            if (!closed && current != null && toldCaller != null) {
                tellSettings();
            }
        } finally {
            lock.unlock();
        }
    }

    /** With the lock held: a {@code settings} frame, if there are settings and the service hasn't heard what they are now. */
    private void tellSettings() {
        Map<String, Object> now = links.settingsNow();
        if (now == null || now.equals(toldSettings)) {
            return;
        }
        toldSettings = now;
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("t", "settings");
        message.put("settings", now);
        enqueue(new Outgoing(JSON, Json.bytes(message), null));
    }

    /** With the lock held: a {@code caller} frame, if what the service last heard isn't the session's caller now. */
    private void tellCaller() {
        Map<String, Object> now = session.grant().caller().toJson();
        if (now.equals(toldCaller)) {
            return;
        }
        toldCaller = now;
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("t", "caller");
        message.put("caller", now);
        // Not offerControl's: this must never be dropped, and it's a few hundred bytes.
        enqueue(new Outgoing(JSON, Json.bytes(message), null));
    }

    /** The session has ended. Never blocks: this can run on the rtc reader. */
    void close() {
        List<Outgoing> failing = new ArrayList<>();
        Connection connection;
        lock.lock();
        try {
            if (closed) {
                return;
            }
            closed = true;
            connection = current;
            countDown();
            current = null;
            treeSid = 0;
            if (connection != null) {
                connection.alive = false;
                if (connection.inHand != null) {
                    failing.add(connection.inHand);
                }
            }
            failing.addAll(queue);
            queue.clear();
            queuedJson = 0;
            failing.addAll(calls.values());
            work.signalAll();
            watch.signalAll();
            wake.signalAll();
        } finally {
            lock.unlock();
        }
        if (connection != null) {
            closeQuietly(connection.channel);
        }
        fail(failing);
        out.stop();
    }

    /** With the lock held. */
    private void enqueue(Outgoing item) {
        queue.addLast(item);
        queuedJson += item.jsonBytes();
        if (current != null) {
            work.signalAll();
        } else {
            wakeLinkThread();
        }
    }

    /** With the lock held. */
    private void wakeLinkThread() {
        if (running) {
            wake.signalAll();
        } else {
            running = true;
            Thread.ofVirtual().name(service.name() + "-link").start(this::run);
        }
    }

    /** With the lock held: brings desk-notebook's subscription into line with what's wanted. A new connection has none. */
    private void settleTree() {
        if (treeWanted && treeSid == 0) {
            treeSid = ++nextSid;
            Map<String, Object> message = new LinkedHashMap<>();
            message.put("t", "sub");
            message.put("sid", treeSid);
            message.put("topic", NotebookTopic.TREE);
            offerControl(message);
        } else if (!treeWanted && treeSid != 0) {
            Map<String, Object> message = new LinkedHashMap<>();
            message.put("t", "unsub");
            message.put("sid", treeSid);
            treeSid = 0;
            offerControl(message);
        }
    }

    /** With the lock held. A cancel or a subscription that can't fit is dropped: its link has stalled, and will go. */
    private void offerControl(Map<String, Object> message) {
        byte[] body = Json.bytes(message);
        if (current != null && queuedJson + body.length <= MAX_JSON + CONTROL_SLACK) {
            enqueue(new Outgoing(JSON, body, null));
        }
    }

    /** A caller has stopped waiting. A call still queued never went, so nothing needs telling. */
    private void withdraw(Outgoing call, long id) {
        lock.lock();
        try {
            if (call.state.compareAndSet(Outgoing.QUEUED, Outgoing.WITHDRAWN)) {
                if (queue.remove(call)) {
                    queuedJson -= call.jsonBytes();
                }
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

    // ---- the link thread

    /** While something wants a connection. It ends when nothing does, and {@link #wakeLinkThread} starts another. */
    private void run() {
        while (awaitAttempt()) {
            SocketChannel channel = connect();
            if (channel == null) {
                lost(null, null);
                lock.lock();
                try {
                    backoff = Math.min(backoff * 2, timing.maxBackoff().toNanos());
                } finally {
                    lock.unlock();
                }
            } else {
                serve(channel);
            }
        }
    }

    /**
     * Waits for the next try: the backoff while only a subscription wants one, and the shortest gap while a call or a
     * message is waiting on it.
     *
     * @return false if nothing wants a connection, and the thread is to end
     */
    private boolean awaitAttempt() {
        lock.lock();
        try {
            while (true) {
                boolean urgent = !queue.isEmpty();
                if (closed || (!urgent && !treeWanted)) {
                    running = false;
                    return false;
                }
                long gap = urgent ? timing.minBackoff().toNanos() : backoff;
                long left = attempted ? lastAttempt + gap - System.nanoTime() : 0;
                if (left <= 0) {
                    attempted = true;
                    lastAttempt = System.nanoTime();
                    return true;
                }
                wake.awaitNanos(left);
            }
        } catch (InterruptedException e) {
            // Nothing interrupts this thread.
            running = false;
            return false;
        } finally {
            lock.unlock();
        }
    }

    /**
     * On a virtual thread this can't park: the JDK's socket is non-blocking underneath, and a Unix socket's connect either
     * finishes or fails at once, with EAGAIN on a full backlog. So a peer that stopped accepting costs nothing here.
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
            upSince = System.nanoTime();
            backoff = timing.minBackoff().toNanos();
            settleTree();
        } finally {
            lock.unlock();
        }
        links.connected();
        Thread.ofVirtual().name(service.name() + "-write").start(() -> writeLoop(connection));
        Thread.ofVirtual().name(service.name() + "-watch").start(() -> watchWrites(connection));
        String why = "end of input";
        try {
            readLoop(connection);
        } catch (IOException | JsonFormatException | RuntimeException e) {
            // The class alone: exception text can quote the payload.
            why = e.getClass().getSimpleName();
        } catch (InterruptedException e) {
            why = e.getClass().getSimpleName();
            Thread.currentThread().interrupt();
        }
        lost(connection, why);
    }

    /**
     * A connection has gone, or a try failed: what's waiting fails, the client hears {@code reset} if its virtual socket
     * was open, and the next connection starts with a clean slate.
     *
     * @param connection null if a try failed
     * @param why the reason's class, or null if there was no connection
     */
    private void lost(Connection connection, String why) {
        List<Outgoing> failing = new ArrayList<>();
        boolean reset;
        boolean sessionOver;
        lock.lock();
        try {
            sessionOver = closed;
            if (connection != null) {
                connection.alive = false;
                closeQuietly(connection.channel);
                if (connection.inHand != null) {
                    failing.add(connection.inHand);
                }
                if (current == connection) {
                    countDown();
                    current = null;
                }
                work.signalAll();
                watch.signalAll();
            }
            treeSid = 0;
            toldCaller = null;
            toldSettings = null;
            failing.addAll(queue);
            queue.clear();
            queuedJson = 0;
            failing.addAll(calls.values());
            reset = collabInUse && !sessionOver;
            collabInUse = false;
        } finally {
            lock.unlock();
        }
        fail(failing);
        if (reset) {
            out.reset();
        }
        // A session's end closes its connection, and that says nothing of desk-notebook.
        if (!sessionOver) {
            links.lost(why);
        }
    }

    private void readLoop(Connection connection) throws IOException, JsonFormatException, InterruptedException {
        ByteBuffer header = ByteBuffer.allocate(5);
        while (true) {
            header.clear();
            if (!fill(connection.channel, header)) {
                return;
            }
            int length = header.getInt(0);
            byte type = header.get(4);
            if (length < 1 || length > MAX_FRAME) {
                throw new IOException("a frame over the limit");
            }
            int size = length - 1;
            if (type == JSON) {
                if (size > MAX_JSON) {
                    throw new IOException("a JSON frame over the limit");
                }
                dispatch(Json.parseObject(body(connection.channel, size)));
            } else if (type == COLLAB) {
                if (size > MAX_COLLAB) {
                    throw new IOException("a collab message over the limit");
                }
                // A client that has stopped reading stops this: desk-notebook then waits on its socket, for a while.
                if (!out.reserve(size, timing.clientStall(), connection.channel::isOpen)) {
                    throw new IOException("the client stopped reading");
                }
                byte[] message;
                try {
                    message = body(connection.channel, size);
                } catch (IOException | RuntimeException e) {
                    out.release(size);
                    throw e;
                }
                out.add(message);
            } else {
                throw new IOException("an unknown frame type");
            }
        }
    }

    private void dispatch(Map<String, Object> message) throws IOException {
        String t = Json.string(message, "t");
        if ("res".equals(t) || "err".equals(t)) {
            Outgoing call = calls.get(number(message, "id"));
            if (call != null) {
                call.done.complete(message);
            }
        } else if ("evt".equals(t)) {
            Map<String, Object> data = Json.object(message, "data");
            if (data != null && number(message, "sid") == treeSid) {
                links.treeEvent(data);
            }
        } else if ("usage".equals(t) && service == NotebookModule.Service.COMMONS) {
            voiceUsage(message.get("voiceBytesSent"), Boolean.TRUE.equals(message.get("final")));
        } else if (t == null) {
            throw new IOException("a message with no t");
        } else {
            log.debug("notebook link: ignored a message of a kind this deskd doesn't know");
        }
    }

    private static long number(Map<String, Object> message, String key) throws IOException {
        if (!(message.get(key) instanceof Number number)) {
            throw new IOException("a message with no " + key);
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

    // ---- the writer

    private void writeLoop(Connection connection) {
        try {
            writeFrame(connection, JSON, Json.bytes(hello(connection)));
            Outgoing item;
            while ((item = next(connection)) != null) {
                if (item.begin()) {
                    writeFrame(connection, item.type, item.body);
                    if (item.type == COLLAB) {
                        item.done.complete(null);
                    }
                }
                written(connection, item);
            }
        } catch (IOException | RuntimeException e) {
            drop(connection);
        } catch (InterruptedException e) {
            drop(connection);
            Thread.currentThread().interrupt();
        }
    }

    /**
     * The first frame, with the caller as it is now (docs/sub-status/deskd-guild-sessions.md). A refresh that lands after
     * this was read queues a {@code caller} behind it, as {@link #toldCaller} is set here under the lock.
     */
    private Map<String, Object> hello(Connection connection) {
        Map<String, Object> hello = new LinkedHashMap<>();
        hello.put("t", "hello");
        hello.put("sessionId", session.sessionId());
        lock.lock();
        try {
            // One read of the grant, so sub and caller agree.
            var grant = session.grant();
            Map<String, Object> caller = grant.caller().toJson();
            hello.put("sub", grant.sub());
            hello.put("caller", caller);
            // The budget in force, on a guild desk only. A change after this reads queues a settings frame behind it.
            Map<String, Object> settings = links.settingsNow();
            if (settings != null) {
                hello.put("settings", settings);
            }
            if (current == connection) {
                toldCaller = caller;
                toldSettings = settings;
            }
        } finally {
            lock.unlock();
        }
        return hello;
    }

    /** From the writer or the watcher: the link thread sees it, in a read or waiting on the client, and it cleans up. */
    private void drop(Connection connection) {
        closeQuietly(connection.channel);
        out.wake();
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
                queuedJson -= item.jsonBytes();
            }
        } finally {
            lock.unlock();
        }
    }

    private void writeFrame(Connection connection, byte type, byte[] body) throws IOException {
        ByteBuffer header = ByteBuffer.allocate(5);
        header.putInt(1 + body.length).put(type).flip();
        connection.lastProgress = System.nanoTime();
        connection.writing = true;
        wakeWatcher(connection);
        try {
            writeFully(connection, header);
            ByteBuffer rest = ByteBuffer.wrap(body);
            while (rest.position() < body.length) {
                rest.limit(Math.min(rest.position() + IO_BYTES, body.length));
                writeFully(connection, rest);
            }
        } finally {
            connection.writing = false;
        }
    }

    private static void writeFully(Connection connection, ByteBuffer buffer) throws IOException {
        while (buffer.hasRemaining()) {
            if (connection.channel.write(buffer) > 0) {
                connection.lastProgress = System.nanoTime();
            }
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
            log.warn("{} link: a write made no progress, so this session's link goes", service.name());
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

    /** desk-notebook's {@code err} as the client's ERR: its code and details, or {@code internal}. */
    static RpcException relayed(Map<String, Object> message) {
        String code = Json.string(message, "code");
        Map<String, Object> details = Json.object(message, "details");
        if (code == null || !CODES.contains(code) || (details != null && Json.bytes(details).length > MAX_ERROR_DETAILS)) {
            return new RpcException(RpcException.INTERNAL, "Internal error", Map.of());
        }
        return new RpcException(code, "desk-notebook: " + code, details == null ? Map.of() : details);
    }

    static RpcException unavailable() {
        return new RpcException(RpcException.UNAVAILABLE, "desk-notebook isn't reachable", Map.of("reason", "notebook"));
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
}
