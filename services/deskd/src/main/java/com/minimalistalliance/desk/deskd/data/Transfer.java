package com.minimalistalliance.desk.deskd.data;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.rpc.RpcPeer;
import com.minimalistalliance.desk.deskd.session.Session;
import java.io.IOException;
import java.time.Duration;
import java.util.Arrays;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Consumer;
import java.util.function.LongConsumer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * One data.read: the helper's body, out on channel 5 as CHUNK frames, within the reader's credit (API.md section 12).
 *
 * <p><b>One thread,</b> from {@link #start} to the end, which reads from the helper only what it's about to send: at
 * most one frame's worth is in hand. {@link Session#send} parks it once 64 KiB of its frames wait for desk-rtc, which
 * is {@code RtcClient}'s limit per message, and the frames of one transfer are one message there. So a slow reader
 * holds about 80 KiB here and slows only itself, and the helper waits on its socket.
 *
 * <p><b>Credit</b> counts the file's bytes, a frame's payload, and the END frame needs none. The first 1 MiB comes with
 * data.read, and each CREDIT adds to it. A frame is as large as the credit and the frame allow, up to 16,372 bytes, so a
 * reader's window is used exactly.
 *
 * <p><b>The end:</b> the helper's trailer, unchanged, as the END frame. A transfer that can't finish, as the helper
 * failed or the reader gave no credit for {@code idle}, sends an END frame with an empty payload, which says read it
 * again. One that's stopped, by data.read.stop or its session's end, sends nothing more.
 */
public final class Transfer {

    private static final Logger log = LoggerFactory.getLogger(Transfer.class);

    /** What data.read grants by itself. */
    static final long INITIAL_CREDIT = 1024 * 1024;
    /** Far past any file; credit stops growing here rather than overflow. */
    private static final long MAX_CREDIT = 1L << 50;
    private static final byte[] FAILED = new byte[0];

    private final long id;
    private final Session session;
    private final LongConsumer frameSent;
    private final Duration idle;
    private final Consumer<Transfer> ended;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition creditChanged = lock.newCondition();
    /** Guarded by lock. */
    private long credit = INITIAL_CREDIT;
    private boolean stopped;
    private Body read;
    private Thread thread;

    /**
     * @param frameSent hears each frame's bytes, header included, once it's handed over. Must not block
     * @param ended runs once, as the transfer ends, whichever way
     */
    Transfer(long id, Session session, LongConsumer frameSent, Duration idle, Consumer<Transfer> ended) {
        this.id = id;
        this.session = session;
        this.frameSent = frameSent;
        this.idle = idle;
        this.ended = ended;
    }

    /** Whether it is an {@code export} session's, which the grant fixed for the whole transfer. */
    boolean isExport() {
        return com.minimalistalliance.desk.deskd.rpc.RpcPrincipal.EXPORT.equals(session.grant().scope());
    }

    public long id() {
        return id;
    }

    /**
     * What a transfer sends: the helper's body for data.read, or an open file for files.read. Read in order, from the
     * start of what is sent; {@link #atEnd} says when it is over and {@link #trailer} is then the END frame's payload.
     */
    public interface Body extends AutoCloseable {
        /** What will be sent counting from byte 0 of the file. */
        long size();

        long mtimeMs();

        /** @throws IOException if the source broke */
        boolean atEnd() throws IOException;

        /** Fills {@code into} from its start with up to {@code length} bytes. @return how many, 0 only at the end */
        int read(byte[] into, int length) throws IOException;

        /** The END frame's payload, once {@link #atEnd} has said so. */
        byte[] trailer();

        /** Never throws; may be called twice. */
        @Override
        void close();
    }

    /**
     * Gives the transfer its body.
     *
     * @return false if it was stopped first, and then the read is closed here
     */
    public boolean attach(Body body) {
        lock.lock();
        try {
            if (!stopped) {
                read = body;
                return true;
            }
        } finally {
            lock.unlock();
        }
        body.close();
        return false;
    }

    /** Starts sending, once the reply to data.read has gone. Does nothing if it was stopped meanwhile. */
    public void start() {
        lock.lock();
        try {
            if (stopped || read == null || thread != null) {
                return;
            }
            thread = Thread.ofVirtual().name("data-transfer").unstarted(this::run);
            thread.start();
        } finally {
            lock.unlock();
        }
    }

    /** A CREDIT from the reader. Never blocks for long: the lane that calls this is the bulk channel's. */
    void grant(long bytes) {
        lock.lock();
        try {
            credit = Math.min(MAX_CREDIT, credit + bytes);
            creditChanged.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /**
     * Ends it with nothing more sent. Never blocks: the thread closes the helper's connection as it goes, and if there's
     * no thread yet, nothing is reading from it, so closing it here is quick.
     */
    public void stop() {
        Thread running;
        Body idleRead;
        lock.lock();
        try {
            if (stopped) {
                return;
            }
            stopped = true;
            running = thread;
            idleRead = thread == null ? read : null;
            creditChanged.signalAll();
        } finally {
            lock.unlock();
        }
        if (running != null) {
            running.interrupt();
        } else {
            if (idleRead != null) {
                idleRead.close();
            }
            ended.accept(this);
        }
    }

    private void run() {
        long seq = 0;
        try {
            byte[] buffer = new byte[Frame.MAX_PAYLOAD_BYTES];
            while (!read.atEnd()) {
                int room = awaitCredit();
                int length = read.read(buffer, room);
                if (length == 0) {
                    break;
                }
                take(length);
                // Sending copies it into a frame, so the buffer is free again once this returns.
                send(Frame.BIN, seq++, length == buffer.length ? buffer : Arrays.copyOf(buffer, length));
            }
            send(Frame.BIN | Frame.END, seq, read.trailer());
        } catch (InterruptedException | RpcPeer.PeerGoneException e) {
            // Stopped, or the session has gone: nothing more is said.
        } catch (IdleException e) {
            log.info("data.read transfer ended: no credit from the reader for {} s", idle.toSeconds());
            sayFailed(seq);
        } catch (IOException e) {
            if (!isStopped()) {
                // The class only: what the helper said could name a file.
                log.warn("data.read transfer failed: {}", e.getClass().getSimpleName());
                sayFailed(seq);
            }
        } catch (RuntimeException e) {
            log.error("data.read transfer failed: {}", e.getClass().getName());
            sayFailed(seq);
        } finally {
            read.close();
            ended.accept(this);
        }
    }

    private void send(int flags, long seq, byte[] payload) throws InterruptedException, RpcPeer.PeerGoneException {
        session.send(Channels.BULK, FrameKind.CHUNK, flags, id, seq, payload);
        frameSent.accept(Frame.HEADER_BYTES + payload.length);
    }

    /** An END frame with no trailer: the reader reads it again. */
    private void sayFailed(long seq) {
        if (isStopped() || Thread.currentThread().isInterrupted()) {
            return;
        }
        try {
            send(Frame.BIN | Frame.END, seq, FAILED);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (RpcPeer.PeerGoneException e) {
            // Nobody to tell.
        }
    }

    /** @return how many bytes the next frame may carry: at least one */
    private int awaitCredit() throws InterruptedException, IdleException {
        long deadline = System.nanoTime() + idle.toNanos();
        lock.lockInterruptibly();
        try {
            while (credit <= 0 && !stopped) {
                long left = deadline - System.nanoTime();
                if (left <= 0) {
                    throw new IdleException();
                }
                creditChanged.awaitNanos(left);
            }
            if (stopped) {
                throw new InterruptedException();
            }
            return (int) Math.min(credit, Frame.MAX_PAYLOAD_BYTES);
        } finally {
            lock.unlock();
        }
    }

    private void take(int bytes) {
        lock.lock();
        try {
            credit -= bytes;
        } finally {
            lock.unlock();
        }
    }

    private boolean isStopped() {
        lock.lock();
        try {
            return stopped;
        } finally {
            lock.unlock();
        }
    }

    private static final class IdleException extends Exception {
        private static final long serialVersionUID = 1L;

        IdleException() {
            super("idle", null, false, false);
        }
    }
}
