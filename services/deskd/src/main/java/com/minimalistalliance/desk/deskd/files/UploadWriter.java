package com.minimalistalliance.desk.deskd.files;

import com.minimalistalliance.desk.deskd.data.Transfers;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.Message;
import com.minimalistalliance.desk.deskd.rpc.RpcPeer;
import com.minimalistalliance.desk.deskd.session.Session;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * One running upload's side of the bulk channel (files.md sections 5.2 and 5.4). The channel's lane only {@link #chunk
 * queues} a frame, bounded by the credit it granted (1 MiB), and returns: it never touches the disk, because its
 * return is what gives desk-rtc credit back, and a slow disk must not hold up the same session's downloads and CREDITs.
 * The disk is touched on this upload's own thread, which writes in order, hashes as it goes, fsyncs every 64 MiB, checks
 * the room every 8 MiB or 5 s, and tells the client how far it has got.
 *
 * <p>A transfer ends when the last byte is down, when something goes wrong ({@code no_space}, {@code credit_violation},
 * {@code seq}, {@code superseded}, {@code aborted}, {@code io}, {@code expired}), or when the session does. It always
 * leaves the partial and its sidecar as they were last made durable, except {@code aborted}, which {@link Uploads}
 * deletes.
 */
final class UploadWriter implements Transfers.ChunkSink, Runnable {

    private static final Logger log = LoggerFactory.getLogger(UploadWriter.class);

    static final long WINDOW = 1024 * 1024;
    static final long ACK_BYTES = 256 * 1024;
    static final long ACK_EVERY_MS = 1000;
    static final long FSYNC_EVERY = 64L * 1024 * 1024;
    static final long ROOM_EVERY_BYTES = 8L * 1024 * 1024;
    static final long ROOM_EVERY_MS = 5000;

    /** A test makes each write this slow, to show the lane and the other transfers never wait for the disk. */
    static volatile long slowWriteMs;

    /** Told to the thread, in order with the chunks before it. */
    private record Stop(String code, boolean tellClient) {}

    private final Uploads uploads;
    final Uploads.Meta meta;
    private final Session session;
    private final Transfers.Slot slot;
    private final FileChannel channel;
    private final MessageDigest digest;
    private final LinkedBlockingQueue<Object> queue = new LinkedBlockingQueue<>();
    final CountDownLatch ended = new CountDownLatch(1);

    // The bulk lane's: one thread at a time.
    private long received;
    private long expectSeq;
    private boolean stopped;

    private volatile long creditLimit;
    volatile long committed;
    volatile long lastByteNanos = System.nanoTime();
    volatile long lastProgressMs;
    /** How it ended: null for all bytes written, else the code. */
    volatile String endedWith;

    // The thread's.
    private long durable;
    private long lastFsyncAt;
    private long acked;
    private long unsent;
    private long lastAckNanos = System.nanoTime();
    private long lastRoomCheckAt;
    private long lastRoomCheckNanos = System.nanoTime();
    private Thread thread;

    UploadWriter(Uploads uploads, Uploads.Meta meta, Session session, Transfers.Slot slot, FileChannel channel, MessageDigest digest, long startOffset, long nowMs) {
        this.uploads = uploads;
        this.meta = meta;
        this.session = session;
        this.slot = slot;
        this.channel = channel;
        this.digest = digest;
        this.received = startOffset;
        this.committed = startOffset;
        this.durable = startOffset;
        this.lastFsyncAt = startOffset;
        this.acked = startOffset;
        this.lastRoomCheckAt = startOffset;
        this.creditLimit = Math.min(meta.size(), startOffset + WINDOW);
        this.lastProgressMs = nowMs;
    }

    long transferId() {
        return slot.id();
    }

    String sessionId() {
        return session.sessionId();
    }

    void start() {
        thread = Thread.ofPlatform().daemon().name("files-upload-" + slot.id()).unstarted(this);
        thread.start();
    }

    // ---- the lane's side

    @Override
    public void chunk(Session from, Message message) {
        if (stopped) {
            return;
        }
        byte[] payload = message.payload();
        if (message.seq() != expectSeq) {
            terminate("seq");
            return;
        }
        expectSeq++;
        if (payload.length == 0) {
            return;
        }
        if (received + payload.length > creditLimit || received + payload.length > meta.size()) {
            terminate("credit_violation");
            return;
        }
        received += payload.length;
        lastByteNanos = System.nanoTime();
        queue.add(payload);
    }

    private void terminate(String code) {
        stopped = true;
        queue.add(new Stop(code, true));
    }

    /** Ends the transfer from outside: a newer session took it, the member aborted it, or deskd is closing. */
    void stop(String code, boolean tellClient) {
        queue.add(new Stop(code, tellClient));
    }

    @Override
    public void sessionEnded() {
        queue.add(new Stop("session", false));
    }

    // ---- the thread

