package com.minimalistalliance.desk.deskd.notebook;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.rpc.RpcPeer;
import com.minimalistalliance.desk.deskd.session.Session;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;

/**
 * What goes to the client on {@code collab}: desk-notebook's messages, in order, and {@code reset}, which comes after
 * every message of the connection it's about. A thread of its own, only while there's something to send, parks on the
 * client's credit, so a client that has stopped reading stops only this and, once {@link #MAX_BYTES} waits, the link's
 * reader. It does no socket I/O, so interrupting it is safe.
 *
 * <p><b>Every DATA has the same id,</b> as one message follows another whole, so nothing ever interleaves. That makes
 * them one message to {@code RtcClient}, which parks a sender at 64 KiB per message: so this holds that and a frame in
 * hand, not the 3 MiB and 4096 messages a new id each time would queue.
 */
final class CollabOut {

    /** What may be waiting or being read: one whole message at the least, and a little more if they're short. */
    static final long MAX_BYTES = NotebookLink.MAX_COLLAB + (64L << 10);
    private static final long DATA_ID = 0;
    private static final byte[] RESET = "{\"t\":\"reset\"}".getBytes(StandardCharsets.US_ASCII);

    private final Session session;
    private final int channel;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition room = lock.newCondition();
    private final ArrayDeque<byte[]> waiting = new ArrayDeque<>();
    private long reserved;
    private boolean resetQueued;
    private boolean stopped;
    private Thread pump;

    /** @param channel collab, or channel 4 for Commons on a guild desk */
    CollabOut(Session session, int channel) {
        this.session = session;
        this.channel = channel;
    }

    /**
     * Before a message is read off the socket, so it's never in memory until there's room for it.
     *
     * @param wanted false once the reader has no more use for this, which {@link #wake} makes it look at
     * @return false if there's still no room after this long, or it's not wanted now, or this has stopped
     */
    boolean reserve(int size, Duration wait, BooleanSupplier wanted) throws InterruptedException {
        long left = wait.toNanos();
        lock.lock();
        try {
            while (!stopped && wanted.getAsBoolean() && reserved > 0 && reserved + size > MAX_BYTES) {
                if (left <= 0) {
                    return false;
                }
                left = room.awaitNanos(left);
            }
            if (stopped || !wanted.getAsBoolean()) {
                return false;
            }
            reserved += size;
            return true;
        } finally {
            lock.unlock();
        }
    }

    /** Whoever waits in {@link #reserve} looks again. */
    void wake() {
        lock.lock();
        try {
            room.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /** A message that was reserved and won't come. */
    void release(int size) {
        lock.lock();
        try {
            reserved -= size;
            room.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /** One message, reserved first. */
    void add(byte[] message) {
        lock.lock();
        try {
            if (!stopped) {
                waiting.addLast(message);
                startPump();
            }
        } finally {
            lock.unlock();
        }
    }

    /** {@code reset}, after all that's waiting. One still waiting says it already. */
    void reset() {
        lock.lock();
        try {
            if (!stopped && !resetQueued) {
                resetQueued = true;
                waiting.addLast(RESET);
                startPump();
            }
        } finally {
            lock.unlock();
        }
    }

    /** The session has ended. Never blocks. */
    void stop() {
        lock.lock();
        try {
            stopped = true;
            waiting.clear();
            reserved = 0;
            room.signalAll();
            if (pump != null) {
                pump.interrupt();
            }
        } finally {
            lock.unlock();
        }
    }

    /** With the lock held. */
    private void startPump() {
        if (pump == null) {
            pump = Thread.ofVirtual().name("notebook-collab").start(this::send);
        }
    }

    private void send() {
        while (true) {
            byte[] message;
            lock.lock();
            try {
                message = waiting.pollFirst();
                if (message == null) {
                    pump = null;
                    return;
                }
                if (message == RESET) {
                    resetQueued = false;
                }
            } finally {
                lock.unlock();
            }
            try {
                session.send(channel, FrameKind.DATA, message == RESET ? 0 : Frame.BIN, DATA_ID, 0, message);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                gone();
                return;
            } catch (RpcPeer.PeerGoneException e) {
                gone();
                return;
            }
            if (message != RESET) {
                release(message.length);
            }
        }
    }

    private void gone() {
        lock.lock();
        try {
            pump = null;
        } finally {
            lock.unlock();
        }
    }

    /** For tests: bytes reserved. */
    long reservedForTest() {
        lock.lock();
        try {
            return reserved;
        } finally {
            lock.unlock();
        }
    }
}
