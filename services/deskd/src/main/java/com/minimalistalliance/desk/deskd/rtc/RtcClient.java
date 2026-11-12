package com.minimalistalliance.desk.deskd.rtc;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SocketChannel;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * deskd's side of rtc.sock (desk-runtime.md section 4). desk-rtc listens; this connects, sends
 * configure, and from then on carries JSON control messages and frames for every session.
 *
 * <p><b>Threads.</b> One virtual thread reads, one writes, one reconnects. No lock is held across
 * socket I/O.
 *
 * <p><b>Credit.</b> Each (handle, channel) has a window in each direction. Outbound frames wait in
 * deskd, and the writer takes only those the peer has credit for, in the priority order of design
 * 4.2.6. So a bulk channel out of credit just stops being picked, and ctl goes past it. Inbound, the
 * peer may send up to the window; the session calls {@link #consumed} as it drains a frame, and that
 * becomes CREDIT. Credit counts a frame's bytes, header included: everything after the channel id in
 * a DATA body.
 *
 * <p><b>Overtaking.</b> Within a channel, frames wait per message, keyed by (kind, id) as reassembly
 * is, and the writer takes one frame per message in turn. A short reply goes out after at most one
 * frame of each message ahead of it, however long those are (design 4.2.4).
 *
 * <p><b>Handles.</b> The handles this class gives out carry the connection's number in their high 32
 * bits. A new desk-rtc may reuse a wire handle, and a late send for a session of the old connection
 * must not reach it. The low 32 bits are the wire handle.
 *
 * <p><b>The clipboard</b> (desk-rtc/README.md, "The clipboard"). Text goes as bytes in parts, both ways, and only
 * the joined bytes are text, for the caller to clean. A set's parts go below session data, as desk-rtc's replies
 * do, with one let through every {@link #CLIPBOARD_SHARE} of data so a paste can't starve. Callers keep to one
 * set at a time. A reply for an id nobody waits for any more is dropped, however late. {@code clipboard.watch}
 * goes out on each connection, after configure, whenever it's wanted, since a new connection starts with it off.
 * Nothing here logs text, data, a part or how many there were.
 */
public final class RtcClient implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(RtcClient.class);

    /**
     * Each side's starting window per channel. deskd only ever grants back what has drained, so
     * upload credit stays at 6 channels x 256 KiB = 1.5 MiB per session, inside the 2 MiB cap of
     * desk-runtime.md 4.2. A later window size for transfers has to respect that cap.
     */
    public static final long INITIAL_CREDIT = 256 * 1024;
    /**
     * What a Guild Desk's configure asks for as deskd's credit per channel toward desk-rtc (desk-rtc 0.4.0, "Guild mode"):
     * it bounds what one stalled member can park in desk-rtc, and so how many sessions fit in its memory. A desk-rtc
     * before 0.4.0 ignores the field and keeps 256 KiB; deskd then reads no {@code credit} in configured and holds to 256 KiB.
     */
    public static final long GUILD_CREDIT = 64 * 1024;
    /** The most a stats.get lists in {@code ack}: desk-rtc keeps at most this many closed rows. */
    static final int MAX_ACK = 2048;
    /** Grants wait until this much has drained. desk-runtime.md 4.2 asks for steps of 32 KiB or more. */
    static final long GRANT_THRESHOLD = 64 * 1024;
    /**
     * A blocking send waits while its message has this much queued. Limits per message, so a long
     * reply parks and a short one on the same channel doesn't.
     */
    static final long QUEUE_LIMIT = 64 * 1024;
    /**
     * A blocking send also waits while its channel has this much queued. The client picks the ids, so
     * the limit per message bounds nothing on its own: replies with new ids would never park. It's
     * over what a session's 32 calls can queue as long replies, so a short reply only ever waits here
     * for a client that has stopped reading. Parking stops its lane, so its credit stops too.
     */
    public static final long CHANNEL_QUEUE_LIMIT = 3 * 1024 * 1024;
    /** The same, in messages. Each has about 160 bytes of bookkeeping, which queuedBytes doesn't count. */
    static final int CHANNEL_QUEUE_MESSAGES = 4096;
    /** {@link RtcListener#onChannelDrained} fires when the queue is under this. */
    static final long LOW_WATER = 64 * 1024;
    /**
     * Control messages waiting for the socket. A few is normal, since desk-rtc reads as fast as deskd
     * writes. Past this it has stopped reading while still sending, so the socket drops, which ends
     * its sessions and starts over, rather than this queue taking the heap.
     */
    static final int MAX_QUEUED_CONTROL = 4096;

    private static final Duration MIN_BACKOFF = Duration.ofMillis(200);
    private static final Duration MAX_BACKOFF = Duration.ofSeconds(5);
    private static final long LOG_INTERVAL_NANOS = TimeUnit.MINUTES.toNanos(1);
    private static final Duration REPLY_TIMEOUT = Duration.ofSeconds(10);
    private static final Duration CLOSE_FLUSH = Duration.ofMillis(500);
    private static final List<String> STREAM_STATES = List.of("down", "warm", "live");
    /** Session data the writer sends before it lets a waiting clipboard part go first, as desk-rtc does the other way. */
    static final long CLIPBOARD_SHARE = 256 * 1024;

    /**
     * @param socket usually /run/desk/rtc.sock
     * @param maxSessions sent in configure
     * @param publicIpv4 read at each configure, since the address changes every start
     */
    public record Config(
            Path socket,
            java.util.function.IntSupplier maxSessions,
            Supplier<String> publicIpv4,
            java.util.function.BooleanSupplier guildDesk,
            int maxSessionsPerMember) {
        public Config(Path socket, int maxSessions, Supplier<String> publicIpv4) {
            this(socket, () -> maxSessions, publicIpv4);
        }

        public Config(Path socket, java.util.function.IntSupplier maxSessions, Supplier<String> publicIpv4) {
            this(socket, maxSessions, publicIpv4, () -> false, 0);
        }
    }

    /** @param answer the SDP answer */
    public record Answer(long handle, String answer) {}

    private final Config config;
    private final ReentrantLock stateLock = new ReentrantLock();
    private volatile RtcListener listener = new RtcListener() {};
    private volatile Connection current;
    private volatile boolean stopped;
    private volatile String rtcVersion;
    private volatile List<String> fingerprints = List.of();
    private volatile String fingerprintsNotAfter;
    private volatile String streamState;
    /**
     * The {@code credit} the last configured echoed, kept across a dropped socket like the version; 0 if it had none.
     * That field is how deskd knows a Guild Desk's desk-rtc is 0.4.0 or later: final counts, closed rows and the
     * budget's reasons come with it.
     */
    private volatile long guildCredit;
    private volatile ClosedRows closedRows;
    private Thread connector;
    private long connectionCount;
    private final AtomicLong clipboardIds = new AtomicLong();
    private final AtomicBoolean clipboardSetting = new AtomicBoolean();
    private final ReentrantLock watchLock = new ReentrantLock();
    /** Guarded by watchLock. */
    private boolean watchWanted;
    private volatile Runnable clipboardChanged = () -> {};

    public RtcClient(Config config) {
        this.config = config;
    }

    /** Starts connecting. Returns at once; a missing socket is normal and retried for ever. */
    public void start(RtcListener listener) {
        stateLock.lock();
        try {
            if (connector != null) {
                throw new IllegalStateException("already started");
            }
            this.listener = listener;
            connector = Thread.ofVirtual().name("rtc-connector").start(this::connectLoop);
        } finally {
            stateLock.unlock();
        }
    }

    /**
     * Stops, after giving what's already queued for the socket a moment to go. The reader runs on the
     * connector thread, and interrupting a read closes the channel, so the interrupt comes last.
     */
    @Override
    public void close() {
        Connection connection = current;
        if (connection != null) {
            connection.flushControl(CLOSE_FLUSH);
        }
        stopped = true;
        if (connection != null) {
            connection.teardown();
        }
        Thread running;
        stateLock.lock();
        try {
            running = connector;
        } finally {
            stateLock.unlock();
        }
        if (running != null) {
            running.interrupt();
        }
    }

    /** True while the socket is up and desk-rtc has answered configure. */
    public boolean isConfigured() {
        Connection connection = current;
        return connection != null && connection.configured;
    }

    /** False only if the reconnect loop died, which would mean deskd itself is broken. */
    public boolean isLoopAlive() {
        stateLock.lock();
        try {
            return connector == null || connector.isAlive() || stopped;
        } finally {
            stateLock.unlock();
        }
    }

    /** The version from the last configured, kept across a dropped socket; null before the first. */
    public String rtcVersion() {
        return rtcVersion;
    }

    /**
     * True once a Guild Desk's configured carried {@code credit}: desk-rtc 0.4.0 or later, which sends a session's final
     * counts in {@code session.closed}, keeps closed sessions' rows in stats until acked, and closes sessions with
     * {@code protocol_error} and {@code over_budget}. False before the first configured, and for an older desk-rtc.
     */
    public boolean deskRtcHasFinalCounts() {
        return guildCredit > 0;
    }

    /** The credit per channel a Guild Desk's sessions start with, as configured echoed it; {@link #INITIAL_CREDIT} otherwise. */
    public long sessionCredit() {
        long credit = guildCredit;
        return credit > 0 ? credit : INITIAL_CREDIT;
    }

    /**
     * Where the closed sessions' rows to acknowledge come from (desk-rtc 0.4.0's Guild Desk). Each stats.get lists
     * {@link ClosedRows#toAck} while desk-rtc is 0.4.0 or later, and a reply tells {@link ClosedRows#acked}. With an
     * older desk-rtc, or none set, stats.get is as it was.
     */
    public void closedRows(ClosedRows rows) {
        this.closedRows = rows;
    }

    /** The closed Guild Desk sessions whose final rows deskd has recorded, to put in {@code stats.get}'s {@code ack}. */
    public interface ClosedRows {
        /** Session ids to list in the next stats.get; at most {@link #MAX_ACK} are sent. */
        java.util.Collection<String> toAck();

        /** desk-rtc has these ids' rows no longer: its reply came after the request that listed them. */
        void acked(java.util.Collection<String> sessionIds);
    }

    /** The DTLS fingerprints from the last configured, 64 lowercase hex chars each. */
    public List<String> fingerprints() {
        return fingerprints;
    }

    /** When the DTLS certificate expires, RFC 3339, from the last configured. Hello's dtls.notAfter. */
    public String fingerprintsNotAfter() {
        return fingerprintsNotAfter;
    }

    /**
     * The last stream.state desk-rtc sent: down, warm or live. Null while the socket is down, or if it
     * hasn't said. Informational: nothing has to wait for it (desk-runtime.md 8.4).
     */
    public String streamState() {
        return streamState;
    }

    /** Sends configure again, after a public IP change. */
    public void reconfigure() {
        Connection connection = current;
        if (connection != null) {
            connection.sendConfigure();
        }
    }

    /**
     * session.create. Parks until desk-rtc answers.
     *
     * @param expectedFingerprint 64 lowercase hex chars
     */
    public Answer createSession(
            String sessionId, String offer, String expectedFingerprint, boolean video, boolean input)
            throws RtcException, InterruptedException {
        return createSession(sessionId, offer, expectedFingerprint, video, input, null);
    }

    /**
     * session.create for a guild member: desk-rtc's guild mode keeps the member's id with the session, for its
     * per-member limit, counts and {@link #closeMember}.
     *
     * @param memberId the token's sub on a guild desk, or null
     */
    public Answer createSession(
            String sessionId, String offer, String expectedFingerprint, boolean video, boolean input, String memberId)
            throws RtcException, InterruptedException {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("t", "session.create");
        message.put("sessionId", sessionId);
        message.put("offer", offer);
        message.put("expectedFingerprint", expectedFingerprint);
        message.put("permissions", Map.of("video", video, "input", input));
        if (memberId != null) {
            message.put("memberId", memberId);
        }
        return awaitAnswer(sessionId, message);
    }

    /**
     * member.close (desk-rtc's guild mode): every session of this member ends at once, each with its session.closed, then
     * member.closed, which deskd needs nothing from. A desk-rtc before guild mode ignores it.
     */
    public void closeMember(String memberId, String reason) {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("t", "member.close");
        message.put("memberId", memberId);
        message.put("reason", reason);
        sendJson(message);
    }

    /** session.ice_restart. Parks until desk-rtc answers. */
    public Answer iceRestart(String sessionId, String offer) throws RtcException, InterruptedException {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("t", "session.ice_restart");
        message.put("sessionId", sessionId);
        message.put("offer", offer);
        return awaitAnswer(sessionId, message);
    }

    /** session.permissions. There's no reply. */
    public void setPermissions(String sessionId, boolean video, boolean input) {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("t", "session.permissions");
        message.put("sessionId", sessionId);
        message.put("video", video);
        message.put("input", input);
        sendJson(message);
    }

    /**
     * session.video. There's no reply. Media flows to a session only while this and its permission to
     * receive video are both true (desk-runtime.md 8.4). Never blocks.
     */
    public void setVideo(String sessionId, boolean view) {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("t", "session.video");
        message.put("sessionId", sessionId);
        message.put("view", view);
        sendJson(message);
    }

    /** session.close. desk-rtc answers with session.closed. */
    public void closeSession(String sessionId, int code, String reason) {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("t", "session.close");
        message.put("sessionId", sessionId);
        message.put("code", code);
        message.put("reason", reason);
        sendJson(message);
    }

    /** stats.get. Parks until desk-rtc answers. */
    public RtcStats stats() throws RtcException, InterruptedException {
        Connection connection = requireConfigured();
        ClosedRows rows = closedRows;
        List<String> ack = List.of();
        if (rows != null && guildCredit > 0) {
            ack = rows.toAck().stream().limit(MAX_ACK).toList();
        }
        CompletableFuture<RtcStats> reply = new CompletableFuture<>();
        connection.lock.lock();
        try {
            connection.pendingStats.addLast(reply);
        } finally {
            connection.lock.unlock();
        }
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("t", "stats.get");
        if (!ack.isEmpty()) {
            request.put("ack", ack);
        }
        connection.enqueueControl(RtcEnvelope.json(Json.bytes(request)));
        try {
            RtcStats result = await(reply);
            if (!ack.isEmpty()) {
                rows.acked(ack);
            }
            return result;
        } finally {
            connection.lock.lock();
            try {
                connection.pendingStats.remove(reply);
            } finally {
                connection.lock.unlock();
            }
        }
    }

    /**
     * Queues a frame, parking while its message has {@link #QUEUE_LIMIT} waiting or its channel is at
     * its limit. Only this caller waits. Other messages keep moving until the channel is full, and
     * other channels and sessions keep moving regardless.
     */
    public void send(long handle, int channel, byte[] frame)
            throws InterruptedException, RtcHandleGoneException {
        Connection connection = current;
        if (connection == null) {
            throw new RtcHandleGoneException();
        }
        connection.lock.lockInterruptibly();
        try {
            HandleState state = connection.requireHandle(handle);
            ChannelState out = state.channels[channel];
            long message = messageKey(frame);
            while (out.queuedFor(message) >= QUEUE_LIMIT || out.isFull()) {
                out.space.await();
                state = connection.requireHandle(handle);
            }
            out.add(message, frame);
            connection.work.signal();
        } finally {
            connection.lock.unlock();
        }
    }

    /**
     * Queues frames with no waiting and no limit, keeping them together. For callers that bound
     * their own backlog, like events, and for the last CLOSE of a session.
     *
     * @return false if the session has ended
     */
    public boolean offer(long handle, int channel, List<byte[]> frames) {
        Connection connection = current;
        if (connection == null) {
            return false;
        }
        connection.lock.lock();
        try {
            HandleState state = connection.handles.get(handle);
            if (state == null || connection.closed) {
                return false;
            }
            for (byte[] frame : frames) {
                state.channels[channel].add(messageKey(frame), frame);
            }
            connection.work.signal();
            return true;
        } finally {
            connection.lock.unlock();
        }
    }

    /** Bytes waiting on this channel, in deskd, for credit or a turn on the socket. */
    public long queuedBytes(long handle, int channel) {
        Connection connection = current;
        if (connection == null) {
            return 0;
        }
        connection.lock.lock();
        try {
            HandleState state = connection.handles.get(handle);
            return state == null ? 0 : state.channels[channel].queuedBytes;
        } finally {
            connection.lock.unlock();
        }
    }

    /**
     * Parks until the channel's queue is empty, or the wait runs out, or the session ends. Frames
     * taken from the queue are written before anything queued later.
     */
    public void awaitDrained(long handle, int channel, Duration maxWait) throws InterruptedException {
        Connection connection = current;
        if (connection == null) {
            return;
        }
        long remaining = maxWait.toNanos();
        connection.lock.lockInterruptibly();
        try {
            while (remaining > 0) {
                HandleState state = connection.handles.get(handle);
                if (state == null || connection.closed || state.channels[channel].queuedBytes == 0) {
                    return;
                }
                remaining = state.channels[channel].space.awaitNanos(remaining);
            }
        } finally {
            connection.lock.unlock();
        }
    }

    /** The session has drained this many bytes of a frame from the channel. Becomes CREDIT. */
    public void consumed(long handle, int channel, int bytes) {
        Connection connection = current;
        if (connection == null) {
            return;
        }
        connection.lock.lock();
        try {
            HandleState state = connection.handles.get(handle);
            if (state == null || connection.closed) {
                return;
            }
            ChannelState in = state.channels[channel];
            in.undrained += bytes;
            if (in.undrained >= GRANT_THRESHOLD) {
                in.receiveWindow += in.undrained;
                connection.control.addLast(RtcEnvelope.credit(handle, channel, in.undrained));
                in.undrained = 0;
                connection.work.signal();
            }
        } finally {
            connection.lock.unlock();
        }
    }

    /**
     * clipboard.set: the desk's CLIPBOARD gets these bytes, which the caller has already made into text. The parts
     * all go together. Parks until desk-rtc answers or the wait runs out, and an interrupt doesn't cut that short:
     * the parts have gone, and the next set mustn't go before this one has its answer, so a caller that keeps to one
     * set at a time, as it has to, keeps desk-rtc to one too. The interrupt is still there for the caller after.
     *
     * @throws RtcException desk-rtc's code: no_display, timeout, too_large or internal. Or deskd's: unavailable,
     *     for no connection or one that dropped first, and no_reply, for a wait that ran out, or a connection whose
     *     clipboard has never answered since one did (see {@link #clipboardGet})
     * @throws IllegalStateException if another set is under way, which is the caller's bug
     */
    public void clipboardSet(byte[] text, Duration wait) throws RtcException, InterruptedException {
        if (!clipboardSetting.compareAndSet(false, true)) {
            throw new IllegalStateException("one clipboard.set at a time");
        }
        boolean interrupted = false;
        try {
            Connection connection = clipboardConnection();
            RtcClipboard.Pending pending = connection.beginClipboard(nextClipboardId(), false, 0);
            connection.enqueueClipboard(RtcClipboard.setEnvelopes(pending.id, text));
            long deadline = System.nanoTime() + wait.toNanos();
            while (true) {
                try {
                    awaitClipboard(connection, pending, deadline);
                    return;
                } catch (InterruptedException e) {
                    interrupted = true;
                }
            }
        } finally {
            clipboardSetting.set(false);
            if (interrupted) {
                Thread.currentThread().interrupt();
            }
        }
    }

    /**
     * clipboard.get, for at most maxBytes. Parks until desk-rtc answers, the wait runs out or the caller is
     * interrupted.
     *
     * <p>A connection on which a wait ran out with nothing at all heard from its clipboard since the request went is
     * taken for a desk-rtc without one, as one before the clipboard ignores these messages. From then on a set or get
     * on it fails at once with no_reply, until any clipboard message arrives on it, or there's a new connection.
     *
     * @return the joined bytes, or null if the clipboard holds no text
     * @throws RtcException as for {@link #clipboardSet}
     */
    public byte[] clipboardGet(int maxBytes, Duration wait) throws RtcException, InterruptedException {
        Connection connection = clipboardConnection();
        RtcClipboard.Pending pending = connection.beginClipboard(nextClipboardId(), true, maxBytes);
        connection.enqueueControl(RtcClipboard.getEnvelope(pending.id, maxBytes));
        try {
            return awaitClipboard(connection, pending, System.nanoTime() + wait.toNanos());
        } finally {
            connection.clipboardPending.remove(pending.id, pending);
        }
    }

    /** Whether desk-rtc should send clipboard.changed: on this connection, and on every one after. Never blocks for long. */
    public void clipboardWatch(boolean on) {
        watchLock.lock();
        try {
            if (watchWanted == on) {
                return;
            }
            watchWanted = on;
            Connection connection = current;
            // One that isn't ready yet sends what's wanted itself, once its configure has gone.
            if (connection != null && connection.watchReady) {
                connection.enqueueControl(RtcClipboard.watchEnvelope(on));
            }
        } finally {
            watchLock.unlock();
        }
    }

    /** What clipboard.changed runs, on the socket's reader, so it must not block. */
    public void onClipboardChanged(Runnable listener) {
        clipboardChanged = listener;
    }

    private long nextClipboardId() {
        return clipboardIds.incrementAndGet() & RtcClipboard.MAX_ID;
    }

    private Connection clipboardConnection() throws RtcException {
        Connection connection = current;
        if (connection == null || connection.closed) {
            throw new RtcException("unavailable");
        }
        if (connection.clipboardSilent) {
            throw new RtcException("no_reply");
        }
        return connection;
    }

    private static byte[] awaitClipboard(Connection connection, RtcClipboard.Pending pending, long deadline)
            throws RtcException, InterruptedException {
        try {
            return pending.done.get(Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
        } catch (TimeoutException e) {
            connection.clipboardPending.remove(pending.id, pending);
            if (connection.clipboardHeard == pending.heardWhenSent && !connection.closed) {
                connection.clipboardSilent = true;
            }
            throw new RtcException("no_reply");
        } catch (ExecutionException e) {
            throw e.getCause() instanceof RtcException cause ? cause : new RtcException("internal");
        }
    }

    private Answer awaitAnswer(String sessionId, Map<String, Object> message)
            throws RtcException, InterruptedException {
        Connection connection = requireConfigured();
        CompletableFuture<Answer> reply = new CompletableFuture<>();
        if (connection.pendingAnswers.putIfAbsent(sessionId, reply) != null) {
            throw new RtcException("internal");
        }
        try {
            connection.enqueueControl(RtcEnvelope.json(Json.bytes(message)));
            return await(reply);
        } finally {
            connection.pendingAnswers.remove(sessionId, reply);
        }
    }

    private static <T> T await(CompletableFuture<T> reply) throws RtcException, InterruptedException {
        try {
            return reply.get(REPLY_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            throw new RtcException("timeout");
        } catch (ExecutionException e) {
            throw e.getCause() instanceof RtcException cause ? cause : new RtcException("internal");
        }
    }

    private Connection requireConfigured() throws RtcException {
        Connection connection = current;
        if (connection == null || connection.closed) {
            throw new RtcException("unavailable");
        }
        if (!connection.configured) {
            throw new RtcException("not_configured");
        }
        return connection;
    }

    private void sendJson(Map<String, Object> message) {
        Connection connection = current;
        if (connection != null) {
            connection.enqueueControl(RtcEnvelope.json(Json.bytes(message)));
        }
    }

    private void connectLoop() {
        Duration backoff = MIN_BACKOFF;
        long lastLogNanos = System.nanoTime() - LOG_INTERVAL_NANOS;
        while (!stopped) {
            SocketChannel channel = null;
            try {
                channel = SocketChannel.open(StandardProtocolFamily.UNIX);
                channel.connect(UnixDomainSocketAddress.of(config.socket()));
            } catch (IOException e) {
                closeQuietly(channel);
                channel = null;
                if (System.nanoTime() - lastLogNanos >= LOG_INTERVAL_NANOS) {
                    lastLogNanos = System.nanoTime();
                    log.info("rtc socket not available at {}, retrying", config.socket());
                }
            }
            if (channel != null) {
                Connection connection = new Connection(channel, ++connectionCount << 32);
                current = connection;
                boolean reachedConfigured = connection.run();
                current = null;
                if (reachedConfigured) {
                    backoff = MIN_BACKOFF;
                }
            }
            if (stopped) {
                return;
            }
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException e) {
                if (stopped) {
                    return;
                }
            }
            Duration doubled = backoff.multipliedBy(2);
            backoff = doubled.compareTo(MAX_BACKOFF) > 0 ? MAX_BACKOFF : doubled;
        }
    }

    private static long longOf(Map<String, Object> message, String key) {
        return message.get(key) instanceof Number number ? number.longValue() : 0;
    }

    private static void closeQuietly(SocketChannel channel) {
        if (channel != null) {
            try {
                channel.close();
            } catch (IOException e) {
                log.debug("closing rtc socket failed");
            }
        }
    }

    /** The (kind, id) of an encoded frame: bytes 1 and 4 to 7 of its header. */
    private static long messageKey(byte[] frame) {
        ByteBuffer header = ByteBuffer.wrap(frame);
        return (long) header.get(1) << 32 | header.getInt(4) & 0xFFFFFFFFL;
    }

    /** One envelope off {@code rtc.sock}, its type read: the body is {@code in} from its position to {@code end}. */
    @FunctionalInterface
    interface EnvelopeHandler {
        void handle(int type, ByteBuffer in, int end);
    }

    /**
     * Hands each whole envelope in {@code in}, flipped after a read, to {@code handler}, then moves what's left of a
     * partial one to the front for the next read, and zeroes the bytes after it that this read brought. The buffer lives
     * as long as the connection, and a later, shorter read covers only its start, so an envelope already handled, a key's
     * {@code agent.key.add} among them, would otherwise stay in it (ISS-20). Past those bytes it's zeros already: it
     * starts so, and each drain leaves it so.
     *
     * @throws IOException on an envelope length out of range
     */
    static void drain(ByteBuffer in, EnvelopeHandler handler) throws IOException {
        while (in.remaining() >= RtcEnvelope.LENGTH_BYTES) {
            int length = in.getInt(in.position());
            if (length < 1 || length > RtcEnvelope.MAX_LENGTH) {
                throw new IOException("bad envelope length");
            }
            if (in.remaining() < RtcEnvelope.LENGTH_BYTES + length) {
                break;
            }
            in.position(in.position() + RtcEnvelope.LENGTH_BYTES);
            int end = in.position() + length;
            int type = in.get() & 0xFF;
            handler.handle(type, in, end);
            in.position(end);
        }
        int filled = in.limit();
        in.compact();
        zero(in, in.position(), filled);
    }

    private static final byte[] ZEROS = new byte[4 << 10];

    /** Zeroes {@code buffer}'s bytes from {@code from} to {@code to}, which its limit must reach. */
    private static void zero(ByteBuffer buffer, int from, int to) {
        for (int at = from; at < to; at += ZEROS.length) {
            buffer.put(at, ZEROS, 0, Math.min(ZEROS.length, to - at));
        }
    }

    private static final class MessageQueue {
        final ArrayDeque<byte[]> frames = new ArrayDeque<>(2);
        long bytes;
    }

    private static final class ChannelState {
        /** Messages with frames waiting, in the order they take their turns. */
        final LinkedHashMap<Long, MessageQueue> messages = new LinkedHashMap<>();
        final Condition space;
        long queuedBytes;
        long sendCredit = INITIAL_CREDIT;
        /** Bytes the peer may still send: the window, less what has arrived. */
        long receiveWindow = INITIAL_CREDIT;
        /** Drained and not yet granted back. */
        long undrained;

        ChannelState(Condition space) {
            this.space = space;
        }

        long queuedFor(long message) {
            MessageQueue queue = messages.get(message);
            return queue == null ? 0 : queue.bytes;
        }

        boolean isFull() {
            return queuedBytes >= CHANNEL_QUEUE_LIMIT || messages.size() >= CHANNEL_QUEUE_MESSAGES;
        }

        void add(long message, byte[] frame) {
            MessageQueue queue = messages.computeIfAbsent(message, key -> new MessageQueue());
            queue.frames.addLast(frame);
            queue.bytes += frame.length;
            queuedBytes += frame.length;
        }

        /**
         * Takes the next message's next frame if credit and the batch have room, and sends that
         * message to the back of the line.
         */
        byte[] takeNext(int batchRoom) {
            Iterator<Map.Entry<Long, MessageQueue>> line = messages.entrySet().iterator();
            if (!line.hasNext()) {
                return null;
            }
            Map.Entry<Long, MessageQueue> next = line.next();
            MessageQueue queue = next.getValue();
            byte[] frame = queue.frames.peekFirst();
            if (sendCredit < frame.length || batchRoom < RtcEnvelope.dataEnvelopeBytes(frame)) {
                return null;
            }
            queue.frames.pollFirst();
            queue.bytes -= frame.length;
            queuedBytes -= frame.length;
            sendCredit -= frame.length;
            line.remove();
            if (!queue.frames.isEmpty()) {
                messages.put(next.getKey(), queue);
            }
            return frame;
        }
    }

    private static final class HandleState {
        final long handle;
        final String sessionId;
        final ChannelState[] channels = new ChannelState[Channels.COUNT];

        HandleState(long handle, String sessionId, ReentrantLock lock, long sendCredit) {
            this.handle = handle;
            this.sessionId = sessionId;
            for (int i = 0; i < channels.length; i++) {
                channels[i] = new ChannelState(lock.newCondition());
                channels[i].sendCredit = sendCredit;
            }
        }
    }

    private final class Connection {
        final SocketChannel channel;
        final long handleBase;
        final ReentrantLock lock = new ReentrantLock();
        final Condition work = lock.newCondition();
        final Condition batchWritten = lock.newCondition();
        final ArrayDeque<byte[]> control = new ArrayDeque<>();
        final Map<Long, HandleState> handles = new LinkedHashMap<>();
        final Map<String, CompletableFuture<Answer>> pendingAnswers = new ConcurrentHashMap<>();
        final ArrayDeque<CompletableFuture<RtcStats>> pendingStats = new ArrayDeque<>();
        final Map<Long, RtcClipboard.Pending> clipboardPending = new ConcurrentHashMap<>();
        /** A set's parts, below session data. */
        final ArrayDeque<byte[]> clipboardOut = new ArrayDeque<>();
        /** Session data written since a clipboard part last went. */
        private long dataSinceClipboard;
        /** Clipboard messages read on this connection. Only the reader writes it. */
        volatile long clipboardHeard;
        volatile boolean clipboardSilent;
        /** Configure has been queued, so clipboard.watch can follow it. Set under watchLock. */
        volatile boolean watchReady;
        volatile boolean configured;
        /** What a new session may send per channel: configured's echo of the guild credit, else the usual. */
        volatile long sessionCredit = INITIAL_CREDIT;
        volatile boolean closed;
        private boolean tornDown;
        private boolean writingBatch;
        /** Which handle to look at first, so one session's frames can't always go first. */
        private long nextFirstHandle;

        Connection(SocketChannel channel, long handleBase) {
            this.channel = channel;
            this.handleBase = handleBase;
        }

        /** Runs until the socket drops. True if desk-rtc got as far as configured. */
        boolean run() {
            Thread writer = Thread.ofVirtual().name("rtc-writer").start(this::writeLoop);
            boolean reachedConfigured = false;
            try {
                sendConfigure();
                watchLock.lock();
                try {
                    watchReady = true;
                    if (watchWanted) {
                        enqueueControl(RtcClipboard.watchEnvelope(true));
                    }
                } finally {
                    watchLock.unlock();
                }
                reachedConfigured = readLoop();
            } catch (IOException | RuntimeException e) {
                if (!stopped) {
                    log.warn("rtc socket dropped: {}", e.getClass().getSimpleName());
                }
                reachedConfigured = configured;
            } finally {
                teardown();
                writer.interrupt();
            }
            return reachedConfigured;
        }

        void sendConfigure() {
            Map<String, Object> message = new LinkedHashMap<>();
            message.put("t", "configure");
            message.put("publicIpv4", config.publicIpv4().get());
            message.put("maxSessions", config.maxSessions().getAsInt());
            // desk-rtc's guild mode (sub/guild-rtc): many members' sessions, data channels only, a member id on each.
            if (config.guildDesk().getAsBoolean()) {
                message.put("deskKind", "guild");
                message.put("maxSessionsPerMember", config.maxSessionsPerMember());
                // desk-rtc 0.4.0 holds deskd to this and echoes it; an older one ignores the field.
                message.put("credit", GUILD_CREDIT);
            }
            enqueueControl(RtcEnvelope.json(Json.bytes(message)));
        }

        /** Waits for queued control messages, and the batch being written, to reach the socket. */
        void flushControl(Duration maxWait) {
            long remaining = maxWait.toNanos();
            lock.lock();
            try {
                while ((writingBatch || !control.isEmpty()) && !closed && remaining > 0) {
                    remaining = batchWritten.awaitNanos(remaining);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                lock.unlock();
            }
        }

        void enqueueControl(byte[] envelope) {
            boolean overflowed = false;
            lock.lock();
            try {
                if (!closed) {
                    overflowed = control.size() >= MAX_QUEUED_CONTROL;
                    if (!overflowed) {
                        control.addLast(envelope);
                        work.signal();
                    }
                }
            } finally {
                lock.unlock();
            }
            if (overflowed) {
                log.error("desk-rtc isn't reading the rtc socket: dropping it");
                // The reader's next read fails, and it tears down.
                closeQuietly(channel);
            }
        }

        RtcClipboard.Pending beginClipboard(long id, boolean get, int maxBytes) throws RtcException {
            RtcClipboard.Pending pending = new RtcClipboard.Pending(id, get, maxBytes, clipboardHeard);
            clipboardPending.put(id, pending);
            // teardown sets closed before it fails what's pending, so this either sees that or is failed by it.
            if (closed) {
                clipboardPending.remove(id, pending);
                throw new RtcException("unavailable");
            }
            return pending;
        }

        void enqueueClipboard(List<byte[]> envelopes) {
            lock.lock();
            try {
                if (!closed) {
                    clipboardOut.addAll(envelopes);
                    work.signal();
                }
            } finally {
                lock.unlock();
            }
        }

        HandleState requireHandle(long handle) throws RtcHandleGoneException {
            HandleState state = handles.get(handle);
            if (state == null || closed) {
                throw new RtcHandleGoneException();
            }
            return state;
        }

        /** Idempotent. Everything waiting on this connection fails or wakes. */
        void teardown() {
            lock.lock();
            try {
                if (tornDown) {
                    return;
                }
                tornDown = true;
                closed = true;
                configured = false;
                streamState = null;
                for (HandleState state : handles.values()) {
                    for (ChannelState out : state.channels) {
                        out.space.signalAll();
                    }
                }
                handles.clear();
                control.clear();
                clipboardOut.clear();
                work.signalAll();
                batchWritten.signalAll();
                for (CompletableFuture<RtcStats> reply : pendingStats) {
                    reply.completeExceptionally(new RtcException("unavailable"));
                }
                pendingStats.clear();
            } finally {
                lock.unlock();
            }
            closeQuietly(channel);
            pendingAnswers.values().forEach(reply -> reply.completeExceptionally(new RtcException("unavailable")));
            pendingAnswers.clear();
            clipboardPending.values().forEach(pending -> pending.done.completeExceptionally(new RtcException("unavailable")));
            clipboardPending.clear();
            listener.onRtcDisconnected();
        }

        private void writeLoop() {
            ByteBuffer batch = ByteBuffer.allocateDirect(RtcEnvelope.LENGTH_BYTES + RtcEnvelope.MAX_LENGTH);
            List<Long> drainedEvents = new ArrayList<>();
            try {
                while (!closed) {
                    batch.clear();
                    drainedEvents.clear();
                    lock.lockInterruptibly();
                    try {
                        while (!fillBatch(batch, drainedEvents)) {
                            work.await();
                            if (closed) {
                                return;
                            }
                        }
                        writingBatch = true;
                    } finally {
                        lock.unlock();
                    }
                    batch.flip();
                    while (batch.hasRemaining()) {
                        channel.write(batch);
                    }
                    lock.lock();
                    try {
                        writingBatch = false;
                        batchWritten.signalAll();
                    } finally {
                        lock.unlock();
                    }
                    for (long handle : drainedEvents) {
                        listener.onChannelDrained(handle, Channels.EVENTS);
                    }
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } catch (IOException e) {
                // The reader sees the same failure and tears down.
                closeQuietly(channel);
            }
        }

        /**
         * Takes what may be sent now, control messages first, then frames in priority order, then a
         * clipboard set's parts, up to one buffer. Each write starts from the top again, so nothing
         * waits for more than one buffer of lower-priority bytes. A part waiting while
         * {@link #CLIPBOARD_SHARE} of frames has gone goes ahead of them once. Runs with the lock held.
         *
         * @return true if the batch holds anything
         */
        private boolean fillBatch(ByteBuffer batch, List<Long> drainedEvents) {
            while (!control.isEmpty() && control.peekFirst().length <= batch.remaining()) {
                batch.put(control.pollFirst());
            }
            if (!control.isEmpty()) {
                return batch.position() > 0;
            }
            if (dataSinceClipboard >= CLIPBOARD_SHARE) {
                putClipboard(batch);
            }
            if (!handles.isEmpty()) {
                fillFrames(batch, drainedEvents);
            }
            while (putClipboard(batch)) {
                // Below session data: whatever room is left.
            }
            return batch.position() > 0;
        }

        /** One part, if one is waiting and it fits. */
        private boolean putClipboard(ByteBuffer batch) {
            byte[] next = clipboardOut.peekFirst();
            if (next == null || next.length > batch.remaining()) {
                return false;
            }
            batch.put(clipboardOut.pollFirst());
            dataSinceClipboard = 0;
            return true;
        }

        private void fillFrames(ByteBuffer batch, List<Long> drainedEvents) {
            int batchStart = batch.position();
            List<HandleState> order = new ArrayList<>(handles.values());
            int start = 0;
            for (int i = 0; i < order.size(); i++) {
                if (order.get(i).handle >= nextFirstHandle) {
                    start = i;
                    break;
                }
            }
            for (int place = 0; place < Channels.COUNT; place++) {
                int channelId = Channels.byPriority(place);
                for (int i = 0; i < order.size(); i++) {
                    HandleState state = order.get((start + i) % order.size());
                    ChannelState out = state.channels[channelId];
                    long before = out.queuedBytes;
                    byte[] frame;
                    while ((frame = out.takeNext(batch.remaining())) != null) {
                        RtcEnvelope.putData(batch, state.handle, channelId, frame);
                    }
                    if (out.queuedBytes != before) {
                        out.space.signalAll();
                        if (channelId == Channels.EVENTS && out.queuedBytes < LOW_WATER) {
                            drainedEvents.add(state.handle);
                        }
                        nextFirstHandle = state.handle + 1;
                    }
                }
            }
            if (!clipboardOut.isEmpty()) {
                dataSinceClipboard += batch.position() - batchStart;
            }
        }

        private boolean readLoop() throws IOException {
            ByteBuffer in = ByteBuffer.allocateDirect(RtcEnvelope.LENGTH_BYTES + RtcEnvelope.MAX_LENGTH);
            try {
                while (true) {
                    if (channel.read(in) < 0) {
                        if (!stopped) {
                            log.info("rtc socket closed by desk-rtc");
                        }
                        return configured;
                    }
                    in.flip();
                    drain(in, (type, envelope, end) -> {
                        switch (type) {
                            case RtcEnvelope.TYPE_JSON -> onJson(envelope, end);
                            case RtcEnvelope.TYPE_DATA -> onData(envelope, end);
                            case RtcEnvelope.TYPE_CREDIT -> onCredit(envelope, end);
                            default -> log.debug("ignoring rtc envelope type {}", type);
                        }
                    });
                }
            } finally {
                // However the connection ends, nothing it read outlives it: native memory is freed without zeroing.
                in.clear();
                zero(in, 0, in.capacity());
            }
        }

        private void onData(ByteBuffer in, int end) {
            if (end - in.position() < 5) {
                log.warn("short rtc DATA envelope dropped");
                return;
            }
            long handle = handleBase | in.getInt() & 0xFFFFFFFFL;
            int channelId = in.get() & 0xFF;
            if (!Channels.isValid(channelId)) {
                log.warn("rtc DATA on channel {} dropped", channelId);
                return;
            }
            int length = end - in.position();
            boolean overrun;
            lock.lock();
            try {
                HandleState state = handles.get(handle);
                if (state == null) {
                    return;
                }
                ChannelState channelState = state.channels[channelId];
                channelState.receiveWindow -= length;
                overrun = channelState.receiveWindow < 0;
            } finally {
                lock.unlock();
            }
            if (overrun) {
                log.error("desk-rtc overran its credit on channel {}", channelId);
                listener.onCreditOverrun(handle, channelId);
                return;
            }
            byte[] frame = new byte[length];
            in.get(frame);
            listener.onData(handle, channelId, frame);
        }

        private void onCredit(ByteBuffer in, int end) {
            if (end - in.position() < 9) {
                log.warn("short rtc CREDIT envelope dropped");
                return;
            }
            long handle = handleBase | in.getInt() & 0xFFFFFFFFL;
            int channelId = in.get() & 0xFF;
            long bytes = in.getInt() & 0xFFFFFFFFL;
            if (!Channels.isValid(channelId)) {
                return;
            }
            lock.lock();
            try {
                HandleState state = handles.get(handle);
                if (state != null) {
                    state.channels[channelId].sendCredit += bytes;
                    work.signal();
                }
            } finally {
                lock.unlock();
            }
        }

        private void onJson(ByteBuffer in, int end) {
            byte[] body = new byte[end - in.position()];
            in.get(body);
            Map<String, Object> message;
            try {
                message = Json.parseObject(body);
            } catch (JsonFormatException e) {
                log.warn("rtc JSON message dropped: unparseable");
                return;
            }
            String type = Json.string(message, "t");
            String sessionId = Json.string(message, "sessionId");
            if (type == null) {
                log.warn("rtc JSON message dropped: no type");
                return;
            }
            switch (type) {
                case "configured" -> onConfigured(message);
                case "session.answer" -> onAnswer(sessionId, message);
                case "session.error" -> onError(sessionId, message);
                case "session.closed" -> onClosed(sessionId, message);
                case "session.state" -> listener.onSessionState(
                        sessionId, Json.string(message, "state"), Json.string(message, "transport"));
                case "input.activity" -> listener.onInputActivity(sessionId, message.get("at"));
                case "stats" -> onStats(message);
                case "stream.state" -> onStreamState(message);
                case "clipboard.ok", "clipboard.error", "clipboard.text" -> onClipboardReply(type, message);
                case "clipboard.changed" -> {
                    heardClipboard();
                    clipboardChanged.run();
                }
                case "error" -> log.warn("desk-rtc refused a message: {}", Json.string(message, "code"));
                default -> log.debug("ignoring rtc message type {}", type);
            }
        }

        private void heardClipboard() {
            clipboardHeard++;
            clipboardSilent = false;
        }

        /** On the reader: only joins bytes and completes. A reply nobody waits for is dropped, however late. */
        private void onClipboardReply(String type, Map<String, Object> message) {
            heardClipboard();
            long id = RtcClipboard.idOf(message);
            if (id < 0) {
                log.warn("rtc {} dropped: no id deskd could have sent", type);
                return;
            }
            RtcClipboard.Pending pending = clipboardPending.get(id);
            if (pending != null && pending.accept(type, message)) {
                clipboardPending.remove(id, pending);
            }
        }

        private void onStreamState(Map<String, Object> message) {
            String state = Json.string(message, "state");
            if (STREAM_STATES.contains(state)) {
                streamState = state;
                listener.onStreamState(state);
            }
        }

        private void onConfigured(Map<String, Object> message) {
            rtcVersion = Json.string(message, "version");
            fingerprintsNotAfter = Json.string(message, "notAfter");
            if (message.get("fingerprintsSha256") instanceof List<?> list) {
                List<String> values = new ArrayList<>(list.size());
                for (Object value : list) {
                    if (value instanceof String fingerprint) {
                        values.add(fingerprint);
                    }
                }
                fingerprints = List.copyOf(values);
            }
            // Only a Guild Desk's reply from desk-rtc 0.4.0 or later has credit. In range, it is what deskd holds to.
            long echoed = message.get("credit") instanceof Number number ? number.longValue() : 0;
            boolean inRange = echoed >= GUILD_CREDIT && echoed <= INITIAL_CREDIT;
            sessionCredit = inRange ? echoed : INITIAL_CREDIT;
            guildCredit = inRange ? echoed : 0;
            configured = true;
            log.info("rtc configured, desk-rtc version {}", rtcVersion);
            listener.onRtcConfigured();
        }

        private void onAnswer(String sessionId, Map<String, Object> message) {
            if (sessionId == null || !(message.get("handle") instanceof Number number)) {
                log.warn("rtc session.answer dropped: missing fields");
                return;
            }
            long handle = handleBase | number.longValue() & 0xFFFFFFFFL;
            HandleState known;
            lock.lock();
            try {
                known = handles.get(handle);
                if (known == null) {
                    handles.put(handle, new HandleState(handle, sessionId, lock, sessionCredit));
                }
            } finally {
                lock.unlock();
            }
            boolean sameOwner = known == null || known.sessionId.equals(sessionId);
            if (!sameOwner || !listener.onSessionBound(sessionId, handle)) {
                // session.closed only ever removes what's there, so nothing here waits for one.
                if (known == null) {
                    forget(handle);
                }
                closeSession(sessionId, 4000, "closed_by_desk");
            }
            CompletableFuture<Answer> reply = pendingAnswers.remove(sessionId);
            if (reply != null) {
                reply.complete(new Answer(handle, Json.string(message, "answer")));
            }
        }

        private void forget(long handle) {
            lock.lock();
            try {
                HandleState state = handles.remove(handle);
                if (state != null) {
                    for (ChannelState out : state.channels) {
                        out.space.signalAll();
                    }
                }
            } finally {
                lock.unlock();
            }
        }

        private void onError(String sessionId, Map<String, Object> message) {
            CompletableFuture<Answer> reply = sessionId == null ? null : pendingAnswers.remove(sessionId);
            if (reply != null) {
                String code = Json.string(message, "code");
                reply.completeExceptionally(new RtcException(code == null ? "internal" : code));
            }
        }

        private void onClosed(String sessionId, Map<String, Object> message) {
            if (sessionId == null) {
                return;
            }
            // A Guild Desk's desk-rtc 0.4.0 puts the session's final counts in session.closed; before 0.4.0 there are none.
            if (message.get("bytesSent") instanceof Number sent && message.get("memberId") instanceof String memberId) {
                long received = message.get("bytesReceived") instanceof Number number ? number.longValue() : 0;
                listener.onSessionFinalBytes(sessionId, memberId, Math.max(0, sent.longValue()), Math.max(0, received));
            }
            lock.lock();
            try {
                handles.values().removeIf(state -> {
                    if (!state.sessionId.equals(sessionId)) {
                        return false;
                    }
                    for (ChannelState out : state.channels) {
                        out.space.signalAll();
                    }
                    return true;
                });
            } finally {
                lock.unlock();
            }
            CompletableFuture<Answer> reply = pendingAnswers.remove(sessionId);
            if (reply != null) {
                reply.completeExceptionally(new RtcException("closed"));
            }
            listener.onSessionClosed(sessionId, Json.string(message, "reason"));
        }

        /** A Guild Desk's stats in parts (desk-rtc "Guild mode"): part 0's reply, and the rows so far. Reader thread only. */
        private Map<String, Object> statsHead;

        private final List<RtcStats.SessionStats> statsRows = new ArrayList<>();

        private void onStats(Map<String, Object> message) {
            // Part 0 has the totals and starts a snapshot; the reply is complete at the part with last, or at once if it has no part.
            boolean parted = message.get("part") instanceof Number;
            if (!parted || ((Number) message.get("part")).intValue() == 0) {
                statsRows.clear();
                statsHead = message;
            } else if (statsHead == null) {
                return;
            }
            parseRows(message);
            if (parted && !Boolean.TRUE.equals(message.get("last"))) {
                return;
            }
            Map<String, Object> head = statsHead;
            List<RtcStats.SessionStats> sessions = List.copyOf(statsRows);
            statsHead = null;
            statsRows.clear();
            CompletableFuture<RtcStats> reply;
            lock.lock();
            try {
                reply = pendingStats.pollFirst();
            } finally {
                lock.unlock();
            }
            if (reply == null) {
                return;
            }
            reply.complete(new RtcStats(
                    sessions,
                    longOf(head, "bytesSent"),
                    longOf(head, "bytesReceived"),
                    longOf(head, "peerBytesSent"),
                    streamStats(Json.object(head, "stream"))));
        }

        private void parseRows(Map<String, Object> message) {
            if (message.get("sessions") instanceof List<?> list) {
                for (Object item : list) {
                    if (item instanceof Map<?, ?> raw) {
                        statsRows.add(new RtcStats.SessionStats(
                                raw.get("sessionId") instanceof String id ? id : null,
                                raw.get("transport") instanceof String transport ? transport : null,
                                raw.get("rttMs") instanceof Number rtt ? rtt.doubleValue() : null,
                                raw.get("bytesSent") instanceof Number sent ? sent.longValue() : 0,
                                raw.get("bytesReceived") instanceof Number received ? received.longValue() : 0,
                                Boolean.TRUE.equals(raw.get("viewing")),
                                raw.get("rtpDropped") instanceof Number dropped ? dropped.longValue() : 0,
                                raw.get("memberId") instanceof String member ? member : null,
                                Boolean.TRUE.equals(raw.get("closed"))));
                    }
                }
            }
        }

        private RtcStats.StreamStats streamStats(Map<String, Object> stream) {
            if (stream == null) {
                return null;
            }
            return new RtcStats.StreamStats(
                    Json.string(stream, "state"),
                    longOf(stream, "viewers"),
                    longOf(stream, "videoPackets"),
                    longOf(stream, "videoBytes"),
                    longOf(stream, "audioPackets"),
                    longOf(stream, "keyframeRequests"));
        }
    }
}