    @Override
    public void run() {
        String reason = null;
        boolean tell = false;
        try {
            if (committed >= meta.size()) {
                finishWhole();
                return;
            }
            while (true) {
                Object item = queue.poll(ACK_EVERY_MS, TimeUnit.MILLISECONDS);
                if (item == null) {
                    if (System.nanoTime() - lastByteNanos > uploads.keepNanos()) {
                        reason = "expired";
                        tell = true;
                        break;
                    }
                    ack(false);
                    continue;
                }
                if (item instanceof Stop stop) {
                    reason = stop.code();
                    tell = stop.tellClient();
                    break;
                }
                try {
                    write((byte[]) item);
                } catch (IOException e) {
                    log.warn("upload write failed: {}", e.getClass().getSimpleName());
                    reason = "io";
                    tell = true;
                    break;
                }
                String problem = checkRoom();
                if (problem != null) {
                    reason = problem;
                    tell = true;
                    break;
                }
                if (committed >= meta.size()) {
                    finishWhole();
                    return;
                }
                ack(false);
            }
        } catch (InterruptedException e) {
            reason = "session";
            Thread.currentThread().interrupt();
        } catch (RuntimeException e) {
            log.error("upload writer failed: {}", e.getClass().getName());
            reason = "io";
            tell = true;
        }
        leave(reason, tell);
    }

    private void write(byte[] chunk) throws IOException {
        if (slowWriteMs > 0) {
            try {
                Thread.sleep(slowWriteMs);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new java.io.InterruptedIOException();
            }
        }
        ByteBuffer buf = ByteBuffer.wrap(chunk);
        long at = committed;
        while (buf.hasRemaining()) {
            at += channel.write(buf, at);
        }
        digest.update(chunk);
        committed = at;
        unsent += chunk.length;
        lastProgressMs = uploads.nowMs();
        uploads.noteActivity();
        if (committed - lastFsyncAt >= FSYNC_EVERY) {
            makeDurable();
        }
    }

    private void makeDurable() throws IOException {
        channel.force(false);
        durable = committed;
        lastFsyncAt = committed;
        uploads.writeSidecar(meta, durable, lastProgressMs);
    }

    /** @return a terminal code if the drive can't take the rest of this upload any more */
    private String checkRoom() {
        long now = System.nanoTime();
        if (committed - lastRoomCheckAt < ROOM_EVERY_BYTES && now - lastRoomCheckNanos < TimeUnit.MILLISECONDS.toNanos(ROOM_EVERY_MS)) {
            return null;
        }
        lastRoomCheckAt = committed;
        lastRoomCheckNanos = now;
        try {
            if (uploads.roomBeforeFloor() < meta.size() - committed) {
                return "no_space";
            }
        } catch (IOException e) {
            return "io";
        }
        return null;
    }

    /** More credit for what has been written, and where the file is. At least 256 KiB at a time, or once a second. */
    private void ack(boolean force) {
        long now = System.nanoTime();
        boolean due = unsent >= ACK_BYTES || (committed > acked && now - lastAckNanos >= TimeUnit.MILLISECONDS.toNanos(ACK_EVERY_MS));
        if (!due && !force) {
            return;
        }
        long grant = Math.max(0, Math.min(unsent, meta.size() - creditLimit));
        creditLimit += grant;
        unsent = 0;
        acked = committed;
        lastAckNanos = now;
        say(grant, null);
    }

    private void say(long bytes, String error) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("bytes", bytes);
        body.put("committed", committed);
        if (error != null) {
            body.put("error", error);
        }
        try {
            session.send(Channels.BULK, FrameKind.CREDIT, 0, slot.id(), 0, Json.bytes(body));
        } catch (RpcPeer.PeerGoneException e) {
            // Nobody to tell.
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** Every byte is down: make it durable, tell the client, and leave. */
    private void finishWhole() {
        try {
            makeDurable();
            if (committed > acked) {
                ack(true);
            }
            endedWith = null;
        } catch (IOException e) {
            log.warn("upload could not be made durable: {}", e.getClass().getSimpleName());
            endedWith = "io";
        }
        done();
    }

    private void leave(String reason, boolean tell) {
        try {
            if (!"aborted".equals(reason)) {
                makeDurable();
            }
        } catch (IOException e) {
            log.warn("upload could not be made durable: {}", e.getClass().getSimpleName());
        }
        endedWith = reason;
        if (tell && reason != null) {
            say(0, reason);
        }
        done();
    }

    /** Releases everything the thread held, then lets whoever waits go. */
    private void done() {
        try {
            channel.close();
        } catch (IOException e) {
            // Closing.
        }
        byte[] fin = null;
        if (endedWith == null) {
            try {
                fin = ((MessageDigest) digest.clone()).digest();
            } catch (CloneNotSupportedException e) {
                throw new IllegalStateException(e);
            }
        }
        uploads.writerEnded(this, fin);
        slot.release();
        ended.countDown();
    }

    /** The SHA-256 of what has been written, if it were the whole file. */
    String hexNow() {
        try {
            return Uploads.hex(((MessageDigest) digest.clone()).digest());
        } catch (CloneNotSupportedException e) {
            throw new IllegalStateException(e);
        }
    }
}
